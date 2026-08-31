import { createHash, randomBytes } from 'node:crypto'
import { readFile, rm } from 'node:fs/promises'
import { closeSync, existsSync, fchmodSync, fsyncSync, mkdirSync, mkdtempSync, openSync, readFileSync, renameSync, statSync, writeSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import type { CommandRunner, CommandSpec, ResolvedArtifactIdentity, UpdateError } from './types.js'
import { isCommandSuccessful } from './command-runner.js'
import { readClaudePluginScope } from './claude-record.js'
import { nativePayloadDigest } from './native-evidence.js'
import { copyOwnedPath, createSiblingBackupPath, ownedPathKind, removeOwnedPath, type OwnedPathKind, type SiblingBackupPath } from './fs-transaction.js'

export interface ClaudeTransactionSpec {
  commands: readonly CommandSpec[]
  /** Byte evidence files bound at planning (plugin registry, marketplace records). */
  registrationPaths: readonly string[]
  configPath?: string
  pluginId: string
  scope: string
  expectedVersion?: string
  artifact?: ResolvedArtifactIdentity
}

export interface ClaudeTransactionResult {
  success: boolean
  rollbackAttempted: boolean
  rollbackSucceeded?: boolean
  error?: UpdateError
  /** Recovery bundle root preserved for deferred or rejected rollbacks. */
  recoveryPath?: string
}

interface RegistrationSnapshot {
  path: string
  existed: boolean
  bytes?: Buffer
  digest?: string
  /** Verified on-disk copy inside the recovery bundle (existed files only). */
  backupPath?: string
  postDigest?: string | null
}

/** Self-describing evidence bundle written before the first command runs. */
interface RecoveryManifest {
  version: 1
  complete: boolean
  createdAt: string
  registration: Array<{
    path: string
    existed: boolean
    digest?: string
    backup?: string
  }>
  payload?: {
    root?: string
    kind?: OwnedPathKind
    digest?: string
    backupPath?: string
    backupDirectory?: string
  }
}

interface PayloadSnapshot {
  root?: string
  backupStorage?: SiblingBackupPath
  kind?: OwnedPathKind
  /** Immutable pre-mutation digest captured before any command runs. */
  originalDigest?: string
  postRoot?: string
  postDigest?: string | null
}

/** Injectable filesystem dependencies for deterministic tests. */
export interface ClaudeTransactionDependencies {
  copyOwnedPath?: typeof copyOwnedPath
  /** Deterministic recovery-root allocation for tests; production defaults to a sibling of the primary registration path. */
  allocateWorkspace?: () => string
  /** Injectable drift-gated restore used to exercise rejected-rollback retention. */
  restoreState?: (payload: PayloadSnapshot, registration: readonly RegistrationSnapshot[]) => Promise<boolean>
}

/**
 * Run the native Claude marketplace refresh inside a byte-level transaction:
 * registration records, marketplace evidence, and the installed payload are
 * backed up before the first command and restored when a command or the
 * post-update validation fails. A concurrent modification of the post-update
 * state blocks the restore; the backup is preserved and CLAUDE_ROLLBACK_FAILED
 * is reported instead of overwriting unknown bytes.
 */
export async function executeClaudeTransaction (
  spec: ClaudeTransactionSpec,
  commandRunner: CommandRunner,
  dependencies: ClaudeTransactionDependencies = {}
): Promise<ClaudeTransactionResult> {
  const copyOwned = dependencies.copyOwnedPath ?? copyOwnedPath
  const registration: RegistrationSnapshot[] = []
  const payload: PayloadSnapshot = {}
  // Authoritative recovery bundle root: created before any evidence is read.
  let recoveryRoot: string | undefined
  let backupsComplete = false
  let mutationStarted = false
  let preserveBackup = false
  const keepBackup = () => { preserveBackup = true }

  // ---- Backup phase: any read or copy failure aborts before the first
  // command. Nothing has been mutated, so there is nothing to restore and a
  // partial backup container is removed (it is not recoverable evidence).
  try {
    recoveryRoot = dependencies.allocateWorkspace?.() ?? defaultRecoveryRoot(spec.registrationPaths)
    mkdirSync(path.join(recoveryRoot, 'registration'), { recursive: true })
    for (const [index, evidencePath] of spec.registrationPaths.entries()) {
      const target = path.resolve(evidencePath)
      if (existsSync(target) && statSync(target).isFile()) {
        const bytes = await readFile(target)
        const digest = sha256(bytes)
        const backupPath = path.join(recoveryRoot, 'registration', `${String(index).padStart(4, '0')}.bin`)
        writeDurableFile(backupPath, bytes)
        const stored = readFileSync(backupPath)
        if (sha256(stored) !== digest) throw new Error('registration backup verification failed')
        registration.push({ path: target, existed: true, bytes, digest, backupPath })
      } else {
        registration.push({ path: target, existed: false })
      }
    }
    const previousRoot = installedClaudePayloadRoot(spec.configPath, spec.pluginId, spec.scope)
    if (previousRoot) {
      payload.root = previousRoot
      payload.kind = await ownedPathKind(previousRoot)
      if (payload.kind !== 'missing') {
        payload.backupStorage = await createSiblingBackupPath(previousRoot, 'payload-backup')
        payload.originalDigest = stateDigest(previousRoot)
        await copyOwned(previousRoot, payload.backupStorage.path)
        // Completeness evidence: only a backup with the same path kind and an
        // identical digest may ever be restored.
        const backupKind = await ownedPathKind(payload.backupStorage.path)
        const backupDigest = stateDigest(payload.backupStorage.path)
        if (backupKind !== payload.kind || !backupDigest || backupDigest !== payload.originalDigest) {
          throw new Error('backup completeness verification failed')
        }
      }
    }
    // The manifest is written last: it only ever describes verified evidence.
    const manifest: RecoveryManifest = {
      version: 1,
      complete: true,
      createdAt: new Date().toISOString(),
      registration: registration.map((entry) => entry.existed
        ? { path: entry.path, existed: true, digest: entry.digest, backup: path.relative(recoveryRoot!, entry.backupPath!) }
        : { path: entry.path, existed: false }),
      payload: payload.backupStorage
        ? {
            root: payload.root,
            kind: payload.kind,
            digest: payload.originalDigest,
            backupPath: payload.backupStorage.path,
            backupDirectory: payload.backupStorage.directory,
          }
        : undefined,
    }
    const manifestPath = path.join(recoveryRoot, 'recovery.json')
    writeDurableFile(manifestPath, Buffer.from(JSON.stringify(manifest, null, 2) + '\n'))
    const verification = JSON.parse(readFileSync(manifestPath, 'utf8')) as RecoveryManifest
    if (verification.complete !== true || verification.registration.length !== registration.length) {
      throw new Error('recovery manifest verification failed')
    }
    backupsComplete = true
  } catch {
    if (payload.backupStorage) await removeOwnedPath(payload.backupStorage.directory).catch(() => {})
    if (recoveryRoot) await rm(recoveryRoot, { recursive: true, force: true }).catch(() => {})
    return {
      success: false,
      rollbackAttempted: false,
      error: { code: 'CLAUDE_BACKUP_FAILED', message: 'Claude registration or payload backup could not be completed' },
    }
  }

  try {
    mutationStarted = true
    for (const command of spec.commands) {
      const result = await commandRunner.run(command)
      if (!isCommandSuccessful(result)) {
        // Never restore while descendants may still be writing the same bytes:
        // defer rollback and keep the backup recoverable, as the Codex and
        // Antigravity transactions do.
        if (result.timedOut && result.treeTerminated !== true) {
          keepBackup()
          return {
            success: false,
            rollbackAttempted: false,
            recoveryPath: recoveryRoot,
            error: {
              code: 'CLAUDE_TREE_TERMINATION_UNCONFIRMED',
              message: `Claude timed out and descendant termination could not be confirmed; the pre-update recovery bundle was preserved at ${recoveryRoot}`,
            },
          }
        }
        const error: UpdateError = result.spawnErrorCode === 'ENOENT'
          ? { code: 'MISSING_EXECUTABLE', message: `${command.executable} executable was not found on PATH` }
          : result.timedOut
            ? { code: 'CLAUDE_COMMAND_TIMEOUT', message: 'Claude marketplace refresh timed out' }
            : { code: 'CLAUDE_COMMAND_FAILED', message: 'Claude marketplace refresh command failed' }
        return await fail(spec, payload, registration, recoveryRoot, { success: false, rollbackAttempted: true }, error, keepBackup, dependencies)
      }
    }

    payload.postRoot = installedClaudePayloadRoot(spec.configPath, spec.pluginId, spec.scope, spec.expectedVersion)
    payload.postDigest = payload.postRoot ? stateDigest(payload.postRoot) : null
    for (const entry of registration) entry.postDigest = existsSync(entry.path) ? stateDigest(entry.path) : null

    if (spec.artifact && (spec.artifact.kind === 'git' || spec.artifact.kind === 'local-snapshot')) {
      if (!payload.postRoot || !payload.postDigest || payload.postDigest !== spec.artifact.contentDigest) {
        return await fail(spec, payload, registration, recoveryRoot, { success: false, rollbackAttempted: true }, {
          code: 'CLAUDE_CONTENT_MISMATCH',
          message: 'Claude installed payload did not match the planned source identity',
        }, keepBackup, dependencies)
      }
    }
    return { success: true, rollbackAttempted: false }
  } catch {
    return await fail(spec, payload, registration, recoveryRoot, {
      success: false,
      rollbackAttempted: mutationStarted && backupsComplete,
    }, { code: 'CLAUDE_TRANSACTION_FAILED', message: 'Claude replacement transaction failed' }, keepBackup, dependencies)
  } finally {
    if (!preserveBackup) {
      if (recoveryRoot) await rm(recoveryRoot, { recursive: true, force: true }).catch(() => {})
      if (payload.backupStorage) await removeOwnedPath(payload.backupStorage.directory).catch(() => {})
    }
  }
}

async function fail (
  transactionSpec: ClaudeTransactionSpec,
  payload: PayloadSnapshot,
  registration: readonly RegistrationSnapshot[],
  recoveryRoot: string | undefined,
  base: ClaudeTransactionResult,
  error: UpdateError,
  keepBackup: () => void,
  dependencies: ClaudeTransactionDependencies = {}
): Promise<ClaudeTransactionResult> {
  // Anchor the authorized post-mutation state to whatever this transaction
  // actually left behind when capture did not run (command failures).
  if (payload.postRoot === undefined) payload.postRoot = installedClaudePayloadRoot(transactionSpec.configPath, transactionSpec.pluginId, transactionSpec.scope)
  if (payload.postDigest === undefined && payload.postRoot) payload.postDigest = stateDigest(payload.postRoot) ?? null
  for (const entry of registration) {
    if (entry.postDigest === undefined) entry.postDigest = existsSync(entry.path) ? stateDigest(entry.path) : null
  }
  const rollback = dependencies.restoreState
    ? await dependencies.restoreState(payload, registration)
    : await restore(payload, registration)
  if (!rollback) {
    keepBackup()
    return {
      ...base,
      rollbackSucceeded: false,
      recoveryPath: recoveryRoot,
      error: {
        code: 'CLAUDE_ROLLBACK_FAILED',
        message: `Claude native state drifted during the failed update and could not be restored; the pre-update recovery bundle was preserved at ${recoveryRoot}`,
      },
    }
  }
  return { ...base, rollbackSucceeded: true, error }
}

/**
 * Restore the backed-up native state. Exposed for direct drift-gate testing:
 * restoration only proceeds while every live byte still matches the exact
 * post-update state this transaction produced.
 */
export async function restoreClaudeNativeState (
  payload: PayloadSnapshot,
  registration: readonly RegistrationSnapshot[]
): Promise<boolean> {
  return restore(payload, registration)
}

export interface ClaudeRegistrationSnapshot {
  path: string
  existed: boolean
  bytes?: Buffer
  digest?: string
  postDigest?: string | null
}

async function restore (payload: PayloadSnapshot, registration: readonly RegistrationSnapshot[]): Promise<boolean> {
  try {
    // Authoritative pre-mutation digest for every backup comparison below.
    // Before any live byte is touched, the backup must still be the same path
    // kind and still hash to the exact original digest: a backup altered after
    // its initial verification is never restored. Manually constructed
    // drift-gate snapshots without a captured original fall back to the
    // current backup bytes.
    let payloadOriginalDigest: string | null = null
    if (payload.kind && payload.kind !== 'missing' && payload.backupStorage) {
      const backupKind = await ownedPathKind(payload.backupStorage.path)
      const backupDigest = stateDigest(payload.backupStorage.path) ?? null
      payloadOriginalDigest = payload.originalDigest ?? backupDigest
      if (backupKind !== payload.kind || backupDigest !== payloadOriginalDigest) return false
    }
    // Only restore while every live byte still matches the exact post-update
    // state this transaction produced. Anything else is concurrent drift and
    // must never be overwritten.
    for (const entry of registration) {
      if (entry.postDigest === undefined) return false
      const current = existsSync(entry.path) ? stateDigest(entry.path) : null
      if (current !== entry.postDigest) return false
    }
    if (payload.postRoot !== undefined) {
      const current = existsSync(payload.postRoot) ? stateDigest(payload.postRoot) : null
      if (current !== payload.postDigest) return false
    } else if (payload.root) {
      // The failed update removed the plugin registration, so no post-update
      // root remains resolvable. The only authorized states for the original
      // payload location are the original bytes or their absence.
      const original = payloadOriginalDigest
      const current = existsSync(payload.root) ? stateDigest(payload.root) : null
      if (current !== original && current !== null) return false
    }
    // Restore the payload first so the restored registration never points at
    // missing bytes. The original payload comes back even when the failed
    // update left no resolvable post-update root.
    if (payload.root && payload.kind && payload.kind !== 'missing' && payload.backupStorage) {
      if (payload.postRoot) await removeOwnedPath(payload.postRoot)
      await removeOwnedPath(payload.root)
      await copyOwnedPath(payload.backupStorage.path, payload.root)
    } else if (payload.postRoot) {
      await removeOwnedPath(payload.postRoot)
    }
    for (const entry of registration) {
      if (!entry.existed) {
        await rm(entry.path, { force: true })
        continue
      }
      // Restore from the verified on-disk backup; in-memory bytes are only a
      // fallback for manually constructed drift-gate snapshots.
      let restoreBytes = entry.bytes
      if (entry.backupPath) {
        if (!existsSync(entry.backupPath)) return false
        const diskBytes = readFileSync(entry.backupPath)
        if (entry.digest && sha256(diskBytes) !== entry.digest) return false
        restoreBytes = diskBytes
      }
      if (!restoreBytes) return false
      // Durable 0600 restore: temp file with the private mode plus rename, so
      // an existing live file cannot keep its wider permissions.
      writeDurableFile(entry.path, restoreBytes)
      // A private mode is part of the restored contract: the final file is
      // verified explicitly because creation modes are umask-filtered.
      if ((statSync(entry.path).mode & 0o777) !== 0o600) return false
    }
    for (const entry of registration) {
      const restored = existsSync(entry.path) ? stateDigest(entry.path) : null
      if (restored !== (entry.existed ? entry.digest ?? null : null)) return false
    }
    if (payload.root) {
      const restored = existsSync(payload.root) ? stateDigest(payload.root) : null
      if (restored !== payloadOriginalDigest) return false
    }
    return true
  } catch {
    return false
  }
}

/** Resolve the single installed payload directory for a scoped Claude plugin. */
export function installedClaudePayloadRoot (
  configPath: string | undefined,
  pluginId: string,
  scope: string,
  expectedVersion?: string
): string | undefined {
  if (!configPath || !path.isAbsolute(configPath)) return undefined
  try {
    const data = JSON.parse(readFileSync(configPath, 'utf8')) as unknown
    if (!data || typeof data !== 'object' || Array.isArray(data)) return undefined
    const plugins = (data as Record<string, unknown>).plugins
    if (!plugins || typeof plugins !== 'object' || Array.isArray(plugins)) return undefined
    const value = (plugins as Record<string, unknown>)[pluginId]
    const records = Array.isArray(value) ? value : [value]
    const roots = records.flatMap((record) => {
      if (!record || typeof record !== 'object' || Array.isArray(record)) return []
      const entry = record as Record<string, unknown>
      if (readClaudePluginScope(entry) !== scope) return []
      if (expectedVersion && typeof entry.version === 'string' && entry.version !== expectedVersion) return []
      if (typeof entry.installPath !== 'string' || !path.isAbsolute(entry.installPath)) return []
      const root = path.resolve(entry.installPath)
      return existsSync(root) ? [root] : []
    })
    return roots.length === 1 ? roots[0] : undefined
  } catch {
    return undefined
  }
}

/** Canonical digest of a registration file or payload directory tree. */
function stateDigest (target: string): string | undefined {
  try {
    if (statSync(target).isFile()) {
      return createHash('sha256').update(readFileSync(target)).digest('hex')
    }
    return nativePayloadDigest(target)
  } catch {
    return undefined
  }
}

function defaultRecoveryRoot (registrationPaths: readonly string[]): string {
  const primary = registrationPaths.length > 0
    ? path.dirname(path.resolve(registrationPaths[0]))
    : tmpdir()
  // Synchronous allocation keeps backup setup free of interleaving, and the
  // sibling location keeps the bundle associated with the registration evidence.
  return mkdtempSync(path.join(primary, '.nsolid-claude-recovery-'))
}

/** Repo-standard durable write: temp file, fsync, rename, best-effort dir fsync. */
function writeDurableFile (target: string, bytes: Buffer): void {
  const temporary = `${target}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`
  const fd = openSync(temporary, 'w', 0o600)
  // The open(2) mode is umask-filtered, so the private mode is enforced
  // explicitly and applies to every durable write this module performs.
  fchmodSync(fd, 0o600)
  try {
    writeSync(fd, bytes)
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
  renameSync(temporary, target)
  try {
    const directory = openSync(path.dirname(target), 'r')
    try { fsyncSync(directory) } finally { closeSync(directory) }
  } catch { /* directory fsync is unavailable on some platforms */ }
}

function sha256 (value: Buffer): string {
  return createHash('sha256').update(value).digest('hex')
}
