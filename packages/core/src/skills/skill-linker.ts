import { symlink, readlink, lstat, rm, rename, cp, access } from 'node:fs/promises'
import path from 'node:path'
import type { HarnessType, SkillRef } from '../types.js'
import { getSkillsDir } from '../utils/path.js'
import { ensureDir } from '../utils/fs.js'
import { assertSafeSkillName } from '../utils/skill-name.js'
import { getAdapter } from '../harnesses/index.js'

export type LinkStatus = 'skipped' | 'replaced' | 'backed-up' | 'created'

export interface LinkResult {
  skill: string;
  status: LinkStatus;
  target: string;
}

const IS_WINDOWS = process.platform === 'win32'

export function getHarnessSkillsPath (harness: HarnessType): string {
  // Delegate to the adapter so each harness's skills directory has a single
  // source of truth. A duplicated hardcoded list here previously drifted out
  // of sync with the adapter (antigravity linked into a path the runtime did
  // not read), so install() and doctor() disagreed on whether skills existed.
  return getAdapter(harness).getSkillsPath()
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
