import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

const require = createRequire(import.meta.url)
const { classifyBatchFailure, fetchBatch, runAudit } = require('../../../../../skills/ns-audit-dependencies/audit-dependencies.cjs') as {
  classifyBatchFailure: (error: unknown) => string
  fetchBatch: (
    apiUrl: string,
    token: string,
    packages: Array<{ name: string, version: string }>,
    options?: Record<string, unknown>
  ) => Promise<Array<Record<string, unknown>>>
  runAudit: (dir: string, options: Record<string, unknown>) => Promise<Record<string, unknown>>
}

async function createNpmProject (packageCount: number): Promise<string> {
  const projectDir = await mkdtemp(path.join(os.tmpdir(), 'nsolid-audit-'))
  const packages: Record<string, { version?: string }> = { '': {} }

  for (let index = 0; index < packageCount; index++) {
    packages[`node_modules/package-${index}`] = { version: `1.0.${index}` }
  }

  await writeFile(path.join(projectDir, 'package.json'), JSON.stringify({}))
  await writeFile(path.join(projectDir, 'package-lock.json'), JSON.stringify({
    lockfileVersion: 3,
    packages
  }))

  return projectDir
}

test('audit helper only emits vulnerable dependency data', async () => {
  const projectDir = await mkdtemp(path.join(os.tmpdir(), 'nsolid-audit-'))

  try {
    await writeFile(path.join(projectDir, 'package.json'), JSON.stringify({
      dependencies: { 'vulnerable-dep': '1.0.0' }
    }))
    await writeFile(path.join(projectDir, 'package-lock.json'), JSON.stringify({
      lockfileVersion: 3,
      packages: {
        '': { dependencies: { 'vulnerable-dep': '1.0.0' } },
        'node_modules/vulnerable-dep': { version: '1.0.0' },
        'node_modules/clean-dep': { version: '2.0.0' }
      }
    }))

    const summary = await runAudit(projectDir, {
      token: 'test-token',
      fetchBatch: async (_apiUrl: string, _token: string, packages: Array<{ name: string, version: string }>) => {
        return packages.map(pkg => ({
          ...pkg,
          published: true,
          description: pkg.name === 'clean-dep' ? 'SECRET_CLEAN_BLOAT' : undefined,
          scores: pkg.name === 'vulnerable-dep' && pkg.version === '1.0.0'
            ? [
                {
                  group: 'security',
                  pass: false,
                  severity: 'HIGH',
                  title: 'Known vulnerability CVE-2026-1234',
                  data: {
                    cve: 'CVE-2026-1234',
                    vulnerable: ['< 1.0.1', ' < 1.0.1 ', 42],
                    patched: '>= 1.0.1',
                    description: 'LARGE_RAW_ADVISORY'
                  }
                },
                {
                  group: 'risk',
                  pass: false,
                  severity: 'CRITICAL',
                  title: 'Package has an install script',
                  data: { scripts: ['postinstall'], secret: 'RAW_RISK_DATA' }
                },
                {
                  group: 'quality',
                  pass: false,
                  severity: 'MEDIUM',
                  title: 'README is too small',
                  data: { bytes: 12, secret: 'RAW_QUALITY_DATA' }
                },
                {
                  group: 'compliance',
                  name: 'license',
                  pass: true,
                  severity: 'NONE',
                  title: 'License is compliant',
                  data: { spdx: 'MIT', secret: 'RAW_LICENSE_DATA' }
                }
              ]
            : [{ group: 'security', pass: true, severity: 'NONE', title: 'Clean' }]
        }))
      }
    }) as {
      packages: Record<string, number>
      vulnerabilities: Record<string, number>
      remediation: Record<string, unknown>
      findings: Array<{
        name: string
        severity: string
        license: { pass: boolean, spdx: string }
        moduleRisks: Array<{ severity: string, title: string }>
        codeQuality: Array<{ severity: string, title: string }>
        vulnerabilities: Array<{ id: string, vulnerable: string[], patched: string[] }>
        remediation: { status: string, version: string, source: string, changeType: string }
      }>
    }
    const output = JSON.stringify(summary)

    assert.deepEqual(summary.packages, { total: 2, direct: 1, transitive: 1, checked: 2, unchecked: 0 })
    assert.equal(summary.vulnerabilities.total, 1)
    assert.equal(summary.vulnerabilities.affectedPackages, 1)
    assert.equal(summary.findings.length, 1)
    assert.equal(summary.findings[0].name, 'vulnerable-dep')
    assert.equal(summary.findings[0].severity, 'HIGH')
    assert.equal(summary.findings[0].vulnerabilities[0].id, 'CVE-2026-1234')
    assert.deepEqual(summary.findings[0].vulnerabilities[0].vulnerable, ['< 1.0.1'])
    assert.deepEqual(summary.findings[0].vulnerabilities[0].patched, ['>= 1.0.1'])
    assert.deepEqual(summary.findings[0].remediation, {
      status: 'ncm-verified',
      version: '1.0.1',
      source: 'patched-range-boundary',
      changeType: 'patch'
    })
    assert.equal(summary.remediation.verified, 1)
    assert.deepEqual(summary.findings[0].license, { pass: true, spdx: 'MIT' })
    assert.deepEqual(summary.findings[0].moduleRisks, [{
      severity: 'CRITICAL',
      title: 'Package has an install script'
    }])
    assert.deepEqual(summary.findings[0].codeQuality, [{
      severity: 'MEDIUM',
      title: 'README is too small'
    }])
    assert.doesNotMatch(output, /clean-dep|SECRET_CLEAN_BLOAT|LARGE_RAW_ADVISORY|RAW_RISK_DATA|RAW_QUALITY_DATA|RAW_LICENSE_DATA/)
  } finally {
    await rm(projectDir, { recursive: true, force: true })
  }
})

test('audit helper verifies a concrete latest fallback when no boundary candidate exists', async () => {
  const projectDir = await createNpmProject(1)
  const requestedVersions: string[] = []

  try {
    const summary = await runAudit(projectDir, {
      token: 'test-token',
      fetchBatch: async (_apiUrl: string, _token: string, packages: Array<{ name: string, version: string }>) => {
        requestedVersions.push(...packages.map(pkg => pkg.version))
        return packages.map(pkg => {
          if (pkg.version === 'latest') {
            return { name: pkg.name, version: '2.0.0', published: true, scores: [] }
          }
          return {
            ...pkg,
            published: true,
            scores: [{
              group: 'security',
              pass: false,
              severity: 'HIGH',
              title: 'Vulnerability without an exclusive upper boundary',
              data: { vulnerable: ['<= 1.0.0'] }
            }]
          }
        })
      }
    }) as {
      packages: Record<string, number>
      remediation: Record<string, number>
      findings: Array<{ remediation: Record<string, string> }>
    }

    assert.deepEqual(requestedVersions, ['1.0.0', 'latest'])
    assert.equal(summary.packages.checked, 1)
    assert.equal(summary.remediation.verified, 1)
    assert.deepEqual(summary.findings[0].remediation, {
      status: 'ncm-verified',
      version: '2.0.0',
      source: 'latest-fallback',
      changeType: 'major'
    })
  } finally {
    await rm(projectDir, { recursive: true, force: true })
  }
})

test('audit helper never emits the literal latest as a remediation version', async () => {
  const projectDir = await createNpmProject(1)

  try {
    const summary = await runAudit(projectDir, {
      token: 'test-token',
      fetchBatch: async (_apiUrl: string, _token: string, packages: Array<{ name: string, version: string }>) => {
        return packages.map(pkg => ({
          ...pkg,
          published: true,
          scores: pkg.version === 'latest'
            ? []
            : [{
                group: 'security',
                pass: false,
                severity: 'HIGH',
                title: 'Known vulnerability',
                data: { vulnerable: ['<= 1.0.0'] }
              }]
        }))
      }
    }) as { remediation: { unresolved: number }, findings: Array<{ remediation: { status: string, version?: string } }> }

    assert.equal(summary.remediation.unresolved, 1)
    assert.deepEqual(summary.findings[0].remediation, { status: 'unresolved' })
    assert.equal(summary.findings[0].remediation.version, undefined)
  } finally {
    await rm(projectDir, { recursive: true, force: true })
  }
})

test('remediation verification failure does not make an audited package unchecked', async () => {
  const projectDir = await createNpmProject(1)

  try {
    const summary = await runAudit(projectDir, {
      token: 'test-token',
      fetchBatch: async (_apiUrl: string, _token: string, packages: Array<{ name: string, version: string }>) => {
        if (packages.some(pkg => pkg.version !== '1.0.0')) {
          throw Object.assign(new Error('candidate service failure'), { status: 503 })
        }
        return packages.map(pkg => ({
          ...pkg,
          published: true,
          scores: [{
            group: 'security',
            pass: false,
            severity: 'HIGH',
            title: 'Known vulnerability',
            data: { vulnerable: ['< 1.0.1'] }
          }]
        }))
      }
    }) as {
      packages: Record<string, number>
      batchFailures: { total: number }
      remediation: { verificationFailed: number, failures: { total: number } }
      findings: Array<{ remediation: { status: string } }>
    }

    assert.equal(summary.packages.checked, 1)
    assert.equal(summary.packages.unchecked, 0)
    assert.equal(summary.batchFailures.total, 0)
    assert.equal(summary.remediation.verificationFailed, 1)
    assert.equal(summary.remediation.failures.total, 2)
    assert.equal(summary.findings[0].remediation.status, 'verification-failed')
  } finally {
    await rm(projectDir, { recursive: true, force: true })
  }
})

test('withdrawn-only findings do not trigger remediation verification', async () => {
  const projectDir = await createNpmProject(1)
  let requests = 0

  try {
    const summary = await runAudit(projectDir, {
      token: 'test-token',
      fetchBatch: async (_apiUrl: string, _token: string, packages: Array<{ name: string, version: string }>) => {
        requests++
        return packages.map(pkg => ({
          ...pkg,
          published: true,
          scores: [{
            group: 'security',
            pass: false,
            severity: 'LOW',
            title: 'Withdrawn advisory',
            data: { vulnerable: ['< 1.0.1'] }
          }]
        }))
      }
    }) as {
      remediation: { notRequired: number, candidateRequests: number }
      findings: Array<{ remediation: Record<string, string> }>
    }

    assert.equal(requests, 1)
    assert.equal(summary.remediation.notRequired, 1)
    assert.equal(summary.remediation.candidateRequests, 0)
    assert.deepEqual(summary.findings[0].remediation, {
      status: 'not-required',
      reason: 'withdrawn-only'
    })
  } finally {
    await rm(projectDir, { recursive: true, force: true })
  }
})

test('remediation candidate batches remain within the two-request concurrency limit', async () => {
  const projectDir = await createNpmProject(205)
  let active = 0
  let maximumActive = 0

  try {
    const summary = await runAudit(projectDir, {
      token: 'test-token',
      fetchBatch: async (
        _apiUrl: string,
        _token: string,
        packages: Array<{ name: string, version: string }>,
        options: { phase?: string }
      ) => {
        if (options.phase === 'remediation') {
          active++
          maximumActive = Math.max(maximumActive, active)
          await new Promise(resolve => setTimeout(resolve, 5))
          active--
          return packages.map(pkg => ({ ...pkg, published: true, scores: [] }))
        }
        return packages.map(pkg => ({
          ...pkg,
          published: true,
          scores: [{
            group: 'security',
            pass: false,
            severity: 'HIGH',
            title: 'Known vulnerability',
            data: { vulnerable: ['< 2.0.0'] }
          }]
        }))
      }
    }) as {
      remediation: { candidateRequests: number, candidatesChecked: number, verified: number }
    }

    assert.equal(maximumActive, 2)
    assert.equal(summary.remediation.candidateRequests, 205)
    assert.equal(summary.remediation.candidatesChecked, 205)
    assert.equal(summary.remediation.verified, 205)
  } finally {
    await rm(projectDir, { recursive: true, force: true })
  }
})

test('audit helper retries an omitted remediation candidate response once', async () => {
  const projectDir = await createNpmProject(1)
  let remediationRequests = 0

  try {
    const summary = await runAudit(projectDir, {
      token: 'test-token',
      fetchBatch: async (
        _apiUrl: string,
        _token: string,
        packages: Array<{ name: string, version: string }>,
        options: { phase?: string }
      ) => {
        if (options.phase === 'remediation') {
          remediationRequests++
          if (remediationRequests === 1) return []
          return packages.map(pkg => ({ ...pkg, published: true, scores: [] }))
        }
        return packages.map(pkg => ({
          ...pkg,
          published: true,
          scores: [{
            group: 'security',
            pass: false,
            severity: 'HIGH',
            title: 'Known vulnerability',
            data: { vulnerable: ['< 1.0.1'] }
          }]
        }))
      }
    }) as {
      remediation: {
        verified: number
        recovery: { missingCandidateRetries: number }
        failures: { total: number }
      }
    }

    assert.equal(remediationRequests, 2)
    assert.equal(summary.remediation.verified, 1)
    assert.equal(summary.remediation.recovery.missingCandidateRetries, 1)
    assert.equal(summary.remediation.failures.total, 0)
  } finally {
    await rm(projectDir, { recursive: true, force: true })
  }
})

test('audit helper runs at most two batches concurrently', async () => {
  const projectDir = await createNpmProject(205)
  let active = 0
  let maximumActive = 0
  let batches = 0

  try {
    await runAudit(projectDir, {
      token: 'test-token',
      fetchBatch: async (_apiUrl: string, _token: string, packages: Array<{ name: string, version: string }>) => {
        batches++
        active++
        maximumActive = Math.max(maximumActive, active)
        await new Promise(resolve => setTimeout(resolve, 10))
        active--
        return packages.map(pkg => ({ ...pkg, published: true, scores: [] }))
      }
    })

    assert.equal(batches, 3)
    assert.equal(maximumActive, 2)
  } finally {
    await rm(projectDir, { recursive: true, force: true })
  }
})

test('audit helper reports progress after every completed batch', async () => {
  const projectDir = await createNpmProject(205)
  const progress: string[] = []

  try {
    await runAudit(projectDir, {
      token: 'test-token',
      onProgress: (message: string) => progress.push(message),
      fetchBatch: async (_apiUrl: string, _token: string, packages: Array<{ name: string, version: string }>) => {
        return packages.map(pkg => ({ ...pkg, published: true, scores: [] }))
      }
    })

    assert.deepEqual(progress, [
      'Audit progress: batches 1/3, packages 100/205\n',
      'Audit progress: batches 2/3, packages 200/205\n',
      'Audit progress: batches 3/3, packages 205/205\n'
    ])
  } finally {
    await rm(projectDir, { recursive: true, force: true })
  }
})

test('audit helper classifies failures without exposing raw errors', () => {
  assert.equal(classifyBatchFailure(Object.assign(new Error('request failed'), { status: 401 })), 'authentication')
  assert.equal(classifyBatchFailure(Object.assign(new Error('request failed'), { status: 429 })), 'rate-limit')
  assert.equal(classifyBatchFailure(Object.assign(new Error('request failed'), { status: 503 })), 'server')
  assert.equal(classifyBatchFailure(Object.assign(new Error('request failed'), { name: 'AbortError' })), 'timeout')
  assert.equal(classifyBatchFailure(new Error('fetch failed', { cause: Object.assign(new Error('dns'), { code: 'ENOTFOUND' }) })), 'network')
  assert.equal(classifyBatchFailure(Object.assign(new Error('bad response'), { code: 'NCM_INVALID_RESPONSE' })), 'invalid-response')
  assert.equal(classifyBatchFailure(new Error('unexpected failure')), 'unknown')
})

test('batch requests retry HTTP 500 with jitter and honor Retry-After', async () => {
  const packages = [{ name: 'package', version: '1.0.0' }]
  const jitterDelays: number[] = []
  const retryAfterDelays: number[] = []
  let http500Attempts = 0
  let http503Attempts = 0
  const response = (status: number, retryAfter: string | null = null) => ({
    ok: false,
    status,
    headers: { get: () => retryAfter },
    json: async () => ({})
  })

  await assert.rejects(fetchBatch('https://example.invalid', 'token', packages, {
    fetch: async () => {
      http500Attempts++
      return response(500)
    },
    random: () => 0.5,
    sleep: async (delay: number) => jitterDelays.push(delay)
  }))
  await assert.rejects(fetchBatch('https://example.invalid', 'token', packages, {
    fetch: async () => {
      http503Attempts++
      return response(503, '2')
    },
    sleep: async (delay: number) => retryAfterDelays.push(delay)
  }))

  assert.equal(http500Attempts, 3)
  assert.deepEqual(jitterDelays, [250, 500])
  assert.equal(http503Attempts, 3)
  assert.deepEqual(retryAfterDelays, [2000, 2000])
})

test('audit helper reports packages recovered by a transport retry', async () => {
  const projectDir = await createNpmProject(1)
  let attempts = 0

  try {
    const summary = await runAudit(projectDir, {
      token: 'test-token',
      random: () => 0,
      sleep: async () => {},
      fetch: async () => {
        attempts++
        if (attempts === 1) {
          return {
            ok: false,
            status: 500,
            headers: { get: () => null },
            json: async () => ({})
          }
        }
        return {
          ok: true,
          status: 200,
          headers: { get: () => null },
          json: async () => ({
            data: {
              packageVersions: [{ name: 'package-0', version: '1.0.0', published: true, scores: [] }]
            }
          })
        }
      }
    }) as {
      packages: Record<string, number>
      batchRecovery: Record<string, number>
    }

    assert.equal(attempts, 2)
    assert.equal(summary.packages.checked, 1)
    assert.equal(summary.batchRecovery.transportRetries, 1)
    assert.equal(summary.batchRecovery.recoveredPackages, 1)
  } finally {
    await rm(projectDir, { recursive: true, force: true })
  }
})

test('audit helper recovers an exhausted batch by splitting it once', async () => {
  const projectDir = await createNpmProject(100)
  const progress: string[] = []
  const requestSizes: number[] = []

  try {
    const summary = await runAudit(projectDir, {
      token: 'test-token',
      onProgress: (message: string) => progress.push(message),
      fetchBatch: async (_apiUrl: string, _token: string, packages: Array<{ name: string, version: string }>) => {
        requestSizes.push(packages.length)
        if (packages.length === 100) throw Object.assign(new Error('temporary failure'), { status: 503 })
        return packages.map(pkg => ({ ...pkg, published: true, scores: [] }))
      }
    }) as {
      packages: Record<string, number>
      batchFailures: { total: number, byReason: Record<string, number> }
      batchRecovery: Record<string, number>
    }

    assert.deepEqual(requestSizes, [100, 50, 50])
    assert.equal(summary.packages.checked, 100)
    assert.equal(summary.packages.unchecked, 0)
    assert.deepEqual(summary.batchFailures, { total: 0, byReason: {} })
    assert.deepEqual(summary.batchRecovery, {
      transportRetries: 0,
      splitBatches: 1,
      missingPackageRetries: 0,
      recoveredPackages: 100
    })
    assert.deepEqual(progress, ['Audit progress: batches 1/1, packages 100/100\n'])
  } finally {
    await rm(projectDir, { recursive: true, force: true })
  }
})

test('audit helper leaves only an unrecovered split unchecked', async () => {
  const projectDir = await createNpmProject(100)
  let requestNumber = 0

  try {
    const summary = await runAudit(projectDir, {
      token: 'test-token',
      fetchBatch: async (_apiUrl: string, _token: string, packages: Array<{ name: string, version: string }>) => {
        requestNumber++
        if (requestNumber === 1 || requestNumber === 3) {
          throw Object.assign(new Error('server PRIVATE_RAW_FAILURE'), { status: 503 })
        }
        return packages.map(pkg => ({ ...pkg, published: true, scores: [] }))
      }
    }) as {
      packages: Record<string, number>
      batchFailures: { total: number, byReason: Record<string, number> }
      batchRecovery: Record<string, number>
    }

    assert.equal(summary.packages.checked, 50)
    assert.equal(summary.packages.unchecked, 50)
    assert.deepEqual(summary.batchFailures, { total: 1, byReason: { server: 1 } })
    assert.equal(summary.batchRecovery.recoveredPackages, 50)
    assert.doesNotMatch(JSON.stringify(summary), /PRIVATE_RAW_FAILURE/)
  } finally {
    await rm(projectDir, { recursive: true, force: true })
  }
})

test('audit helper bounds an exhausted batch to seven transport attempts', async () => {
  const projectDir = await createNpmProject(100)
  let attempts = 0

  try {
    const summary = await runAudit(projectDir, {
      token: 'test-token',
      random: () => 0,
      sleep: async () => {},
      fetch: async () => {
        attempts++
        return {
          ok: false,
          status: 503,
          headers: { get: () => null },
          json: async () => ({})
        }
      }
    }) as {
      packages: Record<string, number>
      batchFailures: { total: number, byReason: Record<string, number> }
      batchRecovery: Record<string, number>
    }

    assert.equal(attempts, 7)
    assert.equal(summary.packages.unchecked, 100)
    assert.deepEqual(summary.batchFailures, { total: 2, byReason: { server: 2 } })
    assert.equal(summary.batchRecovery.transportRetries, 4)
    assert.equal(summary.batchRecovery.splitBatches, 1)
  } finally {
    await rm(projectDir, { recursive: true, force: true })
  }
})

test('audit helper retries omitted responses but not unpublished packages', async () => {
  const projectDir = await createNpmProject(10)
  const requestSizes: number[] = []

  try {
    const summary = await runAudit(projectDir, {
      token: 'test-token',
      fetchBatch: async (_apiUrl: string, _token: string, packages: Array<{ name: string, version: string }>) => {
        requestSizes.push(packages.length)
        if (packages.length === 10) {
          return packages.slice(0, 9).map((pkg, index) => ({
            ...pkg,
            published: index !== 0,
            scores: []
          }))
        }
        return packages.map(pkg => ({ ...pkg, published: true, scores: [] }))
      }
    }) as {
      packages: Record<string, number>
      batchFailures: { total: number, byReason: Record<string, number> }
      batchRecovery: Record<string, number>
    }

    assert.deepEqual(requestSizes, [10, 1])
    assert.equal(summary.packages.checked, 9)
    assert.equal(summary.packages.unchecked, 1)
    assert.deepEqual(summary.batchFailures, { total: 0, byReason: {} })
    assert.equal(summary.batchRecovery.missingPackageRetries, 1)
    assert.equal(summary.batchRecovery.recoveredPackages, 1)
  } finally {
    await rm(projectDir, { recursive: true, force: true })
  }
})

test('audit recovery remains within the two-request concurrency limit', async () => {
  const projectDir = await createNpmProject(205)
  const failedFullBatches = new Set<string>()
  let active = 0
  let maximumActive = 0

  try {
    await runAudit(projectDir, {
      token: 'test-token',
      fetchBatch: async (_apiUrl: string, _token: string, packages: Array<{ name: string, version: string }>) => {
        active++
        maximumActive = Math.max(maximumActive, active)
        await new Promise(resolve => setTimeout(resolve, 5))
        active--
        const key = packages[0].name
        if (packages.length === 100 && !failedFullBatches.has(key)) {
          failedFullBatches.add(key)
          throw Object.assign(new Error('temporary server failure'), { status: 503 })
        }
        return packages.map(pkg => ({ ...pkg, published: true, scores: [] }))
      }
    })

    assert.equal(maximumActive, 2)
  } finally {
    await rm(projectDir, { recursive: true, force: true })
  }
})

test('audit helper preserves severity sorting and the 50-finding limit', async () => {
  const projectDir = await createNpmProject(55)

  try {
    const summary = await runAudit(projectDir, {
      token: 'test-token',
      fetchBatch: async (_apiUrl: string, _token: string, packages: Array<{ name: string, version: string }>) => {
        return packages.map((pkg, index) => ({
          ...pkg,
          published: true,
          scores: [{
            group: 'security',
            pass: false,
            severity: index === packages.length - 1 ? 'CRITICAL' : 'LOW',
            title: index === 0 ? 'Withdrawn advisory' : 'Security issue'
          }]
        }))
      }
    }) as {
      vulnerabilities: { total: number, affectedPackages: number }
      findings: Array<{ severity: string, vulnerabilities: Array<{ withdrawn?: boolean }> }>
      truncatedFindings: number
    }

    assert.equal(summary.vulnerabilities.total, 55)
    assert.equal(summary.vulnerabilities.affectedPackages, 55)
    assert.equal(summary.findings.length, 50)
    assert.equal(summary.findings[0].severity, 'CRITICAL')
    assert.equal(summary.findings.some(finding => finding.vulnerabilities.some(item => item.withdrawn)), true)
    assert.equal(summary.truncatedFindings, 5)
  } finally {
    await rm(projectDir, { recursive: true, force: true })
  }
})
