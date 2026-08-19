import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import path from 'node:path'
import { getAgentsDir } from '../utils/path.js'

/**
 * Shared MCP bridge runtime manager.
 *
 * `setup` provisions an exact-pinned `mcp-remote` copy (with its transitive
 * dependencies) under `~/.agents/nsolid-plugin/runtime/mcp-remote/<version>/`
 * so the generated MCP wrapper never needs npm/npx during harness startup.
 *
 * Invariants:
 * - The destination only ever appears via an atomic rename of a fully
 *   validated staging tree (no partial runtimes are published).
 * - A valid runtime is never deleted before a replacement staging tree has
 *   validated (a failed install cannot leave a worse state).
 * - Only paths created by the current operation are removed, and only after
 *   asserting they live inside the runtime parent directory.
 * - No credentials are read, stored, or logged here.
 */

/** Exact mcp-remote version this plugin pins. Keep in sync with the wrapper generator. */
export const MCP_REMOTE_VERSION = '0.1.38'

/** Setup-time budget for the npm install. NOT the Codex MCP startup timeout. */
export const DEFAULT_RUNTIME_INSTALL_TIMEOUT_MS = 5 * 60 * 1000

/** Bounded tail of npm stderr kept for actionable error messages. */
const STDERR_TAIL_LIMIT = 4096

export interface McpRemoteRuntimeStatus {
  status: 'ready' | 'missing' | 'invalid'
  version: string
  root: string
  proxyPath?: string
  reason?: string
}

export interface EnsureMcpRemoteRuntimeResult {
  /** false when an already-valid runtime was reused and npm was not invoked */
  installed: boolean
  version: string
  root: string
  proxyPath: string
}

export interface NpmRunner {
  run(
    command: string,
    args: string[],
    options: { cwd: string; timeoutMs: number }
  ): Promise<{ status: number | null; stderr: string; timedOut?: boolean }>
}

/**
 * Internal testing seam only — not part of the public CLI surface. Inject a
 * fake runner to exercise install logic without network, or override the
 * resolved npm entry point to point the default (real) runner at a benign
 * executable.
 */
export interface InternalRuntimeOptions {
  runner?: NpmRunner
  npmCommand?: { command: string; args: string[] }
  timeoutMs?: number
}

export class McpRemoteRuntimeError extends Error {
  override readonly name = 'McpRemoteRuntimeError'
  readonly code = 'MCP_REMOTE_RUNTIME_SETUP_FAILED'
}

export function getMcpRemoteRuntimeParent (): string {
  return path.join(getAgentsDir(), 'nsolid-plugin', 'runtime', 'mcp-remote')
}

export function getMcpRemoteRuntimeRoot (): string {
  return path.join(getMcpRemoteRuntimeParent(), MCP_REMOTE_VERSION)
}

interface RuntimeProbe {
  ok: boolean
  proxyPath?: string
  reason?: string
}

/** Read-only inspection: no mutation, no network, no process spawning. */
export function inspectMcpRemoteRuntime (): McpRemoteRuntimeStatus {
  const root = getMcpRemoteRuntimeRoot()
  if (!existsSync(root)) {
    return { status: 'missing', version: MCP_REMOTE_VERSION, root }
  }
  const probe = validateRuntimeRoot(root)
  if (probe.ok) {
    return { status: 'ready', version: MCP_REMOTE_VERSION, root, proxyPath: probe.proxyPath }
  }
  return { status: 'invalid', version: MCP_REMOTE_VERSION, root, reason: probe.reason }
}

/**
 * True when `execPath` is an npm CLI entry point. `npm_execpath` can point at
 * pnpm (`pnpm.cjs`) or yarn (`yarn-*.cjs`) when setup runs inside their
 * lifecycle scripts; those managers reject the npm flags used here and their
 * node_modules layouts fail runtime validation anyway, so they must fall
 * through to the node-dir npm resolution.
 */
function isNpmEntryPoint (execPath: string): boolean {
  const base = path.basename(execPath).toLowerCase()
  if (/^npm(-cli)?\.(c?js|mjs)$/.test(base)) return true
  const segments = execPath.split(path.sep)
  return segments.includes('node_modules') && segments.includes('npm')
}

/**
 * Resolve the npm entry point without consulting PATH or the current working
 * directory (a project's node_modules/.bin must not be able to substitute
 * npm). Order:
 *  1. `npm_execpath` when absolute, existing, a JS file, and actually npm's
 *     CLI entry point (pnpm/yarn lifecycle scripts set it to their own
 *     binary; those are ignored here). Works cross-platform without a shell —
 *     .cmd shims cannot be spawned safely.
 *  2. `<node dir>/node_modules/npm/bin/npm-cli.js` (standard Windows layout).
 *  3. `<node dir>/npm` (Unix shim, e.g. Volta).
 */
export function resolveNpmCommand (): { command: string; args: string[] } {
  const execPath = process.env.npm_execpath
  if (
    typeof execPath === 'string' &&
    path.isAbsolute(execPath) &&
    /\.(c?js|mjs)$/i.test(execPath) &&
    existsSync(execPath) &&
    isNpmEntryPoint(execPath)
  ) {
    return { command: process.execPath, args: [execPath] }
  }

  const nodeDir = path.dirname(process.execPath)
  const npmCli = path.join(nodeDir, 'node_modules', 'npm', 'bin', 'npm-cli.js')
  if (existsSync(npmCli)) {
    return { command: process.execPath, args: [npmCli] }
  }

  const npmShim = path.join(nodeDir, 'npm')
  if (existsSync(npmShim)) {
    return { command: npmShim, args: [] }
  }

  throw new McpRemoteRuntimeError(
    `Could not locate npm next to Node.js (${nodeDir}). Install Node.js with npm, then rerun setup.`
  )
}

export async function ensureMcpRemoteRuntime (
  options?: InternalRuntimeOptions
): Promise<EnsureMcpRemoteRuntimeResult> {
  const existing = inspectMcpRemoteRuntime()
  if (existing.status === 'ready') {
    return {
      installed: false,
      version: MCP_REMOTE_VERSION,
      root: existing.root,
      proxyPath: existing.proxyPath as string,
    }
  }

  const parent = getMcpRemoteRuntimeParent()
  const root = getMcpRemoteRuntimeRoot()
  mkdirSync(parent, { recursive: true })

  // Staging lives next to the destination so publish is a same-filesystem
  // atomic rename. The private package.json anchors npm to this directory so
  // it cannot walk up into unrelated manifests or workspaces.
  const staging = path.join(parent, `.staging-${process.pid}-${randomUUID()}`)
  const created: string[] = [staging]
  const timeoutMs = options?.timeoutMs ?? DEFAULT_RUNTIME_INSTALL_TIMEOUT_MS

  try {
    mkdirSync(staging)
    writeFileSync(
      path.join(staging, 'package.json'),
      `${JSON.stringify({ name: 'nsolid-plugin-mcp-remote-runtime', private: true }, null, 2)}\n`
    )

    const npm = options?.npmCommand ?? resolveNpmCommand()
    const runner = options?.runner ?? defaultNpmRunner
    const args = [
      ...npm.args,
      'install',
      '--omit=dev',
      '--ignore-scripts',
      '--no-audit',
      '--no-fund',
      '--save-exact',
      '--no-package-lock',
      `mcp-remote@${MCP_REMOTE_VERSION}`,
    ]
    const result = await runner.run(npm.command, args, { cwd: staging, timeoutMs })
    if (result.status !== 0) {
      throw new McpRemoteRuntimeError(
        result.timedOut === true
          ? `npm install of mcp-remote@${MCP_REMOTE_VERSION} timed out after ${Math.max(1, Math.round(timeoutMs / 1000))}s. Check network/npm registry access and rerun setup.`
          : `npm install of mcp-remote@${MCP_REMOTE_VERSION} failed (exit ${result.status ?? 'n/a'}).${formatTail(result.stderr)} Rerun setup once npm/network is available.`
      )
    }

    const stagingProbe = validateRuntimeRoot(staging)
    if (!stagingProbe.ok) {
      throw new McpRemoteRuntimeError(
        `Staged mcp-remote runtime failed validation: ${stagingProbe.reason}. Rerun setup; if this persists, report the staging output above.`
      )
    }

    publishStaging(staging, root, created)
  } finally {
    // Clean up only what this operation created; a previously valid runtime
    // is never touched here.
    for (const target of created) {
      if (existsSync(target)) safeRemove(target, parent)
    }
  }

  const final = inspectMcpRemoteRuntime()
  if (final.status !== 'ready') {
    throw new McpRemoteRuntimeError(
      `MCP bridge runtime at ${root} is not ready after install (${final.reason ?? final.status}). Rerun setup.`
    )
  }
  return {
    installed: true,
    version: MCP_REMOTE_VERSION,
    root: final.root,
    proxyPath: final.proxyPath as string,
  }
}

/**
 * Atomically move a validated staging tree into place. On a publish race the
 * loser accepts the winner when it is valid; an invalid pre-existing
 * destination is replaced only after staging has already validated.
 */
function publishStaging (staging: string, root: string, created: string[]): void {
  try {
    renameSync(staging, root)
    return
  } catch {
    // Destination exists (or rename failed) — handle below.
  }

  const winner = validateRuntimeRoot(root)
  if (winner.ok) {
    // A concurrent setup published a valid runtime first: accept it.
    return
  }

  // Invalid pre-existing destination: move it aside, then publish. If the
  // final rename fails, restore the previous state instead of leaving
  // something worse.
  const stale = `${root}.stale-${randomUUID()}`
  created.push(stale)
  let movedAside = false
  try {
    renameSync(root, stale)
    movedAside = true
  } catch {
    // Destination vanished between the failed rename and now — nothing to
    // move aside; fall through and try publishing directly.
  }
  try {
    renameSync(staging, root)
  } catch (err) {
    if (movedAside) {
      try {
        renameSync(stale, root)
      } catch {
        // Best effort restore; the stale copy remains for inspection.
      }
    }
    throw new McpRemoteRuntimeError(
      `Could not publish the mcp-remote runtime to ${root}: ${(err as Error).message}. Rerun setup.`
    )
  }
}

/** Validate a runtime tree (a destination root or a staging directory). */
function validateRuntimeRoot (root: string): RuntimeProbe {
  const mcpRemoteDir = path.join(root, 'node_modules', 'mcp-remote')
  let pkg: { name?: unknown; version?: unknown; dependencies?: unknown; optionalDependencies?: unknown }
  try {
    pkg = JSON.parse(readFileSync(path.join(mcpRemoteDir, 'package.json'), 'utf8'))
  } catch {
    return { ok: false, reason: 'node_modules/mcp-remote/package.json is missing or unreadable' }
  }
  if (pkg.name !== 'mcp-remote') {
    return { ok: false, reason: `expected package name "mcp-remote", found ${JSON.stringify(pkg.name)}` }
  }
  if (pkg.version !== MCP_REMOTE_VERSION) {
    return { ok: false, reason: `expected mcp-remote@${MCP_REMOTE_VERSION}, found ${String(pkg.version)}` }
  }

  const proxyPath = path.join(mcpRemoteDir, 'dist', 'proxy.js')
  try {
    if (!statSync(proxyPath).isFile()) {
      return { ok: false, reason: 'node_modules/mcp-remote/dist/proxy.js is not a regular file' }
    }
  } catch {
    return { ok: false, reason: 'node_modules/mcp-remote/dist/proxy.js is missing' }
  }

  // Static dependency-closure probe: detects missing transitives without
  // executing package code (installs run with --ignore-scripts).
  const missing = findMissingDependency(mcpRemoteDir, root)
  if (missing) {
    return { ok: false, reason: `dependency "${missing.dependency}" required by "${missing.dependent}" is missing` }
  }

  return { ok: true, proxyPath }
}

interface MissingDependency {
  dependency: string
  dependent: string
}

/**
 * Walk the (non-optional) dependency closure of `mcp-remote` using Node-style
 * node_modules resolution confined to `root`. Returns the first missing
 * dependency, or null when the closure is complete.
 */
function findMissingDependency (startDir: string, root: string): MissingDependency | null {
  const queue: Array<{ name: string; dir: string }> = [{ name: 'mcp-remote', dir: startDir }]
  const visited = new Set<string>()

  while (queue.length > 0) {
    const entry = queue.shift() as { name: string; dir: string }
    const key = entry.dir
    if (visited.has(key)) continue
    visited.add(key)

    let pkg: {
      dependencies?: Record<string, string>
      optionalDependencies?: Record<string, string>
    }
    try {
      pkg = JSON.parse(readFileSync(path.join(entry.dir, 'package.json'), 'utf8'))
    } catch {
      return { dependency: 'package.json', dependent: entry.name }
    }

    const optional = new Set(Object.keys(pkg.optionalDependencies ?? {}))
    const dependencies = Object.keys(pkg.dependencies ?? {})
    for (const dependency of dependencies) {
      const resolved = resolveWithinRuntime(entry.dir, dependency, root)
      if (!resolved) {
        if (optional.has(dependency)) continue
        return { dependency, dependent: entry.name }
      }
      queue.push({ name: dependency, dir: resolved })
    }
  }
  return null
}

/** Node-style node_modules lookup for `name` starting at `fromDir`, never escaping `root`. */
function resolveWithinRuntime (fromDir: string, name: string, root: string): string | null {
  let dir = fromDir
  // A dependency of the package at fromDir resolves at
  // fromDir/node_modules/name first, then walks up.
  for (;;) {
    const candidate = path.join(dir, 'node_modules', name)
    if (existsSync(path.join(candidate, 'package.json'))) return candidate
    if (dir === root || path.dirname(dir) === dir) return null
    dir = path.dirname(dir)
  }
}

const defaultNpmRunner: NpmRunner = {
  async run (command, args, { cwd, timeoutMs }) {
    return await new Promise((resolve) => {
      let stderr = ''
      let timedOut = false
      let settled = false
      const child = spawn(command, args, {
        cwd,
        shell: false,
        windowsHide: true,
        stdio: ['ignore', 'ignore', 'pipe'],
      })
      const timer = setTimeout(() => {
        timedOut = true
        child.kill('SIGKILL')
      }, timeoutMs)

      const finish = (result: { status: number | null; stderr: string; timedOut?: boolean }) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        resolve(result)
      }

      child.stderr?.on('data', (chunk: Buffer) => {
        // Keep only a bounded tail; never capture or log the environment.
        stderr = (stderr + chunk.toString('utf8')).slice(-STDERR_TAIL_LIMIT)
      })
      child.on('error', (err) => {
        finish({ status: null, stderr: `${stderr}\n${err.message}`.slice(-STDERR_TAIL_LIMIT) })
      })
      child.on('close', (code) => {
        finish({ status: timedOut ? null : (code ?? null), stderr, timedOut })
      })
    })
  },
}

function formatTail (stderr: string): string {
  const tail = stderr.trim().split('\n').slice(-6).join('\n').trim()
  if (!tail) return ''
  return ` npm said:\n${tail}\n`
}

/**
 * Recursive delete guarded to only accept paths inside the runtime parent.
 * Never call this with an unvalidated or user-supplied path.
 */
function safeRemove (target: string, parent: string): void {
  const resolvedTarget = path.resolve(target)
  const resolvedParent = path.resolve(parent)
  if (resolvedTarget === resolvedParent || !resolvedTarget.startsWith(resolvedParent + path.sep)) {
    throw new McpRemoteRuntimeError(`Refusing to remove a path outside the runtime directory: ${target}`)
  }
  rmSync(resolvedTarget, { recursive: true, force: true })
}
