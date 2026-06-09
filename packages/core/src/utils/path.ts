import os from 'node:os';
import path from 'node:path';

export function resolveHome(tildePath: string): string {
  if (tildePath === '~' || tildePath.startsWith('~/')) {
    return path.join(os.homedir(), tildePath.slice(1));
  }
  return tildePath;
}

export function normalizePath(p: string): string {
  return path.resolve(p);
}

export function getAgentsDir(): string {
  return path.join(os.homedir(), '.agents');
}

export function getSkillsDir(): string {
  return path.join(os.homedir(), '.agents', 'skills');
}

export function getAuthFilePath(): string {
  return path.join(os.homedir(), '.agents', '.nodesource-auth.json');
}

export function getTrackingFilePath(): string {
  return path.join(os.homedir(), '.agents', '.nodesource-installed.json');
}