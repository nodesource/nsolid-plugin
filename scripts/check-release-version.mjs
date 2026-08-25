#!/usr/bin/env node

import { execFileSync } from 'node:child_process'
import { readFileSync, existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const releaseMode = process.argv.includes('--release')
const versionFiles = ['bundle.json', 'packages/core/package.json', 'packages/pi-plugin/package.json']
const payload = [
  'skills/**',
  'packages/core/src/**',
  'packages/pi-plugin/index.js',
  'bundle.json',
  '.claude-plugin/marketplace.json',
  '.claude-plugin/plugin.json',
  '.agents/plugins/marketplace.json',
  '.codex-plugin/plugin.json',
  '.claude-mcp.json',
  '.mcp.json',
  'plugin.json',
  'mcp_config.json',
  'scripts/mcp-wrapper.js',
]
const errors = []

const versions = versionFiles.map((rel) => ({ rel, version: readJson(rel)?.version }))
const canonical = versions[0].version
if (!isStable(canonical)) errors.push(`bundle.json has invalid version ${String(canonical)}`)
for (const entry of versions.slice(1)) {
  if (entry.version !== canonical) errors.push(`${entry.rel}: expected ${canonical}, found ${String(entry.version)}`)
}

checkCommand('packages/core/scripts/check-bundle-sync.mjs', '--check')
checkCommand('scripts/materialize-github-marketplace.mjs', '--check')
checkGeneratedVersions(canonical)

if (releaseMode) checkPayloadVersion(canonical)

if (errors.length > 0) {
  console.error('release:check failed')
  for (const error of errors) console.error(`  ${error}`)
  process.exitCode = 1
} else {
  console.log(`release:check OK (${canonical})`)
}

function checkCommand (script, argument) {
  try {
    execFileSync(process.execPath, [path.join(root, script), argument], { cwd: root, stdio: 'pipe' })
  } catch (error) {
    // Some constrained runners report EPERM after a successful child with a
    // zero exit status when its stdio pipe is closed by the supervisor.
    if (error?.status === 0) return
    const output = Buffer.isBuffer(error?.stderr) ? error.stderr.toString().trim() : ''
    errors.push(`${script}: ${output || 'generated files are out of sync'}`)
  }
}

function checkGeneratedVersions (expected) {
  for (const rel of ['.claude-plugin/marketplace.json', '.claude-plugin/plugin.json', '.agents/plugins/marketplace.json', '.codex-plugin/plugin.json']) {
    if (!existsSync(path.join(root, rel))) {
      errors.push(`${rel}: file is missing`)
      continue
    }
    const values = findVersions(readJson(rel))
    const mismatches = [...new Set(values.filter((value) => value !== expected))]
    if (mismatches.length > 0) errors.push(`${rel}: expected generated version ${expected}, found ${mismatches.join(', ')}`)
  }
}

function checkPayloadVersion (expected) {
  const tag = latestSemanticTag()
  if (!tag) {
    if (!errors.some((error) => error.includes('semantic-version Git tag') || error.includes('semantic release tag') || error.includes('shallow'))) errors.push('release mode requires an eligible semantic-version Git tag')
    return
  }
  const tagVersion = tag.version
  if (expected !== tagVersion) return
  const untrackedPayload = untrackedAllowlistedPayload()
  if (untrackedPayload.length > 0) {
    errors.push(`untracked plugin payload changed since ${tag.name}: ${untrackedPayload.join(', ')}`)
    return
  }
  // Compare the release tag with the complete current worktree. Release
  // checks are normally run before commit/tag publication, so HEAD-only
  // comparison would miss staged or unstaged payload changes.
  const unchanged = runGitQuiet(['diff', '--quiet', tag.name, '--', ...payload])
  if (unchanged === false) {
    errors.push(`plugin payload changed since ${tag.name} without an update-visible version; run release:prepare`)
  } else if (unchanged === undefined) {
    errors.push(`could not compare plugin payload with ${tag.name}`)
  }
}

function latestSemanticTag () {
  const output = runGitOutput(['tag', '--list'])
  if (output === undefined) return undefined
  const names = output
    .split(/\r?\n/)
    .map((tag) => tag.trim())
    .filter(Boolean)
  const semanticNames = names.filter((name) => /^v?(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/.test(name))
  const candidates = names
    .map((name) => {
      const match = name.match(/^v?((?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*))$/)
      if (!match) return undefined
      const commit = runGitOutput(['rev-parse', `${name}^{commit}`])?.trim()
      if (!commit) return undefined
      const ancestry = runGitQuiet(['merge-base', '--is-ancestor', commit, 'HEAD'])
      if (ancestry !== true) return undefined
      return { name, version: match[1], commit }
    })
    .filter(Boolean)
  if (candidates.length === 0) {
    const shallow = runGitOutput(['rev-parse', '--is-shallow-repository'])?.trim() === 'true'
    if (shallow) errors.push('release mode cannot prove an eligible tag because repository history is shallow')
    else if (!output.trim()) errors.push('release mode found no local semantic-version Git tag; remote tags are not considered until fetched locally')
    else if (semanticNames.length === 0) errors.push('release mode found only malformed or non-semantic Git tags')
    else if (semanticNames.length > 0) errors.push('release mode found no semantic release tag that is an ancestor of HEAD')
    return undefined
  }
  candidates.sort((left, right) => compareStable(right.version, left.version))
  const selected = candidates[0]
  const duplicates = candidates.filter((entry) => entry.version === selected.version && entry.commit !== selected.commit)
  if (duplicates.length > 0) {
    errors.push(`release mode found ambiguous duplicate tags for version ${selected.version}: ${[selected, ...duplicates].map((entry) => entry.name).join(', ')}`)
    return undefined
  }
  return selected
}

function runGitOutput (args) {
  try {
    return execFileSync('git', args, { cwd: root, encoding: 'utf8' })
  } catch (error) {
    // Some constrained runners throw after a successful child process has
    // already populated stdout. Preserve that output just as checkCommand()
    // preserves a status-zero result.
    if (error?.status !== 0) return undefined
    if (typeof error?.stdout === 'string') return error.stdout
    if (Buffer.isBuffer(error?.stdout)) return error.stdout.toString('utf8')
    return undefined
  }
}

function runGitQuiet (args) {
  try {
    execFileSync('git', args, { cwd: root, stdio: 'pipe' })
    return true
  } catch (error) {
    if (error?.status === 0) return true
    if (error?.status === 1) return false
    return undefined
  }
}

function untrackedAllowlistedPayload () {
  const output = runGitOutput(['status', '--porcelain=v1', '--untracked-files=all', '-z'])
  if (output === undefined) {
    errors.push('could not inspect untracked plugin payload')
    return []
  }
  return output
    .split('\0')
    .filter((entry) => entry.startsWith('?? '))
    .map((entry) => entry.slice(3))
    .filter(isPayloadPath)
}

function isPayloadPath (relativePath) {
  const normalized = relativePath.replaceAll('\\', '/')
  return normalized === 'bundle.json' || normalized.startsWith('skills/') || normalized.startsWith('packages/core/src/') || normalized === 'packages/pi-plugin/index.js' || payload.includes(normalized)
}

function findVersions (value) {
  if (!value || typeof value !== 'object') return []
  const output = []
  if (typeof value.version === 'string') output.push(value.version)
  for (const child of Object.values(value)) output.push(...findVersions(child))
  return output
}

function readJson (relative) {
  try { return JSON.parse(readFileSync(path.join(root, relative), 'utf8')) } catch { return null }
}

function isStable (value) { return typeof value === 'string' && /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(value) }

function compareStable (left, right) {
  const a = left.split('.').map(Number)
  const b = right.split('.').map(Number)
  return a[0] - b[0] || a[1] - b[1] || a[2] - b[2]
}
