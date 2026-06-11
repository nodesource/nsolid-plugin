import { cp, rm, access } from 'node:fs/promises'
import path from 'node:path'
import type { SkillRef } from '../types.js'
import { getSkillsDir } from '../utils/path.js'
import { ensureDir } from '../utils/fs.js'

function assertSafeSkillPath (sourceDir: string, skillPath: string): string {
  const resolved = path.resolve(sourceDir, skillPath)
  const resolvedBase = path.resolve(sourceDir)
  if (resolved !== resolvedBase && !resolved.startsWith(resolvedBase + path.sep)) {
    throw new Error(`Skill path escapes source directory: ${skillPath}`)
  }
  return resolved
}

function assertSafeSkillName (name: string): string {
  if (name === '.' || name !== path.basename(name) || name.includes('..') || name.includes(path.sep)) {
    throw new Error(`Invalid skill name: ${name}`)
  }
  return name
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

export async function installSkills (skills: SkillRef[], sourceDir: string): Promise<void> {
  const destDir = getSkillsDir()
  ensureDir(destDir)

  for (const skill of skills) {
    const safeName = assertSafeSkillName(skill.name)
    const srcPath = assertSafeSkillPath(sourceDir, skill.path)
    const destPath = path.join(destDir, safeName)

    try {
      await access(srcPath)
    } catch {
      throw new SkillCopyError(skill.name, new Error(`Source not found: ${srcPath}`))
    }

    try {
      await cp(srcPath, destPath, { recursive: true, force: true })
    } catch (err) {
      throw new SkillCopyError(skill.name, err as Error)
    }
  }
}

export async function uninstallSkills (skills: SkillRef[]): Promise<void> {
  const destDir = getSkillsDir()

  for (const skill of skills) {
    const safeName = assertSafeSkillName(skill.name)
    const destPath = path.join(destDir, safeName)
    try {
      await access(destPath)
      await rm(destPath, { recursive: true, force: true })
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw err
      }
      // Best-effort: ignore missing skills
    }
  }
}
