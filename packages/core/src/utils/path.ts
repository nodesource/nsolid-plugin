import os from 'node:os'
import path from 'node:path'
import type { HarnessType } from '../types.js'

export function resolveHome (tildePath: string): string {
  if (tildePath === '~' || tildePath.startsWith('~/') || tildePath.startsWith('~\\')) {
    return path.join(os.homedir(), tildePath.slice(1).replace(/\\/g, path.sep))
  }
  return tildePath
}

export function normalizePath (p: string): string {
  return path.resolve(p)
}

export function getAgentsDir (): string {
  return path.join(os.homedir(), '.agents')
}

export function getSkillsDir (): string {
  return path.join(os.homedir(), '.agents', 'skills')
}

export function getAuthFilePath (): string {
  return path.join(os.homedir(), '.agents', '.nodesource-auth.json')
}

export function getTrackingFilePath (): string {
  return path.join(os.homedir(), '.agents', '.nodesource-installed.json')
}

export function getConfigBackupDir (harness?: HarnessType): string {
  return harness
    ? path.join(os.homedir(), '.agents', '.config-backup', harness)
    : path.join(os.homedir(), '.agents', '.config-backup')
}
