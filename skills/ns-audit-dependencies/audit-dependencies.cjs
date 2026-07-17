#!/usr/bin/env node
'use strict'

const fs = require('fs')
const os = require('os')
const path = require('path')
const { collectDependencies } = require('./collect-dependencies.cjs')
const { renderAuditReport } = require('./render-audit-report.cjs')

const DEFAULT_API_URL = 'https://api.ncm.nodesource.com'
const MAX_NCM_STRING_LENGTH = 4096
const REQUEST_TIMEOUT_MS = 120000
const MAX_RETRIES = 2
const MAX_RECOVERY_RETRIES = 1
const MAX_CONCURRENCY = 2
const MAX_RECOVERY_DEPTH = 1
const RETRY_BASE_DELAY_MS = 500
const RETRY_MAX_DELAY_MS = 5000
const RETRY_AFTER_MAX_DELAY_MS = 30000
const REMEDIATION_BATCH_SIZE = 100
const MAX_REMEDIATION_CANDIDATES_PER_FINDING = 10

const PACKAGE_VERSIONS_QUERY = `
  query getPackageVersions($packageVersions: [PackageVersionInput!]!) {
    packageVersions(packageVersions: $packageVersions) {
      name
      version
      published
      scores {
        group
        name
        pass
        severity
        title
        data
      }
    }
  }
`

const SEVERITY_RANK = {
  NONE: 0,
  LOW: 1,
  MEDIUM: 2,
  HIGH: 3,
  CRITICAL: 4
}

function parseArgs () {
  const args = process.argv.slice(2)
  let dir = process.cwd()
  let format = 'json'

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--dir' && args[i + 1]) dir = path.resolve(args[++i])
    else if (args[i] === '--format' && args[i + 1]) format = args[++i]
  }

  if (!['json', 'markdown'].includes(format)) {
    throw new Error(`Unsupported format: ${format}. Expected json or markdown.`)
  }
  return { dir, format }
}

function formatCliError (error) {
  const code = error && typeof error.code === 'string' && error.code.length > 0
    ? `${error.code}: `
    : ''
  return `Error: ${code}${error.message}\n`
}

function loadToken () {
  if (process.env.NCM_TOKEN) return process.env.NCM_TOKEN

  const authPath = path.join(os.homedir(), '.agents', '.nodesource-auth.json')
  let auth
  try {
    auth = JSON.parse(fs.readFileSync(authPath, 'utf8'))
  } catch {
    throw new Error('NodeSource credentials not found. Run: npx -y nsolid-plugin setup --harness <harness>')
  }

  if (typeof auth.serviceToken !== 'string' || auth.serviceToken.length === 0) {
    throw new Error('Missing serviceToken in ~/.agents/.nodesource-auth.json')
  }

  return auth.serviceToken
}

function normalizeApiUrl (value) {
  return value.replace(/\/+$/, '')
}

function isRetryable (error) {
  const message = String(error && error.message ? error.message : error).toLowerCase()
  const status = error && error.status
  return (error && error.name === 'AbortError') ||
    status === 429 || status === 500 || status === 502 || status === 503 || status === 504 ||
    /\b(429|500|502|503|504)\b|timed? ?out|econnreset|socket hang up|fetch failed/.test(message)
}

function ncmError (message, code, status, retryAfterMs) {
  const error = new Error(message)
  error.code = code
  if (status) error.status = status
  if (Number.isFinite(retryAfterMs)) error.retryAfterMs = retryAfterMs
  return error
}

function parseRetryAfter (value, now = Date.now()) {
  if (typeof value !== 'string' || value.trim() === '') return null
  const seconds = Number(value)
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000
  const date = Date.parse(value)
  if (!Number.isFinite(date)) return null
  return Math.max(0, date - now)
}

function responseHeader (response, name) {
  return response && response.headers && typeof response.headers.get === 'function'
    ? response.headers.get(name)
    : null
}

function retryDelay (error, attempt, random) {
  if (Number.isFinite(error && error.retryAfterMs)) {
    return Math.min(error.retryAfterMs, RETRY_AFTER_MAX_DELAY_MS)
  }
  const ceiling = Math.min(RETRY_BASE_DELAY_MS * (2 ** attempt), RETRY_MAX_DELAY_MS)
  return Math.floor(random() * ceiling)
}

async function fetchBatch (apiUrl, token, packages, options = {}) {
  let lastError
  const fetchImpl = options.fetch || fetch
  const sleep = options.sleep || (delay => new Promise(resolve => setTimeout(resolve, delay)))
  const random = options.random || Math.random
  const onRetry = options.onRetry || (() => {})
  const maxRetries = Number.isInteger(options.maxRetries) ? options.maxRetries : MAX_RETRIES

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)

    try {
      const response = await fetchImpl(`${normalizeApiUrl(apiUrl)}/ncm2/api/v2/graphql`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          query: PACKAGE_VERSIONS_QUERY,
          variables: { packageVersions: packages }
        }),
        signal: controller.signal
      })

      let body
      try {
        body = await response.json()
      } catch {
        if (!response.ok) {
          throw ncmError(
            `NCM API returned HTTP ${response.status}`,
            'NCM_HTTP_ERROR',
            response.status,
            parseRetryAfter(responseHeader(response, 'retry-after'))
          )
        }
        throw ncmError('NCM API returned invalid JSON', 'NCM_INVALID_RESPONSE')
      }

      if (!response.ok) {
        throw ncmError(
          `NCM API returned HTTP ${response.status}`,
          'NCM_HTTP_ERROR',
          response.status,
          parseRetryAfter(responseHeader(response, 'retry-after'))
        )
      }
      if (Array.isArray(body.errors) && body.errors.length > 0) {
        throw ncmError(`NCM API error: ${body.errors.map(error => error.message).join('; ')}`, 'NCM_GRAPHQL_ERROR')
      }
      if (!Array.isArray(body.data && body.data.packageVersions)) {
        throw ncmError('NCM API returned an invalid packageVersions response', 'NCM_INVALID_RESPONSE')
      }

      return body.data.packageVersions
    } catch (error) {
      lastError = error
      if (attempt === maxRetries || !isRetryable(error)) throw error
      const delayMs = retryDelay(error, attempt, random)
      onRetry({
        attempt: attempt + 2,
        totalAttempts: maxRetries + 1,
        reason: classifyBatchFailure(error),
        delayMs
      })
      await sleep(delayMs)
    } finally {
      clearTimeout(timer)
    }
  }

  throw lastError
}

function packageKey (pkg) {
  return `${pkg.name}@${pkg.version}`
}

function matchingRequestKey (pkg, requestedKeys, requestedLatestNames) {
  if (!pkg || typeof pkg.name !== 'string' || typeof pkg.version !== 'string') return null
  const exactKey = packageKey(pkg)
  if (requestedKeys.has(exactKey)) return exactKey
  return requestedLatestNames.has(pkg.name) ? `${pkg.name}@latest` : null
}

function truncateNcmString (value, truncation) {
  if (value.length <= MAX_NCM_STRING_LENGTH) return value

  let end = MAX_NCM_STRING_LENGTH
  const finalCodeUnit = value.charCodeAt(end - 1)
  if (finalCodeUnit >= 0xD800 && finalCodeUnit <= 0xDBFF) end--
  const result = value.slice(0, end)
  if (truncation) {
    truncation.truncatedFields++
    truncation.truncatedCharacters += value.length - result.length
  }
  return result
}

function compactStringList (value, truncation) {
  const values = Array.isArray(value) ? value : typeof value === 'string' ? [value] : []
  return Array.from(new Set(values
    .filter(item => typeof item === 'string')
    .map(item => item.trim())
    .filter(Boolean)))
    .map(item => truncateNcmString(item, truncation))
}

function parseVersion (value) {
  const match = String(value || '').trim().match(/^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/)
  if (!match) return null
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease: match[4] || ''
  }
}

function compareVersions (left, right) {
  const a = parseVersion(left)
  const b = parseVersion(right)
  if (!a || !b) return String(left).localeCompare(String(right), undefined, { numeric: true })
  for (const field of ['major', 'minor', 'patch']) {
    if (a[field] !== b[field]) return a[field] - b[field]
  }
  if (a.prerelease === b.prerelease) return 0
  if (!a.prerelease) return 1
  if (!b.prerelease) return -1
  return a.prerelease.localeCompare(b.prerelease, undefined, { numeric: true })
}

function versionChangeType (current, candidate) {
  const from = parseVersion(current)
  const to = parseVersion(candidate)
  if (!from || !to) return 'unknown'
  if (from.major !== to.major) return 'major'
  if (from.minor !== to.minor) return 'minor'
  if (from.patch !== to.patch || from.prerelease !== to.prerelease) return 'patch'
  return 'none'
}

function remediationCandidates (finding) {
  const candidates = new Map()
  const add = (version, source) => {
    if (!parseVersion(version) || compareVersions(version, finding.version) <= 0) return
    if (!candidates.has(version)) candidates.set(version, source)
  }

  for (const vulnerability of finding.vulnerabilities.filter(item => !item.withdrawn)) {
    for (const range of vulnerability.patched || []) {
      const match = range.match(/(?:^|[\s|,(])>=?\s*v?(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)/)
      if (match) add(match[1], 'patched-range-boundary')
    }
    for (const range of vulnerability.vulnerable || []) {
      const pattern = /(?:^|[\s|,(])<(?![=])\s*v?(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)/g
      let match
      while ((match = pattern.exec(range)) !== null) add(match[1], 'vulnerable-range-boundary')
    }
  }

  return Array.from(candidates, ([version, source]) => ({ version, source }))
    .sort((a, b) => compareVersions(a.version, b.version))
    .slice(0, MAX_REMEDIATION_CANDIDATES_PER_FINDING)
}

function activeVulnerabilities (pkg) {
  if (!pkg || !Array.isArray(pkg.scores)) return null
  return pkg.scores.filter(score => {
    return score && score.group === 'security' && score.pass === false &&
      !/\bwithdrawn\b/i.test(String(score.title || ''))
  })
}

function compactVulnerability (score, truncation) {
  const rawTitle = String(score.title || 'Untitled NCM vulnerability')
  const title = truncateNcmString(rawTitle, truncation)
  const result = {
    severity: truncateNcmString(String(score.severity || 'NONE').toUpperCase(), truncation),
    title
  }
  const data = score.data
  if (data && typeof data === 'object') {
    const id = typeof data.cve === 'string' ? data.cve : typeof data.id === 'string' ? data.id : null
    if (id) result.id = truncateNcmString(id, truncation)
    if (typeof data.url === 'string') result.url = truncateNcmString(data.url, truncation)
    const vulnerable = compactStringList(data.vulnerable, truncation)
    const patched = compactStringList(data.patched, truncation)
    if (vulnerable.length > 0) result.vulnerable = vulnerable
    if (patched.length > 0) result.patched = patched
  }
  if (/\bwithdrawn\b/i.test(rawTitle)) result.withdrawn = true
  return result
}

function compactAssessment (score, fallbackTitle, truncation) {
  return {
    severity: truncateNcmString(String(score.severity || 'NONE').toUpperCase(), truncation),
    title: truncateNcmString(String(score.title || fallbackTitle), truncation)
  }
}

function compactLicense (score, truncation) {
  const data = score.data
  return {
    pass: score.pass === true,
    spdx: data && typeof data === 'object' && typeof data.spdx === 'string'
      ? truncateNcmString(data.spdx, truncation)
      : null
  }
}

function classifyBatchFailure (error) {
  const chain = []
  let current = error
  while (current && chain.length < 5) {
    chain.push(current)
    current = current.cause
  }

  const statuses = chain.map(item => Number(item.status)).filter(Number.isFinite)
  const codes = chain.map(item => String(item.code || '').toUpperCase())
  const names = chain.map(item => String(item.name || '').toLowerCase())
  const message = chain.map(item => String(item.message || item)).join(' ').toLowerCase()

  if (statuses.includes(401) || statuses.includes(403) ||
      /unauthori[sz]ed|forbidden|invalid token|expired token|permission denied/.test(message)) {
    return 'authentication'
  }
  if (statuses.includes(429) || /\b429\b|rate.?limit|too many requests/.test(message)) {
    return 'rate-limit'
  }
  if (statuses.some(status => status >= 500 && status <= 599) || /\b5\d\d\b/.test(message)) {
    return 'server'
  }
  if (names.includes('aborterror') || codes.some(code => ['ETIMEDOUT', 'ESOCKETTIMEDOUT'].includes(code)) ||
      /timed? ?out|timeout/.test(message)) {
    return 'timeout'
  }
  if (codes.some(code => ['ENOTFOUND', 'EAI_AGAIN', 'ENETUNREACH', 'EHOSTUNREACH', 'ECONNREFUSED', 'ECONNRESET'].includes(code)) ||
      /fetch failed|socket hang up|network/.test(message)) {
    return 'network'
  }
  if (codes.some(code => ['NCM_INVALID_RESPONSE', 'NCM_GRAPHQL_ERROR'].includes(code)) ||
      /invalid json|invalid packageversions response|graphql/.test(message)) {
    return 'invalid-response'
  }
  return 'unknown'
}

function highestSeverity (vulnerabilities) {
  return vulnerabilities.reduce((highest, vulnerability) => {
    return (SEVERITY_RANK[vulnerability.severity] || 0) > (SEVERITY_RANK[highest] || 0)
      ? vulnerability.severity
      : highest
  }, 'NONE')
}

async function runAudit (dir, options = {}) {
  const collected = collectDependencies(dir)
  const requested = collected.batches.flat()
  const directByKey = new Map(requested.map(pkg => [packageKey(pkg), pkg.isDirect]))
  const findings = []
  const failureReasons = {}
  const recoveredPackageKeys = new Set()
  const batchRecovery = {
    transportRetries: 0,
    splitBatches: 0,
    missingPackageRetries: 0
  }
  const remediationRecovery = {
    transportRetries: 0,
    splitBatches: 0,
    missingCandidateRetries: 0
  }
  const remediationFailureReasons = {}
  const ncmContentTruncation = {
    truncatedFields: 0,
    truncatedCharacters: 0
  }
  const uncheckedByKey = new Map()
  let failedBatches = 0

  const token = requested.length > 0 ? options.token || loadToken() : ''
  const apiUrl = options.apiUrl || process.env.NCM_API || DEFAULT_API_URL
  const requestBatch = options.fetchBatch || fetchBatch
  const onProgress = options.onProgress || (() => {})
  const totalBatches = collected.batches.length
  let nextBatch = 0
  let completedBatches = 0
  let processedPackages = 0

  function writeStatus (message) {
    process.stderr.write(message)
  }

  function isDirectPackage (pkg) {
    const exactKey = packageKey(pkg)
    if (directByKey.has(exactKey)) return directByKey.get(exactKey) === true
    return directByKey.get(`${pkg.name}@latest`) === true
  }

  function originalRequest (pkg) {
    const exact = requested.find(item => packageKey(item) === packageKey(pkg))
    if (exact) return exact
    return requested.find(item => item.name === pkg.name && item.version === 'latest') || pkg
  }

  function recordUnchecked (pkg, reason) {
    const requestedPackage = originalRequest(pkg)
    const key = packageKey(requestedPackage)
    if (!uncheckedByKey.has(key)) {
      uncheckedByKey.set(key, {
        name: requestedPackage.name,
        version: pkg && pkg.version && requestedPackage.version === 'latest' ? pkg.version : requestedPackage.version,
        reason
      })
    }
  }

  function mergeResults (...groups) {
    const merged = new Map()
    for (const results of groups) {
      for (const pkg of results) merged.set(packageKey(pkg), pkg)
    }
    return Array.from(merged.values())
  }

  async function requestPackages (packages, maxRetries) {
    let retried = false
    const response = await requestBatch(apiUrl, token, packages, {
      maxRetries,
      fetch: options.fetch,
      sleep: options.sleep,
      random: options.random,
      onRetry: event => {
        retried = true
        batchRecovery.transportRetries++
        writeStatus(`Audit retry: ${event.reason}, attempt ${event.attempt}/${event.totalAttempts}\n`)
      }
    })
    if (retried && Array.isArray(response)) {
      const requestedKeys = new Set(packages.map(packageKey))
      const requestedLatestNames = new Set(packages.filter(pkg => pkg.version === 'latest').map(pkg => pkg.name))
      for (const pkg of response) {
        const matchedKey = matchingRequestKey(pkg, requestedKeys, requestedLatestNames)
        if (matchedKey) recoveredPackageKeys.add(matchedKey)
      }
    }
    return response
  }

  async function fetchWithRecovery (packages, recoveryOptions = {}) {
    const depth = recoveryOptions.depth || 0
    const isRecovery = recoveryOptions.isRecovery === true
    const retryMissing = recoveryOptions.retryMissing !== false
    const maxRetries = recoveryOptions.maxRetries === undefined
      ? MAX_RETRIES
      : recoveryOptions.maxRetries
    const requestedKeys = new Set(packages.map(packageKey))
    const requestedLatestNames = new Set(packages.filter(pkg => pkg.version === 'latest').map(pkg => pkg.name))
    let results

    try {
      const response = await requestPackages(packages, maxRetries)
      if (!Array.isArray(response)) {
        throw ncmError('NCM API returned an invalid packageVersions response', 'NCM_INVALID_RESPONSE')
      }
      results = mergeResults(response.filter(pkg => {
        return matchingRequestKey(pkg, requestedKeys, requestedLatestNames) !== null
      }))
    } catch (error) {
      if (isRetryable(error) && depth < MAX_RECOVERY_DEPTH && packages.length > 1) {
        const reason = classifyBatchFailure(error)
        const midpoint = Math.ceil(packages.length / 2)
        batchRecovery.splitBatches++
        writeStatus(`Audit recovery: splitting failed batch (${reason})\n`)
        const left = await fetchWithRecovery(packages.slice(0, midpoint), {
          depth: depth + 1,
          isRecovery: true,
          retryMissing: false,
          maxRetries: MAX_RECOVERY_RETRIES
        })
        const right = await fetchWithRecovery(packages.slice(midpoint), {
          depth: depth + 1,
          isRecovery: true,
          retryMissing: false,
          maxRetries: MAX_RECOVERY_RETRIES
        })
        return {
          results: mergeResults(left.results, right.results),
          unresolved: [...left.unresolved, ...right.unresolved],
          failures: [...left.failures, ...right.failures]
        }
      }

      return {
        results: [],
        unresolved: packages.map(pkg => ({ pkg, reason: classifyBatchFailure(error) })),
        failures: [{ reason: classifyBatchFailure(error) }]
      }
    }

    const returnedKeys = new Set(results
      .map(pkg => matchingRequestKey(pkg, requestedKeys, requestedLatestNames))
      .filter(Boolean))
    if (isRecovery) {
      for (const key of returnedKeys) recoveredPackageKeys.add(key)
    }
    const missing = packages.filter(pkg => !returnedKeys.has(packageKey(pkg)))

    if (missing.length > 0 && retryMissing) {
      batchRecovery.missingPackageRetries++
      writeStatus(`Audit recovery: retrying ${missing.length} omitted package response(s)\n`)
      const retried = await fetchWithRecovery(missing, {
        depth: MAX_RECOVERY_DEPTH,
        isRecovery: true,
        retryMissing: false,
        maxRetries: MAX_RECOVERY_RETRIES
      })
      return {
        results: mergeResults(results, retried.results),
        unresolved: retried.unresolved,
        failures: retried.failures
      }
    }

    return {
      results,
      unresolved: missing.map(pkg => ({ pkg, reason: 'missing-response' })),
      failures: missing.length > 0 ? [{ reason: 'missing-response' }] : []
    }
  }

  async function queryRemediationRequests (requests, mode) {
    const resultByKey = new Map()
    const failedKeys = new Set()
    const requestKey = pkg => mode === 'latest' ? pkg.name : packageKey(pkg)
    const totalBatches = Math.ceil(requests.length / REMEDIATION_BATCH_SIZE)
    let nextBatch = 0
    let completedBatches = 0
    let processedCandidates = 0

    function recordFailures (packages, reason) {
      for (const pkg of packages) failedKeys.add(requestKey(pkg))
      remediationFailureReasons[reason] = (remediationFailureReasons[reason] || 0) + packages.length
    }

    async function requestChunk (packages, requestOptions = {}) {
      const depth = requestOptions.depth || 0
      const retryMissing = requestOptions.retryMissing !== false
      let response
      try {
        response = await requestBatch(apiUrl, token, packages, {
          phase: 'remediation',
          maxRetries: depth === 0 ? MAX_RETRIES : MAX_RECOVERY_RETRIES,
          fetch: options.fetch,
          sleep: options.sleep,
          random: options.random,
          onRetry: event => {
            remediationRecovery.transportRetries++
            writeStatus(`Audit remediation retry: ${event.reason}, attempt ${event.attempt}/${event.totalAttempts}\n`)
          }
        })
        if (!Array.isArray(response)) {
          throw ncmError('NCM API returned an invalid packageVersions response', 'NCM_INVALID_RESPONSE')
        }
      } catch (error) {
        if (isRetryable(error) && depth < MAX_RECOVERY_DEPTH && packages.length > 1) {
          remediationRecovery.splitBatches++
          writeStatus(`Audit remediation recovery: splitting failed candidate batch (${classifyBatchFailure(error)})\n`)
          const midpoint = Math.ceil(packages.length / 2)
          await requestChunk(packages.slice(0, midpoint), { depth: depth + 1, retryMissing: false })
          await requestChunk(packages.slice(midpoint), { depth: depth + 1, retryMissing: false })
          return
        }
        recordFailures(packages, classifyBatchFailure(error))
        return
      }

      const requestedKeys = new Set(packages.map(requestKey))
      const invalidResponseKeys = new Set()
      for (const pkg of response) {
        if (!pkg || typeof pkg.name !== 'string' || typeof pkg.version !== 'string') continue
        const key = mode === 'latest' ? pkg.name : packageKey(pkg)
        if (!requestedKeys.has(key) || resultByKey.has(key)) continue
        if (!Array.isArray(pkg.scores)) {
          invalidResponseKeys.add(key)
          continue
        }
        resultByKey.set(key, pkg)
      }

      const missing = packages.filter(pkg => !resultByKey.has(requestKey(pkg)))
      if (missing.length > 0 && retryMissing) {
        remediationRecovery.missingCandidateRetries++
        writeStatus(`Audit remediation recovery: retrying ${missing.length} omitted candidate response(s)\n`)
        await requestChunk(missing, { depth: MAX_RECOVERY_DEPTH, retryMissing: false })
      } else if (missing.length > 0) {
        const invalid = missing.filter(pkg => invalidResponseKeys.has(requestKey(pkg)))
        const omitted = missing.filter(pkg => !invalidResponseKeys.has(requestKey(pkg)))
        if (invalid.length > 0) recordFailures(invalid, 'invalid-response')
        if (omitted.length > 0) recordFailures(omitted, 'missing-response')
      }
    }

    async function processRemediationBatch (batch) {
      try {
        await requestChunk(batch)
      } finally {
        completedBatches++
        processedCandidates += batch.length
        writeStatus(`Audit remediation: batches ${completedBatches}/${totalBatches}, candidates ${processedCandidates}/${requests.length}\n`)
      }
    }

    async function remediationWorker () {
      while (nextBatch < totalBatches) {
        const start = nextBatch++ * REMEDIATION_BATCH_SIZE
        await processRemediationBatch(requests.slice(start, start + REMEDIATION_BATCH_SIZE))
      }
    }

    const workerCount = Math.min(MAX_CONCURRENCY, totalBatches)
    await Promise.all(Array.from({ length: workerCount }, () => remediationWorker()))
    return { resultByKey, failedKeys }
  }

  async function verifyFindingRemediations () {
    const states = findings.map(finding => ({
      finding,
      candidates: remediationCandidates(finding),
      hadResponse: false,
      hadFailure: false,
      selected: null
    }))
    const activeStates = states.filter(state => {
      if (state.finding.vulnerabilities.some(item => !item.withdrawn)) return true
      state.finding.remediation = { status: 'not-required', reason: 'withdrawn-only' }
      return false
    })

    const boundaryRequests = []
    const seenBoundaries = new Set()
    for (const state of activeStates) {
      for (const candidate of state.candidates) {
        const key = `${state.finding.name}@${candidate.version}`
        if (seenBoundaries.has(key)) continue
        seenBoundaries.add(key)
        boundaryRequests.push({ name: state.finding.name, version: candidate.version })
      }
    }

    let candidateRequests = 0
    let candidatesChecked = 0
    if (boundaryRequests.length > 0) {
      candidateRequests += boundaryRequests.length
      const boundaryResults = await queryRemediationRequests(boundaryRequests, 'exact')
      candidatesChecked += boundaryResults.resultByKey.size
      for (const state of activeStates) {
        for (const candidate of state.candidates) {
          const key = `${state.finding.name}@${candidate.version}`
          const result = boundaryResults.resultByKey.get(key)
          if (result) {
            state.hadResponse = true
            const active = activeVulnerabilities(result)
            if (result.published !== false && active && active.length === 0) {
              state.selected = {
                version: truncateNcmString(result.version, ncmContentTruncation),
                source: candidate.source
              }
              break
            }
          } else if (boundaryResults.failedKeys.has(key)) {
            state.hadFailure = true
          }
        }
      }
    }

    const latestRequests = []
    const seenLatest = new Set()
    for (const state of activeStates.filter(item => !item.selected)) {
      if (seenLatest.has(state.finding.name)) continue
      seenLatest.add(state.finding.name)
      latestRequests.push({ name: state.finding.name, version: 'latest' })
    }

    if (latestRequests.length > 0) {
      candidateRequests += latestRequests.length
      const latestResults = await queryRemediationRequests(latestRequests, 'latest')
      candidatesChecked += latestResults.resultByKey.size
      for (const state of activeStates.filter(item => !item.selected)) {
        const result = latestResults.resultByKey.get(state.finding.name)
        if (result) {
          state.hadResponse = true
          const active = activeVulnerabilities(result)
          const resultVersion = truncateNcmString(result.version)
          if (result.published !== false && parseVersion(resultVersion) && active && active.length === 0 &&
              compareVersions(resultVersion, state.finding.version) > 0) {
            state.selected = {
              version: truncateNcmString(result.version, ncmContentTruncation),
              source: 'latest-fallback'
            }
          }
        } else if (latestResults.failedKeys.has(state.finding.name)) {
          state.hadFailure = true
        }
      }
    }

    const summary = {
      candidateRequests,
      candidatesChecked,
      verified: 0,
      unresolved: 0,
      verificationFailed: 0,
      notRequired: states.length - activeStates.length,
      failures: {
        total: Object.values(remediationFailureReasons).reduce((total, count) => total + count, 0),
        byReason: Object.fromEntries(Object.entries(remediationFailureReasons).sort(([a], [b]) => a.localeCompare(b)))
      },
      recovery: remediationRecovery
    }

    for (const state of activeStates) {
      if (state.selected) {
        state.finding.remediation = {
          status: 'ncm-verified',
          version: state.selected.version,
          source: state.selected.source,
          changeType: versionChangeType(state.finding.version, state.selected.version)
        }
        summary.verified++
      } else if (!state.hadResponse && state.hadFailure) {
        state.finding.remediation = { status: 'verification-failed' }
        summary.verificationFailed++
      } else {
        state.finding.remediation = { status: 'unresolved' }
        summary.unresolved++
      }
    }

    return summary
  }

  async function processBatch (batch) {
    try {
      const packages = batch.map(({ name, version }) => ({ name, version }))
      const outcome = await fetchWithRecovery(packages)
      const results = outcome.results
      for (const unresolved of outcome.unresolved) recordUnchecked(unresolved.pkg, unresolved.reason)
      for (const failure of outcome.failures) {
        failedBatches++
        failureReasons[failure.reason] = (failureReasons[failure.reason] || 0) + 1
      }

      let invalidResponses = 0
      for (const pkg of results) {
        if (pkg.published === false) {
          recordUnchecked(pkg, 'unpublished')
          continue
        }

        if (!Array.isArray(pkg.scores)) {
          recordUnchecked(pkg, 'invalid-response')
          invalidResponses++
          continue
        }

        const scores = pkg.scores.filter(Boolean)
        const vulnerabilities = scores
          .filter(score => score.group === 'security' && score.pass === false)
          .map(score => compactVulnerability(score, ncmContentTruncation))

        if (vulnerabilities.length > 0) {
          const licenseScore = scores.find(score => score.group === 'compliance' && score.name === 'license')
          findings.push({
            name: pkg.name,
            version: pkg.version,
            direct: isDirectPackage(pkg),
            severity: highestSeverity(vulnerabilities),
            vulnerabilities,
            license: licenseScore ? compactLicense(licenseScore, ncmContentTruncation) : null,
            moduleRisks: scores
              .filter(score => score.group === 'risk' && score.pass === false)
              .map(score => compactAssessment(score, 'Untitled NCM module risk', ncmContentTruncation)),
            codeQuality: scores
              .filter(score => score.group === 'quality' && score.pass === false)
              .map(score => compactAssessment(score, 'Untitled NCM quality issue', ncmContentTruncation))
          })
        }
      }
      if (invalidResponses > 0) {
        failedBatches++
        failureReasons['invalid-response'] = (failureReasons['invalid-response'] || 0) + 1
        process.stderr.write(`Warning: NCM returned invalid scores for ${invalidResponses} package(s); left unchecked\n`)
      }
    } catch (error) {
      const reason = classifyBatchFailure(error)
      for (const pkg of batch) recordUnchecked(pkg, reason)
      failedBatches++
      failureReasons[reason] = (failureReasons[reason] || 0) + 1
      process.stderr.write(`Warning: NCM batch failed (${reason}); ${batch.length} package(s) left unchecked\n`)
    } finally {
      completedBatches++
      processedPackages += batch.length
      onProgress(`Audit progress: batches ${completedBatches}/${totalBatches}, packages ${processedPackages}/${requested.length}\n`)
    }
  }

  async function worker () {
    while (nextBatch < totalBatches) {
      const batch = collected.batches[nextBatch++]
      await processBatch(batch)
    }
  }

  const workerCount = Math.min(MAX_CONCURRENCY, totalBatches)
  await Promise.all(Array.from({ length: workerCount }, () => worker()))

  const remediation = await verifyFindingRemediations()

  findings.sort((a, b) => {
    return (SEVERITY_RANK[b.severity] || 0) - (SEVERITY_RANK[a.severity] || 0) ||
      a.name.localeCompare(b.name) || a.version.localeCompare(b.version)
  })

  const bySeverity = { critical: 0, high: 0, medium: 0, low: 0, unknown: 0 }
  let vulnerabilityCount = 0
  for (const finding of findings) {
    for (const vulnerability of finding.vulnerabilities) {
      const key = vulnerability.severity.toLowerCase()
      bySeverity[key in bySeverity ? key : 'unknown']++
      vulnerabilityCount++
    }
  }

  const byFailureReason = Object.fromEntries(Object.entries(failureReasons).sort(([a], [b]) => a.localeCompare(b)))
  const uncheckedPackages = Array.from(uncheckedByKey.values())
    .sort((a, b) => a.reason.localeCompare(b.reason) || a.name.localeCompare(b.name) || a.version.localeCompare(b.version))
  const uncheckedByReason = {}
  for (const pkg of uncheckedPackages) {
    uncheckedByReason[pkg.reason] = (uncheckedByReason[pkg.reason] || 0) + 1
  }
  const unchecked = uncheckedPackages.length
  return {
    packageManager: collected.packageManager,
    packages: {
      total: requested.length,
      direct: collected.direct,
      transitive: collected.transitive,
      checked: Math.max(0, requested.length - unchecked),
      unchecked,
      uncheckedByReason: Object.fromEntries(Object.entries(uncheckedByReason).sort(([a], [b]) => a.localeCompare(b)))
    },
    vulnerabilities: {
      total: vulnerabilityCount,
      affectedPackages: findings.length,
      bySeverity
    },
    batchFailures: {
      total: failedBatches,
      byReason: byFailureReason
    },
    batchRecovery: {
      ...batchRecovery,
      recoveredPackages: recoveredPackageKeys.size
    },
    ncmContentTruncation,
    remediation,
    uncheckedPackages,
    findings
  }
}

if (require.main === module) {
  let args
  try {
    args = parseArgs()
  } catch (error) {
    process.stderr.write(formatCliError(error))
    process.exitCode = 1
  }
  if (args) {
    runAudit(args.dir, { onProgress: message => process.stderr.write(message) })
      .then(summary => process.stdout.write(args.format === 'markdown' ? `${renderAuditReport(summary)}\n` : `${JSON.stringify(summary)}\n`))
      .catch(error => {
        process.stderr.write(formatCliError(error))
        process.exitCode = 1
      })
  }
}

module.exports = { classifyBatchFailure, compactVulnerability, fetchBatch, formatCliError, parseArgs, runAudit }
