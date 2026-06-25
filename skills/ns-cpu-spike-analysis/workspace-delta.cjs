#!/usr/bin/env node

'use strict'

const fs = require('fs')
const path = require('path')
const { createHash } = require('crypto')

const DEFAULT_CONTEXT_LINES = 12
const MAX_CONTEXT_LINES = 40
const APP_ENV_KEYS = ['NSOLID_APPNAME', 'NSOLID_APP']
const KNOWN_RUNTIME_PREFIXES = [
  'app/',
  'usr/src/app/',
  'home/node/app/',
  'srv/app/',
  'workspace/'
]

function main () {
  const argv = process.argv.slice(2)
  if (argv.includes('--help') || argv.includes('-h')) {
    printHelp()
    process.exit(0)
  }

  const input = readInput(argv)
  const result = computeWorkspaceDelta(input)
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
}

function printHelp () {
  process.stdout.write(
    'Usage:\n' +
    '  node .agents/skills/ns-cpu-spike-analysis/workspace-delta.cjs <input.json>\n' +
    '  printf \'%s\' \'<json>\' | node .agents/skills/ns-cpu-spike-analysis/workspace-delta.cjs\n\n' +
    'Input JSON fields:\n' +
    '  workspaceRoot?: string\n' +
    '  targetAppName?: string\n' +
    '  runtimePath?: string\n' +
    '  workspaceRelativePath?: string\n' +
    '  runtimeCode: string\n' +
    '  startLine?: number\n' +
    '  endLine?: number\n' +
    '  lineHint?: number\n' +
    '  contextLines?: number\n'
  )
}

function readInput (argv) {
  let raw = ''

  if (argv.length > 0) {
    raw = fs.readFileSync(argv[0], 'utf-8')
  } else if (!process.stdin.isTTY) {
    raw = fs.readFileSync(0, 'utf-8')
  } else {
    throw new Error('Missing input. Pass a JSON file path or pipe JSON via stdin.')
  }

  if (raw.trim().length === 0) {
    throw new Error('Input JSON is empty.')
  }

  return JSON.parse(raw)
}

function computeWorkspaceDelta (input) {
  const requestedWorkspaceRoot = cleanString(input.workspaceRoot)
  const workspaceRoot = requestedWorkspaceRoot != null
    ? resolveExistingDir(requestedWorkspaceRoot)
    : findWorkspaceRoot(process.cwd())
  const runtimeCode = typeof input.runtimeCode === 'string' ? input.runtimeCode.trim() : ''
  const targetAppName = cleanString(input.targetAppName)
  const runtimePath = cleanString(input.runtimePath)
  const workspaceRelativePath = cleanString(input.workspaceRelativePath)

  if (workspaceRoot == null) {
    return buildFailure(
      'No workspace root could be resolved.',
      null,
      targetAppName,
      runtimePath
    )
  }

  const identity = discoverWorkspaceIdentity(workspaceRoot)
  const workspaceMatchesTargetApp = targetAppName && identity.name
    ? normalizeAppName(identity.name) === normalizeAppName(targetAppName)
    : null

  if (runtimeCode.length === 0) {
    return {
      ok: false,
      error: 'Input "runtimeCode" must be a non-empty string.',
      workspaceRoot,
      targetAppName,
      workspaceIdentity: identity,
      workspaceMatchesTargetApp,
      comparisonSkippedReason: 'Runtime code is required to compute a workspace delta.',
      runtimePath,
      resolvedWorkspacePath: null,
      pathMappingStrategy: null,
      comparisonMode: null,
      lineRange: null,
      fileExists: false,
      inSync: null,
      workspaceHash: null,
      workspaceCode: null,
      diff: null
    }
  }

  if (!targetAppName) {
    return {
      ok: true,
      workspaceRoot,
      targetAppName,
      workspaceIdentity: identity,
      workspaceMatchesTargetApp,
      comparisonSkippedReason: 'Target app name was not provided, so workspace identity could not be verified safely.',
      runtimePath,
      resolvedWorkspacePath: null,
      pathMappingStrategy: null,
      comparisonMode: null,
      lineRange: null,
      fileExists: false,
      inSync: null,
      workspaceHash: null,
      workspaceCode: null,
      diff: null
    }
  }

  if (workspaceMatchesTargetApp !== true) {
    const workspaceLabel = identity.name || 'unresolved'
    return {
      ok: true,
      workspaceRoot,
      targetAppName,
      workspaceIdentity: identity,
      workspaceMatchesTargetApp,
      comparisonSkippedReason: identity.name == null
        ? `Workspace identity could not be resolved, so comparison against target app "${targetAppName}" was skipped.`
        : `Workspace does not match profiled app ("${workspaceLabel}" vs "${targetAppName}") — comparison skipped.`,
      runtimePath,
      resolvedWorkspacePath: null,
      pathMappingStrategy: null,
      comparisonMode: null,
      lineRange: null,
      fileExists: false,
      inSync: null,
      workspaceHash: null,
      workspaceCode: null,
      diff: null
    }
  }

  const resolved = resolveWorkspaceFile(workspaceRoot, workspaceRelativePath, runtimePath)
  if (resolved == null) {
    return {
      ok: true,
      workspaceRoot,
      targetAppName,
      workspaceIdentity: identity,
      workspaceMatchesTargetApp,
      comparisonSkippedReason: runtimePath != null || workspaceRelativePath != null
        ? 'The runtime file could not be mapped to a file inside the current workspace.'
        : 'No runtime path or workspace-relative path was provided for file mapping.',
      runtimePath,
      resolvedWorkspacePath: null,
      pathMappingStrategy: null,
      comparisonMode: null,
      lineRange: null,
      fileExists: false,
      inSync: null,
      workspaceHash: null,
      workspaceCode: null,
      diff: null
    }
  }

  const content = fs.readFileSync(resolved.absolutePath, 'utf-8')
  const lines = content.split(/\r?\n/)
  const sliceSelection = selectWorkspaceSlice(lines, input)
  if (sliceSelection == null) {
    return {
      ok: true,
      workspaceRoot,
      targetAppName,
      workspaceIdentity: identity,
      workspaceMatchesTargetApp,
      comparisonSkippedReason: 'A precise comparison needs either start/end lines or a line hint.',
      runtimePath,
      resolvedWorkspacePath: resolved.relativePath,
      pathMappingStrategy: resolved.strategy,
      comparisonMode: null,
      lineRange: null,
      fileExists: true,
      inSync: null,
      workspaceHash: null,
      workspaceCode: null,
      diff: null
    }
  }

  const workspaceCode = lines.slice(sliceSelection.startLine - 1, sliceSelection.endLine).join('\n')
  const workspaceHash = createHash('sha256').update(workspaceCode).digest('hex')
  const inSync = codesLikelyInSync(workspaceCode, runtimeCode)

  return {
    ok: true,
    workspaceRoot,
    targetAppName,
    workspaceIdentity: identity,
    workspaceMatchesTargetApp,
    comparisonSkippedReason: null,
    runtimePath,
    resolvedWorkspacePath: resolved.relativePath,
    pathMappingStrategy: resolved.strategy,
    comparisonMode: sliceSelection.mode,
    lineRange: {
      startLine: sliceSelection.startLine,
      endLine: sliceSelection.endLine
    },
    fileExists: true,
    inSync,
    workspaceHash,
    workspaceCode,
    diff: inSync ? null : buildUnifiedDiff(runtimeCode, workspaceCode)
  }
}

function buildFailure (message, workspaceRoot, targetAppName, runtimePath) {
  return {
    ok: false,
    error: message,
    workspaceRoot,
    targetAppName,
    workspaceIdentity: { source: 'unresolved', name: null, candidates: [] },
    workspaceMatchesTargetApp: null,
    comparisonSkippedReason: message,
    runtimePath,
    resolvedWorkspacePath: null,
    pathMappingStrategy: null,
    comparisonMode: null,
    lineRange: null,
    fileExists: false,
    inSync: null,
    workspaceHash: null,
    workspaceCode: null,
    diff: null
  }
}

function resolveExistingDir (value) {
  try {
    const absolute = path.resolve(value)
    if (!fs.existsSync(absolute)) return null
    const stat = fs.statSync(absolute)
    if (!stat.isDirectory()) return null
    return fs.realpathSync(absolute)
  } catch {
    return null
  }
}

function findWorkspaceRoot (startDir) {
  let dir = path.resolve(startDir)
  while (true) {
    if (
      fs.existsSync(path.join(dir, '.vscode', 'settings.json')) ||
      fs.existsSync(path.join(dir, 'package.json')) ||
      fs.existsSync(path.join(dir, '.git'))
    ) {
      return fs.realpathSync(dir)
    }

    const parent = path.dirname(dir)
    if (parent === dir) {
      return fs.existsSync(startDir) ? fs.realpathSync(startDir) : null
    }
    dir = parent
  }
}

function discoverWorkspaceIdentity (workspaceRoot) {
  const mappedApp = readMappedAppName(workspaceRoot)
  const workspaceInfo = discoverWorkspaceAppInfo(workspaceRoot)

  if (mappedApp) {
    return {
      source: 'mappedApp',
      name: mappedApp,
      candidates: uniqueStrings([mappedApp].concat(workspaceInfo.candidates))
    }
  }

  if (workspaceInfo.configuredAppName) {
    return {
      source: 'workspaceConfig',
      name: workspaceInfo.configuredAppName,
      candidates: uniqueStrings([workspaceInfo.configuredAppName].concat(workspaceInfo.candidates))
    }
  }

  if (workspaceInfo.workspacePackageName) {
    return {
      source: 'package.json.name',
      name: workspaceInfo.workspacePackageName,
      candidates: uniqueStrings([workspaceInfo.workspacePackageName].concat(workspaceInfo.candidates))
    }
  }

  return {
    source: 'unresolved',
    name: null,
    candidates: uniqueStrings(workspaceInfo.candidates)
  }
}

function readMappedAppName (workspaceRoot) {
  const settingsPath = path.join(workspaceRoot, '.vscode', 'settings.json')
  if (!fs.existsSync(settingsPath)) {
    return null
  }

  try {
    const raw = fs.readFileSync(settingsPath, 'utf-8')
    const cleaned = stripTrailingCommas(stripJsonComments(raw))
    const settings = JSON.parse(cleaned)
    return cleanString(settings['nsolid.mappedApp'])
  } catch {
    return null
  }
}

function discoverWorkspaceAppInfo (workspaceRoot) {
  let configuredAppName = null
  let workspacePackageName = null
  const candidates = []

  const pushCandidate = (value) => {
    const trimmed = cleanString(value)
    if (trimmed && !candidates.includes(trimmed)) {
      candidates.push(trimmed)
    }
  }

  const packageJsonPath = path.join(workspaceRoot, 'package.json')
  if (fs.existsSync(packageJsonPath)) {
    try {
      const packageJsonRaw = fs.readFileSync(packageJsonPath, 'utf-8')
      const packageJson = JSON.parse(packageJsonRaw)

      if (typeof packageJson?.nsolid?.app === 'string' && packageJson.nsolid.app.trim().length > 0) {
        configuredAppName = packageJson.nsolid.app.trim()
      }
      if (typeof packageJson?.name === 'string' && packageJson.name.trim().length > 0) {
        workspacePackageName = packageJson.name.trim()
      }

      pushCandidate(configuredAppName)
      pushCandidate(findAppNameInText(packageJsonRaw))
      pushCandidate(workspacePackageName)
    } catch {}
  }

  for (const filePath of listWorkspaceConfigFiles(workspaceRoot)) {
    try {
      const content = fs.readFileSync(filePath, 'utf-8')
      const discovered = findAllAppNamesInText(content)
      for (const name of discovered) {
        pushCandidate(name)
        if (configuredAppName == null) {
          configuredAppName = name
        }
      }
    } catch {}
  }

  return {
    configuredAppName,
    workspacePackageName,
    candidates
  }
}

function listWorkspaceConfigFiles (workspaceRoot) {
  let names = []
  try {
    names = fs.readdirSync(workspaceRoot)
  } catch {
    return []
  }

  return names
    .filter(name =>
      name === '.env' ||
      name.startsWith('.env.') ||
      /^docker-compose(\.[^.]+)?\.ya?ml$/i.test(name) ||
      /^compose(\.[^.]+)?\.ya?ml$/i.test(name) ||
      /^Dockerfile(\..+)?$/i.test(name)
    )
    .map(name => path.join(workspaceRoot, name))
}

function findAllAppNamesInText (content) {
  const results = []
  const seen = new Set()

  const push = (value) => {
    const trimmed = cleanString(value)
    if (trimmed && !seen.has(trimmed)) {
      seen.add(trimmed)
      results.push(trimmed)
    }
  }

  for (const line of content.split(/\r?\n/)) {
    const match = line.match(/(?:^|\s)(?:ENV\s+)?(NSOLID_APPNAME|NSOLID_APP)(?:\s*[:=]\s*|\s+)(?:"([^"]+)"|'([^']+)'|([^\s#,'"}]+))/i)
    push(match && (match[2] || match[3] || match[4]))
  }

  for (const key of APP_ENV_KEYS) {
    const regex = new RegExp(`"${key}"\\s*:\\s*"([^"]+)"`, 'gi')
    let match
    while ((match = regex.exec(content)) !== null) {
      push(match[1])
    }
  }

  return results
}

function findAppNameInText (content) {
  return findAllAppNamesInText(content)[0] || null
}

function resolveWorkspaceFile (workspaceRoot, workspaceRelativePath, runtimePath) {
  const candidates = []

  const pushCandidate = (value, strategy) => {
    if (typeof value !== 'string') return
    const normalized = normalizeCandidatePath(value)
    if (normalized.length === 0) return
    if (!candidates.some(candidate => candidate.relativePath === normalized)) {
      candidates.push({ relativePath: normalized, strategy })
    }
  }

  pushCandidate(workspaceRelativePath, 'workspaceRelativePath')

  if (runtimePath) {
    pushCandidate(runtimePath, 'runtimePath')

    const normalizedRuntimePath = normalizeCandidatePath(runtimePath)
    for (const prefix of KNOWN_RUNTIME_PREFIXES) {
      if (normalizedRuntimePath.startsWith(prefix)) {
        pushCandidate(normalizedRuntimePath.slice(prefix.length), `runtimePath:${prefix}`)
      }
    }

    const segments = normalizedRuntimePath.split('/').filter(Boolean)
    for (let index = 1; index < segments.length; index++) {
      pushCandidate(segments.slice(index).join('/'), 'runtimePathSuffix')
    }
  }

  const realWorkspaceRoot = fs.realpathSync(workspaceRoot)
  for (const candidate of candidates) {
    const safePath = resolveSafeWorkspacePath(realWorkspaceRoot, candidate.relativePath)
    if (safePath == null) {
      continue
    }
    return {
      relativePath: path.relative(realWorkspaceRoot, safePath).split(path.sep).join('/'),
      absolutePath: safePath,
      strategy: candidate.strategy
    }
  }

  return null
}

function resolveSafeWorkspacePath (workspaceRoot, relativePath) {
  const normalized = path.posix.normalize(relativePath)
  if (
    normalized.length === 0 ||
    normalized === '.' ||
    normalized === '..' ||
    normalized.startsWith('../')
  ) {
    return null
  }

  const absolute = path.resolve(workspaceRoot, normalized)
  if (!fs.existsSync(absolute)) {
    return null
  }

  const realAbsolute = fs.realpathSync(absolute)
  if (realAbsolute !== workspaceRoot && !realAbsolute.startsWith(workspaceRoot + path.sep)) {
    return null
  }

  let stat
  try {
    stat = fs.statSync(realAbsolute)
  } catch {
    return null
  }
  if (!stat.isFile()) {
    return null
  }

  return realAbsolute
}

function selectWorkspaceSlice (lines, input) {
  if (lines.length === 0) {
    return null
  }

  const startLine = toPositiveInteger(input.startLine)
  const endLine = toPositiveInteger(input.endLine)
  if (startLine != null && endLine != null && endLine >= startLine) {
    if (startLine > lines.length) {
      return null
    }
    return {
      startLine,
      endLine: Math.min(endLine, lines.length),
      mode: 'lineRange'
    }
  }

  const lineHint = toPositiveInteger(input.lineHint)
  if (lineHint == null || lineHint > lines.length) {
    return null
  }

  const contextLines = Math.min(
    Math.max(toPositiveInteger(input.contextLines) || DEFAULT_CONTEXT_LINES, 1),
    MAX_CONTEXT_LINES
  )
  const runtimeLineCount = Math.max(1, countLines(input.runtimeCode))
  const start = Math.max(1, lineHint - contextLines)
  const end = Math.min(lines.length, lineHint + runtimeLineCount + contextLines - 1)

  return {
    startLine: start,
    endLine: end,
    mode: 'lineHintWindow'
  }
}

function buildUnifiedDiff (runtimeCode, workspaceCode) {
  const runtimeLines = runtimeCode.split(/\r?\n/)
  const workspaceLines = workspaceCode.split(/\r?\n/)
  const MAX_DIFF_CELLS = 2_000_000
  if ((runtimeLines.length + 1) * (workspaceLines.length + 1) > MAX_DIFF_CELLS) {
    return '@@ runtime vs workspace @@\n... diff omitted (selection too large) ...'
  }
  const dp = Array.from({ length: runtimeLines.length + 1 }, () => Array(workspaceLines.length + 1).fill(0))

  for (let i = runtimeLines.length - 1; i >= 0; i--) {
    for (let j = workspaceLines.length - 1; j >= 0; j--) {
      dp[i][j] = runtimeLines[i] === workspaceLines[j]
        ? dp[i + 1][j + 1] + 1
        : Math.max(dp[i + 1][j], dp[i][j + 1])
    }
  }

  const rawDiff = ['@@ runtime vs workspace @@']
  let i = 0
  let j = 0

  while (i < runtimeLines.length && j < workspaceLines.length) {
    if (runtimeLines[i] === workspaceLines[j]) {
      rawDiff.push(` ${runtimeLines[i]}`)
      i++
      j++
      continue
    }

    if (dp[i + 1][j] >= dp[i][j + 1]) {
      rawDiff.push(`-${runtimeLines[i]}`)
      i++
    } else {
      rawDiff.push(`+${workspaceLines[j]}`)
      j++
    }
  }

  while (i < runtimeLines.length) {
    rawDiff.push(`-${runtimeLines[i]}`)
    i++
  }

  while (j < workspaceLines.length) {
    rawDiff.push(`+${workspaceLines[j]}`)
    j++
  }

  return compactDiff(rawDiff)
}

function compactDiff (lines) {
  if (lines.length <= 14) {
    return lines.join('\n')
  }

  const result = [lines[0]]
  let index = 1
  while (index < lines.length) {
    if (!lines[index].startsWith(' ')) {
      result.push(lines[index])
      index++
      continue
    }

    let end = index
    while (end < lines.length && lines[end].startsWith(' ')) {
      end++
    }

    const unchangedCount = end - index
    if (unchangedCount <= 6) {
      result.push.apply(result, lines.slice(index, end))
    } else {
      result.push.apply(result, lines.slice(index, index + 3))
      result.push(`... ${unchangedCount - 6} unchanged line(s) omitted ...`)
      result.push.apply(result, lines.slice(end - 3, end))
    }
    index = end
  }

  return result.join('\n')
}

function stripJsonComments (input) {
  let output = ''
  let inString = false
  let escaped = false
  let inLineComment = false
  let inBlockComment = false

  for (let index = 0; index < input.length; index++) {
    const current = input[index]
    const next = input[index + 1]

    if (inLineComment) {
      if (current === '\n') {
        inLineComment = false
        output += current
      }
      continue
    }

    if (inBlockComment) {
      if (current === '*' && next === '/') {
        inBlockComment = false
        index++
      }
      continue
    }

    if (inString) {
      output += current
      if (escaped) {
        escaped = false
      } else if (current === '\\') {
        escaped = true
      } else if (current === '"') {
        inString = false
      }
      continue
    }

    if (current === '"') {
      inString = true
      output += current
      continue
    }

    if (current === '/' && next === '/') {
      inLineComment = true
      index++
      continue
    }

    if (current === '/' && next === '*') {
      inBlockComment = true
      index++
      continue
    }

    output += current
  }

  return output
}

function stripTrailingCommas (input) {
  return input.replace(/,\s*([}\]])/g, '$1')
}

function normalizeCandidatePath (value) {
  return value
    .trim()
    .replace(/^[a-z]+:\/\/+/i, '')
    .replace(/^[A-Za-z]:/, '')
    .replace(/\\/g, '/')
    .replace(/^\/+/, '')
}

function normalizeAppName (value) {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
}

function uniqueStrings (values) {
  const seen = new Set()
  const result = []
  for (const value of values) {
    const cleaned = cleanString(value)
    if (cleaned && !seen.has(cleaned)) {
      seen.add(cleaned)
      result.push(cleaned)
    }
  }
  return result
}

function cleanString (value) {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : null
}

function countLines (value) {
  if (typeof value !== 'string' || value.length === 0) {
    return 0
  }
  return value.split(/\r?\n/).length
}

function toPositiveInteger (value) {
  const number = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(number) || number <= 0) {
    return null
  }
  return Math.floor(number)
}

function codesLikelyInSync (workspaceCode, runtimeCode) {
  if (typeof runtimeCode !== 'string') {
    return false
  }

  const normalizedWorkspace = normalizeCodeForComparison(workspaceCode)
  const normalizedRuntime = normalizeCodeForComparison(runtimeCode)
  if (normalizedWorkspace.length === 0 || normalizedRuntime.length === 0) {
    return false
  }

  return normalizedWorkspace === normalizedRuntime ||
    normalizedRuntime.includes(normalizedWorkspace) ||
    normalizedWorkspace.includes(normalizedRuntime)
}

function normalizeCodeForComparison (value) {
  return value.replace(/\s+/g, ' ').trim()
}

main()
