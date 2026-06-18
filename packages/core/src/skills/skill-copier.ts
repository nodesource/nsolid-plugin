import { cp, rm, access } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import path from 'node:path'
import type { Logger, SkillRef } from '../types.js'
import { getSkillsDir } from '../utils/path.js'
import { ensureDir } from '../utils/fs.js'
import { assertSafeSkillName } from '../utils/skill-name.js'
import { formatPluginError, toPluginError } from '../errors.js'

function assertSafeSkillPath (sourceDir: string, skillPath: string): string {
  const resolved = path.resolve(sourceDir, skillPath)
  const resolvedBase = path.resolve(sourceDir)
  const baseWithSep = resolvedBase.endsWith(path.sep) ? resolvedBase : resolvedBase + path.sep
  if (!resolved.startsWith(baseWithSep)) {
    throw new Error(`Skill path escapes source directory: ${skillPath}`)
  }
  return resolved
}

export class SkillCopyError extends Error {
  constructor (
    public readonly skill: string,
    cause: Error
  ) {
    super(`Failed to copy skill '${skill}': ${cause.message}`)
    this.name = 'SkillCopyError'
    this.cause = cause
  }
}

function wrapSkillCopyError (skill: string, err: unknown): SkillCopyError {
  const pluginErr = toPluginError(err, 'SKILL_COPY_FAILED')
  return new SkillCopyError(skill, new Error(formatPluginError(pluginErr), { cause: pluginErr }))
}

export async function installSkills (
  skills: SkillRef[],
  sourceDir: string,
  logger?: Logger
): Promise<void> {
  await installSkillsToDirectory(skills, sourceDir, getSkillsDir(), logger)
}

export async function installSkillsToDirectory (
  skills: SkillRef[],
  sourceDir: string,
  destDir: string,
  logger?: Logger
): Promise<void> {
  ensureDir(destDir)

  const completed: { skill: string; destPath: string; existed: boolean }[] = []

  for (const skill of skills) {
    const safeName = assertSafeSkillName(skill.name)
    const srcPath = assertSafeSkillPath(sourceDir, skill.path)
    const destPath = path.join(destDir, safeName)

    try {
      await access(srcPath)
    } catch {
      throw wrapSkillCopyError(skill.name, new Error(`Source not found: ${srcPath}`))
    }

    const existed = existsSync(destPath)
    try {
      logger?.debug('skills.copy.start', { skill: skill.name, srcPath, destPath, existed })
      await cp(srcPath, destPath, { recursive: true, force: true })
      completed.push({ skill: skill.name, destPath, existed })
      logger?.debug('skills.copy.done', { skill: skill.name, destPath })
    } catch (err) {
      logger?.error('skills.copy.failed', { skill: skill.name, destPath, error: (err as Error).message })
      // Roll back newly-created directories so a partial failure does not
      // leave stale state that interferes with the next install attempt.
      for (const done of completed) {
        if (!done.existed) {
          try { await rm(done.destPath, { recursive: true, force: true }) } catch { /* ignore */ }
        }
      }
      throw wrapSkillCopyError(skill.name, err)
    }
  }
}

export async function uninstallSkills (skills: SkillRef[], logger?: Logger): Promise<void> {
  const destDir = getSkillsDir()

  for (const skill of skills) {
    const safeName = assertSafeSkillName(skill.name)
    const destPath = path.join(destDir, safeName)
    try {
      await access(destPath)
      logger?.debug('skills.uninstall', { skill: skill.name, destPath })
      await rm(destPath, { recursive: true, force: true })
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw toPluginError(err, 'SKILL_COPY_FAILED', { path: destPath })
      }
      // Best-effort: ignore missing skills
    }
  }
}
