import type { Credentials } from '../types.js'
import { existsSync, unlinkSync } from 'node:fs'
import { getAuthFilePath, getAgentsDir } from '../utils/path.js'
import { ensureDir } from '../utils/fs.js'
import { readJsonFile } from '../utils/config.js'
import writeFileAtomic from 'write-file-atomic'

export function saveCredentials (creds: Credentials): void {
  ensureDir(getAgentsDir())
  writeFileAtomic.sync(getAuthFilePath(), JSON.stringify(creds, null, 2) + '\n', { mode: 0o600 })
}

export function loadCredentials (): Credentials | null {
  return readJsonFile<Credentials>(getAuthFilePath())
}

export function isExpired (creds: Credentials): boolean {
  const timestamp = new Date(creds.expiresAt).getTime()
  if (isNaN(timestamp)) {
    return true // Treat invalid dates as expired
  }
  return timestamp < Date.now()
}

/**
 * Deletes the stored credentials file. Idempotent: returns false (no-op) if the
 * file does not exist, true if it was removed. Used by `logout()` and by
 * `uninstall()` when the last harness is removed.
 */
export function removeCredentials (): boolean {
  const filePath = getAuthFilePath()
  if (!existsSync(filePath)) return false
  try {
    unlinkSync(filePath)
    return true
  } catch (err) {
    throw new Error(`Failed to remove credentials at ${filePath}: ${(err as Error).message}`)
  }
}
