import { tarEntry } from '../../helpers/tar.js'
import { createCanonicalTempRoot } from '../../helpers/canonical-temp-root.js'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { gzipSync } from 'node:zlib'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { randomUUID } from 'node:crypto'
import { afterEach, beforeEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { fallbackStrategy } from '../../../src/update/strategies/fallback.js'
import { resolveExecutableIdentity } from '../../../src/update/command-runner.js'
import { applyFallbackEntry, claimFallbackJournalMutation, fallbackJournalPath, manifestDigestOf, pathDigest, pathKind, registerFallbackStage, setFallbackJournalTransitionLockTimeoutForTests, trackingDigest } from '../../../src/update/fallback-journal.js'
import { valueDigest } from '../../../src/update/mcp-lookup.js'
import { readTrackingFile, writeTrackingFile } from '../../../src/skills/skill-tracker.js'
import { getHarnessSkillsPath } from '../../../src/skills/skill-linker.js'
import { getSkillsDir, resolveHome } from '../../../src/utils/path.js'
import { FALLBACK_CHILD_RESULT_SCHEMA, recordContainmentDirectoryIdentity } from '../../../src/update/fallback-result-protocol.js'
import { FALLBACK_PROTOCOL_VERSION, type CommandResult, type FallbackTransactionIdentity, type UpdateInstallation, type UpdatePlanItem, type UpdateResult } from '../../../src/update/types.js'

function isolateHome (home: string): () => void {
  const previousHome = process.env.HOME
  const previousUserProfile = process.env.USERPROFILE
  process.env.HOME = home
  process.env.USERPROFILE = home
  return () => {
    if (previousHome === undefined) delete process.env.HOME
    else process.env.HOME = previousHome
    if (previousUserProfile === undefined) delete process.env.USERPROFILE
    else process.env.USERPROFILE = previousUserProfile
  }
}

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

async function pathEvidence (target: string) {
  const kind = await pathKind(target)
  const digest = kind === 'missing' ? undefined : await pathDigest(target)
  return { path: path.resolve(target), kind, digest }
}

describe('fallback update strategy', () => {
  it('rejects a mutable fallback plan without a transaction before creating a workspace or running a command', async () => {
    let commandRan = false
    const result = await fallbackStrategy.execute(item(), {
      options: {},
      commandRunner: {
        run: async () => {
          commandRan = true
          return { exitCode: 1, stdout: '', stderr: '', timedOut: false, treeTerminated: true }
        },
      },
    })

    assert.equal(result.status, 'failed')
    assert.equal(result.error?.code, 'INVALID_PLAN')
    assert.equal(commandRan, false)
    assert.equal(result.rollback, undefined)
  })

  it('reports a missing package executor as unsupported instead of failed planning', async () => {
    const previousPath = process.env.PATH
    const previousHome = process.env.HOME
    const previousUserProfile = process.env.USERPROFILE
    const home = createCanonicalTempRoot('nsolid-plugin-fallback-plan-')
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
      }, { options: {}, commandRunner: { run: async () => ({ exitCode: 0, stdout: '', stderr: '', timedOut: false, treeTerminated: true }) } })
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
  let restoreHome: () => void

  beforeEach(() => {
    home = createCanonicalTempRoot('nsolid-plugin-fallback-strategy-')
    restoreHome = isolateHome(home)
  })

  afterEach(() => {
    restoreHome()
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
      protocolVersion: FALLBACK_PROTOCOL_VERSION,
      nonce: randomUUID(),
      plannedMissingFrontiers: [],
      ownedSkills: [await pathEvidence(skillPath)],
      ownedLinks: [await pathEvidence(path.join(getHarnessSkillsPath('claude'), 'tracked'))],
      ownedMcpFields: options.trackedMcp === true
        ? [
            { configPath, server: 'alpha-console', field: 'url', expectedDigest: valueDigest('https://old.example.com/mcp') },
            { configPath, server: 'alpha-console', field: 'headers', expectedDigest: valueDigest({ AUTH: 'x' }) },
          ]
        : [],
      // The union of tracked MCP config paths and the adapter's canonical path,
      // exactly as the ownership matcher recomputes it, captured as whole-path
      // evidence: this is what authenticates MCP backups during rollback.
      ownedMcpConfigPaths: await Promise.all(
        [...new Set([configPath, resolveHome('~/.claude.json')].map((value) => path.resolve(value)))].map((value) => pathEvidence(value))
      ),
      bundleDestinations: [],
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

  /** Simulate the verified child: it recomputes the canonical manifest digest from the transaction manifest it verified, claims the mutating journal, and only then stages and applies through the journal API. */
  async function childStagesAndApplies (fixture: GateFixture, target: string, bytes: Buffer): Promise<void> {
    const claimed = await claimFallbackJournalMutation(fixture.identity, manifestDigestOf(fixture.identity))
    assert.ok(claimed, 'the simulated child must be able to claim the mutating journal')
    const staged = await registerFallbackStage(claimed, target, { bytes })
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
      commandRunner: { run: async () => ({ exitCode: 0, stdout: 'refresh done\n', stderr: '', timedOut: false, treeTerminated: true }) },
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
          return { exitCode: 0, stdout: 'refresh done\n', stderr: '', timedOut: false, treeTerminated: true }
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
          return { exitCode: 0, stdout: 'refresh done\n', stderr: '', timedOut: false, treeTerminated: true }
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

describe('fallback strategy structured child result', () => {
  let home: string
  let restoreHome: () => void

  beforeEach(() => {
    home = createCanonicalTempRoot('nsolid-plugin-fallback-result-')
    restoreHome = isolateHome(home)
  })

  afterEach(() => {
    restoreHome()
    rmSync(home, { recursive: true, force: true })
  })

  interface ResultFixture {
    identity: FallbackTransactionIdentity
    manifestDir: string
    manifestPath: string
    resultPath: string
    skillPath: string
    item: UpdatePlanItem
  }

  /** A journal-backed fallback item whose child command carries the transaction manifest and a result path. */
  async function setupResultFixture (): Promise<ResultFixture> {
    const skillPath = path.join(getSkillsDir(), 'tracked')
    mkdirSync(skillPath, { recursive: true })
    writeFileSync(path.join(skillPath, 'SKILL.md'), 'old tracked')
    const trackingPath = path.join(home, '.agents', '.nodesource-installed.json')
    mkdirSync(path.dirname(trackingPath), { recursive: true })
    await writeTrackingFile({
      version: '1.0.0',
      installedAt: new Date().toISOString(),
      harness: 'claude',
      bundleVersions: { claude: '1.0.0' },
      skills: [{ name: 'tracked', path: skillPath, paths: { claude: skillPath }, installedAt: new Date().toISOString(), harnesses: ['claude'] }],
      mcpServers: [],
    })
    const identity: FallbackTransactionIdentity = {
      installationId: 'claude:fallback',
      harness: 'claude',
      trackingPath,
      trackingDigest: trackingDigest(trackingPath)!,
      protocolVersion: FALLBACK_PROTOCOL_VERSION,
      nonce: randomUUID(),
      plannedMissingFrontiers: [],
      ownedSkills: [await pathEvidence(skillPath)],
      ownedLinks: [await pathEvidence(path.join(getHarnessSkillsPath('claude'), 'tracked'))],
      ownedMcpFields: [],
      // The adapter canonical path is usually absent on a fresh machine;
      // missing evidence (no digest) is a legitimate planned state.
      ownedMcpConfigPaths: [await pathEvidence(resolveHome('~/.claude.json'))],
      bundleDestinations: [],
      approvedDestinationRoots: [getSkillsDir(), getHarnessSkillsPath('claude')].map((value) => path.resolve(value)),
    }
    const manifestDir = mkdtempSync(path.join(home, 'nsolid-plugin-manifest-'))
    if (process.platform !== 'win32') chmodSync(manifestDir, 0o700)
    const manifestPath = path.join(manifestDir, 'transaction.json')
    writeFileSync(manifestPath, JSON.stringify(identity, null, 2) + '\n', { mode: 0o600 })
    const resultPath = path.join(manifestDir, 'result.json')
    const item: UpdatePlanItem = {
      installationId: 'claude:fallback',
      target: 'claude',
      ownership: 'fallback',
      installed: true,
      source: { kind: 'fallback', bundleVersion: '1.0.0' },
      version: { current: '1.0.0', latest: '1.0.1', status: 'update-available' },
      steps: [{
        kind: 'command',
        description: 'refresh',
        command: {
          executable: 'npm',
          args: ['exec', '--yes', '--package=x.tgz', '--', 'nsolid-plugin-refresh-owned', '--transaction', manifestPath, '--result', resultPath],
          cwd: tmpdir(),
          timeoutMs: 1000,
        },
      }],
      rollbackSteps: [],
      requiresConfirmation: true,
      fallbackTransaction: identity,
      temporaryDirectories: [manifestDir],
      resultContainment: [await recordContainmentDirectoryIdentity(manifestDir)],
    }
    return { identity, manifestDir, manifestPath, resultPath, skillPath, item }
  }

  interface ChildContext {
    resultPath?: string
    manifestPath?: string
    workspace?: string
  }

  /** Simulate the real child: it reads the nonce from its own manifest and publishes the structured envelope. */
  function childWritesEnvelope (build: (nonce: string) => Record<string, unknown>): (child: ChildContext) => CommandResult {
    return (child) => {
      if (child.resultPath && child.manifestPath) {
        const nonce = (JSON.parse(readFileSync(child.manifestPath, 'utf8')) as { nonce: string }).nonce
        writeFileSync(child.resultPath, JSON.stringify(build(nonce)), { mode: 0o600 })
      }
      return { exitCode: 1, stdout: '', stderr: 'Fallback refresh failed\nrollback: not-attempted\n', timedOut: false, treeTerminated: true }
    }
  }

  async function execute (fixture: ResultFixture, runner: (child: ChildContext) => CommandResult) {
    return fallbackStrategy.execute(fixture.item, {
      options: {},
      commandRunner: {
        run: async (command) => {
          const args = command.args ?? []
          const at = (flag: string): string | undefined => {
            const index = args.indexOf(flag)
            return index >= 0 ? args[index + 1] : undefined
          }
          return runner({ resultPath: at('--result'), manifestPath: at('--transaction'), workspace: command.cwd })
        }
      },
    })
  }

  interface RecoveryScenario {
    name: string
    expectedCode: string
    expectedRollback: UpdateResult['rollback']
    run: (fixture: ResultFixture) => Promise<UpdateResult>
  }

  const recoveryScenarios: RecoveryScenario[] = [
    {
      name: 'unconfirmed termination',
      expectedCode: 'FALLBACK_TREE_TERMINATION_UNCONFIRMED',
      expectedRollback: { attempted: false },
      run: (fixture) => execute(fixture, (child) => {
        const envelope = childWritesEnvelope((nonce) => ({ schema: FALLBACK_CHILD_RESULT_SCHEMA, nonce, code: 'MCP_RECONCILIATION_REQUIRED' }))(child)
        return { ...envelope, timedOut: true, treeTerminated: false }
      }),
    },
    {
      name: 'missing executable',
      expectedCode: 'MISSING_EXECUTABLE',
      expectedRollback: { attempted: true, succeeded: true },
      run: (fixture) => execute(fixture, (child) => {
        const envelope = childWritesEnvelope((nonce) => ({ schema: FALLBACK_CHILD_RESULT_SCHEMA, nonce, code: 'MCP_RECONCILIATION_REQUIRED' }))(child)
        return { ...envelope, spawnErrorCode: 'ENOENT', treeTerminated: true }
      }),
    },
    {
      name: 'confirmed timeout',
      expectedCode: 'FALLBACK_COMMAND_TIMEOUT',
      expectedRollback: { attempted: true, succeeded: true },
      run: (fixture) => execute(fixture, (child) => {
        const envelope = childWritesEnvelope((nonce) => ({ schema: FALLBACK_CHILD_RESULT_SCHEMA, nonce, code: 'MCP_RECONCILIATION_REQUIRED' }))(child)
        return { ...envelope, timedOut: true, treeTerminated: true }
      }),
    },
    {
      name: 'unproven state',
      expectedCode: 'FALLBACK_STATE_UNPROVEN',
      expectedRollback: { attempted: true, succeeded: false },
      run: (fixture) => execute(fixture, (child) => {
        const journal = JSON.parse(readFileSync(fallbackJournalPath(fixture.identity.trackingPath), 'utf8')) as { entries: Array<{ backup?: string }> }
        const backup = journal.entries.find((entry) => entry.backup)?.backup
        assert.ok(backup, 'the scenario journal must hold at least one backup')
        if (statSync(backup).isDirectory()) writeFileSync(path.join(backup, '__tampered__'), 'tampered')
        else writeFileSync(backup, 'tampered')
        return childWritesEnvelope((nonce) => ({ schema: FALLBACK_CHILD_RESULT_SCHEMA, nonce, code: 'MCP_RECONCILIATION_REQUIRED' }))(child)
      }),
    },
    {
      name: 'incomplete rollback',
      expectedCode: 'FALLBACK_ROLLBACK_FAILED',
      expectedRollback: { attempted: true, succeeded: false },
      run: (fixture) => execute(fixture, (child) => {
        // Replacing only the skill parent leaves the tracking file available;
        // the authenticated restore cannot traverse this foreign file and
        // therefore returns an incomplete (not unproven) outcome.
        const skillParent = path.dirname(fixture.skillPath)
        rmSync(skillParent, { recursive: true, force: true })
        writeFileSync(skillParent, 'foreign parent')
        assert.equal(statSync(skillParent).isFile(), true)
        return childWritesEnvelope((nonce) => ({ schema: FALLBACK_CHILD_RESULT_SCHEMA, nonce, code: 'MCP_RECONCILIATION_REQUIRED' }))(child)
      }),
    },
    {
      name: 'validated child error',
      expectedCode: 'MCP_RECONCILIATION_REQUIRED',
      expectedRollback: { attempted: true, succeeded: true },
      run: (fixture) => execute(fixture, childWritesEnvelope((nonce) => ({ schema: FALLBACK_CHILD_RESULT_SCHEMA, nonce, code: 'MCP_RECONCILIATION_REQUIRED' }))),
    },
  ]

  for (const scenario of recoveryScenarios) {
    it(`projects the ${scenario.name} recovery outcome with the required precedence`, async () => {
      const fixture = await setupResultFixture()
      try {
        const result = await scenario.run(fixture)
        assert.equal(result.error?.code, scenario.expectedCode)
        assert.deepEqual(result.rollback, scenario.expectedRollback)
      } finally {
        rmSync(fixture.manifestDir, { recursive: true, force: true })
      }
    })
  }

  it('uses a private temporary cwd and parent rollback with a real transaction', async () => {
    const fixture = await setupResultFixture()
    let observedCwd = ''
    const result = await fallbackStrategy.execute(fixture.item, {
      options: {},
      commandRunner: {
        run: async (command) => {
          observedCwd = command.cwd ?? ''
          assert.notEqual(observedCwd, tmpdir())
          if (process.platform !== 'win32') {
            assert.equal(statSync(observedCwd).mode & 0o777, 0o700)
          } else {
            assert.equal(path.dirname(observedCwd), path.resolve(tmpdir()))
          }
          return { exitCode: 1, stdout: '', stderr: 'refresh failed\nrollback: succeeded\n', timedOut: false, treeTerminated: true }
        },
      },
    })

    assert.equal(result.status, 'failed')
    assert.deepEqual(result.rollback, { attempted: true, succeeded: true })
    assert.equal(existsSync(path.resolve(observedCwd)), false)
  })

  it('never removes a path derived from command args during strategy execution', async () => {
    const fixture = await setupResultFixture()
    const foreign = mkdtempSync(path.join(tmpdir(), 'nsolid-plugin-foreign-'))
    const commandStep = fixture.item.steps.find((entry) => entry.kind === 'command')
    assert.ok(commandStep !== undefined && commandStep.kind === 'command')
    fixture.item.steps = [{
      ...commandStep,
      command: { ...commandStep.command, args: ['--transaction', path.join(foreign, 'transaction.json')] },
    }]

    const result = await execute(fixture, () => ({ exitCode: 1, stdout: '', stderr: 'refresh failed\n', timedOut: false, treeTerminated: true }))

    assert.equal(result.status, 'failed')
    assert.equal(existsSync(fixture.manifestDir), true, 'the strategy must not release planning temporaries owned by the coordinator')
    assert.equal(existsSync(foreign), true, 'a directory not created by this process must never be deleted')
    rmSync(foreign, { recursive: true, force: true })
  })

  it('surfaces the child MCP_RECONCILIATION_REQUIRED code instead of the generic fallback failure', async () => {
    const fixture = await setupResultFixture()
    const writeEnvelope = childWritesEnvelope((nonce) => ({
      schema: FALLBACK_CHILD_RESULT_SCHEMA,
      nonce,
      code: 'MCP_RECONCILIATION_REQUIRED',
      rollback: { attempted: false },
    }))
    const result = await execute(fixture, (child) => ({ ...writeEnvelope(child), treeTerminated: true }))

    assert.equal(result.status, 'failed')
    assert.equal(result.error?.code, 'MCP_RECONCILIATION_REQUIRED')
    assert.ok(result.error?.message.includes('nsolid-plugin setup --harness claude'), 'the approved recovery guidance must name the planned harness, not a hardcoded one')
    // The parent journal exists, so its verified recovery outcome — not the
    // child envelope claim — is the public rollback state.
    assert.deepEqual(result.rollback, { attempted: true, succeeded: true })
    assert.equal(readFileSync(path.join(fixture.skillPath, 'SKILL.md'), 'utf8'), 'old tracked', 'the reconciliation failure must not mutate owned state')
    assert.equal(existsSync(fixture.resultPath), false, 'the structured result must be removed during normal workspace cleanup')
    assert.equal(existsSync(fixture.manifestDir), true, 'planning temporaries remain for coordinator-owned cleanup')
    const serialized = JSON.stringify(result)
    const parsed = JSON.parse(serialized) as UpdateResult
    assert.deepEqual(JSON.parse(JSON.stringify(parsed)), parsed, 'the parent result must remain exactly one stable JSON document')
  })

  for (const exitCode of [0, 1]) {
    it(`prioritizes unconfirmed termination over a valid child envelope without timeout (exit: ${exitCode})`, async () => {
      const fixture = await setupResultFixture()
      const journalPath = fallbackJournalPath(fixture.identity.trackingPath)
      let journalBefore = ''
      const result = await execute(fixture, (child) => {
        journalBefore = readFileSync(journalPath, 'utf8')
        writeFileSync(path.join(fixture.skillPath, 'SKILL.md'), 'child mutation must remain')
        const envelope = childWritesEnvelope((nonce) => ({
          schema: FALLBACK_CHILD_RESULT_SCHEMA,
          nonce,
          code: 'MCP_RECONCILIATION_REQUIRED',
          rollback: { attempted: true, succeeded: true },
        }))(child)
        return { ...envelope, exitCode, treeTerminated: false, stdout: 'RAW-CHILD-SECRET', stderr: 'RAW-CHILD-SECRET\nrollback: succeeded\n' }
      })

      assert.equal(result.status, 'failed')
      assert.equal(result.error?.code, 'FALLBACK_TREE_TERMINATION_UNCONFIRMED')
      assert.deepEqual(result.rollback, { attempted: false })
      assert.equal(readFileSync(path.join(fixture.skillPath, 'SKILL.md'), 'utf8'), 'child mutation must remain')
      assert.equal(readFileSync(journalPath, 'utf8'), journalBefore, 'deferral must not reclaim, restore or dispose the journal')
      const journal = JSON.parse(journalBefore) as { snapshotDirectory: string }
      assert.equal(existsSync(journal.snapshotDirectory), true)
      assert.equal(existsSync(fixture.manifestDir), true)
      assert.ok(!JSON.stringify(result).includes('RAW-CHILD-SECRET'))
    })
  }

  it('never publishes child-controlled text carried inside the envelope', async () => {
    const fixture = await setupResultFixture()
    const result = await execute(fixture, childWritesEnvelope((nonce) => ({
      schema: FALLBACK_CHILD_RESULT_SCHEMA,
      nonce,
      code: 'MCP_RECONCILIATION_REQUIRED',
      rollback: { attempted: false },
      message: 'LEAKED CHILD TEXT npm notice registry https://registry.npmjs.org/SECRET',
    })))

    assert.equal(result.error?.code, 'MCP_RECONCILIATION_REQUIRED')
    assert.ok(!result.error?.message.includes('LEAKED'), 'arbitrary child text must never reach the public message')
    assert.ok(!result.error?.message.includes('SECRET'), 'arbitrary child text must never reach the public message')
    assert.ok(result.error?.message.includes('nsolid-plugin setup --harness claude'))
  })

  it('keeps raw child stdout/stderr out of the public error and trusts the envelope over output parsing', async () => {
    const fixture = await setupResultFixture()
    const result = await execute(fixture, (child) => {
      const quiet = childWritesEnvelope((nonce) => ({ schema: FALLBACK_CHILD_RESULT_SCHEMA, nonce, code: 'FALLBACK_MCP_DRIFT', rollback: { attempted: false } }))(child)
      return {
        ...quiet,
        stdout: 'npm notice New version available\nnpm ERR code E404\nhttps://registry.npmjs.org/nsolid-plugin/-/nsolid-plugin-1.0.1.tgz',
        stderr: 'npm error TOKEN=SECRET-VALUE\nrollback: succeeded\n',
      }
    })

    assert.equal(result.error?.code, 'FALLBACK_MCP_DRIFT')
    assert.ok(!result.error?.message.includes('registry.npmjs.org'))
    assert.ok(!result.error?.message.includes('SECRET-VALUE'))
    assert.ok(!result.error?.message.includes('npm error'))
  })

  it('fails safe when the child publishes no result file at all', async () => {
    const fixture = await setupResultFixture()
    const result = await execute(fixture, () => ({ exitCode: 1, stdout: '', stderr: 'refresh failed\n', timedOut: false, treeTerminated: true }))
    assert.equal(result.error?.code, 'FALLBACK_COMMAND_FAILED')
    assert.equal(result.error?.message, 'Fallback refresh command failed')
  })

  it('fails safe when the result file is malformed JSON', async () => {
    const fixture = await setupResultFixture()
    const result = await execute(fixture, (child) => {
      if (child.resultPath) writeFileSync(child.resultPath, 'not json', { mode: 0o600 })
      return { exitCode: 1, stdout: '', stderr: 'refresh failed\n', timedOut: false, treeTerminated: true }
    })
    assert.equal(result.error?.code, 'FALLBACK_COMMAND_FAILED')
  })

  for (const [name, invalidFields] of [
    ['oversized result', { pad: 'x'.repeat(8192) }],
    ['different transaction nonce', { nonce: 'stale-transaction-nonce' }],
    ['unknown child code', { code: 'TOTALLY_UNKNOWN_CODE' }],
    ['unsafe child code shape', { code: 'bad code' }],
    ['schema-version skew', { schema: 99 }],
    ['malformed rollback shape', { rollback: { attempted: 1 } }],
  ] as const) {
    it(`fails safe on ${name}`, async () => {
      const fixture = await setupResultFixture()
      const result = await execute(fixture, childWritesEnvelope((nonce) => ({ schema: FALLBACK_CHILD_RESULT_SCHEMA, nonce, code: 'MCP_RECONCILIATION_REQUIRED', ...invalidFields })))
      assert.equal(result.error?.code, 'FALLBACK_COMMAND_FAILED')
    })
  }

  it('fails safe when the result path is a symlink', async () => {
    const fixture = await setupResultFixture()
    const realDir = mkdtempSync(path.join(tmpdir(), 'nsolid-plugin-result-real-'))
    const realTarget = path.join(realDir, 'real.json')
    const nonce = fixture.identity.nonce
    writeFileSync(realTarget, JSON.stringify({ schema: FALLBACK_CHILD_RESULT_SCHEMA, nonce, code: 'MCP_RECONCILIATION_REQUIRED' }), { mode: 0o600 })
    rmSync(fixture.resultPath, { force: true })
    symlinkSync(realTarget, fixture.resultPath)
    const result = await execute(fixture, () => ({ exitCode: 1, stdout: '', stderr: 'refresh failed\n', timedOut: false, treeTerminated: true }))
    assert.equal(result.error?.code, 'FALLBACK_COMMAND_FAILED')
    rmSync(realDir, { recursive: true, force: true })
  })

  it('refuses to execute when a recorded containment directory was swapped', async () => {
    const fixture = await setupResultFixture()
    const replacement = mkdtempSync(path.join(tmpdir(), 'nsolid-plugin-result-swap-'))
    try {
      rmSync(fixture.manifestDir, { recursive: true, force: true })
      symlinkSync(replacement, fixture.manifestDir)
      let ran = false
      const result = await execute(fixture, () => {
        ran = true
        return { exitCode: 0, stdout: '', stderr: '', timedOut: false, treeTerminated: true }
      })
      assert.equal(result.error?.code, 'FALLBACK_COMMAND_FAILED', 'a swapped transaction workspace must fail closed')
      assert.equal(ran, false, 'the child command must never run against a swapped workspace')
    } finally {
      rmSync(fixture.manifestDir, { force: true })
      rmSync(replacement, { recursive: true, force: true })
    }
  })

  it('never replays a prior envelope when the same plan item executes twice', async () => {
    const fixture = await setupResultFixture()
    const observedResultPaths: string[] = []
    let blockedCommandRan = false
    // First execution: an unconfirmed-termination timeout preserves the
    // transaction workspace AND the journal for manual recovery.
    const first = await execute(fixture, (child) => {
      if (child.resultPath !== undefined) observedResultPaths.push(child.resultPath)
      const quiet = childWritesEnvelope((nonce) => ({ schema: FALLBACK_CHILD_RESULT_SCHEMA, nonce, code: 'MCP_RECONCILIATION_REQUIRED' }))(child)
      return { ...quiet, timedOut: true, treeTerminated: false }
    })
    assert.equal(first.error?.code, 'FALLBACK_TREE_TERMINATION_UNCONFIRMED')
    // Second execution of the SAME item: the preserved journal is a pending
    // next-run recovery state. Recovery never restores or commits on its own,
    // so it must block the run before any command executes.
    const second = await execute(fixture, (child) => {
      blockedCommandRan = true
      if (child.resultPath !== undefined) observedResultPaths.push(child.resultPath)
      return { exitCode: 1, stdout: '', stderr: 'refresh failed\n', timedOut: false, treeTerminated: true }
    })
    assert.equal(second.error?.code, 'FALLBACK_RECOVERY_PENDING', 'a preserved journal must block the next run as pending')
    assert.equal(blockedCommandRan, false, 'the pending-blocked run must never execute the child command')
    // Direct strategy execution leaves planning-owned state for the
    // coordinator; a coordinator run releases it after this result.
    assert.equal(existsSync(fixture.manifestDir), true, 'direct strategy execution must not own planning cleanup')
    // The user applies the prescribed manual remedy (remove the pending
    // journal and its snapshot). A retry then RE-PLANS: a fresh fixture means
    // a fresh manifest, fresh nonce, and fresh per-execution result location,
    // so the first envelope (already gone with its workspace) could never
    // replay even if some copy survived.
    const pendingJournalPath = fallbackJournalPath(fixture.identity.trackingPath)
    const snapshotDirectory = (JSON.parse(readFileSync(pendingJournalPath, 'utf8')) as { snapshotDirectory: string }).snapshotDirectory
    rmSync(pendingJournalPath, { force: true })
    rmSync(snapshotDirectory, { recursive: true, force: true })
    const rePlannedFixture = await setupResultFixture()
    const third = await execute(rePlannedFixture, (child) => {
      if (child.resultPath !== undefined) observedResultPaths.push(child.resultPath)
      return { exitCode: 1, stdout: '', stderr: 'refresh failed\n', timedOut: false, treeTerminated: true }
    })
    assert.equal(third.error?.code, 'FALLBACK_COMMAND_FAILED', 'the post-remedy execution must not replay the first envelope')
    assert.equal(observedResultPaths.length, 2, 'both executed runs must receive an explicit result path')
    assert.notEqual(observedResultPaths[0], observedResultPaths[1], 'each execution must use a fresh result location')
  })

  it('fails safe when the planned result path escapes the parent-owned workspace', async () => {
    const fixture = await setupResultFixture()
    const foreignDir = mkdtempSync(path.join(tmpdir(), 'nsolid-plugin-result-foreign-'))
    const foreignResult = path.join(foreignDir, 'result.json')
    const nonce = fixture.identity.nonce
    writeFileSync(foreignResult, JSON.stringify({ schema: FALLBACK_CHILD_RESULT_SCHEMA, nonce, code: 'MCP_RECONCILIATION_REQUIRED' }), { mode: 0o600 })
    fixture.item.steps = [{
      kind: 'command',
      description: 'refresh',
      command: {
        executable: 'npm',
        args: ['exec', '--yes', '--package=x.tgz', '--', 'nsolid-plugin-refresh-owned', '--transaction', fixture.manifestPath, '--result', foreignResult],
        cwd: tmpdir(),
        timeoutMs: 1000,
      },
    }]
    const result = await execute(fixture, () => ({ exitCode: 1, stdout: '', stderr: 'refresh failed\n', timedOut: false, treeTerminated: true }))
    assert.equal(result.error?.code, 'FALLBACK_COMMAND_FAILED', 'a result outside the parent-owned workspace must never be trusted')
    // The parent must also never DELETE a file it did not create: the stale-
    // result cleanup is bound to the recorded containment identity.
    assert.equal(existsSync(foreignResult), true, 'the escape attempt must leave the foreign file untouched')
    rmSync(foreignDir, { recursive: true, force: true })
  })

  it('rejects a mutable fallback plan without a transaction before invoking the child', async () => {
    const fixture = await setupResultFixture()
    try {
      delete (fixture.item as { fallbackTransaction?: unknown }).fallbackTransaction
      let commandRan = false
      const result = await fallbackStrategy.execute(fixture.item, {
        options: {},
        commandRunner: {
          run: async () => {
            commandRan = true
            return { exitCode: 1, stdout: '', stderr: '', timedOut: false, treeTerminated: true }
          },
        },
      })
      assert.equal(result.error?.code, 'INVALID_PLAN')
      assert.equal(commandRan, false)
      assert.equal(existsSync(fixture.manifestDir), true, 'an invalid plan must not clean up planning-owned state')
    } finally {
      rmSync(fixture.manifestDir, { recursive: true, force: true })
    }
  })

  it('lets parent journal recovery stay authoritative over the child rollback claim', async () => {
    // The child claims its rollback FAILED, but the parent journal recovers
    // successfully: the public state must follow the verified parent outcome,
    // so the structured child code (not FALLBACK_ROLLBACK_FAILED) is reported.
    {
      const fixture = await setupResultFixture()
      const result = await execute(fixture, childWritesEnvelope((nonce) => ({ schema: FALLBACK_CHILD_RESULT_SCHEMA, nonce, code: 'MCP_RECONCILIATION_REQUIRED', rollback: { attempted: true, succeeded: false } })))
      assert.equal(result.error?.code, 'MCP_RECONCILIATION_REQUIRED')
      assert.deepEqual(result.rollback, { attempted: true, succeeded: true })
    }
    // The child claims its rollback SUCCEEDED, but parent recovery verifiably
    // fails (a tampered backup aborts the restore preflight): the public state
    // must report the rollback failure the parent actually observed.
    {
      const fixture = await setupResultFixture()
      const result = await execute(fixture, (child) => {
        const outcome = childWritesEnvelope((nonce) => ({ schema: FALLBACK_CHILD_RESULT_SCHEMA, nonce, code: 'MCP_RECONCILIATION_REQUIRED', rollback: { attempted: true, succeeded: true } }))(child)
        // Between the child failure and parent recovery, corrupt one journaled
        // backup so the parent restore preflight provably fails.
        const journal = JSON.parse(readFileSync(fallbackJournalPath(fixture.identity.trackingPath), 'utf8')) as { entries: Array<{ backup?: string }> }
        const backup = journal.entries.find((entry) => entry.backup)?.backup
        assert.ok(backup, 'the fixture journal must hold at least one backup')
        if (statSync(backup).isDirectory()) writeFileSync(path.join(backup, '__tampered__'), 'tampered')
        else writeFileSync(backup, 'tampered')
        return outcome
      })
      assert.equal(result.error?.code, 'FALLBACK_STATE_UNPROVEN')
      assert.equal(result.error?.message, 'The fallback transaction could not prove the state of its owned files, so the automatic rollback was refused. Its journal, snapshot, and preserved artifacts were left untouched for manual recovery.')
      assert.deepEqual(result.rollback, { attempted: true, succeeded: false })
    }
  })

  it('keeps FALLBACK_COMMAND_TIMEOUT precedence when the confirmed timeout carries a structured result', async () => {
    const fixture = await setupResultFixture()
    const result = await execute(fixture, (child) => {
      const quiet = childWritesEnvelope((nonce) => ({ schema: FALLBACK_CHILD_RESULT_SCHEMA, nonce, code: 'MCP_RECONCILIATION_REQUIRED' }))(child)
      return { ...quiet, timedOut: true, treeTerminated: true }
    })
    assert.equal(result.error?.code, 'FALLBACK_COMMAND_TIMEOUT')
    // The confirmed timeout must own both the code AND its message; the
    // structured message must not pair with the timeout code.
    assert.equal(result.error?.message, 'Fallback refresh command timed out')
  })

  it('never replays a stale envelope left at the planned path by a prior attempt', async () => {
    const fixture = await setupResultFixture()
    // A prior attempt left a valid envelope at the planned result path. The
    // parent now points each execution at a FRESH result location, so the
    // stale file is never read regardless of its nonce.
    writeFileSync(fixture.resultPath, JSON.stringify({ schema: FALLBACK_CHILD_RESULT_SCHEMA, nonce: fixture.identity.nonce, code: 'MCP_RECONCILIATION_REQUIRED', rollback: { attempted: false } }), { mode: 0o600 })
    const result = await execute(fixture, () => ({ exitCode: 1, stdout: '', stderr: 'refresh failed\n', timedOut: false, treeTerminated: true }))
    assert.equal(result.error?.code, 'FALLBACK_COMMAND_FAILED', 'the stale envelope must not surface its structured code')
    // (The planned-path file may still be removed as part of the parent-owned
    // manifest workspace cleanup; the fresh-path design means it was never
    // READ, which is the property under test.)
  })

  it('keeps unconfirmed tree termination precedence and preserves recovery artifacts', async () => {
    const fixture = await setupResultFixture()
    const result = await execute(fixture, (child) => {
      const quiet = childWritesEnvelope((nonce) => ({ schema: FALLBACK_CHILD_RESULT_SCHEMA, nonce, code: 'MCP_RECONCILIATION_REQUIRED' }))(child)
      return { ...quiet, timedOut: true, treeTerminated: false }
    })
    assert.equal(result.error?.code, 'FALLBACK_TREE_TERMINATION_UNCONFIRMED')
    assert.equal(existsSync(fixture.manifestDir), true, 'recovery artifacts must be preserved for the unconfirmed case')
    rmSync(fixture.manifestDir, { recursive: true, force: true })
  })

  it('keeps MISSING_EXECUTABLE precedence when the spawn fails with a structured result present', async () => {
    const fixture = await setupResultFixture()
    const result = await execute(fixture, (child) => {
      const quiet = childWritesEnvelope((nonce) => ({ schema: FALLBACK_CHILD_RESULT_SCHEMA, nonce, code: 'MCP_RECONCILIATION_REQUIRED' }))(child)
      return { ...quiet, spawnErrorCode: 'ENOENT' }
    })
    assert.equal(result.error?.code, 'MISSING_EXECUTABLE')
  })

  it('maps a validated FALLBACK_PROTOCOL_UNSUPPORTED pre-mutation rejection to a no-rollback failure and preserves its verified journal state', async () => {
    const fixture = await setupResultFixture()
    const journalPath = fallbackJournalPath(fixture.identity.trackingPath)
    const result = await execute(fixture, childWritesEnvelope((nonce) => ({
      schema: FALLBACK_CHILD_RESULT_SCHEMA,
      nonce,
      code: 'FALLBACK_PROTOCOL_UNSUPPORTED',
      rollback: { attempted: false },
    })))

    assert.equal(result.status, 'failed')
    assert.equal(result.error?.code, 'FALLBACK_PROTOCOL_UNSUPPORTED')
    assert.equal(result.error?.message, 'This fallback update was planned by an incompatible nsolid-plugin version. Update nsolid-plugin manually (for example with your package manager) and retry the update.')
    assert.deepEqual(result.rollback, { attempted: false }, 'a pre-mutation child rejection must never report a parent rollback')
    assert.equal(readFileSync(path.join(fixture.skillPath, 'SKILL.md'), 'utf8'), 'old tracked', 'a pre-mutation rejection must not mutate owned state')
    // The parent proved, from its own in-memory manifest, that nothing was
    // mutated. A disposal-only journal operation does not exist yet, so the
    // journal and snapshot remain preserved for deliberate manual resolution.
    assert.equal(existsSync(journalPath), true, 'the verified pre-mutation journal must be preserved')
    const snapshotDirectory = (JSON.parse(readFileSync(journalPath, 'utf8')) as { snapshotDirectory: string }).snapshotDirectory
    assert.equal(existsSync(snapshotDirectory), true, 'the verified pre-mutation snapshot must be preserved')
    assert.deepEqual(result.preservedArtifacts, [journalPath, snapshotDirectory].sort())
    assert.equal(result.preservedPaths, undefined)
  })

  it('preserves an owned skill changed concurrently after original-state verification', async () => {
    const fixture = await setupResultFixture()
    const journalPath = fallbackJournalPath(fixture.identity.trackingPath)
    const originalTrackingDigest = fixture.identity.trackingDigest
    let trackingDigestRead = false
    let concurrentChangeApplied = false
    let workspace = ''
    let resultDirectory = ''
    let snapshotDirectory = ''

    try {
      const result = await execute(fixture, (child) => {
        workspace = child.workspace ?? ''
        resultDirectory = child.resultPath === undefined ? '' : path.dirname(child.resultPath)
        // Install the seam only after beginFallbackJournal has completed. The
        // final tracking-digest read in liveStateMatchesPlannedEvidence queues
        // a separate writer after that async verifier resolves true but before
        // its caller can start any disposal operation. This is deterministic
        // event-loop concurrency, not a pre-verification drift.
        Object.defineProperty(fixture.identity, 'trackingDigest', {
          configurable: true,
          enumerable: true,
          get: () => {
            if (!trackingDigestRead) {
              trackingDigestRead = true
              queueMicrotask(() => {
                concurrentChangeApplied = true
                writeFileSync(path.join(fixture.skillPath, 'SKILL.md'), 'concurrent owned edit')
              })
            }
            return originalTrackingDigest
          },
        })
        return childWritesEnvelope((nonce) => ({
          schema: FALLBACK_CHILD_RESULT_SCHEMA,
          nonce,
          code: 'FALLBACK_PROTOCOL_UNSUPPORTED',
          rollback: { attempted: false },
        }))(child)
      })

      assert.equal(concurrentChangeApplied, true)
      assert.equal(result.error?.code, 'FALLBACK_PROTOCOL_UNSUPPORTED')
      assert.deepEqual(result.rollback, { attempted: false })
      assert.equal(readFileSync(path.join(fixture.skillPath, 'SKILL.md'), 'utf8'), 'concurrent owned edit', 'a concurrent edit after verification must never be restored over')
      assert.equal(existsSync(journalPath), true, 'the journal must remain for manual recovery')
      snapshotDirectory = (JSON.parse(readFileSync(journalPath, 'utf8')) as { snapshotDirectory: string }).snapshotDirectory
      assert.equal(existsSync(snapshotDirectory), true, 'the snapshot must remain for manual recovery')
      assert.ok((result.preservedArtifacts ?? []).includes(journalPath))
      assert.ok((result.preservedArtifacts ?? []).includes(snapshotDirectory))
      assert.equal(existsSync(workspace), true, 'execution resources must remain paired with preserved recovery state')
      assert.equal(existsSync(resultDirectory), true, 'result resources must remain paired with preserved recovery state')
    } finally {
      Object.defineProperty(fixture.identity, 'trackingDigest', {
        configurable: true,
        enumerable: true,
        writable: true,
        value: originalTrackingDigest,
      })
      if (workspace !== '') rmSync(workspace, { recursive: true, force: true })
      if (resultDirectory !== '') rmSync(resultDirectory, { recursive: true, force: true })
      if (snapshotDirectory !== '') rmSync(snapshotDirectory, { recursive: true, force: true })
      rmSync(journalPath, { force: true })
      rmSync(fixture.manifestDir, { recursive: true, force: true })
    }
  })

  it('preserves its pre-mutation journal when a protocol rejection cannot be proven pre-mutation', async () => {
    const fixture = await setupResultFixture()
    const journalPath = fallbackJournalPath(fixture.identity.trackingPath)
    const result = await execute(fixture, childWritesEnvelope((nonce) => {
      // Hostile drift during the transaction window: the live owned state no
      // longer matches the planned evidence, so the parent can NOT prove the
      // rejection was pre-mutation and must fail closed.
      writeFileSync(path.join(fixture.skillPath, 'SKILL.md'), 'mutated during the window')
      return { schema: FALLBACK_CHILD_RESULT_SCHEMA, nonce, code: 'FALLBACK_PROTOCOL_UNSUPPORTED', rollback: { attempted: false } }
    }))

    assert.equal(result.error?.code, 'FALLBACK_PROTOCOL_UNSUPPORTED')
    assert.deepEqual(result.rollback, { attempted: false })
    // The mutated live bytes are never rolled back on this path; the journal
    // and snapshot stay preserved and are reported for manual recovery.
    assert.equal(readFileSync(path.join(fixture.skillPath, 'SKILL.md'), 'utf8'), 'mutated during the window', 'an unprovable rejection must never authorize a restore')
    assert.equal(existsSync(journalPath), true, 'the unprovable journal must be preserved, not disposed')
    assert.ok((result.preservedArtifacts ?? []).includes(journalPath), 'the preserved journal must be reported')
  })

  it('treats a child-disposed parent journal as unproven while keeping validated child preservation reporting', async () => {
    const fixture = await setupResultFixture()
    const childArtifact = path.join(home, 'preserved', 'stage-container')
    const childPath = path.join(home, 'preserved', 'live-path')
    mkdirSync(path.dirname(childArtifact), { recursive: true })
    const journalPath = fallbackJournalPath(fixture.identity.trackingPath)
    const result = await execute(fixture, childWritesEnvelope((nonce) => {
      // The child removed the parent journal before exiting: losing journal
      // authority is never proof of a successful rollback, so the envelope
      // claim must not become a verified success. Only its validated
      // reporting survives, alongside the retained recovery locations.
      rmSync(journalPath, { force: true })
      return {
        schema: FALLBACK_CHILD_RESULT_SCHEMA,
        nonce,
        code: 'FALLBACK_MCP_DRIFT',
        rollback: { attempted: true, succeeded: true },
        preservedArtifacts: [childArtifact],
        preservedPaths: [childPath],
      }
    }))

    assert.equal(result.status, 'failed')
    assert.equal(result.error?.code, 'FALLBACK_STATE_UNPROVEN')
    assert.deepEqual(result.rollback, { attempted: true, succeeded: false }, 'a lost journal must never be promoted to a child-claimed success')
    assert.ok((result.preservedArtifacts ?? []).includes(childArtifact), 'child preservation reporting must survive a child-disposed journal')
    assert.ok((result.preservedArtifacts ?? []).includes(journalPath), 'the lost journal location must be retained for manual guidance')
    assert.deepEqual(result.preservedPaths, [childPath])
  })

  it('treats a reclaim failure with only a stdout rollback claim as unproven and preserves live bytes', async () => {
    const fixture = await setupResultFixture()
    const journalPath = fallbackJournalPath(fixture.identity.trackingPath)
    let snapshotDirectory = ''
    const result = await execute(fixture, () => {
      // Failing child with no envelope: it changed live owned bytes, deleted
      // the journal, and left a bare stdout success claim behind.
      snapshotDirectory = (JSON.parse(readFileSync(journalPath, 'utf8')) as { snapshotDirectory: string }).snapshotDirectory
      writeFileSync(path.join(fixture.skillPath, 'SKILL.md'), 'mutated by child')
      rmSync(journalPath, { force: true })
      return { exitCode: 1, stdout: '', stderr: 'refresh failed\nrollback: succeeded\n', timedOut: false, treeTerminated: true }
    })

    assert.equal(result.status, 'failed')
    assert.equal(result.error?.code, 'FALLBACK_STATE_UNPROVEN')
    assert.deepEqual(result.rollback, { attempted: true, succeeded: false }, 'the stdout claim must not become a verified success')
    assert.equal(readFileSync(path.join(fixture.skillPath, 'SKILL.md'), 'utf8'), 'mutated by child', 'unproven live bytes must be preserved, never silently restored or removed')
    assert.ok((result.preservedArtifacts ?? []).includes(journalPath), 'the lost journal location must be retained for manual guidance')
    assert.ok((result.preservedArtifacts ?? []).includes(snapshotDirectory), 'the surviving snapshot must be retained for manual guidance')
    assert.equal(existsSync(snapshotDirectory), true, 'the surviving snapshot must not be removed')
  })

  it('treats a reclaim failure with a nonce-valid success envelope as unproven and preserves live bytes', async () => {
    const fixture = await setupResultFixture()
    const journalPath = fallbackJournalPath(fixture.identity.trackingPath)
    const result = await execute(fixture, childWritesEnvelope((nonce) => {
      // Failing child with a nonce-valid envelope: it changed live owned
      // bytes, corrupted the journal transaction identity, and still claims
      // a successful rollback.
      writeFileSync(path.join(fixture.skillPath, 'SKILL.md'), 'mutated by child')
      const journal = JSON.parse(readFileSync(journalPath, 'utf8')) as Record<string, unknown>
      writeFileSync(journalPath, JSON.stringify({ ...journal, transactionId: randomUUID() }, null, 2) + '\n')
      return {
        schema: FALLBACK_CHILD_RESULT_SCHEMA,
        nonce,
        code: 'FALLBACK_MCP_DRIFT',
        rollback: { attempted: true, succeeded: true },
      }
    }))

    assert.equal(result.status, 'failed')
    assert.equal(result.error?.code, 'FALLBACK_STATE_UNPROVEN')
    assert.deepEqual(result.rollback, { attempted: true, succeeded: false }, 'even a nonce-valid envelope must not become a verified success without reclaim')
    assert.equal(readFileSync(path.join(fixture.skillPath, 'SKILL.md'), 'utf8'), 'mutated by child', 'unproven live bytes must be preserved, never silently restored or removed')
    assert.ok((result.preservedArtifacts ?? []).includes(journalPath), 'the corrupted journal location must be retained for manual guidance')
    assert.equal(existsSync(journalPath), true, 'the corrupted journal must survive for manual recovery')
  })

  it('names the abandoned transition lock when a successful child cannot be reclaimed, preserving journal and lock', async () => {
    const fixture = await setupResultFixture()
    const journalPath = fallbackJournalPath(fixture.identity.trackingPath)
    const lockPath = `${journalPath}.mutation-lock`
    let journalInChild = ''
    let lockContent = ''
    setFallbackJournalTransitionLockTimeoutForTests(50)
    try {
      const result = await execute(fixture, () => {
        // The child succeeded, but an abandoned mutation transition lock now
        // blocks the parent's reclaim: the parent must fail closed and name
        // the exact lock path instead of swallowing the refusal.
        journalInChild = readFileSync(journalPath, 'utf8')
        lockContent = 'held by an abandoned process'
        writeFileSync(lockPath, lockContent, { mode: 0o600 })
        return { exitCode: 0, stdout: '', stderr: '', timedOut: false, treeTerminated: true }
      })

      assert.equal(result.status, 'failed')
      assert.equal(result.error?.code, 'FALLBACK_STATE_UNPROVEN')
      assert.ok(result.error?.message.includes(lockPath), `actual lock path expected in: ${result.error?.message}`)
      assert.match(result.error?.message ?? '', /manual recovery/)
      assert.deepEqual(result.rollback, { attempted: false })
      // Fail-closed preservation: journal bytes and the foreign lock are untouched.
      assert.equal(readFileSync(journalPath, 'utf8'), journalInChild)
      assert.ok(existsSync(lockPath))
      assert.equal(readFileSync(lockPath, 'utf8'), lockContent)
    } finally {
      setFallbackJournalTransitionLockTimeoutForTests(undefined)
    }
  })

  it('names the abandoned transition lock when parent recovery cannot reclaim the journal, preserving journal and backup', async () => {
    const fixture = await setupResultFixture()
    const journalPath = fallbackJournalPath(fixture.identity.trackingPath)
    const lockPath = `${journalPath}.mutation-lock`
    let journalInChild = ''
    let backupInChild = ''
    setFallbackJournalTransitionLockTimeoutForTests(50)
    try {
      const result = await execute(fixture, () => {
        // Failing child; the recovery reclaim then hits the abandoned lock and
        // the projected user-facing failure must carry the actual lock path.
        journalInChild = readFileSync(journalPath, 'utf8')
        const journal = JSON.parse(journalInChild) as { entries: Array<{ backup?: string }> }
        const backup = journal.entries.map((entry) => entry.backup).find((candidate) => candidate !== undefined && statSync(candidate).isFile())
        assert.ok(backup !== undefined, 'the fixture journal must hold at least one file backup')
        backupInChild = readFileSync(backup, 'utf8')
        writeFileSync(lockPath, 'held by an abandoned process', { mode: 0o600 })
        return { exitCode: 1, stdout: '', stderr: 'refresh failed\nrollback: not-attempted\n', timedOut: false, treeTerminated: true }
      })

      assert.equal(result.status, 'failed')
      assert.equal(result.error?.code, 'FALLBACK_STATE_UNPROVEN')
      assert.ok(result.error?.message.includes(lockPath), `actual lock path expected in: ${result.error?.message}`)
      assert.match(result.error?.message ?? '', /manual recovery/)
      assert.deepEqual(result.rollback, { attempted: true, succeeded: false })
      assert.ok((result.preservedArtifacts ?? []).includes(journalPath), 'the journaled location must be retained for manual guidance')
      // Fail-closed preservation: journal bytes, backup bytes, and the lock are untouched.
      assert.equal(readFileSync(journalPath, 'utf8'), journalInChild)
      const journal = JSON.parse(journalInChild) as { entries: Array<{ backup?: string }> }
      const backup = journal.entries.map((entry) => entry.backup).find((candidate) => candidate !== undefined && statSync(candidate).isFile())!
      assert.equal(readFileSync(backup, 'utf8'), backupInChild)
      assert.ok(existsSync(lockPath))
    } finally {
      setFallbackJournalTransitionLockTimeoutForTests(undefined)
    }
  })

  it('still reports a verified parent rollback when the journal survives a mutating failing child', async () => {
    // Positive control: the child mutates the live tracking file through the
    // genuine journal API and then fails. The parent reclaims, restores from
    // authenticated backups, and proves the rollback.
    const fixture = await setupResultFixture()
    const result = await fallbackStrategy.execute(fixture.item, {
      options: {},
      commandRunner: {
        run: async () => {
          const claimed = await claimFallbackJournalMutation(fixture.identity, manifestDigestOf(fixture.identity))
          assert.ok(claimed, 'the simulated child must be able to claim the mutating journal')
          const mutated = { ...(await readTrackingFile())!, bundleVersions: { claude: '9.9.9' } }
          const staged = await registerFallbackStage(claimed, fixture.identity.trackingPath, { bytes: Buffer.from(JSON.stringify(mutated, null, 2) + '\n') })
          await applyFallbackEntry(staged, fixture.identity.trackingPath)
          return { exitCode: 1, stdout: '', stderr: 'refresh failed\nrollback: succeeded\n', timedOut: false, treeTerminated: true }
        },
      },
    })

    assert.equal(result.status, 'failed')
    assert.equal(result.error?.code, 'FALLBACK_COMMAND_FAILED')
    assert.deepEqual(result.rollback, { attempted: true, succeeded: true })
    assert.equal((await readTrackingFile())?.bundleVersions?.claude, '1.0.0', 'the verified parent restore must bring back the planned tracking bytes')
    assert.equal(readFileSync(path.join(fixture.skillPath, 'SKILL.md'), 'utf8'), 'old tracked')
  })

  it('deterministically merges child preservation reporting with an unproven parent restore', async () => {
    const fixture = await setupResultFixture()
    const childArtifactLate = path.join(home, 'preserved', 'z-artifact')
    const childArtifactEarly = path.join(home, 'preserved', 'a-artifact')
    const childPath = path.join(home, 'preserved', 'm-path')
    const journalPath = fallbackJournalPath(fixture.identity.trackingPath)
    const result = await execute(fixture, childWritesEnvelope((nonce) => {
      // Tamper one journaled backup so the parent's own restore fails closed
      // (unproven) while the validated child reporting still propagates.
      const journal = JSON.parse(readFileSync(journalPath, 'utf8')) as { entries: Array<{ backup?: string }> }
      const backup = journal.entries.find((entry) => entry.backup)?.backup
      assert.ok(backup, 'the fixture journal must hold at least one backup')
      if (statSync(backup).isDirectory()) writeFileSync(path.join(backup, '__tampered__'), 'tampered')
      else writeFileSync(backup, 'tampered')
      return {
        schema: FALLBACK_CHILD_RESULT_SCHEMA,
        nonce,
        code: 'FALLBACK_STATE_UNPROVEN',
        rollback: { attempted: true, succeeded: false },
        preservedArtifacts: [childArtifactLate, childArtifactEarly],
        preservedPaths: [childPath],
      }
    }))

    assert.equal(result.error?.code, 'FALLBACK_STATE_UNPROVEN')
    assert.deepEqual(result.rollback, { attempted: true, succeeded: false })
    assert.deepEqual(result.preservedArtifacts, [childArtifactEarly, childArtifactLate], 'merged reporting must be deduplicated and deterministically ordered')
    assert.deepEqual(result.preservedPaths, [childPath])
    assert.equal(existsSync(journalPath), true, 'an unproven restore must preserve the journal')
  })

  it('fails safely when an older child publishes no structured result', async () => {
    const fixture = await setupResultFixture()
    const result = await execute(fixture, () => ({ exitCode: 1, stdout: '', stderr: 'Fallback MCP state changed but valid credentials are unavailable\nrollback: succeeded\n', timedOut: false, treeTerminated: true }))
    assert.equal(result.error?.code, 'FALLBACK_COMMAND_FAILED')
    assert.equal(result.error?.message, 'Fallback refresh command failed')
    // The verified parent journal, not child stdout, supplies the rollback
    // outcome when the command has completed and parent recovery succeeds.
    assert.deepEqual(result.rollback, { attempted: true, succeeded: true })
  })

  it('keeps the public seam to exactly one JSON document and never leaks raw child output', { timeout: 120_000 }, async () => {
    // Real-process test: a driver process runs the real fallback strategy with
    // the real command runner against the real refresh-owned child (repository
    // sources through tsx), then renders the UpdateResult the way the CLI does.
    const fixture = await setupResultFixture()
    const require = createRequire(import.meta.url)
    const tsxLoader = pathToFileURL(require.resolve('tsx/esm')).href
    const driverPath = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fallback-public-seam-driver.ts')
    const payload = JSON.stringify({
      home,
      manifestDir: fixture.manifestDir,
      manifestPath: fixture.manifestPath,
      resultPath: fixture.resultPath,
      identity: fixture.identity,
    })

    const child = spawn(process.execPath, ['--import', tsxLoader, driverPath, payload], {
      env: { ...process.env, HOME: home, USERPROFILE: home },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => { stdout += chunk })
    child.stderr.on('data', (chunk: string) => { stderr += chunk })
    const exitCode = await new Promise<number | null>((resolve) => child.on('close', resolve))

    assert.equal(exitCode, 0, `driver process must exit cleanly; stderr: ${stderr}`)
    // Exactly one JSON document: JSON.parse over the whole trimmed stdout must
    // succeed and consume it entirely (a second document would throw).
    const trimmed = stdout.trim()
    const parsed = JSON.parse(trimmed) as UpdateResult
    const completion = JSON.parse(readFileSync(path.join(home, 'command-completion.json'), 'utf8')) as Pick<CommandResult, 'exitCode' | 'timedOut' | 'treeTerminated' | 'spawnErrorCode'> & { childCode: string; childNonce: string }
    assert.equal(parsed.status, 'failed')
    assert.equal(completion.exitCode, 1)
    assert.equal(completion.timedOut, false)
    assert.equal(completion.childCode, 'MCP_RECONCILIATION_REQUIRED', 'the real child must reach the intended fixture failure')
    assert.equal(completion.childNonce, fixture.identity.nonce)
    assert.equal(typeof completion.treeTerminated, 'boolean', 'the real runner must provide explicit completion evidence')
    // The public document must reflect the REAL completion verdict. Parallel
    // process activity (or a platform without proof) can require deferral;
    // the child envelope must never override that safety decision.
    if (completion.treeTerminated) {
      assert.equal(completion.spawnErrorCode, undefined)
      assert.equal(parsed.error?.code, 'MCP_RECONCILIATION_REQUIRED')
      assert.ok(parsed.error?.message.includes('nsolid-plugin setup --harness claude'), 'the approved recovery guidance must name the planned harness')
    } else {
      assert.equal(completion.spawnErrorCode, 'TREE_TERMINATION_UNCONFIRMED')
      assert.equal(parsed.error?.code, 'FALLBACK_TREE_TERMINATION_UNCONFIRMED')
      assert.deepEqual(parsed.rollback, { attempted: false })
      const journalPath = fallbackJournalPath(fixture.identity.trackingPath)
      assert.equal(existsSync(journalPath), true)
      const journal = JSON.parse(readFileSync(journalPath, 'utf8')) as { snapshotDirectory: string }
      assert.equal(existsSync(journal.snapshotDirectory), true)
      assert.equal(existsSync(fixture.manifestDir), true)
    }
    // The child's own raw stderr text is child-controlled data and must not
    // appear anywhere in the public result or on the public stdout. (The
    // phrase 'valid credentials are unavailable' also appears in the approved
    // parent-owned template, so the unique child fragment is used here.)
    const childRawFragment = 'Fallback MCP state changed'
    assert.ok(!trimmed.includes(childRawFragment), 'raw child stderr must never reach public stdout')
    assert.ok(!stderr.includes(childRawFragment), 'raw child stderr must never be forwarded to public stderr')
    assert.ok(!parsed.error?.message.includes(childRawFragment), 'raw child text must never be promoted into the public message')
    assert.equal(JSON.parse(JSON.stringify(parsed)) && true, true, 'the public document must round-trip as one stable JSON value')
  })
})

describe('fallback strategy frontier planning', () => {
  let home: string
  let restoreHome: () => void
  let restoreNpmPath: (() => void) | undefined
  let previousOpenCodeSkillsDir: string | undefined
  const createdManifestDirectories: string[] = []

  /**
   * Deterministic npm launcher fixture: a resolver-verified npm identity so
   * planning resolves `npm` from the fixture instead of the ambient runner
   * PATH (whose launcher distribution differs across CI hosts and can be
   * rejected as UNSAFE_FALLBACK_EXECUTOR for reasons unrelated to these
   * destination-classification scenarios). Same pattern as
   * package-manager.test.ts: a POSIX executable script on POSIX, and an
   * npm-style `.CMD` shim plus its adjacent node_modules entrypoint with a
   * matching package manifest on Windows, which `resolveExecutableIdentity`
   * verifies through the production shim path before accepting.
   */
  function writeNpmIdentityFixture (binPath: string): void {
    mkdirSync(binPath, { recursive: true })
    if (process.platform === 'win32') {
      const entrypoint = path.join(binPath, 'node_modules', 'npm', 'bin', 'npm-cli.js')
      mkdirSync(path.dirname(entrypoint), { recursive: true })
      writeFileSync(entrypoint, '#!/usr/bin/env node\n')
      writeFileSync(path.join(binPath, 'node_modules', 'npm', 'package.json'), JSON.stringify({
        name: 'npm',
        bin: { npm: 'bin/npm-cli.js' },
      }))
      writeFileSync(path.join(binPath, 'npm.CMD'),
        '@ECHO off\r\nSETLOCAL\r\nCALL :find_dp0\r\nIF EXIST "%dp0%\\node.exe" (SET "_prog=%dp0%\\node.exe") ELSE (SET "_prog=node")\r\n' +
        '"%_prog%" "%dp0%\\node_modules\\npm\\bin\\npm-cli.js" %*\r\n' +
        'exit /b %errorlevel%\r\n:find_dp0\r\nSET dp0=%~dp0\r\nEXIT /b\r\n')
    } else {
      const launcher = path.join(binPath, 'npm')
      writeFileSync(launcher, '#!/bin/sh\n')
      chmodSync(launcher, 0o755)
    }
  }

  /**
   * Isolate executable lookup to the fixture bin directory. Saves every
   * case-variant of PATH (and PATHEXT on Windows) so the restore puts the
   * environment back exactly, regardless of the host's key casing.
   */
  function isolateExecutableLookup (fixtureBin: string): () => void {
    const saved = Object.entries(process.env).filter(([name]) => {
      const lowered = name.toLowerCase()
      return lowered === 'path' || (process.platform === 'win32' && lowered === 'pathext')
    })
    for (const [name] of saved) delete process.env[name]
    process.env.PATH = fixtureBin
    if (process.platform === 'win32') process.env.PATHEXT = '.CMD'
    return () => {
      // Delete every case-variant of the installed lookup keys — including
      // ones that were initially absent — so the restore cannot leak the
      // fixture state into the ambient environment.
      for (const name of Object.keys(process.env)) {
        const lowered = name.toLowerCase()
        if (lowered === 'path' || (process.platform === 'win32' && lowered === 'pathext')) delete process.env[name]
      }
      for (const [name, value] of saved) {
        if (value !== undefined) process.env[name] = value
      }
    }
  }

  beforeEach(() => {
    home = createCanonicalTempRoot('nsolid-plugin-frontier-')
    previousOpenCodeSkillsDir = process.env.NSOLID_OPENCODE_SKILLS_DIR
    restoreHome = isolateHome(home)
    const npmFixtureBin = path.join(home, 'npm-identity-fixture')
    writeNpmIdentityFixture(npmFixtureBin)
    restoreNpmPath = isolateExecutableLookup(npmFixtureBin)
  })

  afterEach(() => {
    restoreNpmPath?.()
    restoreHome()
    if (previousOpenCodeSkillsDir === undefined) delete process.env.NSOLID_OPENCODE_SKILLS_DIR
    else process.env.NSOLID_OPENCODE_SKILLS_DIR = previousOpenCodeSkillsDir
    while (createdManifestDirectories.length > 0) {
      rmSync(createdManifestDirectories.pop()!, { recursive: true, force: true })
    }
    rmSync(home, { recursive: true, force: true })
  })

  it('resolves npm through the isolated resolver-verified fixture, never the ambient PATH', () => {
    const fixtureBin = path.join(home, 'npm-identity-fixture')
    const identity = resolveExecutableIdentity('npm')
    assert.ok(
      identity.kind === 'native' || identity.kind === 'node',
      `the resolver must accept the fixture npm identity, got: ${JSON.stringify(identity)}`
    )
    if (identity.kind === 'node') {
      // Windows: the verified shim launches the immutable JS entrypoint
      // through the parent's own node executable, never cmd.exe.
      assert.equal(identity.executable, process.execPath)
      assert.equal(identity.entrypoint, path.join(fixtureBin, 'node_modules', 'npm', 'bin', 'npm-cli.js'))
    } else {
      assert.equal(identity.executable, path.join(fixtureBin, 'npm'))
    }
  })

  function writeBundleTarball (bundle: object): string {
    const tarball = path.join(home, 'artifact.tgz')
    writeFileSync(tarball, gzipSync(Buffer.concat([
      tarEntry('package/', undefined, '5'),
      tarEntry('package/bundle.json', Buffer.from(JSON.stringify(bundle)), '0'),
      Buffer.alloc(1024),
    ])))
    return tarball
  }

  async function writeFixtureTracking (options: {
    harness: 'opencode' | 'claude'
    skills: readonly { name: string, path: string }[]
    mcpServers?: readonly Record<string, unknown>[]
  }): Promise<void> {
    const trackingPath = path.join(home, '.agents', '.nodesource-installed.json')
    mkdirSync(path.dirname(trackingPath), { recursive: true })
    await writeTrackingFile({
      version: '1.0.0',
      installedAt: new Date().toISOString(),
      harness: options.harness,
      bundleVersions: { [options.harness]: '1.0.0' },
      skills: options.skills.map((skill) => ({
        ...skill,
        installedAt: new Date().toISOString(),
        harnesses: [options.harness],
        paths: { [options.harness]: skill.path },
      })),
      mcpServers: [...(options.mcpServers ?? [])],
    } as never)
  }

  function buildInstallation (options: {
    harness: 'opencode' | 'claude'
    tarball: string
    trackedSkills: readonly { name: string, path: string }[]
    trackedMcpConfigPath?: string
    trackedMcpNames?: readonly string[]
    trackedMcpFields?: readonly { configPath: string, server: string, field: string, expectedDigest: string }[]
  }): UpdateInstallation {
    return {
      installationId: `${options.harness}:fallback`,
      target: options.harness,
      ownership: 'fallback',
      installed: true,
      source: { kind: 'fallback', bundleVersion: '1.0.0', executor: 'npm-exec' },
      version: { current: '1.0.0', latest: '1.0.1', status: 'update-available' },
      artifact: {
        kind: 'npm',
        packageName: 'nsolid-plugin',
        version: '1.0.1',
        registry: 'https://registry.example.com',
        tarball: 'artifact.tgz',
        integrity: 'sha512-unused-at-plan-time',
        tarballPath: options.tarball,
      },
      metadata: {
        trackedSkills: [...options.trackedSkills],
        ...(options.trackedMcpConfigPath !== undefined ? { trackedMcpConfigPath: options.trackedMcpConfigPath } : {}),
        ...(options.trackedMcpNames !== undefined ? { trackedMcpNames: [...options.trackedMcpNames] } : {}),
        ...(options.trackedMcpFields !== undefined ? { trackedMcpFields: [...options.trackedMcpFields] } : {}),
      },
    }
  }

  async function planFixture (installation: UpdateInstallation): Promise<UpdatePlanItem> {
    const planned = await fallbackStrategy.plan(installation, { options: {}, commandRunner: { run: async () => ({ exitCode: 0, stdout: '', stderr: '', timedOut: false, treeTerminated: true }) } })
    for (const directory of planned.temporaryDirectories ?? []) createdManifestDirectories.push(directory)
    return planned
  }

  /**
   * Active planned-missing frontiers only proceed to the manifest workspace
   * on Linux (platform preflight). Non-linux hosts assert the fail-closed
   * rejection instead of the manifest assertions that follow.
   */
  async function planOrRejectOnNonLinux (installation: UpdateInstallation): Promise<UpdatePlanItem> {
    const planned = await planFixture(installation)
    if (process.platform !== 'linux') {
      assert.equal(planned.planningError?.code, 'FALLBACK_PARENT_CREATION_UNSUPPORTED')
      assert.equal(planned.steps.length, 0)
      assert.equal(planned.temporaryDirectories, undefined)
    } else {
      // Callers early-return on ANY planning error: on Linux the error must
      // be asserted undefined here, otherwise a planner failure would
      // silently skip every success/frontier assertion below.
      assert.equal(planned.planningError, undefined)
    }
    return planned
  }

  function anchorIdentityOfFixture (anchorPath: string): Record<string, unknown> {
    const stats = statSync(anchorPath, { bigint: true })
    return { path: anchorPath, realpath: anchorPath, type: 'directory', device: stats.dev.toString(), inode: stats.ino.toString() }
  }

  function readManifest (planned: UpdatePlanItem): Record<string, unknown> {
    const manifestPath = path.join(planned.temporaryDirectories![0], 'transaction.json')
    return JSON.parse(readFileSync(manifestPath, 'utf8'))
  }

  it('embeds the exact deterministic frontier graph in the manifest and binds the command digest to it', async () => {
    const skillsRoot = path.join(home, '.config', 'opencode', 'skills')
    mkdirSync(path.join(home, '.config', 'opencode'), { recursive: true })
    await writeFixtureTracking({
      harness: 'opencode',
      skills: [{ name: 'tracked', path: path.join(skillsRoot, 'tracked') }],
    })
    const tarball = writeBundleTarball({
      name: 'nsolid-plugin',
      version: '1.0.1',
      skills: [
        { name: 'tracked', path: 'skills/tracked', description: 'tracked' },
        { name: 'added', path: 'skills/added', description: 'added' },
      ],
      mcpServers: [{ name: 'nsolid-console', url: 'https://example.com/mcp', headers: {} }],
    })
    const planned = await planOrRejectOnNonLinux(buildInstallation({
      harness: 'opencode',
      tarball,
      trackedSkills: [{ name: 'tracked', path: path.join(skillsRoot, 'tracked') }],
    }))
    // Non-linux hosts already asserted the fail-closed platform rejection.
    if (planned.planningError !== undefined) return

    assert.equal(planned.planningError, undefined)
    assert.equal(planned.steps.length, 4)
    const expectedFrontier = {
      frontierPath: skillsRoot,
      activation: 'required',
      anchor: anchorIdentityOfFixture(path.join(home, '.config', 'opencode')),
      leaves: [
        { id: 'skill:added', role: 'skill', activation: 'required', path: path.join(skillsRoot, 'added') },
        { id: 'skill:tracked', role: 'skill', activation: 'required', path: path.join(skillsRoot, 'tracked') },
      ],
    }
    const manifest = readManifest(planned)
    assert.deepEqual(manifest.plannedMissingFrontiers, [expectedFrontier])
    // The published child command digest covers exactly the embedded graph.
    const commandStep = planned.steps.find((entry) => entry.kind === 'command')
    assert.ok(commandStep !== undefined && commandStep.kind === 'command')
    const command = commandStep.command
    const digestArgumentIndex = command.args.indexOf('--manifest-digest')
    assert.ok(digestArgumentIndex >= 0)
    assert.equal(command.args[digestArgumentIndex + 1], manifestDigestOf(manifest as never))
    // Derivation is deterministic: an identical planned state yields a
    // byte-identical frontier graph.
    const replanned = await planOrRejectOnNonLinux(buildInstallation({
      harness: 'opencode',
      tarball,
      trackedSkills: [{ name: 'tracked', path: path.join(skillsRoot, 'tracked') }],
    }))
    assert.deepEqual(readManifest(replanned).plannedMissingFrontiers, [expectedFrontier])
  })

  it('derives complete leaf roles inside a frontier including planned removals while existing parents keep their leaves out', async () => {
    const skillsRoot = path.join(home, '.agents', 'skills')
    const linkRoot = path.resolve(getHarnessSkillsPath('claude'))
    mkdirSync(path.join(home, '.agents'), { recursive: true })
    mkdirSync(linkRoot, { recursive: true })
    await writeFixtureTracking({
      harness: 'claude',
      skills: [
        { name: 'kept', path: path.join(skillsRoot, 'kept') },
        { name: 'dropped', path: path.join(skillsRoot, 'dropped') },
      ],
    })
    const tarball = writeBundleTarball({
      name: 'nsolid-plugin',
      version: '1.0.1',
      skills: [
        { name: 'kept', path: 'skills/kept', description: 'kept' },
        { name: 'brand-new', path: 'skills/brand-new', description: 'brand-new' },
      ],
      mcpServers: [{ name: 'nsolid-console', url: 'https://example.com/mcp', headers: {} }],
    })
    const planned = await planOrRejectOnNonLinux(buildInstallation({
      harness: 'claude',
      tarball,
      trackedSkills: [
        { name: 'kept', path: path.join(skillsRoot, 'kept') },
        { name: 'dropped', path: path.join(skillsRoot, 'dropped') },
      ],
    }))
    // Non-linux hosts already asserted the fail-closed platform rejection.
    if (planned.planningError !== undefined) return

    assert.equal(planned.planningError, undefined)
    const manifest = readManifest(planned)
    assert.deepEqual(manifest.plannedMissingFrontiers, [{
      frontierPath: skillsRoot,
      activation: 'required',
      anchor: anchorIdentityOfFixture(path.join(home, '.agents')),
      leaves: [
        { id: 'skill:brand-new', role: 'skill', activation: 'required', path: path.join(skillsRoot, 'brand-new') },
        { id: 'owned-skill:dropped', role: 'skill', activation: 'conditional', path: path.join(skillsRoot, 'dropped') },
        { id: 'skill:kept', role: 'skill', activation: 'required', path: path.join(skillsRoot, 'kept') },
      ],
    }])
  })

  it('treats a missing file leaf under an existing parent as a normal destination, never a frontier', async () => {
    const skillsRoot = path.join(home, '.config', 'opencode', 'skills')
    mkdirSync(path.join(skillsRoot, 'tracked'), { recursive: true })
    writeFileSync(path.join(skillsRoot, 'tracked', 'SKILL.md'), 'tracked')
    await writeFixtureTracking({
      harness: 'opencode',
      skills: [{ name: 'tracked', path: path.join(skillsRoot, 'tracked') }],
    })
    const tarball = writeBundleTarball({
      name: 'nsolid-plugin',
      version: '1.0.1',
      skills: [{ name: 'tracked', path: 'skills/tracked', description: 'tracked' }],
      mcpServers: [{ name: 'nsolid-console', url: 'https://example.com/mcp', headers: {} }],
    })
    const planned = await planFixture(buildInstallation({
      harness: 'opencode',
      tarball,
      trackedSkills: [{ name: 'tracked', path: path.join(skillsRoot, 'tracked') }],
    }))

    // The canonical MCP config (~/.config/opencode/opencode.jsonc) is missing
    // but its parent exists: an independent leaf destination, so the update
    // stays fully supported with an explicitly empty frontier list.
    assert.equal(planned.planningError, undefined)
    assert.equal(planned.steps.length, 4)
    assert.deepEqual(readManifest(planned).plannedMissingFrontiers, [])
  })

  it('keeps frontiers sharing one parent together and separates distinct missing parents', async () => {
    const skillsRoot = path.join(home, '.agents', 'skills')
    const linkRoot = path.resolve(getHarnessSkillsPath('claude'))
    mkdirSync(path.join(home, '.agents'), { recursive: true })
    mkdirSync(path.join(home, '.claude'), { recursive: true })
    await writeFixtureTracking({
      harness: 'claude',
      skills: [{ name: 'kept', path: path.join(skillsRoot, 'kept') }],
    })
    const tarball = writeBundleTarball({
      name: 'nsolid-plugin',
      version: '1.0.1',
      skills: [
        { name: 'kept', path: 'skills/kept', description: 'kept' },
        { name: 'brand-new', path: 'skills/brand-new', description: 'brand-new' },
      ],
      mcpServers: [{ name: 'nsolid-console', url: 'https://example.com/mcp', headers: {} }],
    })
    const planned = await planOrRejectOnNonLinux(buildInstallation({
      harness: 'claude',
      tarball,
      trackedSkills: [{ name: 'kept', path: path.join(skillsRoot, 'kept') }],
    }))
    // Non-linux hosts already asserted the fail-closed platform rejection.
    if (planned.planningError !== undefined) return

    assert.equal(planned.planningError, undefined)
    const manifest = readManifest(planned)
    const frontiers = manifest.plannedMissingFrontiers as Record<string, unknown>[]
    assert.deepEqual(frontiers, [
      {
        frontierPath: skillsRoot,
        activation: 'required',
        anchor: anchorIdentityOfFixture(path.join(home, '.agents')),
        leaves: [
          { id: 'skill:brand-new', role: 'skill', activation: 'required', path: path.join(skillsRoot, 'brand-new') },
          { id: 'skill:kept', role: 'skill', activation: 'required', path: path.join(skillsRoot, 'kept') },
        ],
      },
      {
        frontierPath: linkRoot,
        activation: 'required',
        anchor: anchorIdentityOfFixture(path.join(home, '.claude')),
        leaves: [
          { id: 'link:brand-new', role: 'link', activation: 'required', path: path.join(linkRoot, 'brand-new') },
          { id: 'link:kept', role: 'link', activation: 'required', path: path.join(linkRoot, 'kept') },
        ],
      },
    ])
  })

  it('fails a leaf ancestor collision closed before any manifest workspace exists', async () => {
    // Destination root = ~/.config so the bundle skill `opencode` plans the
    // leaf ~/.config/opencode, a proper ancestor of the canonical MCP config
    // leaf ~/.config/opencode/opencode.jsonc.
    process.env.NSOLID_OPENCODE_SKILLS_DIR = path.join(home, '.config')
    mkdirSync(path.join(home, '.config', 'opencode'), { recursive: true })
    await writeFixtureTracking({
      harness: 'opencode',
      skills: [{ name: 'opencode', path: path.join(home, '.config', 'opencode') }],
    })
    const tarball = writeBundleTarball({
      name: 'nsolid-plugin',
      version: '1.0.1',
      skills: [{ name: 'opencode', path: 'skills/opencode', description: 'opencode' }],
      mcpServers: [{ name: 'nsolid-console', url: 'https://example.com/mcp', headers: {} }],
    })
    const planned = await planFixture(buildInstallation({
      harness: 'opencode',
      tarball,
      trackedSkills: [{ name: 'opencode', path: path.join(home, '.config', 'opencode') }],
    }))

    assert.equal(planned.planningError?.code, 'FALLBACK_FRONTIER_COLLISION')
    assert.equal(planned.steps.length, 0)
    assert.equal(planned.temporaryDirectories, undefined)
  })

  it('rejects an active frontier on unsupported platforms before the manifest exists and keeps existing-parent updates supported', async () => {
    const skillsRoot = path.join(home, '.config', 'opencode', 'skills')
    mkdirSync(path.join(home, '.config', 'opencode'), { recursive: true })
    await writeFixtureTracking({
      harness: 'opencode',
      skills: [{ name: 'tracked', path: path.join(skillsRoot, 'tracked') }],
    })
    const tarball = writeBundleTarball({
      name: 'nsolid-plugin',
      version: '1.0.1',
      skills: [{ name: 'tracked', path: 'skills/tracked', description: 'tracked' }],
      mcpServers: [{ name: 'nsolid-console', url: 'https://example.com/mcp', headers: {} }],
    })
    const installation = buildInstallation({
      harness: 'opencode',
      tarball,
      trackedSkills: [{ name: 'tracked', path: path.join(skillsRoot, 'tracked') }],
    })
    // Capture the REAL host platform BEFORE the spoof: inside the try block
    // below process.platform is faked to 'win32' on every host, so it can no
    // longer distinguish a native Windows runner from a POSIX host faking it.
    const realPlatform = process.platform
    const platformDescriptor = Object.getOwnPropertyDescriptor(process, 'platform')!
    Object.defineProperty(process, 'platform', { value: 'win32' })
    try {
      const rejected = await planFixture(installation)
      assert.equal(rejected.planningError?.code, 'FALLBACK_PARENT_CREATION_UNSUPPORTED')
      assert.ok(rejected.planningError?.message.includes(skillsRoot))
      assert.equal(rejected.steps.length, 0)
      assert.equal(rejected.temporaryDirectories, undefined)
      assert.deepEqual(rejected.manualCommands, ['nsolid-plugin install --harness opencode'])

      // Once every parent and leaf exists, the frontier gate passes on the
      // same faked platform: the rejection is strictly frontier-conditional.
      mkdirSync(path.join(skillsRoot, 'tracked'), { recursive: true })
      const pastGate = await planFixture(installation)
      assert.notEqual(pastGate.planningError?.code, 'FALLBACK_PARENT_CREATION_UNSUPPORTED')
      if (realPlatform === 'win32') {
        // Native Windows: the beforeEach npm-identity fixture ships a verified
        // npm.CMD shim, so planning legitimately proceeds into a real manifest
        // workspace (CI evidence: run 34258873417 actual temporaryDirectories
        // contained an nsolid-plugin-manifest-* directory created by this very
        // call). Assert the full supported outcome; planFixture registers the
        // workspace in createdManifestDirectories and afterEach disposes it.
        assert.equal(pastGate.planningError, undefined)
        assert.equal(pastGate.steps.length, 4)
        assert.ok(Array.isArray(pastGate.temporaryDirectories) && pastGate.temporaryDirectories.length > 0)
        assert.deepEqual(readManifest(pastGate).plannedMissingFrontiers, [])
      } else {
        // POSIX host faking win32: the isolated single-segment fixture PATH
        // contains no Windows-extension candidates, so findExecutable('npm',
        // env, 'win32') deterministically returns undefined (verified against
        // the production resolver) and planning must reject with the exact
        // executor reason BEFORE creating any manifest workspace.
        assert.equal(pastGate.planningError?.code, 'UNSAFE_FALLBACK_EXECUTOR')
        assert.equal(pastGate.temporaryDirectories, undefined)
      }
    } finally {
      Object.defineProperty(process, 'platform', platformDescriptor)
    }
    // Existing-parent support on the REAL platform: once every parent and
    // leaf exists, with no frontier the plan carries a full command step and
    // an explicitly empty frontier list.
    const supported = await planFixture(installation)
    assert.equal(supported.planningError, undefined)
    assert.equal(supported.steps.length, 4)
    assert.deepEqual(readManifest(supported).plannedMissingFrontiers, [])
  })

  it('keeps a conditional MCP-only frontier active on unsupported platforms instead of inferring a no-op', async () => {
    const skillsRoot = path.join(home, '.config', 'opencode', 'skills')
    mkdirSync(path.join(skillsRoot, 'kept'), { recursive: true })
    mkdirSync(path.join(home, 'custom'), { recursive: true })
    const deepConfigPath = path.join(home, 'custom', 'deep', 'nested', 'config.json')
    const fields = {
      url: valueDigest('https://old.example.com/mcp'),
      headers: valueDigest({ AUTH: 'x' }),
    }
    await writeFixtureTracking({
      harness: 'opencode',
      skills: [{ name: 'kept', path: path.join(skillsRoot, 'kept') }],
      mcpServers: [{ name: 'alpha-console', configPath: deepConfigPath, harness: 'opencode', configuredAt: new Date().toISOString(), fields }],
    })
    const trackedMcpFields = [
      { configPath: deepConfigPath, server: 'alpha-console', field: 'url', expectedDigest: fields.url },
      { configPath: deepConfigPath, server: 'alpha-console', field: 'headers', expectedDigest: fields.headers },
    ]
    const tarball = writeBundleTarball({
      name: 'nsolid-plugin',
      version: '1.0.1',
      skills: [{ name: 'kept', path: 'skills/kept', description: 'kept' }],
      mcpServers: [{ name: 'nsolid-console', url: 'https://example.com/mcp', headers: {} }],
    })
    const installation = buildInstallation({
      harness: 'opencode',
      tarball,
      trackedSkills: [{ name: 'kept', path: path.join(skillsRoot, 'kept') }],
      trackedMcpConfigPath: deepConfigPath,
      trackedMcpNames: ['alpha-console'],
      trackedMcpFields,
    })

    // Linux plans the conditional frontier: the parent cannot prove the
    // config render is a no-op, so the frontier is carried as conditional
    // evidence and never marked inactive. Non-linux hosts already assert the
    // fail-closed platform rejection in the forced-win32 phase below, so the
    // manifest assertions here are Linux-only.
    const linuxPlanned = await planOrRejectOnNonLinux(installation)
    if (linuxPlanned.planningError !== undefined) return
    assert.equal(linuxPlanned.planningError, undefined)
    assert.deepEqual(readManifest(linuxPlanned).plannedMissingFrontiers, [{
      frontierPath: path.join(home, 'custom', 'deep'),
      activation: 'conditional',
      anchor: anchorIdentityOfFixture(path.join(home, 'custom')),
      leaves: [
        // Sorted union index 1: the canonical ~/.config/opencode/opencode.jsonc
        // leaf sorts before custom/... and is a missing leaf (parent exists).
        { id: 'mcp-config:1', role: 'mcp-config', activation: 'conditional', path: deepConfigPath },
      ],
    }])

    // An unsupported platform must not infer frontier inactivity from that
    // mutable plan state: the same conditional frontier fails the plan closed
    // before any manifest workspace exists.
    const platformDescriptor = Object.getOwnPropertyDescriptor(process, 'platform')!
    Object.defineProperty(process, 'platform', { value: 'win32' })
    try {
      const rejected = await planFixture(installation)
      assert.equal(rejected.planningError?.code, 'FALLBACK_PARENT_CREATION_UNSUPPORTED')
      assert.ok(rejected.planningError?.message.includes(path.join(home, 'custom', 'deep')))
      assert.equal(rejected.steps.length, 0)
      assert.equal(rejected.temporaryDirectories, undefined)
    } finally {
      Object.defineProperty(process, 'platform', platformDescriptor)
    }
  })
})

describe('fallback change summary', () => {
  function sampleBundle (): object {
    return {
      name: 'nsolid-plugin',
      version: '90.0.0',
      skills: [
        { name: 'kept', path: 'skills/kept', description: 'kept' },
        { name: 'brand-new', path: 'skills/brand-new', description: 'brand-new' },
      ],
      mcpServers: [
        { name: 'nsolid-console', url: 'https://example.com/mcp', headers: {} },
        { name: 'brand-new-mcp', url: 'https://example.com/mcp2', headers: {} },
      ],
    }
  }

  function writeTarball (directory: string, name: string, bytes: Buffer): string {
    const tarball = path.join(directory, name)
    writeFileSync(tarball, bytes)
    return tarball
  }

  it('summarizes skill and MCP diffs from the verified tarball bundle', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'nsolid-plugin-changes-'))
    try {
      const tarball = writeTarball(dir, 'artifact.tgz', gzipSync(Buffer.concat([
        tarEntry('package/', undefined, '5'),
        tarEntry('package/bundle.json', Buffer.from(JSON.stringify(sampleBundle())), '0'),
        Buffer.alloc(1024),
      ])))

      const { summarizeFallbackChanges } = await import('../../../src/update/strategies/fallback.js')
      const summary = await summarizeFallbackChanges(
        {
          metadata: {
            trackedSkills: [{ name: 'kept', path: '/tmp/kept' }, { name: 'dropped', path: '/tmp/dropped' }],
            trackedMcpNames: ['nsolid-console', 'dropped-mcp'],
          },
        } as never,
        tarball
      )
      assert.deepEqual(summary, {
        skillsAdded: ['brand-new'],
        skillsRemoved: ['dropped'],
        skillsUpdated: 1,
        mcpAdded: ['brand-new-mcp'],
        mcpRemoved: ['dropped-mcp'],
        mcpUpdated: 1,
      })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  for (const hostile of [true, false]) {
    it(hostile ? 'never executes a PATH-resolved tar' : 'summarizes without any tar on PATH', async () => {
      const dir = mkdtempSync(path.join(tmpdir(), 'nsolid-plugin-changes-'))
      const previousPath = process.env.PATH
      try {
        const hostileBin = path.join(dir, 'hostile-bin')
        if (hostile) {
          mkdirSync(hostileBin)
          const fakeTar = path.join(hostileBin, 'tar')
          writeFileSync(fakeTar, '#!/bin/sh\nprintf "TAMPERED"\n')
          chmodSync(fakeTar, 0o755)
        }
        const tarball = writeTarball(dir, 'artifact.tgz', gzipSync(Buffer.concat([
          tarEntry('package/bundle.json', Buffer.from(JSON.stringify(sampleBundle())), '0'),
          Buffer.alloc(1024),
        ])))
        process.env.PATH = hostile ? hostileBin : ''
        const { summarizeFallbackChanges } = await import('../../../src/update/strategies/fallback.js')
        const summary = await summarizeFallbackChanges({ metadata: { trackedSkills: [], trackedMcpNames: [] } } as never, tarball)
        assert.deepEqual(summary, {
          skillsAdded: ['kept', 'brand-new'],
          skillsRemoved: [],
          skillsUpdated: 0,
          mcpAdded: ['nsolid-console', 'brand-new-mcp'],
          mcpRemoved: [],
          mcpUpdated: 0,
        }, 'the summary must come from the archive bytes, never from a PATH lookup')
      } finally {
        if (previousPath === undefined) delete process.env.PATH
        else process.env.PATH = previousPath
        rmSync(dir, { recursive: true, force: true })
      }
    })
  }

  it('never blocks planning when the tarball cannot be read', async () => {
    const { summarizeFallbackChanges } = await import('../../../src/update/strategies/fallback.js')
    const summary = await summarizeFallbackChanges({ metadata: { trackedSkills: [], trackedMcpNames: [] } } as never, '/nonexistent/artifact.tgz')
    assert.equal(summary, undefined)
  })

  it('never blocks planning when the tarball is not a tar archive', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'nsolid-plugin-changes-'))
    try {
      const tarball = writeTarball(dir, 'garbage.tgz', Buffer.from('definitely not a tar archive'))
      const { summarizeFallbackChanges } = await import('../../../src/update/strategies/fallback.js')
      assert.equal(await summarizeFallbackChanges({ metadata: { trackedSkills: [], trackedMcpNames: [] } } as never, tarball), undefined)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
