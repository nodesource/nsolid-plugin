import { constants, lstatSync } from 'node:fs'
import { chmod, lstat, open, rename, rm, writeFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import path from 'node:path'

/** O_NOFOLLOW is unavailable on some platforms (Windows); fall back to a plain open there. */
const NO_FOLLOW_FLAG = (constants as { O_NOFOLLOW?: number }).O_NOFOLLOW ?? 0

/**
 * Identity of a parent-owned containment directory, recorded at creation time
 * (before any other process can observe or replace the path). POSIX carries
 * device+inode; Windows filesystems expose neither, so the recorded identity
 * is empty there and containment relies on the inherited ACLs of the private
 * temporary workspace plus the other trust boundaries.
 */
export interface ContainmentDirectoryIdentity {
  /** Directory path recorded by the parent (absolute). */
  directory: string
  /** Device of the directory at creation time; undefined when not measurable. */
  dev?: number
  /** Inode of the directory at creation time; undefined when not measurable. */
  ino?: number
}

/**
 * Record the identity of a directory this process just created. The lstat is
 * taken immediately after creation/chmod, before the path can be replaced by
 * an attacker, so a later read can verify the directory was not swapped for
 * a symlink or another directory.
 */
export async function recordContainmentDirectoryIdentity (directory: string): Promise<ContainmentDirectoryIdentity> {
  const resolved = path.resolve(directory)
  if (process.platform === 'win32') {
    return { directory: resolved }
  }
  try {
    const stat = await lstat(resolved)
    return { directory: resolved, dev: stat.dev, ino: stat.ino }
  } catch {
    return { directory: resolved }
  }
}

/**
 * True when the identity of a recorded containment directory still matches
 * what is currently at that path. A replaced (symlinked or recreated)
 * directory fails the comparison even when the replacement points elsewhere.
 */
export function containmentDirectoryMatches (recorded: ContainmentDirectoryIdentity, currentDirectory: string): boolean {
  if (!path.isAbsolute(currentDirectory)) return false
  const resolved = path.resolve(currentDirectory)
  if (path.resolve(recorded.directory) !== resolved) return false
  if (recorded.dev === undefined || recorded.ino === undefined) {
    // Windows (or an unmeasurable POSIX identity): containment is enforced
    // lexically only, as before.
    return true
  }
  try {
    const stat = lstatSync(resolved)
    return stat.dev === recorded.dev && stat.ino === recorded.ino
  } catch {
    return false
  }
}

/**
 * Private, file-based result protocol between the `nsolid-plugin-refresh-owned`
 * child and its parent. The child publishes a schema-versioned, bounded,
 * nonce-bound envelope inside the parent-created private workspace; the parent
 * validates every trust boundary before promoting any of it to public state.
 * The envelope never transports arbitrary text: messages shown to users are
 * parent-owned templates keyed by an allowlisted code.
 */

export const FALLBACK_CHILD_RESULT_SCHEMA = 1
export const FALLBACK_CHILD_RESULT_MAX_BYTES = 4096
export const FALLBACK_CHILD_RESULT_FILENAME = 'result.json'

export interface FallbackChildResultRollback {
  attempted: boolean
  succeeded?: boolean
}

export interface FallbackChildResultEnvelope {
  schema: number
  nonce: string
  code: string
  rollback?: FallbackChildResultRollback
}

/**
 * Parent-owned safe messages for the child codes the parent accepts. A known
 * code can therefore never leak child-controlled data: only these constant
 * templates are ever rendered. Codes outside this map keep the existing
 * generic fallback error.
 */
const CHILD_RESULT_MESSAGES: Record<string, string> = {
  MCP_RECONCILIATION_REQUIRED: 'The fallback update requires NodeSource MCP reconciliation but valid credentials are unavailable. Run "nsolid-plugin setup --harness opencode" to authenticate, then retry the update.',
  FALLBACK_MCP_DRIFT: 'The harness MCP configuration did not match the state approved for this fallback update. The refresh was stopped before it could continue unsafely.',
  FALLBACK_OWNERSHIP_DRIFT: 'The tracked fallback ownership no longer matches this installation. The refresh was stopped.',
  UNTRACKED_INSTALLATION: 'No NodeSource tracking record covers this installation. Nothing was refreshed.',
}

/** Explicit child args pointing at the parent-planned result path. Older children ignore it safely. */
export function childResultArgs (resultPath: string): string[] {
  return ['--result', resultPath]
}

/** Extract the result path the parent planned into its own command args, or undefined. */
export function plannedChildResultPath (args: readonly string[] | undefined): string | undefined {
  if (!args) return undefined
  const index = args.indexOf('--result')
  if (index < 0) return undefined
  const value = args[index + 1]
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

/** Structured codes must be safe identifier shapes; anything else is never published or accepted. */
export function isValidChildResultCode (code: unknown): code is string {
  return typeof code === 'string' && code.length > 0 && code.length <= 64 && /^[A-Z][A-Z0-9_]*$/.test(code)
}

/** Parent-owned safe message for an accepted child code, or undefined when the code is not accepted. */
export function fallbackChildResultMessage (code: string): string | undefined {
  return CHILD_RESULT_MESSAGES[code]
}

/**
 * Child side: publish the structured result atomically with mode 0600.
 * Unpublishable inputs (unsafe code, missing nonce) are silently skipped so
 * the parent falls back to its existing generic error handling.
 */
export async function writeFallbackChildResult (
  resultPath: string,
  nonce: string,
  code: string,
  rollback: FallbackChildResultRollback | undefined
): Promise<void> {
  if (!isValidChildResultCode(code)) return
  if (typeof nonce !== 'string' || nonce.length === 0) return
  if (typeof resultPath !== 'string' || !path.isAbsolute(resultPath)) return
  const envelope: FallbackChildResultEnvelope = { schema: FALLBACK_CHILD_RESULT_SCHEMA, nonce, code }
  if (rollback && typeof rollback.attempted === 'boolean') {
    envelope.rollback = rollback.succeeded === undefined
      ? { attempted: rollback.attempted }
      : { attempted: rollback.attempted, succeeded: rollback.succeeded === true }
  }
  const payload = JSON.stringify(envelope)
  // The envelope must stay bounded: an over-limit result is never published so
  // the parent falls back to its existing generic error handling.
  if (Buffer.byteLength(payload) > FALLBACK_CHILD_RESULT_MAX_BYTES) return
  const temporary = `${resultPath}.${randomUUID()}.tmp`
  try {
    await writeFile(temporary, payload, { mode: 0o600 })
    // chmod makes the private mode explicit instead of relying on mode/umask
    // interaction alone; the post-rename verification below refuses to leave
    // behind a result anyone else could read.
    await chmod(temporary, 0o600)
    await rename(temporary, resultPath)
    if (process.platform !== 'win32') {
      const published = await lstat(resultPath)
      if ((published.mode & 0o777) !== 0o600) {
        await rm(resultPath, { force: true }).catch(() => {})
      }
    }
  } catch {
    await rm(temporary, { force: true }).catch(() => {})
  }
}

/**
 * Parent side: read and fully validate the child result before trusting it.
 * Every failed trust boundary (containment, symlink, ownership, size, schema,
 * nonce, code shape, rollback shape, malformed JSON) yields undefined so the
 * caller keeps its existing generic error behavior.
 */
export async function readValidatedFallbackChildResult (
  resultPath: string,
  expectedNonce: string,
  options: {
    /** Directories this process created; the result must live inside one of them. */
    containmentDirectories?: readonly ContainmentDirectoryIdentity[]
  } = {}
): Promise<FallbackChildResultEnvelope | undefined> {
  try {
    if (typeof resultPath !== 'string' || !path.isAbsolute(resultPath)) return undefined
    if (typeof expectedNonce !== 'string' || expectedNonce.length === 0) return undefined
    // The only legitimate result location is a parent-created private
    // workspace recorded on the plan item; anything else is rejected.
    const directories = options.containmentDirectories ?? []
    if (directories.length === 0) return undefined
    // Lexical containment first (works on every platform): the result path
    // must sit directly inside one of the recorded directories.
    const lexicalParent = path.dirname(resultPath)
    if (!directories.some((identity) => path.resolve(identity.directory) === path.resolve(lexicalParent))) return undefined
    // Identity check: the recorded directory must still BE the directory that
    // was created at planning time. A parent directory that was deleted and
    // replaced by a symlink (or by another directory) fails even if the
    // result path still lexically matches, closing the ancestor-swap escape.
    const recorded = directories.find((identity) => path.resolve(identity.directory) === path.resolve(lexicalParent))
    if (!recorded || !containmentDirectoryMatches(recorded, lexicalParent)) return undefined
    // Open the expected path exactly once with no-follow semantics: on POSIX
    // O_NOFOLLOW makes a symlink planted at the path fail instead of being
    // followed. Every further check (file kind, ownership, mode, size, bytes)
    // inspects only this already-open descriptor, so swapping the path after
    // validation cannot change what this call reads. Windows has no
    // O_NOFOLLOW equivalent and does not expose POSIX ownership/mode bits
    // here; isolation rests on inherited temporary-directory ACLs plus the
    // containment and nonce validation.
    const handle = await open(resultPath, constants.O_RDONLY | NO_FOLLOW_FLAG)
    let text: string
    try {
      // Check-open-check: after the descriptor is open, re-verify the
      // containment directory identity so a swap between the first check and
      // the open is still detected. The residual window is the open syscall
      // itself; Node exposes no openat2-style ancestor no-follow primitive.
      if (!containmentDirectoryMatches(recorded, lexicalParent)) return undefined
      const stat = await handle.stat()
      if (!stat.isFile()) return undefined
      // Ownership assumption: the envelope must have been written by this user.
      if (typeof process.getuid === 'function' && stat.uid !== process.getuid()) return undefined
      // The result is private state: reject anything group- or world-readable
      // on POSIX. Windows does not expose these owner/mode bits here; its
      // isolation guarantee rests on inherited temporary-directory ACLs plus
      // containment and nonce validation.
      if (typeof process.getuid === 'function' && (stat.mode & 0o077) !== 0) return undefined
      if (stat.size > FALLBACK_CHILD_RESULT_MAX_BYTES) return undefined
      // Bounded read from the same descriptor: never re-resolve the path.
      const buffer = Buffer.alloc(FALLBACK_CHILD_RESULT_MAX_BYTES)
      const read = await handle.read(buffer, 0, FALLBACK_CHILD_RESULT_MAX_BYTES, 0)
      text = buffer.toString('utf8', 0, read.bytesRead)
    } finally {
      await handle.close().catch(() => {})
    }
    const parsed = JSON.parse(text) as Partial<FallbackChildResultEnvelope> | null
    if (!parsed || typeof parsed !== 'object') return undefined
    if (parsed.schema !== FALLBACK_CHILD_RESULT_SCHEMA) return undefined
    if (typeof parsed.nonce !== 'string' || parsed.nonce.length === 0 || parsed.nonce !== expectedNonce) return undefined
    // Identifier shape is not enough: only codes the parent owns a safe
    // message template for may be accepted. An unknown code with a valid
    // shape must not surface an envelope (or its rollback claim) publicly.
    if (!isValidChildResultCode(parsed.code)) return undefined
    if (fallbackChildResultMessage(parsed.code) === undefined) return undefined
    if (parsed.rollback !== undefined) {
      const rollback = parsed.rollback as Partial<FallbackChildResultRollback> | null
      if (!rollback || typeof rollback !== 'object' || typeof rollback.attempted !== 'boolean') return undefined
      if (rollback.succeeded !== undefined && typeof rollback.succeeded !== 'boolean') return undefined
    }
    return parsed.rollback !== undefined
      ? { schema: parsed.schema, nonce: parsed.nonce, code: parsed.code, rollback: parsed.rollback as FallbackChildResultRollback }
      : { schema: parsed.schema, nonce: parsed.nonce, code: parsed.code }
  } catch {
    return undefined
  }
}
