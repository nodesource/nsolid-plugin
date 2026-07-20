#!/usr/bin/env node
'use strict'

/**
 * collect-dependencies.cjs
 *
 * Walks package.json + lockfile and emits a JSON summary ready for
 * getPackageVersions batch calls. Supports npm (package-lock.json v2/v3),
 * yarn (yarn.lock classic), and pnpm (pnpm-lock.yaml v5/v6/v9).
 *
 * Usage:
 *   node collect-dependencies.cjs [--dir /path/to/project]
 *
 * Output (stdout):
 *   {
 *     "packageManager": "npm|yarn|pnpm",
 *     "direct": <count>,
 *     "transitive": <count>,
 *     "batches": [[{name, version, isDirect, installedVersion?}, ...], ...]
 *   }
 *
 * Errors go to stderr; exit code 1 on unrecoverable failures.
 */

const fs = require('fs')
const path = require('path')

const BATCH_SIZE = 100

function parseArgs () {
  const args = process.argv.slice(2)
  let dir = process.cwd()
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--dir' && args[i + 1]) dir = args[++i]
  }
  return { dir }
}

// ---------------------------------------------------------------------------
// package.json helpers
// ---------------------------------------------------------------------------

function getDirectDeps (pkgJsonPath) {
  try {
    const json = JSON.parse(fs.readFileSync(pkgJsonPath, 'utf8'))
    const deps = new Set()
    for (const key of ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies']) {
      if (json[key] && typeof json[key] === 'object') {
        for (const name of Object.keys(json[key])) deps.add(name)
      }
    }
    return deps
  } catch {
    return new Set()
  }
}

function getInstalledVersion (dir, name) {
  if (typeof name !== 'string' || !/^(?:@[^/\\]+\/)?[^@/\\][^/\\]*$/.test(name)) return null
  const segments = name.split('/')
  if (segments.some(segment => segment === '.' || segment === '..')) return null

  try {
    const json = JSON.parse(fs.readFileSync(path.join(dir, 'node_modules', ...segments, 'package.json'), 'utf8'))
    return typeof json.version === 'string' && json.version.trim() && json.version !== 'latest'
      ? json.version
      : null
  } catch {
    return null
  }
}

// ---------------------------------------------------------------------------
// npm (package-lock.json v2 / v3)
// ---------------------------------------------------------------------------

function parseNpm (content, directDeps) {
  const deps = []
  let lock
  try { lock = JSON.parse(content) } catch { return deps }

  const packages = lock.packages
  if (!packages || typeof packages !== 'object') return deps

  for (const [pkgPath, meta] of Object.entries(packages)) {
    if (!pkgPath || pkgPath === '') continue
    if (!meta || typeof meta !== 'object') continue
    const version = meta.version
    if (typeof version !== 'string') continue
    const segments = pkgPath.replace(/^node_modules\//, '').split('/node_modules/')
    const name = segments[segments.length - 1]
    if (!name) continue
    const isDirect = directDeps.size > 0 ? directDeps.has(name) : segments.length === 1
    deps.push({ name, version, isDirect })
  }
  return deps
}

// ---------------------------------------------------------------------------
// yarn (yarn.lock classic v1)
// ---------------------------------------------------------------------------

function parseYarn (content, directDeps) {
  const deps = []
  if (!content || !content.trim()) return deps

  const seen = new Set()
  const lines = content.split('\n')
  let i = 0

  while (i < lines.length) {
    const line = lines[i]

    // Package header: "name@range, name@range2":  or  name@range:
    if (!line.match(/^["']?(@?[^@\s][^"]*?)@[^:]+["']?:\s*$/)) {
      i++
      continue
    }

    const specifier = line.replace(/^["']?/, '').replace(/["']?:\s*$/, '')
    const nameMatch = specifier.match(/^(@?[^@]+)@/)
    if (!nameMatch) { i++; continue }

    const name = nameMatch[1]
    let version = ''
    i++

    while (i < lines.length) {
      const inner = lines[i]
      // End of block when back at top-level indentation
      if (inner.length > 0 && !inner.startsWith(' ') && !inner.startsWith('\t')) break
      const vm = inner.match(/^\s+version\s+"([^"]+)"/)
      if (vm) { version = vm[1] }
      i++
    }

    if (version && !seen.has(name + '@' + version)) {
      seen.add(name + '@' + version)
      const isDirect = directDeps.size > 0 ? directDeps.has(name) : false
      deps.push({ name, version, isDirect })
    }
  }

  return deps
}

// ---------------------------------------------------------------------------
// pnpm (pnpm-lock.yaml v5 / v6 / v9)
// ---------------------------------------------------------------------------

function parsePnpm (content, directDeps) {
  const deps = []
  if (!content || !content.trim()) return deps

  const lines = content.split('\n')
  let inPackages = false
  let currentName = ''
  let currentVersion = ''
  const seen = new Set()

  const flush = () => {
    if (currentName && currentVersion) {
      const key = currentName + '@' + currentVersion
      if (!seen.has(key)) {
        seen.add(key)
        const isDirect = directDeps.size > 0 ? directDeps.has(currentName) : false
        deps.push({ name: currentName, version: currentVersion, isDirect })
      }
    }
    currentName = ''
    currentVersion = ''
  }

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]

    if (/^packages\s*:\s*$/.test(line)) { inPackages = true; continue }
    if (!inPackages) continue

    // Back to top-level = end of packages block
    if (line.length > 0 && !line.startsWith(' ') && !line.startsWith('\t')) {
      flush()
      inPackages = false
      break
    }

    // pnpm v5/v6 scoped: /  /@scope/name/version:
    const v6Scoped = line.match(/^\s{2}\/?(@[^/\s]+\/[^/\s]+)\/([^/@:()\s'"]+)\s*:/)
    // pnpm v5/v6 non-scoped: /  /name/version:
    const v6Plain = !v6Scoped ? line.match(/^\s{2}\/([^@/\s'"]+)\/([^/:()\s'"]+)\s*:/) : null
    // pnpm v9: '  name@version:'
    const v9 = !v6Scoped && !v6Plain
      ? line.match(/^\s{2}['"]?\/?(@?[^@\s'":]+)@([^'":()\s]+)/)
      : null

    const m = v6Scoped || v6Plain || v9
    if (m) {
      flush()
      currentName = m[1]
      currentVersion = (m[2] || '').replace(/['"]$/, '')
      continue
    }

    if (!currentName) continue

    // Inline version override (v5/v6 sometimes lists version: inside the block)
    const vline = line.match(/^\s+version:\s*['"]?([^'"\s]+)/)
    if (vline && !currentVersion) {
      currentVersion = vline[1].replace(/['"]$/, '')
    }
  }

  flush()
  return deps
}

// ---------------------------------------------------------------------------
// Dedup + batch
// ---------------------------------------------------------------------------

function dedup (deps) {
  const map = new Map()
  for (const d of deps) {
    const key = d.name + '@' + d.version
    if (!map.has(key)) map.set(key, d)
  }
  return Array.from(map.values())
}

function batch (arr, size) {
  const batches = []
  for (let i = 0; i < arr.length; i += size) {
    batches.push(arr.slice(i, i + size))
  }
  return batches
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function collectDependencies (dir) {
  const pkgJsonPath = path.join(dir, 'package.json')
  if (!fs.existsSync(pkgJsonPath)) {
    throw new Error(`package.json not found in ${dir}`)
  }

  const directDeps = getDirectDeps(pkgJsonPath)
  const pkgJsonContent = fs.readFileSync(pkgJsonPath, 'utf8')

  let declaredPm = null
  try {
    const parsedPkg = JSON.parse(pkgJsonContent)
    if (typeof parsedPkg.packageManager === 'string') {
      declaredPm = parsedPkg.packageManager.split('@')[0]
    }
  } catch {}

  let packageManager = 'npm'
  let deps = []

  const npmLock = path.join(dir, 'package-lock.json')
  const yarnLock = path.join(dir, 'yarn.lock')
  const pnpmLock = path.join(dir, 'pnpm-lock.yaml')

  if (declaredPm === 'npm' && fs.existsSync(npmLock)) {
    packageManager = 'npm'
    deps = parseNpm(fs.readFileSync(npmLock, 'utf8'), directDeps)
  } else if (declaredPm === 'yarn' && fs.existsSync(yarnLock)) {
    packageManager = 'yarn'
    deps = parseYarn(fs.readFileSync(yarnLock, 'utf8'), directDeps)
  } else if (declaredPm === 'pnpm' && fs.existsSync(pnpmLock)) {
    packageManager = 'pnpm'
    deps = parsePnpm(fs.readFileSync(pnpmLock, 'utf8'), directDeps)
  } else if (fs.existsSync(npmLock)) {
    packageManager = 'npm'
    deps = parseNpm(fs.readFileSync(npmLock, 'utf8'), directDeps)
  } else if (fs.existsSync(yarnLock)) {
    packageManager = 'yarn'
    deps = parseYarn(fs.readFileSync(yarnLock, 'utf8'), directDeps)
  } else if (fs.existsSync(pnpmLock)) {
    packageManager = 'pnpm'
    deps = parsePnpm(fs.readFileSync(pnpmLock, 'utf8'), directDeps)
  } else {
    // No lockfile — fall back to package.json direct deps only
    try {
      const json = JSON.parse(pkgJsonContent)
      for (const section of ['dependencies', 'devDependencies']) {
        const block = json[section]
        if (block && typeof block === 'object') {
          for (const [name, range] of Object.entries(block)) {
            const version = String(range).replace(/^[^0-9]*/, '') || 'latest'
            const installedVersion = version === 'latest' ? getInstalledVersion(dir, name) : null
            deps.push({
              name,
              version,
              isDirect: true,
              ...(installedVersion ? { installedVersion } : {})
            })
          }
        }
      }
    } catch { /* ignore */ }
  }

  const unique = dedup(deps)
  const directCount = unique.filter(d => d.isDirect).length
  const transitiveCount = unique.length - directCount

  return {
    packageManager,
    direct: directCount,
    transitive: transitiveCount,
    batches: batch(unique, BATCH_SIZE)
  }
}

if (require.main === module) {
  try {
    const { dir } = parseArgs()
    const result = collectDependencies(dir)
    process.stdout.write(JSON.stringify(result, null, 2) + '\n')
  } catch (error) {
    process.stderr.write(`Error: ${error.message}\n`)
    process.exitCode = 1
  }
}

module.exports = { collectDependencies }
