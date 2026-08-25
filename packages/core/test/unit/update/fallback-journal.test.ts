import { afterEach, beforeEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { beginFallbackJournal, captureFallbackJournalState, commitFallbackJournal, restoreFallbackJournal, trackingDigest } from '../../../src/update/fallback-journal.js'
import { getHarnessSkillsPath } from '../../../src/skills/skill-linker.js'
import { getTrackingFilePath } from '../../../src/utils/path.js'
import type { FallbackTransactionIdentity } from '../../../src/update/types.js'

let home: string
let previousHome: string | undefined
let previousUserProfile: string | undefined

beforeEach(() => {
  home = mkdtempSync(path.join(os.tmpdir(), 'nsolid-plugin-journal-'))
  previousHome = process.env.HOME
  previousUserProfile = process.env.USERPROFILE
  process.env.HOME = home
  process.env.USERPROFILE = home
})

afterEach(() => {
  rmSync(home, { recursive: true, force: true })
  if (previousHome === undefined) delete process.env.HOME
  else process.env.HOME = previousHome
  if (previousUserProfile === undefined) delete process.env.USERPROFILE
  else process.env.USERPROFILE = previousUserProfile
})

describe('fallback journal ownership validation', () => {
  it('refuses rollback paths that are not owned by the snapshotted tracking record', async () => {
    const trackingPath = getTrackingFilePath()
    const skillPath = path.join(home, '.agents', 'skills', 'tracked')
    mkdirSync(skillPath, { recursive: true })
    mkdirSync(path.dirname(trackingPath), { recursive: true })
    writeFileSync(trackingPath, JSON.stringify({
      version: '1.0.0',
      installedAt: new Date().toISOString(),
      harness: 'claude',
      skills: [{ name: 'tracked', path: skillPath, paths: { claude: skillPath }, installedAt: new Date().toISOString(), harnesses: ['claude'] }],
      mcpServers: [],
    }))
    const manifest: FallbackTransactionIdentity = {
      installationId: 'claude:fallback',
      harness: 'claude',
      trackingPath,
      trackingDigest: trackingDigest(trackingPath)!,
      ownedSkillPaths: [skillPath],
      ownedLinkPaths: [path.join(getHarnessSkillsPath('claude'), 'tracked')],
      ownedMcpFields: [],
    }
    const { journal } = await beginFallbackJournal(manifest)
    const victim = path.join(home, 'user-owned.txt')
    writeFileSync(victim, 'keep')
    const malicious = {
      ...journal,
      manifest: { ...journal.manifest, ownedSkillPaths: [...journal.manifest.ownedSkillPaths, victim] },
      entries: [...journal.entries, { path: victim, backup: path.join(journal.snapshotDirectory, 'attacker'), existed: false }],
    }

    assert.equal(await restoreFallbackJournal(malicious), false)
    assert.equal(readFileSync(victim, 'utf8'), 'keep')
  })

  it('restores the snapshotted bytes of owned state after a mutation', async () => {
    const { trackingPath, skillPath, linkPath, manifest, trackingJson } = setupValidFixture()
    let { journal } = await beginFallbackJournal(manifest)
    writeFileSync(path.join(skillPath, 'SKILL.md'), '# mutated\n')
    writeFileSync(linkPath, 'mutated\n')
    writeFileSync(trackingPath, JSON.stringify({ ...JSON.parse(trackingJson), installedAt: 'mutated' }))
    journal = await captureFallbackJournalState(journal)

    assert.equal(await restoreFallbackJournal(journal), true)
    assert.equal(readFileSync(path.join(skillPath, 'SKILL.md'), 'utf8'), '# tracked\n')
    assert.equal(readFileSync(linkPath, 'utf8'), 'link\n')
    assert.equal(readFileSync(trackingPath, 'utf8'), trackingJson)
    assert.equal(existsSync(journal.journalPath), false)
    assert.equal(existsSync(journal.snapshotDirectory), false)
  })

  it('refuses to overwrite state that changed after the authorized mutation snapshot', async () => {
    const { linkPath, manifest } = setupValidFixture()
    let { journal } = await beginFallbackJournal(manifest)
    writeFileSync(linkPath, 'child mutation\n')
    journal = await captureFallbackJournalState(journal)
    writeFileSync(linkPath, 'concurrent user edit\n')

    assert.equal(await restoreFallbackJournal(journal), false)
    assert.equal(readFileSync(linkPath, 'utf8'), 'concurrent user edit\n')
    assert.equal(existsSync(journal.journalPath), true)
    assert.equal(existsSync(journal.snapshotDirectory), true)
  })

  it('rejects a nested user-owned link path whose basename matches the expected link', async () => {
    const { manifest } = setupValidFixture()
    const expectedLink = path.join(getHarnessSkillsPath('claude'), 'tracked')
    const nested = path.join(getHarnessSkillsPath('claude'), 'user-owned', 'tracked')
    mkdirSync(path.dirname(nested), { recursive: true })
    writeFileSync(nested, 'keep')
    const { journal } = await beginFallbackJournal(manifest)
    const malicious = {
      ...journal,
      manifest: { ...journal.manifest, ownedLinkPaths: [nested] },
      entries: journal.entries.map((entry) => path.resolve(entry.path) === path.resolve(expectedLink)
        ? { path: nested, backup: path.join(journal.snapshotDirectory, 'attacker'), existed: false }
        : entry),
    }

    assert.equal(await restoreFallbackJournal(malicious), false)
    assert.equal(readFileSync(nested, 'utf8'), 'keep')
  })

  it('commits a valid journal and removes its journal and snapshot artifacts', async () => {
    const { manifest } = setupValidFixture()
    const { journal } = await beginFallbackJournal(manifest)

    await commitFallbackJournal(journal)
    assert.equal(existsSync(journal.journalPath), false)
    assert.equal(existsSync(journal.snapshotDirectory), false)
  })
})

function setupValidFixture (): { trackingPath: string; skillPath: string; linkPath: string; manifest: FallbackTransactionIdentity; trackingJson: string } {
  const trackingPath = getTrackingFilePath()
  const skillPath = path.join(home, '.agents', 'skills', 'tracked')
  const linkPath = path.join(getHarnessSkillsPath('claude'), 'tracked')
  mkdirSync(skillPath, { recursive: true })
  writeFileSync(path.join(skillPath, 'SKILL.md'), '# tracked\n')
  mkdirSync(path.dirname(trackingPath), { recursive: true })
  const trackingJson = JSON.stringify({
    version: '1.0.0',
    installedAt: new Date().toISOString(),
    harness: 'claude',
    skills: [{ name: 'tracked', path: skillPath, paths: { claude: skillPath }, installedAt: new Date().toISOString(), harnesses: ['claude'] }],
    mcpServers: [],
  })
  writeFileSync(trackingPath, trackingJson)
  mkdirSync(path.dirname(linkPath), { recursive: true })
  writeFileSync(linkPath, 'link\n')
  const manifest: FallbackTransactionIdentity = {
    installationId: 'claude:fallback',
    harness: 'claude',
    trackingPath,
    trackingDigest: trackingDigest(trackingPath)!,
    ownedSkillPaths: [skillPath],
    ownedLinkPaths: [linkPath],
    ownedMcpFields: [],
  }
  return { trackingPath, skillPath, linkPath, manifest, trackingJson }
}
