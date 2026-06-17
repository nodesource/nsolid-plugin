import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync, readFileSync, symlinkSync } from 'node:fs'
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
]

function setupSkillSource (): void {
  const skillDir = join(tmpDir, '.agents', 'skills', 'ns-analyze-cpu')
  mkdirSync(skillDir, { recursive: true })
  writeFileSync(join(skillDir, 'SKILL.md'), '# ns-analyze-cpu')
}

describe('linkSkillsToHarness', () => {
  it('creates symlink on first link (status: created)', async () => {
    const { linkSkillsToHarness } = await import('../../../src/skills/skill-linker.js')
    setupSkillSource()

    const results = await linkSkillsToHarness('claude', skills)

    assert.strictEqual(results.length, 1)
    assert.strictEqual(results[0].status, 'created')

    const harnessDir = join(tmpDir, '.claude', 'skills', 'ns-analyze-cpu')
    assert.ok(existsSync(harnessDir))
  })

  it('skips existing correct symlink (status: skipped)', async () => {
    const { linkSkillsToHarness } = await import('../../../src/skills/skill-linker.js')
    setupSkillSource()

    await linkSkillsToHarness('claude', skills)
    const results = await linkSkillsToHarness('claude', skills)

    assert.strictEqual(results[0].status, 'skipped')
  })

  it('replaces broken symlink (status: replaced)', async () => {
    const { linkSkillsToHarness } = await import('../../../src/skills/skill-linker.js')
    setupSkillSource()

    const harnessDir = join(tmpDir, '.claude', 'skills')
    mkdirSync(harnessDir, { recursive: true })
    symlinkSync(join(tmpDir, 'nonexistent'), join(harnessDir, 'ns-analyze-cpu'), 'dir')

    const results = await linkSkillsToHarness('claude', skills)

    assert.strictEqual(results[0].status, 'replaced')
  })

  it('replaces symlink pointing elsewhere (status: replaced)', async () => {
    const { linkSkillsToHarness } = await import('../../../src/skills/skill-linker.js')
    setupSkillSource()

    const harnessDir = join(tmpDir, '.claude', 'skills')
    mkdirSync(harnessDir, { recursive: true })
    const otherSource = join(tmpDir, 'other', 'ns-analyze-cpu')
    mkdirSync(otherSource, { recursive: true })
    symlinkSync(otherSource, join(harnessDir, 'ns-analyze-cpu'), 'dir')

    const results = await linkSkillsToHarness('claude', skills)

    assert.strictEqual(results[0].status, 'replaced')
  })

  it('backs up existing directory (status: backed-up)', async () => {
    const { linkSkillsToHarness } = await import('../../../src/skills/skill-linker.js')
    setupSkillSource()

    const harnessDir = join(tmpDir, '.claude', 'skills')
    mkdirSync(join(harnessDir, 'ns-analyze-cpu'), { recursive: true })
    writeFileSync(join(harnessDir, 'ns-analyze-cpu', 'SKILL.md'), 'old')

    const results = await linkSkillsToHarness('claude', skills)

    assert.strictEqual(results[0].status, 'backed-up')
    assert.ok(existsSync(join(harnessDir, 'ns-analyze-cpu', 'SKILL.md')))
    assert.ok(readFileSync(join(harnessDir, 'ns-analyze-cpu', 'SKILL.md'), 'utf-8').includes('ns-analyze-cpu'))
  })

  it('copies for pi agent (no symlink)', async () => {
    const { linkSkillsToHarness } = await import('../../../src/skills/skill-linker.js')
    setupSkillSource()

    const results = await linkSkillsToHarness('pi', skills)

    assert.strictEqual(results[0].status, 'created')

    const harnessDir = join(tmpDir, '.pi', 'agent', 'skills', 'ns-analyze-cpu')
    assert.ok(existsSync(harnessDir))
    assert.ok(readFileSync(join(harnessDir, 'SKILL.md'), 'utf-8').includes('ns-analyze-cpu'))
  })
})

describe('unlinkSkillsFromHarness', () => {
  it('removes symlink from harness', async () => {
    const { linkSkillsToHarness, unlinkSkillsFromHarness } = await import('../../../src/skills/skill-linker.js')
    setupSkillSource()

    await linkSkillsToHarness('claude', skills)
    const harnessDir = join(tmpDir, '.claude', 'skills', 'ns-analyze-cpu')
    assert.ok(existsSync(harnessDir))

    await unlinkSkillsFromHarness('claude', skills)
    assert.ok(!existsSync(harnessDir))
  })

  it('does not throw for missing skills', async () => {
    const { unlinkSkillsFromHarness } = await import('../../../src/skills/skill-linker.js')

    assert.strictEqual(await unlinkSkillsFromHarness('claude', skills), undefined)
  })
})

describe('assertSafeSkillName', () => {
  it('rejects "." (would rename/delete entire harness skills dir)', async () => {
    const { assertSafeSkillName } = await import('../../../src/utils/skill-name.js')
    assert.throws(() => assertSafeSkillName('.'))
  })

  it('rejects ".."', async () => {
    const { assertSafeSkillName } = await import('../../../src/utils/skill-name.js')
    assert.throws(() => assertSafeSkillName('..'))
  })

  it('rejects empty string', async () => {
    const { assertSafeSkillName } = await import('../../../src/utils/skill-name.js')
    assert.throws(() => assertSafeSkillName(''))
  })

  it('rejects names containing "/"', async () => {
    const { assertSafeSkillName } = await import('../../../src/utils/skill-name.js')
    assert.throws(() => assertSafeSkillName('foo/bar'))
  })

  it('rejects absolute paths', async () => {
    const { assertSafeSkillName } = await import('../../../src/utils/skill-name.js')
    assert.throws(() => assertSafeSkillName('/etc/passwd'))
  })

  it('accepts valid skill names', async () => {
    const { assertSafeSkillName } = await import('../../../src/utils/skill-name.js')
    assert.strictEqual(assertSafeSkillName('ns-analyze-cpu'), 'ns-analyze-cpu')
    assert.strictEqual(assertSafeSkillName('my-skill_v2'), 'my-skill_v2')
  })
})
