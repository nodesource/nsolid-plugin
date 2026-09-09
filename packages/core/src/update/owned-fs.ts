import { cp, lstat, mkdtemp, open, readFile, readdir, rename, rm } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import path from 'node:path'

export type OwnedPathKind = 'missing' | 'file' | 'directory' | 'junction-or-symlink' | 'other'

export interface SiblingBackupPath {
  directory: string
  path: string
}

/** Error for owned-filesystem contract violations; never silently swallowed. */
export class OwnedFsError extends Error {
  readonly code: 'SYMLINK_IN_TREE' | 'KIND_CHANGED'
  readonly relativePath?: string

  constructor (code: 'SYMLINK_IN_TREE' | 'KIND_CHANGED', relativePath?: string, message?: string) {
    super(message ?? (relativePath !== undefined ? `${code}: ${relativePath}` : code))
    this.name = 'OwnedFsError'
    this.code = code
    this.relativePath = relativePath
  }
}

const RETRYABLE_FS_ERRORS = new Set(['EPERM', 'EBUSY', 'ENOTEMPTY'])
const OWNED_TEMP_ATTEMPTS = 5

/** Locale-independent total ordering over the exact UTF-8 path bytes. */
function comparePathNames (left: string, right: string): number {
  return Buffer.compare(Buffer.from(left), Buffer.from(right))
}

/** Allocate backup storage beside the target so it is necessarily on the same volume. */
export async function createSiblingBackupPath (targetPath: string, label: string): Promise<SiblingBackupPath> {
  const absolute = path.resolve(targetPath)
  const directory = await mkdtemp(path.join(path.dirname(absolute), `.${path.basename(absolute)}.nsolid-${label}-`))
  return { directory, path: path.join(directory, path.basename(absolute)) }
}

/** Classify the owned path itself; never dereference a junction/symlink. */
export async function ownedPathKind (targetPath: string): Promise<OwnedPathKind> {
  try {
    const stats = await lstat(targetPath)
    if (stats.isSymbolicLink()) return 'junction-or-symlink'
    if (stats.isDirectory()) return 'directory'
    if (stats.isFile()) return 'file'
    return 'other'
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 'missing'
    throw error
  }
}

/** SHA-256 hex digest of a regular file's bytes; null for any other path kind. */
export async function ownedFileDigest (targetPath: string): Promise<string | null> {
  const kind = await ownedPathKind(targetPath)
  if (kind !== 'file') return null
  const bytes = await readFile(targetPath)
  return createHash('sha256').update(bytes).digest('hex')
}

/**
 * Deterministic digest of an owned directory tree. Entries are framed with
 * their kind, POSIX relative path, and content digest (files) or link target
 * (symlinks) so two identical trees hash identically regardless of the order
 * the filesystem reports them, and any single-byte content change changes the
 * digest. By default ANY nested symlink (or a symlink at the root itself)
 * throws `OwnedFsError('SYMLINK_IN_TREE', relativePath)` instead of being
 * recorded, so callers can never mistake a redirected tree for a stable one.
 */
export async function ownedTreeDigest (
  targetPath: string,
  options: { allowSymlinks?: false } = {}
): Promise<string | null> {
  const kind = await ownedPathKind(targetPath)
  if (kind === 'missing') return null
  if (kind === 'junction-or-symlink') {
    // A symlinked root is never dereferenced: it cannot be digested as a tree,
    // and silently returning null would hide the redirect from callers.
    throw new OwnedFsError('SYMLINK_IN_TREE', '.')
  }
  if (kind !== 'directory') return null
  const entries: Array<{ relative: string, kind: string, digest: string }> = []
  const walk = async (absolute: string, relative: string): Promise<void> => {
    const children = await readdir(absolute)
    for (const child of children.sort(comparePathNames)) {
      const childAbsolute = path.join(absolute, child)
      const childRelative = relative === '' ? child : `${relative}/${child}`
      const childKind = await ownedPathKind(childAbsolute)
      if (childKind === 'junction-or-symlink') {
        throw new OwnedFsError('SYMLINK_IN_TREE', childRelative)
      }
      if (childKind === 'directory') {
        // Directory structure itself is part of the identity: a tree with an
        // extra empty directory must not collide with the same tree without it.
        entries.push({ relative: childRelative, kind: 'directory', digest: '' })
        await walk(childAbsolute, childRelative)
        continue
      }
      if (childKind === 'file') {
        const bytes = await readFile(childAbsolute)
        entries.push({ relative: childRelative, kind: 'file', digest: createHash('sha256').update(bytes).digest('hex') })
        continue
      }
      entries.push({ relative: childRelative, kind: 'other', digest: '' })
    }
  }
  await walk(targetPath, '')
  entries.sort((left, right) => comparePathNames(left.relative, right.relative))
  const hash = createHash('sha256')
  for (const entry of entries) {
    hash.update(entry.kind).update('\0').update(entry.relative).update('\0').update(entry.digest).update('\0')
  }
  return hash.digest('hex')
}

/**
 * Assert that `root` is a directory containing no symlink anywhere, without
 * dereferencing anything. On the first symlink (sorted path order) throws
 * `OwnedFsError('SYMLINK_IN_TREE', relativePath)`, with `'.'` when the root
 * itself is a symlink. A missing root throws `OwnedFsError('KIND_CHANGED')`
 * since callers pass owned trees they believe exist; any other stat error
 * propagates unchanged.
 */
export async function assertNoSymlinksInTree (root: string): Promise<void> {
  const kind = await ownedPathKind(root)
  if (kind === 'missing') throw new OwnedFsError('KIND_CHANGED', undefined, `Owned tree is missing: ${root}`)
  if (kind === 'junction-or-symlink') throw new OwnedFsError('SYMLINK_IN_TREE', '.')
  if (kind !== 'directory') throw new OwnedFsError('KIND_CHANGED', undefined, `Owned tree is not a directory: ${root}`)
  const walk = async (absolute: string, relative: string): Promise<void> => {
    const children = (await readdir(absolute)).sort(comparePathNames)
    for (const child of children) {
      const childAbsolute = path.join(absolute, child)
      const childRelative = relative === '' ? child : `${relative}/${child}`
      const childKind = await ownedPathKind(childAbsolute)
      if (childKind === 'junction-or-symlink') throw new OwnedFsError('SYMLINK_IN_TREE', childRelative)
      if (childKind === 'directory') await walk(childAbsolute, childRelative)
    }
  }
  await walk(root, '')
}

/** Copy without following reparse points and verify the copied path kind. */
export async function copyOwnedPath (source: string, destination: string): Promise<OwnedPathKind> {
  const sourceKind = await ownedPathKind(source)
  if (sourceKind === 'missing') throw new Error('Owned backup source is missing')
  if (sourceKind === 'junction-or-symlink') throw new OwnedFsError('SYMLINK_IN_TREE', '.')
  if (sourceKind === 'directory') await assertNoSymlinksInTree(source)
  await cp(source, destination, {
    recursive: sourceKind === 'directory',
    force: false,
    errorOnExist: true,
    dereference: false,
    verbatimSymlinks: true,
  })
  if (await ownedPathKind(destination) !== sourceKind) throw new Error('Owned backup path kind changed during copy')
  return sourceKind
}

/** Remove the owned path itself with bounded Windows lock retries and kind revalidation. */
export async function removeOwnedPath (targetPath: string, expectedKind?: OwnedPathKind): Promise<void> {
  for (let attempt = 0; attempt < 5; attempt++) {
    const currentKind = await ownedPathKind(targetPath)
    if (currentKind === 'missing') return
    if (expectedKind && currentKind !== expectedKind) throw new Error('Owned path kind changed before removal')
    try {
      await rm(targetPath, { recursive: currentKind === 'directory', force: true })
      return
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (!code || !RETRYABLE_FS_ERRORS.has(code) || attempt === 4) throw error
      await new Promise((resolve) => setTimeout(resolve, 25 * (attempt + 1)))
    }
  }
}

/**
 * Atomically write a regular file at an owned path. The target must currently
 * be `expectedKind` ('missing' or 'file'); anything else — including a
 * symlink — throws `OwnedFsError('KIND_CHANGED')` and the existing symlink is
 * left untouched (its referent is never modified). Bytes go to a randomized
 * sibling temp file, are fsynced, the target kind is revalidated immediately
 * before an atomic rename over the target, and the temp file is removed on
 * every failure path.
 */
export async function writeOwnedFile (
  targetPath: string,
  bytes: Buffer,
  options: { mode?: number, expectedKind: 'missing' | 'file' }
): Promise<void> {
  const assertExpectedKind = (current: OwnedPathKind): void => {
    if (current !== options.expectedKind) throw new OwnedFsError('KIND_CHANGED', undefined, `Owned path kind is '${current}', expected '${options.expectedKind}': ${targetPath}`)
  }
  assertExpectedKind(await ownedPathKind(targetPath))
  const absolute = path.resolve(targetPath)
  const directory = path.dirname(absolute)
  const basename = path.basename(absolute)
  let temp: string | undefined
  let handle: Awaited<ReturnType<typeof open>> | undefined
  for (let attempt = 0; attempt < OWNED_TEMP_ATTEMPTS; attempt++) {
    const candidate = path.join(directory, `.${basename}.nsolid-tmp-${process.pid}-${Math.random().toString(36).slice(2)}-${attempt}`)
    try {
      handle = await open(candidate, 'wx', options.mode ?? 0o600)
      temp = candidate
      break
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST' && attempt < OWNED_TEMP_ATTEMPTS - 1) continue
      throw error
    }
  }
  if (handle === undefined || temp === undefined) throw new Error('Owned temporary file could not be created')
  try {
    await handle.writeFile(bytes)
    await handle.sync()
    await handle.close()
    handle = undefined
    assertExpectedKind(await ownedPathKind(targetPath))
    await rename(temp, absolute)
  } catch (error) {
    // Only a successfully opened `wx` candidate belongs to this invocation.
    // Close it before removing it; a colliding pre-existing path is foreign
    // and is never assigned to `temp`, so it can never be cleaned up here.
    if (handle !== undefined) await handle.close().catch(() => {})
    await rm(temp, { force: true }).catch(() => {})
    throw error
  }
}
