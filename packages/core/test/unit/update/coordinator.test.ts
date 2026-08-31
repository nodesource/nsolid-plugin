import { afterEach, beforeEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { gzipSync } from 'node:zlib'
import os from 'node:os'
import path from 'node:path'
import { executeUpdatePlan, planUpdates, update, withPinnedMarketplaceCommit } from '../../../src/update/coordinator.js'
import { fallbackJournalPath } from '../../../src/update/fallback-journal.js'
import { getTrackingFilePath } from '../../../src/utils/path.js'
import type { ResolvedArtifactIdentity, UpdatePlanItem, UpdateSource } from '../../../src/update/types.js'

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
      temporaryDirectories: [transactionDirectory],
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

  function tarEntry (name: string, body: Buffer | undefined, type: string): Buffer {
    const header = Buffer.alloc(512)
    header.write(name, 0, 'utf8')
    const size = body ? body.length : 0
    header.write(size.toString(8).padStart(11, '0') + ' ', 124, 'ascii')
    header[156] = type.charCodeAt(0)
    header.write('ustar', 257, 'ascii')
    header.write('00', 263, 'ascii')
    const blocks = Math.ceil(size / 512)
    const padded = Buffer.concat([body ?? Buffer.alloc(0), Buffer.alloc(blocks * 512 - size)])
    return Buffer.concat([header, padded])
  }

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
        commandRunner: { run: async () => ({ exitCode: 0, stdout: '', stderr: '', timedOut: false }) },
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
