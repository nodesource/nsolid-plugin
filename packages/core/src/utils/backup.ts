import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { copyFileSync, existsSync, mkdirSync, readdirSync, statSync, unlinkSync, readFileSync as fsReadFileSync } from 'node:fs'
import { HARNESS_VALUES, type HarnessType } from '../types.js'
import { getConfigBackupDir, resolveHome } from './path.js'
import { atomicWriteSync } from './fs.js'
import { readJsonFile } from './config.js'
import { formatPluginError, toPluginError, PluginError } from '../errors.js'

export interface BackupEntry {
  harness: HarnessType
  originalPath: string
  backupPath: string
  createdAt: string
}

interface BackupMeta {
  harness: HarnessType
  originalPath: string
  createdAt: string
  /**
   * Monotonic per-directory sequence, reserved through an exclusive,
   * immutable marker (see reserveBackupSeq). `createdAt` has millisecond precision
   * and filesystem mtimes can be coarse (FAT, network mounts), so neither
   * can guarantee newest-first ordering for back-to-back backups; `seq`
   * cannot tie.
   */
  seq?: number
  reason?: string
}

const SEQ_RESERVATIONS_DIR = '.seq-reservations'

function normalizeBackupMeta (value: unknown): BackupMeta | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null

  const candidate = value as Record<string, unknown>
  const createdAtMs = typeof candidate.createdAt === 'string' ? Date.parse(candidate.createdAt) : Number.NaN
  if (
    typeof candidate.harness !== 'string' ||
    !HARNESS_VALUES.includes(candidate.harness as HarnessType) ||
    typeof candidate.originalPath !== 'string' ||
    !Number.isFinite(createdAtMs)
  ) return null

  const seq = typeof candidate.seq === 'number' &&
    Number.isSafeInteger(candidate.seq) &&
    candidate.seq > 0 &&
    candidate.seq < Number.MAX_SAFE_INTEGER
    ? candidate.seq
    : undefined

  return {
    harness: candidate.harness as HarnessType,
    originalPath: candidate.originalPath,
    createdAt: new Date(createdAtMs).toISOString(),
    seq,
    reason: typeof candidate.reason === 'string' ? candidate.reason : undefined,
  }
}

/** Highest seq persisted in existing backup sidecars (0 when none). */
function highestMetaSeq (dir: string): number {
  let max = 0
  for (const name of readdirSync(dir)) {
    if (!name.endsWith('.meta.json')) continue
    let meta: BackupMeta | null
    try {
      meta = normalizeBackupMeta(readJsonFile<unknown>(path.join(dir, name)))
    } catch {
      continue
    }
    if (meta?.seq !== undefined && meta.seq > max) max = meta.seq
  }
  return max
}

/** Highest immutable sequence reservation (0 when none). */
function highestReservedSeq (dir: string): number {
  const reservationsDir = path.join(dir, SEQ_RESERVATIONS_DIR)
  if (!existsSync(reservationsDir)) return 0

  let max = 0
  for (const name of readdirSync(reservationsDir)) {
    if (!/^[1-9]\d*$/.test(name)) continue
    const seq = Number(name)
    if (Number.isSafeInteger(seq) && seq > max) max = seq
  }
  return max
}

/** Counter floor written by the previous lock-based implementation. */
function legacyCounterSeq (dir: string): number {
  try {
    const seq = Number(fsReadFileSync(path.join(dir, '.seq'), 'utf8').trim())
    return Number.isSafeInteger(seq) && seq > 0 ? seq : 0
  } catch {
    return 0
  }
}

/**
 * Reserve the next backup sequence for a directory, atomically across
 * processes. Every sequence is an immutable directory created with exclusive
 * mkdir semantics. Concurrent callers may propose the same number, but only
 * one can create its marker; losers advance until their own marker succeeds.
 * Reservations are never removed, so a crashed creator leaves a harmless gap
 * instead of making the number reusable. Existing sidecars and the counter
 * from the previous implementation establish the migration floor.
 */
function reserveBackupSeq (dir: string): number {
  const reservationsDir = path.join(dir, SEQ_RESERVATIONS_DIR)
  mkdirSync(reservationsDir, { recursive: true })

  let seq = Math.max(highestMetaSeq(dir), highestReservedSeq(dir), legacyCounterSeq(dir)) + 1
  while (Number.isSafeInteger(seq)) {
    try {
      mkdirSync(path.join(reservationsDir, String(seq)))
      return seq
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err
      seq++
    }
  }
  throw new Error('Backup sequence space exhausted')
}

function backupName (originalPath: string, timestamp: number): string {
  const ext = path.extname(originalPath) || '.bak'
  return `${timestamp}-${randomUUID()}${ext}`
}

function metaPath (backupPath: string): string {
  return `${backupPath}.meta.json`
}

export function createConfigBackup (
  harness: HarnessType,
  originalPath: string,
  options?: { reason?: string }
): BackupEntry | null {
  if (!existsSync(originalPath)) return null

  originalPath = path.resolve(resolveHome(originalPath))

  const dir = getConfigBackupDir(harness)
  mkdirSync(dir, { recursive: true })

  const timestamp = Date.now()
  const backupPath = path.join(dir, backupName(originalPath, timestamp))
  try {
    // Back-to-back backups can share a millisecond (and coarse filesystems can
    // share mtimes): reserve a cross-process sequence that cannot tie so
    // "latest" is always the backup that was created last.
    const seq = reserveBackupSeq(dir)
    copyFileSync(originalPath, backupPath)
    const meta: BackupMeta = {
      harness,
      originalPath,
      createdAt: new Date(timestamp).toISOString(),
      seq,
      reason: options?.reason,
    }
    atomicWriteSync(metaPath(backupPath), JSON.stringify(meta, null, 2) + '\n')
  } catch (err) {
    // If we cannot create a backup, do not leave a partial file behind.
    try { unlinkSync(backupPath) } catch { /* ignore */ }
    try { unlinkSync(metaPath(backupPath)) } catch { /* ignore */ }
    const pluginErr = toPluginError(err, 'MCP_CONFIG_BACKUP_FAILED', { path: originalPath, harness })
    throw new Error(formatPluginError(pluginErr), { cause: pluginErr })
  }

  return {
    harness,
    originalPath,
    backupPath,
    createdAt: new Date(timestamp).toISOString(),
  }
}

export function listConfigBackups (harness: HarnessType): BackupEntry[] {
  const dir = getConfigBackupDir(harness)
  if (!existsSync(dir)) return []

  const entries: Array<{ entry: BackupEntry; seq: number; metaMtimeMs: number }> = []
  for (const name of readdirSync(dir)) {
    if (name.endsWith('.meta.json')) continue
    const backupPath = path.join(dir, name)
    let meta: BackupMeta | null
    try {
      meta = normalizeBackupMeta(readJsonFile<unknown>(metaPath(backupPath)))
    } catch {
      continue
    }
    if (!meta || meta.harness !== harness) continue
    let metaMtimeMs = 0
    try {
      // Legacy tie-break for backups created before the persisted `seq`
      // existed (sub-millisecond on ext4/NTFS/APFS).
      metaMtimeMs = statSync(metaPath(backupPath)).mtimeMs
    } catch {
      // Meta file vanished mid-scan — order it last among ties.
    }
    entries.push({
      entry: {
        harness: meta.harness,
        originalPath: meta.originalPath,
        backupPath,
        createdAt: meta.createdAt,
      },
      seq: meta.seq ?? 0,
      metaMtimeMs,
    })
  }

  // Newest first: createdAt is primary; ties (same millisecond) break by the
  // persisted seq, which cannot tie. Legacy backups without seq (seq = 0)
  // fall back to the meta file mtime among themselves.
  return entries
    .sort((a, b) =>
      b.entry.createdAt.localeCompare(a.entry.createdAt) || b.seq - a.seq || b.metaMtimeMs - a.metaMtimeMs
    )
    .map(({ entry }) => entry)
}

export function restoreConfigBackup (
  harness: HarnessType,
  backupPath?: string
): BackupEntry {
  const backups = listConfigBackups(harness)
  if (backups.length === 0) {
    const err = new PluginError('BACKUP_NOT_FOUND', `No backups found for harness "${harness}"`, {
      action: 'Run installation first to create a backup, or check ~/.agents/.config-backup/.',
      harness,
    })
    throw new Error(formatPluginError(err), { cause: err })
  }

  const selected = backupPath
    ? backups.find((b) => path.resolve(b.backupPath) === path.resolve(backupPath))
    : backups[0]

  if (!selected) {
    const err = new PluginError('BACKUP_NOT_FOUND', `Backup not found: ${backupPath}`, {
      action: 'Run restore with a valid backup path, or omit --backup to restore the latest.',
      harness,
    })
    throw new Error(formatPluginError(err), { cause: err })
  }

  try {
    atomicWriteSync(selected.originalPath, fsReadFileSync(selected.backupPath, 'utf8'))
  } catch (err) {
    const pluginErr = toPluginError(err, 'BACKUP_RESTORE_FAILED', {
      path: selected.originalPath,
      harness,
      cause: err,
    })
    throw new Error(formatPluginError(pluginErr), { cause: pluginErr })
  }

  return selected
}
