#!/usr/bin/env node

import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync, existsSync, rmSync, mkdirSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const request = process.argv.slice(2).find((arg) => !arg.startsWith('-'))
const sourceFiles = ['bundle.json', 'packages/core/package.json', 'packages/pi-plugin/package.json']
const generatedFiles = [
  'packages/core/bundle.json',
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
const materializedDirs = ['packages/core/skills', 'packages/pi-plugin/skills']
const snapshots = new Map()
const directorySnapshots = new Map()

try {
  if (!request) throw new Error('Usage: pnpm release:prepare -- patch|minor|major|<version>')
  const currentBundle = readJson('bundle.json')
  const current = currentBundle.version
  if (!isStable(current)) throw new Error(`Current bundle version is invalid: ${current}`)
  const next = nextVersion(current, request)
  if (!next) throw new Error(`Requested release version is invalid or not greater than ${current}: ${request}`)

  for (const rel of [...sourceFiles, ...generatedFiles]) snapshot(rel)
  for (const rel of materializedDirs) snapshotDirectory(rel)
  for (const rel of sourceFiles) {
    const value = readJson(rel)
    value.version = next
    writeJson(rel, value)
  }

  run('packages/core/scripts/check-bundle-sync.mjs')
  run('scripts/materialize-github-marketplace.mjs')
  run('scripts/sync-plugin-assets.mjs')
  validate(next)

  console.log(`Prepared release ${next}`)
  for (const rel of changedFiles()) console.log(`  ${rel}`)
} catch (error) {
  restore()
  console.error(`release:prepare failed: ${error instanceof Error ? error.message : 'unknown error'}`)
  process.exitCode = 1
}

function nextVersion (current, requestValue) {
  if (requestValue === 'patch' || requestValue === 'minor' || requestValue === 'major') {
    const [major, minor, patch] = current.split('.').map(Number)
    if (requestValue === 'major') return `${major + 1}.0.0`
    if (requestValue === 'minor') return `${major}.${minor + 1}.0`
    return `${major}.${minor}.${patch + 1}`
  }
  if (!isStable(requestValue) || compare(requestValue, current) <= 0) return null
  return requestValue
}

function validate (version) {
  for (const rel of sourceFiles) {
    if (readJson(rel).version !== version) throw new Error(`${rel} did not receive ${version}`)
  }
  if (readFile('bundle.json') !== readFile('packages/core/bundle.json')) throw new Error('packages/core/bundle.json is not synchronized')
  for (const rel of ['.claude-plugin/marketplace.json', '.claude-plugin/plugin.json', '.agents/plugins/marketplace.json', '.codex-plugin/plugin.json']) {
    const value = readJson(rel)
    const versions = findVersions(value)
    if (versions.some((value) => value !== version)) throw new Error(`${rel} contains a stale version`)
  }
}

function findVersions (value) {
  if (!value || typeof value !== 'object') return []
  const output = []
  if (typeof value.version === 'string') output.push(value.version)
  for (const child of Object.values(value)) output.push(...findVersions(child))
  return output
}

function run (relativeScript) {
  execFileSync(process.execPath, [path.join(root, relativeScript)], { cwd: root, stdio: 'inherit' })
}

function snapshot (relative) {
  const file = path.join(root, relative)
  snapshots.set(relative, existsSync(file) ? readFile(relative) : null)
}

function restore () {
  for (const [relative, content] of snapshots) {
    const file = path.join(root, relative)
    if (content === null) {
      if (existsSync(file)) rmSync(file, { recursive: true, force: true })
    } else {
      writeFileSync(file, content)
    }
  }
  for (const [relative, files] of directorySnapshots) {
    const directory = path.join(root, relative)
    rmSync(directory, { recursive: true, force: true })
    if (!files) continue
    for (const [file, content] of files) {
      const target = path.join(root, file)
      mkdirSync(path.dirname(target), { recursive: true })
      writeFileSync(target, content)
    }
  }
}

function snapshotDirectory (relative) {
  const directory = path.join(root, relative)
  if (!existsSync(directory)) {
    directorySnapshots.set(relative, null)
    return
  }
  const files = new Map()
  collectDirectoryFiles(directory, relative, files)
  directorySnapshots.set(relative, files)
}

function collectDirectoryFiles (directory, relative, files) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const child = path.join(directory, entry.name)
    const childRelative = path.join(relative, entry.name)
    if (entry.isDirectory()) collectDirectoryFiles(child, childRelative, files)
    else if (entry.isFile()) files.set(childRelative, readFileSync(child))
  }
}

function changedFiles () {
  try {
    return execFileSync('git', ['diff', '--name-only', '--', ...sourceFiles, ...generatedFiles], { cwd: root, encoding: 'utf8' }).trim().split(/\r?\n/).filter(Boolean)
  } catch { return [] }
}

function readJson (relative) { return JSON.parse(readFile(relative)) }
function readFile (relative) { return readFileSync(path.join(root, relative), 'utf8') }
function writeJson (relative, value) { writeFileSync(path.join(root, relative), JSON.stringify(value, null, 2) + '\n') }
function isStable (value) { return typeof value === 'string' && /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(value) }
function compare (a, b) { return a.split('.').map(Number).reduce((result, part, index) => result || part - Number(b.split('.')[index]), 0) }
