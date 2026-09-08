import { afterEach, beforeEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { closeSync, cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, realpathSync, readdirSync, renameSync, rmSync, symlinkSync, writeFileSync, openSync } from 'node:fs'
import { spawn, type ChildProcess } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import os from 'node:os'
import path from 'node:path'
import { applyFallbackEntry, beginFallbackJournal, canonicalJsonString, claimFallbackJournalMutation, clearFallbackFrontierPublicationStateForTests, commitFallbackJournal, fallbackJournalPath, inspectFallbackJournal, manifestDigestOf, markFallbackJournalMutating, pathDigest, pathKind, publishedFallbackFrontiers, reclaimFallbackJournalMutation, recoverFallbackJournal, recoverFallbackJournalMutation, registerFallbackFrontierStage, registerFallbackStage, reloadFallbackJournal, restoreFallbackJournal, setFallbackArtifactSwapSeamForTests, setFallbackFrontierPublicationSeamForTests, setFallbackFrontierRollbackSeamForTests, trackingDigest, type FallbackJournalHandle } from '../../../src/update/fallback-journal.js'
import { assertFallbackFrontierEvidenceList, compareUtf8, FallbackFrontierError } from '../../../src/update/fallback-frontier.js'
import { getHarnessSkillsPath } from '../../../src/skills/skill-linker.js'
import { getSkillsDir, getTrackingFilePath } from '../../../src/utils/path.js'
import { createCanonicalTempRoot } from '../../helpers/canonical-temp-root.js'
import { FALLBACK_PROTOCOL_VERSION, type FallbackAnchorIdentity, type FallbackFrontierEvidence, type FallbackTransactionIdentity } from '../../../src/update/types.js'

let home: string
let previousHome: string | undefined
let previousUserProfile: string | undefined

beforeEach(() => {
  home = createCanonicalTempRoot('nsolid-plugin-journal-')
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

// --- Live-process fixture helpers -------------------------------------------------
// The historical fixtures parsed the FIRST stdout chunk of a spawned child with
// parseInt and then read /proc/<parsed>/stat. Whenever that chunk was not a
// bare integer (banner text, fragmented output, runtime-specific formatting)
// the parsed value was NaN or truncated and the /proc read failed with
// ENOENT /proc/NaN/stat, failing fixture construction instead of exercising
// the production behavior under test. The helpers below own a child's full
// lifecycle instead: the pid comes from child.pid (validated after the spawn
// event), the Linux starttime identity is read exactly once with no polling
// or retries, and termination is awaited under a bounded deadline (a truthy
// kill() return only means the signal was sent, not that the child exited).

const MUTATOR_CHILD_TTL_MS = 30_000
const CHILD_SPAWN_DEADLINE_MS = 10_000
const CHILD_STOP_DEADLINE_MS = 5_000

interface LiveProcessFixture {
  child: ChildProcess
  pid: number
  startIdentity: string
  stop: () => Promise<void>
}

function readStatStartIdentity (stat: string, expectedPid: number): string {
  // Field 22 of /proc/<pid>/stat is starttime. comm may itself contain ') ',
  // so split after the LAST ')': the remaining fields start at field 3 (state),
  // which puts starttime at index 22 - 3 = 19. Read exactly once — no polling,
  // no retries — so a vanished or malformed identity fails the fixture
  // explicitly instead of silently sampling whatever process later reused the
  // pid.
  const closeParen = stat.lastIndexOf(')')
  const afterComm = closeParen === -1 ? '' : stat.slice(closeParen + 1).trim()
  const fields = afterComm.split(' ')
  const recordedPid = Number.parseInt(stat, 10)
  const starttime = fields[19]
  if (!Number.isSafeInteger(recordedPid) || recordedPid !== expectedPid || starttime === undefined || !/^\d+$/.test(starttime)) {
    throw new Error(`malformed or vanished /proc/${expectedPid}/stat identity: ${JSON.stringify(stat.slice(0, 64))}`)
  }
  return starttime
}

async function terminateFixtureChild (child: ChildProcess, onError: (error: Error) => void): Promise<void> {
  // A failed spawn has no pid and nothing to terminate (some runtimes set a
  // negative exitCode, others may leave it null); an already-exited child
  // needs only listener disposal. Both resolve immediately instead of
  // attempting a bogus kill or waiting out the stop deadline.
  if (child.pid === undefined || child.exitCode !== null || child.signalCode !== null) {
    child.removeListener('error', onError)
    return
  }
  // Named listener references: only the listeners this helper attaches are
  // removed — no broad removeAllListeners(), which would also strip unrelated
  // runtime-installed stream listeners and does not express ownership.
  let onExit: () => void = () => {}
  let onStopError: (error: Error) => void = () => {}
  const exited = new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`fixture child ${String(child.pid)} did not exit within ${CHILD_STOP_DEADLINE_MS}ms of SIGKILL`)), CHILD_STOP_DEADLINE_MS)
    onExit = () => { clearTimeout(timer); resolve() }
    onStopError = (error: Error) => { clearTimeout(timer); reject(error) }
    child.once('exit', onExit)
    child.once('error', onStopError)
  })
  child.kill('SIGKILL')
  try {
    await exited
  } finally {
    child.removeListener('exit', onExit)
    child.removeListener('error', onStopError)
    child.removeListener('error', onError)
  }
}

async function spawnLiveProcessFixture (childArgv?: string[], statPathFor?: (pid: number) => string): Promise<LiveProcessFixture> {
  const argv = childArgv ?? [process.execPath, '-e', `setTimeout(() => {}, ${MUTATOR_CHILD_TTL_MS})`]
  const statPath = statPathFor ?? ((pid: number) => `/proc/${pid}/stat`)
  // No stdout pid protocol: the fixtures need a live process with a Linux
  // starttime, not a JavaScript readiness handshake. 'spawn' confirms process
  // creation, not execution of the child's code, and Linux starttime survives
  // exec, so no extra handshake is required.
  const child = spawn(argv[0], argv.slice(1), { stdio: 'ignore' })
  // Persistent `on` error listener for the child's lifetime (removed in
  // stop()) so a late error event is observed instead of crashing the test
  // runner; a once-listener would stop observing after the first error.
  let childError: Error | null = null
  const onError = (error: Error) => { childError = error }
  child.on('error', onError)
  // Ownership starts at creation: stop() exists BEFORE the spawn event is
  // awaited, so a spawn timeout or spawn error terminates (or disposes) the
  // child instead of leaking it. Cached, so repeated and concurrent calls
  // share one bounded termination.
  let exitPromise: Promise<void> | null = null
  const stop = (): Promise<void> => {
    if (exitPromise === null) exitPromise = terminateFixtureChild(child, onError)
    return exitPromise
  }
  // Every setup failure terminates the owned child and surfaces BOTH the
  // original diagnostic and any cleanup failure — cleanup errors are never
  // swallowed.
  const failWithCleanup = async (setupError: Error): Promise<Error> => {
    let cleanupNote = ''
    try {
      await stop()
    } catch (cleanupError) {
      cleanupNote = `; fixture cleanup also failed: ${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}`
    }
    const pidNote = child.pid === undefined ? 'child pid unknown (spawn failed)' : `child pid ${child.pid}`
    return new Error(`fixture setup failed (${pidNote}): ${setupError.message}${cleanupNote}`)
  }
  const spawned = await new Promise<{ error: Error | null }>((resolve) => {
    const cleanup = () => {
      clearTimeout(timer)
      child.removeListener('error', onChildError)
      child.removeListener('spawn', onSpawn)
    }
    const timer = setTimeout(() => {
      cleanup()
      resolve({ error: new Error(`fixture child did not spawn within ${CHILD_SPAWN_DEADLINE_MS}ms`) })
    }, CHILD_SPAWN_DEADLINE_MS)
    const onSpawn = () => { cleanup(); resolve({ error: null }) }
    const onChildError = (error: Error) => { cleanup(); resolve({ error }) }
    child.once('error', onChildError)
    child.once('spawn', onSpawn)
  })
  if (spawned.error !== null) throw await failWithCleanup(spawned.error)
  try {
    const pid = child.pid
    if (pid === undefined || !Number.isSafeInteger(pid) || pid <= 0) {
      throw new Error(`fixture child reported invalid pid: ${String(pid)}`)
    }
    if (childError !== null) throw childError
    // Single /proc read through the stat seam: production fixtures read the
    // real /proc/<pid>/stat; failure-path tests inject a controlled path.
    const startIdentity = readStatStartIdentity(readFileSync(statPath(pid), 'utf8'), pid)
    return { child, pid, startIdentity, stop }
  } catch (error) {
    throw await failWithCleanup(error instanceof Error ? error : new Error(String(error)))
  }
}

// Bounded confirmation that a fixture child is really gone from /proc (a
// truthy kill() only means the signal was sent, not that the process exited).
async function assertProcGone (pid: number, context: string): Promise<void> {
  for (let waited = 0; waited < 100; waited++) {
    if (!existsSync(`/proc/${pid}`)) return
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  assert.fail(`${context}: fixture child ${pid} still present in /proc after ${100 * 50}ms`)
}

describe('fallback journal canonical manifest digest', () => {
  it('is stable across object key order and sensitive to array order and content', async () => {
    const { manifest } = await setupValidFixture()
    const reordered = {
      approvedDestinationRoots: manifest.approvedDestinationRoots,
      bundleDestinations: manifest.bundleDestinations,
      ownedMcpConfigPaths: manifest.ownedMcpConfigPaths,
      ownedMcpFields: manifest.ownedMcpFields,
      ownedLinks: manifest.ownedLinks,
      ownedSkills: manifest.ownedSkills,
      nonce: manifest.nonce,
      digestAlgorithm: manifest.digestAlgorithm,
      protocolVersion: manifest.protocolVersion,
      plannedMissingFrontiers: manifest.plannedMissingFrontiers,
      trackingDigest: manifest.trackingDigest,
      trackingPath: manifest.trackingPath,
      harness: manifest.harness,
      installationId: manifest.installationId,
    }
    assert.equal(manifestDigestOf(reordered as unknown as FallbackTransactionIdentity), manifestDigestOf(manifest))
    // Array-order sensitivity needs at least two elements: reversing a
    // single-element array is a no-op and would prove nothing.
    const twoSkills = {
      ...manifest,
      ownedSkills: [...manifest.ownedSkills, { path: path.join(home, 'second-skill'), kind: 'missing' }],
    } as unknown as FallbackTransactionIdentity
    const arrayShuffled = {
      ...twoSkills,
      ownedSkills: [...twoSkills.ownedSkills].reverse(),
    } as unknown as FallbackTransactionIdentity
    assert.notEqual(manifestDigestOf(arrayShuffled), manifestDigestOf(twoSkills))
    const contentChanged = { ...manifest, trackingDigest: '0'.repeat(64) } as unknown as FallbackTransactionIdentity
    assert.notEqual(manifestDigestOf(contentChanged), manifestDigestOf(manifest))
  })

  it('rejects undefined or sparse array elements and non-finite numbers in canonical JSON', () => {
    assert.throws(() => canonicalJsonString([undefined]))
    const sparse: unknown[] = new Array(3)
    sparse[1] = 'x'
    assert.throws(() => canonicalJsonString(sparse))
    assert.throws(() => canonicalJsonString({ a: Number.NaN }))
    assert.equal(canonicalJsonString({ a: undefined, b: 1 }), '{"b":1}')
    assert.equal(canonicalJsonString(['a', 1, true, null]), '["a",1,true,null]')
  })
})

describe('fallback journal ownership validation', () => {
  it('refuses rollback paths that are not covered by the manifest evidence', async () => {
    const { manifest } = await setupValidFixture()
    const { handle } = await beginFallbackJournal(manifest)
    const victim = path.join(home, 'user-owned.txt')
    writeFileSync(victim, 'keep')
    const malicious = {
      ...JSON.parse(readFileSync(fallbackJournalPath(manifest.trackingPath), 'utf8')),
      entries: [
        ...JSON.parse(readFileSync(fallbackJournalPath(manifest.trackingPath), 'utf8')).entries,
        { path: victim, backup: path.join(home, 'attacker'), existed: false, kind: 'file' },
      ],
    }
    writeFileSync(fallbackJournalPath(manifest.trackingPath), JSON.stringify(malicious))

    const result = await restoreFallbackJournal(handle)
    assert.equal(result.succeeded, false)
    assert.equal(readFileSync(victim, 'utf8'), 'keep')
  })

  it('rejects owned skill bytes that change after planning but before journaling', async () => {
    const { manifest, skillPath } = await setupValidFixture()
    writeFileSync(path.join(skillPath, 'SKILL.md'), '# user edit after approval\n')

    await assert.rejects(beginFallbackJournal(manifest), /FALLBACK_TRACKING_DRIFT/)
    assert.equal(existsSync(fallbackJournalPath(manifest.trackingPath)), false)
  })

  it('rejects a planned-missing destination that appears before the transaction creates it', async () => {
    const { manifest } = await setupValidFixture()
    const destination = path.join(getSkillsDir(), 'new-skill')
    manifest.bundleDestinations = [{ path: destination, kind: 'missing' }]
    mkdirSync(destination, { recursive: true })
    writeFileSync(path.join(destination, 'user-file.txt'), 'keep\n')

    await assert.rejects(beginFallbackJournal(manifest), /FALLBACK_BACKUP_FAILED/)
    assert.equal(readFileSync(path.join(destination, 'user-file.txt'), 'utf8'), 'keep\n')
    // The failed begin removed both its reservation and its snapshot.
    assert.equal(existsSync(fallbackJournalPath(manifest.trackingPath)), false)
    const trackingDir = path.dirname(manifest.trackingPath)
    assert.deepEqual(readdirSync(trackingDir).filter((name) => name.startsWith('.nsolid-plugin-update-')), [])
  })

  it('validates equal, malformed, and unexpected nested frontier evidence before reserving a journal', async () => {
    const fixture = await setupFrontierFixture()
    const malformed = { ...fixture.manifest, plannedMissingFrontiers: [{ nope: true }] } as unknown as FallbackTransactionIdentity
    const nestedExtra = JSON.parse(JSON.stringify(fixture.manifest)) as FallbackTransactionIdentity
    ;(nestedExtra.plannedMissingFrontiers[0].leaves[0] as unknown as Record<string, unknown>).unexpected = true

    await assert.rejects(beginFallbackJournal(malformed), /FALLBACK_FRONTIER_EVIDENCE_INVALID/)
    await assert.rejects(beginFallbackJournal(nestedExtra), /FALLBACK_FRONTIER_EVIDENCE_INVALID/)
    assert.equal(existsSync(fallbackJournalPath(fixture.trackingPath)), false)

    // The unchanged graph follows the real journal path and is accepted.
    const begun = await beginFallbackJournal(fixture.manifest)
    assert.ok(begun.handle)
    const restored = await restoreFallbackJournal(begun.handle)
    assert.equal(restored.succeeded, true)
  })

  it('compares shape-valid frontier roles and destination lists with the trusted journal manifest', async () => {
    const fixture = await setupFrontierFixture()
    const begun = await beginFallbackJournal(fixture.manifest)
    const mutating = await markFallbackJournalMutating(begun.handle)
    const trustedDigest = manifestDigestOf(fixture.manifest)
    const tamperedManifests: FallbackTransactionIdentity[] = []

    const roleTampered = JSON.parse(JSON.stringify(fixture.manifest)) as FallbackTransactionIdentity
    roleTampered.plannedMissingFrontiers[0].leaves[0].role = 'link'
    tamperedManifests.push(roleTampered)

    const destinationRemoved = JSON.parse(JSON.stringify(fixture.manifest)) as FallbackTransactionIdentity
    destinationRemoved.plannedMissingFrontiers[0].leaves = destinationRemoved.plannedMissingFrontiers[0].leaves.slice(0, 1)
    tamperedManifests.push(destinationRemoved)

    const destinationAdded = JSON.parse(JSON.stringify(fixture.manifest)) as FallbackTransactionIdentity
    const addedLeaf = {
      id: 'skill:gamma',
      role: 'skill' as const,
      activation: 'conditional' as const,
      path: path.join(fixture.frontierPath, 'gamma'),
    }
    destinationAdded.plannedMissingFrontiers[0].leaves = [...destinationAdded.plannedMissingFrontiers[0].leaves, addedLeaf]
      .sort((left, right) => compareUtf8(left.path, right.path))
    tamperedManifests.push(destinationAdded)

    const frontierRemoved = JSON.parse(JSON.stringify(fixture.manifest)) as FallbackTransactionIdentity
    frontierRemoved.plannedMissingFrontiers = []
    tamperedManifests.push(frontierRemoved)

    const secondAnchorPath = path.join(home, 'second-frontier-anchor')
    mkdirSync(secondAnchorPath)
    const frontierAdded = JSON.parse(JSON.stringify(fixture.manifest)) as FallbackTransactionIdentity
    frontierAdded.plannedMissingFrontiers = [...frontierAdded.plannedMissingFrontiers, {
      frontierPath: path.join(secondAnchorPath, 'new-root'),
      activation: 'required',
      anchor: await frontierAnchorIdentity(secondAnchorPath),
      leaves: [{ id: 'skill:gamma', role: 'skill', activation: 'required', path: path.join(secondAnchorPath, 'new-root', 'gamma') }],
    }]
    frontierAdded.plannedMissingFrontiers = [...frontierAdded.plannedMissingFrontiers]
      .sort((left, right) => compareUtf8(left.frontierPath, right.frontierPath))
    tamperedManifests.push(frontierAdded)

    // Every tamper above is strict-parser-valid and self-consistent for live
    // revalidation. Only the journal's trusted manifest comparison rejects it.
    for (const tampered of tamperedManifests) {
      assert.equal(await claimFallbackJournalMutation(tampered, trustedDigest), null)
    }

    const owner = await reclaimFallbackJournalMutation(mutating)
    const restored = await restoreFallbackJournal(owner)
    assert.equal(restored.succeeded, true)
  })

  it('rejects a changed frontier anchor inode through the real journal preflight', async () => {
    const fixture = await setupFrontierFixture()
    // Replace the anchor's inode without deleting the original directory and
    // without rename-over-existing (not permitted on every platform): rename
    // the original aside preserving its inode, then move the freshly created
    // replacement into the anchor path.
    const replacement = path.join(home, 'frontier-anchor-replacement')
    mkdirSync(replacement)
    renameSync(fixture.anchorPath, `${fixture.anchorPath}-replaced`)
    renameSync(replacement, fixture.anchorPath)

    await assert.rejects(beginFallbackJournal(fixture.manifest), /FALLBACK_FRONTIER_DRIFT/)
    assert.equal(existsSync(fallbackJournalPath(fixture.trackingPath)), false)
  })

  it('serializes two concurrent begins in the same process: exactly one succeeds', async () => {
    const { manifest } = await setupValidFixture()
    const [first, second] = await Promise.allSettled([
      beginFallbackJournal(manifest),
      beginFallbackJournal(manifest),
    ])
    const fulfilled = [first, second].filter((outcome) => outcome.status === 'fulfilled')
    const rejected = [first, second].filter((outcome) => outcome.status === 'rejected')
    assert.equal(fulfilled.length, 1)
    assert.equal(rejected.length, 1)
    assert.match(String((rejected[0] as PromiseRejectedResult).reason), /FALLBACK_JOURNAL_BUSY/)
  })

  it('serializes concurrent begins across processes: exactly one succeeds', { skip: process.platform === 'win32' }, async () => {
    const { manifest } = await setupValidFixture()
    // Both the imported module URL and the child's cwd (needed to resolve the
    // `tsx/esm` loader specifier) are derived from THIS test file's location,
    // never from process.cwd: the suite must behave identically whether it is
    // run from packages/core or the repository root.
    const packageRoot = fileURLToPath(new URL('../../..', import.meta.url))
    const journalModule = new URL('../../../src/update/fallback-journal.js', import.meta.url).href
    // True overlap: both children park on a filesystem barrier and only call
    // beginFallbackJournal once BOTH are alive, so the wx reservation race is
    // genuinely concurrent instead of two sequential spawns.
    const readyPrefix = path.join(home, 'begin-ready.')
    const goPath = path.join(home, 'begin-go')
    const script = [
      'const { writeFileSync, existsSync } = require(\'node:fs\')',
      `writeFileSync(${JSON.stringify(readyPrefix)} + process.pid, '')`,
      'const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)',
      `while (!existsSync(${JSON.stringify(goPath)})) sleep(5)`,
      `import(${JSON.stringify(journalModule)}).then(async (m) => {`,
      '  try {',
      `    await m.beginFallbackJournal(${JSON.stringify(manifest)})`,
      '    console.log(\'BEGIN_OK\')',
      '  } catch (error) {',
      '    console.log(error.message)',
      '  }',
      '})',
    ].join('\n')
    const children = [0, 1].map(() => spawn(process.execPath, ['--import', 'tsx/esm', '-e', script], {
      cwd: packageRoot,
      env: { ...process.env, HOME: home, USERPROFILE: home },
      stdio: ['ignore', 'pipe', 'pipe'],
    }))
    try {
      const deadline = Date.now() + 60_000
      while (Date.now() < deadline && readdirSync(home).filter((name) => name.startsWith('begin-ready.')).length < 2) {
        await new Promise((resolve) => setTimeout(resolve, 20))
      }
      assert.equal(readdirSync(home).filter((name) => name.startsWith('begin-ready.')).length, 2, 'both racers must be parked at the barrier before the begin')
      writeFileSync(goPath, 'go')
      const outcomes = await Promise.all(children.map((child) => new Promise<string>((resolve, reject) => {
        let output = ''
        child.stdout!.on('data', (chunk: Buffer) => { output += chunk.toString() })
        child.stderr!.on('data', (chunk: Buffer) => { output += chunk.toString() })
        child.on('error', reject)
        child.on('close', () => resolve(output))
      })))
      assert.equal(outcomes.filter((text) => text.includes('BEGIN_OK')).length, 1, outcomes.join('\n---\n'))
      assert.equal(outcomes.filter((text) => text.includes('FALLBACK_JOURNAL_BUSY')).length, 1, outcomes.join('\n---\n'))
    } finally {
      for (const child of children) child.kill('SIGKILL')
    }
  })

  it('reserves the journal path before any snapshot work: an existing reservation is busy', async () => {
    const { manifest } = await setupValidFixture()
    // A reservation created by "another process" (only the file existence
    // matters for wx) makes the begin fail closed before any snapshot exists.
    const reservation = openSync(fallbackJournalPath(manifest.trackingPath), 'wx', 0o600)
    writeFileSync(fallbackJournalPath(manifest.trackingPath), '{}\n')
    closeSync(reservation)
    const trackingDir = path.dirname(manifest.trackingPath)
    const snapshotsBefore = readdirSync(trackingDir).filter((name) => name.startsWith('.nsolid-plugin-update-'))
    await assert.rejects(beginFallbackJournal(manifest), /FALLBACK_JOURNAL_BUSY/)
    assert.deepEqual(readdirSync(trackingDir).filter((name) => name.startsWith('.nsolid-plugin-update-')), snapshotsBefore)
  })

  it('refuses to claim the mutation without an existing journal, without the nonce, or with a wrong digest', async () => {
    const { manifest } = await setupValidFixture()
    // Missing journal: the claim must fail closed (never succeed vacuously).
    assert.equal(await claimFallbackJournalMutation(manifest), null)
    const { handle } = await beginFallbackJournal(manifest)
    const mutating = await markFallbackJournalMutating(handle)
    const impostor = { ...manifest, nonce: randomUUID() }
    assert.equal(await claimFallbackJournalMutation(impostor), null)
    assert.equal(await claimFallbackJournalMutation({ ...manifest, nonce: undefined }), null)
    assert.equal(await claimFallbackJournalMutation(manifest, 'f'.repeat(64)), null)
    assert.notEqual(await claimFallbackJournalMutation(manifest, manifestDigestOf(manifest)), null)
    // A claim on a prepared (not mutating) journal fails too: dispose this
    // transaction and begin a fresh one, which stays prepared.
    rmSync(fallbackJournalPath(manifest.trackingPath), { force: true })
    await beginFallbackJournal(manifest)
    assert.equal(await claimFallbackJournalMutation(manifest, manifestDigestOf(manifest)), null)
    assert.ok(mutating)
  })

  it('fails closed on stale revisions and on deleted or replaced journals between API calls', async () => {
    const { manifest, skillPath } = await setupValidFixture()
    let { handle } = await beginFallbackJournal(manifest)
    handle = await markFallbackJournalMutating(handle)
    const disk = JSON.parse(readFileSync(handle.journalPath, 'utf8'))
    disk.revision += 5
    writeFileSync(handle.journalPath, JSON.stringify(disk))
    await assert.rejects(registerFallbackStage(handle, skillPath, { bytes: Buffer.from('x') }), /Invalid fallback journal/)

    // The tampered first journal must be disposed before a fresh begin: any
    // existing journal (even a stale one) makes begin fail closed as busy.
    rmSync(handle.journalPath, { force: true })
    const fresh = await beginFallbackJournal(manifest)
    let live = await markFallbackJournalMutating(fresh.handle)
    rmSync(live.journalPath, { force: true })
    // A deleted or malformed journal must fail closed; the thrown value is the
    // raw fs/parse error in the current implementation, so accept any
    // rejection here — the contract is "never return stale state".
    await assert.rejects(reloadFallbackJournal(live))
    live = await markFallbackJournalMutating(live).catch(() => live)
    rmSync(live.journalPath, { force: true })
    writeFileSync(live.journalPath, '{"not":"a journal"}\n')
    await assert.rejects(reloadFallbackJournal(live))
  })

  it('refuses parent reclaim while a different live process mutates, allows it after exit, and never lets PID reuse grant ownership', { skip: process.platform !== 'linux' }, async () => {
    const { manifest } = await setupValidFixture()
    const { handle } = await beginFallbackJournal(manifest)
    const owner = await markFallbackJournalMutating(handle)

    // Craft a mutator record for a real live process (a sleeping child). The
    // fixture helper owns the child lifecycle: no stdout pid protocol, a
    // validated child.pid, and a single /proc starttime read.
    const live = await spawnLiveProcessFixture()
    const childPid: number = live.pid
    try {
      const disk = JSON.parse(readFileSync(owner.journalPath, 'utf8'))
      disk.mutator = { pid: childPid, startIdentity: live.startIdentity, claimedAt: new Date().toISOString() }
      writeFileSync(owner.journalPath, JSON.stringify(disk))

      await assert.rejects(reclaimFallbackJournalMutation(owner), /FALLBACK_MUTATOR_LIVE/)
    } finally {
      // Explicitly stop and await the child BEFORE the reclaim-success
      // assertions: a truthy kill() return only means the signal was sent,
      // not that the process exited. Idempotent if already stopped.
      await live.stop()
    }
    const reclaimed = await reclaimFallbackJournalMutation(owner)
    assert.equal(reclaimed.role, 'owner')
    assert.equal(JSON.parse(readFileSync(reclaimed.journalPath, 'utf8')).mutator, undefined)

    // PID reuse: a record pointing at OUR pid with someone else's start
    // identity is provably a recycled pid, not a live mutator.
    const recycled = JSON.parse(readFileSync(reclaimed.journalPath, 'utf8'))
    recycled.mutator = { pid: process.pid, startIdentity: '1', claimedAt: new Date().toISOString() }
    writeFileSync(reclaimed.journalPath, JSON.stringify(recycled))
    // A spread copy of a genuine handle was never issued: the immutable
    // issuance metadata is bound to the original object only, so the copy
    // must be rejected before any successor authority is issued.
    await assert.rejects(reclaimFallbackJournalMutation({ ...reclaimed }), /Invalid fallback journal/)
    // The original genuine handle still reclaims the stale same-revision
    // disk state successfully.
    const again = await reclaimFallbackJournalMutation(reclaimed)
    assert.equal(again.role, 'owner')
  })

  it('live-process fixture helper uses the real pid and a valid starttime even when child stdout carries a banner and a numeric decoy', { skip: process.platform !== 'linux' }, async () => {
    // Controlled parser-mechanism discrimination plus real-helper identity
    // verification — NOT captured-output equivalence and NOT a reconstruction
    // of the unknown historical trigger. The historical fixtures parsed the
    // FIRST stdout chunk with Number.parseInt(chunk.trim(), 10) and then read
    // /proc/<parsed>/stat. This regression feeds that exact expression a
    // FIXED controlled first-chunk string beginning with a nonnumeric banner
    // and shows the failure mechanism end to end: the parse yields NaN and
    // the /proc/NaN/stat read fails with ENOENT. The real shared helper is
    // then spawned with a child script configured to emit that same banner
    // plus a numeric decoy before sleeping, proving the helper ignores
    // hostile stdout entirely and uses the actual child pid with a real
    // single-read starttime.
    const bannerLine = 'fixture child banner: pid follows'
    // Fixed controlled first-chunk payload: begins with a nonnumeric banner.
    const controlledFirstChunk = `${bannerLine}\n`
    // The exact legacy parser expression on the controlled parser input:
    // NaN, then the historical ENOENT /proc/NaN/stat failure.
    const legacyPid = Number.parseInt(controlledFirstChunk.trim(), 10)
    assert.ok(Number.isNaN(legacyPid), `legacy first-chunk parser must yield NaN on a banner-led chunk, got ${String(legacyPid)}`)
    assert.throws(() => readFileSync(`/proc/${legacyPid}/stat`, 'utf8'), /ENOENT/)

    // Real helper against a child emitting the same fixed banner plus a
    // numeric decoy (a truncated fragment of its own pid) and then sleeping.
    const bannerScript = `console.log(${JSON.stringify(bannerLine)}); console.log(String(process.pid).slice(0, 2)); setTimeout(() => {}, ${MUTATOR_CHILD_TTL_MS})`
    const live = await spawnLiveProcessFixture([process.execPath, '-e', bannerScript])
    try {
      // Authoritative identity: the helper pid must be the actual spawned
      // child's pid, and the recorded identity must be that exact child's
      // /proc starttime — not merely a well-formed number.
      assert.ok(live.child.pid !== undefined, 'spawned child must expose its pid')
      assert.equal(live.pid, live.child.pid)
      assert.match(live.startIdentity, /^\d+$/)
      assert.equal(live.startIdentity, readStatStartIdentity(readFileSync(`/proc/${live.child.pid}/stat`, 'utf8'), live.child.pid))
    } finally {
      await live.stop()
    }
  })

  it('fixture helper terminates the owned child when setup fails after a successful spawn', { skip: process.platform !== 'linux' }, async () => {
    // Deterministic setup failure: the stat-path seam makes the single
    // identity read return a malformed record while the child is already
    // alive. The helper must fail setup, terminate the child it owns, and
    // surface the setup diagnostic — never leak the child or retry the read.
    const malformedStatPath = path.join(os.tmpdir(), `nsolid-journal-fixture-stat-${randomUUID()}`)
    writeFileSync(malformedStatPath, '999 (decoy) S 0 0 0')
    let setupError: Error | null = null
    try {
      await spawnLiveProcessFixture(undefined, () => malformedStatPath)
    } catch (error) {
      setupError = error as Error
    }
    rmSync(malformedStatPath, { force: true })
    assert.ok(setupError !== null, 'malformed identity must fail fixture setup')
    assert.match(setupError.message, /malformed or vanished \/proc\/\d+\/stat identity/)
    // The diagnostic must identify the owned child so termination can be
    // confirmed — kill() alone is not confirmation.
    const match = /child pid (\d+)/.exec(setupError.message)
    assert.ok(match !== null, `setup failure must identify the owned child pid: ${setupError.message}`)
    await assertProcGone(Number(match[1]), 'setup failure')
  })

  it('fixture helper rejects promptly on spawn failure with the setup diagnostic retained', { skip: process.platform !== 'linux' }, async () => {
    const startedAt = Date.now()
    await assert.rejects(
      spawnLiveProcessFixture(['nonexistent-fixture-binary-9x7']),
      (error: Error) => {
        assert.match(error.message, /ENOENT/)
        assert.match(error.message, /fixture setup failed/)
        assert.match(error.message, /child pid unknown/)
        return true
      }
    )
    // Promptly: the rejection is the spawn error itself, not a waited-out
    // spawn deadline.
    assert.ok(Date.now() - startedAt < CHILD_SPAWN_DEADLINE_MS, 'spawn failure must reject without waiting out the spawn deadline')
  })

  it('fixture helper fails explicitly when the child vanishes before its identity is read', { skip: process.platform !== 'linux' }, async () => {
    // Deterministic stand-in for an early-exiting child: by the time the
    // single identity read happens, /proc/<pid>/stat is already gone. The
    // helper must fail explicitly — no polling, no retry that could sample a
    // reused pid — and still terminate the child it owns.
    let setupError: Error | null = null
    try {
      await spawnLiveProcessFixture(undefined, () => '/proc/nonexistent-fixture-pid/stat')
    } catch (error) {
      setupError = error as Error
    }
    assert.ok(setupError !== null, 'vanished identity must fail fixture setup explicitly')
    assert.match(setupError.message, /ENOENT/)
    const match = /child pid (\d+)/.exec(setupError.message)
    assert.ok(match !== null, `setup failure must identify the owned child pid: ${setupError.message}`)
    await assertProcGone(Number(match[1]), 'vanished identity')
  })

  it('fixture helper stop is idempotent, confirms real termination, and disposes listeners', { skip: process.platform !== 'linux' }, async () => {
    const live = await spawnLiveProcessFixture()
    try {
      const { child } = live
      assert.ok(child.pid !== undefined)
      assert.equal(live.pid, child.pid)
      // Concurrent repeated stops share one bounded termination.
      await Promise.all([live.stop(), live.stop(), live.stop()])
      // Real termination, not merely a signalled child.
      assert.ok(child.exitCode !== null || child.signalCode !== null, 'child must have really exited, not merely been signalled')
      // Listener disposal: nothing stays attached after termination, so no
      // late event work or deadline timer survives the stop.
      assert.equal(child.listenerCount('error'), 0)
      assert.equal(child.listenerCount('exit'), 0)
      assert.equal(child.listenerCount('close'), 0)
      // Stop after completion stays idempotent.
      await live.stop()
    } finally {
      // An assertion failure before stop() must not leak the owned child;
      // stop is cached and idempotent, so this joins the earlier termination.
      await live.stop()
    }
  })

  it('terminateFixtureChild resolves without killing an already-exited or failed-spawn child', async () => {
    // Already-exited child: listener disposal only, no kill needed. The probe
    // is owned from creation: the error listener is attached immediately, the
    // close wait is bounded, and terminateFixtureChild runs in finally so an
    // assertion failure cannot leak the child.
    const dead = spawn(process.execPath, ['-e', 'process.exit(0)'], { stdio: 'ignore' })
    const deadOnError = () => {}
    dead.once('error', deadOnError)
    // Named reference for this probe's own error listener: it never fires on
    // a clean exit, so the probe disposes it itself — helper removal is
    // limited to listeners the helper owns.
    let onDeadError: (error: Error) => void = () => {}
    try {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`probe child did not close within ${CHILD_SPAWN_DEADLINE_MS}ms`)), CHILD_SPAWN_DEADLINE_MS)
        dead.once('close', () => { clearTimeout(timer); resolve() })
        onDeadError = (error: Error) => { clearTimeout(timer); reject(error) }
        dead.once('error', onDeadError)
      })
      assert.equal(dead.exitCode, 0)
    } finally {
      dead.removeListener('error', onDeadError)
      await terminateFixtureChild(dead, deadOnError)
    }
    assert.equal(dead.listenerCount('error'), 0)

    // Failed spawn: no pid exists, so termination must resolve without a
    // bogus kill and without waiting out the stop deadline. The error wait is
    // bounded and terminateFixtureChild runs in finally for disposal.
    const failed = spawn('nonexistent-fixture-binary-9x7', [], { stdio: 'ignore' })
    const failures: Error[] = []
    const failedOnError = (error: Error) => { failures.push(error) }
    failed.once('error', failedOnError)
    try {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`failed-spawn probe reported no error within ${CHILD_SPAWN_DEADLINE_MS}ms`)), CHILD_SPAWN_DEADLINE_MS)
        failed.once('error', () => { clearTimeout(timer); resolve() })
      })
    } finally {
      await terminateFixtureChild(failed, failedOnError)
    }
    assert.equal(failures.length, 1)
    assert.equal(failed.pid, undefined)
    assert.equal(failed.listenerCount('error'), 0)
  })

  it('refuses spread or plain handles that were never issued for reload, reclaim, and commit', async () => {
    const { manifest } = await setupValidFixture()
    const { handle } = await beginFallbackJournal(manifest)
    // Structurally identical copies (spread/plain objects) carry no WeakMap
    // issuance metadata: every handle-based transition must reject them
    // before reading or clearing any authority.
    await assert.rejects(reloadFallbackJournal({ ...handle }), /Invalid fallback journal/)
    await assert.rejects(reclaimFallbackJournalMutation({ ...handle }), /Invalid fallback journal/)
    await assert.rejects(commitFallbackJournal({ ...handle }), /Invalid fallback journal/)
    // The genuine handle still works end to end.
    const owner = await markFallbackJournalMutating(handle)
    assert.equal((await reloadFallbackJournal(owner)).phase, 'mutating')
    const reclaimed = await reclaimFallbackJournalMutation(owner)
    assert.equal(reclaimed.role, 'owner')
  })

  it('refuses an in-place retargeted genuine handle from laundering another transaction reclaim or restore', async () => {
    // Transaction A: a genuine owner handle that later gets retargeted in
    // place. Its journal is disposed so transaction B can begin normally.
    const aFixture = await setupValidFixture()
    const { handle: genuineA } = await beginFallbackJournal(aFixture.manifest)
    rmSync(genuineA.journalPath, { force: true })
    // Transaction B: a real frontier publication this process legitimately
    // owns and applies (same lifecycle as the frontier publication tests).
    const bFixture = await setupFrontierFixture()
    const { handle: bRaw } = await beginFallbackJournal(bFixture.manifest)
    await markFallbackJournalMutating(bRaw)
    const bOwner = await claimFallbackJournalMutation(bFixture.manifest, manifestDigestOf(bFixture.manifest))
    if (!bOwner) throw new Error('mutation claim failed')
    const staged = path.join(home, `staged-frontier-${randomUUID().slice(0, 8)}`)
    mkdirSync(path.join(staged, 'alpha'), { recursive: true })
    writeFileSync(path.join(staged, 'alpha', 'SKILL.md'), '# alpha staged\n')
    mkdirSync(path.join(staged, 'beta'), { recursive: true })
    writeFileSync(path.join(staged, 'beta', 'SKILL.md'), '# beta staged\n')
    const registered = await registerFallbackFrontierStage(bOwner, bFixture.frontierPath, staged, { activeConditionalLeafIds: ['skill:beta'] })
    const currentB = await applyFallbackEntry(registered, bFixture.frontierPath)
    assert.equal(publishedFallbackFrontiers(currentB).length, 1)

    // Laundering attempt: overwrite A's fields in place with B's identity.
    // The WeakMap issuance metadata bound to A's object still describes A,
    // so every transition must reject BEFORE issuing successor authority.
    const retargetedA = Object.assign(genuineA, currentB)
    await assert.rejects(reclaimFallbackJournalMutation(retargetedA), /Invalid fallback journal/)
    // Restore through the laundered chain consumes nothing: B's publication
    // capability and live frontier content stay intact.
    const launderedRestore = await restoreFallbackJournal(retargetedA)
    assert.equal(launderedRestore.succeeded, false)
    assert.equal(launderedRestore.unproven, true)
    assert.equal(publishedFallbackFrontiers(currentB).length, 1)
    assert.equal(readFileSync(path.join(bFixture.frontierPath, 'alpha', 'SKILL.md'), 'utf8'), '# alpha staged\n')
    assert.equal(readFileSync(path.join(bFixture.frontierPath, 'beta', 'SKILL.md'), 'utf8'), '# beta staged\n')
    // The genuine B handle still owns its publication.
    const bRestore = await restoreFallbackJournal(currentB)
    assert.equal(bRestore.succeeded, true)
    assert.equal(existsSync(bFixture.frontierPath), false)
  })

  it('reclaims authority and restores a failed parent transaction as one journal operation', async () => {
    const { skillPath, manifest } = await setupValidFixture()
    const begun = await beginFallbackJournal(manifest)
    const mutating = await markFallbackJournalMutating(begun.handle)
    writeFileSync(path.join(skillPath, 'SKILL.md'), '# mutated\n')

    const result = await recoverFallbackJournalMutation(mutating, begun.journal.snapshotDirectory)
    assert.equal(result.succeeded, true)
    assert.equal(readFileSync(path.join(skillPath, 'SKILL.md'), 'utf8'), '# tracked\n')
    assert.equal(existsSync(mutating.journalPath), false)
    assert.equal(begun.journal.snapshotDirectory !== undefined && existsSync(begun.journal.snapshotDirectory), false)
  })

  it('restores the snapshotted bytes of owned state after a mutation and disposes the journal as owner', async () => {
    const { trackingPath, skillPath, linkPath, manifest, trackingJson } = await setupValidFixture()
    const { handle } = await beginFallbackJournal(manifest)
    await markFallbackJournalMutating(handle)
    const claimed = await claimFallbackJournalMutation(manifest, manifestDigestOf(manifest))
    assert.ok(claimed)
    const staged = await registerFallbackStage(claimed, trackingPath, { bytes: Buffer.from(JSON.stringify({ ...JSON.parse(trackingJson), installedAt: 'mutated' })) })
    await applyFallbackEntry(staged, trackingPath)
    const owner = await reclaimFallbackJournalMutation(handle)
    writeFileSync(path.join(skillPath, 'SKILL.md'), '# mutated\n')
    writeFileSync(linkPath, 'mutated\n')

    const result = await restoreFallbackJournal(owner)
    assert.equal(result.succeeded, true)
    assert.equal(result.unproven, undefined)
    assert.deepEqual(result.preservedPaths, [])
    assert.equal(readFileSync(path.join(skillPath, 'SKILL.md'), 'utf8'), '# tracked\n')
    assert.equal(readFileSync(linkPath, 'utf8'), 'link\n')
    assert.equal(readFileSync(trackingPath, 'utf8'), trackingJson)
    assert.equal(existsSync(owner.journalPath), false)
    const trackingDir = path.dirname(trackingPath)
    assert.deepEqual(readdirSync(trackingDir).filter((name) => name.includes('.nsolid-')), [])
  })

  it('overwrites a concurrent edit to an owned path with the authenticated original (hybrid parent authority)', async () => {
    const { skillPath, manifest } = await setupValidFixture()
    const { handle } = await beginFallbackJournal(manifest)
    const owner = await markFallbackJournalMutating(handle)
    writeFileSync(path.join(skillPath, 'SKILL.md'), 'child mutation\n')
    writeFileSync(path.join(skillPath, 'user-edit.txt'), 'concurrent user edit\n')

    const result = await restoreFallbackJournal(owner)
    assert.equal(result.succeeded, true)
    assert.equal(readFileSync(path.join(skillPath, 'SKILL.md'), 'utf8'), '# tracked\n')
    assert.equal(existsSync(path.join(skillPath, 'user-edit.txt')), false)
    assert.equal(existsSync(owner.journalPath), false)
  })

  it('preserves tracking added by another harness after the snapshot and defers restore', async () => {
    const { manifest, trackingPath, skillPath } = await setupValidFixture()
    const { handle } = await beginFallbackJournal(manifest)
    const owner = await markFallbackJournalMutating(handle)
    const tracking = JSON.parse(readFileSync(trackingPath, 'utf8'))
    const foreignPath = path.join(home, '.config', 'opencode', 'skills', 'foreign')
    mkdirSync(foreignPath, { recursive: true })
    writeFileSync(path.join(foreignPath, 'SKILL.md'), 'KEEP')
    tracking.skills.push({ name: 'foreign', path: foreignPath, paths: { opencode: foreignPath }, installedAt: new Date().toISOString(), harnesses: ['opencode'] })
    const concurrentBytes = JSON.stringify(tracking, null, 2) + '\r\n'
    writeFileSync(trackingPath, concurrentBytes)
    writeFileSync(path.join(skillPath, 'SKILL.md'), 'child mutation')

    const result = await restoreFallbackJournal(owner)

    assert.equal(readFileSync(trackingPath, 'utf8'), concurrentBytes)
    assert.equal(readFileSync(path.join(foreignPath, 'SKILL.md'), 'utf8'), 'KEEP')
    assert.equal(readFileSync(path.join(skillPath, 'SKILL.md'), 'utf8'), 'child mutation', 'drift is detected before any restore')
    assert.equal(result.succeeded, false)
    assert.equal(result.unproven, true)
    assert.ok(result.preservedPaths.includes(trackingPath))
    assert.equal(existsSync(owner.journalPath), true)
    const inspection = await inspectFallbackJournal(trackingPath)
    assert.equal(inspection.recovered, false)
    assert.ok(inspection.preservedPaths.includes(trackingPath))
    const recovery = await recoverFallbackJournal(trackingPath)
    assert.equal(recovery.pending, true)
    assert.equal(recovery.recovered, false)
    assert.ok(recovery.preservedPaths.includes(trackingPath))
    assert.equal(readFileSync(trackingPath, 'utf8'), concurrentBytes, 'next-run recovery must preserve the concurrent records too')
  })

  it('does not promote forged applied tracking digests to restore authority', async () => {
    const { manifest, trackingPath, trackingJson } = await setupValidFixture()
    const { handle } = await beginFallbackJournal(manifest)
    await markFallbackJournalMutating(handle)
    const claimed = await claimFallbackJournalMutation(manifest, manifestDigestOf(manifest))
    assert.ok(claimed)
    const staged = await registerFallbackStage(claimed, trackingPath, { bytes: Buffer.from(JSON.stringify({ ...JSON.parse(trackingJson), installedAt: 'published' })) })
    await applyFallbackEntry(staged, trackingPath)
    const owner = await reclaimFallbackJournalMutation(handle)
    const concurrentBytes = JSON.stringify({ ...JSON.parse(trackingJson), installedAt: 'concurrent' })
    writeFileSync(trackingPath, concurrentBytes)
    const disk = JSON.parse(readFileSync(owner.journalPath, 'utf8'))
    const entry = disk.entries.find((entry: { path: string }) => entry.path === trackingPath)
    entry.applied = true
    entry.stageDigest = await pathDigest(trackingPath)
    writeFileSync(owner.journalPath, JSON.stringify(disk))

    const result = await restoreFallbackJournal(owner)
    assert.equal(result.succeeded, false)
    assert.equal(result.unproven, true)
    assert.equal(readFileSync(trackingPath, 'utf8'), concurrentBytes)
    assert.equal(existsSync(owner.journalPath), true)
  })

  it('reports FALLBACK_STATE_UNPROVEN and preserves everything when a backup was tampered with', async () => {
    const { skillPath, manifest } = await setupValidFixture()
    const { handle } = await beginFallbackJournal(manifest)
    const owner = await markFallbackJournalMutating(handle)
    const disk = JSON.parse(readFileSync(owner.journalPath, 'utf8'))
    const skillEntry = disk.entries.find((entry: { path: string }) => path.resolve(entry.path) === path.resolve(skillPath))
    writeFileSync(path.join(skillEntry.backup, 'SKILL.md'), '# tampered\n')

    const result = await restoreFallbackJournal(owner)
    assert.equal(result.succeeded, false)
    assert.equal(result.unproven, true)
    // The live skill still holds its pre-restore bytes, not the tampered backup.
    assert.equal(readFileSync(path.join(skillPath, 'SKILL.md'), 'utf8'), '# tracked\n')
    assert.equal(existsSync(owner.journalPath), true)
  })

  it('reports unproven when the journal was replaced after begin', async () => {
    const { manifest } = await setupValidFixture()
    const { handle } = await beginFallbackJournal(manifest)
    const owner = await markFallbackJournalMutating(handle)
    const forged = JSON.parse(readFileSync(owner.journalPath, 'utf8'))
    forged.transactionId = randomUUID()
    writeFileSync(owner.journalPath, JSON.stringify(forged))

    const result = await restoreFallbackJournal(owner)
    assert.equal(result.succeeded, false)
    assert.equal(result.unproven, true)
    assert.equal(existsSync(owner.journalPath), true)
  })

  it('rolls back a created planned-missing destination into a preserved quarantine without deleting it', async () => {
    const { manifest, trackingPath } = await setupValidFixture()
    const destination = path.join(getSkillsDir(), 'added')
    manifest.bundleDestinations = [{ path: destination, kind: 'missing' }]
    const { handle: fresh } = await beginFallbackJournal(manifest)
    await markFallbackJournalMutating(fresh)
    // Mutator-role operations require a claimed mutator handle (and the
    // journal's mutator record): the owner handle from
    // markFallbackJournalMutating can neither stage nor apply.
    const claimed = await claimFallbackJournalMutation(manifest, manifestDigestOf(manifest))
    assert.ok(claimed)
    const stageSource = mkdtempSync(path.join(path.dirname(destination), '.stage-src-'))
    mkdirSync(path.join(stageSource, 'payload'), { recursive: true })
    writeFileSync(path.join(stageSource, 'payload', 'SKILL.md'), 'new skill\n')
    let handle = await registerFallbackStage(claimed, destination, { directory: path.join(stageSource, 'payload') })
    handle = await applyFallbackEntry(handle, destination)
    assert.equal(readFileSync(path.join(destination, 'SKILL.md'), 'utf8'), 'new skill\n')

    const result = await restoreFallbackJournal(handle)
    assert.equal(result.succeeded, true)
    // The created destination was moved into a quarantine that SURVIVES.
    assert.equal(existsSync(destination), false)
    const quarantines = readdirSync(path.dirname(destination)).filter((name) => name.includes('.nsolid-quarantine-'))
    assert.equal(quarantines.length, 1)
    assert.equal(readFileSync(path.join(path.dirname(destination), quarantines[0], 'added', 'SKILL.md'), 'utf8'), 'new skill\n')
    assert.ok(result.preservedArtifacts.some((artifact) => artifact.includes('.nsolid-quarantine-')))
    assert.equal(existsSync(handle.journalPath), true, 'a mutator leaves journal disposition to its owner')
    assert.equal(existsSync(trackingPath), true)
    rmSync(stageSource, { recursive: true, force: true })
  })

  it('never deletes a journal-recorded stage container without its in-memory capability during commit', async () => {
    const { manifest, skillPath } = await setupValidFixture()
    const { handle } = await beginFallbackJournal(manifest)
    const owner = await markFallbackJournalMutating(handle)
    // A decoy container that passes strict structural validation (exact
    // sibling name shape + payload child) but was created OUTSIDE this
    // process: the journal record alone must never authorize its removal.
    const decoy = path.join(path.dirname(skillPath), `.${path.basename(skillPath)}.nsolid-stage-abc123`)
    mkdirSync(path.join(decoy, 'payload'), { recursive: true })
    writeFileSync(path.join(decoy, 'payload', 'decoy.txt'), 'KEEP')
    const journalPath = fallbackJournalPath(manifest.trackingPath)
    const forged = JSON.parse(readFileSync(journalPath, 'utf8'))
    const skillEntry = forged.entries.find((entry: { path: string }) => path.resolve(entry.path) === path.resolve(skillPath))
    skillEntry.stage = path.join(decoy, 'payload')
    writeFileSync(journalPath, JSON.stringify(forged))

    const result = await commitFallbackJournal(owner)
    assert.equal(result.succeeded, true)
    assert.equal(readFileSync(path.join(decoy, 'payload', 'decoy.txt'), 'utf8'), 'KEEP')
    assert.ok(result.preservedArtifacts.some((artifact) => artifact === decoy))
  })

  it('cleans authenticated stage and quarantine containers during commit and reports none', async () => {
    const { manifest, skillPath } = await setupValidFixture()
    const { handle: fresh } = await beginFallbackJournal(manifest)
    await markFallbackJournalMutating(fresh)
    const claimed = await claimFallbackJournalMutation(manifest, manifestDigestOf(manifest))
    assert.ok(claimed)
    const stageSource = mkdtempSync(path.join(path.dirname(skillPath), '.stage-src-'))
    mkdirSync(path.join(stageSource, 'payload'), { recursive: true })
    writeFileSync(path.join(stageSource, 'payload', 'SKILL.md'), 'new bundle\n')
    let handle = await registerFallbackStage(claimed, skillPath, { directory: path.join(stageSource, 'payload') })
    handle = await applyFallbackEntry(handle, skillPath)
    assert.equal(readFileSync(path.join(skillPath, 'SKILL.md'), 'utf8'), 'new bundle\n')
    // The creator cleaned its own containers right after the apply.
    const siblings = readdirSync(path.dirname(skillPath)).filter((name) => name.includes('.nsolid-'))
    assert.deepEqual(siblings, [])

    // The owner reclaims (fresh revision, mutator released) before committing.
    const owner = await reclaimFallbackJournalMutation(fresh)
    const result = await commitFallbackJournal(owner)
    assert.equal(result.succeeded, true)
    assert.deepEqual(result.preservedArtifacts, [])
    assert.equal(existsSync(handle.journalPath), false)
    rmSync(stageSource, { recursive: true, force: true })
  })

  it('applies a deletion-only entry by moving the owned path into quarantine', async () => {
    const { manifest, skillPath } = await setupValidFixture()
    const { handle: fresh } = await beginFallbackJournal(manifest)
    await markFallbackJournalMutating(fresh)
    const claimed = await claimFallbackJournalMutation(manifest, manifestDigestOf(manifest))
    assert.ok(claimed)
    // Deletion-only apply: v3 performs a deletion by swapping in nothing, so
    // the owned path moves to quarantine while the journal still records it.
    await applyFallbackEntry(claimed, skillPath)
    assert.equal(existsSync(skillPath), false)
    const quarantines = readdirSync(path.dirname(skillPath)).filter((name) => name.includes('.nsolid-quarantine-'))
    assert.equal(quarantines.length, 1, 'deletion preserves bytes in quarantine until cleanup')
  })

  it('aborts the swap when the live path drifted after registration', async () => {
    const { linkPath, manifest } = await setupValidFixture()
    const { handle: fresh } = await beginFallbackJournal(manifest)
    await markFallbackJournalMutating(fresh)
    const handle = await claimFallbackJournalMutation(manifest, manifestDigestOf(manifest))
    assert.ok(handle)
    const staged = await registerFallbackStage(handle, linkPath, { bytes: Buffer.from('# new bundle\n') })
    writeFileSync(linkPath, 'concurrent user edit\n')

    await assert.rejects(applyFallbackEntry(staged, linkPath), /drifted after journaling/)
    assert.equal(readFileSync(linkPath, 'utf8'), 'concurrent user edit\n')
    assert.equal(existsSync(fallbackJournalPath(manifest.trackingPath)), true)
    const reloaded = JSON.parse(readFileSync(fallbackJournalPath(manifest.trackingPath), 'utf8'))
    const entry = reloaded.entries.find((candidate: { path: string }) => candidate.path === linkPath)
    assert.ok(entry.stage)
    assert.equal(readFileSync(entry.stage, 'utf8'), '# new bundle\n')
  })

  it('aborts the swap when a journaled-missing destination was created concurrently', async () => {
    const { manifest } = await setupValidFixture()
    const destination = path.join(getSkillsDir(), 'fresh-skill')
    manifest.bundleDestinations = [{ path: destination, kind: 'missing' }]
    const { handle: fresh } = await beginFallbackJournal(manifest)
    await markFallbackJournalMutating(fresh)
    const handle = await claimFallbackJournalMutation(manifest, manifestDigestOf(manifest))
    assert.ok(handle)
    const stageSource = mkdtempSync(path.join(path.dirname(destination), '.stage-src-'))
    mkdirSync(path.join(stageSource, 'payload'), { recursive: true })
    writeFileSync(path.join(stageSource, 'payload', 'SKILL.md'), 'fresh\n')
    const staged = await registerFallbackStage(handle, destination, { directory: path.join(stageSource, 'payload') })
    mkdirSync(destination, { recursive: true })
    writeFileSync(path.join(destination, 'user-file.txt'), 'precious\n')

    await assert.rejects(applyFallbackEntry(staged, destination), /drifted after journaling/)
    assert.equal(readFileSync(path.join(destination, 'user-file.txt'), 'utf8'), 'precious\n')
    rmSync(stageSource, { recursive: true, force: true })
  })

  it('refuses a no-stage apply for a planned-missing destination it never owned', async () => {
    const { manifest } = await setupValidFixture()
    const destination = path.join(getSkillsDir(), 'unauthorized-fresh-skill')
    manifest.bundleDestinations = [{ path: destination, kind: 'missing' }]
    const { handle: fresh } = await beginFallbackJournal(manifest)
    await markFallbackJournalMutating(fresh)
    // A planned-missing bundle destination is creation authority only: without
    // a registered stage there is nothing authenticated to swap in, and the
    // manifest's owned evidence (ownedSkills/ownedLinks) never authorizes
    // deleting it. An owned no-stage apply is the valid deletion-only path
    // covered by the test above; this refusal is genuinely unauthorized.
    const handle = await claimFallbackJournalMutation(manifest, manifestDigestOf(manifest))
    assert.ok(handle)
    await assert.rejects(applyFallbackEntry(handle, destination), /No registered stage capability/)
    assert.equal(existsSync(destination), false, 'the unauthorized target must stay untouched')
    assert.equal(
      readdirSync(path.dirname(destination)).filter((name) => name.includes('.nsolid-quarantine-')).length,
      0,
      'a refused no-stage apply must not create any quarantine container'
    )
  })

  it('keeps next-run recovery strictly restore-only, scoped to tracking-owned paths', async () => {
    const { trackingPath, skillPath, manifest } = await setupValidFixture()
    const destination = path.join(getSkillsDir(), 'added')
    manifest.bundleDestinations = [{ path: destination, kind: 'missing' }]
    const { handle: fresh } = await beginFallbackJournal(manifest)
    await markFallbackJournalMutating(fresh)
    const claimed = await claimFallbackJournalMutation(manifest, manifestDigestOf(manifest))
    assert.ok(claimed)
    const stageSource = mkdtempSync(path.join(path.dirname(destination), '.stage-src-'))
    mkdirSync(path.join(stageSource, 'payload'), { recursive: true })
    writeFileSync(path.join(stageSource, 'payload', 'SKILL.md'), 'new skill\n')
    let handle = await registerFallbackStage(claimed, destination, { directory: path.join(stageSource, 'payload') })
    handle = await applyFallbackEntry(handle, destination)
    writeFileSync(path.join(skillPath, 'SKILL.md'), '# mutated by crashed child\n')
    assert.equal(existsSync(handle.journalPath), true)

    const recovery = await recoverFallbackJournal(trackingPath)
    assert.equal(recovery.pending, true, 'next-run recovery never claims completion')
    assert.equal(recovery.recovered, true, 'the tracking-owned skill was restored')
    assert.equal(readFileSync(path.join(skillPath, 'SKILL.md'), 'utf8'), '# tracked\n')
    assert.equal(existsSync(destination), true, 'a non-owned destination is preserved, not restored or deleted')
    // Journal and snapshot survive next-run recovery untouched.
    assert.equal(existsSync(handle.journalPath), true)
    assert.ok(recovery.preservedArtifacts.includes(handle.journalPath))
    assert.ok(existsSync(handle.journalPath))
    rmSync(stageSource, { recursive: true, force: true })
  })

  it('refuses next-run recovery when the tracking backup disagrees with the planned manifest digest', async () => {
    const { trackingPath, skillPath, manifest, trackingJson } = await setupValidFixture()
    const { handle } = await beginFallbackJournal(manifest)
    await markFallbackJournalMutating(handle)
    // Drift an owned skill so any live mutation ordered before the tracking
    // install would be observable: the preflight must leave it drifted.
    writeFileSync(path.join(skillPath, 'SKILL.md'), '# mutated by crashed child\n')
    // Forge ONLY the tracking backup and its journaled entry digest: valid
    // tracking JSON carrying an extra ownership declaration, while the
    // manifest and its hash stay exactly as planned.
    const disk = JSON.parse(readFileSync(handle.journalPath, 'utf8')) as { manifest: FallbackTransactionIdentity; manifestDigest: string; entries: Array<{ path: string; backup?: string; digest?: string }> }
    const trackingEntry = disk.entries.find((entry) => path.resolve(entry.path) === path.resolve(manifest.trackingPath))
    assert.ok(trackingEntry?.backup)
    const forged = JSON.parse(trackingJson) as { skills: Array<{ name: string; path: string; paths: Record<string, string>; installedAt: string; harnesses: string[] }> }
    forged.skills.push({ name: 'forged', path: path.join(home, 'forged-skill'), paths: { claude: path.join(home, 'forged-skill') }, installedAt: new Date().toISOString(), harnesses: ['claude'] })
    writeFileSync(trackingEntry.backup, `${JSON.stringify(forged, null, 2)}\n`)
    trackingEntry.digest = await pathDigest(trackingEntry.backup)
    writeFileSync(handle.journalPath, `${JSON.stringify(disk, null, 2)}\n`)
    // Only the tracking backup and its entry digest changed: the manifest
    // and its hash are exactly as planned.
    const reloaded = JSON.parse(readFileSync(handle.journalPath, 'utf8')) as { manifest: FallbackTransactionIdentity; manifestDigest: string }
    assert.equal(canonicalJsonString(reloaded.manifest), canonicalJsonString(manifest))
    assert.equal(reloaded.manifestDigest, manifestDigestOf(manifest))
    const snapshotDirectory = (JSON.parse(readFileSync(handle.journalPath, 'utf8')) as { snapshotDirectory: string }).snapshotDirectory

    // Fresh restart: the original handle is never handed to recovery.
    const recovery = await recoverFallbackJournal(trackingPath)
    assert.equal(recovery.pending, true, 'next-run recovery never claims completion')
    assert.equal(recovery.recovered, false, 'a tracking backup that disagrees with the manifest digest must fail closed')
    assert.deepEqual(recovery.restoredPaths, [], 'nothing may be restored when tracking evidence is tampered')
    assert.equal(readFileSync(trackingPath, 'utf8'), trackingJson, 'the forged tracking backup must not be installed')
    assert.equal(readFileSync(path.join(skillPath, 'SKILL.md'), 'utf8'), '# mutated by crashed child\n', 'no live path may be mutated before the tampered tracking is detected')
    // Journal and snapshot survive for deliberate manual cleanup.
    assert.equal(existsSync(handle.journalPath), true)
    assert.equal(existsSync(snapshotDirectory), true)
    assert.ok(recovery.preservedArtifacts.includes(handle.journalPath))
  })

  it('restores owned bytes on untampered next-run recovery', async () => {
    const { trackingPath, skillPath, manifest, trackingJson } = await setupValidFixture()
    const { handle } = await beginFallbackJournal(manifest)
    await markFallbackJournalMutating(handle)
    writeFileSync(path.join(skillPath, 'SKILL.md'), '# mutated by crashed child\n')

    // Fresh restart: the original handle is never handed to recovery.
    const recovery = await recoverFallbackJournal(trackingPath)
    assert.equal(recovery.pending, true, 'next-run recovery never claims completion')
    assert.equal(recovery.recovered, true, 'the untampered tracking-owned skill was restored')
    assert.ok(recovery.restoredPaths.includes(path.resolve(skillPath)))
    assert.equal(readFileSync(path.join(skillPath, 'SKILL.md'), 'utf8'), '# tracked\n')
    assert.equal(readFileSync(trackingPath, 'utf8'), trackingJson, 'untampered tracking stays byte-identical')
    // Journal and snapshot survive next-run recovery untouched.
    assert.equal(existsSync(handle.journalPath), true)
    assert.ok(recovery.preservedArtifacts.includes(handle.journalPath))
  })

  it('keeps next-run recovery preserve-only when an owned skill parent was replaced by a link to a foreign directory', { skip: process.platform !== 'linux' }, async () => {
    const { trackingPath, skillPath, manifest } = await setupValidFixture()
    const { handle } = await beginFallbackJournal(manifest)
    await markFallbackJournalMutating(handle)
    // The owned skill drifts so recovery must attempt its restore instead of
    // skipping an already-matching path.
    writeFileSync(path.join(skillPath, 'SKILL.md'), '# mutated by crashed child\n')

    // A foreign directory tree whose same-named skill carries sentinel bytes:
    // a substituted ancestor must never redirect the recovery copy into it.
    const foreignRoot = mkdtempSync(path.join(os.tmpdir(), 'nsolid-foreign-'))
    const foreignSkills = path.join(foreignRoot, 'skills')
    const sentinel = '# foreign sentinel bytes\n'
    mkdirSync(path.join(foreignSkills, 'tracked'), { recursive: true })
    writeFileSync(path.join(foreignSkills, 'tracked', 'SKILL.md'), sentinel)

    const skillParent = path.dirname(skillPath)
    const movedParent = path.join(path.dirname(skillParent), `skills.moved-${randomUUID()}`)
    renameSync(skillParent, movedParent)
    symlinkSync(foreignSkills, skillParent)

    try {
      const recovery = await recoverFallbackJournal(trackingPath)
      assert.equal(recovery.pending, true, 'next-run recovery never claims completion')
      assert.equal(recovery.recovered, false, 'the linked ancestor makes the restore unprovable')
      assert.ok(recovery.preservedPaths.includes(path.resolve(skillPath)), 'the owned target is reported preserved')
      // The foreign tree is byte-identical and structurally untouched.
      assert.equal(readFileSync(path.join(foreignSkills, 'tracked', 'SKILL.md'), 'utf8'), sentinel)
      assert.deepEqual(readdirSync(foreignSkills).sort(), ['tracked'])
      assert.deepEqual(readdirSync(foreignRoot).sort(), ['skills'])
      // No recovery storage was created beside the real parent or through the
      // substituted link into the foreign tree.
      assert.deepEqual(readdirSync(path.dirname(skillParent)).filter((name) => name.startsWith('.nsolid-recovery-')), [])
      // Journal and snapshot survive next-run recovery untouched.
      assert.equal(existsSync(handle.journalPath), true)
      assert.ok(recovery.preservedArtifacts.includes(handle.journalPath))
      const journal = JSON.parse(readFileSync(handle.journalPath, 'utf8')) as { snapshotDirectory?: string }
      assert.equal(existsSync(journal.snapshotDirectory!), true)
    } finally {
      rmSync(skillParent, { force: true })
      rmSync(movedParent, { recursive: true, force: true })
      rmSync(foreignRoot, { recursive: true, force: true })
    }
  })

  it('reports a byte-identical skill under a substituted parent as preserved for manual inspection on check', { skip: process.platform !== 'linux' }, async () => {
    const { trackingPath, skillPath, manifest } = await setupValidFixture()
    const { handle } = await beginFallbackJournal(manifest)
    await markFallbackJournalMutating(handle)
    // No drift: the live skill stays byte-identical to the tracked backup.
    // A foreign directory tree carries the SAME bytes under the same name,
    // so digest equality alone must never reassure.
    const foreignRoot = mkdtempSync(path.join(os.tmpdir(), 'nsolid-foreign-'))
    const foreignSkills = path.join(foreignRoot, 'skills')
    mkdirSync(path.join(foreignSkills, 'tracked'), { recursive: true })
    writeFileSync(path.join(foreignSkills, 'tracked', 'SKILL.md'), '# tracked\n')
    const journalBefore = readFileSync(handle.journalPath, 'utf8')

    const skillParent = path.dirname(skillPath)
    const movedParent = path.join(path.dirname(skillParent), `skills.moved-${randomUUID()}`)
    renameSync(skillParent, movedParent)
    symlinkSync(foreignSkills, skillParent)

    try {
      const inspection = await inspectFallbackJournal(trackingPath)
      assert.equal(inspection.pending, true, 'inspection never claims completion')
      assert.equal(inspection.recovered, false, 'byte-identical bytes under a substituted ancestor are unproven')
      assert.ok(inspection.preservedPaths.includes(path.resolve(skillPath)), 'the owned target is named for manual inspection')
      assert.deepEqual(inspection.restoredPaths, [], 'an inspection never restores')
      // Read-only: the live bytes, the foreign tree, and the journal are untouched...
      assert.equal(readFileSync(path.join(skillPath, 'SKILL.md'), 'utf8'), '# tracked\n')
      assert.equal(readFileSync(path.join(foreignSkills, 'tracked', 'SKILL.md'), 'utf8'), '# tracked\n')
      assert.deepEqual(readdirSync(foreignSkills).sort(), ['tracked'])
      assert.deepEqual(readdirSync(foreignRoot).sort(), ['skills'])
      assert.equal(readFileSync(handle.journalPath, 'utf8'), journalBefore)
      // ...and no recovery storage was created beside the real parent or
      // through the substituted link into the foreign tree.
      assert.deepEqual(readdirSync(path.dirname(skillParent)).filter((name) => name.startsWith('.nsolid-recovery-')), [])
    } finally {
      rmSync(skillParent, { force: true })
      rmSync(movedParent, { recursive: true, force: true })
      rmSync(foreignRoot, { recursive: true, force: true })
    }
  })

  it('keeps next-run recovery pending and untouched for forged committed and legacy v2 journals', async () => {
    const { trackingPath, skillPath, manifest } = await setupValidFixture()
    const { handle } = await beginFallbackJournal(manifest)
    // A forged committed phase is not a valid v3 phase: strict load fails and
    // nothing is cleaned.
    const forged = JSON.parse(readFileSync(handle.journalPath, 'utf8'))
    forged.phase = 'committed'
    writeFileSync(handle.journalPath, JSON.stringify(forged))
    let recovery = await recoverFallbackJournal(trackingPath)
    assert.equal(recovery.pending, true)
    assert.equal(recovery.recovered, false)
    assert.equal(existsSync(handle.journalPath), true)
    assert.equal(readFileSync(path.join(skillPath, 'SKILL.md'), 'utf8'), '# tracked\n')

    // Journal version 2 was never deployed: preserved pending, no migration.
    rmSync(handle.journalPath, { force: true })
    const legacy = { version: 2, phase: 'mutating', manifest, journalPath: handle.journalPath, snapshotDirectory: handle.journalPath.replace(/json$/, 'snapshot'), entries: [] }
    writeFileSync(handle.journalPath, JSON.stringify(legacy))
    recovery = await recoverFallbackJournal(trackingPath)
    assert.equal(recovery.pending, true)
    assert.equal(recovery.recovered, false)
    assert.equal(existsSync(handle.journalPath), true)
    // And a begin over any pending journal is busy.
    await assert.rejects(beginFallbackJournal(manifest), /FALLBACK_JOURNAL_BUSY/)
  })

  it('keeps next-run recovery pending while the recorded mutator is a live different process', { skip: process.platform !== 'linux' }, async () => {
    const { trackingPath, manifest } = await setupValidFixture()
    const { handle } = await beginFallbackJournal(manifest)
    const live = await spawnLiveProcessFixture()
    const childPid: number = live.pid
    try {
      const disk = JSON.parse(readFileSync(handle.journalPath, 'utf8'))
      disk.phase = 'mutating'
      disk.mutator = { pid: childPid, startIdentity: live.startIdentity, claimedAt: new Date().toISOString() }
      writeFileSync(handle.journalPath, JSON.stringify(disk))

      const recovery = await recoverFallbackJournal(trackingPath)
      assert.equal(recovery.pending, true)
      assert.equal(recovery.recovered, false)
    } finally {
      await live.stop()
    }
  })

  it('rejects begin for a manifest with a missing or unknown protocol version before creating anything', async () => {
    const { manifest } = await setupValidFixture()
    const trackingDir = path.dirname(manifest.trackingPath)
    for (const protocolVersion of [undefined, 2, FALLBACK_PROTOCOL_VERSION + 1]) {
      const broken = { ...manifest, protocolVersion } as unknown as FallbackTransactionIdentity
      await assert.rejects(beginFallbackJournal(broken), /FALLBACK_PROTOCOL_UNSUPPORTED/)
      // The gate fires before the reservation and before any snapshot work.
      assert.equal(existsSync(fallbackJournalPath(manifest.trackingPath)), false)
      assert.deepEqual(readdirSync(trackingDir).filter((name) => name.startsWith('.nsolid-plugin-update-')), [])
    }
  })

  it('refuses a mutation claim for an unsupported protocol version and leaves the journal byte-identical', async () => {
    const { manifest } = await setupValidFixture()
    const { handle } = await beginFallbackJournal(manifest)
    const owner = await markFallbackJournalMutating(handle)
    const before = readFileSync(owner.journalPath, 'utf8')
    for (const protocolVersion of [undefined, FALLBACK_PROTOCOL_VERSION + 1]) {
      const broken = { ...manifest, protocolVersion } as unknown as FallbackTransactionIdentity
      await assert.rejects(claimFallbackJournalMutation(broken), /FALLBACK_PROTOCOL_UNSUPPORTED/)
    }
    assert.equal(readFileSync(owner.journalPath, 'utf8'), before, 'a refused claim must not mutate the journal')
  })

  it('rejects begin for absent, malformed, or tampered frontier evidence before creating anything', async () => {
    const { manifest } = await setupValidFixture()
    const trackingDir = path.dirname(manifest.trackingPath)
    const absent: Record<string, unknown> = { ...manifest }
    delete absent.plannedMissingFrontiers
    const anchorPath = path.dirname(manifest.trackingPath)
    const frontierPath = path.join(anchorPath, 'missing-destination')
    const forgedFrontier = {
      frontierPath,
      activation: 'required',
      anchor: { path: anchorPath, realpath: anchorPath, device: '1', inode: '1', type: 'directory' },
      leaves: [{ id: 'skill:forged', role: 'skill', activation: 'required', path: path.join(frontierPath, 'skill') }],
    }
    const cases: unknown[] = [
      // Absent field: protocol v3 has no absent-field fallback.
      absent,
      // Non-array evidence.
      { ...manifest, plannedMissingFrontiers: 'none' },
      // Extra key on the frontier evidence object.
      { ...manifest, plannedMissingFrontiers: [{ ...forgedFrontier, extraKey: true }] },
      // Anchor missing a required identity field.
      { ...manifest, plannedMissingFrontiers: [{ ...forgedFrontier, anchor: { path: anchorPath, realpath: anchorPath, device: '1', inode: '1' } }] },
      // Extra key nested inside a leaf.
      { ...manifest, plannedMissingFrontiers: [{ ...forgedFrontier, leaves: [{ ...forgedFrontier.leaves[0], extra: 1 }] }] },
      // Tampered graph: frontier evidence must stay strictly sorted.
      { ...manifest, plannedMissingFrontiers: [forgedFrontier, { ...forgedFrontier, frontierPath: path.join(anchorPath, 'a-missing-destination') }] },
    ]
    for (const [index, broken] of cases.entries()) {
      await assert.rejects(beginFallbackJournal(broken as unknown as FallbackTransactionIdentity), /FALLBACK_FRONTIER_EVIDENCE_INVALID/, `frontier case ${index} must fail closed`)
      // The gate fires before the reservation and before any snapshot work.
      assert.equal(existsSync(fallbackJournalPath(manifest.trackingPath)), false)
      assert.deepEqual(readdirSync(trackingDir).filter((name) => name.startsWith('.nsolid-plugin-update-')), [])
    }
  })

  it('refuses a mutation claim whose frontier evidence fails strict parsing and leaves the journal byte-identical', async () => {
    const { manifest } = await setupValidFixture()
    const { handle } = await beginFallbackJournal(manifest)
    await markFallbackJournalMutating(handle)
    const before = readFileSync(handle.journalPath, 'utf8')
    const absent: Record<string, unknown> = { ...manifest }
    delete absent.plannedMissingFrontiers
    await assert.rejects(claimFallbackJournalMutation(absent as unknown as FallbackTransactionIdentity), /FALLBACK_FRONTIER_EVIDENCE_INVALID/)
    assert.equal(readFileSync(handle.journalPath, 'utf8'), before, 'a refused claim must not mutate the journal')
  })

  it('rejects begin for self-consistent but globally impossible frontier graphs before creating anything', async () => {
    const { manifest } = await setupValidFixture()
    const trackingDir = path.dirname(manifest.trackingPath)
    const anchorPath = path.dirname(manifest.trackingPath)
    const anchor = { path: anchorPath, realpath: anchorPath, device: '1', inode: '1', type: 'directory' }
    // Every frontier below is individually well-formed for the strict parser;
    // only the whole-graph rules can reject them.
    const nestedLeaves = {
      frontierPath: path.join(anchorPath, 'impossible-frontier'),
      activation: 'required',
      anchor,
      leaves: [
        { id: 'skill:nested-parent', role: 'skill', activation: 'required', path: path.join(anchorPath, 'impossible-frontier', 'a') },
        { id: 'link:nested-child', role: 'link', activation: 'conditional', path: path.join(anchorPath, 'impossible-frontier', 'a', 'b') },
      ],
    }
    const duplicateLeafId = [
      {
        frontierPath: path.join(anchorPath, 'za-frontier'),
        activation: 'required',
        anchor,
        leaves: [{ id: 'dup', role: 'skill', activation: 'required', path: path.join(anchorPath, 'za-frontier', 'x') }],
      },
      {
        frontierPath: path.join(anchorPath, 'zb-frontier'),
        activation: 'required',
        anchor,
        leaves: [{ id: 'dup', role: 'skill', activation: 'required', path: path.join(anchorPath, 'zb-frontier', 'y') }],
      },
    ]
    const activationLie = {
      frontierPath: path.join(anchorPath, 'activation-lie'),
      activation: 'required',
      anchor,
      leaves: [{ id: 'config:conditional', role: 'mcp-config', activation: 'conditional', path: path.join(anchorPath, 'activation-lie', 'cfg.json') }],
    }
    const linkSelfLeaf = {
      frontierPath: path.join(anchorPath, 'self-frontier'),
      activation: 'required',
      anchor,
      leaves: [{ id: 'link:self', role: 'link', activation: 'required', path: path.join(anchorPath, 'self-frontier') }],
    }
    // The manifest field is a frontier list: the three singleton graphs are
    // wrapped in arrays so each one reaches the whole-graph validator instead
    // of being rejected by array-shape parsing. duplicateLeafId is already a
    // list and stays unchanged.
    const cases = [[nestedLeaves], duplicateLeafId, [activationLie], [linkSelfLeaf]]
    for (const [index, frontiers] of cases.entries()) {
      // Prove the rejection layer directly: the strict frontier parser — the
      // same whole-graph validator begin applies before reserving anything —
      // refuses every one of these graphs on its own.
      assert.throws(
        () => assertFallbackFrontierEvidenceList(frontiers),
        (error: unknown) => error instanceof FallbackFrontierError,
        `impossible graph case ${index} must be refused by the strict frontier parser itself`
      )
      const broken = { ...manifest, plannedMissingFrontiers: frontiers } as unknown as FallbackTransactionIdentity
      await assert.rejects(beginFallbackJournal(broken), /FALLBACK_FRONTIER_EVIDENCE_INVALID/, `impossible graph case ${index} must fail closed`)
      // The gate fires before the reservation and before any snapshot work.
      assert.equal(existsSync(fallbackJournalPath(manifest.trackingPath)), false)
      assert.deepEqual(readdirSync(trackingDir).filter((name) => name.startsWith('.nsolid-plugin-update-')), [])
    }
  })

  it('refuses a mutation claim carrying a globally impossible frontier graph and leaves the journal byte-identical', async () => {
    const { manifest } = await setupValidFixture()
    const { handle } = await beginFallbackJournal(manifest)
    await markFallbackJournalMutating(handle)
    const before = readFileSync(handle.journalPath, 'utf8')
    const anchorPath = path.dirname(manifest.trackingPath)
    // The frontier gate runs before any journal read or digest comparison, so
    // the impossible graph itself must refuse the claim.
    const impossible = [{
      frontierPath: path.join(anchorPath, 'impossible-frontier'),
      activation: 'required',
      anchor: { path: anchorPath, realpath: anchorPath, device: '1', inode: '1', type: 'directory' },
      leaves: [
        { id: 'skill:nested-parent', role: 'skill', activation: 'required', path: path.join(anchorPath, 'impossible-frontier', 'a') },
        { id: 'link:nested-child', role: 'link', activation: 'conditional', path: path.join(anchorPath, 'impossible-frontier', 'a', 'b') },
      ],
    }]
    const broken = { ...manifest, plannedMissingFrontiers: impossible } as unknown as FallbackTransactionIdentity
    await assert.rejects(claimFallbackJournalMutation(broken), /FALLBACK_FRONTIER_EVIDENCE_INVALID/)
    assert.equal(readFileSync(handle.journalPath, 'utf8'), before, 'a refused claim must not mutate the journal')
  })

  it('refuses next-run recovery of an on-disk v3 journal whose manifest lacks frontier evidence', { skip: process.platform !== 'linux' }, async () => {
    const { manifest } = await setupValidFixture()
    const { handle } = await beginFallbackJournal(manifest)
    await markFallbackJournalMutating(handle)
    const live = await spawnLiveProcessFixture()
    const childPid: number = live.pid
    try {
      // Re-serialize the disk journal WITHOUT the frontier field and re-sign
      // its manifest digest, with a live mutator: every other recovery check
      // would pass, so only the strict isSafeJournal frontier gate can refuse
      // this journal as v3 transaction state. (The previous comment said
      // "dead mutator", but the fixture child was alive the whole time; the
      // refusal comes from the frontier gate, not from mutator liveness.)
      const disk = JSON.parse(readFileSync(handle.journalPath, 'utf8')) as { manifest: Record<string, unknown>; manifestDigest: string; phase: string; mutator: unknown }
      disk.phase = 'mutating'
      disk.mutator = { pid: childPid, startIdentity: live.startIdentity, claimedAt: new Date().toISOString() }
      delete disk.manifest.plannedMissingFrontiers
      disk.manifestDigest = manifestDigestOf(disk.manifest as unknown as FallbackTransactionIdentity)
      writeFileSync(handle.journalPath, JSON.stringify(disk))
      const recovery = await recoverFallbackJournal(manifest.trackingPath)
      assert.equal(recovery.pending, true)
      assert.equal(recovery.recovered, false)
      // strictLoad fails before any snapshot evidence is trusted: only the
      // unauthenticated journal artifact is reported preserved.
      assert.deepEqual(recovery.preservedArtifacts, [handle.journalPath])
      assert.deepEqual(recovery.preservedPaths, [])
    } finally {
      await live.stop()
    }
  })

  it('refuses a plain self-consistent journal as restore authority and preserves everything', async () => {
    const { skillPath, manifest } = await setupValidFixture()
    const { handle } = await beginFallbackJournal(manifest)
    await markFallbackJournalMutating(handle)
    writeFileSync(path.join(skillPath, 'SKILL.md'), '# mutated while plain\n')
    // The exact bytes on disk, read back WITHOUT the owner's handle: even a
    // perfectly self-consistent v3 journal must never be destructive authority
    // on its own. Only the in-process handle (with its trusted manifest and
    // capabilities) restores; next-run recovery's restricted tracking-scoped
    // path lives in recoverFallbackJournal.
    const plain = JSON.parse(readFileSync(handle.journalPath, 'utf8')) as unknown as FallbackJournalHandle
    const result = await restoreFallbackJournal(plain)
    assert.equal(result.succeeded, false)
    assert.equal(result.unproven, true)
    assert.deepEqual(result.preservedPaths, [])
    assert.equal(readFileSync(path.join(skillPath, 'SKILL.md'), 'utf8'), '# mutated while plain\n', 'no restore may run from plain disk state')
    assert.equal(existsSync(handle.journalPath), true, 'the journal must survive a refused plain restore')
    const snapshot = JSON.parse(readFileSync(handle.journalPath, 'utf8')).snapshotDirectory as string
    assert.equal(existsSync(snapshot), true, 'the snapshot must survive a refused plain restore')
  })

  it('refuses a plain self-consistent journal as commit authority and disposes nothing', async () => {
    const { skillPath, manifest } = await setupValidFixture()
    const { handle } = await beginFallbackJournal(manifest)
    await markFallbackJournalMutating(handle)
    const plain = JSON.parse(readFileSync(handle.journalPath, 'utf8')) as unknown as FallbackJournalHandle
    await assert.rejects(commitFallbackJournal(plain), /Invalid fallback journal/)
    assert.equal(existsSync(handle.journalPath), true, 'the journal must survive a refused plain commit')
    const snapshot = JSON.parse(readFileSync(handle.journalPath, 'utf8')).snapshotDirectory as string
    assert.equal(existsSync(snapshot), true, 'the snapshot must survive a refused plain commit')
    assert.equal(readFileSync(path.join(skillPath, 'SKILL.md'), 'utf8'), '# tracked\n')
  })

  it('pins the fallback digest framing with fixed vectors', async () => {
    const { createHash } = await import('node:crypto')
    const file = path.join(home, 'vector.txt')
    writeFileSync(file, 'vector')
    assert.equal(await pathDigest(file), createHash('sha256').update('file\0vector').digest('hex'))
    const target = path.join(home, 'target.txt')
    writeFileSync(target, 't')
    const link = path.join(home, 'link.txt')
    if (process.platform !== 'win32') {
      const { symlinkSync } = await import('node:fs')
      symlinkSync(target, link, 'file')
      assert.equal(await pathDigest(link), createHash('sha256').update(`symlink\0${target}`).digest('hex'))
    }
    assert.equal(await pathKind(file), 'file')
    assert.equal(await pathKind(path.join(home, 'absent')), 'missing')
  })
})

describe('fallback journal authenticated artifact cleanup', () => {
  it('preserves a stage container that carries unexpected sentinel content instead of deleting it', async () => {
    const { manifest, skillPath } = await setupValidFixture()
    const { handle: fresh } = await beginFallbackJournal(manifest)
    await markFallbackJournalMutating(fresh)
    const claimed = await claimFallbackJournalMutation(manifest, manifestDigestOf(manifest))
    assert.ok(claimed)
    const stageSource = mkdtempSync(path.join(path.dirname(skillPath), '.stage-src-'))
    mkdirSync(path.join(stageSource, 'payload'), { recursive: true })
    writeFileSync(path.join(stageSource, 'payload', 'SKILL.md'), 'new bundle\n')
    const staged = await registerFallbackStage(claimed, skillPath, { directory: path.join(stageSource, 'payload') })
    // Stuff an unexpected sentinel into the stage container after registration:
    // authenticated cleanup must refuse to recursively delete it.
    const journaled = JSON.parse(readFileSync(fresh.journalPath, 'utf8'))
    const entry = journaled.entries.find((candidate: { path: string }) => path.resolve(candidate.path) === path.resolve(skillPath))
    const stageContainer = path.dirname(entry.stage)
    writeFileSync(path.join(stageContainer, '.user-sentinel'), 'KEEP')

    await applyFallbackEntry(staged, skillPath)
    // The swap itself still succeeded: the staged payload moved into the live
    // path, out of its container...
    assert.equal(readFileSync(path.join(skillPath, 'SKILL.md'), 'utf8'), 'new bundle\n')
    // ...but the sentinel-bearing container survived intact and was reported.
    const siblings = readdirSync(path.dirname(skillPath)).filter((name) => name.includes('.nsolid-stage-'))
    assert.equal(siblings.length, 1)
    const container = path.join(path.dirname(skillPath), siblings[0])
    assert.equal(existsSync(path.join(container, 'payload')), false, 'the payload legitimately moved into the live path')
    assert.equal(readFileSync(path.join(container, '.user-sentinel'), 'utf8'), 'KEEP')
    const residues = JSON.parse(readFileSync(fresh.journalPath, 'utf8'))
    assert.ok((residues.preservedArtifacts ?? []).some((artifact: string) => path.resolve(artifact) === path.resolve(container)))
    rmSync(stageSource, { recursive: true, force: true })
  })

  it('preserves a swap quarantine when unexpected content appears inside the removal window', async () => {
    const { manifest, skillPath } = await setupValidFixture()
    const { handle: fresh } = await beginFallbackJournal(manifest)
    await markFallbackJournalMutating(fresh)
    const claimed = await claimFallbackJournalMutation(manifest, manifestDigestOf(manifest))
    assert.ok(claimed)
    const stageSource = mkdtempSync(path.join(path.dirname(skillPath), '.stage-src-'))
    mkdirSync(path.join(stageSource, 'payload'), { recursive: true })
    writeFileSync(path.join(stageSource, 'payload', 'SKILL.md'), 'new bundle\n')
    let injected = false
    setFallbackArtifactSwapSeamForTests(async (artifact) => {
      // Deterministic awaited seam: the quarantine (the replaced bytes) gets
      // an unexpected sentinel after validation but before the tombstone
      // rename, so the whole container must be preserved, not deleted.
      if (artifact.role === 'quarantine' && !injected) {
        injected = true
        writeFileSync(path.join(artifact.container, '.user-sentinel'), 'KEEP')
      }
    })
    try {
      const staged = await registerFallbackStage(claimed, skillPath, { directory: path.join(stageSource, 'payload') })
      const applied = await applyFallbackEntry(staged, skillPath)
      assert.ok(applied)
      assert.equal(readFileSync(path.join(skillPath, 'SKILL.md'), 'utf8'), 'new bundle\n')
      const quarantines = readdirSync(path.dirname(skillPath)).filter((name) => name.includes('.nsolid-quarantine-'))
      assert.equal(quarantines.length, 1)
      const container = path.join(path.dirname(skillPath), quarantines[0])
      assert.equal(readFileSync(path.join(container, 'tracked', 'SKILL.md'), 'utf8'), '# tracked\n')
      assert.equal(readFileSync(path.join(container, '.user-sentinel'), 'utf8'), 'KEEP')
      const residues = JSON.parse(readFileSync(fresh.journalPath, 'utf8'))
      assert.ok((residues.preservedArtifacts ?? []).some((artifact: string) => path.resolve(artifact) === path.resolve(container)))
    } finally {
      setFallbackArtifactSwapSeamForTests(undefined)
      rmSync(stageSource, { recursive: true, force: true })
    }
  })

  it('preserves a restore quarantine when unexpected content appears inside the removal window', async () => {
    const { skillPath, manifest } = await setupValidFixture()
    const { handle } = await beginFallbackJournal(manifest)
    const owner = await markFallbackJournalMutating(handle)
    writeFileSync(path.join(skillPath, 'SKILL.md'), '# mutated\n')
    writeFileSync(path.join(skillPath, 'user-edit.txt'), 'concurrent user edit\n')
    let injected = false
    setFallbackArtifactSwapSeamForTests(async (artifact) => {
      if (artifact.role === 'restore' && !injected) {
        injected = true
        writeFileSync(path.join(artifact.container, '.user-sentinel'), 'KEEP')
      }
    })
    try {
      const result = await restoreFallbackJournal(owner)
      assert.equal(result.succeeded, true)
      assert.equal(readFileSync(path.join(skillPath, 'SKILL.md'), 'utf8'), '# tracked\n')
      // The drifted bytes were quarantined; the sentinel-bearing container
      // survived and was reported instead of being destroyed.
      const quarantines = readdirSync(path.dirname(skillPath)).filter((name) => name.includes('.nsolid-quarantine-'))
      assert.equal(quarantines.length, 1)
      const container = path.join(path.dirname(skillPath), quarantines[0])
      assert.ok(result.preservedArtifacts.includes(container))
      assert.equal(readFileSync(path.join(container, 'tracked', 'user-edit.txt'), 'utf8'), 'concurrent user edit\n')
      assert.equal(readFileSync(path.join(container, '.user-sentinel'), 'utf8'), 'KEEP')
      assert.equal(existsSync(owner.journalPath), false)
    } finally {
      setFallbackArtifactSwapSeamForTests(undefined)
    }
  })

  it('preserves the snapshot when it carries unexpected sentinel content during commit', async () => {
    const { manifest } = await setupValidFixture()
    const { handle } = await beginFallbackJournal(manifest)
    const owner = await markFallbackJournalMutating(handle)
    const disk = JSON.parse(readFileSync(owner.journalPath, 'utf8'))
    const snapshot = disk.snapshotDirectory as string
    writeFileSync(path.join(snapshot, '.user-sentinel'), 'KEEP')

    const result = await commitFallbackJournal(owner)
    assert.equal(result.succeeded, true)
    assert.ok(result.preservedArtifacts.includes(snapshot))
    assert.equal(existsSync(snapshot), true)
    assert.equal(readFileSync(path.join(snapshot, '.user-sentinel'), 'utf8'), 'KEEP')
    assert.equal(readFileSync(path.join(snapshot, '1', 'SKILL.md'), 'utf8'), '# tracked\n')
    assert.equal(existsSync(owner.journalPath), false)
  })

  it('preserves the snapshot when a backup child was replaced with a symlink', async () => {
    const { manifest, linkPath } = await setupValidFixture()
    const { handle } = await beginFallbackJournal(manifest)
    const owner = await markFallbackJournalMutating(handle)
    const disk = JSON.parse(readFileSync(owner.journalPath, 'utf8'))
    const snapshot = disk.snapshotDirectory as string
    const linkEntry = disk.entries.find((entry: { path: string }) => path.resolve(entry.path) === path.resolve(linkPath))
    rmSync(linkEntry.backup, { recursive: true, force: true })
    symlinkSync(path.join(home, 'elsewhere'), linkEntry.backup, 'file')

    const result = await commitFallbackJournal(owner)
    assert.equal(result.succeeded, true)
    assert.ok(result.preservedArtifacts.includes(snapshot))
    assert.equal(existsSync(snapshot), true)
    assert.equal(readlinkSync(linkEntry.backup), path.join(home, 'elsewhere'))
  })

  it('never deletes a replacement swapped into the container path before the tombstone rename', async () => {
    const { manifest } = await setupValidFixture()
    const { handle } = await beginFallbackJournal(manifest)
    const owner = await markFallbackJournalMutating(handle)
    const disk = JSON.parse(readFileSync(owner.journalPath, 'utf8'))
    const snapshot = disk.snapshotDirectory as string
    const stash = path.join(home, 'attacker-stash')
    mkdirSync(stash, { recursive: true })
    setFallbackArtifactSwapSeamForTests(async (artifact) => {
      if (artifact.role === 'snapshot' && artifact.container === path.resolve(snapshot)) {
        // Deterministic swap inside the validation→rename window: the real
        // snapshot is moved aside and a decoy takes its place at the path.
        renameSync(snapshot, path.join(stash, 'real-snapshot'))
        mkdirSync(path.join(stash, 'decoy'), { recursive: true })
        writeFileSync(path.join(stash, 'decoy', 'decoy.txt'), 'decoy')
        renameSync(path.join(stash, 'decoy'), snapshot)
      }
    })
    try {
      const result = await commitFallbackJournal(owner)
      assert.equal(result.succeeded, true)
      assert.ok(result.preservedArtifacts.includes(snapshot))
      // The decoy was renamed back to the container path, fully preserved.
      assert.equal(readFileSync(path.join(snapshot, 'decoy.txt'), 'utf8'), 'decoy')
      // The real authenticated snapshot survived at the stash untouched.
      assert.equal(existsSync(path.join(stash, 'real-snapshot', '1', 'SKILL.md')), true)
      assert.equal(existsSync(owner.journalPath), false)
    } finally {
      setFallbackArtifactSwapSeamForTests(undefined)
    }
  })

  it('preserves the whole container when content is smuggled in after validation but before the rename', async () => {
    const { manifest, skillPath } = await setupValidFixture()
    const { handle: fresh } = await beginFallbackJournal(manifest)
    await markFallbackJournalMutating(fresh)
    const claimed = await claimFallbackJournalMutation(manifest, manifestDigestOf(manifest))
    assert.ok(claimed)
    const stageSource = mkdtempSync(path.join(path.dirname(skillPath), '.stage-src-'))
    mkdirSync(path.join(stageSource, 'payload'), { recursive: true })
    writeFileSync(path.join(stageSource, 'payload', 'SKILL.md'), 'new bundle\n')
    let smuggled = false
    setFallbackArtifactSwapSeamForTests(async (artifact) => {
      if (artifact.role === 'stage' && !smuggled) {
        smuggled = true
        writeFileSync(path.join(artifact.container, '.smuggled'), 'KEEP')
      }
    })
    try {
      const staged = await registerFallbackStage(claimed, skillPath, { directory: path.join(stageSource, 'payload') })
      const applied = await applyFallbackEntry(staged, skillPath)
      assert.ok(applied)
      assert.equal(readFileSync(path.join(skillPath, 'SKILL.md'), 'utf8'), 'new bundle\n')
      const siblings = readdirSync(path.dirname(skillPath)).filter((name) => name.includes('.nsolid-stage-'))
      assert.equal(siblings.length, 1)
      const container = path.join(path.dirname(skillPath), siblings[0])
      assert.equal(existsSync(path.join(container, 'payload')), false, 'the payload legitimately moved into the live path')
      assert.equal(readFileSync(path.join(container, '.smuggled'), 'utf8'), 'KEEP')
      const residues = JSON.parse(readFileSync(fresh.journalPath, 'utf8'))
      assert.ok((residues.preservedArtifacts ?? []).some((artifact: string) => path.resolve(artifact) === path.resolve(container)))
    } finally {
      setFallbackArtifactSwapSeamForTests(undefined)
      rmSync(stageSource, { recursive: true, force: true })
    }
  })
})

describe('fallback journal frontier entries', () => {
  it('journals one planned-missing frontier entry that replaces multiple covered leaves and keeps them out of the snapshot', async () => {
    const fixture = await setupFrontierFixture()
    const { journal } = await beginFallbackJournal(fixture.manifest)
    const paths = journal.entries.map((entry) => path.resolve(entry.path))
    assert.deepEqual(paths.sort(), [
      fixture.trackingPath,
      fixture.keptSkillPath,
      fixture.keptLinkPath,
      path.join(home, '.claude.json'),
      fixture.frontierPath,
    ].map((value) => path.resolve(value)).sort())
    const frontierEntry = journal.entries.find((entry) => path.resolve(entry.path) === path.resolve(fixture.frontierPath))
    assert.ok(frontierEntry)
    assert.equal(frontierEntry.existed, false)
    assert.equal(frontierEntry.kind, 'missing')
    assert.equal(frontierEntry.digest, undefined)
    assert.equal(frontierEntry.backup, undefined)
    for (const covered of ['alpha', 'beta']) {
      assert.equal(journal.entries.some((entry) => entry.path === path.join(fixture.frontierPath, covered)), false, `covered leaf ${covered} must have no entry`)
    }
    // The snapshot carries backups only for retained existing targets.
    assert.deepEqual(readdirSync(journal.snapshotDirectory!).sort(), ['0', '1', '2'])
    // Existing directory anchors are validation-only: never entries.
    assert.equal(paths.includes(path.resolve(fixture.anchorPath)), false)
  })

  it('rejects begin for a manifest candidate hidden under a frontier without being an authorized leaf', async () => {
    const fixture = await setupFrontierFixture()
    const hidden = path.join(fixture.frontierPath, 'hidden.json')
    const broken = {
      ...fixture.manifest,
      bundleDestinations: [...fixture.manifest.bundleDestinations, await pathEvidence(hidden)],
    } as FallbackTransactionIdentity
    const trackingDir = path.dirname(fixture.trackingPath)
    await assert.rejects(beginFallbackJournal(broken), /FALLBACK_FRONTIER_EVIDENCE_INVALID/)
    assert.equal(existsSync(fallbackJournalPath(fixture.trackingPath)), false)
    assert.deepEqual(readdirSync(trackingDir).filter((name) => name.startsWith('.nsolid-plugin-update-')), [])
  })

  it('rejects begin on frontier or anchor drift before any journal state exists', async () => {
    const fixture = await setupFrontierFixture()
    const trackingDir = path.dirname(fixture.trackingPath)
    // The frontier path appeared before begin.
    mkdirSync(fixture.frontierPath)
    await assert.rejects(beginFallbackJournal(fixture.manifest), /FALLBACK_FRONTIER_DRIFT/)
    assert.equal(existsSync(fallbackJournalPath(fixture.trackingPath)), false)
    assert.deepEqual(readdirSync(trackingDir).filter((name) => name.startsWith('.nsolid-plugin-update-')), [])
    rmSync(fixture.frontierPath, { recursive: true, force: true })
    // The anchor identity changed: rename the original anchor aside
    // (preserving its inode, avoiding rename-over-existing), then move a
    // freshly created directory into the anchor path so the replacement is
    // guaranteed to carry a new inode.
    const replacement = path.join(home, 'anchor-replacement')
    mkdirSync(replacement)
    renameSync(fixture.anchorPath, `${fixture.anchorPath}-replaced`)
    renameSync(replacement, fixture.anchorPath)
    await assert.rejects(beginFallbackJournal(fixture.manifest), /FALLBACK_FRONTIER_DRIFT/)
    assert.equal(existsSync(fallbackJournalPath(fixture.trackingPath)), false)
    assert.deepEqual(readdirSync(trackingDir).filter((name) => name.startsWith('.nsolid-plugin-update-')), [])
  })

  it('refuses a mutation claim on frontier drift and leaves the journal byte-identical', async () => {
    const fixture = await setupFrontierFixture()
    const { handle } = await beginFallbackJournal(fixture.manifest)
    await markFallbackJournalMutating(handle)
    const before = readFileSync(handle.journalPath, 'utf8')
    mkdirSync(fixture.frontierPath)
    writeFileSync(path.join(fixture.frontierPath, 'user.txt'), 'KEEP')
    await assert.rejects(claimFallbackJournalMutation(fixture.manifest, manifestDigestOf(fixture.manifest)), /FALLBACK_FRONTIER_DRIFT/)
    assert.equal(readFileSync(handle.journalPath, 'utf8'), before)
  })

  it('never lets forged applied or stageDigest fields on a frontier entry grant parent restore authority', async () => {
    const fixture = await setupFrontierFixture()
    const begin = await beginFallbackJournal(fixture.manifest)
    const owner = await markFallbackJournalMutating(begin.handle)
    mkdirSync(fixture.frontierPath)
    writeFileSync(path.join(fixture.frontierPath, 'user.txt'), 'KEEP\n')
    const forged = JSON.parse(readFileSync(owner.journalPath, 'utf8')) as { entries: Array<{ path: string; applied?: boolean; stageDigest?: string }> }
    const frontierEntry = forged.entries.find((entry) => path.resolve(entry.path) === path.resolve(fixture.frontierPath))
    assert.ok(frontierEntry)
    frontierEntry.applied = true
    frontierEntry.stageDigest = await pathDigest(fixture.frontierPath)
    writeFileSync(owner.journalPath, JSON.stringify(forged, null, 2) + '\n')
    const restore = await restoreFallbackJournal(owner)
    assert.equal(restore.succeeded, false)
    assert.equal(restore.unproven, true)
    assert.deepEqual(restore.preservedPaths, [path.resolve(fixture.frontierPath)])
    assert.equal(readFileSync(path.join(fixture.frontierPath, 'user.txt'), 'utf8'), 'KEEP\n')
    assert.equal(existsSync(owner.journalPath), true)
  })

  it('restores independently owned bytes while preserving a live frontier and reporting the rollback incomplete', async () => {
    const fixture = await setupFrontierFixture()
    const { journal, handle } = await beginFallbackJournal(fixture.manifest)
    const owner = await markFallbackJournalMutating(handle)
    writeFileSync(path.join(fixture.keptSkillPath, 'SKILL.md'), 'drifted\n')
    mkdirSync(fixture.frontierPath)
    writeFileSync(path.join(fixture.frontierPath, 'user.txt'), 'KEEP\n')
    const restore = await restoreFallbackJournal(owner)
    assert.equal(restore.succeeded, false)
    assert.equal(restore.unproven, true)
    assert.equal(readFileSync(path.join(fixture.keptSkillPath, 'SKILL.md'), 'utf8'), '# kept\n')
    assert.equal(readFileSync(path.join(fixture.frontierPath, 'user.txt'), 'utf8'), 'KEEP\n')
    assert.deepEqual(restore.preservedPaths, [path.resolve(fixture.frontierPath)])
    assert.equal(restore.preservedArtifacts.length, 1)
    assert.ok(restore.preservedArtifacts[0].includes('.nsolid-quarantine-'))
    assert.equal(existsSync(owner.journalPath), true)
    assert.equal(existsSync(journal.snapshotDirectory!), true)
  })

  it('completes the owner restore and disposes the journal when a planned frontier is still absent', async () => {
    const fixture = await setupFrontierFixture()
    const { journal, handle } = await beginFallbackJournal(fixture.manifest)
    const owner = await markFallbackJournalMutating(handle)
    writeFileSync(path.join(fixture.keptSkillPath, 'SKILL.md'), 'drifted\n')
    const restore = await restoreFallbackJournal(owner)
    assert.equal(restore.succeeded, true)
    assert.equal(restore.frontierJournalPending, undefined)
    assert.deepEqual(restore.preservedArtifacts, [])
    assert.deepEqual(restore.preservedPaths, [])
    assert.equal(existsSync(owner.journalPath), false)
    assert.equal(existsSync(journal.snapshotDirectory!), false)
    assert.equal(readFileSync(path.join(fixture.keptSkillPath, 'SKILL.md'), 'utf8'), '# kept\n')
    assert.equal(existsSync(fixture.frontierPath), false)
  })

  it('keeps next-run recovery strictly preserve-only for a live frontier and its descendants', async () => {
    const fixture = await setupFrontierFixture()
    const { journal, handle } = await beginFallbackJournal(fixture.manifest)
    await markFallbackJournalMutating(handle)
    mkdirSync(path.join(fixture.frontierPath, 'nested'), { recursive: true })
    writeFileSync(path.join(fixture.frontierPath, 'nested', 'user.txt'), 'KEEP\n')
    const recovery = await recoverFallbackJournal(fixture.trackingPath)
    assert.equal(recovery.pending, true)
    assert.equal(recovery.recovered, false)
    // The unmanaged kept link is outside current tracking ownership and the
    // live frontier is never restored: both stay preserved and reported.
    assert.deepEqual(recovery.preservedPaths, [fixture.keptLinkPath, path.resolve(fixture.frontierPath)].map((value) => path.resolve(value)).sort())
    assert.equal(readFileSync(path.join(fixture.frontierPath, 'nested', 'user.txt'), 'utf8'), 'KEEP\n')
    assert.deepEqual(recovery.preservedArtifacts, [handle.journalPath, path.resolve(journal.snapshotDirectory!)].map((value) => path.resolve(value)).sort())
  })

  it('treats an absent planned frontier as satisfying the missing state during recovery', async () => {
    const fixture = await setupFrontierFixture()
    const { handle } = await beginFallbackJournal(fixture.manifest)
    await markFallbackJournalMutating(handle)
    const recovery = await recoverFallbackJournal(fixture.trackingPath)
    assert.equal(recovery.pending, true)
    assert.equal(recovery.recovered, true)
    // Only the tracking-unowned kept link is reported; the absent frontier
    // satisfies the original missing state without any reporting inference.
    assert.deepEqual(recovery.preservedPaths, [path.resolve(fixture.keptLinkPath)])
  })

  it('rejects exact immutable-entry tampering: insertion, removal, kind, and digest', async () => {
    const fixture = await setupFrontierFixture()
    const { handle } = await beginFallbackJournal(fixture.manifest)
    interface EditableEntry { path: string; kind: string; existed: boolean; digest?: string }
    interface EditableJournal { entries: EditableEntry[] }
    const read = (): EditableJournal => JSON.parse(readFileSync(handle.journalPath, 'utf8')) as EditableJournal
    const write = (disk: EditableJournal): void => { writeFileSync(handle.journalPath, JSON.stringify(disk, null, 2) + '\n') }
    const expectRejection = async (label: string): Promise<void> => {
      await assert.rejects(reloadFallbackJournal(handle), /Invalid fallback journal/, `${label} must be rejected`)
    }
    // Insertion of an unmanifested entry.
    const inserted = read()
    inserted.entries.push({ path: path.join(home, 'unmanifested'), kind: 'missing', existed: false })
    write(inserted)
    await expectRejection('entry insertion')
    // Removal of a required entry.
    const removed = read()
    removed.entries.splice(0, 1)
    write(removed)
    await expectRejection('entry removal')
    // Kind tampering on an evidence-backed entry.
    const kindTampered = read()
    const skillEntry = kindTampered.entries.find((entry) => path.resolve(entry.path) === path.resolve(fixture.keptSkillPath))
    assert.ok(skillEntry)
    skillEntry.kind = 'file'
    write(kindTampered)
    await expectRejection('entry kind tampering')
    // Digest tampering on an evidence-backed entry.
    const digestTampered = read()
    const skillEntry2 = digestTampered.entries.find((entry) => path.resolve(entry.path) === path.resolve(fixture.keptSkillPath))
    assert.ok(skillEntry2)
    skillEntry2.digest = '0'.repeat(64)
    write(digestTampered)
    await expectRejection('entry digest tampering')
    // A frontier entry must stay a pure missing publication unit.
    const frontierTampered = read()
    const frontierEntry = frontierTampered.entries.find((entry) => path.resolve(entry.path) === path.resolve(fixture.frontierPath))
    assert.ok(frontierEntry)
    frontierEntry.digest = '0'.repeat(64)
    write(frontierTampered)
    await expectRejection('frontier entry digest tampering')
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
    protocolVersion: FALLBACK_PROTOCOL_VERSION,
    digestAlgorithm: 'fallback-path-v2',
    nonce: randomUUID(),
    plannedMissingFrontiers: [],
    ownedSkills: [await pathEvidence(skillPath)],
    ownedLinks: [await pathEvidence(linkPath)],
    ownedMcpFields: [],
    ownedMcpConfigPaths: [await pathEvidence(path.join(home, '.claude.json'))],
    bundleDestinations: [],
    approvedDestinationRoots: [path.resolve(path.join(home, '.agents', 'skills')), path.resolve(getHarnessSkillsPath('claude'))],
  }
  return { trackingPath, skillPath, linkPath, manifest, trackingJson }
}

async function pathEvidence (target: string) {
  const kind = await pathKind(target)
  const digest = kind === 'missing' ? undefined : await pathDigest(target)
  return { path: path.resolve(target), kind, digest }
}

async function frontierAnchorIdentity (anchorPath: string): Promise<FallbackAnchorIdentity> {
  const stats = lstatSync(anchorPath, { bigint: true })
  const real = realpathSync(anchorPath)
  if (real !== anchorPath || !stats.isDirectory()) throw new Error(`fixture anchor ${anchorPath} must be a real directory`)
  return { path: anchorPath, realpath: real, type: 'directory', device: stats.dev.toString(10), inode: stats.ino.toString(10) }
}

/**
 * Valid claude fixture plus one planned-missing frontier: a topmost missing
 * directory `frontier-anchor/new-root` covering two planned skill leaves
 * (alpha, beta), alongside retained existing tracked skill/link evidence and
 * a missing canonical MCP config outside the frontier.
 */
async function setupFrontierFixture (): Promise<{
  trackingPath: string
  anchorPath: string
  frontierPath: string
  keptSkillPath: string
  keptLinkPath: string
  frontierEvidence: FallbackFrontierEvidence
  manifest: FallbackTransactionIdentity
}> {
  const trackingPath = getTrackingFilePath()
  const keptSkillPath = path.join(home, '.agents', 'skills', 'kept')
  const keptLinkPath = path.join(getHarnessSkillsPath('claude'), 'kept')
  mkdirSync(keptSkillPath, { recursive: true })
  writeFileSync(path.join(keptSkillPath, 'SKILL.md'), '# kept\n')
  mkdirSync(path.dirname(keptLinkPath), { recursive: true })
  writeFileSync(keptLinkPath, 'kept-link\n')
  mkdirSync(path.dirname(trackingPath), { recursive: true })
  const trackingJson = JSON.stringify({
    version: '1.0.0',
    installedAt: new Date().toISOString(),
    harness: 'claude',
    skills: [{ name: 'kept', path: keptSkillPath, paths: { claude: keptSkillPath }, installedAt: new Date().toISOString(), harnesses: ['claude'] }],
    mcpServers: [],
  })
  writeFileSync(trackingPath, trackingJson)
  const anchorPath = path.join(home, 'frontier-anchor')
  mkdirSync(anchorPath)
  const frontierPath = path.join(anchorPath, 'new-root')
  const frontierEvidence: FallbackFrontierEvidence = {
    frontierPath,
    activation: 'required',
    anchor: await frontierAnchorIdentity(anchorPath),
    leaves: [
      { id: 'skill:alpha', role: 'skill', activation: 'required', path: path.join(frontierPath, 'alpha') },
      { id: 'skill:beta', role: 'skill', activation: 'conditional', path: path.join(frontierPath, 'beta') },
    ],
  }
  const manifest: FallbackTransactionIdentity = {
    installationId: 'claude:fallback',
    harness: 'claude',
    trackingPath,
    trackingDigest: trackingDigest(trackingPath)!,
    protocolVersion: FALLBACK_PROTOCOL_VERSION,
    digestAlgorithm: 'fallback-path-v2',
    nonce: randomUUID(),
    plannedMissingFrontiers: [frontierEvidence],
    ownedSkills: [await pathEvidence(keptSkillPath)],
    ownedLinks: [await pathEvidence(keptLinkPath)],
    ownedMcpFields: [],
    ownedMcpConfigPaths: [await pathEvidence(path.join(home, '.claude.json'))],
    bundleDestinations: [await pathEvidence(path.join(frontierPath, 'alpha')), await pathEvidence(path.join(frontierPath, 'beta'))],
    approvedDestinationRoots: [path.dirname(keptSkillPath), anchorPath].map((value) => path.resolve(value)),
  }
  return { trackingPath, anchorPath, frontierPath, keptSkillPath, keptLinkPath, frontierEvidence, manifest }
}

/** Registers the shared frontier fixture with its intentional conditional skill:beta leaf active. */
async function registerFrontierStageWithBeta (handle: FallbackJournalHandle, frontierPath: string, staged: string): Promise<FallbackJournalHandle> {
  return registerFallbackFrontierStage(handle, frontierPath, staged, { activeConditionalLeafIds: ['skill:beta'] })
}

type FrontierFixture = Awaited<ReturnType<typeof setupFrontierFixture>>

async function buildStagedFrontier (options: { alphaContent?: string; betaContent?: string } = {}): Promise<string> {
  const staged = path.join(home, `staged-frontier-${randomUUID().slice(0, 8)}`)
  mkdirSync(path.join(staged, 'alpha'), { recursive: true })
  writeFileSync(path.join(staged, 'alpha', 'SKILL.md'), options.alphaContent ?? '# alpha staged\n')
  mkdirSync(path.join(staged, 'beta'), { recursive: true })
  writeFileSync(path.join(staged, 'beta', 'SKILL.md'), options.betaContent ?? '# beta staged\n')
  return staged
}

async function beginMutatingFrontier (fixture: FrontierFixture): Promise<FallbackJournalHandle> {
  const { handle } = await beginFallbackJournal(fixture.manifest)
  await markFallbackJournalMutating(handle)
  // The local transaction lifecycle: the same process self-claims the
  // mutator role from the manifest it just planned.
  const claimed = await claimFallbackJournalMutation(fixture.manifest, manifestDigestOf(fixture.manifest))
  if (!claimed) throw new Error('mutation claim failed')
  return claimed
}

async function setupPublishedFrontier (): Promise<{ fixture: FrontierFixture; applied: FallbackJournalHandle }> {
  const fixture = await setupFrontierFixture()
  const owner = await beginMutatingFrontier(fixture)
  const staged = await buildStagedFrontier()
  const registered = await registerFrontierStageWithBeta(owner, fixture.frontierPath, staged)
  const applied = await applyFallbackEntry(registered, fixture.frontierPath)
  return { fixture, applied }
}

describe('fallback journal frontier publication', () => {
  const stageContainers = (fixture: FrontierFixture): string[] =>
    readdirSync(fixture.anchorPath).filter((name) => name.includes('.nsolid-stage-'))

  /** setupFrontierFixture for a second fixture in one test: the anchor mkdir is not recursive and a pending journal blocks begin. */
  async function freshFrontierFixture (): Promise<FrontierFixture> {
    rmSync(fallbackJournalPath(getTrackingFilePath()), { force: true })
    const trackingDir = path.dirname(getTrackingFilePath())
    if (existsSync(trackingDir)) {
      for (const name of readdirSync(trackingDir)) {
        if (name.startsWith('.nsolid-plugin-update-')) rmSync(path.join(trackingDir, name), { recursive: true, force: true })
      }
    }
    rmSync(path.join(home, 'frontier-anchor'), { recursive: true, force: true })
    return await setupFrontierFixture()
  }

  it('publishes a complete multi-leaf frontier exactly once, in place', async () => {
    const fixture = await setupFrontierFixture()
    const owner = await beginMutatingFrontier(fixture)
    const staged = await buildStagedFrontier()
    const registered = await registerFrontierStageWithBeta(owner, fixture.frontierPath, staged)
    const before = JSON.parse(readFileSync(registered.journalPath, 'utf8')) as { entries: Array<{ path: string; applied?: boolean; stageDigest?: string }> }
    const registeredEntry = before.entries.find((entry) => path.resolve(entry.path) === path.resolve(fixture.frontierPath))
    assert.ok(registeredEntry?.stageDigest)
    assert.equal(registeredEntry.applied, false)

    let reservedIno = 0
    setFallbackFrontierPublicationSeamForTests((event) => {
      if (event.phase === 'reserved-identity') reservedIno = lstatSync(fixture.frontierPath).ino
    })
    try {
      const applied = await applyFallbackEntry(registered, fixture.frontierPath)
      // The reserved directory was populated in place: same inode, no rename.
      assert.equal(lstatSync(fixture.frontierPath).ino, reservedIno)
      const stageDigest = registeredEntry.stageDigest!
      assert.equal(await pathDigest(fixture.frontierPath), stageDigest)
      assert.equal(readFileSync(path.join(fixture.frontierPath, 'alpha', 'SKILL.md'), 'utf8'), '# alpha staged\n')
      assert.equal(readFileSync(path.join(fixture.frontierPath, 'beta', 'SKILL.md'), 'utf8'), '# beta staged\n')
      const after = JSON.parse(readFileSync(applied.journalPath, 'utf8')) as { entries: Array<{ path: string; applied?: boolean; stage?: string }> }
      const appliedEntry = after.entries.find((entry) => path.resolve(entry.path) === path.resolve(fixture.frontierPath))
      assert.equal(appliedEntry?.applied, true)
      assert.equal(appliedEntry?.stage, undefined)
      // The authenticated stage container was cleaned after publication.
      assert.deepEqual(stageContainers(fixture), [])
      assert.equal(existsSync(applied.journalPath), true)
      // The completion record is process-local and carries the reserved identity.
      const publications = publishedFallbackFrontiers(applied)
      assert.equal(publications.length, 1)
      assert.equal(path.resolve(publications[0].frontierPath), path.resolve(fixture.frontierPath))
      const liveIdentity = lstatSync(fixture.frontierPath)
      assert.equal(publications[0].dev, liveIdentity.dev)
      assert.equal(publications[0].ino, liveIdentity.ino)
      assert.equal(publications[0].stageDigest, stageDigest)
      // Replying a published frontier fails closed without touching bytes.
      const digestBeforeReplay = await pathDigest(fixture.frontierPath)
      await assert.rejects(applyFallbackEntry(applied, fixture.frontierPath), /No registered stage capability/)
      assert.equal(await pathDigest(fixture.frontierPath), digestBeforeReplay)
    } finally {
      setFallbackFrontierPublicationSeamForTests()
    }
  })

  it('never replaces a foreign destination at the frontier path, even byte-identical', async () => {
    for (const mode of ['byte-identical', 'empty'] as const) {
      const fixture = await freshFrontierFixture()
      const owner = await beginMutatingFrontier(fixture)
      const staged = await buildStagedFrontier(mode === 'byte-identical' ? {} : { alphaContent: 'different\n' })
      const registered = await registerFrontierStageWithBeta(owner, fixture.frontierPath, staged)
      mkdirSync(fixture.frontierPath, { recursive: true })
      if (mode === 'byte-identical') {
        mkdirSync(path.join(fixture.frontierPath, 'alpha'), { recursive: true })
        writeFileSync(path.join(fixture.frontierPath, 'alpha', 'SKILL.md'), '# alpha staged\n')
        mkdirSync(path.join(fixture.frontierPath, 'beta'), { recursive: true })
        writeFileSync(path.join(fixture.frontierPath, 'beta', 'SKILL.md'), '# beta staged\n')
      }
      const foreignIno = lstatSync(fixture.frontierPath).ino
      await assert.rejects(applyFallbackEntry(registered, fixture.frontierPath), /FALLBACK_FRONTIER_COLLISION/)
      // The existing destination is preserved untouched: same inode, same bytes.
      assert.equal(lstatSync(fixture.frontierPath).ino, foreignIno)
      if (mode === 'byte-identical') {
        assert.equal(readFileSync(path.join(fixture.frontierPath, 'alpha', 'SKILL.md'), 'utf8'), '# alpha staged\n')
      } else {
        assert.deepEqual(readdirSync(fixture.frontierPath), [])
      }
      // The journal stays pending and the stage artifacts are preserved.
      const disk = JSON.parse(readFileSync(registered.journalPath, 'utf8')) as { entries: Array<{ path: string; applied?: boolean }> }
      const entry = disk.entries.find((candidate) => path.resolve(candidate.path) === path.resolve(fixture.frontierPath))
      assert.equal(entry?.applied, false)
      assert.equal(stageContainers(fixture).length, 1)
    }
  })

  it('preserves a foreign destination created inside the reservation window', async () => {
    const fixture = await setupFrontierFixture()
    const owner = await beginMutatingFrontier(fixture)
    const staged = await buildStagedFrontier()
    const registered = await registerFrontierStageWithBeta(owner, fixture.frontierPath, staged)
    setFallbackFrontierPublicationSeamForTests((event) => {
      if (event.phase === 'before-reserve') {
        mkdirSync(fixture.frontierPath, { recursive: true })
        writeFileSync(path.join(fixture.frontierPath, 'user.txt'), 'KEEP')
      }
    })
    try {
      await assert.rejects(applyFallbackEntry(registered, fixture.frontierPath), /FALLBACK_FRONTIER_COLLISION/)
      assert.equal(readFileSync(path.join(fixture.frontierPath, 'user.txt'), 'utf8'), 'KEEP')
      assert.equal(stageContainers(fixture).length, 1)
    } finally {
      setFallbackFrontierPublicationSeamForTests()
    }
  })

  it('rejects arbitrary symlinks in the staged tree before anything goes live', async () => {
    for (const [label, place] of [
      ['inside skill content', (staged: string): string => path.join(staged, 'alpha', 'evil-link')],
      ['at an unplanned frontier-level path', (staged: string): string => path.join(staged, 'stray-link')],
    ] as const) {
      const fixture = await freshFrontierFixture()
      const owner = await beginMutatingFrontier(fixture)
      const staged = await buildStagedFrontier()
      symlinkSync('/etc', place(staged))
      await assert.rejects(registerFrontierStageWithBeta(owner, fixture.frontierPath, staged), /symlink|unplanned content/, `${label} must be rejected`)
      // Nothing live was created and the fresh stage container was contained.
      assert.equal(existsSync(fixture.frontierPath), false)
      assert.deepEqual(stageContainers(fixture), [])
    }
  })

  it('publishes a managed link leaf to the exact final skill path without dereferencing', async () => {
    const fixture = await setupFrontierFixture()
    const destAnchor = path.join(home, 'dest-anchor')
    const linkAnchor = path.join(home, 'link-anchor')
    mkdirSync(destAnchor)
    mkdirSync(linkAnchor)
    const destRoot = path.join(destAnchor, 'skills')
    const linkRoot = path.join(linkAnchor, 'skills')
    const destGammaPath = path.join(destRoot, 'gamma')
    const linkGammaPath = path.join(linkRoot, 'gamma')
    const skillFrontier = {
      frontierPath: destRoot,
      activation: 'required' as const,
      anchor: await frontierAnchorIdentity(destAnchor),
      leaves: [{ id: 'skill:gamma', role: 'skill' as const, activation: 'required' as const, path: destGammaPath }],
    }
    const linkFrontier = {
      frontierPath: linkRoot,
      activation: 'required' as const,
      anchor: await frontierAnchorIdentity(linkAnchor),
      leaves: [{ id: 'link:gamma', role: 'link' as const, activation: 'required' as const, path: linkGammaPath }],
    }
    const manifest = {
      ...fixture.manifest,
      plannedMissingFrontiers: [skillFrontier, linkFrontier],
      bundleDestinations: [await pathEvidence(destGammaPath), await pathEvidence(linkGammaPath)],
      approvedDestinationRoots: [...fixture.manifest.approvedDestinationRoots, destAnchor, linkAnchor],
    }
    const { handle } = await beginFallbackJournal(manifest)
    await markFallbackJournalMutating(handle)
    const owner = await claimFallbackJournalMutation(manifest, manifestDigestOf(manifest))
    if (!owner) throw new Error('mutation claim failed')
    // Staged destination tree and staged link tree (the link text is the
    // absolute final skill path; the destination does not exist yet).
    const stagedDest = path.join(home, `staged-dest-${randomUUID().slice(0, 8)}`)
    mkdirSync(path.join(stagedDest, 'gamma'), { recursive: true })
    writeFileSync(path.join(stagedDest, 'gamma', 'SKILL.md'), '# gamma staged\n')
    const stagedLink = path.join(home, `staged-link-${randomUUID().slice(0, 8)}`)
    mkdirSync(stagedLink, { recursive: true })
    symlinkSync(destGammaPath, path.join(stagedLink, 'gamma'))
    const withDest = await registerFallbackFrontierStage(owner, destRoot, stagedDest)
    const withLink = await registerFallbackFrontierStage(withDest, linkRoot, stagedLink)
    // The link frontier publishes first, while its target is still missing:
    // publication must never dereference the managed link.
    const withLinkApplied = await applyFallbackEntry(withLink, linkRoot)
    assert.equal(lstatSync(linkGammaPath).isSymbolicLink(), true)
    assert.equal(readlinkSync(linkGammaPath), destGammaPath)
    assert.equal(existsSync(destGammaPath), false)
    const withDestApplied = await applyFallbackEntry(withLinkApplied, destRoot)
    assert.equal(readFileSync(path.join(destGammaPath, 'SKILL.md'), 'utf8'), '# gamma staged\n')
    assert.equal(readlinkSync(linkGammaPath), destGammaPath)
    assert.deepEqual(publishedFallbackFrontiers(withDestApplied).map((publication) => path.resolve(publication.frontierPath)).sort(), [destRoot, linkRoot].map((value) => path.resolve(value)).sort())
  })

  it('preserves a partially populated frontier and stays pending when population fails', async () => {
    const fixture = await setupFrontierFixture()
    const owner = await beginMutatingFrontier(fixture)
    const staged = await buildStagedFrontier()
    const registered = await registerFrontierStageWithBeta(owner, fixture.frontierPath, staged)
    // The seam emits op.relative joined with the platform-native separator
    // (walkFrontierTree), so match with the native separator: a POSIX literal
    // never fires on Windows and the injected fault would be silently skipped.
    let injectorReached = false
    setFallbackFrontierPublicationSeamForTests((event) => {
      if (event.phase === 'before-leaf' && event.leaf === path.join('beta', 'SKILL.md')) {
        injectorReached = true
        throw new Error('injected failure')
      }
    })
    try {
      await assert.rejects(applyFallbackEntry(registered, fixture.frontierPath), /FALLBACK_FRONTIER_PUBLICATION_INCOMPLETE/)
      assert.equal(injectorReached, true)
      // The partial population is preserved, never rolled back or removed.
      assert.equal(existsSync(fixture.frontierPath), true)
      assert.equal(readFileSync(path.join(fixture.frontierPath, 'alpha', 'SKILL.md'), 'utf8'), '# alpha staged\n')
      assert.equal(existsSync(path.join(fixture.frontierPath, 'beta', 'SKILL.md')), false)
      // The authenticated stage artifacts and pending journal are preserved.
      assert.equal(stageContainers(fixture).length, 1)
      const disk = JSON.parse(readFileSync(registered.journalPath, 'utf8')) as { entries: Array<{ path: string; applied?: boolean; stageDigest?: string }> }
      const entry = disk.entries.find((candidate) => path.resolve(candidate.path) === path.resolve(fixture.frontierPath))
      assert.equal(entry?.applied, false)
      assert.ok(entry?.stageDigest)
      assert.equal(existsSync(registered.journalPath), true)
    } finally {
      setFallbackFrontierPublicationSeamForTests()
    }
  })

  it('rejects a foreign nested insertion during exclusive population and preserves everything', async () => {
    const fixture = await setupFrontierFixture()
    const owner = await beginMutatingFrontier(fixture)
    const staged = await buildStagedFrontier()
    const registered = await registerFrontierStageWithBeta(owner, fixture.frontierPath, staged)
    // Native-separator leaf match as above; the stray write must actually be
    // injected for the preservation assertions below to mean anything.
    let injectorReached = false
    setFallbackFrontierPublicationSeamForTests((event) => {
      if (event.phase === 'before-leaf' && event.leaf === path.join('beta', 'SKILL.md')) {
        injectorReached = true
        writeFileSync(path.join(fixture.frontierPath, 'alpha', 'stray.txt'), 'FOREIGN')
      }
    })
    try {
      await assert.rejects(applyFallbackEntry(registered, fixture.frontierPath), /FALLBACK_FRONTIER_PUBLICATION_INCOMPLETE/)
      assert.equal(injectorReached, true)
      // The foreign insertion is preserved, not deleted.
      assert.equal(readFileSync(path.join(fixture.frontierPath, 'alpha', 'stray.txt'), 'utf8'), 'FOREIGN')
      assert.equal(readFileSync(path.join(fixture.frontierPath, 'alpha', 'SKILL.md'), 'utf8'), '# alpha staged\n')
      assert.equal(stageContainers(fixture).length, 1)
      const disk = JSON.parse(readFileSync(registered.journalPath, 'utf8')) as { entries: Array<{ path: string; applied?: boolean }> }
      const entry = disk.entries.find((candidate) => path.resolve(candidate.path) === path.resolve(fixture.frontierPath))
      assert.equal(entry?.applied, false)
    } finally {
      setFallbackFrontierPublicationSeamForTests()
    }
  })

  it('detects a reserved-directory replacement between mkdir and identity observation', async () => {
    const fixture = await setupFrontierFixture()
    const owner = await beginMutatingFrontier(fixture)
    const staged = await buildStagedFrontier()
    const registered = await registerFrontierStageWithBeta(owner, fixture.frontierPath, staged)
    // Deterministic replacement: rename the reserved directory away and move
    // a pre-existing directory (guaranteed different inode) into the path.
    const replacement = path.join(home, 'replacement-dir')
    mkdirSync(replacement)
    writeFileSync(path.join(replacement, 'replacement.txt'), 'REPLACED')
    setFallbackFrontierPublicationSeamForTests((event) => {
      if (event.phase === 'reserved-identity') {
        renameSync(fixture.frontierPath, path.join(home, 'stashed-reserved'))
        renameSync(replacement, fixture.frontierPath)
      }
    })
    try {
      await assert.rejects(applyFallbackEntry(registered, fixture.frontierPath), /replaced between reservation and identity observation/)
      // Both the stashed original reservation and the replacement are
      // preserved, never deleted.
      assert.equal(readFileSync(path.join(fixture.frontierPath, 'replacement.txt'), 'utf8'), 'REPLACED')
      assert.equal(existsSync(path.join(home, 'stashed-reserved')), true)
      assert.equal(stageContainers(fixture).length, 1)
      const disk = JSON.parse(readFileSync(registered.journalPath, 'utf8')) as { entries: Array<{ path: string; applied?: boolean }> }
      const entry = disk.entries.find((candidate) => path.resolve(candidate.path) === path.resolve(fixture.frontierPath))
      assert.equal(entry?.applied, false)
    } finally {
      setFallbackFrontierPublicationSeamForTests()
    }
  })

  it('detects post-population drift and preserves the published bytes', async () => {
    const fixture = await setupFrontierFixture()
    const owner = await beginMutatingFrontier(fixture)
    const staged = await buildStagedFrontier()
    const registered = await registerFrontierStageWithBeta(owner, fixture.frontierPath, staged)
    setFallbackFrontierPublicationSeamForTests((event) => {
      if (event.phase === 'post-population') {
        writeFileSync(path.join(fixture.frontierPath, 'alpha', 'SKILL.md'), '# alpha staged\n tampered')
      }
    })
    try {
      await assert.rejects(applyFallbackEntry(registered, fixture.frontierPath), /FALLBACK_FRONTIER_PUBLICATION_INCOMPLETE/)
      assert.equal(readFileSync(path.join(fixture.frontierPath, 'alpha', 'SKILL.md'), 'utf8'), '# alpha staged\n tampered')
      assert.equal(existsSync(path.join(fixture.frontierPath, 'beta', 'SKILL.md')), true)
      assert.equal(stageContainers(fixture).length, 1)
      const disk = JSON.parse(readFileSync(registered.journalPath, 'utf8')) as { entries: Array<{ path: string; applied?: boolean }> }
      const entry = disk.entries.find((candidate) => path.resolve(candidate.path) === path.resolve(fixture.frontierPath))
      assert.equal(entry?.applied, false)
    } finally {
      setFallbackFrontierPublicationSeamForTests()
    }
  })

  it('never lets forged journal fields fake publication completion', async () => {
    // (a) A live foreign destination plus forged applied/stageDigest fields:
    // the payload digest check fails first and the live bytes stay untouched.
    const forgedFixture = await setupFrontierFixture()
    const forgedOwner = await beginMutatingFrontier(forgedFixture)
    const forgedStaged = await buildStagedFrontier()
    const forgedRegistered = await registerFrontierStageWithBeta(forgedOwner, forgedFixture.frontierPath, forgedStaged)
    mkdirSync(forgedFixture.frontierPath, { recursive: true })
    writeFileSync(path.join(forgedFixture.frontierPath, 'foreign.txt'), 'FOREIGN')
    const foreignIno = lstatSync(forgedFixture.frontierPath).ino
    const forged = JSON.parse(readFileSync(forgedRegistered.journalPath, 'utf8')) as { entries: Array<{ path: string; applied?: boolean }> }
    const forgedEntry = forged.entries.find((entry) => path.resolve(entry.path) === path.resolve(forgedFixture.frontierPath))
    assert.ok(forgedEntry)
    forgedEntry.applied = true
    writeFileSync(forgedRegistered.journalPath, JSON.stringify(forged, null, 2) + '\n')
    await assert.rejects(applyFallbackEntry(forgedRegistered, forgedFixture.frontierPath), /FALLBACK_FRONTIER_COLLISION/)
    assert.equal(lstatSync(forgedFixture.frontierPath).ino, foreignIno)
    assert.equal(readFileSync(path.join(forgedFixture.frontierPath, 'foreign.txt'), 'utf8'), 'FOREIGN')
    // Forged disk fields never create process-local completion authority.
    assert.deepEqual(publishedFallbackFrontiers(forgedRegistered), [])
    assert.equal(existsSync(forgedRegistered.journalPath), true)

    // (b) A forged digest matching a live foreign tree still fails the
    // missing-destination check before any reservation.
    const driftedFixture = await freshFrontierFixture()
    const driftedOwner = await beginMutatingFrontier(driftedFixture)
    const driftedStaged = await buildStagedFrontier()
    const driftedRegistered = await registerFrontierStageWithBeta(driftedOwner, driftedFixture.frontierPath, driftedStaged)
    mkdirSync(driftedFixture.frontierPath, { recursive: true })
    const driftedDisk = JSON.parse(readFileSync(driftedRegistered.journalPath, 'utf8')) as { entries: Array<{ path: string; applied?: boolean; stageDigest?: string }> }
    const driftedEntry = driftedDisk.entries.find((entry) => path.resolve(entry.path) === path.resolve(driftedFixture.frontierPath))
    assert.ok(driftedEntry)
    driftedEntry.applied = true
    driftedEntry.stageDigest = await pathDigest(driftedFixture.frontierPath)
    writeFileSync(driftedRegistered.journalPath, JSON.stringify(driftedDisk, null, 2) + '\n')
    await assert.rejects(applyFallbackEntry(driftedRegistered, driftedFixture.frontierPath), /capability digest/)
    assert.deepEqual(publishedFallbackFrontiers(driftedRegistered), [])
    assert.equal(existsSync(driftedRegistered.journalPath), true)
  })

  it('rejects a tampered stage payload before any reservation', async () => {
    const fixture = await setupFrontierFixture()
    const owner = await beginMutatingFrontier(fixture)
    const staged = await buildStagedFrontier()
    const registered = await registerFrontierStageWithBeta(owner, fixture.frontierPath, staged)
    const container = stageContainers(fixture)[0]
    assert.ok(container)
    writeFileSync(path.join(fixture.anchorPath, container, 'payload', 'alpha', 'SKILL.md'), 'tampered\n')
    await assert.rejects(applyFallbackEntry(registered, fixture.frontierPath), /no longer matches its registered digest/)
    assert.equal(existsSync(fixture.frontierPath), false)
    assert.equal(existsSync(registered.journalPath), true)
    const disk = JSON.parse(readFileSync(registered.journalPath, 'utf8')) as { entries: Array<{ path: string; applied?: boolean }> }
    const entry = disk.entries.find((candidate) => path.resolve(candidate.path) === path.resolve(fixture.frontierPath))
    assert.equal(entry?.applied, false)
  })

  it('refuses frontier registration for a path that is not a planned frontier', async () => {
    const fixture = await setupFrontierFixture()
    const owner = await beginMutatingFrontier(fixture)
    const staged = await buildStagedFrontier()
    await assert.rejects(registerFallbackFrontierStage(owner, path.join(fixture.anchorPath, 'other-root'), staged), /No planned fallback frontier/)
    assert.equal(existsSync(fixture.frontierPath), false)
    assert.deepEqual(stageContainers(fixture), [])
  })

  it('rejects simultaneous payload and journal digest tampering against the immutable registered digest', async () => {
    const fixture = await setupFrontierFixture()
    const owner = await beginMutatingFrontier(fixture)
    const staged = await buildStagedFrontier()
    const registered = await registerFrontierStageWithBeta(owner, fixture.frontierPath, staged)
    const container = stageContainers(fixture)[0]
    assert.ok(container)
    // Tamper the staged payload AND update the disk journal digest to the
    // tampered tree's digest, leaving the revision untouched: only the
    // process-local registered digest must stand in the way.
    const payloadAlpha = path.join(fixture.anchorPath, container, 'payload', 'alpha', 'SKILL.md')
    writeFileSync(payloadAlpha, 'EVIL\n')
    const disk = JSON.parse(readFileSync(registered.journalPath, 'utf8')) as { entries: Array<{ path: string; stageDigest?: string }> }
    const entry = disk.entries.find((candidate) => path.resolve(candidate.path) === path.resolve(fixture.frontierPath))
    assert.ok(entry)
    entry.stageDigest = await pathDigest(path.join(fixture.anchorPath, container, 'payload'))
    writeFileSync(registered.journalPath, JSON.stringify(disk, null, 2) + '\n')
    await assert.rejects(applyFallbackEntry(registered, fixture.frontierPath), /capability digest/)
    // Zero live mutation and no completion authority from the tampered pair.
    assert.equal(existsSync(fixture.frontierPath), false)
    assert.equal(stageContainers(fixture).length, 1)
    assert.deepEqual(publishedFallbackFrontiers(registered), [])
  })

  it('never lets a replaced destination ancestor redirect writes outside the reservation', async () => {
    const fixture = await setupFrontierFixture()
    const owner = await beginMutatingFrontier(fixture)
    const staged = await buildStagedFrontier()
    const registered = await registerFrontierStageWithBeta(owner, fixture.frontierPath, staged)
    const external = path.join(home, 'external-redirect')
    mkdirSync(external)
    const stashed = path.join(home, 'stashed-alpha')
    // Native-separator leaf match as above; the ancestor replacement must
    // actually be injected for the redirect-containment assertions to run.
    let injectorReached = false
    setFallbackFrontierPublicationSeamForTests((event) => {
      if (event.phase === 'before-leaf' && event.leaf === path.join('alpha', 'SKILL.md')) {
        injectorReached = true
        // Deterministically rename the created `alpha` directory aside and
        // replace its path with a symlink to an external directory.
        renameSync(path.join(fixture.frontierPath, 'alpha'), stashed)
        symlinkSync(external, path.join(fixture.frontierPath, 'alpha'))
      }
    })
    try {
      await assert.rejects(applyFallbackEntry(registered, fixture.frontierPath), /destination directory alpha was replaced during publication/)
      assert.equal(injectorReached, true)
      // The external redirect target was never written and nothing was deleted.
      assert.deepEqual(readdirSync(external), [])
      // `alpha` was stashed before its SKILL.md was copied: an empty managed dir.
      assert.equal(existsSync(stashed), true)
      assert.deepEqual(readdirSync(stashed), [])
      assert.equal(lstatSync(path.join(fixture.frontierPath, 'alpha')).isSymbolicLink(), true)
      assert.equal(stageContainers(fixture).length, 1)
      const disk = JSON.parse(readFileSync(registered.journalPath, 'utf8')) as { entries: Array<{ path: string; applied?: boolean }> }
      const entry = disk.entries.find((candidate) => path.resolve(candidate.path) === path.resolve(fixture.frontierPath))
      assert.equal(entry?.applied, false)
    } finally {
      setFallbackFrontierPublicationSeamForTests()
    }
  })

  it('publishes a directory skill leaf that exactly equals the frontier root', async () => {
    const trackingPath = getTrackingFilePath()
    const keptSkillPath = path.join(home, '.agents', 'skills', 'kept')
    const keptLinkPath = path.join(getHarnessSkillsPath('claude'), 'kept')
    mkdirSync(keptSkillPath, { recursive: true })
    writeFileSync(path.join(keptSkillPath, 'SKILL.md'), '# kept\n')
    mkdirSync(path.dirname(keptLinkPath), { recursive: true })
    writeFileSync(keptLinkPath, 'kept-link\n')
    mkdirSync(path.dirname(trackingPath), { recursive: true })
    const trackingJson = JSON.stringify({
      version: '1.0.0',
      installedAt: new Date().toISOString(),
      harness: 'claude',
      skills: [{ name: 'kept', path: keptSkillPath, paths: { claude: keptSkillPath }, installedAt: new Date().toISOString(), harnesses: ['claude'] }],
      mcpServers: [],
    })
    writeFileSync(trackingPath, trackingJson)
    const anchorPath = path.join(home, 'root-skill-anchor')
    mkdirSync(anchorPath)
    const frontierPath = path.join(anchorPath, 'whole-skill')
    const frontierEvidence: FallbackFrontierEvidence = {
      frontierPath,
      activation: 'required',
      anchor: await frontierAnchorIdentity(anchorPath),
      leaves: [{ id: 'skill:whole', role: 'skill', activation: 'required', path: frontierPath }],
    }
    const manifest: FallbackTransactionIdentity = {
      installationId: 'claude:fallback',
      harness: 'claude',
      trackingPath,
      trackingDigest: trackingDigest(trackingPath)!,
      protocolVersion: FALLBACK_PROTOCOL_VERSION,
      digestAlgorithm: 'fallback-path-v2',
      nonce: randomUUID(),
      plannedMissingFrontiers: [frontierEvidence],
      ownedSkills: [await pathEvidence(keptSkillPath)],
      ownedLinks: [await pathEvidence(keptLinkPath)],
      ownedMcpFields: [],
      ownedMcpConfigPaths: [await pathEvidence(path.join(home, '.claude.json'))],
      bundleDestinations: [await pathEvidence(frontierPath)],
      approvedDestinationRoots: [path.resolve(path.join(home, '.agents', 'skills')), anchorPath],
    }
    const { handle } = await beginFallbackJournal(manifest)
    await markFallbackJournalMutating(handle)
    const owner = await claimFallbackJournalMutation(manifest, manifestDigestOf(manifest))
    if (!owner) throw new Error('mutation claim failed')
    // The whole staged tree is the skill's managed interior.
    const staged = path.join(home, `staged-root-${randomUUID().slice(0, 8)}`)
    mkdirSync(staged, { recursive: true })
    writeFileSync(path.join(staged, 'SKILL.md'), '# whole skill\n')
    mkdirSync(path.join(staged, 'interior'))
    writeFileSync(path.join(staged, 'interior', 'note.txt'), 'interior\n')
    const registered = await registerFallbackFrontierStage(owner, frontierPath, staged)
    const applied = await applyFallbackEntry(registered, frontierPath)
    assert.equal(readFileSync(path.join(frontierPath, 'SKILL.md'), 'utf8'), '# whole skill\n')
    assert.equal(readFileSync(path.join(frontierPath, 'interior', 'note.txt'), 'utf8'), 'interior\n')
    const publications = publishedFallbackFrontiers(applied)
    assert.equal(publications.length, 1)
    assert.equal(path.resolve(publications[0].frontierPath), frontierPath)
    assert.equal(publications[0].dev, lstatSync(frontierPath).dev)
    assert.equal(publications[0].ino, lstatSync(frontierPath).ino)
    assert.deepEqual(stageContainers({ anchorPath } as never), [])
  })

  it('registers a link frontier whose final skill destination already exists', async () => {
    const fixture = await setupFrontierFixture()
    const destAnchor = path.join(home, 'existing-dest-anchor')
    const linkAnchor = path.join(home, 'existing-link-anchor')
    mkdirSync(destAnchor)
    mkdirSync(linkAnchor)
    const destRoot = path.join(destAnchor, 'skills')
    const linkRoot = path.join(linkAnchor, 'skills')
    const destGammaPath = path.join(destRoot, 'gamma')
    const linkGammaPath = path.join(linkRoot, 'gamma')
    // The final skill destination already exists, so it is an existing leaf —
    // not a frontier leaf. Only the link's parent is a planned-missing
    // frontier, and registration must still bind the link to its skill via
    // the trusted manifest resolver.
    mkdirSync(destGammaPath, { recursive: true })
    writeFileSync(path.join(destGammaPath, 'SKILL.md'), '# gamma existing\n')
    const linkFrontier: FallbackFrontierEvidence = {
      frontierPath: linkRoot,
      activation: 'required',
      anchor: await frontierAnchorIdentity(linkAnchor),
      leaves: [{ id: 'link:gamma', role: 'link', activation: 'required', path: linkGammaPath }],
    }
    const manifest = {
      ...fixture.manifest,
      plannedMissingFrontiers: [linkFrontier],
      bundleDestinations: [await pathEvidence(destGammaPath), await pathEvidence(linkGammaPath)],
      approvedDestinationRoots: [...fixture.manifest.approvedDestinationRoots, destAnchor, linkAnchor],
    }
    const { handle } = await beginFallbackJournal(manifest)
    await markFallbackJournalMutating(handle)
    const owner = await claimFallbackJournalMutation(manifest, manifestDigestOf(manifest))
    if (!owner) throw new Error('mutation claim failed')
    const stagedLink = path.join(home, `staged-link-${randomUUID().slice(0, 8)}`)
    mkdirSync(stagedLink, { recursive: true })
    symlinkSync(destGammaPath, path.join(stagedLink, 'gamma'))
    const registered = await registerFallbackFrontierStage(owner, linkRoot, stagedLink)
    const applied = await applyFallbackEntry(registered, linkRoot)
    assert.equal(lstatSync(linkGammaPath).isSymbolicLink(), true)
    assert.equal(readlinkSync(linkGammaPath), destGammaPath)
    assert.equal(readFileSync(path.join(destGammaPath, 'SKILL.md'), 'utf8'), '# gamma existing\n')
    assert.equal(publishedFallbackFrontiers(applied).length, 1)
  })

  it('preserves a foreign replacement of the stage container when registration fails', async () => {
    const fixture = await setupFrontierFixture()
    const owner = await beginMutatingFrontier(fixture)
    const staged = await buildStagedFrontier()
    const foreign = path.join(home, 'foreign-stage')
    mkdirSync(foreign)
    writeFileSync(path.join(foreign, 'foreign.txt'), 'FOREIGN')
    setFallbackFrontierPublicationSeamForTests((event) => {
      if (event.phase === 'stage-ready') {
        // Move the allocated container aside, put a foreign directory in its
        // pathname, and corrupt the disk revision so the durable CAS fails.
        const containers = readdirSync(fixture.anchorPath).filter((name) => name.includes('.nsolid-stage-'))
        const containerPath = path.join(fixture.anchorPath, containers[0])
        renameSync(containerPath, path.join(home, 'stashed-stage'))
        renameSync(foreign, containerPath)
        const disk = JSON.parse(readFileSync(owner.journalPath, 'utf8')) as { revision: number }
        disk.revision += 1000
        writeFileSync(owner.journalPath, JSON.stringify(disk, null, 2) + '\n')
      }
    })
    try {
      await assert.rejects(registerFrontierStageWithBeta(owner, fixture.frontierPath, staged), /Invalid fallback journal/)
      // The foreign replacement is preserved (authenticated cleanup refuses
      // to destroy an unproven container) and the stashed original too.
      const containers = readdirSync(fixture.anchorPath).filter((name) => name.includes('.nsolid-stage-'))
      assert.equal(containers.length, 1)
      assert.equal(readFileSync(path.join(fixture.anchorPath, containers[0], 'foreign.txt'), 'utf8'), 'FOREIGN')
      assert.equal(existsSync(path.join(home, 'stashed-stage', 'payload', 'alpha', 'SKILL.md')), true)
      assert.equal(existsSync(fixture.frontierPath), false)
    } finally {
      setFallbackFrontierPublicationSeamForTests()
    }
  })

  it('reports a completed publication when only post-apply bookkeeping fails', async () => {
    const fixture = await setupFrontierFixture()
    const owner = await beginMutatingFrontier(fixture)
    const staged = await buildStagedFrontier()
    const registered = await registerFrontierStageWithBeta(owner, fixture.frontierPath, staged)
    setFallbackFrontierPublicationSeamForTests((event) => {
      if (event.phase === 'after-applied') {
        // The first CAS has already durably recorded applied:true and stage
        // cleanup succeeds right after; corrupt the disk revision so the
        // post-apply bookkeeping CAS fails.
        const disk = JSON.parse(readFileSync(registered.journalPath, 'utf8')) as { revision: number }
        disk.revision += 1000
        writeFileSync(registered.journalPath, JSON.stringify(disk, null, 2) + '\n')
      }
    })
    try {
      // The publication IS complete: a bookkeeping failure must never become
      // FALLBACK_FRONTIER_PUBLICATION_INCOMPLETE and must never promise a
      // pending journal or a preserved stage.
      const completed = await applyFallbackEntry(registered, fixture.frontierPath)
      assert.equal(readFileSync(path.join(fixture.frontierPath, 'alpha', 'SKILL.md'), 'utf8'), '# alpha staged\n')
      assert.equal(readFileSync(path.join(fixture.frontierPath, 'beta', 'SKILL.md'), 'utf8'), '# beta staged\n')
      const publications = publishedFallbackFrontiers(completed)
      assert.equal(publications.length, 1)
      assert.equal(publications[0].cleanupPending, true)
      // Stage cleanup already succeeded before the bookkeeping failure.
      assert.deepEqual(stageContainers(fixture), [])
      const disk = JSON.parse(readFileSync(completed.journalPath, 'utf8')) as { entries: Array<{ path: string; applied?: boolean }> }
      const entry = disk.entries.find((candidate) => path.resolve(candidate.path) === path.resolve(fixture.frontierPath))
      assert.equal(entry?.applied, true)
    } finally {
      setFallbackFrontierPublicationSeamForTests()
    }
  })

  it('rejects staged frontier trees exceeding the structural bounds before allocation', async () => {
    const fixture = await setupFrontierFixture()
    const owner = await beginMutatingFrontier(fixture)
    const staged = path.join(home, `staged-deep-${randomUUID().slice(0, 8)}`)
    mkdirSync(path.join(staged, 'alpha'), { recursive: true })
    writeFileSync(path.join(staged, 'alpha', 'SKILL.md'), '# alpha\n')
    // The deep chain lives inside the planned directory leaf `beta` (its
    // interior is managed content), keeping the leaf graph exact so the
    // failure is proven by the depth bound, not by classification.
    let deep = path.join(staged, 'beta')
    for (let depth = 0; depth <= 16; depth++) {
      deep = path.join(deep, `level-${depth}`)
    }
    mkdirSync(deep, { recursive: true })
    writeFileSync(path.join(deep, 'note.txt'), 'deep\n')
    await assert.rejects(registerFrontierStageWithBeta(owner, fixture.frontierPath, staged), /maximum depth/)
    assert.equal(existsSync(fixture.frontierPath), false)
    assert.deepEqual(stageContainers(fixture), [])
  })

  it('reports cleanup-pending when authenticated stage cleanup refuses, even with successful bookkeeping', async () => {
    const fixture = await setupFrontierFixture()
    const owner = await beginMutatingFrontier(fixture)
    const staged = await buildStagedFrontier()
    const registered = await registerFrontierStageWithBeta(owner, fixture.frontierPath, staged)
    setFallbackFrontierPublicationSeamForTests((event) => {
      if (event.phase === 'post-population') {
        // An unexpected direct child makes the authenticated container proof
        // fail, so cleanup refuses and preserves the stage; the bookkeeping
        // CAS after cleanup still succeeds.
        writeFileSync(path.join(fixture.anchorPath, stageContainers(fixture)[0], 'smuggled.txt'), 'SMUGGLED')
      }
    })
    try {
      const completed = await applyFallbackEntry(registered, fixture.frontierPath)
      // Publication is complete and the bookkeeping CAS succeeded.
      const disk = JSON.parse(readFileSync(completed.journalPath, 'utf8')) as { entries: Array<{ path: string; applied?: boolean; stage?: string }> }
      const entry = disk.entries.find((candidate) => path.resolve(candidate.path) === path.resolve(fixture.frontierPath))
      assert.equal(entry?.applied, true)
      // Cleanup refused: the stage is preserved with its smuggled child and
      // the record is frozen cleanup-pending.
      assert.equal(stageContainers(fixture).length, 1)
      assert.equal(readFileSync(path.join(fixture.anchorPath, stageContainers(fixture)[0], 'smuggled.txt'), 'utf8'), 'SMUGGLED')
      const publications = publishedFallbackFrontiers(completed)
      assert.equal(publications.length, 1)
      assert.equal(publications[0].cleanupPending, true)
    } finally {
      setFallbackFrontierPublicationSeamForTests()
    }
  })

  it('fails oversized post-registration tamper within bounds before any live mutation', async () => {
    const fixture = await setupFrontierFixture()
    const owner = await beginMutatingFrontier(fixture)
    const staged = await buildStagedFrontier()
    const registered = await registerFrontierStageWithBeta(owner, fixture.frontierPath, staged)
    const container = stageContainers(fixture)[0]
    assert.ok(container)
    // Replace a small registered file with content beyond the per-file bound.
    const bigPath = path.join(fixture.anchorPath, container, 'payload', 'alpha', 'SKILL.md')
    writeFileSync(bigPath, 'x'.repeat(8 * 1024 * 1024 + 1))
    let reachedReserve = false
    setFallbackFrontierPublicationSeamForTests((event) => {
      if (event.phase === 'before-reserve') reachedReserve = true
    })
    try {
      await assert.rejects(applyFallbackEntry(registered, fixture.frontierPath), /exceeds the maximum file size/)
      // The failure happened inside the single bounded walk, before the
      // reservation seam: no unbounded read and zero live mutation.
      assert.equal(reachedReserve, false)
      assert.equal(existsSync(fixture.frontierPath), false)
      assert.equal(stageContainers(fixture).length, 1)
    } finally {
      setFallbackFrontierPublicationSeamForTests()
    }
  })

  it('returns frozen copies whose mutation cannot alter later publishedFallbackFrontiers reads', async () => {
    // A genuine publication through the integration-style frontier APIs: the
    // process-local record is created only by a real applyFallbackEntry call.
    const { fixture, applied } = await setupPublishedFrontier()
    const authentic = {
      frontierPath: path.resolve(fixture.frontierPath),
      dev: lstatSync(fixture.frontierPath).dev,
      ino: lstatSync(fixture.frontierPath).ino,
      stageDigest: await pathDigest(fixture.frontierPath),
      cleanupPending: false,
    }
    const first = publishedFallbackFrontiers(applied)
    assert.equal(first.length, 1)
    // Attack every mutable field of the returned copy. Object.freeze makes
    // strict-mode writes throw (ESM tests are strict); both a throw and a
    // silently ignored write are acceptable, the source of truth must not
    // move either way.
    const record = first[0] as unknown as Record<string, unknown>
    const attacks: Array<[string, unknown]> = [
      ['frontierPath', path.resolve(home, 'elsewhere')],
      ['dev', 999999],
      ['ino', 999999],
      ['stageDigest', 'f'.repeat(64)],
      ['cleanupPending', true],
    ]
    for (const [field, value] of attacks) {
      try {
        record[field] = value
      } catch { /* strict-mode frozen write throws; both outcomes are safe */ }
    }
    // Adding properties must not work either.
    try {
      ;(record as Record<string, unknown>).planted = true
    } catch { /* same */ }
    const second = publishedFallbackFrontiers(applied)
    assert.equal(second.length, 1)
    assert.equal(path.resolve(second[0].frontierPath), authentic.frontierPath)
    assert.equal(second[0].dev, authentic.dev)
    assert.equal(second[0].ino, authentic.ino)
    assert.equal(second[0].stageDigest, authentic.stageDigest)
    assert.equal(second[0].cleanupPending, false)
    assert.equal(Object.isFrozen(second[0]), true)
  })
})
describe('fallback journal frontier rollback authority', () => {
  const quarantineContainers = (anchorPath: string): string[] =>
    readdirSync(anchorPath).filter((name) => name.includes('.nsolid-quarantine-'))

  afterEach(() => {
    setFallbackFrontierRollbackSeamForTests()
    setFallbackFrontierPublicationSeamForTests()
  })

  it('rolls a genuine same-process publication back to missing and preserves the exact tree in quarantine', async () => {
    const { fixture, applied } = await setupPublishedFrontier()
    assert.equal(publishedFallbackFrontiers(applied).length, 1)
    const inoBefore = lstatSync(fixture.frontierPath).ino
    const restore = await restoreFallbackJournal(applied)
    // The physical restore IS complete: the missing state is back.
    assert.equal(restore.succeeded, true)
    assert.equal(restore.frontierJournalPending, undefined)
    assert.equal(existsSync(fixture.frontierPath), false)
    assert.deepEqual(publishedFallbackFrontiers(applied), [])
    // The quarantine preserves the exact proven tree as a reporting artifact.
    const containers = quarantineContainers(fixture.anchorPath)
    assert.equal(containers.length, 1)
    const movedRoot = path.join(fixture.anchorPath, containers[0], path.basename(fixture.frontierPath))
    assert.equal(readFileSync(path.join(movedRoot, 'alpha', 'SKILL.md'), 'utf8'), '# alpha staged\n')
    assert.equal(readFileSync(path.join(movedRoot, 'beta', 'SKILL.md'), 'utf8'), '# beta staged\n')
    assert.equal(lstatSync(movedRoot).ino, inoBefore)
    // A mutator handle deliberately leaves the journal for its owner; the
    // rollback itself completed (missing state + preserved quarantine).
    assert.equal(existsSync(applied.journalPath), true)
  })

  it('lets a locally reclaimed owner roll back its own publication', async () => {
    const fixture = await setupFrontierFixture()
    const first = await beginMutatingFrontier(fixture)
    const staged = await buildStagedFrontier()
    const registered = await registerFrontierStageWithBeta(first, fixture.frontierPath, staged)
    const applied = await applyFallbackEntry(registered, fixture.frontierPath)
    // Reclaim in the SAME process: the completion capability survives the
    // handle spread and binds to the transaction, so the new mutator handle
    // still holds the rollback authority.
    const reclaimed = await reclaimFallbackJournalMutation(applied)
    const restore = await restoreFallbackJournal(reclaimed)
    assert.equal(restore.succeeded, true)
    assert.equal(existsSync(fixture.frontierPath), false)
    assert.equal(quarantineContainers(fixture.anchorPath).length, 1)
  })

  it('fail-closes when the process-local capability is cleared (simulated restart)', async () => {
    const { fixture, applied } = await setupPublishedFrontier()
    clearFallbackFrontierPublicationStateForTests()
    const before = lstatSync(fixture.frontierPath)
    const restore = await restoreFallbackJournal(applied)
    assert.equal(restore.succeeded, false)
    assert.equal(restore.unproven, true)
    // The live frontier is preserved untouched, never renamed or deleted.
    assert.equal(lstatSync(fixture.frontierPath).ino, before.ino)
    assert.equal(readFileSync(path.join(fixture.frontierPath, 'alpha', 'SKILL.md'), 'utf8'), '# alpha staged\n')
    assert.deepEqual(restore.preservedPaths, [path.resolve(fixture.frontierPath)])
    assert.equal(existsSync(applied.journalPath), true)
  })

  it('never lets forged disk fields grant rollback authority', async () => {
    const { fixture, applied } = await setupPublishedFrontier()
    clearFallbackFrontierPublicationStateForTests()
    // Forge the full disk authorization surface: applied, stage digest, and a
    // fabricated quarantine identity. None of it may move the live root.
    const disk = JSON.parse(readFileSync(applied.journalPath, 'utf8')) as { revision: number; entries: Array<{ path: string; applied?: boolean; stageDigest?: string; quarantine?: string }> }
    const entry = disk.entries.find((candidate) => path.resolve(candidate.path) === path.resolve(fixture.frontierPath))
    assert.ok(entry)
    entry.applied = true
    entry.stageDigest = await pathDigest(fixture.frontierPath)
    disk.revision = JSON.parse(readFileSync(applied.journalPath, 'utf8')).revision
    writeFileSync(applied.journalPath, JSON.stringify(disk, null, 2) + '\n')
    const before = lstatSync(fixture.frontierPath)
    const restore = await restoreFallbackJournal(applied)
    assert.equal(restore.succeeded, false)
    assert.equal(restore.unproven, true)
    assert.equal(lstatSync(fixture.frontierPath).ino, before.ino)
    assert.equal(readFileSync(path.join(fixture.frontierPath, 'alpha', 'SKILL.md'), 'utf8'), '# alpha staged\n')
  })

  it('preserves a drifted frontier and reports the rollback unproven', async () => {
    type Drift = { label: string; tamper: (frontierPath: string, anchorPath: string) => void }
    const drifts: Drift[] = [
      { label: 'content drift', tamper: (frontierPath) => { writeFileSync(path.join(frontierPath, 'alpha', 'SKILL.md'), '# tampered\n') } },
      { label: 'extra child', tamper: (frontierPath) => { writeFileSync(path.join(frontierPath, 'stray.txt'), 'FOREIGN\n') } },
      { label: 'symlink child', tamper: (frontierPath, anchorPath) => { symlinkSync(path.join(anchorPath, 'elsewhere'), path.join(frontierPath, 'gamma')) } },
    ]
    for (const { label, tamper } of drifts) {
      const fixture = await setupFrontierFixture()
      const { journal, handle } = await beginFallbackJournal(fixture.manifest)
      await markFallbackJournalMutating(handle)
      const owner = await claimFallbackJournalMutation(fixture.manifest, manifestDigestOf(fixture.manifest))
      if (!owner) throw new Error('mutation claim failed')
      const staged = await buildStagedFrontier()
      const registered = await registerFrontierStageWithBeta(owner, fixture.frontierPath, staged)
      const applied = await applyFallbackEntry(registered, fixture.frontierPath)
      tamper(fixture.frontierPath, fixture.anchorPath)
      const before = lstatSync(fixture.frontierPath)
      const restore = await restoreFallbackJournal(applied)
      assert.equal(restore.succeeded, false, label)
      assert.equal(restore.unproven, true, label)
      assert.equal(lstatSync(fixture.frontierPath).ino, before.ino, label)
      assert.equal(quarantineContainers(fixture.anchorPath).length, 0, label)
      assert.equal(existsSync(applied.journalPath), true, label)
      // Reset for the next iteration: remove the anchor (with the drift) and
      // dispose this transaction's journal so the next begin can reserve it.
      rmSync(fixture.anchorPath, { recursive: true, force: true })
      rmSync(applied.journalPath, { force: true })
      rmSync(journal.snapshotDirectory!, { recursive: true, force: true })
    }
  })

  it('preserves a frontier whose root identity was replaced after publication', async () => {
    const { fixture, applied } = await setupPublishedFrontier()
    // Swap the published root for a byte-identical but different-inode copy.
    const stashed = path.join(home, 'stashed-root')
    renameSync(fixture.frontierPath, stashed)
    const copy = path.join(home, 'copied-root')
    cpSync(stashed, copy, { recursive: true, verbatimSymlinks: true })
    renameSync(copy, fixture.frontierPath)
    rmSync(stashed, { recursive: true, force: true })
    const restore = await restoreFallbackJournal(applied)
    assert.equal(restore.succeeded, false)
    assert.equal(restore.unproven, true)
    assert.equal(existsSync(fixture.frontierPath), true)
    assert.equal(readFileSync(path.join(fixture.frontierPath, 'alpha', 'SKILL.md'), 'utf8'), '# alpha staged\n')
    assert.equal(quarantineContainers(fixture.anchorPath).length, 0)
  })

  it('preserves a partially published frontier (never proven complete)', async () => {
    const fixture = await setupFrontierFixture()
    const owner = await beginMutatingFrontier(fixture)
    const staged = await buildStagedFrontier()
    const registered = await registerFrontierStageWithBeta(owner, fixture.frontierPath, staged)
    // Native-separator leaf match as above; the injected failure must fire
    // for the unproven-restore assertions below to be exercised.
    let injectorReached = false
    setFallbackFrontierPublicationSeamForTests((event) => {
      if (event.phase === 'before-leaf' && event.leaf === path.join('beta', 'SKILL.md')) {
        injectorReached = true
        throw new Error('injected failure')
      }
    })
    try {
      await assert.rejects(applyFallbackEntry(registered, fixture.frontierPath), /FALLBACK_FRONTIER_PUBLICATION_INCOMPLETE/)
      assert.equal(injectorReached, true)
      // No completion record exists, so the restore can never quarantine it.
      const restore = await restoreFallbackJournal(registered)
      assert.equal(restore.succeeded, false)
      assert.equal(restore.unproven, true)
      assert.equal(existsSync(path.join(fixture.frontierPath, 'alpha', 'SKILL.md')), true)
      assert.equal(existsSync(path.join(fixture.frontierPath, 'beta', 'SKILL.md')), false)
      assert.equal(quarantineContainers(fixture.anchorPath).length, 0)
    } finally {
      setFallbackFrontierPublicationSeamForTests()
    }
  })

  it('keeps an external parent without publication capability preserve-only', async () => {
    // Simulated by clearing the registry after a genuine publication in this
    // same process, since the suite cannot spawn a real second process: the
    // semantic under test is the absence of capability, not the process id.
    const { fixture, applied } = await setupPublishedFrontier()
    clearFallbackFrontierPublicationStateForTests()
    const restore = await restoreFallbackJournal(applied)
    assert.equal(restore.succeeded, false)
    assert.equal(restore.unproven, true)
    assert.equal(existsSync(fixture.frontierPath), true)
  })

  it('keeps next-run recovery strictly preserve-only for a published frontier', async () => {
    const fixture = await setupFrontierFixture()
    const owner = await beginMutatingFrontier(fixture)
    const staged = await buildStagedFrontier()
    const registered = await registerFrontierStageWithBeta(owner, fixture.frontierPath, staged)
    await applyFallbackEntry(registered, fixture.frontierPath)
    clearFallbackFrontierPublicationStateForTests()
    const recovery = await recoverFallbackJournal(fixture.trackingPath)
    assert.equal(recovery.pending, true)
    assert.equal(recovery.recovered, false)
    assert.ok(recovery.preservedPaths.includes(path.resolve(fixture.frontierPath)))
    assert.equal(existsSync(fixture.frontierPath), true)
  })

  it('consumes capabilities and rejects a genuine handle retargeted in place to another live transaction', async () => {
    const { fixture, applied } = await setupPublishedFrontier()
    const first = await restoreFallbackJournal(applied)
    assert.equal(first.succeeded, true)
    assert.equal(existsSync(fixture.frontierPath), false)
    // Replay against the same handle: the rollback consumed the one-shot
    // capability AND the CAS bumped the revision, so the stale handle fails
    // closed without touching anything.
    const replay = await restoreFallbackJournal(applied)
    assert.equal(replay.succeeded, false)
    assert.equal(replay.unproven, true)
    assert.equal(existsSync(fixture.frontierPath), false)
    // A second frontier published by another transaction must not be
    // reachable from the first transaction's handles. Dispose the first
    // transaction's pending journal (mutator leaves it) and snapshots so the
    // second begin can reserve the journal path.
    rmSync(applied.journalPath, { force: true })
    const trackingDir = path.dirname(getTrackingFilePath())
    for (const name of readdirSync(trackingDir)) {
      if (name.startsWith('.nsolid-plugin-update-')) rmSync(path.join(trackingDir, name), { recursive: true, force: true })
    }
    rmSync(path.join(home, 'frontier-anchor'), { recursive: true, force: true })
    const second = await setupFrontierFixture()
    const secondOwner = await beginMutatingFrontier(second)
    const secondStaged = await buildStagedFrontier()
    const secondRegistered = await registerFrontierStageWithBeta(secondOwner, second.frontierPath, secondStaged)
    const secondApplied = await applyFallbackEntry(secondRegistered, second.frontierPath)
    // Retarget the still-genuine transaction-A object in place with every
    // valid current field from transaction B. A WeakSet-only gate accepts the
    // object and reaches B; immutable WeakMap issuance metadata must reject it.
    Object.assign(applied as unknown as Record<string, unknown>, secondApplied)
    const secondBefore = lstatSync(second.frontierPath)
    const cross = await restoreFallbackJournal(applied)
    assert.equal(cross.succeeded, false)
    assert.equal(cross.unproven, true)
    assert.equal(lstatSync(second.frontierPath).ino, secondBefore.ino)
    assert.equal(quarantineContainers(second.anchorPath).length, 0)
    // B's own genuine current handle still succeeds, proving the rejection
    // came from issued-object binding rather than invalid transaction fields.
    const secondRestore = await restoreFallbackJournal(secondApplied)
    assert.equal(secondRestore.succeeded, true)
    assert.equal(existsSync(second.frontierPath), false)
    // The first handle still cannot reach the second (now missing) frontier
    // and the first transaction's quarantine remains intact.
    assert.equal(quarantineContainers(second.anchorPath).length, 1)
  })

  it('rolls back two completed frontiers healthily with both quarantines and overall success', async () => {
    const fixture = await setupFrontierFixture()
    const destAnchor = path.join(home, 'two-dest-anchor')
    const linkAnchor = path.join(home, 'two-link-anchor')
    mkdirSync(destAnchor)
    mkdirSync(linkAnchor)
    const destRoot = path.join(destAnchor, 'skills')
    const linkRoot = path.join(linkAnchor, 'skills')
    const destGammaPath = path.join(destRoot, 'gamma')
    const linkGammaPath = path.join(linkRoot, 'gamma')
    const skillFrontier = {
      frontierPath: destRoot,
      activation: 'required' as const,
      anchor: await frontierAnchorIdentity(destAnchor),
      leaves: [{ id: 'skill:gamma', role: 'skill' as const, activation: 'required' as const, path: destGammaPath }],
    }
    const linkFrontier = {
      frontierPath: linkRoot,
      activation: 'required' as const,
      anchor: await frontierAnchorIdentity(linkAnchor),
      leaves: [{ id: 'link:gamma', role: 'link' as const, activation: 'required' as const, path: linkGammaPath }],
    }
    const manifest = {
      ...fixture.manifest,
      plannedMissingFrontiers: [skillFrontier, linkFrontier],
      bundleDestinations: [await pathEvidence(destGammaPath), await pathEvidence(linkGammaPath)],
      approvedDestinationRoots: [...fixture.manifest.approvedDestinationRoots, destAnchor, linkAnchor],
    }
    rmSync(fallbackJournalPath(getTrackingFilePath()), { force: true })
    const { handle } = await beginFallbackJournal(manifest)
    await markFallbackJournalMutating(handle)
    const owner = await claimFallbackJournalMutation(manifest, manifestDigestOf(manifest))
    if (!owner) throw new Error('mutation claim failed')
    const stagedDest = path.join(home, `two-staged-dest-${randomUUID().slice(0, 8)}`)
    mkdirSync(path.join(stagedDest, 'gamma'), { recursive: true })
    writeFileSync(path.join(stagedDest, 'gamma', 'SKILL.md'), '# gamma two\n')
    const stagedLink = path.join(home, `two-staged-link-${randomUUID().slice(0, 8)}`)
    mkdirSync(stagedLink, { recursive: true })
    symlinkSync(destGammaPath, path.join(stagedLink, 'gamma'))
    const withDest = await registerFallbackFrontierStage(owner, destRoot, stagedDest)
    const withLink = await registerFallbackFrontierStage(withDest, linkRoot, stagedLink)
    const appliedLink = await applyFallbackEntry(withLink, linkRoot)
    const appliedBoth = await applyFallbackEntry(appliedLink, destRoot)
    assert.equal(publishedFallbackFrontiers(appliedBoth).length, 2)
    const restore = await restoreFallbackJournal(appliedBoth)
    // Healthy multi-frontier rollback: BOTH quarantines reported, overall success.
    assert.equal(restore.succeeded, true)
    assert.equal(restore.frontierJournalPending, undefined)
    assert.equal(restore.preservedArtifacts.length, 2)
    assert.equal(quarantineContainers(destAnchor).length, 1)
    assert.equal(quarantineContainers(linkAnchor).length, 1)
    assert.equal(existsSync(destRoot), false)
    assert.equal(existsSync(linkRoot), false)
    assert.deepEqual(publishedFallbackFrontiers(appliedBoth), [])
  })

  it('reports a structured incomplete when an unplanned child appears at the moved seam', async () => {
    const { fixture, applied } = await setupPublishedFrontier()
    let quarantineContainer: string | undefined
    setFallbackFrontierRollbackSeamForTests((event) => {
      if (event.phase === 'moved') {
        quarantineContainer = path.dirname(event.quarantinePath!)
        writeFileSync(path.join(event.quarantinePath!, 'stray-unplanned.txt'), 'FOREIGN\n')
      }
    })
    try {
      const restore = await restoreFallbackJournal(applied)
      // One structured incomplete outcome: exact container, durable pending
      // retained, no partial success.
      assert.equal(restore.succeeded, false)
      assert.equal(restore.unproven, true)
      assert.ok(quarantineContainer)
      assert.deepEqual(restore.preservedArtifacts, [path.resolve(quarantineContainer!)])
      assert.equal(readFileSync(path.join(quarantineContainer!, path.basename(fixture.frontierPath), 'stray-unplanned.txt'), 'utf8'), 'FOREIGN\n')
      assert.equal(existsSync(applied.journalPath), true)
      const disk = JSON.parse(readFileSync(applied.journalPath, 'utf8')) as { entries: Array<{ path: string; frontierRollbackPending?: boolean; quarantine?: string }> }
      const entry = disk.entries.find((candidate) => path.resolve(candidate.path) === path.resolve(fixture.frontierPath))
      assert.equal(entry?.frontierRollbackPending, true)
      assert.ok(entry?.quarantine?.includes('.nsolid-quarantine-'))
    } finally {
      setFallbackFrontierRollbackSeamForTests()
    }
  })

  it('reports the exact quarantine after an ordinary post-allocation seam error', async () => {
    const { fixture, applied } = await setupPublishedFrontier()
    let quarantineContainer: string | undefined
    setFallbackFrontierRollbackSeamForTests(async (event) => {
      if (event.phase === 'quarantine-ready') {
        quarantineContainer = path.dirname(event.quarantinePath!)
        throw new Error('ordinary runtime failure')
      }
    })
    try {
      const restore = await restoreFallbackJournal(applied)
      assert.equal(restore.succeeded, false)
      assert.equal(restore.unproven, true)
      assert.ok(quarantineContainer)
      assert.deepEqual(restore.preservedArtifacts, [path.resolve(quarantineContainer!)])
      assert.equal(existsSync(fixture.frontierPath), true)
      assert.equal(readFileSync(path.join(fixture.frontierPath, 'alpha', 'SKILL.md'), 'utf8'), '# alpha staged\n')
      assert.equal(existsSync(applied.journalPath), true)
      const disk = JSON.parse(readFileSync(applied.journalPath, 'utf8')) as { entries: Array<{ path: string; frontierRollbackPending?: boolean; quarantine?: string }> }
      const entry = disk.entries.find((candidate) => path.resolve(candidate.path) === path.resolve(fixture.frontierPath))
      assert.equal(entry?.frontierRollbackPending, true)
      assert.equal(path.dirname(path.resolve(entry!.quarantine!)), path.resolve(quarantineContainer!))
    } finally {
      setFallbackFrontierRollbackSeamForTests()
    }
  })

  it('preserves everything when the authenticated quarantine container is replaced by a symlink at the quarantine-ready seam', async () => {
    const { fixture, applied } = await setupPublishedFrontier()
    // Foreign test-owned target the substituted symlink points at. It lives
    // inside the temp home so afterEach cleanup never touches anything
    // outside the test's own artifacts.
    const foreignTarget = path.join(home, 'foreign-quarantine-target')
    mkdirSync(foreignTarget)
    writeFileSync(path.join(foreignTarget, 'foreign-sentinel.txt'), 'FOREIGN\n')
    let substitutedContainer: string | undefined
    setFallbackFrontierRollbackSeamForTests(async (event) => {
      if (event.phase === 'quarantine-ready') {
        substitutedContainer = path.dirname(event.quarantinePath!)
        // Displace the real container (same filesystem, test-owned temp home)
        // and replace its path with a symlink to the foreign directory: the
        // rollback must re-prove container identity BEFORE the move and
        // refuse to move the frontier through the link.
        renameSync(substitutedContainer, path.join(home, 'displaced-original-quarantine-container'))
        symlinkSync(foreignTarget, substitutedContainer)
      }
    })
    try {
      const restore = await restoreFallbackJournal(applied)
      // Structured preservation: the symlinked container is reported, the
      // durable pending state stays, and nothing followed the link.
      assert.equal(restore.succeeded, false)
      assert.equal(restore.unproven, true)
      assert.ok(substitutedContainer)
      assert.deepEqual(restore.preservedArtifacts, [path.resolve(substitutedContainer!)])
      // The live frontier was never moved through the symlink.
      assert.equal(existsSync(fixture.frontierPath), true)
      assert.equal(readFileSync(path.join(fixture.frontierPath, 'alpha', 'SKILL.md'), 'utf8'), '# alpha staged\n')
      // The foreign target was never written into.
      assert.equal(readFileSync(path.join(foreignTarget, 'foreign-sentinel.txt'), 'utf8'), 'FOREIGN\n')
      assert.deepEqual(readdirSync(foreignTarget), ['foreign-sentinel.txt'])
      // The substituted container path still exists (as the symlink) and is
      // preserved as evidence; the displaced original stays in the temp home.
      assert.equal(quarantineContainers(fixture.anchorPath).length, 1)
      assert.ok(lstatSync(substitutedContainer!).isSymbolicLink())
      assert.equal(existsSync(applied.journalPath), true)
      const disk = JSON.parse(readFileSync(applied.journalPath, 'utf8')) as { entries: Array<{ path: string; frontierRollbackPending?: boolean; quarantine?: string }> }
      const entry = disk.entries.find((candidate) => path.resolve(candidate.path) === path.resolve(fixture.frontierPath))
      assert.equal(entry?.frontierRollbackPending, true)
      assert.equal(path.dirname(path.resolve(entry!.quarantine!)), path.resolve(substitutedContainer!))
      // The destructive publication authority was retired (observable as an
      // empty publication list), so a replay can never move anything.
      assert.deepEqual(publishedFallbackFrontiers(applied), [])
    } finally {
      setFallbackFrontierRollbackSeamForTests()
    }
  })

  it('rejects the move and preserves the collision when an empty directory appears at the quarantine payload destination', async () => {
    const { fixture, applied } = await setupPublishedFrontier()
    let collisionContainer: string | undefined
    let collisionPath: string | undefined
    setFallbackFrontierRollbackSeamForTests(async (event) => {
      if (event.phase === 'quarantine-ready') {
        collisionContainer = path.dirname(event.quarantinePath!)
        collisionPath = event.quarantinePath!
        // An empty directory at the exact payload destination: the pre-move
        // proof must see it and refuse to rename over it.
        mkdirSync(event.quarantinePath!)
      }
    })
    try {
      const restore = await restoreFallbackJournal(applied)
      assert.equal(restore.succeeded, false)
      assert.equal(restore.unproven, true)
      assert.ok(collisionContainer)
      assert.deepEqual(restore.preservedArtifacts, [path.resolve(collisionContainer!)])
      // The live frontier bytes are intact and were never moved.
      assert.equal(existsSync(fixture.frontierPath), true)
      assert.equal(readFileSync(path.join(fixture.frontierPath, 'alpha', 'SKILL.md'), 'utf8'), '# alpha staged\n')
      // The collision was preserved, never overwritten or removed.
      assert.equal(existsSync(collisionPath!), true)
      assert.deepEqual(readdirSync(collisionPath!), [])
      // The quarantine container and its durable pending evidence survive.
      assert.equal(quarantineContainers(fixture.anchorPath).length, 1)
      assert.equal(existsSync(applied.journalPath), true)
      const disk = JSON.parse(readFileSync(applied.journalPath, 'utf8')) as { entries: Array<{ path: string; frontierRollbackPending?: boolean; quarantine?: string }> }
      const entry = disk.entries.find((candidate) => path.resolve(candidate.path) === path.resolve(fixture.frontierPath))
      assert.equal(entry?.frontierRollbackPending, true)
      assert.equal(path.resolve(entry!.quarantine!), path.resolve(collisionPath!))
      // The publication authority was retired; replay cannot move anything.
      assert.deepEqual(publishedFallbackFrontiers(applied), [])
    } finally {
      setFallbackFrontierRollbackSeamForTests()
    }
  })

  it('keeps a reclaimed-owner retry after an ambiguous move incomplete with exact artifact and pending state', async () => {
    const { fixture, applied } = await setupPublishedFrontier()
    let quarantineContainer: string | undefined
    setFallbackFrontierRollbackSeamForTests((event) => {
      if (event.phase === 'moved') {
        quarantineContainer = path.dirname(event.quarantinePath!)
        writeFileSync(path.join(event.quarantinePath!, 'alpha', 'SKILL.md'), 'TAMPERED\n')
      }
    })
    try {
      const first = await restoreFallbackJournal(applied)
      assert.equal(first.succeeded, false)
      assert.equal(first.unproven, true)
      // A legitimately reclaimed owner retries: the durable pending state
      // keeps the retry incomplete — the ambiguous state must be resolved
      // deliberately, never re-rolled or cleaned.
      const reclaimed = await reclaimFallbackJournalMutation(applied)
      const retry = await restoreFallbackJournal(reclaimed)
      assert.equal(retry.succeeded, false)
      assert.equal(retry.unproven, true)
      assert.ok(quarantineContainer)
      assert.deepEqual(retry.preservedArtifacts, [path.resolve(quarantineContainer!)])
      assert.equal(existsSync(fixture.frontierPath), false)
      assert.equal(quarantineContainers(fixture.anchorPath).length, 1)
      assert.equal(existsSync(applied.journalPath), true)
      // Next-run recovery also preserves while pending.
      const recovery = await recoverFallbackJournal(fixture.trackingPath)
      assert.equal(recovery.recovered, false)
      assert.ok(recovery.preservedPaths.includes(path.resolve(fixture.frontierPath)))
    } finally {
      setFallbackFrontierRollbackSeamForTests()
    }
  })

  it('refuses commit while a durable rollback-pending state exists', async () => {
    const { fixture, applied } = await setupPublishedFrontier()
    setFallbackFrontierRollbackSeamForTests((event) => {
      if (event.phase === 'moved') {
        writeFileSync(path.join(event.quarantinePath!, 'alpha', 'SKILL.md'), 'TAMPERED\n')
      }
    })
    try {
      const first = await restoreFallbackJournal(applied)
      assert.equal(first.succeeded, false)
      const reclaimed = await reclaimFallbackJournalMutation(applied)
      await assert.rejects(commitFallbackJournal(reclaimed), /FALLBACK_FRONTIER_ROLLBACK_PENDING/)
      assert.equal(existsSync(applied.journalPath), true)
      assert.equal(quarantineContainers(fixture.anchorPath).length, 1)
    } finally {
      setFallbackFrontierRollbackSeamForTests()
    }
  })

  it('moves nothing when the durable rollback-pending CAS fails before the rename', async () => {
    const { fixture, applied } = await setupPublishedFrontier()
    setFallbackFrontierRollbackSeamForTests((event) => {
      if (event.phase === 'proof-complete') {
        // Corrupt the revision so the durable pending-state CAS fails during
        // preparation (the container is allocated first, but NOTHING moves).
        const disk = JSON.parse(readFileSync(applied.journalPath, 'utf8')) as { revision: number }
        disk.revision += 1000
        writeFileSync(applied.journalPath, JSON.stringify(disk, null, 2) + '\n')
      }
    })
    try {
      const restore = await restoreFallbackJournal(applied)
      assert.equal(restore.succeeded, false)
      assert.equal(restore.unproven, true)
      // Nothing moved, nothing pending, no container: the live frontier is
      // fully intact and the journal carries no pending flag.
      assert.equal(existsSync(fixture.frontierPath), true)
      assert.equal(readFileSync(path.join(fixture.frontierPath, 'alpha', 'SKILL.md'), 'utf8'), '# alpha staged\n')
      // The container was allocated during preparation and is preserved as
      // an artifact; nothing was moved and no pending state was recorded.
      assert.equal(quarantineContainers(fixture.anchorPath).length, 1)
      assert.ok(restore.preservedArtifacts.some((artifact) => artifact.includes('.nsolid-quarantine-')))
      const disk = JSON.parse(readFileSync(applied.journalPath, 'utf8')) as { entries: Array<{ path: string; frontierRollbackPending?: boolean }> }
      const entry = disk.entries.find((candidate) => path.resolve(candidate.path) === path.resolve(fixture.frontierPath))
      assert.equal(entry?.frontierRollbackPending, undefined)
    } finally {
      setFallbackFrontierRollbackSeamForTests()
    }
  })

  it('rejects same-revision transaction identity tampering before the pending-state CAS', async () => {
    const { fixture, applied } = await setupPublishedFrontier()
    setFallbackFrontierRollbackSeamForTests((event) => {
      if (event.phase === 'proof-complete') {
        // Schema-valid tamper at the SAME revision: swap the transaction
        // identity the durable pending-state CAS is about to compare
        // against. Full-state equality must reject it.
        const disk = JSON.parse(readFileSync(applied.journalPath, 'utf8')) as { revision: number; transactionId: string }
        disk.transactionId = randomUUID()
        writeFileSync(applied.journalPath, JSON.stringify(disk, null, 2) + '\n')
      }
    })
    try {
      const restore = await restoreFallbackJournal(applied)
      assert.equal(restore.succeeded, false)
      assert.equal(restore.unproven, true)
      // The live frontier never moved.
      assert.equal(existsSync(fixture.frontierPath), true)
      assert.equal(readFileSync(path.join(fixture.frontierPath, 'alpha', 'SKILL.md'), 'utf8'), '# alpha staged\n')
      assert.equal(readFileSync(path.join(fixture.frontierPath, 'beta', 'SKILL.md'), 'utf8'), '# beta staged\n')
      // The allocated container is preserved as evidence; no cleanup ran.
      assert.equal(quarantineContainers(fixture.anchorPath).length, 1)
      assert.ok(restore.preservedArtifacts.some((artifact) => artifact.includes('.nsolid-quarantine-')))
      // The durable tamper itself is preserved untouched (evidence), and no
      // pending flag was ever written by the rejected transaction.
      const disk = JSON.parse(readFileSync(applied.journalPath, 'utf8')) as { transactionId: string; entries: Array<{ path: string; frontierRollbackPending?: boolean }> }
      assert.notEqual(disk.transactionId, applied.transactionId)
      const entry = disk.entries.find((candidate) => path.resolve(candidate.path) === path.resolve(fixture.frontierPath))
      assert.equal(entry?.frontierRollbackPending, undefined)
    } finally {
      setFallbackFrontierRollbackSeamForTests()
    }
  })

  it('rejects same-revision insertion of durable pending ambiguity before the move', async () => {
    const { fixture, applied } = await setupPublishedFrontier()
    setFallbackFrontierRollbackSeamForTests((event) => {
      if (event.phase === 'proof-complete') {
        // Schema-valid same-revision injection of the durable pending
        // ambiguity state the rollback itself would write: the full-state
        // CAS must refuse to build on top of it, and the injected state
        // must survive untouched as preserved evidence.
        const disk = JSON.parse(readFileSync(applied.journalPath, 'utf8')) as { revision: number; entries: Array<{ path: string; frontierRollbackPending?: boolean }> }
        const entry = disk.entries.find((candidate) => path.resolve(candidate.path) === path.resolve(fixture.frontierPath))
        assert.ok(entry)
        entry.frontierRollbackPending = true
        writeFileSync(applied.journalPath, JSON.stringify(disk, null, 2) + '\n')
      }
    })
    try {
      const restore = await restoreFallbackJournal(applied)
      assert.equal(restore.succeeded, false)
      assert.equal(restore.unproven, true)
      // Nothing moved: the live frontier keeps the exact published bytes.
      assert.equal(existsSync(fixture.frontierPath), true)
      assert.equal(readFileSync(path.join(fixture.frontierPath, 'alpha', 'SKILL.md'), 'utf8'), '# alpha staged\n')
      // The container allocated during preparation stays preserved.
      assert.equal(quarantineContainers(fixture.anchorPath).length, 1)
      assert.ok(restore.preservedArtifacts.some((artifact) => artifact.includes('.nsolid-quarantine-')))
      // The injected ambiguity state was never consumed or overwritten by
      // the rejected transaction: it remains durable for manual resolution.
      const disk = JSON.parse(readFileSync(applied.journalPath, 'utf8')) as { entries: Array<{ path: string; frontierRollbackPending?: boolean }> }
      const entry = disk.entries.find((candidate) => path.resolve(candidate.path) === path.resolve(fixture.frontierPath))
      assert.equal(entry?.frontierRollbackPending, true)
    } finally {
      setFallbackFrontierRollbackSeamForTests()
    }
  })

  it('preserves everything when a collision occupies the quarantine container child before the move', async () => {
    const { fixture, applied } = await setupPublishedFrontier()
    const foreign = path.join(home, 'foreign-child')
    mkdirSync(foreign)
    writeFileSync(path.join(foreign, 'foreign.txt'), 'FOREIGN\n')
    let quarantineContainer: string | undefined
    setFallbackFrontierRollbackSeamForTests((event) => {
      if (event.phase === 'quarantine-ready') {
        quarantineContainer = event.quarantinePath === undefined ? undefined : path.dirname(event.quarantinePath)
        renameSync(foreign, event.quarantinePath!)
      }
    })
    try {
      const before = lstatSync(fixture.frontierPath)
      const restore = await restoreFallbackJournal(applied)
      // The collision is preserved: the live root never moved.
      assert.equal(restore.succeeded, false)
      assert.equal(restore.unproven, true)
      assert.equal(lstatSync(fixture.frontierPath).ino, before.ino)
      assert.equal(readFileSync(path.join(fixture.frontierPath, 'alpha', 'SKILL.md'), 'utf8'), '# alpha staged\n')
      // The occupied container keeps the foreign child untouched: it was
      // renamed into the payload path inside the container. The exact
      // allocated container path is the reported artifact (blocker 4).
      assert.ok(quarantineContainer)
      assert.deepEqual(restore.preservedArtifacts, [path.resolve(quarantineContainer!)])
      assert.equal(readFileSync(path.join(quarantineContainer!, path.basename(fixture.frontierPath), 'foreign.txt'), 'utf8'), 'FOREIGN\n')
      assert.equal(existsSync(applied.journalPath), true)
      // The completion capability survives a collision (nothing moved), but
      // a replay with a re-legitimated handle still cannot pass because the
      // original live root is intact and the container is occupied; the
      // replay via the SAME genuine handle is stale-revision refused first.
      const replay = await restoreFallbackJournal(applied)
      assert.equal(replay.succeeded, false)
    } finally {
      setFallbackFrontierRollbackSeamForTests()
    }
  })

  it('preserves the quarantine when a replacement appears at the frontier path after the move', async () => {
    const { fixture, applied } = await setupPublishedFrontier()
    setFallbackFrontierRollbackSeamForTests((event) => {
      if (event.phase === 'moved') {
        // A racing writer creates a replacement at the vacated path inside
        // the rename→prove window.
        mkdirSync(fixture.frontierPath, { recursive: true })
        writeFileSync(path.join(fixture.frontierPath, 'raced.txt'), 'RACED\n')
      }
    })
    try {
      const restore = await restoreFallbackJournal(applied)
      // The ambiguity is preserved: both the raced replacement and the
      // quarantine stay, and the rollback is reported incomplete.
      assert.equal(restore.succeeded, false)
      assert.equal(restore.unproven, true)
      assert.equal(readFileSync(path.join(fixture.frontierPath, 'raced.txt'), 'utf8'), 'RACED\n')
      assert.equal(quarantineContainers(fixture.anchorPath).length, 1)
      assert.equal(existsSync(applied.journalPath), true)
    } finally {
      setFallbackFrontierRollbackSeamForTests()
    }
  })

  it('stops the restore and reports succeeded:false when the bookkeeping CAS fails after the move', async () => {
    const { fixture, applied } = await setupPublishedFrontier()
    // A modified authenticated preexisting entry the restore has not reached
    // yet: it must be reported in preservedPaths because the restore stops
    // at the untrustworthy handle revision.
    writeFileSync(path.join(fixture.keptSkillPath, 'SKILL.md'), 'drifted-before-restore\n')
    setFallbackFrontierRollbackSeamForTests((event) => {
      if (event.phase === 'proven') {
        const disk = JSON.parse(readFileSync(applied.journalPath, 'utf8')) as { revision: number }
        disk.revision += 1000
        writeFileSync(applied.journalPath, JSON.stringify(disk, null, 2) + '\n')
      }
    })
    try {
      const restore = await restoreFallbackJournal(applied)
      // The physical frontier move IS done, but the journal could not be
      // updated: the whole operation is incomplete (never succeeded:true).
      assert.equal(restore.succeeded, false)
      assert.equal(restore.frontierJournalPending, true)
      assert.equal(existsSync(fixture.frontierPath), false)
      // The exact allocated quarantine container is reported as the artifact.
      const containers = quarantineContainers(fixture.anchorPath)
      assert.equal(containers.length, 1)
      assert.deepEqual(restore.preservedArtifacts, [path.resolve(path.join(fixture.anchorPath, containers[0]))])
      // The unrestored modified preexisting target is reported.
      assert.ok(restore.preservedPaths.includes(path.resolve(fixture.keptSkillPath)))
      // Journal stays in place for deliberate resolution.
      assert.equal(existsSync(applied.journalPath), true)
    } finally {
      setFallbackFrontierRollbackSeamForTests()
    }
  })

  it('refuses a role-substituted handle copy with zero mutation', async () => {
    const { fixture, applied } = await setupPublishedFrontier()
    // A forged owner handle: same fields, different object identity, never
    // registered by begin/claim/reclaim, and the journal still records a
    // live same-process mutator.
    const forgedOwner = { ...applied, role: 'owner' as const }
    const before = lstatSync(fixture.frontierPath)
    const restore = await restoreFallbackJournal(forgedOwner)
    assert.equal(restore.succeeded, false)
    assert.equal(restore.unproven, true)
    assert.equal(lstatSync(fixture.frontierPath).ino, before.ino)
    assert.equal(existsSync(fixture.frontierPath), true)
    assert.equal(readFileSync(path.join(fixture.frontierPath, 'alpha', 'SKILL.md'), 'utf8'), '# alpha staged\n')
    assert.equal(quarantineContainers(fixture.anchorPath).length, 0)
  })

  it('refuses a stale unreclaimed owner after a legitimate claim, keeping legitimate reclaim working', async () => {
    const fixture = await setupFrontierFixture()
    const { handle } = await beginFallbackJournal(fixture.manifest)
    const preparedOwner = await markFallbackJournalMutating(handle)
    const claimed = await claimFallbackJournalMutation(fixture.manifest, manifestDigestOf(fixture.manifest))
    if (!claimed) throw new Error('mutation claim failed')
    const staged = await buildStagedFrontier()
    const registered = await registerFrontierStageWithBeta(claimed, fixture.frontierPath, staged)
    const applied = await applyFallbackEntry(registered, fixture.frontierPath)
    // `preparedOwner` is a genuine object but stale: the journal mutator is
    // this process and no reclaim has cleared it.
    const before = lstatSync(fixture.frontierPath)
    const staleRestore = await restoreFallbackJournal(preparedOwner)
    assert.equal(staleRestore.succeeded, false)
    assert.equal(staleRestore.unproven, true)
    assert.equal(lstatSync(fixture.frontierPath).ino, before.ino)
    assert.equal(existsSync(fixture.frontierPath), true)
    assert.equal(quarantineContainers(fixture.anchorPath).length, 0)
    // The genuine reclaimed owner still succeeds: legitimate local reclaim
    // keeps working.
    const reclaimed = await reclaimFallbackJournalMutation(applied)
    const reclaimedRestore = await restoreFallbackJournal(reclaimed)
    assert.equal(reclaimedRestore.succeeded, true)
    assert.equal(existsSync(fixture.frontierPath), false)
  })

  it('treats a tampered quarantined tree at the moved seam as a whole-operation incomplete', async () => {
    const { fixture, applied } = await setupPublishedFrontier()
    let quarantineContainer: string | undefined
    setFallbackFrontierRollbackSeamForTests((event) => {
      if (event.phase === 'moved') {
        quarantineContainer = path.dirname(event.quarantinePath!)
        // Tamper the quarantined content inside the rename→prove window.
        writeFileSync(path.join(event.quarantinePath!, 'alpha', 'SKILL.md'), 'TAMPERED-IN-QUARANTINE\n')
      }
    })
    try {
      const restore = await restoreFallbackJournal(applied)
      // The original path IS missing, but the moved content cannot be proven:
      // the whole operation is incomplete, never a success.
      assert.equal(restore.succeeded, false)
      assert.equal(restore.unproven, true)
      assert.equal(existsSync(fixture.frontierPath), false)
      // The exact allocated container is reported and the tampered content
      // is preserved inside it (never deleted).
      assert.ok(quarantineContainer)
      assert.deepEqual(restore.preservedArtifacts, [path.resolve(quarantineContainer!)])
      assert.equal(readFileSync(path.join(quarantineContainer!, path.basename(fixture.frontierPath), 'alpha', 'SKILL.md'), 'utf8'), 'TAMPERED-IN-QUARANTINE\n')
      // The durable pending state blocks any replay: the ambiguous physical
      // state (missing path + unproven quarantined content) must be resolved
      // deliberately; every retry stays incomplete with the exact artifact.
      const replay = await restoreFallbackJournal(applied)
      assert.equal(replay.succeeded, false)
      assert.equal(replay.unproven, true)
      assert.equal(existsSync(fixture.frontierPath), false)
      assert.equal(quarantineContainers(fixture.anchorPath).length, 1)
      assert.deepEqual(publishedFallbackFrontiers(applied), [])
      // Journal and evidence retained.
      assert.equal(existsSync(applied.journalPath), true)
      const disk = JSON.parse(readFileSync(applied.journalPath, 'utf8')) as { entries: Array<{ path: string; applied?: boolean }> }
      const entry = disk.entries.find((candidate) => path.resolve(candidate.path) === path.resolve(fixture.frontierPath))
      assert.equal(entry?.applied, true)
    } finally {
      setFallbackFrontierRollbackSeamForTests()
    }
  })

  it('publishes only required leaves with an empty selector and rolls back to missing', async () => {
    const fixture = await setupFrontierFixture()
    const owner = await beginMutatingFrontier(fixture)
    // Staged tree contains only the required skill:alpha leaf: the staged
    // payload must exactly match the active selection.
    const staged = path.join(home, `staged-frontier-${randomUUID().slice(0, 8)}`)
    mkdirSync(path.join(staged, 'alpha'), { recursive: true })
    writeFileSync(path.join(staged, 'alpha', 'SKILL.md'), '# alpha staged\n')
    // Default/empty selector: only required skill:alpha is authorized.
    const registered = await registerFallbackFrontierStage(owner, fixture.frontierPath, staged)
    const applied = await applyFallbackEntry(registered, fixture.frontierPath)
    const publications = publishedFallbackFrontiers(applied)
    assert.equal(publications.length, 1)
    // Reporting shows the registered selection: beta (conditional, unselected) is absent.
    assert.deepEqual(publications[0].activeConditionalLeafIds, [])
    // Live tree has alpha only; beta never materialized.
    assert.equal(readFileSync(path.join(fixture.frontierPath, 'alpha', 'SKILL.md'), 'utf8'), '# alpha staged\n')
    assert.equal(existsSync(path.join(fixture.frontierPath, 'beta')), false)
    // Rollback proves the alpha-only tree: success and beta stays absent everywhere.
    const restore = await restoreFallbackJournal(applied)
    assert.equal(restore.succeeded, true)
    assert.equal(existsSync(fixture.frontierPath), false)
    const containers = quarantineContainers(fixture.anchorPath)
    assert.equal(containers.length, 1)
    const movedRoot = path.join(fixture.anchorPath, containers[0], path.basename(fixture.frontierPath))
    assert.equal(readFileSync(path.join(movedRoot, 'alpha', 'SKILL.md'), 'utf8'), '# alpha staged\n')
    assert.equal(existsSync(path.join(movedRoot, 'beta')), false)
    assert.deepEqual(publishedFallbackFrontiers(applied), [])
  })

  it('publishes and proves both leaves with an explicit conditional selection', async () => {
    const fixture = await setupFrontierFixture()
    const owner = await beginMutatingFrontier(fixture)
    const staged = await buildStagedFrontier()
    const registered = await registerFallbackFrontierStage(owner, fixture.frontierPath, staged, { activeConditionalLeafIds: ['skill:beta'] })
    const applied = await applyFallbackEntry(registered, fixture.frontierPath)
    const publications = publishedFallbackFrontiers(applied)
    assert.equal(publications.length, 1)
    assert.deepEqual(publications[0].activeConditionalLeafIds, ['skill:beta'])
    assert.equal(readFileSync(path.join(fixture.frontierPath, 'alpha', 'SKILL.md'), 'utf8'), '# alpha staged\n')
    assert.equal(readFileSync(path.join(fixture.frontierPath, 'beta', 'SKILL.md'), 'utf8'), '# beta staged\n')
    // Rollback re-proves BOTH leaves through the immutable registered selection.
    const restore = await restoreFallbackJournal(applied)
    assert.equal(restore.succeeded, true)
    assert.equal(existsSync(fixture.frontierPath), false)
    const containers = quarantineContainers(fixture.anchorPath)
    assert.equal(containers.length, 1)
    const movedRoot = path.join(fixture.anchorPath, containers[0], path.basename(fixture.frontierPath))
    assert.equal(readFileSync(path.join(movedRoot, 'alpha', 'SKILL.md'), 'utf8'), '# alpha staged\n')
    assert.equal(readFileSync(path.join(movedRoot, 'beta', 'SKILL.md'), 'utf8'), '# beta staged\n')
    assert.deepEqual(publishedFallbackFrontiers(applied), [])
  })

  it('ignores caller mutations of the selector and reporting arrays after registration', async () => {
    const fixture = await setupFrontierFixture()
    const owner = await beginMutatingFrontier(fixture)
    const staged = await buildStagedFrontier()
    const selector = ['skill:beta']
    const registered = await registerFallbackFrontierStage(owner, fixture.frontierPath, staged, { activeConditionalLeafIds: selector })
    // Caller mutates its own selector copy after registration.
    selector.push('mcp-config:0')
    // Reporting arrays are frozen: in-place mutation must throw.
    const publications = publishedFallbackFrontiers(registered)
    assert.equal(publications.length, 0)
    const applied = await applyFallbackEntry(registered, fixture.frontierPath)
    const appliedPublications = publishedFallbackFrontiers(applied)
    assert.equal(appliedPublications.length, 1)
    assert.throws(() => {
      (appliedPublications[0].activeConditionalLeafIds as unknown as string[]).push('mcp-config:0')
    })
    // The registered immutable selection still drives apply/rollback: only
    // skill:beta was materialized, never mcp-config:0.
    assert.equal(existsSync(path.join(fixture.frontierPath, 'beta', 'SKILL.md')), true)
    const restore = await restoreFallbackJournal(applied)
    assert.equal(restore.succeeded, true)
    assert.equal(existsSync(fixture.frontierPath), false)
    const containers = quarantineContainers(fixture.anchorPath)
    assert.equal(containers.length, 1)
    const movedRoot = path.join(fixture.anchorPath, containers[0], path.basename(fixture.frontierPath))
    assert.equal(readFileSync(path.join(movedRoot, 'alpha', 'SKILL.md'), 'utf8'), '# alpha staged\n')
    assert.equal(readFileSync(path.join(movedRoot, 'beta', 'SKILL.md'), 'utf8'), '# beta staged\n')
    assert.deepEqual(publishedFallbackFrontiers(applied), [])
  })
})

describe('fallback journal copied-link bindings', () => {
  async function setupCopiedLinkFixture (): Promise<{
    liveSkillPath: string
    liveLinkPath: string
    manifest: FallbackTransactionIdentity
  }> {
    // Pi harness: managed links materialize as real directory copies bound to
    // the registered staged skill payload.
    const skillsRoot = path.join(home, '.agents', 'skills')
    const linkRoot = path.join(home, '.pi', 'agent', 'skills')
    const liveSkillPath = path.join(skillsRoot, 'tracked')
    const liveLinkPath = path.join(linkRoot, 'tracked')
    mkdirSync(liveSkillPath, { recursive: true })
    writeFileSync(path.join(liveSkillPath, 'SKILL.md'), '# old tracked\n')
    mkdirSync(liveLinkPath, { recursive: true })
    writeFileSync(path.join(liveLinkPath, 'SKILL.md'), '# old tracked\n')
    const trackingPath = getTrackingFilePath()
    mkdirSync(path.dirname(trackingPath), { recursive: true })
    writeFileSync(trackingPath, JSON.stringify({
      version: '1.0.0',
      installedAt: new Date().toISOString(),
      harness: 'pi',
      skills: [{ name: 'tracked', path: liveSkillPath, paths: { pi: liveSkillPath }, installedAt: new Date().toISOString(), harnesses: ['pi'] }],
      mcpServers: [],
    }))
    const manifest: FallbackTransactionIdentity = {
      installationId: 'pi:fallback',
      harness: 'pi',
      trackingPath,
      trackingDigest: trackingDigest(trackingPath)!,
      protocolVersion: FALLBACK_PROTOCOL_VERSION,
      digestAlgorithm: 'fallback-path-v2',
      nonce: randomUUID(),
      plannedMissingFrontiers: [],
      ownedSkills: [await pathEvidence(liveSkillPath)],
      ownedLinks: [await pathEvidence(liveLinkPath)],
      ownedMcpFields: [],
      ownedMcpConfigPaths: [await pathEvidence(path.join(home, '.pi', 'agent', 'mcp.json'))],
      bundleDestinations: [await pathEvidence(liveSkillPath), await pathEvidence(liveLinkPath)],
      approvedDestinationRoots: [path.resolve(skillsRoot), path.resolve(linkRoot)],
    }
    return { liveSkillPath, liveLinkPath, manifest }
  }

  async function beginMutating (manifest: FallbackTransactionIdentity): Promise<FallbackJournalHandle> {
    const { handle } = await beginFallbackJournal(manifest)
    await markFallbackJournalMutating(handle)
    const claimed = await claimFallbackJournalMutation(manifest, manifestDigestOf(manifest))
    if (!claimed) throw new Error('mutation claim failed')
    return claimed
  }

  function buildStagedSkill (content: string): string {
    const staged = path.join(home, `staged-skill-${randomUUID().slice(0, 8)}`)
    mkdirSync(staged, { recursive: true })
    writeFileSync(path.join(staged, 'SKILL.md'), content)
    return staged
  }

  async function publishCopiedLink (manifest: FallbackTransactionIdentity, liveSkillPath: string, liveLinkPath: string, content: string): Promise<FallbackJournalHandle> {
    let owner = await beginMutating(manifest)
    owner = await registerFallbackStage(owner, liveSkillPath, { directory: buildStagedSkill(content) })
    owner = await registerFallbackStage(owner, liveLinkPath, { directory: buildStagedSkill(content) })
    owner = await applyFallbackEntry(owner, liveSkillPath)
    owner = await applyFallbackEntry(owner, liveLinkPath)
    return owner
  }

  it('rejects an independent copied link whose bytes do not match the registered skill payload', async () => {
    const fixture = await setupCopiedLinkFixture()
    let owner = await beginMutating(fixture.manifest)
    owner = await registerFallbackStage(owner, fixture.liveSkillPath, { directory: buildStagedSkill('# new tracked\n') })
    await assert.rejects(
      registerFallbackStage(owner, fixture.liveLinkPath, { directory: buildStagedSkill('# attacker bytes\n') }),
      /does not match the registered skill payload/
    )
    // Live paths untouched; the failed registration cleaned its own stage container.
    assert.equal(readFileSync(path.join(fixture.liveSkillPath, 'SKILL.md'), 'utf8'), '# old tracked\n')
    assert.equal(readFileSync(path.join(fixture.liveLinkPath, 'SKILL.md'), 'utf8'), '# old tracked\n')
    assert.deepEqual(readdirSync(path.dirname(fixture.liveLinkPath)).filter((name) => name.includes('.nsolid-stage-')), [])
  })

  it('rejects an independent copied link carrying a nested symlink without publication', async () => {
    const fixture = await setupCopiedLinkFixture()
    let owner = await beginMutating(fixture.manifest)
    owner = await registerFallbackStage(owner, fixture.liveSkillPath, { directory: buildStagedSkill('# new tracked\n') })
    const stagedLink = buildStagedSkill('# new tracked\n')
    symlinkSync(path.join(fixture.liveSkillPath, 'SKILL.md'), path.join(stagedLink, 'nested-link'))
    await assert.rejects(
      registerFallbackStage(owner, fixture.liveLinkPath, { directory: stagedLink }),
      /contains a symlink/
    )
    assert.equal(readFileSync(path.join(fixture.liveLinkPath, 'SKILL.md'), 'utf8'), '# old tracked\n')
    assert.deepEqual(readdirSync(path.dirname(fixture.liveLinkPath)).filter((name) => name.includes('.nsolid-stage-')), [])
  })

  it('aborts the copied-link swap when the staged payload is replaced after registration', async () => {
    const fixture = await setupCopiedLinkFixture()
    let owner = await beginMutating(fixture.manifest)
    owner = await registerFallbackStage(owner, fixture.liveSkillPath, { directory: buildStagedSkill('# new tracked\n') })
    owner = await registerFallbackStage(owner, fixture.liveLinkPath, { directory: buildStagedSkill('# new tracked\n') })
    const disk = JSON.parse(readFileSync(owner.journalPath, 'utf8')) as { entries: Array<{ path: string, stage?: string }> }
    const linkEntry = disk.entries.find((candidate) => path.resolve(candidate.path) === path.resolve(fixture.liveLinkPath))
    rmSync(linkEntry!.stage!, { recursive: true, force: true })
    mkdirSync(linkEntry!.stage!, { recursive: true })
    writeFileSync(path.join(linkEntry!.stage!, 'SKILL.md'), '# attacker\n')
    owner = await applyFallbackEntry(owner, fixture.liveSkillPath)
    assert.equal(readFileSync(path.join(fixture.liveSkillPath, 'SKILL.md'), 'utf8'), '# new tracked\n')
    await assert.rejects(applyFallbackEntry(owner, fixture.liveLinkPath), /no longer matches its registered digest/)
    assert.equal(readFileSync(path.join(fixture.liveLinkPath, 'SKILL.md'), 'utf8'), '# old tracked\n')
  })

  it('preserves a published copied link whose live bytes no longer match what this process published', async () => {
    const fixture = await setupCopiedLinkFixture()
    const owner = await publishCopiedLink(fixture.manifest, fixture.liveSkillPath, fixture.liveLinkPath, '# new tracked\n')
    assert.equal(readFileSync(path.join(fixture.liveLinkPath, 'SKILL.md'), 'utf8'), '# new tracked\n')
    // Foreign bytes replace the published link before the restore runs.
    writeFileSync(path.join(fixture.liveLinkPath, 'SKILL.md'), '# foreign\n')
    const restore = await restoreFallbackJournal(owner)
    assert.equal(restore.succeeded, false)
    assert.ok(restore.preservedPaths.includes(path.resolve(fixture.liveLinkPath)))
    assert.equal(readFileSync(path.join(fixture.liveLinkPath, 'SKILL.md'), 'utf8'), '# foreign\n')
    assert.equal(existsSync(owner.journalPath), true)
  })

  it('restores the authenticated original when the published copied link is intact', async () => {
    const fixture = await setupCopiedLinkFixture()
    const owner = await publishCopiedLink(fixture.manifest, fixture.liveSkillPath, fixture.liveLinkPath, '# new tracked\n')
    const restore = await restoreFallbackJournal(owner)
    assert.equal(restore.succeeded, true)
    assert.deepEqual(restore.preservedPaths, [])
    assert.equal(readFileSync(path.join(fixture.liveSkillPath, 'SKILL.md'), 'utf8'), '# old tracked\n')
    assert.equal(readFileSync(path.join(fixture.liveLinkPath, 'SKILL.md'), 'utf8'), '# old tracked\n')
  })

  async function setupCopiedLinkFrontierFixture (): Promise<{
    destRoot: string
    linkRoot: string
    linkGammaPath: string
    manifest: FallbackTransactionIdentity
  }> {
    const destAnchor = path.join(home, 'dest-anchor')
    const linkAnchor = path.join(home, 'link-anchor')
    mkdirSync(destAnchor)
    mkdirSync(linkAnchor)
    const destRoot = path.join(destAnchor, 'skills')
    const linkRoot = path.join(linkAnchor, 'skills')
    const destGammaPath = path.join(destRoot, 'gamma')
    const linkGammaPath = path.join(linkRoot, 'gamma')
    // The destination skill frontier registers first so the link frontier
    // binds its directory copy against the registered skill payload.
    const skillFrontier: FallbackFrontierEvidence = {
      frontierPath: destRoot,
      activation: 'required',
      anchor: await frontierAnchorIdentity(destAnchor),
      leaves: [{ id: 'skill:gamma', role: 'skill', activation: 'required', path: destGammaPath }],
    }
    const linkFrontier: FallbackFrontierEvidence = {
      frontierPath: linkRoot,
      activation: 'required',
      anchor: await frontierAnchorIdentity(linkAnchor),
      leaves: [{ id: 'link:gamma', role: 'link', activation: 'required', path: linkGammaPath }],
    }
    const trackingPath = getTrackingFilePath()
    mkdirSync(path.dirname(trackingPath), { recursive: true })
    writeFileSync(trackingPath, JSON.stringify({
      version: '1.0.0',
      installedAt: new Date().toISOString(),
      harness: 'pi',
      skills: [],
      mcpServers: [],
    }))
    const manifest: FallbackTransactionIdentity = {
      installationId: 'pi:fallback',
      harness: 'pi',
      trackingPath,
      trackingDigest: trackingDigest(trackingPath)!,
      protocolVersion: FALLBACK_PROTOCOL_VERSION,
      digestAlgorithm: 'fallback-path-v2',
      nonce: randomUUID(),
      plannedMissingFrontiers: [skillFrontier, linkFrontier],
      ownedSkills: [],
      ownedLinks: [],
      ownedMcpFields: [],
      ownedMcpConfigPaths: [await pathEvidence(path.join(home, '.pi', 'agent', 'mcp.json'))],
      bundleDestinations: [await pathEvidence(destGammaPath), await pathEvidence(linkGammaPath)],
      approvedDestinationRoots: [path.resolve(destRoot), path.resolve(linkRoot)],
    }
    return { destRoot, linkRoot, linkGammaPath, manifest }
  }

  async function publishCopiedLinkFrontier (manifest: FallbackTransactionIdentity, destRoot: string, linkRoot: string, content: string): Promise<FallbackJournalHandle> {
    let owner = await beginMutating(manifest)
    const stagedSkillRoot = path.join(home, `staged-dest-${randomUUID().slice(0, 8)}`)
    mkdirSync(path.join(stagedSkillRoot, 'gamma'), { recursive: true })
    writeFileSync(path.join(stagedSkillRoot, 'gamma', 'SKILL.md'), content)
    const stagedLinkRoot = path.join(home, `staged-link-${randomUUID().slice(0, 8)}`)
    mkdirSync(path.join(stagedLinkRoot, 'gamma'), { recursive: true })
    writeFileSync(path.join(stagedLinkRoot, 'gamma', 'SKILL.md'), content)
    owner = await registerFallbackFrontierStage(owner, destRoot, stagedSkillRoot)
    owner = await registerFallbackFrontierStage(owner, linkRoot, stagedLinkRoot)
    owner = await applyFallbackEntry(owner, destRoot)
    owner = await applyFallbackEntry(owner, linkRoot)
    return owner
  }

  it('publishes a copied-link frontier bound to the registered skill bytes without leaking bindings into reports', async () => {
    const fixture = await setupCopiedLinkFrontierFixture()
    const owner = await publishCopiedLinkFrontier(fixture.manifest, fixture.destRoot, fixture.linkRoot, '# new gamma\n')
    assert.equal(lstatSync(fixture.linkGammaPath).isSymbolicLink(), false)
    assert.equal(readFileSync(path.join(fixture.linkGammaPath, 'SKILL.md'), 'utf8'), '# new gamma\n')
    const publications = publishedFallbackFrontiers(owner)
    assert.equal(publications.length, 2)
    for (const publication of publications) {
      assert.equal((publication as unknown as Record<string, unknown>).copiedLinkBindings, undefined)
    }
  })

  it('rolls back a published copied-link frontier when its live bytes are intact', async () => {
    const fixture = await setupCopiedLinkFrontierFixture()
    const owner = await publishCopiedLinkFrontier(fixture.manifest, fixture.destRoot, fixture.linkRoot, '# new gamma\n')
    const restore = await restoreFallbackJournal(owner)
    assert.equal(restore.succeeded, true)
    assert.equal(existsSync(fixture.destRoot), false)
    assert.equal(existsSync(fixture.linkRoot), false)
  })

  it('preserves a copied-link frontier whose live leaf no longer matches its frozen binding', async () => {
    const fixture = await setupCopiedLinkFrontierFixture()
    const owner = await publishCopiedLinkFrontier(fixture.manifest, fixture.destRoot, fixture.linkRoot, '# new gamma\n')
    writeFileSync(path.join(fixture.linkGammaPath, 'SKILL.md'), '# tampered\n')
    const restore = await restoreFallbackJournal(owner)
    assert.equal(restore.succeeded, false)
    assert.equal(restore.unproven, true)
    // The tampered frontier is preserved exactly; the destination frontier
    // rolled back independently and the journal stays for deliberate resolution.
    assert.equal(readFileSync(path.join(fixture.linkGammaPath, 'SKILL.md'), 'utf8'), '# tampered\n')
    assert.equal(existsSync(fixture.destRoot), false)
    assert.equal(existsSync(owner.journalPath), true)
  })
})

describe('fallback journal partial recovery reporting', () => {
  async function setupTwoSkillRecoveryFixture (): Promise<{
    skillAPath: string
    skillBPath: string
    manifest: FallbackTransactionIdentity
  }> {
    const skillsRoot = path.join(home, '.agents', 'skills')
    const skillAPath = path.join(skillsRoot, 'alpha')
    const skillBPath = path.join(skillsRoot, 'beta')
    mkdirSync(skillAPath, { recursive: true })
    writeFileSync(path.join(skillAPath, 'SKILL.md'), '# alpha tracked\n')
    mkdirSync(skillBPath, { recursive: true })
    writeFileSync(path.join(skillBPath, 'SKILL.md'), '# beta tracked\n')
    const trackingPath = getTrackingFilePath()
    mkdirSync(path.dirname(trackingPath), { recursive: true })
    writeFileSync(trackingPath, JSON.stringify({
      version: '1.0.0',
      installedAt: new Date().toISOString(),
      harness: 'opencode',
      skills: [
        { name: 'alpha', path: skillAPath, paths: { opencode: skillAPath }, installedAt: new Date().toISOString(), harnesses: ['opencode'] },
        { name: 'beta', path: skillBPath, paths: { opencode: skillBPath }, installedAt: new Date().toISOString(), harnesses: ['opencode'] },
      ],
      mcpServers: [],
    }))
    const manifest: FallbackTransactionIdentity = {
      installationId: 'opencode:fallback',
      harness: 'opencode',
      trackingPath,
      trackingDigest: trackingDigest(trackingPath)!,
      protocolVersion: FALLBACK_PROTOCOL_VERSION,
      digestAlgorithm: 'fallback-path-v2',
      nonce: randomUUID(),
      plannedMissingFrontiers: [],
      ownedSkills: [await pathEvidence(skillAPath), await pathEvidence(skillBPath)],
      ownedLinks: [],
      ownedMcpFields: [],
      ownedMcpConfigPaths: [await pathEvidence(path.join(home, '.config', 'opencode', 'opencode.jsonc'))],
      bundleDestinations: [await pathEvidence(skillAPath), await pathEvidence(skillBPath)],
      approvedDestinationRoots: [path.resolve(skillsRoot)],
    }
    return { skillAPath, skillBPath, manifest }
  }

  /** Break one snapshot backup's authentication by smuggling a stray child into it. */
  function tamperBackupOf (journalPath: string, entryPath: string): void {
    const disk = JSON.parse(readFileSync(journalPath, 'utf8')) as {
      entries: Array<{ path: string, backup?: string }>
      revision?: number
    }
    const entry = disk.entries.find((candidate) => path.resolve(candidate.path) === path.resolve(entryPath))
    if (entry?.backup === undefined) throw new Error(`no backup for ${entryPath}`)
    writeFileSync(path.join(entry.backup, 'tampered.txt'), 'tampered backup bytes')
  }

  async function assertReadOnlyInspection (trackingPath: string, preservedPaths: string[]): Promise<void> {
    const before = await pathDigest(home)
    assert.ok(before, 'the fixture tree must be digestible')
    const inspection = await inspectFallbackJournal(trackingPath)
    assert.equal(inspection.pending, true)
    assert.equal(inspection.recovered, preservedPaths.length === 0)
    assert.deepEqual(inspection.restoredPaths, [])
    assert.deepEqual(inspection.preservedPaths.sort(), preservedPaths.map((value) => path.resolve(value)).sort())
    assert.equal(await pathDigest(home), before, 'inspection must preserve live, journal and backup bytes')
  }

  it('reports both owned paths as restored when full recovery rewrites every entry', async () => {
    const fixture = await setupTwoSkillRecoveryFixture()
    const { handle } = await beginFallbackJournal(fixture.manifest)
    await markFallbackJournalMutating(handle)
    writeFileSync(path.join(fixture.skillAPath, 'SKILL.md'), '# alpha drifted\n')
    writeFileSync(path.join(fixture.skillBPath, 'SKILL.md'), '# beta drifted\n')

    await assertReadOnlyInspection(fixture.manifest.trackingPath, [fixture.skillAPath, fixture.skillBPath])
    const recovery = await recoverFallbackJournal(fixture.manifest.trackingPath)
    assert.equal(recovery.pending, true)
    assert.equal(recovery.recovered, true)
    assert.deepEqual(recovery.restoredPaths.sort(), [path.resolve(fixture.skillAPath), path.resolve(fixture.skillBPath)].sort())
    assert.deepEqual(recovery.preservedPaths, [])
    assert.equal(readFileSync(path.join(fixture.skillAPath, 'SKILL.md'), 'utf8'), '# alpha tracked\n')
    assert.equal(readFileSync(path.join(fixture.skillBPath, 'SKILL.md'), 'utf8'), '# beta tracked\n')
  })

  it('reports a partial recovery: one entry restored, its tampered sibling preserved', async () => {
    const fixture = await setupTwoSkillRecoveryFixture()
    const { handle } = await beginFallbackJournal(fixture.manifest)
    await markFallbackJournalMutating(handle)
    writeFileSync(path.join(fixture.skillAPath, 'SKILL.md'), '# alpha drifted\n')
    writeFileSync(path.join(fixture.skillBPath, 'SKILL.md'), '# beta drifted\n')
    tamperBackupOf(handle.journalPath, fixture.skillBPath)

    await assertReadOnlyInspection(fixture.manifest.trackingPath, [fixture.skillAPath, fixture.skillBPath])
    const recovery = await recoverFallbackJournal(fixture.manifest.trackingPath)
    assert.equal(recovery.pending, true)
    assert.equal(recovery.recovered, false, 'a tampered backup leaves the journal unproven')
    assert.deepEqual(recovery.restoredPaths, [path.resolve(fixture.skillAPath)])
    assert.deepEqual(recovery.preservedPaths, [path.resolve(fixture.skillBPath)])
    // The restored entry holds its tracked bytes; the failed entry keeps its
    // drifted live bytes untouched.
    assert.equal(readFileSync(path.join(fixture.skillAPath, 'SKILL.md'), 'utf8'), '# alpha tracked\n')
    assert.equal(readFileSync(path.join(fixture.skillBPath, 'SKILL.md'), 'utf8'), '# beta drifted\n')
  })

  it('reports nothing to rewrite when every owned path already matches its tracked state', async () => {
    const fixture = await setupTwoSkillRecoveryFixture()
    const { handle } = await beginFallbackJournal(fixture.manifest)
    await markFallbackJournalMutating(handle)

    await assertReadOnlyInspection(fixture.manifest.trackingPath, [])
    const recovery = await recoverFallbackJournal(fixture.manifest.trackingPath)
    assert.equal(recovery.pending, true)
    assert.equal(recovery.recovered, true)
    assert.deepEqual(recovery.restoredPaths, [])
    assert.deepEqual(recovery.preservedPaths, [])
    assert.equal(readFileSync(path.join(fixture.skillAPath, 'SKILL.md'), 'utf8'), '# alpha tracked\n')
    assert.equal(readFileSync(path.join(fixture.skillBPath, 'SKILL.md'), 'utf8'), '# beta tracked\n')
  })

  it('reports nothing restored when the only entry cannot be recovered', async () => {
    const fixture = await setupTwoSkillRecoveryFixture()
    const { handle } = await beginFallbackJournal(fixture.manifest)
    await markFallbackJournalMutating(handle)
    writeFileSync(path.join(fixture.skillAPath, 'SKILL.md'), '# alpha drifted\n')
    tamperBackupOf(handle.journalPath, fixture.skillAPath)

    await assertReadOnlyInspection(fixture.manifest.trackingPath, [fixture.skillAPath])
    const recovery = await recoverFallbackJournal(fixture.manifest.trackingPath)
    assert.equal(recovery.pending, true)
    assert.equal(recovery.recovered, false)
    assert.deepEqual(recovery.restoredPaths, [])
    assert.deepEqual(recovery.preservedPaths, [path.resolve(fixture.skillAPath)])
    assert.equal(readFileSync(path.join(fixture.skillAPath, 'SKILL.md'), 'utf8'), '# alpha drifted\n')
    assert.equal(readFileSync(path.join(fixture.skillBPath, 'SKILL.md'), 'utf8'), '# beta tracked\n')
  })
})
