import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs'
import path from 'node:path'
import semver from 'semver'

/**
 * Canonical read-only validation for MCP bridge runtime trees.
 *
 * Readiness is judged exclusively on canonical (realpath) paths: a symlinked
 * tree cannot smuggle targets from outside the real root, a broken symlink
 * fails, and a regular file where a directory is required fails. Dependency
 * completeness is proven by a static closure walk (no package code runs).
 */

export interface RuntimeProbe {
  ok: boolean
  proxyPath?: string
  reason?: string
}

/**
 * Canonical containment per the readiness contract: `target` must resolve
 * (realpath) to `kind` with its canonical path equal to or inside the
 * canonical `boundary` by a path-segment-aware check. A missing canonical
 * target, a broken symlink or a symlink whose target escapes the boundary
 * fails. The `failure` discriminator lets callers map each cause to their own
 * error wording without re-implementing the probe.
 */
type CanonicalProbe =
  | { ok: true; canonical: string }
  | { ok: false; failure: 'unreadable'; reason: string }
  | { ok: false; failure: 'type'; reason: string }
  | { ok: false; failure: 'escape'; reason: string; canonical: string }

function canonicalTargetInside (target: string, boundary: string, kind: 'dir' | 'file'): CanonicalProbe {
  let canonical: string
  try {
    canonical = realpathSync(target)
  } catch {
    return { ok: false, failure: 'unreadable', reason: `${target} is missing or unreadable` }
  }
  let targetStat: ReturnType<typeof statSync>
  try {
    targetStat = statSync(canonical)
  } catch {
    return { ok: false, failure: 'unreadable', reason: `${target} is not statable` }
  }
  if (kind === 'dir' && !targetStat.isDirectory()) {
    return { ok: false, failure: 'type', reason: `${target} is not a directory` }
  }
  if (kind === 'file' && !targetStat.isFile()) {
    return { ok: false, failure: 'type', reason: `${target} is not a regular file` }
  }
  if (!isInsideBoundary(canonical, boundary)) {
    return { ok: false, failure: 'escape', reason: `${target} resolves outside the runtime root (${canonical})`, canonical }
  }
  return { ok: true, canonical }
}

/** Validate a runtime tree (a destination root or a staging directory). */
export function validateRuntimeRoot (root: string, expectedVersion: string): RuntimeProbe {
  // Anchor the canonical root to its canonical controlled parent before using
  // that root as the boundary for package targets. Otherwise a whole-root
  // symlink could move the boundary itself outside the managed tree.
  let canonicalParent: string
  try {
    canonicalParent = realpathSync(path.dirname(root))
    if (!statSync(canonicalParent).isDirectory()) {
      return { ok: false, reason: 'controlled runtime parent is not a directory' }
    }
  } catch {
    return { ok: false, reason: 'controlled runtime parent is missing or unreadable' }
  }

  const rootProbe = canonicalTargetInside(root, canonicalParent, 'dir')
  if (!rootProbe.ok) {
    if (rootProbe.failure === 'escape') {
      return { ok: false, reason: `runtime root resolves outside the controlled runtime parent (${rootProbe.canonical})` }
    }
    if (rootProbe.failure === 'type') {
      return { ok: false, reason: 'runtime root is not a directory' }
    }
    return { ok: false, reason: 'runtime root is missing or unreadable' }
  }
  const canonicalRoot = rootProbe.canonical

  const mcpRemoteDir = path.join(canonicalRoot, 'node_modules', 'mcp-remote')
  const packageProbe = canonicalTargetInside(mcpRemoteDir, canonicalRoot, 'dir')
  if (!packageProbe.ok) return { ok: false, reason: `node_modules/mcp-remote ${packageProbe.reason}` }

  const manifestProbe = canonicalTargetInside(path.join(mcpRemoteDir, 'package.json'), canonicalRoot, 'file')
  if (!manifestProbe.ok) {
    return { ok: false, reason: `node_modules/mcp-remote/package.json ${manifestProbe.reason}` }
  }
  let pkg: { name?: unknown; version?: unknown; dependencies?: unknown; optionalDependencies?: unknown }
  try {
    pkg = JSON.parse(readFileSync(manifestProbe.canonical, 'utf8'))
  } catch {
    return { ok: false, reason: 'node_modules/mcp-remote/package.json is missing or unreadable' }
  }
  if (pkg.name !== 'mcp-remote') {
    return { ok: false, reason: `expected package name "mcp-remote", found ${JSON.stringify(pkg.name)}` }
  }
  if (pkg.version !== expectedVersion) {
    return { ok: false, reason: `expected mcp-remote@${expectedVersion}, found ${String(pkg.version)}` }
  }

  const proxyProbe = canonicalTargetInside(path.join(mcpRemoteDir, 'dist', 'proxy.js'), canonicalRoot, 'file')
  if (!proxyProbe.ok) {
    return { ok: false, reason: `node_modules/mcp-remote/dist/proxy.js ${proxyProbe.reason}` }
  }

  // Static dependency-closure probe: detects missing, wrong-named and
  // version-incompatible transitives without executing package code (installs
  // run with --ignore-scripts).
  const closure = validateDependencyClosure(packageProbe.canonical, canonicalRoot)
  if (!closure.ok) {
    return { ok: false, reason: closure.reason }
  }

  return { ok: true, proxyPath: proxyProbe.canonical }
}

/**
 * Walk the (non-optional) dependency closure of `mcp-remote` using Node-style
 * node_modules resolution confined to `root`. For every resolved dependency:
 * its canonical path must remain inside `root`, its `package.json` `name` must
 * exactly equal the requested dependency name, and its installed `version`
 * must satisfy the range declared by its dependent (unparseable ranges fail
 * closed). Missing optional dependencies are tolerated.
 */
function validateDependencyClosure (
  startDir: string,
  root: string
): { ok: true } | { ok: false; reason: string } {
  const queue: Array<{ name: string; dir: string }> = [{ name: 'mcp-remote', dir: startDir }]
  const visited = new Set<string>()

  while (queue.length > 0) {
    const entry = queue.shift() as { name: string; dir: string }
    if (visited.has(entry.dir)) continue
    visited.add(entry.dir)

    const entryManifest = canonicalTargetInside(path.join(entry.dir, 'package.json'), root, 'file')
    let pkg: {
      dependencies?: Record<string, string>
      optionalDependencies?: Record<string, string>
    }
    try {
      if (!entryManifest.ok) throw new Error(entryManifest.reason)
      pkg = JSON.parse(readFileSync(entryManifest.canonical, 'utf8'))
    } catch {
      return { ok: false, reason: `package.json of "${entry.name}" is missing or unreadable` }
    }

    const optional = new Set(Object.keys(pkg.optionalDependencies ?? {}))
    for (const [dependency, declaredRange] of Object.entries(pkg.dependencies ?? {})) {
      const resolved = resolveWithinRuntime(entry.dir, dependency, root)
      if (!resolved) {
        if (optional.has(dependency)) continue
        return {
          ok: false,
          reason: `dependency "${dependency}" required by "${entry.name}" is missing inside the runtime root`,
        }
      }

      // Resolution must stay inside the runtime root after canonicalization —
      // a symlinked node_modules entry cannot satisfy the closure from
      // outside. The package target must be a directory; its manifest (below)
      // a regular file.
      const depDirProbe = canonicalTargetInside(resolved, root, 'dir')
      if (!depDirProbe.ok) {
        if (depDirProbe.failure === 'escape') {
          return {
            ok: false,
            reason: `dependency "${dependency}" required by "${entry.name}" resolves outside the runtime root (${resolved} → ${depDirProbe.canonical})`,
          }
        }
        if (depDirProbe.failure === 'type') {
          return {
            ok: false,
            reason: `dependency "${dependency}" required by "${entry.name}" resolved to a path that is not a directory (${resolved})`,
          }
        }
        return {
          ok: false,
          reason: `dependency "${dependency}" required by "${entry.name}" resolved to an unreadable path (${resolved})`,
        }
      }
      const canonicalDir = depDirProbe.canonical

      // Read the manifest through its canonical path so a symlinked manifest
      // cannot serve package metadata from outside the runtime.
      const depManifest = canonicalTargetInside(path.join(canonicalDir, 'package.json'), root, 'file')
      let depPkg: { name?: unknown; version?: unknown }
      try {
        if (!depManifest.ok) throw new Error(depManifest.reason)
        depPkg = JSON.parse(readFileSync(depManifest.canonical, 'utf8'))
      } catch {
        if (optional.has(dependency)) continue
        return {
          ok: false,
          reason: `dependency "${dependency}" required by "${entry.name}" has no readable package.json`,
        }
      }
      if (depPkg.name !== dependency) {
        return {
          ok: false,
          reason: `dependency "${dependency}" required by "${entry.name}" resolved to a package named ${JSON.stringify(depPkg.name)}`,
        }
      }

      const installedVersion = typeof depPkg.version === 'string' ? depPkg.version : ''
      const supportedRange = semver.validRange(declaredRange)
      if (supportedRange === null) {
        return {
          ok: false,
          reason: `dependency "${dependency}" required by "${entry.name}" declares the unsupported range "${declaredRange}"`,
        }
      }
      if (!semver.satisfies(installedVersion, supportedRange)) {
        return {
          ok: false,
          reason: `dependency "${dependency}" required by "${entry.name}" has installed version ${JSON.stringify(installedVersion)} which does not satisfy "${declaredRange}"`,
        }
      }

      queue.push({ name: dependency, dir: canonicalDir })
    }
  }
  return { ok: true }
}

/** Node-style node_modules lookup for `name` starting at `fromDir`, never escaping `root`. */
function resolveWithinRuntime (fromDir: string, name: string, root: string): string | null {
  let dir = fromDir
  // A dependency of the package at fromDir resolves at
  // fromDir/node_modules/name first, then walks up — but no further than the
  // runtime root, so nothing outside it can ever satisfy the closure.
  for (;;) {
    const candidate = path.join(dir, 'node_modules', name)
    if (existsSync(path.join(candidate, 'package.json'))) return candidate
    if (dir === root || path.dirname(dir) === dir) return null
    dir = path.dirname(dir)
  }
}

/**
 * Path-aware containment: `target` must equal `boundary` or live underneath
 * it. A lexical prefix such as `<boundary>-evil` is NOT a descendant. On
 * Windows the comparison is case-insensitive.
 */
export function isInsideBoundary (target: string, boundary: string): boolean {
  const t = path.resolve(target)
  const b = path.resolve(boundary)
  if (process.platform === 'win32') {
    return t.toLowerCase() === b.toLowerCase() || t.toLowerCase().startsWith(b.toLowerCase() + path.sep)
  }
  return t === b || t.startsWith(b + path.sep)
}
