import { cp, lstat, mkdtemp, rm } from 'node:fs/promises'
import path from 'node:path'

export type OwnedPathKind = 'missing' | 'file' | 'directory' | 'junction-or-symlink' | 'other'

export interface SiblingBackupPath {
  directory: string
  path: string
}

const RETRYABLE_FS_ERRORS = new Set(['EPERM', 'EBUSY', 'ENOTEMPTY'])

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

/** Copy without following reparse points and verify the copied path kind. */
export async function copyOwnedPath (source: string, destination: string): Promise<OwnedPathKind> {
  const sourceKind = await ownedPathKind(source)
  if (sourceKind === 'missing') throw new Error('Owned backup source is missing')
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
