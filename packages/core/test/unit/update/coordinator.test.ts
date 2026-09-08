import { tarEntry } from '../../helpers/tar.js'
import { createCanonicalTempRoot } from '../../helpers/canonical-temp-root.js'
import { afterEach, beforeEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { gzipSync } from 'node:zlib'
import path from 'node:path'
import { checkUpdates, executeUpdatePlan, planUpdates, update, withPinnedMarketplaceCommit } from '../../../src/update/coordinator.js'
import { beginFallbackJournal, fallbackJournalPath, pathDigest, pathKind, trackingDigest } from '../../../src/update/fallback-journal.js'
import { cliPackageStrategy } from '../../../src/update/strategies/cli-package.js'
import { fallbackStrategy } from '../../../src/update/strategies/fallback.js'
import { getHarnessSkillsPath } from '../../../src/skills/skill-linker.js'
import { getTrackingFilePath } from '../../../src/utils/path.js'
import type { CommandSpec, FallbackTransactionIdentity, ResolvedArtifactIdentity, UpdatePlanItem, UpdateResult, UpdateSource } from '../../../src/update/types.js'
import { FALLBACK_PROTOCOL_VERSION } from '../../../src/update/types.js'

let home: string
let previousHome: string | undefined
let previousUserProfile: string | undefined

beforeEach(() => {
  home = createCanonicalTempRoot('nsolid-plugin-coordinator-')
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

function writeInvalidJournal (): void {
  const trackingPath = getTrackingFilePath()
  mkdirSync(path.dirname(trackingPath), { recursive: true })
  writeFileSync(fallbackJournalPath(trackingPath), '{ invalid journal')
}

/**
 * Build a genuine journal via beginFallbackJournal, then drift the live skill
 * past its snapshotted state — the exact state in which next-run restore-only
 * recovery succeeds (recovered: true) and mutates tracked paths.
 */
async function writeFallbackExecutionFixture (): Promise<{ identity: FallbackTransactionIdentity; skillPath: string; trackingPath: string }> {
  const skillsDir = path.join(home, '.config', 'opencode', 'skills')
  const skillPath = path.join(skillsDir, 'tracked')
  mkdirSync(skillPath, { recursive: true })
  writeFileSync(path.join(skillPath, 'SKILL.md'), 'old tracked')
  const trackingPath = getTrackingFilePath()
  mkdirSync(path.dirname(trackingPath), { recursive: true })
  writeFileSync(trackingPath, `${JSON.stringify({
    version: '1.0.0',
    installedAt: new Date().toISOString(),
    harness: 'opencode',
    skills: [{ name: 'tracked', path: skillPath, paths: { opencode: skillPath }, installedAt: new Date().toISOString(), harnesses: ['opencode'] }],
    mcpServers: [],
  }, null, 2)}\n`)
  const evidence = async (target: string) => {
    const kind = await pathKind(target)
    return { path: path.resolve(target), kind, digest: kind === 'missing' ? undefined : await pathDigest(target) }
  }
  const identity: FallbackTransactionIdentity = {
    installationId: 'opencode:fallback',
    harness: 'opencode',
    trackingPath,
    trackingDigest: trackingDigest(trackingPath)!,
    protocolVersion: FALLBACK_PROTOCOL_VERSION,
    nonce: randomUUID(),
    plannedMissingFrontiers: [],
    ownedSkills: [await evidence(skillPath)],
    ownedLinks: [],
    ownedMcpFields: [],
    ownedMcpConfigPaths: [await evidence(path.join(home, '.config', 'opencode', 'opencode.jsonc'))],
    bundleDestinations: [await evidence(skillPath)],
    approvedDestinationRoots: [skillsDir],
  }
  return { identity, skillPath, trackingPath }
}

async function writeRestorableJournal (): Promise<{ skillPath: string; journalPath: string; snapshotDirectory: string }> {
  const skillsDir = path.join(home, '.config', 'opencode', 'skills')
  const skillPath = path.join(skillsDir, 'tracked')
  mkdirSync(skillPath, { recursive: true })
  writeFileSync(path.join(skillPath, 'SKILL.md'), 'old tracked')
  const trackingPath = getTrackingFilePath()
  mkdirSync(path.dirname(trackingPath), { recursive: true })
  writeFileSync(trackingPath, `${JSON.stringify({
    version: '1.0.0',
    installedAt: new Date().toISOString(),
    harness: 'opencode',
    skills: [{ name: 'tracked', path: skillPath, paths: { opencode: skillPath }, installedAt: new Date().toISOString(), harnesses: ['opencode'] }],
    mcpServers: [],
  }, null, 2)}\n`)
  const evidence = async (target: string) => {
    const kind = await pathKind(target)
    return { path: path.resolve(target), kind, digest: kind === 'missing' ? undefined : await pathDigest(target) }
  }
  const { journal } = await beginFallbackJournal({
    installationId: 'opencode:fallback',
    harness: 'opencode',
    trackingPath,
    trackingDigest: trackingDigest(trackingPath)!,
    protocolVersion: FALLBACK_PROTOCOL_VERSION,
    nonce: randomUUID(),
    plannedMissingFrontiers: [],
    ownedSkills: [await evidence(skillPath)],
    ownedLinks: [],
    ownedMcpFields: [],
    ownedMcpConfigPaths: [await evidence(path.join(home, '.config', 'opencode', 'opencode.jsonc'))],
    bundleDestinations: [await evidence(skillPath)],
    approvedDestinationRoots: [skillsDir],
  })
  writeFileSync(path.join(skillPath, 'SKILL.md'), 'drifted')
  writeFileSync(path.join(skillPath, 'stray.txt'), 'half-applied')
  return { skillPath, journalPath: journal.journalPath, snapshotDirectory: journal.snapshotDirectory! }
}

/**
 * Read-only recursive byte snapshot of a directory tree (relative path to
 * utf8 contents). Directories are detected by a successful readdir; anything
 * else is read as a file. Fixture trees contain only text bytes.
 */
function snapshotTree (root: string): Record<string, string> {
  const files: Record<string, string> = {}
  const walk = (directory: string): void => {
    for (const name of readdirSync(directory)) {
      const target = path.join(directory, name)
      let children: string[] | undefined
      try {
        children = readdirSync(target)
      } catch {
        children = undefined
      }
      if (children === undefined) files[path.relative(root, target)] = readFileSync(target, 'utf8')
      else walk(target)
    }
  }
  walk(root)
  return files
}

function mutableCliItem (): UpdatePlanItem {
  return {
    installationId: 'cli:global',
    target: 'cli',
    ownership: 'global-package',
    installed: true,
    source: { kind: 'global-package', packageManager: 'npm', packageName: 'nsolid-plugin' },
    version: { current: '1.0.0', latest: '1.0.1', status: 'update-available' },
    steps: [{
      kind: 'command',
      description: 'update',
      command: { executable: process.execPath, args: [], timeoutMs: 1000 },
    }],
    rollbackSteps: [],
    requiresConfirmation: true,
  }
}

function artifact (packageName: 'nsolid-plugin' | 'nsolid-pi-plugin' = 'nsolid-plugin') {
  const directory = mkdtempSync(path.join(home, 'artifact-'))
  const bytes = Buffer.from('verified artifact')
  const tarballPath = path.join(directory, 'package.tgz')
  writeFileSync(tarballPath, bytes)
  const integrity = `sha512-${createHash('sha512').update(bytes).digest('base64')}`
  return {
    kind: 'npm' as const,
    packageName,
    version: '1.0.1',
    registry: 'https://registry.example',
    tarball: 'https://registry.example/package.tgz',
    integrity,
    tarballPath,
    tempDirectory: directory,
  }
}

describe('update coordinator recovery gate', () => {
  it('returns only the recovery item before inventory when recovery is unresolved', async () => {
    writeInvalidJournal()
    let fetchCalls = 0
    let runnerCalls = 0

    const plan = await planUpdates({
      all: true,
      check: true,
      fetchImpl: async () => {
        fetchCalls++
        return new Response('{}', { status: 200 })
      },
      commandRunner: {
        run: async () => {
          runnerCalls++
          return { exitCode: 0, stdout: '', stderr: '', timedOut: false, treeTerminated: true }
        },
      },
    })

    assert.equal(plan.items.length, 1)
    assert.equal(plan.items[0]?.installationId, 'fallback:recovery')
    assert.equal(plan.items[0]?.planningError?.code, 'FALLBACK_RECOVERY_PENDING')
    assert.equal(fetchCalls, 0)
    assert.equal(runnerCalls, 0)
  })

  it('keeps a check-only plan byte-identical for a restorable pending journal', async () => {
    const { skillPath, journalPath, snapshotDirectory } = await writeRestorableJournal()
    const trackingPath = getTrackingFilePath()
    let fetchCalls = 0
    let runnerCalls = 0
    const spies = () => ({
      fetchImpl: async () => {
        fetchCalls++
        return new Response('{}', { status: 200 })
      },
      commandRunner: {
        run: async () => {
          runnerCalls++
          return { exitCode: 0, stdout: '', stderr: '', timedOut: false, treeTerminated: true }
        },
      },
    })
    // Every live byte a restore would touch, plus the journal, tracking, and
    // snapshot backups: a check must leave all of them identical.
    const skillFile = path.join(skillPath, 'SKILL.md')
    const strayFile = path.join(skillPath, 'stray.txt')
    const skillBefore = readFileSync(skillFile, 'utf8')
    const strayBefore = readFileSync(strayFile, 'utf8')
    const trackingBefore = readFileSync(trackingPath, 'utf8')
    const journalBefore = readFileSync(journalPath, 'utf8')
    const snapshotBefore = snapshotTree(snapshotDirectory)
    const skillParentBefore = readdirSync(path.dirname(skillPath)).sort()
    const trackingDirBefore = readdirSync(path.dirname(trackingPath)).sort()
    assert.equal(skillBefore, 'drifted')

    const plan = await planUpdates({ all: true, check: true, ...spies() })

    assert.equal(plan.items.length, 1)
    assert.equal(plan.items[0]?.installationId, 'fallback:recovery')
    assert.equal(plan.items[0]?.planningError?.code, 'FALLBACK_RECOVERY_PENDING')
    const message = plan.items[0]?.planningError?.message ?? ''
    // A check never restores, so claiming the state was "restored to its
    // tracked state" would be false; the guidance must say it was preserved
    // untouched for manual resolution.
    assert.match(message, /preserved untouched/)
    assert.doesNotMatch(message, /restored to its tracked state/)
    assert.equal(fetchCalls, 0)
    assert.equal(runnerCalls, 0)
    // The drifted skill, the stray file, the tracking file, the journal, and
    // every snapshot backup are byte-identical...
    assert.equal(readFileSync(skillFile, 'utf8'), skillBefore)
    assert.equal(readFileSync(strayFile, 'utf8'), strayBefore)
    assert.equal(readFileSync(trackingPath, 'utf8'), trackingBefore)
    assert.equal(readFileSync(journalPath, 'utf8'), journalBefore)
    assert.deepEqual(snapshotTree(snapshotDirectory), snapshotBefore)
    // ...and no recovery storage was created beside any live target.
    assert.deepEqual(readdirSync(path.dirname(skillPath)).sort(), skillParentBefore)
    assert.deepEqual(readdirSync(path.dirname(trackingPath)).sort(), trackingDirBefore)
    // The journal and snapshot survive for deliberate manual cleanup.
    assert.equal(existsSync(journalPath), true)
    assert.equal(existsSync(snapshotDirectory), true)

    // A second read-only pass through the public summary reports the same
    // pending state, still without running or writing anything.
    const checkSummary = await checkUpdates({ all: true, ...spies() })
    assert.equal(checkSummary.results.length, 1)
    assert.equal(checkSummary.results[0]?.status, 'failed')
    assert.equal(checkSummary.results[0]?.error?.code, 'FALLBACK_RECOVERY_PENDING')
    assert.match(checkSummary.results[0]?.error?.message ?? '', /preserved untouched/)
    assert.equal(fetchCalls, 0)
    assert.equal(runnerCalls, 0)
    assert.equal(readFileSync(skillFile, 'utf8'), skillBefore)
    assert.equal(readFileSync(strayFile, 'utf8'), strayBefore)
    assert.equal(readFileSync(trackingPath, 'utf8'), trackingBefore)
    assert.equal(readFileSync(journalPath, 'utf8'), journalBefore)
    assert.deepEqual(readdirSync(path.dirname(skillPath)).sort(), skillParentBefore)
    assert.deepEqual(readdirSync(path.dirname(trackingPath)).sort(), trackingDirBefore)
  })

  it('restores a restorable pending journal on a non-check plan', async () => {
    const { skillPath, journalPath, snapshotDirectory } = await writeRestorableJournal()
    let fetchCalls = 0
    let runnerCalls = 0

    const plan = await planUpdates({
      all: true,
      fetchImpl: async () => {
        fetchCalls++
        return new Response('{}', { status: 200 })
      },
      commandRunner: {
        run: async () => {
          runnerCalls++
          return { exitCode: 0, stdout: '', stderr: '', timedOut: false, treeTerminated: true }
        },
      },
    })

    assert.equal(plan.items.length, 1)
    assert.equal(plan.items[0]?.installationId, 'fallback:recovery')
    assert.equal(plan.items[0]?.planningError?.code, 'FALLBACK_RECOVERY_PENDING')
    const message = plan.items[0]?.planningError?.message ?? ''
    // Restore-only recovery rewrote tracked paths, so claiming the state was
    // "preserved untouched" would be false; the message must say it restored.
    assert.doesNotMatch(message, /preserved untouched/)
    assert.match(message, /restored to its tracked state/)
    assert.ok(message.includes(path.resolve(skillPath)), 'the restored path is named in the guidance')
    const expectedPreserved = [path.resolve(journalPath), path.resolve(snapshotDirectory)].sort()
    assert.deepEqual(plan.items[0]?.preservedArtifacts, expectedPreserved)
    assert.equal(plan.items[0]?.preservedPaths, undefined)
    assert.equal(fetchCalls, 0)
    assert.equal(runnerCalls, 0)
    // The drifted skill was rewritten from the authenticated snapshot...
    assert.equal(readFileSync(path.join(skillPath, 'SKILL.md'), 'utf8'), 'old tracked')
    assert.equal(existsSync(path.join(skillPath, 'stray.txt')), false)
    // ...while the journal and snapshot survive for deliberate manual cleanup.
    assert.equal(existsSync(journalPath), true)
    assert.equal(existsSync(snapshotDirectory), true)

    // And the public mutation result, still without running any mutation.
    const summary = await update({
      all: true,
      yes: true,
      fetchImpl: async () => {
        fetchCalls++
        return new Response('{}', { status: 200 })
      },
      commandRunner: {
        run: async () => {
          runnerCalls++
          return { exitCode: 0, stdout: '', stderr: '', timedOut: false, treeTerminated: true }
        },
      },
    })
    assert.equal(summary.results.length, 1)
    assert.equal(summary.results[0]?.status, 'failed')
    assert.equal(summary.results[0]?.error?.code, 'FALLBACK_RECOVERY_PENDING')
    assert.deepEqual(summary.results[0]?.preservedArtifacts, expectedPreserved)
    assert.equal(summary.results[0]?.preservedPaths, undefined)
    assert.equal(fetchCalls, 0)
    assert.equal(runnerCalls, 0)
    assert.equal(existsSync(journalPath), true)
    assert.equal(existsSync(snapshotDirectory), true)
  })

  it('does not execute mutable targets while recovery remains unresolved', async () => {
    writeInvalidJournal()
    const journalPath = fallbackJournalPath(getTrackingFilePath())
    let runnerCalls = 0
    let fetchCalls = 0
    const summary = await update({
      all: true,
      yes: true,
      commandRunner: {
        run: async () => {
          runnerCalls++
          return { exitCode: 0, stdout: '', stderr: '', timedOut: false, treeTerminated: true }
        },
      },
      fetchImpl: async () => {
        fetchCalls++
        return new Response('{}', { status: 200 })
      },
    })

    // Pending recovery fails closed with the preserved-journal guidance, not
    // the legacy FAILED mapping.
    assert.equal(summary.results.length, 1)
    assert.equal(summary.results[0]?.error?.code, 'FALLBACK_RECOVERY_PENDING')
    assert.match(summary.results[0]?.error?.message ?? '', /preserved untouched/)
    assert.equal(summary.results[0]?.status, 'failed')
    // A malformed journal cannot be authenticated, so only the journal
    // artifact is reported as preserved and no live path evidence exists.
    assert.deepEqual(summary.results[0]?.preservedArtifacts, [journalPath])
    assert.equal(summary.results[0]?.preservedPaths, undefined)
    // No package-manager command and no inventory fetch may run while
    // recovery is unresolved.
    assert.equal(runnerCalls, 0)
    assert.equal(fetchCalls, 0)
    // The pending journal must remain untouched on disk.
    assert.equal(existsSync(journalPath), true)
  })

  it('defends the recovery gate for externally constructed plans', async () => {
    let runnerCalls = 0
    const recovery: UpdatePlanItem = {
      installationId: 'fallback:recovery',
      target: 'opencode',
      ownership: 'fallback',
      installed: true,
      source: { kind: 'fallback' },
      version: { status: 'unknown' },
      steps: [],
      rollbackSteps: [],
      planningError: { code: 'FALLBACK_RECOVERY_FAILED', message: 'recovery failed' },
      requiresConfirmation: false,
    }

    const summary = await executeUpdatePlan({ checkOnly: false, items: [recovery, mutableCliItem()] }, {
      yes: true,
      commandRunner: {
        run: async () => {
          runnerCalls++
          return { exitCode: 0, stdout: '', stderr: '', timedOut: false, treeTerminated: true }
        },
      },
    })

    assert.equal(runnerCalls, 0)
    assert.equal(summary.results[1]?.status, 'failed')
    assert.equal(summary.results[1]?.error?.code, 'FALLBACK_RECOVERY_FAILED')
    // Externally constructed items without preservation evidence keep the
    // stable shape: the reporting fields stay absent instead of becoming
    // empty arrays.
    assert.equal(summary.results[0]?.preservedArtifacts, undefined)
    assert.equal(summary.results[0]?.preservedPaths, undefined)
    assert.equal(summary.results[1]?.preservedArtifacts, undefined)
    assert.equal(summary.results[1]?.preservedPaths, undefined)
  })

  it('preserves planning-owned state when the public seam rejects an incomplete fallback plan', async () => {
    const fixture = await writeFallbackExecutionFixture()
    const transactionDirectory = mkdtempSync(path.join(home, 'transaction-'))
    const manifestPath = path.join(transactionDirectory, 'transaction.json')
    writeFileSync(manifestPath, 'planned manifest\n')
    const plannedArtifact = artifact()
    const artifactBefore = readFileSync(plannedArtifact.tarballPath)
    const transactionBefore = snapshotTree(transactionDirectory)
    const skillBefore = snapshotTree(fixture.skillPath)
    const trackingBefore = readFileSync(fixture.trackingPath)
    let runnerCalls = 0
    const item: UpdatePlanItem = {
      installationId: 'opencode:fallback',
      target: 'opencode',
      ownership: 'fallback',
      installed: true,
      source: { kind: 'fallback', executor: 'npm-exec' },
      version: { current: '1.0.0', latest: '1.0.1', status: 'update-available' },
      artifact: plannedArtifact,
      steps: [{
        kind: 'command',
        description: 'refresh',
        command: { executable: process.execPath, args: ['--transaction', manifestPath], timeoutMs: 1000 },
      }],
      rollbackSteps: [],
      requiresConfirmation: true,
      temporaryDirectories: [transactionDirectory],
    }

    const summary = await executeUpdatePlan({ checkOnly: false, items: [item] }, {
      yes: true,
      commandRunner: {
        run: async () => {
          runnerCalls++
          return { exitCode: 0, stdout: '', stderr: '', timedOut: false, treeTerminated: true }
        },
      },
    })

    assert.equal(summary.results[0]?.status, 'failed')
    assert.equal(summary.results[0]?.error?.code, 'INVALID_PLAN')
    assert.equal(runnerCalls, 0)
    assert.equal(existsSync(plannedArtifact.tempDirectory), true)
    assert.deepEqual(readFileSync(plannedArtifact.tarballPath), artifactBefore)
    assert.equal(existsSync(transactionDirectory), true)
    assert.deepEqual(snapshotTree(transactionDirectory), transactionBefore)
    assert.deepEqual(snapshotTree(fixture.skillPath), skillBefore)
    assert.deepEqual(readFileSync(fixture.trackingPath), trackingBefore)
  })

  it('preserves fallback artifacts and transaction state when tree termination is unconfirmed', async () => {
    const fixture = await writeFallbackExecutionFixture()
    const transactionDirectory = mkdtempSync(path.join(home, 'transaction-'))
    const manifestPath = path.join(transactionDirectory, 'transaction.json')
    writeFileSync(manifestPath, '{}')
    const plannedArtifact = artifact()
    let workspace = ''
    let resultDirectory = ''
    const item: UpdatePlanItem = {
      installationId: 'opencode:fallback',
      target: 'opencode',
      ownership: 'fallback',
      installed: true,
      source: { kind: 'fallback', executor: 'npm-exec' },
      version: { current: '1.0.0', latest: '1.0.1', status: 'update-available' },
      artifact: plannedArtifact,
      fallbackTransaction: fixture.identity,
      steps: [{
        kind: 'command',
        description: 'refresh',
        command: { executable: process.execPath, args: ['--transaction', manifestPath], timeoutMs: 1000 },
      }],
      rollbackSteps: [],
      requiresConfirmation: true,
      temporaryDirectories: [transactionDirectory],
    }

    const summary = await executeUpdatePlan({ checkOnly: false, items: [item] }, {
      yes: true,
      commandRunner: {
        run: async (command) => {
          workspace = command.cwd ?? ''
          const resultIndex = command.args?.indexOf('--result') ?? -1
          const resultPath = resultIndex >= 0 ? command.args?.[resultIndex + 1] : undefined
          resultDirectory = resultPath === undefined ? '' : path.dirname(resultPath)
          return { exitCode: null, stdout: '', stderr: '', timedOut: true, treeTerminated: false }
        },
      },
    })

    assert.equal(summary.results[0]?.error?.code, 'FALLBACK_TREE_TERMINATION_UNCONFIRMED')
    assert.equal(existsSync(plannedArtifact.tempDirectory), true)
    assert.equal(existsSync(manifestPath), true)
    assert.equal(existsSync(workspace), true)
    assert.equal(existsSync(resultDirectory), true)
    rmSync(plannedArtifact.tempDirectory, { recursive: true, force: true })
    rmSync(transactionDirectory, { recursive: true, force: true })
    rmSync(workspace, { recursive: true, force: true })
    rmSync(resultDirectory, { recursive: true, force: true })
  })

  it('releases planning temporaries when update confirmation is cancelled', async () => {
    const transactionDirectory = mkdtempSync(path.join(home, 'cancelled-transaction-'))
    writeFileSync(path.join(transactionDirectory, 'transaction.json'), 'planned manifest\n')
    const plannedArtifact = artifact()
    const item: UpdatePlanItem = {
      installationId: 'opencode:fallback',
      target: 'opencode',
      ownership: 'fallback',
      installed: true,
      source: { kind: 'fallback', executor: 'npm-exec' },
      version: { current: '1.0.0', latest: '1.0.1', status: 'update-available' },
      artifact: plannedArtifact,
      steps: [{ kind: 'command', description: 'refresh', command: { executable: process.execPath, args: [], timeoutMs: 1000 } }],
      rollbackSteps: [],
      requiresConfirmation: true,
      temporaryDirectories: [transactionDirectory],
    }

    const summary = await executeUpdatePlan({ checkOnly: false, items: [item] }, {
      confirm: async () => false,
      commandRunner: { run: async () => { throw new Error('cancelled updates must not execute') } },
    })

    assert.equal(summary.results[0]?.status, 'skipped')
    assert.equal(existsSync(plannedArtifact.tempDirectory), false)
    assert.equal(existsSync(transactionDirectory), false)
  })

  it('preserves all fallback resources when execution raises before a completion verdict', async () => {
    const fixture = await writeFallbackExecutionFixture()
    const transactionDirectory = mkdtempSync(path.join(home, 'exception-transaction-'))
    const manifestPath = path.join(transactionDirectory, 'transaction.json')
    writeFileSync(manifestPath, '{}')
    const plannedArtifact = artifact()
    const journalPath = fallbackJournalPath(fixture.trackingPath)
    let workspace = ''
    let resultDirectory = ''
    let snapshotDirectory = ''
    const item: UpdatePlanItem = {
      installationId: 'opencode:fallback',
      target: 'opencode',
      ownership: 'fallback',
      installed: true,
      source: { kind: 'fallback', executor: 'npm-exec' },
      version: { current: '1.0.0', latest: '1.0.1', status: 'update-available' },
      artifact: plannedArtifact,
      fallbackTransaction: fixture.identity,
      steps: [{ kind: 'command', description: 'refresh', command: { executable: process.execPath, args: ['--transaction', manifestPath], timeoutMs: 1000 } }],
      rollbackSteps: [],
      requiresConfirmation: true,
      temporaryDirectories: [transactionDirectory],
    }

    try {
      const summary = await executeUpdatePlan({ checkOnly: false, items: [item] }, {
        yes: true,
        commandRunner: {
          run: async (command) => {
            workspace = command.cwd ?? ''
            const resultIndex = command.args?.indexOf('--result') ?? -1
            const resultPath = resultIndex >= 0 ? command.args?.[resultIndex + 1] : undefined
            resultDirectory = resultPath === undefined ? '' : path.dirname(resultPath)
            throw new Error('runner failed before completion evidence')
          },
        },
      })

      assert.equal(summary.results[0]?.error?.code, 'UPDATE_EXECUTION_FAILED')
      assert.equal(existsSync(plannedArtifact.tempDirectory), true)
      assert.equal(existsSync(transactionDirectory), true)
      assert.equal(existsSync(workspace), true)
      assert.notEqual(resultDirectory, '')
      assert.equal(existsSync(resultDirectory), true)
      assert.equal(existsSync(journalPath), true)
      snapshotDirectory = (JSON.parse(readFileSync(journalPath, 'utf8')) as { snapshotDirectory: string }).snapshotDirectory
      assert.equal(existsSync(snapshotDirectory), true)
    } finally {
      rmSync(plannedArtifact.tempDirectory, { recursive: true, force: true })
      rmSync(transactionDirectory, { recursive: true, force: true })
      if (workspace !== '') rmSync(workspace, { recursive: true, force: true })
      if (resultDirectory !== '') rmSync(resultDirectory, { recursive: true, force: true })
      if (snapshotDirectory !== '') rmSync(snapshotDirectory, { recursive: true, force: true })
      rmSync(journalPath, { force: true })
    }
  })

  it('keeps plan cleanup independent from public child error presentation', async () => {
    const fixture = await writeFallbackExecutionFixture()
    const transactionDirectory = mkdtempSync(path.join(home, 'presentation-transaction-'))
    const manifestPath = path.join(transactionDirectory, 'transaction.json')
    writeFileSync(manifestPath, '{}')
    const plannedArtifact = artifact()
    const journalPath = fallbackJournalPath(fixture.trackingPath)
    let workspace = ''
    let resultDirectory = ''
    let snapshotDirectory = ''
    const item: UpdatePlanItem = {
      installationId: 'opencode:fallback',
      target: 'opencode',
      ownership: 'fallback',
      installed: true,
      source: { kind: 'fallback', executor: 'npm-exec' },
      version: { current: '1.0.0', latest: '1.0.1', status: 'update-available' },
      artifact: plannedArtifact,
      fallbackTransaction: fixture.identity,
      steps: [{ kind: 'command', description: 'refresh', command: { executable: process.execPath, args: ['--transaction', manifestPath], timeoutMs: 1000 } }],
      rollbackSteps: [],
      requiresConfirmation: true,
      temporaryDirectories: [transactionDirectory],
    }
    const originalExecuteWithOutcome = fallbackStrategy.executeWithOutcome
    let returnedResult: UpdateResult | undefined
    fallbackStrategy.executeWithOutcome = async (planItem, context) => {
      const outcome = await originalExecuteWithOutcome(planItem, context)
      assert.equal(outcome.result.error?.code, 'FALLBACK_TREE_TERMINATION_UNCONFIRMED')
      // Return a distinct public result object. Cleanup must follow the
      // explicit disposition, never an identity lookup on the result.
      const result = { ...outcome.result, error: { code: 'FALLBACK_COMMAND_FAILED', message: 'public presentation changed' } }
      returnedResult = result
      assert.equal(JSON.stringify(result).includes('planResources'), false)
      return { result, planResources: outcome.planResources }
    }

    try {
      const summary = await executeUpdatePlan({ checkOnly: false, items: [item] }, {
        yes: true,
        commandRunner: {
          run: async (command) => {
            workspace = command.cwd ?? ''
            const resultIndex = command.args?.indexOf('--result') ?? -1
            const resultPath = resultIndex >= 0 ? command.args?.[resultIndex + 1] : undefined
            resultDirectory = resultPath === undefined ? '' : path.dirname(resultPath)
            return { exitCode: null, stdout: '', stderr: '', timedOut: true, treeTerminated: false }
          },
        },
      })

      assert.equal(summary.results[0], returnedResult, 'the coordinator must consume the same result object whose public error was changed')
      assert.equal(summary.results[0]?.error?.code, 'FALLBACK_COMMAND_FAILED')
      assert.equal(existsSync(plannedArtifact.tempDirectory), true)
      assert.equal(existsSync(transactionDirectory), true)
      assert.equal(existsSync(workspace), true)
      assert.notEqual(resultDirectory, '')
      assert.equal(existsSync(resultDirectory), true)
      assert.equal(existsSync(journalPath), true)
      snapshotDirectory = (JSON.parse(readFileSync(journalPath, 'utf8')) as { snapshotDirectory: string }).snapshotDirectory
      assert.equal(existsSync(snapshotDirectory), true)
    } finally {
      fallbackStrategy.executeWithOutcome = originalExecuteWithOutcome
      rmSync(plannedArtifact.tempDirectory, { recursive: true, force: true })
      rmSync(transactionDirectory, { recursive: true, force: true })
      if (workspace !== '') rmSync(workspace, { recursive: true, force: true })
      if (resultDirectory !== '') rmSync(resultDirectory, { recursive: true, force: true })
      if (snapshotDirectory !== '') rmSync(snapshotDirectory, { recursive: true, force: true })
      rmSync(journalPath, { force: true })
    }
  })

  it('releases resources for a cloned confirmed outcome despite preservation-looking public error', async () => {
    const fixture = await writeFallbackExecutionFixture()
    const transactionDirectory = mkdtempSync(path.join(home, 'cloned-release-transaction-'))
    const manifestPath = path.join(transactionDirectory, 'transaction.json')
    writeFileSync(manifestPath, '{}')
    const plannedArtifact = artifact()
    const item: UpdatePlanItem = {
      installationId: 'opencode:fallback',
      target: 'opencode',
      ownership: 'fallback',
      installed: true,
      source: { kind: 'fallback', executor: 'npm-exec' },
      version: { current: '1.0.0', latest: '1.0.1', status: 'update-available' },
      artifact: plannedArtifact,
      fallbackTransaction: fixture.identity,
      steps: [{ kind: 'command', description: 'refresh', command: { executable: process.execPath, args: ['--transaction', manifestPath], timeoutMs: 1000 } }],
      rollbackSteps: [],
      requiresConfirmation: true,
      temporaryDirectories: [transactionDirectory],
    }
    const originalExecuteWithOutcome = fallbackStrategy.executeWithOutcome
    let originalResult: UpdateResult | undefined
    let returnedResult: UpdateResult | undefined
    fallbackStrategy.executeWithOutcome = async (planItem, context) => {
      const outcome = await originalExecuteWithOutcome(planItem, context)
      assert.equal(outcome.planResources, 'release')
      originalResult = outcome.result
      // Clone the public result while retaining the internal release decision.
      // A presentation that resembles preservation must not override it.
      const result = { ...outcome.result, error: { code: 'CLI_TREE_TERMINATION_UNCONFIRMED', message: 'public preservation presentation' } }
      assert.notEqual(result, outcome.result)
      assert.equal(JSON.stringify(result).includes('planResources'), false)
      returnedResult = result
      return { result, planResources: outcome.planResources }
    }

    try {
      const summary = await executeUpdatePlan({ checkOnly: false, items: [item] }, {
        yes: true,
        commandRunner: { run: async () => ({ exitCode: 1, stdout: '', stderr: '', timedOut: false, treeTerminated: true }) },
      })

      assert.equal(summary.results[0], returnedResult)
      assert.notEqual(summary.results[0], originalResult)
      assert.equal(summary.results[0]?.error?.code, 'CLI_TREE_TERMINATION_UNCONFIRMED')
      assert.equal(existsSync(plannedArtifact.tempDirectory), false)
      assert.equal(existsSync(transactionDirectory), false)
      assert.equal(JSON.stringify(summary).includes('planResources'), false)
    } finally {
      fallbackStrategy.executeWithOutcome = originalExecuteWithOutcome
      rmSync(plannedArtifact.tempDirectory, { recursive: true, force: true })
      rmSync(transactionDirectory, { recursive: true, force: true })
    }
  })

  it('preserves plan resources when a fallback outcome lacks its internal disposition', async () => {
    const fixture = await writeFallbackExecutionFixture()
    const transactionDirectory = mkdtempSync(path.join(home, 'missing-disposition-transaction-'))
    const manifestPath = path.join(transactionDirectory, 'transaction.json')
    writeFileSync(manifestPath, '{}')
    const plannedArtifact = artifact()
    const item: UpdatePlanItem = {
      installationId: 'opencode:fallback',
      target: 'opencode',
      ownership: 'fallback',
      installed: true,
      source: { kind: 'fallback', executor: 'npm-exec' },
      version: { current: '1.0.0', latest: '1.0.1', status: 'update-available' },
      artifact: plannedArtifact,
      fallbackTransaction: fixture.identity,
      steps: [{ kind: 'command', description: 'refresh', command: { executable: process.execPath, args: ['--transaction', manifestPath], timeoutMs: 1000 } }],
      rollbackSteps: [],
      requiresConfirmation: true,
      temporaryDirectories: [transactionDirectory],
    }
    const resultWithoutDisposition: UpdateResult = {
      installationId: item.installationId,
      target: item.target,
      ownership: item.ownership,
      status: 'failed',
      changed: false,
      error: { code: 'FALLBACK_COMMAND_FAILED', message: 'untrusted result' },
    }
    const originalExecuteWithOutcome = fallbackStrategy.executeWithOutcome
    fallbackStrategy.executeWithOutcome = async () => ({ result: resultWithoutDisposition } as unknown as Awaited<ReturnType<typeof fallbackStrategy.executeWithOutcome>>)

    try {
      const summary = await executeUpdatePlan({ checkOnly: false, items: [item] }, {
        yes: true,
        commandRunner: { run: async () => { throw new Error('a missing-disposition result must not execute the command') } },
      })

      assert.equal(summary.results[0], resultWithoutDisposition)
      assert.equal(JSON.stringify(summary).includes('planResources'), false)
      assert.equal(existsSync(plannedArtifact.tempDirectory), true)
      assert.equal(existsSync(transactionDirectory), true)
    } finally {
      fallbackStrategy.executeWithOutcome = originalExecuteWithOutcome
      rmSync(plannedArtifact.tempDirectory, { recursive: true, force: true })
      rmSync(transactionDirectory, { recursive: true, force: true })
    }
  })

  it('preserves plan resources and returns a failed result for malformed fallback result enums', async () => {
    const malformedFields: Array<['status' | 'target' | 'ownership', string]> = [
      ['status', 'invalid'],
      ['target', 'invalid'],
      ['ownership', 'invalid'],
    ]
    const originalExecuteWithOutcome = fallbackStrategy.executeWithOutcome

    for (const [field, value] of malformedFields) {
      const fixture = await writeFallbackExecutionFixture()
      const transactionDirectory = mkdtempSync(path.join(home, `malformed-${field}-transaction-`))
      const manifestPath = path.join(transactionDirectory, 'transaction.json')
      writeFileSync(manifestPath, '{}')
      const plannedArtifact = artifact()
      const item: UpdatePlanItem = {
        installationId: 'opencode:fallback',
        target: 'opencode',
        ownership: 'fallback',
        installed: true,
        source: { kind: 'fallback', executor: 'npm-exec' },
        version: { current: '1.0.0', latest: '1.0.1', status: 'update-available' },
        artifact: plannedArtifact,
        fallbackTransaction: fixture.identity,
        steps: [{ kind: 'command', description: 'refresh', command: { executable: process.execPath, args: ['--transaction', manifestPath], timeoutMs: 1000 } }],
        rollbackSteps: [],
        requiresConfirmation: true,
        temporaryDirectories: [transactionDirectory],
      }
      const malformedResult: Record<string, unknown> = {
        installationId: item.installationId,
        target: item.target,
        ownership: item.ownership,
        status: 'failed',
        changed: false,
      }
      malformedResult[field] = value
      fallbackStrategy.executeWithOutcome = async () => ({
        result: malformedResult as unknown as UpdateResult,
        planResources: 'release',
      })

      try {
        const summary = await executeUpdatePlan({ checkOnly: false, items: [item] }, {
          yes: true,
          commandRunner: { run: async () => { throw new Error('malformed outcomes must not execute the command') } },
        })

        const result = summary.results[0]
        assert.equal(result?.status, 'failed')
        assert.equal(result?.error?.code, 'UPDATE_EXECUTION_FAILED')
        assert.equal(result?.installationId, item.installationId)
        assert.equal(result?.target, item.target)
        assert.equal(result?.ownership, item.ownership)
        assert.equal(result?.changed, false)
        assert.equal(summary.counts.failed, 1)
        assert.equal(Object.prototype.hasOwnProperty.call(summary.counts, 'invalid'), false)
        assert.equal(existsSync(plannedArtifact.tempDirectory), true)
        assert.equal(existsSync(transactionDirectory), true)
      } finally {
        fallbackStrategy.executeWithOutcome = originalExecuteWithOutcome
        rmSync(plannedArtifact.tempDirectory, { recursive: true, force: true })
        rmSync(transactionDirectory, { recursive: true, force: true })
      }
    }
  })

  it('cleans fallback artifacts and transaction state after a confirmed failure', async () => {
    const fixture = await writeFallbackExecutionFixture()
    const transactionDirectory = mkdtempSync(path.join(home, 'transaction-'))
    const manifestPath = path.join(transactionDirectory, 'transaction.json')
    writeFileSync(manifestPath, '{}')
    const plannedArtifact = artifact()
    const item: UpdatePlanItem = {
      installationId: 'opencode:fallback',
      target: 'opencode',
      ownership: 'fallback',
      installed: true,
      source: { kind: 'fallback', executor: 'npm-exec' },
      version: { current: '1.0.0', latest: '1.0.1', status: 'update-available' },
      artifact: plannedArtifact,
      fallbackTransaction: fixture.identity,
      steps: [{ kind: 'command', description: 'refresh', command: { executable: process.execPath, args: ['--transaction', manifestPath], timeoutMs: 1000 } }],
      rollbackSteps: [],
      requiresConfirmation: true,
      temporaryDirectories: [transactionDirectory],
    }

    const summary = await executeUpdatePlan({ checkOnly: false, items: [item] }, {
      yes: true,
      commandRunner: { run: async () => ({ exitCode: 1, stdout: '', stderr: '', timedOut: false, treeTerminated: true }) },
    })

    assert.equal(summary.results[0]?.status, 'failed')
    assert.equal(existsSync(plannedArtifact.tempDirectory), false)
    assert.equal(existsSync(transactionDirectory), false)
  })

  it('preserves the CLI artifact when package-manager tree termination is unconfirmed', async () => {
    const plannedArtifact = artifact()
    const item: UpdatePlanItem = {
      ...mutableCliItem(),
      artifact: plannedArtifact,
      metadata: { packagePath: path.join(home, 'global', 'nsolid-plugin') },
      steps: [{ kind: 'command', description: 'update', command: { executable: process.execPath, args: [], timeoutMs: 1000 } }],
    }

    const summary = await executeUpdatePlan({ checkOnly: false, items: [item] }, {
      yes: true,
      commandRunner: { run: async () => ({ exitCode: null, stdout: '', stderr: '', timedOut: true, treeTerminated: false }) },
    })

    assert.equal(summary.results[0]?.error?.code, 'CLI_TREE_TERMINATION_UNCONFIRMED')
    assert.equal(existsSync(plannedArtifact.tempDirectory), true)
    rmSync(plannedArtifact.tempDirectory, { recursive: true, force: true })
  })
})

describe('withPinnedMarketplaceCommit', () => {
  const gitArtifact = (commit = 'bc9c87e6ce6ca73756dc20fdd41a3219bcd5b60c'): ResolvedArtifactIdentity => ({
    kind: 'git',
    repository: 'https://github.com/NodeSource/nsolid-plugin.git',
    commit,
    contentDigest: 'planned-content',
  })

  const marketplaceSource = (): UpdateSource => ({
    kind: 'claude-marketplace',
    pluginId: 'nsolid-plugin@nodesource',
    marketplace: 'nodesource',
    scope: 'user',
    versionSource: { kind: 'git', repository: 'https://github.com/NodeSource/nsolid-plugin.git', revision: 'main', manifestPath: 'bundle.json' } as const,
  })

  it('pins a mutable marketplace ref to the resolved commit', () => {
    const pinned = withPinnedMarketplaceCommit(marketplaceSource(), gitArtifact())
    if (pinned.kind !== 'claude-marketplace') { assert.fail('source kind changed') }
    if (pinned.versionSource.kind !== 'git') { assert.fail('version source kind changed') }
    assert.equal(pinned.versionSource.revision, 'bc9c87e6ce6ca73756dc20fdd41a3219bcd5b60c')
    assert.equal(pinned.versionSource.commit, 'bc9c87e6ce6ca73756dc20fdd41a3219bcd5b60c')
  })

  it('leaves a source already pinned to the resolved commit untouched', () => {
    const source = {
      ...marketplaceSource(),
      versionSource: { kind: 'git', repository: 'https://github.com/NodeSource/nsolid-plugin.git', revision: 'bc9c87e6ce6ca73756dc20fdd41a3219bcd5b60c', commit: 'bc9c87e6ce6ca73756dc20fdd41a3219bcd5b60c', manifestPath: 'bundle.json' } as const,
    }
    assert.equal(withPinnedMarketplaceCommit(source, gitArtifact()), source)
  })

  it('rewrites a source whose commit matches but whose revision is still a mutable ref', () => {
    // A source carrying the resolved commit but a branch revision would pass
    // through a commit-only pin check and then fail the execution guard
    // (NATIVE_SOURCE_NOT_PINNED): the revision must also be rewritten to the
    // resolved artifact commit.
    const source = {
      ...marketplaceSource(),
      versionSource: { kind: 'git', repository: 'https://github.com/NodeSource/nsolid-plugin.git', revision: 'main', commit: 'bc9c87e6ce6ca73756dc20fdd41a3219bcd5b60c', manifestPath: 'bundle.json' } as const,
    }
    const pinned = withPinnedMarketplaceCommit(source, gitArtifact())
    if (pinned.kind !== 'claude-marketplace') { assert.fail('source kind changed') }
    if (pinned.versionSource.kind !== 'git') { assert.fail('version source kind changed') }
    assert.equal(pinned.versionSource.revision, 'bc9c87e6ce6ca73756dc20fdd41a3219bcd5b60c')
    assert.equal(pinned.versionSource.commit, 'bc9c87e6ce6ca73756dc20fdd41a3219bcd5b60c')
    // A rewritten source must not be the same object identity.
    assert.notEqual(pinned, source)
  })

  it('returns the source unchanged for non-git artifacts', () => {
    const source = marketplaceSource()
    const snapshotArtifact: ResolvedArtifactIdentity = { kind: 'local-snapshot', root: '/tmp/snapshot', contentDigest: 'snapshot-digest' }
    assert.equal(withPinnedMarketplaceCommit(source, snapshotArtifact), source)
    assert.equal(withPinnedMarketplaceCommit(source, undefined), source)
  })

  it('returns the source unchanged for non-marketplace sources', () => {
    const cliSource: UpdateSource = { kind: 'global-package', packageManager: 'npm', packageName: 'nsolid-plugin' }
    assert.equal(withPinnedMarketplaceCommit(cliSource, gitArtifact()), cliSource)
  })

  it('pins codex marketplace sources too', () => {
    const codexSource: UpdateSource = {
      kind: 'codex-marketplace',
      pluginId: 'nsolid-plugin@nodesource',
      marketplace: 'nodesource',
      versionSource: { kind: 'git', repository: 'https://github.com/NodeSource/nsolid-plugin.git', revision: 'main', manifestPath: 'bundle.json' } as const,
    }
    const pinned = withPinnedMarketplaceCommit(codexSource, gitArtifact())
    if (pinned.kind !== 'codex-marketplace') { assert.fail('source kind changed') }
    if (pinned.versionSource.kind !== 'git') { assert.fail('version source kind changed') }
    assert.equal(pinned.versionSource.commit, 'bc9c87e6ce6ca73756dc20fdd41a3219bcd5b60c')
  })
})

describe('planUpdates pins the resolved marketplace commit into the planned source', () => {
  const resolvedCommit = 'bc9c87e6ce6ca73756dc20fdd41a3219bcd5b60c'

  function marketplaceArchive (): Buffer {
    const root = `nsolid-plugin-${resolvedCommit}`
    const dir = tarEntry(`${root}/`, undefined, '5')
    const file = tarEntry(`${root}/bundle.json`, Buffer.from('{"version":"1.0.1"}\n'), '0')
    return gzipSync(Buffer.concat([dir, file, Buffer.alloc(1024)]))
  }

  it('resolves a mutable main ref and plans the native strategy with the pinned commit', async () => {
    const claudeDir = mkdtempSync(path.join(home, 'claude-bin-'))
    const claudeExe = path.join(claudeDir, process.platform === 'win32' ? 'claude.exe' : 'claude')
    writeFileSync(claudeExe, process.platform === 'win32' ? '' : '#!/bin/sh\nexit 0\n', { mode: 0o755 })
    // A mutable-ref marketplace installation: the record pins no commit, only
    // a branch ref, so the resolved commit must come from the lookup.
    const payloadRoot = path.join(home, '.claude', 'plugins', 'cache', 'nsolid-plugin', '1.0.0')
    mkdirSync(payloadRoot, { recursive: true })
    writeFileSync(path.join(payloadRoot, 'bundle.json'), '{"version":"1.0.0"}\n')
    const pluginsDir = path.join(home, '.claude', 'plugins')
    mkdirSync(pluginsDir, { recursive: true })
    const registry = {
      plugins: {
        'nsolid-plugin@nodesource': [{
          version: '1.0.0',
          installPath: payloadRoot,
          scope: 'user',
          repository: 'https://github.com/NodeSource/nsolid-plugin.git',
          revision: 'main',
        }],
      },
    }
    const installedPath = path.join(pluginsDir, 'installed_plugins.json')
    writeFileSync(installedPath, JSON.stringify(registry))
    writeFileSync(path.join(pluginsDir, 'known_marketplaces.json'), '{"nodesource":{"source":"github.com/NodeSource/nsolid-plugin"}}\n')
    const previousPath = process.env.PATH
    const previousPathExt = process.env.PATHEXT
    process.env.PATH = claudeDir
    if (process.platform === 'win32') process.env.PATHEXT = '.EXE;.COM;.CMD;.BAT'

    const archive = marketplaceArchive()
    try {
      const plan = await planUpdates({
        harness: 'claude',
        fetchImpl: async (url: RequestInfo | URL) => {
          const text = String(url)
          if (text.includes('api.github.com')) {
            return new Response(JSON.stringify({ sha: resolvedCommit }), { status: 200 })
          }
          if (text.includes('raw.githubusercontent.com')) {
            return new Response(JSON.stringify({ version: '1.0.1' }), {
              status: 200,
              headers: { 'x-commit-sha': resolvedCommit },
            })
          }
          if (text.includes('codeload.github.com')) {
            return new Response(new Uint8Array(archive), { status: 200 })
          }
          throw new Error(`unexpected fetch ${text}`)
        },
        commandRunner: { run: async () => ({ exitCode: 0, stdout: '', stderr: '', timedOut: false, treeTerminated: true }) },
      })

      const item = plan.items.find((candidate) => candidate.target === 'claude')
      assert.ok(item, 'a claude plan item must exist')
      assert.equal(item.planningError, undefined, JSON.stringify(item.planningError))
      assert.ok(item.steps.length > 0)
      const source = item.source
      if (source.kind !== 'claude-marketplace') { assert.fail('source kind changed') }
      if (source.versionSource.kind !== 'git') { assert.fail('version source kind changed') }
      assert.equal(source.versionSource.revision, resolvedCommit)
      assert.equal(source.versionSource.commit, resolvedCommit)
    } finally {
      if (previousPath === undefined) delete process.env.PATH
      else process.env.PATH = previousPath
      if (previousPathExt === undefined) delete process.env.PATHEXT
      else process.env.PATHEXT = previousPathExt
    }
  })
})

describe('unsupported CLI provenance', () => {
  function cliPackageRoot (root: string, version: string): string {
    const manifest = path.join(root, 'package.json')
    mkdirSync(path.dirname(manifest), { recursive: true })
    writeFileSync(manifest, JSON.stringify({ name: 'nsolid-plugin', version }))
    writeFileSync(path.join(root, 'bundle.json'), JSON.stringify({ name: 'nsolid-plugin', version }))
    return root
  }

  function cliLauncher (root: string): string {
    const launcher = path.join(root, 'dist', 'src', 'cli.js')
    mkdirSync(path.dirname(launcher), { recursive: true })
    writeFileSync(launcher, '#!/usr/bin/env node\n')
    return launcher
  }

  function registryFetch (version: string): typeof fetch {
    return async () => new Response(JSON.stringify({ 'dist-tags': { latest: version } }), { status: 200 })
  }

  const exactVersionGuidance = (version: string) => [
    `npm install --global nsolid-plugin@${version}`,
    `pnpm add --global nsolid-plugin@${version}`,
    `npx -y nsolid-plugin@${version} <command>`,
  ]

  it('reports a workspace CLI launch as unsupported with exact-version guidance during a check', async () => {
    const root = cliPackageRoot(path.join(home, 'repo', 'packages', 'core'), '1.0.3')
    const launcher = cliLauncher(root)
    let probes = 0

    const summary = await checkUpdates({
      packageRoot: root,
      executablePath: launcher,
      cwd: path.join(home, 'scratch'),
      fetchImpl: registryFetch('90.0.2'),
      commandRunner: {
        run: async () => {
          probes++
          throw new Error('read-only check must not probe package managers')
        },
      },
    })

    const cli = summary.results.find((result) => result.installationId === 'cli:global')
    assert.ok(cli, 'a cli result must exist')
    assert.equal(cli.status, 'unsupported')
    assert.equal(cli.ownership, 'none')
    assert.equal(cli.currentVersion, undefined)
    assert.equal(cli.latestVersion, '90.0.2')
    assert.deepEqual(cli.manualCommands, exactVersionGuidance('90.0.2'))
    assert.equal(summary.exitCode, 0)
    assert.equal(summary.success, true)
    assert.equal(probes, 0)
  })

  it('appends wrapper guidance for a detected Volta launcher during a check', async () => {
    const root = cliPackageRoot(path.join(home, '.volta', 'tools', 'image', 'packages', 'nsolid-plugin'), '90.0.0')
    const launcher = path.join(root, 'bin', 'nsolid-plugin')
    mkdirSync(path.dirname(launcher), { recursive: true })
    writeFileSync(launcher, '#!/bin/sh\n')

    const summary = await checkUpdates({
      packageRoot: root,
      executablePath: launcher,
      cwd: path.join(home, 'scratch'),
      fetchImpl: registryFetch('90.0.2'),
      commandRunner: { run: async () => { throw new Error('check must not probe package managers') } },
    })

    const cli = summary.results.find((result) => result.installationId === 'cli:global')
    assert.ok(cli)
    assert.equal(cli.status, 'unsupported')
    assert.equal(cli.currentVersion, undefined)
    const strategyItem = await cliPackageStrategy.plan({
      installationId: 'cli:global',
      target: 'cli',
      ownership: 'none',
      installed: true,
      source: { kind: 'unsupported', source: launcher, reason: 'unsupported-manager' },
      version: { latest: '90.0.2', status: 'unknown' },
    }, {
      options: {},
      commandRunner: { run: async () => ({ exitCode: 0, stdout: '', stderr: '', timedOut: false, treeTerminated: true }) },
    })
    assert.deepEqual(cli.manualCommands, strategyItem.manualCommands, 'check and mutation planning must use the identical shared guidance')
    assert.deepEqual(cli.manualCommands, [...exactVersionGuidance('90.0.2'), 'volta install nsolid-plugin@90.0.2'])
    assert.equal(summary.exitCode, 0)
  })

  it('exits 2 with exact-version guidance and runs no package-manager update for a workspace CLI mutation', async () => {
    const root = cliPackageRoot(path.join(home, 'repo', 'packages', 'core'), '1.0.3')
    const launcher = cliLauncher(root)
    const tarballBytes = Buffer.from('verified artifact')
    const integrity = `sha512-${createHash('sha512').update(tarballBytes).digest('base64')}`
    const commands: string[] = []

    const summary = await update({
      packageRoot: root,
      executablePath: launcher,
      cwd: path.join(home, 'scratch'),
      yes: true,
      registry: 'https://registry.example',
      fetchImpl: async (url: RequestInfo | URL) => {
        const text = String(url)
        if (text.endsWith('/nsolid-plugin')) {
          return new Response(JSON.stringify({
            'dist-tags': { latest: '90.0.2' },
            versions: {
              '90.0.2': {
                name: 'nsolid-plugin',
                version: '90.0.2',
                dist: { tarball: 'https://registry.example/nsolid-plugin-90.0.2.tgz', integrity },
              },
            },
          }), { status: 200 })
        }
        if (text.endsWith('.tgz')) return new Response(new Uint8Array(tarballBytes), { status: 200 })
        throw new Error(`unexpected fetch ${text}`)
      },
      commandRunner: {
        run: async (spec: CommandSpec) => {
          commands.push([spec.executable, ...spec.args].join(' '))
          return { exitCode: 1, stdout: '', stderr: '', timedOut: false, treeTerminated: true }
        },
      },
    })

    const cli = summary.results.find((result) => result.installationId === 'cli:global')
    assert.ok(cli)
    assert.equal(cli.status, 'unsupported')
    assert.equal(cli.currentVersion, undefined)
    assert.equal(cli.latestVersion, '90.0.2')
    assert.deepEqual(cli.manualCommands, exactVersionGuidance('90.0.2'))
    assert.equal(summary.exitCode, 2)
    assert.equal(summary.success, false)
    assert.deepEqual(commands, [], 'an unsupported launcher must not invoke any package manager')
  })
})

describe('read-only check stays off the filesystem', () => {
  it('summarizes fallback changes in memory without requiring a writable temporary directory', { skip: process.platform === 'win32' }, async () => {
    // A tracked opencode fallback installation with one tracked skill.
    const destination = path.join(home, '.config', 'opencode', 'skills')
    mkdirSync(path.join(destination, 'tracked'), { recursive: true })
    writeFileSync(path.join(destination, 'tracked', 'SKILL.md'), 'old')
    const trackingPath = getTrackingFilePath()
    mkdirSync(path.dirname(trackingPath), { recursive: true })
    writeFileSync(trackingPath, JSON.stringify({
      version: '1.0.0',
      installedAt: new Date().toISOString(),
      harness: 'opencode',
      bundleVersions: { opencode: '1.0.0' },
      skills: [{
        name: 'tracked',
        path: path.join(destination, 'tracked'),
        paths: { opencode: path.join(destination, 'tracked') },
        installedAt: new Date().toISOString(),
        harnesses: ['opencode'],
      }],
      mcpServers: [],
    }))

    // A verified registry artifact whose bundle adds one skill and one MCP
    // server; it is served over the fetch seam and never written to disk.
    const bundle = {
      name: 'nsolid-plugin',
      version: '1.0.1',
      skills: [{ name: 'added', path: 'skills/added', description: 'added' }],
      mcpServers: [{ name: 'brand-new-mcp', url: 'https://example.com/mcp', headers: {} }],
    }
    const bundleJson = Buffer.from(JSON.stringify(bundle))
    const tar = Buffer.concat([
      tarEntry('package/', undefined, '5'),
      tarEntry('package/bundle.json', bundleJson, '0'),
      Buffer.alloc(1024),
    ])
    const tarballBytes = gzipSync(tar)
    const integrity = `sha512-${createHash('sha512').update(tarballBytes).digest('base64')}`

    // Route os.tmpdir() into a watched scratch directory for the duration of
    // the check: the former implementation mkdtemp'd
    // `nsolid-plugin-artifact-*` here on every fallback check.
    const scratch = mkdtempSync(path.join(home, 'check-tmp-'))
    const previousTmpdir = process.env.TMPDIR
    const previousTemp = process.env.TEMP
    const previousTmp = process.env.TMP
    process.env.TMPDIR = scratch
    process.env.TEMP = scratch
    process.env.TMP = scratch
    chmodSync(scratch, 0o500)
    try {
      const summary = await checkUpdates({
        harness: 'opencode',
        fetchImpl: async (url: RequestInfo | URL) => {
          const text = String(url)
          if (text.endsWith('/nsolid-plugin')) {
            return new Response(JSON.stringify({
              'dist-tags': { latest: '1.0.1' },
              versions: {
                '1.0.1': { version: '1.0.1', dist: { tarball: 'https://registry.example/a.tgz', integrity } },
              },
            }), { status: 200 })
          }
          if (text.endsWith('.tgz')) return new Response(new Uint8Array(tarballBytes), { status: 200 })
          throw new Error(`unexpected fetch ${text}`)
        },
      })

      const fallback = summary.results.find((result) => result.installationId === 'opencode:fallback')
      assert.ok(fallback, JSON.stringify(summary.results))
      assert.equal(fallback.status, 'update-available')
      assert.deepEqual(fallback.changes, {
        skillsAdded: ['added'],
        skillsRemoved: ['tracked'],
        skillsUpdated: 0,
        mcpAdded: ['brand-new-mcp'],
        mcpRemoved: [],
        mcpUpdated: 0,
      })
      assert.deepEqual(readdirSync(scratch), [], 'the check path must not create any temporary artifact directory')
    } finally {
      chmodSync(scratch, 0o700)
      if (previousTmpdir === undefined) delete process.env.TMPDIR
      else process.env.TMPDIR = previousTmpdir
      if (previousTemp === undefined) delete process.env.TEMP
      else process.env.TEMP = previousTemp
      if (previousTmp === undefined) delete process.env.TMP
      else process.env.TMP = previousTmp
    }
  })
})

describe('update coordinator recovery message branches', () => {
  const planOptions = () => ({
    all: true,
    check: true,
    fetchImpl: async () => new Response('{}', { status: 200 }),
    commandRunner: {
      run: async () => ({ exitCode: 0, stdout: '', stderr: '', timedOut: false, treeTerminated: true }),
    },
  })

  /** A two-skill pending journal whose snapshot backups can be selectively tampered with. */
  async function writeTwoSkillJournal (): Promise<{ skillAPath: string; skillBPath: string; journalPath: string }> {
    const skillsDir = path.join(home, '.config', 'opencode', 'skills')
    const skillAPath = path.join(skillsDir, 'alpha')
    const skillBPath = path.join(skillsDir, 'beta')
    mkdirSync(skillAPath, { recursive: true })
    writeFileSync(path.join(skillAPath, 'SKILL.md'), 'alpha tracked')
    mkdirSync(skillBPath, { recursive: true })
    writeFileSync(path.join(skillBPath, 'SKILL.md'), 'beta tracked')
    const trackingPath = getTrackingFilePath()
    mkdirSync(path.dirname(trackingPath), { recursive: true })
    writeFileSync(trackingPath, `${JSON.stringify({
      version: '1.0.0',
      installedAt: new Date().toISOString(),
      harness: 'opencode',
      skills: [
        { name: 'alpha', path: skillAPath, paths: { opencode: skillAPath }, installedAt: new Date().toISOString(), harnesses: ['opencode'] },
        { name: 'beta', path: skillBPath, paths: { opencode: skillBPath }, installedAt: new Date().toISOString(), harnesses: ['opencode'] },
      ],
      mcpServers: [],
    }, null, 2)}\n`)
    const evidence = async (target: string) => {
      const kind = await pathKind(target)
      return { path: path.resolve(target), kind, digest: kind === 'missing' ? undefined : await pathDigest(target) }
    }
    const { journal } = await beginFallbackJournal({
      installationId: 'opencode:fallback',
      harness: 'opencode',
      trackingPath,
      trackingDigest: trackingDigest(trackingPath)!,
      protocolVersion: FALLBACK_PROTOCOL_VERSION,
      nonce: randomUUID(),
      plannedMissingFrontiers: [],
      ownedSkills: [await evidence(skillAPath), await evidence(skillBPath)],
      ownedLinks: [],
      ownedMcpFields: [],
      ownedMcpConfigPaths: [await evidence(path.join(home, '.config', 'opencode', 'opencode.jsonc'))],
      bundleDestinations: [await evidence(skillAPath), await evidence(skillBPath)],
      approvedDestinationRoots: [skillsDir],
    })
    return { skillAPath, skillBPath, journalPath: journal.journalPath }
  }

  /** Break one snapshot backup's authentication by smuggling a stray child into it. */
  function tamperBackupOf (journalPath: string, entryPath: string): void {
    const disk = JSON.parse(readFileSync(journalPath, 'utf8')) as { entries: Array<{ path: string, backup?: string }> }
    const entry = disk.entries.find((candidate) => path.resolve(candidate.path) === path.resolve(entryPath))
    if (entry?.backup === undefined) throw new Error(`no backup for ${entryPath}`)
    writeFileSync(path.join(entry.backup, 'tampered.txt'), 'tampered backup bytes')
  }

  it('reports unrestorable and drifted paths as preserved untouched on a check plan', async () => {
    const { skillAPath, skillBPath, journalPath } = await writeTwoSkillJournal()
    writeFileSync(path.join(skillAPath, 'SKILL.md'), 'alpha drifted')
    writeFileSync(path.join(skillBPath, 'SKILL.md'), 'beta drifted')
    tamperBackupOf(journalPath, skillBPath)

    const plan = await planUpdates(planOptions())
    const message = plan.items[0]?.planningError?.message ?? ''
    // A check never restores: even though skillA is restorable and skillB is
    // not, the guidance must say the state was preserved untouched and name
    // both paths for manual inspection.
    assert.match(message, /preserved untouched/)
    assert.doesNotMatch(message, /restored to its tracked state/)
    assert.match(message, new RegExp(`Live paths left for manual inspection: ${skillAPath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`))
    assert.match(message, new RegExp(`${skillBPath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`))
    assert.deepEqual(plan.items[0]?.preservedPaths, [path.resolve(skillAPath), path.resolve(skillBPath)].sort())
    // Both live trees are byte-identical: the drifted skill was not
    // rewritten and the tampered backup was never installed.
    assert.equal(readFileSync(path.join(skillAPath, 'SKILL.md'), 'utf8'), 'alpha drifted')
    assert.equal(readFileSync(path.join(skillBPath, 'SKILL.md'), 'utf8'), 'beta drifted')
  })

  it('reports drifted paths as preserved untouched on a check plan without restoring', async () => {
    const { skillAPath, skillBPath } = await writeTwoSkillJournal()
    writeFileSync(path.join(skillAPath, 'SKILL.md'), 'alpha drifted')
    writeFileSync(path.join(skillBPath, 'SKILL.md'), 'beta drifted')

    const plan = await planUpdates(planOptions())
    const message = plan.items[0]?.planningError?.message ?? ''
    assert.match(message, /preserved untouched/)
    assert.match(message, new RegExp(`Live paths left for manual inspection: ${skillAPath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`))
    assert.match(message, new RegExp(`${skillBPath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`))
    assert.doesNotMatch(message, /restored to its tracked state/)
    assert.deepEqual(plan.items[0]?.preservedPaths, [path.resolve(skillAPath), path.resolve(skillBPath)].sort())
    // The drifted skills were not rewritten from the snapshot.
    assert.equal(readFileSync(path.join(skillAPath, 'SKILL.md'), 'utf8'), 'alpha drifted')
    assert.equal(readFileSync(path.join(skillBPath, 'SKILL.md'), 'utf8'), 'beta drifted')
  })

  it('partially restores drifted skills on a non-check plan while preserving tampered backups', async () => {
    const { skillAPath, skillBPath, journalPath } = await writeTwoSkillJournal()
    writeFileSync(path.join(skillAPath, 'SKILL.md'), 'alpha drifted')
    writeFileSync(path.join(skillBPath, 'SKILL.md'), 'beta drifted')
    tamperBackupOf(journalPath, skillBPath)

    const plan = await planUpdates({ ...planOptions(), check: false })
    const message = plan.items[0]?.planningError?.message ?? ''
    // Skill A was restorable and rewritten while skill B stayed preserved:
    // the guidance must say PARTIALLY, name the restored path and the path
    // left for manual inspection, and never claim preserved untouched after
    // a restoration happened.
    assert.match(message, /PARTIALLY restored/)
    assert.match(message, /Restored to tracked state:/)
    assert.ok(message.includes(path.resolve(skillAPath)), 'the restored path is named in the guidance')
    assert.match(message, /Live paths left for manual inspection:/)
    assert.ok(message.includes(path.resolve(skillBPath)), 'the preserved path is named in the guidance')
    assert.doesNotMatch(message, /preserved untouched/)
    assert.deepEqual(plan.items[0]?.preservedPaths, [path.resolve(skillBPath)])
    // Skill A was rewritten from the authenticated snapshot while skill B
    // keeps its drifted bytes: the tampered backup was never installed.
    assert.equal(readFileSync(path.join(skillAPath, 'SKILL.md'), 'utf8'), 'alpha tracked')
    assert.equal(readFileSync(path.join(skillBPath, 'SKILL.md'), 'utf8'), 'beta drifted')
  })

  it('announces that nothing needed restoration when every owned path is already tracked', async () => {
    await writeTwoSkillJournal()

    const plan = await planUpdates(planOptions())
    const message = plan.items[0]?.planningError?.message ?? ''
    assert.match(message, /needs no restoration: every owned path is already at its tracked state/)
    assert.doesNotMatch(message, /Restored to tracked state:/)
    assert.doesNotMatch(message, /preserved untouched\./)
  })

  it('names preserved harness links outside tracking ownership when nothing needed restoration', async () => {
    // Journaled harness links are deliberately outside restore scope: the
    // current tracking file never names the link path, so next-run recovery
    // preserves it for inspection while every owned path already matches.
    const skillsDir = path.join(home, '.agents', 'skills')
    const skillPath = path.join(skillsDir, 'tracked')
    const linkPath = path.join(getHarnessSkillsPath('claude'), 'tracked')
    mkdirSync(skillPath, { recursive: true })
    writeFileSync(path.join(skillPath, 'SKILL.md'), 'tracked')
    mkdirSync(path.dirname(linkPath), { recursive: true })
    writeFileSync(linkPath, 'link\n')
    const trackingPath = getTrackingFilePath()
    mkdirSync(path.dirname(trackingPath), { recursive: true })
    writeFileSync(trackingPath, `${JSON.stringify({
      version: '1.0.0',
      installedAt: new Date().toISOString(),
      harness: 'claude',
      skills: [
        { name: 'tracked', path: skillPath, paths: { claude: skillPath }, installedAt: new Date().toISOString(), harnesses: ['claude'] },
      ],
      mcpServers: [],
    }, null, 2)}\n`)
    const evidence = async (target: string) => {
      const kind = await pathKind(target)
      return { path: path.resolve(target), kind, digest: kind === 'missing' ? undefined : await pathDigest(target) }
    }
    await beginFallbackJournal({
      installationId: 'claude:fallback',
      harness: 'claude',
      trackingPath,
      trackingDigest: trackingDigest(trackingPath)!,
      protocolVersion: FALLBACK_PROTOCOL_VERSION,
      nonce: randomUUID(),
      plannedMissingFrontiers: [],
      ownedSkills: [await evidence(skillPath)],
      ownedLinks: [await evidence(linkPath)],
      ownedMcpFields: [],
      ownedMcpConfigPaths: [await evidence(path.join(home, '.claude.json'))],
      bundleDestinations: [],
      approvedDestinationRoots: [path.resolve(skillsDir), path.resolve(getHarnessSkillsPath('claude'))],
    })

    const plan = await planUpdates(planOptions())
    const message = plan.items[0]?.planningError?.message ?? ''
    assert.match(message, /needs no restoration: every owned path is already at its tracked state/)
    assert.match(message, new RegExp(`Live paths left for manual inspection: ${linkPath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`))
    assert.doesNotMatch(message, /Restored to tracked state:/)
    assert.doesNotMatch(message, /preserved untouched\./)
  })
})
