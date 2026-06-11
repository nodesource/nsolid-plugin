import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { SkillRef } from '../../../src/types.js'

let tmpDir: string
let originalHome: string | undefined

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'nsolid-test-'))
  originalHome = process.env.HOME
  process.env.HOME = tmpDir
})

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true })
  if (originalHome !== undefined) {
    process.env.HOME = originalHome
  } else {
    delete process.env.HOME
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

  it('allows skill.path resolving to source directory itself', async () => {
    const { installSkills } = await import('../../../src/skills/skill-copier.js')
    const sourceDir = join(tmpDir, 'source')
    mkdirSync(sourceDir, { recursive: true })
    writeFileSync(join(sourceDir, 'SKILL.md'), '# test')

    const skill: SkillRef = {
      name: 'ns-test',
      path: '.',
      description: 'test'
    }

    await assert.doesNotReject(
      installSkills([skill], sourceDir)
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
    const skillDir = join(sourceDir, 'skills', '.')
    mkdirSync(skillDir, { recursive: true })
    writeFileSync(join(skillDir, 'SKILL.md'), '# test')

    const invalidSkill: SkillRef = {
      name: '.',
      path: 'skills/.',
      description: 'test'
    }

    await assert.rejects(
      installSkills([invalidSkill], sourceDir),
      /Invalid skill name/
    )
  })
})

describe('uninstallSkills error handling', () => {
  it('throws on permission errors, not ENOENT', async () => {
    const { installSkills, uninstallSkills } = await import('../../../src/skills/skill-copier.js')
    const sourceDir = join(tmpDir, 'source')
    mkdirSync(sourceDir, { recursive: true })
    const skillDir = join(sourceDir, 'skills', 'ns-test')
    mkdirSync(skillDir, { recursive: true })
    writeFileSync(join(skillDir, 'SKILL.md'), '# test')

    await installSkills([{ name: 'ns-test', path: 'skills/ns-test', description: 'test' }], sourceDir)

    // Make directory read-only to simulate permission error
    const destDir = join(tmpDir, '.agents', 'skills', 'ns-test')
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
