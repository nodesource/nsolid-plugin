import { afterEach, beforeEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { executeUpdatePlan, planUpdates, update } from '../../../src/update/coordinator.js'
import { fallbackJournalPath } from '../../../src/update/fallback-journal.js'
import { getTrackingFilePath } from '../../../src/utils/path.js'
import type { UpdatePlanItem } from '../../../src/update/types.js'

let home: string
let previousHome: string | undefined
let previousUserProfile: string | undefined

beforeEach(() => {
  home = mkdtempSync(path.join(os.tmpdir(), 'nsolid-plugin-coordinator-'))
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
          return { exitCode: 0, stdout: '', stderr: '', timedOut: false }
        },
      },
    })

    assert.equal(plan.items.length, 1)
    assert.equal(plan.items[0]?.installationId, 'fallback:recovery')
    assert.equal(plan.items[0]?.planningError?.code, 'FALLBACK_RECOVERY_PENDING')
    assert.equal(fetchCalls, 0)
    assert.equal(runnerCalls, 0)
  })

  it('does not execute mutable targets while recovery remains unresolved', async () => {
    writeInvalidJournal()
    let runnerCalls = 0
    const summary = await update({
      all: true,
      yes: true,
      commandRunner: {
        run: async () => {
          runnerCalls++
          return { exitCode: 0, stdout: '', stderr: '', timedOut: false }
        },
      },
      fetchImpl: async () => new Response('{}', { status: 200 }),
    })

    assert.equal(summary.results.length, 1)
    assert.equal(summary.results[0]?.error?.code, 'FALLBACK_RECOVERY_FAILED')
    assert.equal(summary.results[0]?.status, 'failed')
    assert.equal(runnerCalls, 0)
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
          return { exitCode: 0, stdout: '', stderr: '', timedOut: false }
        },
      },
    })

    assert.equal(runnerCalls, 0)
    assert.equal(summary.results[1]?.status, 'failed')
    assert.equal(summary.results[1]?.error?.code, 'FALLBACK_RECOVERY_FAILED')
  })

  it('preserves fallback artifacts and transaction state when tree termination is unconfirmed', async () => {
    const transactionDirectory = mkdtempSync(path.join(home, 'transaction-'))
    const manifestPath = path.join(transactionDirectory, 'transaction.json')
    writeFileSync(manifestPath, '{}')
    const plannedArtifact = artifact()
    let workspace = ''
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
    }

    const summary = await executeUpdatePlan({ checkOnly: false, items: [item] }, {
      yes: true,
      commandRunner: {
        run: async (command) => {
          workspace = command.cwd ?? ''
          return { exitCode: null, stdout: '', stderr: '', timedOut: true, treeTerminated: false }
        },
      },
    })

    assert.equal(summary.results[0]?.error?.code, 'FALLBACK_TREE_TERMINATION_UNCONFIRMED')
    assert.equal(existsSync(plannedArtifact.tempDirectory), true)
    assert.equal(existsSync(manifestPath), true)
    assert.equal(existsSync(workspace), true)
    rmSync(plannedArtifact.tempDirectory, { recursive: true, force: true })
    rmSync(transactionDirectory, { recursive: true, force: true })
    rmSync(workspace, { recursive: true, force: true })
  })

  it('cleans fallback artifacts and transaction state after a confirmed failure', async () => {
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
      steps: [{ kind: 'command', description: 'refresh', command: { executable: process.execPath, args: ['--transaction', manifestPath], timeoutMs: 1000 } }],
      rollbackSteps: [],
      requiresConfirmation: true,
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
