import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { join, isAbsolute } from 'node:path'
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
  }
})

const skills: SkillRef[] = [
  { name: 'ns-analyze-cpu', path: 'skills/ns-analyze-cpu', description: 'CPU analysis' },
  { name: 'ns-analyze-memory', path: 'skills/ns-analyze-memory', description: 'Memory analysis' },
]

describe('readTrackingFile', () => {
  it('returns null when file does not exist', async () => {
    const { readTrackingFile } = await import('../../../src/skills/skill-tracker.js')

    assert.strictEqual(await readTrackingFile(), null)
  })

  it('returns null for corrupted file', async () => {
    const { readTrackingFile } = await import('../../../src/skills/skill-tracker.js')
    const { mkdirSync } = await import('node:fs')
    const { getAgentsDir, getTrackingFilePath } = await import('../../../src/utils/path.js')

    mkdirSync(getAgentsDir(), { recursive: true })
    writeFileSync(getTrackingFilePath(), 'not valid json')

    assert.strictEqual(await readTrackingFile(), null)
  })
})

describe('addTrackedSkills', () => {
  it('creates tracking file with skills', async () => {
    const { addTrackedSkills, readTrackingFile } = await import('../../../src/skills/skill-tracker.js')

    await addTrackedSkills(skills, 'claude')

    const tracking = await readTrackingFile()
    assert.notStrictEqual(tracking, null)
    assert.strictEqual(tracking!.skills.length, 2)
    assert.strictEqual(tracking!.skills[0].name, 'ns-analyze-cpu')
    assert.deepStrictEqual(tracking!.skills[0].harnesses, ['claude'])
    assert.strictEqual(tracking!.harness, 'claude')
  })

  it('adds harness to existing skill entry', async () => {
    const { addTrackedSkills, readTrackingFile } = await import('../../../src/skills/skill-tracker.js')

    await addTrackedSkills(skills, 'claude')
    await addTrackedSkills([skills[0]], 'codex')

    const tracking = await readTrackingFile()
    const entry = tracking!.skills.find((s) => s.name === 'ns-analyze-cpu')
    assert.deepStrictEqual(entry!.harnesses, ['claude', 'codex'])
  })

  it('does not duplicate harness entries', async () => {
    const { addTrackedSkills, readTrackingFile } = await import('../../../src/skills/skill-tracker.js')

    await addTrackedSkills(skills, 'claude')
    await addTrackedSkills(skills, 'claude')

    const tracking = await readTrackingFile()
    assert.deepStrictEqual(tracking!.skills[0].harnesses, ['claude'])
  })

  it('stores normalized absolute paths', async () => {
    const { addTrackedSkills, readTrackingFile } = await import('../../../src/skills/skill-tracker.js')

    await addTrackedSkills([skills[0]], 'claude')

    const tracking = await readTrackingFile()
    const entry = tracking!.skills[0]
    assert.ok(isAbsolute(entry.path), `expected absolute path, got ${entry.path}`)
    assert.ok(entry.path.includes('ns-analyze-cpu'))
  })

  it('stores ISO8601 timestamps', async () => {
    const { addTrackedSkills, readTrackingFile } = await import('../../../src/skills/skill-tracker.js')

    await addTrackedSkills([skills[0]], 'claude')

    const tracking = await readTrackingFile()
    const entry = tracking!.skills[0]
    assert.strictEqual(new Date(entry.installedAt).toISOString(), entry.installedAt)
  })
})

describe('removeTrackedSkills', () => {
  it('removes harness from entry when harness specified', async () => {
    const { addTrackedSkills, removeTrackedSkills, readTrackingFile } = await import('../../../src/skills/skill-tracker.js')

    await addTrackedSkills([skills[0]], 'claude')
    await addTrackedSkills([skills[0]], 'codex')
    await removeTrackedSkills([skills[0]], 'claude')

    const tracking = await readTrackingFile()
    const entry = tracking!.skills.find((s) => s.name === 'ns-analyze-cpu')
    assert.deepStrictEqual(entry!.harnesses, ['codex'])
  })

  it('removes entire entry when last harness removed', async () => {
    const { addTrackedSkills, removeTrackedSkills, readTrackingFile } = await import('../../../src/skills/skill-tracker.js')

    await addTrackedSkills([skills[0]], 'claude')
    await removeTrackedSkills([skills[0]], 'claude')

    assert.strictEqual(await readTrackingFile(), null)
  })

  it('removes entire entry when no harness specified', async () => {
    const { addTrackedSkills, removeTrackedSkills, readTrackingFile } = await import('../../../src/skills/skill-tracker.js')

    await addTrackedSkills(skills, 'claude')
    await removeTrackedSkills([skills[0]])

    const tracking = await readTrackingFile()
    assert.strictEqual(tracking!.skills.length, 1)
    assert.strictEqual(tracking!.skills[0].name, 'ns-analyze-memory')
  })

  it('deletes file when skills and mcpServers are both empty', async () => {
    const { addTrackedSkills, removeTrackedSkills, readTrackingFile } = await import('../../../src/skills/skill-tracker.js')
    const { getTrackingFilePath } = await import('../../../src/utils/path.js')

    await addTrackedSkills([skills[0]], 'claude')
    await removeTrackedSkills([skills[0]], 'claude')

    assert.ok(!existsSync(getTrackingFilePath()))
    assert.strictEqual(await readTrackingFile(), null)
  })

  it('does nothing when tracking file missing', async () => {
    const { removeTrackedSkills } = await import('../../../src/skills/skill-tracker.js')

    assert.strictEqual(await removeTrackedSkills(skills, 'claude'), undefined)
  })
})

describe('listTrackedSkills', () => {
  it('returns empty array when no tracking file', async () => {
    const { listTrackedSkills } = await import('../../../src/skills/skill-tracker.js')

    assert.deepStrictEqual(await listTrackedSkills(), [])
  })

  it('returns tracked skills', async () => {
    const { addTrackedSkills, listTrackedSkills } = await import('../../../src/skills/skill-tracker.js')

    await addTrackedSkills(skills, 'claude')

    const listed = await listTrackedSkills()
    assert.strictEqual(listed.length, 2)
    assert.deepStrictEqual(listed.map((s) => s.name), ['ns-analyze-cpu', 'ns-analyze-memory'])
  })
})
