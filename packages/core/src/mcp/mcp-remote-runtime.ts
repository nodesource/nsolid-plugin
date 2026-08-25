import { randomUUID } from 'node:crypto'
import {
  closeSync,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
  writeSync,
} from 'node:fs'
import path from 'node:path'
import { getAgentsDir } from '../utils/path.js'
import { isInsideBoundary, validateRuntimeRoot } from './mcp-runtime-validation.js'
import { defaultNpmRunner, formatTail, sleep } from './mcp-runtime-runner.js'
import type { NpmRunner } from './mcp-runtime-runner.js'

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
 * - Publication is serialized per version by an `O_CREAT | O_EXCL` lock whose
 *   owner is recorded with a unique token; a stale lock is broken only for a
 *   holder proven dead, and breaking it never grants ownership — every
 *   publisher must win a fresh exclusive create.
 * - Only paths created by the current operation are removed, and only after
 *   asserting they live inside the runtime parent directory.
 * - npm is resolved exclusively from canonical candidates anchored to the
 *   running Node.js installation; `PATH`, the current project and
 *   `npm_execpath` are never consulted.
 * - No credentials are read, stored, or logged here.
 */

/** Exact mcp-remote version this plugin pins. Keep in sync with the wrapper generator. */
export const MCP_REMOTE_VERSION = '0.1.38'

/** Setup-time budget for the npm install. NOT the Codex MCP startup timeout. */
export const DEFAULT_RUNTIME_INSTALL_TIMEOUT_MS = 5 * 60 * 1000

/** A lock older than this may be broken — but only for a holder proven dead. */
const STALE_LOCK_THRESHOLD_MS = 10 * 60 * 1000

/** Bounded total wait while the publication lock is held by a live/unknown holder. */
const DEFAULT_LOCK_WAIT_MS = 15 * 1000

/**
 * Reclamation grace for orphaned staging/stale trees, measured from the
 * ownership-sidecar creation time. Must exceed the npm install budget
 * (DEFAULT_RUNTIME_INSTALL_TIMEOUT_MS) plus the termination confirmation
 * budget (TERMINATION_CONFIRM_MS) so a live-but-slow operation is never
 * reclaimed. Tests inject a short grace via `publish.reclaimGraceMs`.
 */
const RECLAMATION_GRACE_MS = 10 * 60 * 1000

/** Suffix identifying the ownership sidecar adjacent to a temporary tree. */
const SIDECAR_SUFFIX = '.owner.json'

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

export type { NpmRunner, NpmRunnerRunResult } from './mcp-runtime-runner.js'

/**
 * Internal testing seam only — not part of the public CLI surface. Inject a
 * fake runner to exercise install logic without network, or override the
 * resolved npm entry point to point the default (real) runner at a benign
 * executable. `publish` tunes the publication protocol deterministically
 * (lock thresholds, holder pid, fault injection between the replacement
 * renames).
 */
export interface InternalRuntimeOptions {
  runner?: NpmRunner
  npmCommand?: { command: string; args: string[] }
  /** Setup-time npm timeout (default 5 min). NOT the Codex MCP startup timeout. */
  timeoutMs?: number
  /** Test-only publication controls (deterministic locking/fault injection). */
  publish?: PublishTestControls
}

/** Test-only knobs for the publication protocol. Internal seam. */
export interface PublishTestControls {
  /** Lock age (ms) after which a holder-proven-dead lock may be broken. */
  staleLockMs?: number
  /** Bounded total wait (ms) while the lock is held by a live/unknown holder. */
  lockWaitMs?: number
  /**
   * Reclamation grace (ms) for orphaned staging/stale trees — the age their
   * ownership sidecar must exceed before safe reclamation may even be
   * considered. Production default: RECLAMATION_GRACE_MS.
   */
  reclaimGraceMs?: number
  /** PID recorded in this operation's lock (tests simulate dead holders). */
  holderPid?: number
  /** Publication-only rename implementation (tests inject `EXDEV`). */
  rename?: typeof renameSync
  /**
   * Deterministic fault injection: called between `root → stale` and
   * `staging → root`. Any throw simulates the replacing process dying at that
   * point (cleanup is skipped so the on-disk state matches a real crash).
   */
  afterRootAside?: () => void
}

export class McpRemoteRuntimeError extends Error {
  override readonly name = 'McpRemoteRuntimeError'
  readonly code = 'MCP_REMOTE_RUNTIME_SETUP_FAILED'
}

/** Marks a deterministic simulated interruption (test fault injection). */
class SimulatedInterruptionError extends Error {
  override readonly name = 'SimulatedInterruptionError'
}

export function getMcpRemoteRuntimeParent (): string {
  return path.join(getAgentsDir(), 'nsolid-plugin', 'runtime', 'mcp-remote')
}

export function getMcpRemoteRuntimeRoot (): string {
  return path.join(getMcpRemoteRuntimeParent(), MCP_REMOTE_VERSION)
}

/** Read-only inspection: no mutation, no network, no process spawning. */
export function inspectMcpRemoteRuntime (): McpRemoteRuntimeStatus {
  const root = getMcpRemoteRuntimeRoot()
  if (!existsSync(root)) {
    return { status: 'missing', version: MCP_REMOTE_VERSION, root }
  }
  const probe = validateRuntimeRoot(root, MCP_REMOTE_VERSION)
  if (probe.ok) {
    return { status: 'ready', version: MCP_REMOTE_VERSION, root, proxyPath: probe.proxyPath }
  }
  return { status: 'invalid', version: MCP_REMOTE_VERSION, root, reason: probe.reason }
}

/** npm entry-point candidates, in trust order. */
interface NpmCandidate {
  candidatePath: string
  /** 'cli' → spawn `[node, cli.js]`; 'shim' → spawn the executable directly. */
  kind: 'cli' | 'shim'
}

/**
 * Resolve the npm entry point anchored to the running Node.js installation.
 * `PATH`, the current working directory/project, package manifests and
 * `process.env.npm_execpath` are never consulted: a basename or
 * `node_modules/npm` substring cannot prove an arbitrary path is npm's own
 * CLI, and `npm_execpath` is attacker-influenceable environment input.
 */
export function resolveNpmCommand (): { command: string; args: string[] } {
  return resolveNpmCommandForExecPath(process.execPath)
}

/**
 * Internal helper accepting the Node executable path (and platform) so tests
 * can construct supported layouts without modifying the real installation.
 * Not exported from the package barrel.
 */
export function resolveNpmCommandForExecPath (
  execPath: string,
  platform: NodeJS.Platform = process.platform
): { command: string; args: string[] } {
  let canonicalExec: string
  try {
    canonicalExec = realpathSync(execPath)
  } catch {
    throw new McpRemoteRuntimeError(
      `Could not resolve the running Node.js executable (${execPath}). Reinstall Node.js with npm, then rerun setup.`
    )
  }
  const nodeDir = path.dirname(canonicalExec)
  // Unix installs put node in <prefix>/bin, so the installation prefix is the
  // parent of the canonical bin directory; Windows installs keep node.exe and
  // npm side by side, so the executable directory is the prefix.
  const prefix = platform === 'win32' ? nodeDir : path.dirname(nodeDir)
  const candidates: NpmCandidate[] = [
    // Windows Node.js installer layout (.cmd shims cannot be spawned without a shell).
    { candidatePath: path.join(nodeDir, 'node_modules', 'npm', 'bin', 'npm-cli.js'), kind: 'cli' },
    // Unix prefix layouts: nvm, Volta images, Homebrew, macOS installer.
    { candidatePath: path.join(nodeDir, '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'), kind: 'cli' },
  ]
  if (platform !== 'win32') {
    // Unix distro sibling shim (e.g. Debian/Ubuntu), spawned directly.
    candidates.push({ candidatePath: path.join(nodeDir, 'npm'), kind: 'shim' })
  }

  for (const candidate of candidates) {
    const trusted = inspectTrustedNpmCandidate(candidate, prefix)
    if (trusted === null) continue
    if (candidate.kind === 'cli') {
      return { command: execPath, args: [trusted.canonicalPath] }
    }
    return { command: trusted.canonicalPath, args: [] }
  }

  throw new McpRemoteRuntimeError(
    `Could not locate a trusted npm in the Node.js installation (${prefix}). Install Node.js with npm (https://nodejs.org), then rerun setup.`
  )
}

/**
 * Trust check for one anchored npm candidate: it must exist (lstat), its
 * canonical target (realpath) must be a regular file inside the canonical
 * installation prefix, and an executable Unix shim must carry an execute bit.
 * A symlink is trusted only when its target remains inside the boundary.
 */
function inspectTrustedNpmCandidate (
  candidate: NpmCandidate,
  prefix: string
): { canonicalPath: string } | null {
  try {
    lstatSync(candidate.candidatePath)
  } catch {
    return null // missing → try the next candidate
  }
  let canonicalPath: string
  try {
    canonicalPath = realpathSync(candidate.candidatePath)
  } catch {
    return null
  }
  let target: ReturnType<typeof statSync>
  try {
    target = statSync(canonicalPath)
  } catch {
    return null
  }
  if (!target.isFile()) return null // directory, fifo, … — never executable as npm
  if (candidate.kind === 'shim' && (target.mode & 0o111) === 0) return null
  if (!isInsideBoundary(canonicalPath, prefix)) return null // symlink/path escape
  return { canonicalPath }
}

interface PublishControls {
  /** Unique operation token recorded in the publication lock and sidecars. */
  token: string
  staleLockMs: number
  lockWaitMs: number
  /** Reclamation grace (ms) for orphaned temporary trees. */
  reclaimGraceMs: number
  holderPid: number
  rename: typeof renameSync
  afterRootAside?: () => void
}

/** Ownership metadata adjacent to every temporary tree this operation creates. */
interface OwnershipSidecarRecord {
  token: string
  pid: number
  createdAt: number
  state: 'active' | 'retained-live'
  managedPid?: number
}

interface OwnedPublicationLock {
  path: string
  token: string
}

interface LockRecord {
  token?: unknown
  pid?: unknown
  createdAt?: unknown
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
  // Ownership sidecar adjacent to the staging tree: ties the tree to this
  // operation (token), its creator (pid) and the managed npm process, so a
  // later setup may reclaim it only through the safe-reclamation protocol.
  const sidecar = sidecarPathFor(staging)
  const created: string[] = [staging, sidecar]
  const timeoutMs = options?.timeoutMs ?? DEFAULT_RUNTIME_INSTALL_TIMEOUT_MS
  const publish: PublishControls = {
    token: randomUUID(),
    staleLockMs: options?.publish?.staleLockMs ?? STALE_LOCK_THRESHOLD_MS,
    lockWaitMs: options?.publish?.lockWaitMs ?? DEFAULT_LOCK_WAIT_MS,
    reclaimGraceMs: options?.publish?.reclaimGraceMs ?? RECLAMATION_GRACE_MS,
    holderPid: options?.publish?.holderPid ?? process.pid,
    rename: options?.publish?.rename ?? renameSync,
    afterRootAside: options?.publish?.afterRootAside,
  }
  let skipCleanup = false
  const sidecarRecord: OwnershipSidecarRecord = {
    token: publish.token,
    pid: publish.holderPid,
    createdAt: Date.now(),
    state: 'active',
  }

  try {
    mkdirSync(staging)
    writeFileSync(
      path.join(staging, 'package.json'),
      `${JSON.stringify({ name: 'nsolid-plugin-mcp-remote-runtime', private: true }, null, 2)}\n`
    )
    // Written before spawning npm (see tryWriteOwnershipSidecar for the
    // unclassified-retention policy on write failure).
    tryWriteOwnershipSidecar(sidecar, sidecarRecord)

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
    const result = await runner.run(npm.command, args, {
      cwd: staging,
      timeoutMs,
      // Record the managed process identity immediately after spawn so
      // reclamation can prove the managed tree is gone, not just the creator.
      onSpawned: (identity) => {
        sidecarRecord.managedPid = identity.pid
        tryWriteOwnershipSidecar(sidecar, sidecarRecord)
      },
    })
    if (result.spawnError) {
      // The installer process never started: no download mutated staging, so
      // cleanup is safe and nothing was published.
      throw new McpRemoteRuntimeError(
        `Could not start the npm installer (${result.spawnError}). Install Node.js with npm, then rerun setup.`
      )
    }
    if (result.terminationError) {
      // A surviving process may still mutate staging: mark it retained-live
      // and exclude it from publication and cleanup — never validate it,
      // never publish it, never delete it. A later setup reclaims it only
      // after the safe-reclamation protocol proves that is harmless.
      skipCleanup = true
      sidecarRecord.state = 'retained-live'
      tryWriteOwnershipSidecar(sidecar, sidecarRecord)
      throw new McpRemoteRuntimeError(
        `npm install of mcp-remote@${MCP_REMOTE_VERSION} timed out and its process tree could not be confirmed stopped ` +
          `(${result.terminationError}). The partial download was left untouched at ${staging}; it is marked ` +
          'retained-live and will not be used. Rerun setup once the system is idle.'
      )
    }
    if (result.status !== 0) {
      throw new McpRemoteRuntimeError(
        result.timedOut === true
          ? `npm install of mcp-remote@${MCP_REMOTE_VERSION} timed out after ${Math.max(1, Math.round(timeoutMs / 1000))}s. Check network/npm registry access and rerun setup.`
          : `npm install of mcp-remote@${MCP_REMOTE_VERSION} failed (exit ${result.status ?? 'n/a'}).${formatTail(result.stderr)} Rerun setup once npm/network is available.`
      )
    }

    await publishStaging(staging, root, parent, created, publish)
  } catch (err) {
    if (err instanceof SimulatedInterruptionError) {
      // The fault-injection hook simulates the replacing process dying: skip
      // cleanup so the on-disk state matches a real interruption.
      skipCleanup = true
    }
    throw err
  } finally {
    // Clean up only what this operation created; a previously valid runtime
    // is never touched here.
    if (!skipCleanup) {
      for (const target of created) {
        if (existsSync(target)) safeRemove(target, parent)
      }
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
 * Publish a validated staging tree into the versioned root under the
 * per-version publication lock. `root` only ever appears through one atomic
 * rename of a fully validated tree; replacement of an invalid root is a
 * rename-aside + rename-in pair (NOT a gap-free swap: `root` is briefly
 * absent between them — every interruption state of that pair recovers
 * deterministically through the root-absent branch).
 */
async function publishStaging (
  staging: string,
  root: string,
  parent: string,
  created: string[],
  publish: PublishControls
): Promise<void> {
  const lock = await acquirePublicationLock(parent, root, publish)
  let interrupted = false
  try {
    // Bounded retries: a concurrent publisher may make `root` reappear under
    // us; loop back to the re-inspect step while still holding the lock.
    for (let attempt = 0; attempt < 4; attempt++) {
      // Re-inspect `root` under the lock: accept a valid concurrent winner
      // and let the caller's finally remove only this operation's staging.
      if (existsSync(root)) {
        const winner = validateRuntimeRoot(root, MCP_REMOTE_VERSION)
        if (winner.ok) return
      }

      // Validate this operation's staging fully before touching `root`.
      const stagingProbe = validateRuntimeRoot(staging, MCP_REMOTE_VERSION)
      if (!stagingProbe.ok) {
        throw new McpRemoteRuntimeError(
          `Staged mcp-remote runtime failed validation: ${stagingProbe.reason}. Rerun setup; if this persists, report the staging output above.`
        )
      }

      if (!existsSync(root)) {
        // Fresh publish (also the deterministic recovery path after an
        // interrupted replacement): one atomic rename.
        try {
          publish.rename(staging, root)
          return
        } catch (err) {
          if (isRenameBlockedError(err)) continue // destination appeared — re-inspect
          throw publishError(root, err)
        }
      }

      // Invalid pre-existing root: rename aside, rename in, then delete this
      // operation's stale tree. The stale tree's ownership sidecar exists
      // BEFORE the tree does, so an interrupted replacement never leaves an
      // unowned stale tree behind.
      const stale = `${root}.stale-${randomUUID()}`
      const staleSidecar = sidecarPathFor(stale)
      created.push(stale, staleSidecar)
      writeOwnershipSidecar(staleSidecar, {
        token: publish.token,
        pid: publish.holderPid,
        createdAt: Date.now(),
        state: 'active',
      })
      try {
        publish.rename(root, stale)
      } catch (err) {
        if (!existsSync(root)) continue // vanished — re-inspect
        throw publishError(root, err)
      }
      if (publish.afterRootAside !== undefined) {
        try {
          publish.afterRootAside()
        } catch (err) {
          throw new SimulatedInterruptionError(`between root-aside and staging-rename: ${(err as Error)?.message ?? String(err)}`)
        }
      }
      try {
        publish.rename(staging, root)
      } catch (err) {
        if (isRenameBlockedError(err)) continue // re-inspect under the lock
        throw publishError(root, err)
      }
      // The stale tree is only ever the one this operation just moved aside.
      safeRemove(stale, parent)
      return
    }
    throw new McpRemoteRuntimeError(
      `Could not publish the mcp-remote runtime to ${root}: repeated concurrent modifications. Rerun setup.`
    )
  } catch (err) {
    if (err instanceof SimulatedInterruptionError) interrupted = true
    throw err
  } finally {
    // While still holding the lock, conservatively reclaim orphaned temporary
    // trees whose ownership/liveness proof is safe (a stale-aside tree only
    // after a valid versioned root exists — which this operation may have
    // just published). Any doubt retains the tree.
    if (!interrupted) {
      try {
        reclaimOrphans(parent, root, publish)
      } catch {
        // Reclamation must never fail the publish.
      }
      // A simulated interruption models the holder dying with the lock in
      // place — the record (with its holder pid) must survive for the recovery
      // path to exercise the stale-lock protocol.
      releasePublicationLock(lock)
    }
  }
}

function publishError (root: string, err: unknown): McpRemoteRuntimeError {
  return new McpRemoteRuntimeError(
    `Could not publish the mcp-remote runtime to ${root}: ${(err as Error).message}. Rerun setup.`
  )
}

/** Platform refusal of a directory-over-directory rename (destination appeared). */
function isRenameBlockedError (err: unknown): boolean {
  const code = (err as NodeJS.ErrnoException).code
  return code === 'EEXIST' || code === 'EPERM' || code === 'ENOTEMPTY' || code === 'ENOTDIR' || code === 'EISDIR'
}

/**
 * Acquire the per-version publication lock. Ownership is granted ONLY by a
 * successful `O_CREAT | O_EXCL` create; the recorded holder (token, pid,
 * creation time) lets waiters distinguish a live publisher from a dead one.
 */
async function acquirePublicationLock (
  parent: string,
  root: string,
  publish: PublishControls
): Promise<OwnedPublicationLock> {
  const lockPath = path.join(parent, `.publish-${path.basename(root)}.lock`)
  const deadline = Date.now() + publish.lockWaitMs
  let backoffMs = 25

  for (;;) {
    let fd: number | undefined
    try {
      fd = openSync(lockPath, 'wx') // O_CREAT | O_EXCL — the only ownership grant
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err
      // Someone owns it. Decide whether the lock is breakable before waiting.
      if (await maybeBreakStaleLock(lockPath, parent, publish)) {
        // Broken — but moving the stale lock granted nothing: race back to a
        // fresh exclusive create.
        continue
      }
      if (Date.now() >= deadline) {
        throw new McpRemoteRuntimeError(
          `Another setup is publishing the MCP bridge runtime (${lockPath} is still held). Wait for it to finish, then rerun setup.`
        )
      }
      await sleep(backoffMs)
      backoffMs = Math.min(backoffMs * 2, 500)
      continue
    }
    try {
      // The lock records the operation token, so orphaned trees whose sidecar
      // carries the same token are visibly owned while this lock exists.
      writeSync(fd, JSON.stringify({ token: publish.token, pid: publish.holderPid, createdAt: Date.now() }))
    } finally {
      closeSync(fd)
    }
    return { path: lockPath, token: publish.token }
  }
}

/**
 * Break a stale lock — only when it is older than the threshold AND its
 * recorded holder is proven dead. Contenders race an atomic rename to a
 * unique tombstone; the successful breaker deletes only that tombstone.
 * Returns true when the lock was broken (the caller must still win a fresh
 * `O_EXCL` create). Live holders, young locks, malformed records and
 * unprovable liveness never authorize takeover (fail closed).
 */
async function maybeBreakStaleLock (
  lockPath: string,
  parent: string,
  publish: PublishControls
): Promise<boolean> {
  let record: LockRecord
  try {
    record = JSON.parse(readFileSync(lockPath, 'utf8')) as LockRecord
  } catch {
    return false // unreadable/malformed: cannot prove anything — treat as owned
  }
  const createdAt = typeof record.createdAt === 'number' ? record.createdAt : Number.NaN
  const pid = typeof record.pid === 'number' ? record.pid : Number.NaN
  if (!Number.isFinite(createdAt) || Date.now() - createdAt <= publish.staleLockMs) {
    return false // young lock — never breakable regardless of liveness
  }
  if (!isProvenGone(pid)) return false // live or unknown holder — owned

  const tombstone = `${lockPath}.steal-${randomUUID()}`
  try {
    renameSync(lockPath, tombstone)
  } catch {
    return false // another breaker won the race
  }
  safeRemove(tombstone, parent) // delete only this breaker's tombstone
  return true
}

/**
 * Signal-target liveness, fail closed: only the platform's definite
 * not-found result (ESRCH) proves death. Permission errors, malformed records
 * and unsupported checks do not authorize takeover or reclamation.
 */
function isProvenGone (target: number): boolean {
  if (!Number.isInteger(target) || target <= 0) return false
  try {
    process.kill(target, 0)
    return false // definitely exists
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'ESRCH'
  }
}

/** Release the lock only when its recorded owner token still matches ours. */
function releasePublicationLock (lock: OwnedPublicationLock): void {
  try {
    const record = JSON.parse(readFileSync(lock.path, 'utf8')) as LockRecord
    if (record.token === lock.token) {
      unlinkSync(lock.path)
    }
  } catch {
    // Already gone (or unreadable): nothing to release. Never unlink a lock
    // this operation does not own.
  }
}

/** Adjacent ownership sidecar path for a temporary tree. */
function sidecarPathFor (tree: string): string {
  return `${tree}${SIDECAR_SUFFIX}`
}

/**
 * Atomic sidecar write (temp + rename): a reader never observes a partial
 * record, and a crash mid-write leaves the previous state intact.
 */
function writeOwnershipSidecar (sidecar: string, record: OwnershipSidecarRecord): void {
  const temp = `${sidecar}.tmp-${randomUUID()}`
  try {
    writeFileSync(temp, `${JSON.stringify(record, null, 2)}\n`)
    renameSync(temp, sidecar)
  } catch (err) {
    try {
      unlinkSync(temp)
    } catch {
      // Nothing to clean up.
    }
    throw err
  }
}

/**
 * Best-effort sidecar write: a failure never fails the install — the tree is
 * simply retained as unclassified, and unclassified trees are never
 * automatically deleted (fail-closed reclamation).
 */
function tryWriteOwnershipSidecar (sidecar: string, record: OwnershipSidecarRecord): void {
  try {
    writeOwnershipSidecar(sidecar, record)
  } catch {
    // Retained as unclassified.
  }
}

/** Sidecar record as read back from disk (unknown shapes fail closed). */
interface ScannedSidecar extends LockRecord {
  state?: unknown
  managedPid?: unknown
}

/**
 * Safe orphan reclamation, run only while holding the per-version publication
 * lock. A staging/stale tree and its sidecar are removed only when EVERY
 * guard holds: the grace period elapsed, the metadata parses, the tree path
 * is inside the runtime parent, the creator pid is proven dead, no live
 * publication lock carries the sidecar's operation token and — when a managed
 * process identity was recorded — that process group/tree is proven absent.
 * Unknown liveness, permission errors, malformed metadata or a token mismatch
 * retain the tree. Stale-aside trees additionally require a valid versioned
 * root to exist. Reclamation never restores or promotes an orphan.
 */
function reclaimOrphans (parent: string, root: string, publish: PublishControls): void {
  let canonicalParent: string
  try {
    canonicalParent = realpathSync(parent)
  } catch {
    return
  }
  let entries: string[]
  try {
    entries = readdirSync(parent)
  } catch {
    return
  }
  for (const entry of entries) {
    if (!entry.endsWith(SIDECAR_SUFFIX)) continue
    const treeName = entry.slice(0, -SIDECAR_SUFFIX.length)
    const isStaleTree = treeName.includes('.stale-')
    if (!isStaleTree && !treeName.startsWith('.staging-')) continue
    try {
      const treePath = path.join(parent, treeName)
      if (!isInsideBoundary(realpathSync(treePath), canonicalParent)) continue
      // A stale-aside tree is reclaimed only after a valid versioned root
      // exists: recovery never depends on removing it.
      if (isStaleTree && (!existsSync(root) || !validateRuntimeRoot(root, MCP_REMOTE_VERSION).ok)) continue

      let raw: ScannedSidecar
      try {
        raw = JSON.parse(readFileSync(path.join(parent, entry), 'utf8')) as ScannedSidecar
      } catch {
        continue // malformed metadata — retain
      }
      if (typeof raw.token !== 'string' || raw.token.length === 0) continue
      if (!Number.isInteger(raw.pid) || (raw.pid as number) <= 0) continue
      if (typeof raw.createdAt !== 'number' || !Number.isFinite(raw.createdAt)) continue
      if (Date.now() - raw.createdAt <= publish.reclaimGraceMs) continue
      if (!isProvenGone(raw.pid as number)) continue
      if (lockCarriesToken(parent, raw.token)) continue
      if (typeof raw.managedPid === 'number' && !isManagedTreeProvenAbsent(raw.managedPid)) continue

      safeRemove(treePath, parent)
      safeRemove(path.join(parent, entry), parent)
    } catch {
      // Reclamation is conservative: any failure retains the tree.
      continue
    }
  }
}

/**
 * Whether any publication lock under `parent` carries `token`. An unreadable
 * lock may be the one carrying it, so it blocks reclamation (fail closed).
 */
function lockCarriesToken (parent: string, token: string): boolean {
  let entries: string[]
  try {
    entries = readdirSync(parent)
  } catch {
    return true
  }
  for (const entry of entries) {
    if (!entry.startsWith('.publish-') || !entry.endsWith('.lock')) continue
    try {
      const record = JSON.parse(readFileSync(path.join(parent, entry), 'utf8')) as LockRecord
      if (record.token === token) return true
    } catch {
      return true // unreadable lock: cannot prove it is unrelated — retain
    }
  }
  return false
}

/**
 * Managed-tree absence, fail closed: on Unix the managed npm process was a
 * detached group leader, so the whole group (-pid) must be gone; on Windows
 * the root pid must be gone.
 */
function isManagedTreeProvenAbsent (managedPid: number): boolean {
  return isProvenGone(process.platform === 'win32' ? managedPid : -managedPid)
}

/**
 * Recursive delete guarded to only accept paths inside the runtime parent.
 * Never call this with an unvalidated or user-supplied path.
 */
function safeRemove (target: string, parent: string): void {
  const canonicalTarget = realpathSync(target)
  const canonicalParent = realpathSync(parent)
  if (!isInsideBoundary(canonicalTarget, canonicalParent)) {
    throw new McpRemoteRuntimeError(`Refusing to remove a path outside the runtime directory: ${target}`)
  }
  rmSync(target, { recursive: true, force: true })
}
