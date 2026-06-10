import type { Credentials } from '../types.js';
import { getAuthFilePath, getAgentsDir } from '../utils/path.js';
import { ensureDir } from '../utils/fs.js';
import { readJsonFile } from '../utils/config.js';
import writeFileAtomic from 'write-file-atomic';

export function saveCredentials(creds: Credentials): void {
  ensureDir(getAgentsDir());
  writeFileAtomic.sync(getAuthFilePath(), JSON.stringify(creds, null, 2) + '\n', { mode: 0o600 });
}

export function loadCredentials(): Credentials | null {
  return readJsonFile<Credentials>(getAuthFilePath());
}

export function isExpired(creds: Credentials): boolean {
  return new Date(creds.expiresAt).getTime() < Date.now();
}
