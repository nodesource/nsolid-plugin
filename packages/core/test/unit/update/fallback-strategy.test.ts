import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { fallbackStrategy } from '../../../src/update/strategies/fallback.js'
import { applyFallbackEntry, fallbackJournalPath, pathDigest, registerFallbackStage, trackingDigest } from '../../../src/update/fallback-journal.js'
import { valueDigest } from '../../../src/update/mcp-lookup.js'
import { readTrackingFile, writeTrackingFile } from '../../../src/skills/skill-tracker.js'
import { getHarnessSkillsPath } from '../../../src/skills/skill-linker.js'
import { getSkillsDir, resolveHome } from '../../../src/utils/path.js'
import type { FallbackTransactionIdentity, UpdatePlanItem } from '../../../src/update/types.js'

function item (): UpdatePlanItem {
  return {
    installationId: 'opencode:fallback',
    target: 'opencode',
    ownership: 'fallback',
    installed: true,
    source: { kind: 'fallback', bundleVersion: '1.0.0', executor: 'npm-exec' },
    version: { current: '1.0.0', latest: '1.0.1', status: 'update-available' },
    steps: [{ kind: 'command', description: 'refresh', command: { executable: 'npm', args: ['exec'], cwd: tmpdir(), timeoutMs: 1000 } }],
    rollbackSteps: [],
    requiresConfirmation: true,
  }
}

describe('fallback update strategy', () => {
  it('uses a private temporary cwd and propagates the child rollback result', async () => {
    let observedCwd = ''
    const result = await fallbackStrategy.execute(item(), {
      options: {},
      commandRunner: {
        run: async (command) => {
          observedCwd = command.cwd ?? ''
          assert.notEqual(observedCwd, tmpdir())
          // POSIX exposes the restrictive mode bits that the implementation
          // applies. Windows filesystems do not expose chmod(0700) through
          // stat(), so verify the private temp location there instead.
          if (process.platform !== 'win32') {
            assert.equal(statSync(observedCwd).mode & 0o777, 0o700)
          } else {
            assert.equal(path.dirname(observedCwd), path.resolve(tmpdir()))
          }
          return { exitCode: 1, stdout: '', stderr: 'refresh failed\nrollback: succeeded\n', timedOut: false }
        },
      },
    })

    assert.equal(result.status, 'failed')
    assert.deepEqual(result.rollback, { attempted: true, succeeded: true })
    assert.equal(existsSync(path.resolve(observedCwd)), false)
  })

  it('removes only the recorded manifest directory, never a path derived from command args', async () => {
    const recorded = mkdtempSync(path.join(tmpdir(), 'nsolid-plugin-recorded-'))
    const foreign = mkdtempSync(path.join(tmpdir(), 'nsolid-plugin-foreign-'))
    // The command references a foreign directory that this process did not
    // create; only the recorded temporary directory may be removed.
    const candidate = {
      ...item(),
      steps: [{ kind: 'command' as const, description: 'refresh', command: { executable: 'npm', args: ['--transaction', path.join(foreign, 'transaction.json')], cwd: tmpdir(), timeoutMs: 1000 } }],
      temporaryDirectories: [recorded],
    }

    const result = await fallbackStrategy.execute(candidate, {
      options: {},
      commandRunner: { run: async () => ({ exitCode: 1, stdout: '', stderr: 'refresh failed\n', timedOut: false, treeTerminated: true }) },
    })

    assert.equal(result.status, 'failed')
    assert.equal(existsSync(recorded), false)
    assert.equal(existsSync(foreign), true, 'a directory not created by this process must never be deleted')
  })

  it('reports a missing package executor as unsupported instead of failed planning', async () => {
    const previousPath = process.env.PATH
    const previousHome = process.env.HOME
    const previousUserProfile = process.env.USERPROFILE
    const home = mkdtempSync(path.join(tmpdir(), 'nsolid-plugin-fallback-plan-'))
    const skillPath = path.join(home, '.agents', 'skills', 'tracked')
    const trackingPath = path.join(home, '.agents', '.nodesource-installed.json')
    mkdirSync(skillPath, { recursive: true })
    writeFileSync(trackingPath, JSON.stringify({
      version: '1.0.0',
      installedAt: new Date().toISOString(),
      harness: 'opencode',
      skills: [{ name: 'tracked', path: skillPath, paths: { opencode: skillPath }, installedAt: new Date().toISOString(), harnesses: ['opencode'] }],
      mcpServers: [],
    }))
    process.env.PATH = ''
    process.env.HOME = home
    process.env.USERPROFILE = home
    try {
      const planned = await fallbackStrategy.plan({
        ...item(),
        source: { kind: 'fallback', bundleVersion: '1.0.0' },
        metadata: { trackedSkills: [{ name: 'tracked', path: skillPath }] },
      }, { options: {}, commandRunner: { run: async () => ({ exitCode: 0, stdout: '', stderr: '', timedOut: false }) } })
      assert.equal(planned.planningError, undefined)
      assert.equal(planned.source.kind, 'unsupported')
      assert.equal(planned.manualCommands?.length, 2)
      assert.ok(planned.manualCommands?.every((command) => command.includes(' update --harness opencode --yes') && !command.includes(' --transaction ')))
    } finally {
      if (previousPath === undefined) delete process.env.PATH
      else process.env.PATH = previousPath
      if (previousHome === undefined) delete process.env.HOME
      else process.env.HOME = previousHome
      if (previousUserProfile === undefined) delete process.env.USERPROFILE
      else process.env.USERPROFILE = previousUserProfile
      rmSync(home, { recursive: true, force: true })
    }
  })
})

describe('fallback strategy parent gate', () => {
  let home: string
  let previousHome: string | undefined
  let previousUserProfile: string | undefined

  beforeEach(() => {
    home = mkdtempSync(path.join(tmpdir(), 'nsolid-plugin-fallback-strategy-'))
    previousHome = process.env.HOME
    previousUserProfile = process.env.USERPROFILE
    process.env.HOME = home
    process.env.USERPROFILE = home
  })

  afterEach(() => {
    if (previousHome === undefined) delete process.env.HOME
    else process.env.HOME = previousHome
    if (previousUserProfile === undefined) delete process.env.USERPROFILE
    else process.env.USERPROFILE = previousUserProfile
    rmSync(home, { recursive: true, force: true })
  })

  interface GateFixture {
    identity: FallbackTransactionIdentity
    trackingPath: string
    skillPath: string
    trackedConfigPath?: string
    item: UpdatePlanItem
  }

  async function setupGateFixture (options: { trackedMcp?: boolean } = {}): Promise<GateFixture> {
    const skillPath = path.join(getSkillsDir(), 'tracked')
    mkdirSync(skillPath, { recursive: true })
    writeFileSync(path.join(skillPath, 'SKILL.md'), 'old tracked')
    const trackedConfigPath = path.join(home, 'custom', 'claude-tracked.json')
    const configPath = options.trackedMcp === true ? trackedConfigPath : resolveHome('~/.claude.json')
    if (options.trackedMcp === true) {
      mkdirSync(path.dirname(trackedConfigPath), { recursive: true })
      writeFileSync(trackedConfigPath, JSON.stringify({
        mcpServers: { 'alpha-console': { url: 'https://old.example.com/mcp', headers: { AUTH: 'x' } } },
      }, null, 2) + '\n')
    }
    const trackingPath = path.join(home, '.agents', '.nodesource-installed.json')
    mkdirSync(path.dirname(trackingPath), { recursive: true })
    await writeTrackingFile({
      version: '1.0.0',
      installedAt: new Date().toISOString(),
      harness: 'claude',
      bundleVersions: { claude: '1.0.0' },
      skills: [{ name: 'tracked', path: skillPath, paths: { claude: skillPath }, installedAt: new Date().toISOString(), harnesses: ['claude'] }],
      mcpServers: options.trackedMcp === true
        ? [{ name: 'alpha-console', configPath, harness: 'claude', configuredAt: new Date().toISOString(), fields: { url: valueDigest('https://old.example.com/mcp'), headers: valueDigest({ AUTH: 'x' }) } }]
        : [],
    })
    const identity: FallbackTransactionIdentity = {
      installationId: 'claude:fallback',
      harness: 'claude',
      trackingPath,
      trackingDigest: trackingDigest(trackingPath)!,
      nonce: randomUUID(),
      ownedSkillPaths: [skillPath],
      ownedLinkPaths: [path.join(getHarnessSkillsPath('claude'), 'tracked')],
      ownedMcpFields: options.trackedMcp === true
        ? [
            { configPath, server: 'alpha-console', field: 'url', expectedDigest: valueDigest('https://old.example.com/mcp') },
            { configPath, server: 'alpha-console', field: 'headers', expectedDigest: valueDigest({ AUTH: 'x' }) },
          ]
        : [],
      // The union of tracked MCP config paths and the adapter's canonical path,
      // exactly as the ownership matcher recomputes it.
      ownedMcpConfigPaths: [...new Set([configPath, resolveHome('~/.claude.json')].map((value) => path.resolve(value)))],
      approvedDestinationRoots: [getSkillsDir(), getHarnessSkillsPath('claude')].map((value) => path.resolve(value)),
    }
    const gateItem: UpdatePlanItem = {
      installationId: 'claude:fallback',
      target: 'claude',
      ownership: 'fallback',
      installed: true,
      source: { kind: 'fallback', bundleVersion: '1.0.0' },
      version: { current: '1.0.0', latest: '1.0.1', status: 'update-available' },
      steps: [{ kind: 'command', description: 'refresh', command: { executable: 'npm', args: ['exec'], cwd: tmpdir(), timeoutMs: 1000 } }],
      rollbackSteps: [],
      requiresConfirmation: true,
      fallbackTransaction: identity,
    }
    return { identity, trackingPath, skillPath, trackedConfigPath: options.trackedMcp === true ? trackedConfigPath : undefined, item: gateItem }
  }

  /** Simulate the verified child: it legitimately holds the nonce, so it may stage and apply through the journal API. */
  async function childStagesAndApplies (fixture: GateFixture, target: string, bytes: Buffer): Promise<void> {
    const journal = JSON.parse(readFileSync(fallbackJournalPath(fixture.identity.trackingPath), 'utf8'))
    const staged = await registerFallbackStage(journal, target, { bytes })
    await applyFallbackEntry(staged, target)
  }

  /** Simulate a lying child: it registers a stage for new bytes and claims the swap, but the live path keeps the old bytes. */
  async function childClaimsSwapWithoutApplying (fixture: GateFixture, target: string, bytes: Buffer): Promise<void> {
    const journalPath = fallbackJournalPath(fixture.identity.trackingPath)
    const stageDir = mkdtempSync(path.join(path.dirname(target), `.${path.basename(target)}.nsolid-stage-`))
    const stagePath = path.join(stageDir, 'payload')
    writeFileSync(stagePath, bytes)
    const stageDigest = await pathDigest(stagePath)
    const journal = JSON.parse(readFileSync(journalPath, 'utf8'))
    const entries = journal.entries.map((entry: { path: string }) => path.resolve(entry.path) === path.resolve(target)
      ? { ...entry, stage: stagePath, stageDigest, applied: true }
      : entry)
    writeFileSync(journalPath, JSON.stringify({ ...journal, entries }, null, 2) + '\n')
  }

  it('fails a no-op child with a parent rollback instead of reporting updated', async () => {
    const fixture = await setupGateFixture()
    const skillBytes = readFileSync(path.join(fixture.skillPath, 'SKILL.md'), 'utf8')

    const result = await fallbackStrategy.execute(fixture.item, {
      options: {},
      commandRunner: { run: async () => ({ exitCode: 0, stdout: 'refresh done\n', stderr: '', timedOut: false }) },
    })

    assert.equal(result.status, 'failed')
    assert.notEqual(result.status, 'updated')
    assert.deepEqual(result.rollback, { attempted: true, succeeded: true })
    assert.equal(result.error?.code, 'FALLBACK_VALIDATION_FAILED')
    assert.equal(readFileSync(path.join(fixture.skillPath, 'SKILL.md'), 'utf8'), skillBytes)
    const tracking = await readTrackingFile()
    assert.equal(tracking?.bundleVersions?.claude, '1.0.0')
  })

  it('fails a lying child whose claimed swap left the owned skill bytes stale', async () => {
    const fixture = await setupGateFixture()
    const newTracking = { ...(await readTrackingFile())!, bundleVersions: { claude: '1.0.1' } }

    const result = await fallbackStrategy.execute(fixture.item, {
      options: {},
      commandRunner: {
        run: async () => {
          // The child stages and applies the tracking update properly: the
          // bundle evidence check alone would trust it.
          await childStagesAndApplies(fixture, fixture.trackingPath, Buffer.from(JSON.stringify(newTracking, null, 2) + '\n'))
          // But the skill swap is only claimed: the journal records new bytes
          // while the live path still carries the old ones.
          await childClaimsSwapWithoutApplying(fixture, fixture.skillPath, Buffer.from('new tracked'))
          return { exitCode: 0, stdout: 'refresh done\n', stderr: '', timedOut: false }
        },
      },
    })

    assert.equal(result.status, 'failed')
    assert.deepEqual(result.rollback, { attempted: true, succeeded: true })
    assert.equal(result.error?.code, 'FALLBACK_VALIDATION_FAILED')
    assert.equal(readFileSync(path.join(fixture.skillPath, 'SKILL.md'), 'utf8'), 'old tracked')
    const tracking = await readTrackingFile()
    assert.equal(tracking?.bundleVersions?.claude, '1.0.0')
  })

  it('fails when tracked field evidence no longer matches the live MCP configuration', async () => {
    const fixture = await setupGateFixture({ trackedMcp: true })
    const originalConfig = readFileSync(fixture.trackedConfigPath!, 'utf8')
    const newTracking = { ...(await readTrackingFile())!, bundleVersions: { claude: '1.0.1' } }
    // A wrong record value inside the owned server: the child stages and
    // applies it together with the tracking evidence, so every journal-level
    // check passes and only the tracked-digest proof can catch it.
    const tamperedConfig = JSON.stringify({
      mcpServers: { 'alpha-console': { url: 'https://tampered.example.com/mcp', headers: { AUTH: 'x' } } },
    }, null, 2) + '\n'

    const result = await fallbackStrategy.execute(fixture.item, {
      options: {},
      commandRunner: {
        run: async () => {
          await childStagesAndApplies(fixture, fixture.trackedConfigPath!, Buffer.from(tamperedConfig))
          await childStagesAndApplies(fixture, fixture.trackingPath, Buffer.from(JSON.stringify(newTracking, null, 2) + '\n'))
          return { exitCode: 0, stdout: 'refresh done\n', stderr: '', timedOut: false }
        },
      },
    })

    assert.equal(result.status, 'failed')
    assert.deepEqual(result.rollback, { attempted: true, succeeded: true })
    assert.equal(result.error?.code, 'FALLBACK_VALIDATION_FAILED')
    assert.equal(readFileSync(fixture.trackedConfigPath!, 'utf8'), originalConfig)
    const tracking = await readTrackingFile()
    assert.equal(tracking?.bundleVersions?.claude, '1.0.0')
  })
})
