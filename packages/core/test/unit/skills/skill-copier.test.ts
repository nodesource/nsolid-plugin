import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs'
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
  } else {
    delete process.env.HOME
  }
  if (originalUserProfile !== undefined) {
    process.env.USERPROFILE = originalUserProfile
  } else {
    delete process.env.USERPROFILE
  }
})

const skills: SkillRef[] = [
  { name: 'ns-analyze-cpu', path: 'skills/ns-analyze-cpu', description: 'CPU analysis' },
  { name: 'ns-analyze-memory', path: 'skills/ns-analyze-memory', description: 'Memory analysis' },
]

function createSourceSkills (sourceDir: string): void {
  for (const skill of skills) {
    const skillDir = join(sourceDir, skill.path)
    mkdirSync(skillDir, { recursive: true })
    writeFileSync(join(skillDir, 'SKILL.md'), `# ${skill.name}\n${skill.description}`)
  }
}

describe('installSkills', () => {
  it('copies skills to ~/.agents/skills/', async () => {
    const { installSkills } = await import('../../../src/skills/skill-copier.js')
    const sourceDir = join(tmpDir, 'source')
    mkdirSync(sourceDir, { recursive: true })
    createSourceSkills(sourceDir)

    await installSkills(skills, sourceDir)

    const skillDir = join(tmpDir, '.agents', 'skills', 'ns-analyze-cpu')
    assert.ok(existsSync(skillDir))
    assert.ok(existsSync(join(skillDir, 'SKILL.md')))
    assert.ok(readFileSync(join(skillDir, 'SKILL.md'), 'utf-8').includes('ns-analyze-cpu'))
  })

  it('overwrites existing skills', async () => {
    const { installSkills } = await import('../../../src/skills/skill-copier.js')
    const sourceDir = join(tmpDir, 'source')
    mkdirSync(sourceDir, { recursive: true })
    createSourceSkills(sourceDir)

    await installSkills([skills[0]], sourceDir)

    const skillDir = join(tmpDir, '.agents', 'skills', 'ns-analyze-cpu')
    writeFileSync(join(skillDir, 'SKILL.md'), 'old content')

    await installSkills([skills[0]], sourceDir)

    assert.ok(readFileSync(join(skillDir, 'SKILL.md'), 'utf-8').includes('ns-analyze-cpu'))
  })

  it('throws SkillCopyError for missing source', async () => {
    const { installSkills, SkillCopyError } = await import('../../../src/skills/skill-copier.js')

    await assert.rejects(installSkills(skills, join(tmpDir, 'nonexistent')), SkillCopyError)
  })
})

describe('uninstallSkills', () => {
  it('removes skills from ~/.agents/skills/', async () => {
    const { installSkills, uninstallSkills } = await import('../../../src/skills/skill-copier.js')
    const sourceDir = join(tmpDir, 'source')
    mkdirSync(sourceDir, { recursive: true })
    createSourceSkills(sourceDir)

    await installSkills(skills, sourceDir)
    const skillDir = join(tmpDir, '.agents', 'skills', 'ns-analyze-cpu')
    assert.ok(existsSync(skillDir))

    await uninstallSkills(skills)
    assert.ok(!existsSync(skillDir))
  })

  it('does not throw for missing skills', async () => {
    const { uninstallSkills } = await import('../../../src/skills/skill-copier.js')

    assert.strictEqual(await uninstallSkills(skills), undefined)
  })
})
