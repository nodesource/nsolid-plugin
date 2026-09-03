import { symlink, readlink, lstat, rm, rename, cp } from 'node:fs/promises'
import path from 'node:path'
import type { HarnessType, Logger, SkillRef } from '../types.js'
import { getSkillsDir } from '../utils/path.js'
import { ensureDir } from '../utils/fs.js'
import { assertSafeSkillName } from '../utils/skill-name.js'
import { getAdapter } from '../harnesses/index.js'
import { toPluginError } from '../errors.js'

export type LinkStatus = 'skipped' | 'replaced' | 'backed-up' | 'created'

export interface LinkResult {
  skill: string;
  status: LinkStatus;
  target: string;
}

export interface SkillLinkFsOps {
  symlink (existingPath: string, newPath: string, type?: 'dir' | 'junction'): Promise<void>
  cp (source: string, destination: string, options?: { recursive?: boolean, force?: boolean }): Promise<void>
}

export interface SkillLinkMaterializationOptions {
  /** The path a symlink or junction should reference: the final live skill path. */
  linkSource: string
  /** The path to create. */
  target: string
  /**
   * The directory copied when linking is unsupported or unwanted. Defaults to
   * linkSource; fallback staging sets it to the newly prepared staged bytes so
   * a copy never captures the old live content.
   */
  copySource?: string
  /** Always copy instead of linking (the Pi harness policy). */
  alwaysCopy?: boolean
  /** Platform used to choose the link strategy; defaults to process.platform. */
  platform?: NodeJS.Platform
  /** Filesystem operations; defaults to node:fs/promises, injectable in tests. */
  fs?: SkillLinkFsOps
}

/**
 * The single policy for materializing a harness skill link: Pi always copies;
 * Windows attempts a junction and recursively copies `copySource` on failure
 * (junctions do not require elevated privileges); other platforms create a
 * directory symlink and never fall back to copying on unrelated errors.
 */
export async function materializeSkillLink (options: SkillLinkMaterializationOptions): Promise<void> {
  const { linkSource, target, copySource = linkSource, alwaysCopy = false, platform = process.platform } = options
  const ops = options.fs ?? { symlink, cp }
  if (alwaysCopy) {
    await ops.cp(copySource, target, { recursive: true, force: true })
    return
  }

  if (platform === 'win32') {
    try {
      await ops.symlink(linkSource, target, 'junction')
    } catch {
      await ops.cp(copySource, target, { recursive: true, force: true })
    }
    return
  }

  await ops.symlink(linkSource, target, 'dir')
}

export function getHarnessSkillsPath (harness: HarnessType): string {
  // Delegate to the adapter so each harness's skills directory has a single
  // source of truth. A duplicated hardcoded list here previously drifted out
  // of sync with the adapter (antigravity linked into a path the runtime did
  // not read), so install() and doctor() disagreed on whether skills existed.
  return getAdapter(harness).getSkillsPath()
}

export async function linkSkillsToHarness (
  harness: HarnessType,
  skills: SkillRef[],
  logger?: Logger
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
    logger?.debug('skills.link', { harness, skill: skill.name, target, status })
    results.push({ skill: skill.name, status, target })
  }

  return results
}

export async function unlinkSkillsFromHarness (
  harness: HarnessType,
  skills: SkillRef[],
  logger?: Logger
): Promise<void> {
  const harnessDir = getHarnessSkillsPath(harness)

  for (const skill of skills) {
    const safeName = assertSafeSkillName(skill.name)
    const target = path.join(harnessDir, safeName)
    try {
      // lstat also finds dangling symlinks. access() follows the link and
      // treated a removed shared skill as missing, leaving stale harness links
      // behind after a fallback refresh.
      await lstat(target)
      logger?.debug('skills.unlink', { harness, skill: skill.name, target })
      await rm(target, { recursive: true, force: true })
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw toPluginError(err, 'SKILL_LINK_FAILED', { harness, path: target })
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
      await materializeSkillLink({ linkSource: source, target, alwaysCopy })
      return 'replaced'
    }

    // Regular file or directory: backup
    const backupPath = `${target}.bak.${Date.now()}`
    await rename(target, backupPath)
    await materializeSkillLink({ linkSource: source, target, alwaysCopy })
    return 'backed-up'
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      await materializeSkillLink({ linkSource: source, target, alwaysCopy })
      return 'created'
    }
    throw err
  }
}
