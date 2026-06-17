import path from 'node:path'
import { copyFileSync, existsSync, mkdirSync, readdirSync, unlinkSync, readFileSync as fsReadFileSync } from 'node:fs'
import type { HarnessType } from '../types.js'
import { getConfigBackupDir } from './path.js'
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
  reason?: string
}

function backupName (originalPath: string, timestamp: number): string {
  const ext = path.extname(originalPath) || '.bak'
  return `${timestamp}${ext}`
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

  const dir = getConfigBackupDir(harness)
  mkdirSync(dir, { recursive: true })

  const timestamp = Date.now()
  const backupPath = path.join(dir, backupName(originalPath, timestamp))

  try {
    copyFileSync(originalPath, backupPath)
    const meta: BackupMeta = {
      harness,
      originalPath,
      createdAt: new Date(timestamp).toISOString(),
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

  const entries: BackupEntry[] = []
  for (const name of readdirSync(dir)) {
    if (name.endsWith('.meta.json')) continue
    const backupPath = path.join(dir, name)
    const meta = readJsonFile<BackupMeta>(metaPath(backupPath))
    if (!meta) continue
    entries.push({
      harness: meta.harness,
      originalPath: meta.originalPath,
      backupPath,
      createdAt: meta.createdAt,
    })
  }

  return entries.sort((a, b) => b.createdAt.localeCompare(a.createdAt))
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
