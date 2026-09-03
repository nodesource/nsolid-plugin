import { afterEach, beforeEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import os from 'node:os'
import path from 'node:path'
import { appendFallbackJournalEntries, applyFallbackEntry, beginFallbackJournal, captureFallbackJournalState, claimFallbackJournalMutation, commitFallbackJournal, fallbackJournalPath, markFallbackJournalMutating, pathDigest, pathKind, recoverFallbackJournal, registerFallbackStage, reloadFallbackJournal, restoreFallbackJournal, trackingDigest } from '../../../src/update/fallback-journal.js'
import { getHarnessSkillsPath } from '../../../src/skills/skill-linker.js'
import { getSkillsDir, getTrackingFilePath } from '../../../src/utils/path.js'
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
      nonce: randomUUID(),
      ownedSkills: [await pathEvidence(skillPath)],
      ownedLinks: [await pathEvidence(path.join(getHarnessSkillsPath('claude'), 'tracked'))],
      ownedMcpFields: [],
      ownedMcpConfigPaths: [path.join(home, '.claude.json')],
      approvedDestinationRoots: [path.join(home, '.agents', 'skills'), getHarnessSkillsPath('claude')],
    }
    const { journal } = await beginFallbackJournal(manifest)
    const victim = path.join(home, 'user-owned.txt')
    writeFileSync(victim, 'keep')
    const malicious = {
      ...journal,
      manifest: { ...journal.manifest, ownedSkills: [...journal.manifest.ownedSkills, await pathEvidence(victim)] },
      entries: [...journal.entries, { path: victim, backup: path.join(journal.snapshotDirectory, 'attacker'), existed: false, kind: 'file' as const }],
    }

    assert.equal(await restoreFallbackJournal(malicious), false)
    assert.equal(readFileSync(victim, 'utf8'), 'keep')
  })

  it('refuses appended new-destination entries outside the approved destination roots', async () => {
    const { manifest } = await setupValidFixture()
    let { journal } = await beginFallbackJournal(manifest)
    const foreign = path.join(home, 'elsewhere', 'added')
    mkdirSync(path.dirname(foreign), { recursive: true })
    writeFileSync(foreign, 'payload')
    const digest = await pathDigest(foreign)
    journal = {
      ...journal,
      entries: [...journal.entries, { path: foreign, existed: true, kind: 'file', digest: digest!, backup: path.join(journal.snapshotDirectory, 'extra'), expectedCurrentDigest: digest! }],
    }
    assert.equal(await restoreFallbackJournal(journal), false)
    assert.equal(readFileSync(foreign, 'utf8'), 'payload')
  })

  it('refuses appended new-destination entries whose basename is not a safe skill name', async () => {
    const { manifest } = await setupValidFixture()
    let { journal } = await beginFallbackJournal(manifest)
    const unsafe = path.join(home, '.agents', 'skills', 'wei..rd')
    const digest = await pathDigest(unsafe)
    journal = {
      ...journal,
      entries: [...journal.entries, { path: unsafe, existed: false, kind: 'missing', expectedCurrentDigest: null, digest }],
    }
    assert.equal(await restoreFallbackJournal(journal), false)
  })

  it('rejects owned skill bytes that change after planning but before journaling', async () => {
    const { manifest, skillPath } = await setupValidFixture()
    writeFileSync(path.join(skillPath, 'SKILL.md'), '# user edit after approval\n')

    await assert.rejects(beginFallbackJournal(manifest), /FALLBACK_TRACKING_DRIFT/)
    assert.equal(existsSync(fallbackJournalPath(manifest.trackingPath)), false)
  })

  it('rejects a user destination that appears before the child appends it', async () => {
    const { manifest } = await setupValidFixture()
    const { journal } = await beginFallbackJournal(manifest)
    const destination = path.join(getSkillsDir(), 'new-skill')
    mkdirSync(destination, { recursive: true })
    writeFileSync(path.join(destination, 'user-file.txt'), 'keep\n')

    await assert.rejects(appendFallbackJournalEntries(journal, [destination]), /UNTRACKED_DESTINATION/)
    assert.equal(readFileSync(path.join(destination, 'user-file.txt'), 'utf8'), 'keep\n')
  })

  it('restores the snapshotted bytes of owned state after a mutation', async () => {
    const { trackingPath, skillPath, linkPath, manifest, trackingJson } = await setupValidFixture()
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
    // No quarantine or stage containers remain beside the owned paths.
    const skillSiblings = readdirSync(path.dirname(skillPath)).filter((name) => name.includes('.nsolid-'))
    const linkSiblings = readdirSync(path.dirname(linkPath)).filter((name) => name.includes('.nsolid-'))
    assert.deepEqual([...skillSiblings, ...linkSiblings], [])
  })

  it('refuses to overwrite state that changed after the authorized mutation snapshot', async () => {
    const { linkPath, manifest } = await setupValidFixture()
    let { journal } = await beginFallbackJournal(manifest)
    writeFileSync(linkPath, 'child mutation\n')
    journal = await captureFallbackJournalState(journal)
    writeFileSync(linkPath, 'concurrent user edit\n')

    assert.equal(await restoreFallbackJournal(journal), false)
    assert.equal(readFileSync(linkPath, 'utf8'), 'concurrent user edit\n')
    assert.equal(existsSync(journal.journalPath), true)
    assert.equal(existsSync(journal.snapshotDirectory), true)
  })

  it('recovers a crash after the swap was applied but before commit', async () => {
    const { trackingPath, skillPath, manifest, trackingJson } = await setupValidFixture()
    let { journal } = await beginFallbackJournal(manifest)
    journal = await markFallbackJournalMutating(journal)
    assert.equal(await claimFallbackJournalMutation(manifest, 2_147_483_647), true)
    const stageDir = mkdtempSync(path.join(path.dirname(skillPath), `.${path.basename(skillPath)}.nsolid-stage-`))
    mkdirSync(path.join(stageDir, 'payload'), { recursive: true })
    writeFileSync(path.join(stageDir, 'payload', 'SKILL.md'), '# new bundle\n')
    journal = await registerFallbackStage(journal, skillPath, { directory: path.join(stageDir, 'payload') })
    journal = await applyFallbackEntry(journal, skillPath)
    assert.equal(readFileSync(path.join(skillPath, 'SKILL.md'), 'utf8'), '# new bundle\n')

    // The mutator PID is gone: the parent recovers the registered state.
    assert.deepEqual(await recoverFallbackJournal(trackingPath, true), { pending: true, recovered: true })
    assert.equal(readFileSync(path.join(skillPath, 'SKILL.md'), 'utf8'), '# tracked\n')
    assert.equal(readFileSync(trackingPath, 'utf8'), trackingJson)
    assert.equal(existsSync(journal.journalPath), false)
  })

  it('recovers a crash in the middle of a swap: target missing, stage intact', async () => {
    const { trackingPath, skillPath, manifest } = await setupValidFixture()
    let { journal } = await beginFallbackJournal(manifest)
    journal = await markFallbackJournalMutating(journal)
    await claimFallbackJournalMutation(manifest, 2_147_483_647)
    const stageDir = mkdtempSync(path.join(path.dirname(skillPath), `.${path.basename(skillPath)}.nsolid-stage-`))
    mkdirSync(path.join(stageDir, 'payload'), { recursive: true })
    writeFileSync(path.join(stageDir, 'payload', 'SKILL.md'), '# new bundle\n')
    journal = await registerFallbackStage(journal, skillPath, { directory: path.join(stageDir, 'payload') })
    // Crash between the quarantine rename and the stage rename: the target is
    // missing while the registered stage is intact.
    rmSync(skillPath, { recursive: true, force: true })

    assert.deepEqual(await recoverFallbackJournal(trackingPath, true), { pending: true, recovered: true })
    assert.equal(readFileSync(path.join(skillPath, 'SKILL.md'), 'utf8'), '# tracked\n')
    assert.equal(existsSync(journal.journalPath), false)
  })

  it('fails closed and preserves artifacts when live bytes are unregistered drift', async () => {
    const { trackingPath, skillPath, manifest } = await setupValidFixture()
    let { journal } = await beginFallbackJournal(manifest)
    journal = await markFallbackJournalMutating(journal)
    await claimFallbackJournalMutation(manifest, 2_147_483_647)
    // The child mutated a path through unregistered means: unknown digest.
    writeFileSync(path.join(skillPath, 'SKILL.md'), '# rogue child write\n')

    assert.deepEqual(await recoverFallbackJournal(trackingPath, true), { pending: true, recovered: false })
    assert.equal(readFileSync(path.join(skillPath, 'SKILL.md'), 'utf8'), '# rogue child write\n')
    assert.equal(existsSync(journal.journalPath), true)
    assert.equal(existsSync(journal.snapshotDirectory), true)
  })

  it('fails closed when a user edits the target after an applied swap', async () => {
    const { trackingPath, skillPath, manifest } = await setupValidFixture()
    let { journal } = await beginFallbackJournal(manifest)
    journal = await markFallbackJournalMutating(journal)
    await claimFallbackJournalMutation(manifest, 2_147_483_647)
    const stageDir = mkdtempSync(path.join(path.dirname(skillPath), `.${path.basename(skillPath)}.nsolid-stage-`))
    mkdirSync(path.join(stageDir, 'payload'), { recursive: true })
    writeFileSync(path.join(stageDir, 'payload', 'SKILL.md'), '# new bundle\n')
    journal = await registerFallbackStage(journal, skillPath, { directory: path.join(stageDir, 'payload') })
    journal = await applyFallbackEntry(journal, skillPath)
    // The user touched the freshly-swapped bytes before recovery ran.
    writeFileSync(path.join(skillPath, 'SKILL.md'), '# user edit\n')

    assert.deepEqual(await recoverFallbackJournal(trackingPath, true), { pending: true, recovered: false })
    assert.equal(readFileSync(path.join(skillPath, 'SKILL.md'), 'utf8'), '# user edit\n')
    assert.equal(existsSync(journal.journalPath), true)
  })

  it('fails closed when the staged payload no longer matches its registered digest', async () => {
    const { skillPath, manifest } = await setupValidFixture()
    let { journal } = await beginFallbackJournal(manifest)
    journal = await markFallbackJournalMutating(journal)
    await claimFallbackJournalMutation(manifest, 2_147_483_647)
    const stageDir = mkdtempSync(path.join(path.dirname(skillPath), `.${path.basename(skillPath)}.nsolid-stage-`))
    mkdirSync(path.join(stageDir, 'payload'), { recursive: true })
    writeFileSync(path.join(stageDir, 'payload', 'SKILL.md'), '# new bundle\n')
    journal = await registerFallbackStage(journal, skillPath, { directory: path.join(stageDir, 'payload') })
    const stageEntry = journal.entries.find((entry) => path.resolve(entry.path) === path.resolve(skillPath))!
    writeFileSync(path.join(stageEntry.stage!, 'SKILL.md'), '# substituted\n')

    await assert.rejects(applyFallbackEntry(journal, skillPath))
  })

  it('fails closed when the snapshotted backup no longer matches the registered digest', async () => {
    const { trackingPath, manifest, trackingJson } = await setupValidFixture()
    let { journal } = await beginFallbackJournal(manifest)
    journal = await markFallbackJournalMutating(journal)
    await claimFallbackJournalMutation(manifest, 2_147_483_647)
    // The tracking backup inside the snapshot directory was tampered with.
    const trackingEntry = journal.entries.find((entry) => path.resolve(entry.path) === path.resolve(trackingPath))!
    writeFileSync(path.join(journal.snapshotDirectory, path.basename(trackingEntry.backup!)), '{}\n')

    assert.deepEqual(await recoverFallbackJournal(trackingPath, true), { pending: true, recovered: false })
    assert.equal(readFileSync(trackingPath, 'utf8'), trackingJson)
    assert.equal(existsSync(journal.journalPath), true)
    assert.equal(existsSync(journal.snapshotDirectory), true)
  })

  it('fails closed when an applied staged replacement is deleted concurrently', async () => {
    const { trackingPath, skillPath, manifest } = await setupValidFixture()
    let { journal } = await beginFallbackJournal(manifest)
    journal = await markFallbackJournalMutating(journal)
    await claimFallbackJournalMutation(manifest, 2_147_483_647)
    const stageDir = mkdtempSync(path.join(path.dirname(skillPath), `.${path.basename(skillPath)}.nsolid-stage-`))
    mkdirSync(path.join(stageDir, 'payload'), { recursive: true })
    writeFileSync(path.join(stageDir, 'payload', 'SKILL.md'), '# new bundle\n')
    journal = await registerFallbackStage(journal, skillPath, { directory: path.join(stageDir, 'payload') })
    journal = await applyFallbackEntry(journal, skillPath)
    // Another process deletes the freshly swapped directory afterwards.
    rmSync(skillPath, { recursive: true, force: true })

    assert.deepEqual(await recoverFallbackJournal(trackingPath, true), { pending: true, recovered: false })
    assert.equal(existsSync(skillPath), false)
    assert.equal(existsSync(journal.journalPath), true)
    assert.equal(existsSync(journal.snapshotDirectory), true)
  })

  it('recovers a deletion crash using the durably persisted quarantine', async () => {
    const { trackingPath, skillPath, manifest, trackingJson } = await setupValidFixture()
    let { journal } = await beginFallbackJournal(manifest)
    journal = await markFallbackJournalMutating(journal)
    await claimFallbackJournalMutation(manifest, 2_147_483_647)
    // Emulate a crash window after the persisted quarantine record but before
    // the applied flag: the on-disk journal explains the missing target.
    const storage = mkdtempSync(path.join(path.dirname(skillPath), `.${path.basename(skillPath)}.nsolid-quarantine-`))
    const quarantinePath = path.join(storage, path.basename(skillPath))
    renameSync(skillPath, quarantinePath)
    const onDisk = JSON.parse(readFileSync(journal.journalPath, 'utf8')) as { entries: Array<{ path: string; quarantine?: string; applied?: boolean }> }
    for (const entry of onDisk.entries) {
      if (path.resolve(entry.path) === path.resolve(skillPath)) entry.quarantine = quarantinePath
    }
    writeFileSync(journal.journalPath, JSON.stringify(onDisk))
    journal = await reloadFallbackJournal(journal)

    assert.deepEqual(await recoverFallbackJournal(trackingPath, true), { pending: true, recovered: true })
    assert.equal(readFileSync(path.join(skillPath, 'SKILL.md'), 'utf8'), '# tracked\n')
    assert.equal(readFileSync(trackingPath, 'utf8'), trackingJson)
    assert.equal(existsSync(journal.journalPath), false)
  })

  it('does not recover while the claimed child process is still alive', async () => {
    const { trackingPath, manifest } = await setupValidFixture()
    let { journal } = await beginFallbackJournal(manifest)
    journal = await markFallbackJournalMutating(journal)
    assert.equal(await claimFallbackJournalMutation(manifest), true)

    assert.deepEqual(await recoverFallbackJournal(trackingPath, true), { pending: true, recovered: false })
    assert.equal(existsSync(journal.journalPath), true)
  })

  it('refuses to claim the mutation without the journal nonce', async () => {
    const { manifest } = await setupValidFixture()
    let { journal } = await beginFallbackJournal(manifest)
    journal = await markFallbackJournalMutating(journal)
    const impostor = { ...manifest, nonce: randomUUID() }
    assert.equal(await claimFallbackJournalMutation(impostor), false)
    assert.equal(await claimFallbackJournalMutation({ ...manifest, nonce: undefined }), false)
    assert.equal(journal.phase, 'mutating')
  })

  it('fails closed on version 1 journals without cleaning their snapshots', async () => {
    const { trackingPath, manifest, skillPath } = await setupValidFixture()
    const legacySnapshot = mkdtempSync(path.join(path.dirname(trackingPath), '.nsolid-plugin-update-'))
    const legacy = {
      version: 1,
      phase: 'mutating',
      manifest: { ...manifest, nonce: undefined },
      journalPath: `${trackingPath}.update-journal.json`,
      snapshotDirectory: legacySnapshot,
      entries: [{ path: skillPath, backup: path.join(legacySnapshot, '0'), existed: true }],
      mutator: { pid: 2_147_483_647, claimedAt: new Date().toISOString() },
    }
    writeFileSync(legacy.journalPath, JSON.stringify(legacy))

    assert.deepEqual(await recoverFallbackJournal(trackingPath, true), { pending: true, recovered: false })
    assert.equal(existsSync(legacy.journalPath), true)
    assert.equal(existsSync(legacySnapshot), true)
    assert.equal(readFileSync(path.join(skillPath, 'SKILL.md'), 'utf8'), '# tracked\n')
  })

  it('rejects a nested user-owned link path whose basename matches the expected link', async () => {
    const { manifest } = await setupValidFixture()
    const expectedLink = path.join(getHarnessSkillsPath('claude'), 'tracked')
    const nested = path.join(getHarnessSkillsPath('claude'), 'user-owned', 'tracked')
    mkdirSync(path.dirname(nested), { recursive: true })
    writeFileSync(nested, 'keep')
    const { journal } = await beginFallbackJournal(manifest)
    const malicious = {
      ...journal,
      manifest: { ...journal.manifest, ownedLinks: [await pathEvidence(nested)] },
      entries: journal.entries.map((entry) => path.resolve(entry.path) === path.resolve(expectedLink)
        ? { path: nested, backup: path.join(journal.snapshotDirectory, 'attacker'), existed: false, kind: 'file' as const }
        : entry),
    }

    assert.equal(await restoreFallbackJournal(malicious), false)
    assert.equal(readFileSync(nested, 'utf8'), 'keep')
  })

  it('commits a valid journal and removes its journal and snapshot artifacts', async () => {
    const { manifest } = await setupValidFixture()
    const { journal } = await beginFallbackJournal(manifest)

    await commitFallbackJournal(journal)
    assert.equal(existsSync(journal.journalPath), false)
    assert.equal(existsSync(journal.snapshotDirectory), false)
    const leftovers = readdirSync(path.dirname(manifest.trackingPath)).filter((name) => name.includes('.nsolid-'))
    assert.deepEqual(leftovers, [])
  })

  it('aborts the swap when the live file drifted after registration', async () => {
    const { linkPath, manifest } = await setupValidFixture()
    let { journal } = await beginFallbackJournal(manifest)
    journal = await registerFallbackStage(journal, linkPath, { bytes: Buffer.from('# new bundle\n') })
    writeFileSync(linkPath, 'concurrent user edit\n')

    await assert.rejects(applyFallbackEntry(journal, linkPath), /drifted after journaling/)
    // The concurrent bytes were never touched and the journal/stage stay recoverable.
    assert.equal(readFileSync(linkPath, 'utf8'), 'concurrent user edit\n')
    assert.equal(existsSync(journal.journalPath), true)
    const reloaded = await reloadFallbackJournal(journal)
    const entry = reloaded.entries.find((candidate) => candidate.path === linkPath)
    assert.ok(entry?.stage)
    assert.equal(readFileSync(entry.stage!, 'utf8'), '# new bundle\n')
  })

  it('aborts the swap when the live directory drifted after registration', async () => {
    const { manifest } = await setupValidFixture()
    let { journal } = await beginFallbackJournal(manifest)
    const dirPath = path.join(getSkillsDir(), 'tracked-dir')
    journal = await appendFallbackJournalEntries(journal, [dirPath])
    mkdirSync(dirPath, { recursive: true })
    writeFileSync(path.join(dirPath, 'SKILL.md'), '# v1\n')
    const stageSource = mkdtempSync(path.join(path.dirname(dirPath), '.stage-src-'))
    mkdirSync(path.join(stageSource, 'payload'), { recursive: true })
    writeFileSync(path.join(stageSource, 'payload', 'SKILL.md'), '# v2\n')
    journal = await registerFallbackStage(journal, dirPath, { directory: path.join(stageSource, 'payload') })
    writeFileSync(path.join(dirPath, 'user-notes.md'), 'user added a file\n')

    await assert.rejects(applyFallbackEntry(journal, dirPath), /drifted after journaling/)
    assert.deepEqual(readdirSync(dirPath).sort(), ['SKILL.md', 'user-notes.md'])
    assert.equal(readFileSync(path.join(dirPath, 'SKILL.md'), 'utf8'), '# v1\n')
    assert.equal(existsSync(journal.journalPath), true)
    rmSync(stageSource, { recursive: true, force: true })
  })

  it('refuses to swap over a missing destination created concurrently', async () => {
    const { manifest } = await setupValidFixture()
    let { journal } = await beginFallbackJournal(manifest)
    const freshPath = path.join(getSkillsDir(), 'fresh-skill')
    journal = await appendFallbackJournalEntries(journal, [freshPath])
    const stageSource = mkdtempSync(path.join(path.dirname(freshPath), '.stage-src-'))
    mkdirSync(path.join(stageSource, 'payload'), { recursive: true })
    writeFileSync(path.join(stageSource, 'payload', 'SKILL.md'), '# fresh\n')
    journal = await registerFallbackStage(journal, freshPath, { directory: path.join(stageSource, 'payload') })
    // A concurrent writer created the destination between journaling and apply.
    mkdirSync(freshPath, { recursive: true })
    writeFileSync(path.join(freshPath, 'user-file.txt'), 'precious\n')

    await assert.rejects(applyFallbackEntry(journal, freshPath), /drifted after journaling/)
    assert.equal(readFileSync(path.join(freshPath, 'user-file.txt'), 'utf8'), 'precious\n')
    assert.equal(existsSync(journal.journalPath), true)
    rmSync(stageSource, { recursive: true, force: true })
  })

  it('fails closed when the snapshot directory points at the tracking directory itself', async () => {
    const { trackingPath, manifest, trackingJson } = await setupValidFixture()
    const { journal } = await beginFallbackJournal(manifest)
    const trackingDir = path.dirname(trackingPath)
    const sibling = path.join(trackingDir, 'sibling.txt')
    writeFileSync(sibling, 'keep')
    const tampered = { ...journal, snapshotDirectory: trackingDir }

    assert.equal(await restoreFallbackJournal(tampered), false)
    const committed = { ...tampered, phase: 'committed' as const }
    writeFileSync(journal.journalPath, JSON.stringify(committed))
    await assert.rejects(commitFallbackJournal(committed))
    assert.deepEqual(await recoverFallbackJournal(trackingPath, true), { pending: true, recovered: false })

    // The tracking directory and its siblings survived every cleanup attempt.
    assert.equal(readFileSync(trackingPath, 'utf8'), trackingJson)
    assert.equal(readFileSync(sibling, 'utf8'), 'keep')
    assert.equal(existsSync(journal.snapshotDirectory), true)
    assert.equal(existsSync(journal.journalPath), true)
  })

  it('fails closed when the snapshot directory is a symlink escaping the tracking directory', { skip: process.platform === 'win32' }, async () => {
    const { trackingPath, manifest } = await setupValidFixture()
    const { journal } = await beginFallbackJournal(manifest)
    const victim = path.join(home, 'victim-dir')
    mkdirSync(victim)
    writeFileSync(path.join(victim, 'keep.txt'), 'keep')
    rmSync(journal.snapshotDirectory, { recursive: true, force: true })
    symlinkSync(victim, journal.snapshotDirectory, 'dir')

    assert.equal(await restoreFallbackJournal(journal), false)
    const committed = { ...journal, phase: 'committed' as const }
    writeFileSync(journal.journalPath, JSON.stringify(committed))
    assert.deepEqual(await recoverFallbackJournal(trackingPath, true), { pending: true, recovered: false })
    await assert.rejects(commitFallbackJournal(journal))

    // Nothing outside the journal was deleted and the journal survives.
    assert.equal(readFileSync(path.join(victim, 'keep.txt'), 'utf8'), 'keep')
    assert.equal(existsSync(journal.journalPath), true)
  })

  it('fails closed when the snapshot directory name does not match the mkdtemp shape', async () => {
    const { trackingPath, manifest } = await setupValidFixture()
    const { journal } = await beginFallbackJournal(manifest)
    const trackingDir = path.dirname(trackingPath)
    const suffixless = { ...journal, snapshotDirectory: path.join(trackingDir, '.nsolid-plugin-update-') }
    const foreign = { ...journal, snapshotDirectory: path.join(trackingDir, '.other-update-abc123') }

    assert.equal(await restoreFallbackJournal(suffixless), false)
    assert.equal(await restoreFallbackJournal(foreign), false)
    writeFileSync(journal.journalPath, JSON.stringify({ ...foreign, phase: 'committed' as const }))
    await assert.rejects(commitFallbackJournal(foreign))
    assert.deepEqual(await recoverFallbackJournal(trackingPath, true), { pending: true, recovered: false })

    // The real snapshot was never cleaned up by the forged journals.
    assert.equal(existsSync(journal.snapshotDirectory), true)
    assert.equal(existsSync(journal.journalPath), true)
  })

  it('accepts a portable mkdtemp suffix containing dot and dash characters', async () => {
    // POSIX mkdtemp only promises suffix characters from the portable filename
    // set, which includes `.` and `-`: a valid snapshot produced by such a
    // libc must still pass validation and restore.
    const { trackingPath, skillPath, linkPath, manifest, trackingJson } = await setupValidFixture()
    const { journal } = await beginFallbackJournal(manifest)
    const renamed = path.join(path.dirname(journal.snapshotDirectory), '.nsolid-plugin-update-a.c-01')
    renameSync(journal.snapshotDirectory, renamed)
    const rebased = {
      ...journal,
      snapshotDirectory: renamed,
      entries: journal.entries.map((entry) => entry.backup === undefined
        ? entry
        : { ...entry, backup: path.join(renamed, path.basename(entry.backup)) }),
    }
    // Persist the rebased journal so later reloads keep the renamed snapshot.
    writeFileSync(journal.journalPath, JSON.stringify(rebased, null, 2) + '\n')
    // The live owned bytes were mutated like a crashed child would leave them.
    writeFileSync(path.join(skillPath, 'SKILL.md'), '# mutated\n')
    writeFileSync(linkPath, 'mutated\n')
    writeFileSync(trackingPath, JSON.stringify({ ...JSON.parse(trackingJson), installedAt: 'mutated' }))
    const captured = await captureFallbackJournalState(rebased)

    assert.equal(await restoreFallbackJournal(captured), true)
    assert.equal(readFileSync(path.join(skillPath, 'SKILL.md'), 'utf8'), '# tracked\n')
    assert.equal(readFileSync(linkPath, 'utf8'), 'link\n')
    assert.equal(readFileSync(trackingPath, 'utf8'), trackingJson)
    assert.equal(existsSync(rebased.journalPath), false)
    assert.equal(existsSync(renamed), false)
  })

  it('aborts the restore without touching live paths when a non-tracking backup was tampered with', async () => {
    const { skillPath, manifest } = await setupValidFixture()
    const { journal } = await beginFallbackJournal(manifest)
    const skillEntry = journal.entries.find((entry) => path.resolve(entry.path) === path.resolve(skillPath))!
    writeFileSync(path.join(skillEntry.backup!, 'SKILL.md'), '# tampered\n')

    assert.equal(await restoreFallbackJournal(journal), false)
    // The live skill still holds its pre-restore bytes, not the tampered backup.
    assert.equal(readFileSync(path.join(skillPath, 'SKILL.md'), 'utf8'), '# tracked\n')
    assert.equal(existsSync(journal.journalPath), true)
    assert.equal(existsSync(journal.snapshotDirectory), true)
  })
})

async function setupValidFixture (): Promise<{ trackingPath: string; skillPath: string; linkPath: string; manifest: FallbackTransactionIdentity; trackingJson: string }> {
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
    nonce: randomUUID(),
    ownedSkills: [await pathEvidence(skillPath)],
    ownedLinks: [await pathEvidence(linkPath)],
    ownedMcpFields: [],
    ownedMcpConfigPaths: [path.join(home, '.claude.json')],
    approvedDestinationRoots: [path.join(home, '.agents', 'skills'), getHarnessSkillsPath('claude')],
  }
  return { trackingPath, skillPath, linkPath, manifest, trackingJson }
}

async function pathEvidence (target: string) {
  const kind = await pathKind(target)
  const digest = kind === 'missing' ? undefined : await pathDigest(target)
  return { path: path.resolve(target), kind, digest }
}
