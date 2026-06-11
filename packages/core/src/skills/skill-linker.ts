import { symlink, readlink, lstat, rm, rename, cp, access } from 'node:fs/promises'
import path from 'node:path'
import type { HarnessType, SkillRef } from '../types.js'
import { getSkillsDir, resolveHome } from '../utils/path.js'
import { ensureDir } from '../utils/fs.js'

function assertSafeSkillName (name: string): string {
  if (name !== path.basename(name) || name.includes('..') || name.includes(path.sep)) {
    throw new Error(`Invalid skill name: ${name}`)
  }
  return name
}

export type LinkStatus = 'skipped' | 'replaced' | 'backed-up' | 'created'

export interface LinkResult {
  skill: string;
  status: LinkStatus;
  target: string;
}

const IS_WINDOWS = process.platform === 'win32'

export function getHarnessSkillsPath (harness: HarnessType): string {
  switch (harness) {
    case 'claude':
      return resolveHome('~/.claude/skills/')
    case 'codex':
      return resolveHome('~/.codex/skills/')
    case 'opencode':
      return resolveHome('~/.config/opencode/skills/')
    case 'antigravity':
      return resolveHome('~/.gemini/antigravity-cli/skills/')
    case 'pi':
      return resolveHome('~/.pi/agent/skills/')
  }
}

export async function linkSkillsToHarness (
  harness: HarnessType,
  skills: SkillRef[]
): Promise<LinkResult[]> {
  const harnessDir = getHarnessSkillsPath(harness)
  ensureDir(harnessDir)

  const results: LinkResult[] = []
  const isPi = harness === 'pi'

  for (const skill of skills) {
    const safeName = assertSafeSkillName(skill.name)
    const source = path.join(getSkillsDir(), safeName)
    const target = path.join(harnessDir, safeName)

    const status = await createIdempotentLink(source, target, isPi)
    results.push({ skill: skill.name, status, target })
  }

  return results
}

export async function unlinkSkillsFromHarness (
  harness: HarnessType,
  skills: SkillRef[]
): Promise<void> {
  const harnessDir = getHarnessSkillsPath(harness)

  for (const skill of skills) {
    const safeName = assertSafeSkillName(skill.name)
    const target = path.join(harnessDir, safeName)
    try {
      await access(target)
      await rm(target, { recursive: true, force: true })
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw err
      }
      // Best-effort: ignore missing
    }
  }
}

async function createIdempotentLink (
  source: string,
  target: string,
  alwaysCopy: boolean
): Promise<LinkStatus> {
  try {
    const stats = await lstat(target)

    if (stats.isSymbolicLink()) {
      const existingTarget = await readlink(target)
      const resolvedExisting = path.resolve(path.dirname(target), existingTarget)

      if (!alwaysCopy && resolvedExisting === path.resolve(source)) {
        return 'skipped'
      }

      await rm(target, { force: true })
      await doCreateLink(source, target, alwaysCopy)
      return 'replaced'
    }

    // Regular file or directory: backup
    const backupPath = `${target}.bak.${Date.now()}`
    await rename(target, backupPath)
    await doCreateLink(source, target, alwaysCopy)
    return 'backed-up'
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      await doCreateLink(source, target, alwaysCopy)
      return 'created'
    }
    throw err
  }
}

async function doCreateLink (
  source: string,
  target: string,
  alwaysCopy: boolean
): Promise<void> {
  if (alwaysCopy) {
    await cp(source, target, { recursive: true, force: true })
    return
  }

  if (IS_WINDOWS) {
    try {
      await symlink(source, target, 'junction')
    } catch {
      await cp(source, target, { recursive: true, force: true })
    }
    return
  }

  await symlink(source, target, 'dir')
}
