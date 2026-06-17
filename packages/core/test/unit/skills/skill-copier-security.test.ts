import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { SkillRef } from '../../../src/types.js'

let tmpDir: string
let originalHome: string | undefined

let originalUserProfile: string | undefined
beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'nsolid-test-'))
  originalHome = process.env.HOME
  originalUserProfile = process.env.USERPROFILE
  process.env.HOME = tmpDir
  process.env.USERPROFILE = tmpDir
})

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true })
  if (originalHome !== undefined) {
    process.env.HOME = originalHome
    process.env.USERPROFILE = originalUserProfile
  } else {
    delete process.env.HOME
    delete process.env.USERPROFILE
  }
})

describe('installSkills security', () => {
  it('rejects path traversal in skill.path', async () => {
    const { installSkills } = await import('../../../src/skills/skill-copier.js')
    const sourceDir = join(tmpDir, 'source')
    mkdirSync(sourceDir, { recursive: true })
    writeFileSync(join(tmpDir, 'secret.txt'), 'sensitive')

    const maliciousSkill: SkillRef = {
      name: 'ns-test',
      path: '../secret.txt',
      description: 'test'
    }

    await assert.rejects(
      installSkills([maliciousSkill], sourceDir),
      /Skill path escapes source directory/
    )
  })

  it('rejects path traversal in skill.name', async () => {
    const { installSkills } = await import('../../../src/skills/skill-copier.js')
    const sourceDir = join(tmpDir, 'source')
    mkdirSync(sourceDir, { recursive: true })
    const skillDir = join(sourceDir, 'skills', 'ns-test')
    mkdirSync(skillDir, { recursive: true })
    writeFileSync(join(skillDir, 'SKILL.md'), '# test')

    const maliciousSkill: SkillRef = {
      name: '../escaped',
      path: 'skills/ns-test',
      description: 'test'
    }

    await assert.rejects(
      installSkills([maliciousSkill], sourceDir),
      /Invalid skill name/
    )
  })

  it('rejects dot as skill name', async () => {
    const { installSkills } = await import('../../../src/skills/skill-copier.js')
    const sourceDir = join(tmpDir, 'source')
    mkdirSync(sourceDir, { recursive: true })

    const maliciousSkill: SkillRef = {
      name: '.',
      path: '.',
      description: 'test'
    }

    await assert.rejects(
      installSkills([maliciousSkill], sourceDir),
      /Invalid skill name/
    )
  })

  it('rejects empty string as skill name', async () => {
    const { installSkills } = await import('../../../src/skills/skill-copier.js')
    const sourceDir = join(tmpDir, 'source')
    mkdirSync(sourceDir, { recursive: true })

    const maliciousSkill: SkillRef = {
      name: '',
      path: '.',
      description: 'test'
    }

    await assert.rejects(
      installSkills([maliciousSkill], sourceDir),
      /Invalid skill name/
    )
  })

  it('rejects double-dot as skill name', async () => {
    const { installSkills } = await import('../../../src/skills/skill-copier.js')
    const sourceDir = join(tmpDir, 'source')
    mkdirSync(sourceDir, { recursive: true })

    const maliciousSkill: SkillRef = {
      name: '..',
      path: '.',
      description: 'test'
    }

    await assert.rejects(
      installSkills([maliciousSkill], sourceDir),
      /Invalid skill name/
    )
  })

  it('allows valid paths when sourceDir is root', async () => {
    const { installSkills } = await import('../../../src/skills/skill-copier.js')

    // Create a skill directory at root level (in tmpDir to avoid actual root)
    const rootDir = join(tmpDir, 'root')
    mkdirSync(rootDir, { recursive: true })
    const skillDir = join(rootDir, 'skills', 'ns-test')
    mkdirSync(skillDir, { recursive: true })
    writeFileSync(join(skillDir, 'SKILL.md'), '# test')

    const validSkill: SkillRef = {
      name: 'ns-test',
      path: 'skills/ns-test',
      description: 'test'
    }

    // Should not throw
    await installSkills([validSkill], rootDir)

    // Verify skill was installed
    const destDir = join(tmpDir, '.agents', 'skills', 'ns-test')
    assert.ok(existsSync(destDir))
  })
})

describe('uninstallSkills error handling', () => {
  it('throws on permission errors, not ENOENT', {
    skip: process.platform === 'win32'
      ? 'POSIX chmod permission simulation is not reliable on Windows'
      : false
  }, async () => {
    const { installSkills, uninstallSkills } = await import('../../../src/skills/skill-copier.js')
    const sourceDir = join(tmpDir, 'source')
    mkdirSync(sourceDir, { recursive: true })
    const skillDir = join(sourceDir, 'skills', 'ns-test')
    mkdirSync(skillDir, { recursive: true })
    writeFileSync(join(skillDir, 'SKILL.md'), '# test')

    await installSkills([{ name: 'ns-test', path: 'skills/ns-test', description: 'test' }], sourceDir)

    // Make directory read-only to simulate permission error.
    // This relies on POSIX chmod semantics and is skipped on Windows above.
    const destDir = join(tmpDir, '.agents', 'skills', 'ns-test')
    assert.ok(existsSync(destDir), 'expected skill to be installed before chmod')
    const { chmodSync } = await import('node:fs')
    chmodSync(destDir, 0o555)

    try {
      await assert.rejects(
        uninstallSkills([{ name: 'ns-test', path: 'skills/ns-test', description: 'test' }]),
        (err: Error) => (err as NodeJS.ErrnoException).code !== 'ENOENT'
      )
    } finally {
      chmodSync(destDir, 0o755)
    }
  })
})
