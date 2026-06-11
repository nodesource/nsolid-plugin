import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs'
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
  }
})

function setupSkillSource (): void {
  const skillDir = join(tmpDir, '.agents', 'skills', 'ns-analyze-cpu')
  mkdirSync(skillDir, { recursive: true })
  writeFileSync(join(skillDir, 'SKILL.md'), '# ns-analyze-cpu')
}

describe('linkSkillsToHarness security', () => {
  it('rejects path traversal in skill.name', async () => {
    const { linkSkillsToHarness } = await import('../../../src/skills/skill-linker.js')
    setupSkillSource()

    const maliciousSkill: SkillRef = {
      name: '../escaped',
      path: 'skills/ns-analyze-cpu',
      description: 'test'
    }

    await assert.rejects(
      linkSkillsToHarness('claude', [maliciousSkill]),
      /Invalid skill name/
    )
  })
})

describe('unlinkSkillsFromHarness error handling', () => {
  it('does not throw on ENOENT errors', async () => {
    const { unlinkSkillsFromHarness } = await import('../../../src/skills/skill-linker.js')

    // Create a non-existent skill name to trigger an error path
    // The function should NOT throw for ENOENT (missing skill)
    await assert.doesNotReject(
      unlinkSkillsFromHarness('claude', [{ name: 'nonexistent-skill', path: 'skills/none', description: 'test' }])
    )
  })
})

describe('alwaysCopy behavior', () => {
  it('copies for pi agent (no symlink)', async () => {
    const { linkSkillsToHarness } = await import('../../../src/skills/skill-linker.js')
    setupSkillSource()

    const results = await linkSkillsToHarness('pi', [{ name: 'ns-analyze-cpu', path: 'skills/ns-analyze-cpu', description: 'test' }])
    assert.strictEqual(results[0].status, 'created')

    const harnessDir = join(tmpDir, '.pi', 'agent', 'skills', 'ns-analyze-cpu')
    assert.ok(existsSync(harnessDir))
    assert.ok(readFileSync(join(harnessDir, 'SKILL.md'), 'utf-8').includes('ns-analyze-cpu'))
  })
})
