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
import { applyFallbackEntry, fallbackJournalPath, pathDigest, pathKind, registerFallbackStage, trackingDigest } from '../../../src/update/fallback-journal.js'
import { valueDigest } from '../../../src/update/mcp-lookup.js'
import { readTrackingFile, writeTrackingFile } from '../../../src/skills/skill-tracker.js'
import { getHarnessSkillsPath } from '../../../src/skills/skill-linker.js'
import { getSkillsDir, resolveHome } from '../../../src/utils/path.js'
import { recordContainmentDirectoryIdentity } from '../../../src/update/fallback-result-protocol.js'
import type { FallbackTransactionIdentity, UpdatePlanItem, UpdateResult } from '../../../src/update/types.js'

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
      ownedSkills: [await pathEvidence(skillPath)],
      ownedLinks: [await pathEvidence(path.join(getHarnessSkillsPath('claude'), 'tracked'))],
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

describe('fallback strategy structured child result', () => {
  let home: string
  let previousHome: string | undefined
  let previousUserProfile: string | undefined

  beforeEach(() => {
    home = mkdtempSync(path.join(tmpdir(), 'nsolid-plugin-fallback-result-'))
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
      nonce: randomUUID(),
      ownedSkills: [await pathEvidence(skillPath)],
      ownedLinks: [await pathEvidence(path.join(getHarnessSkillsPath('claude'), 'tracked'))],
      ownedMcpFields: [],
      ownedMcpConfigPaths: [resolveHome('~/.claude.json')],
      approvedDestinationRoots: [getSkillsDir(), getHarnessSkillsPath('claude')].map((value) => path.resolve(value)),
    }
    const manifestDir = mkdtempSync(path.join(tmpdir(), 'nsolid-plugin-manifest-'))
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
  }

  /** Simulate the real child: it reads the nonce from its own manifest and publishes the structured envelope. */
  function childWritesEnvelope (build: (nonce: string) => Record<string, unknown>): (child: ChildContext) => { exitCode: number; stdout: string; stderr: string; timedOut: boolean } {
    return (child) => {
      if (child.resultPath && child.manifestPath) {
        const nonce = (JSON.parse(readFileSync(child.manifestPath, 'utf8')) as { nonce: string }).nonce
        writeFileSync(child.resultPath, JSON.stringify(build(nonce)), { mode: 0o600 })
      }
      return { exitCode: 1, stdout: '', stderr: 'Fallback refresh failed\nrollback: not-attempted\n', timedOut: false }
    }
  }

  async function execute (fixture: ResultFixture, runner: (child: ChildContext) => { exitCode: number; stdout: string; stderr: string; timedOut: boolean } & Record<string, unknown>) {
    return fallbackStrategy.execute(fixture.item, {
      options: {},
      commandRunner: {
        run: async (command) => {
          const args = command.args ?? []
          const at = (flag: string): string | undefined => {
            const index = args.indexOf(flag)
            return index >= 0 ? args[index + 1] : undefined
          }
          return runner({ resultPath: at('--result'), manifestPath: at('--transaction') }) as { exitCode: number; stdout: string; stderr: string; timedOut: boolean }
        }
      },
    })
  }

  it('surfaces the child MCP_RECONCILIATION_REQUIRED code instead of the generic fallback failure', async () => {
    const fixture = await setupResultFixture()
    const result = await execute(fixture, childWritesEnvelope((nonce) => ({
      schema: 1,
      nonce,
      code: 'MCP_RECONCILIATION_REQUIRED',
      rollback: { attempted: false },
    })))

    assert.equal(result.status, 'failed')
    assert.equal(result.error?.code, 'MCP_RECONCILIATION_REQUIRED')
    assert.ok(result.error?.message.includes('nsolid-plugin setup --harness claude'), 'the approved recovery guidance must name the planned harness, not a hardcoded one')
    // The parent journal exists, so its verified recovery outcome — not the
    // child envelope claim — is the public rollback state.
    assert.deepEqual(result.rollback, { attempted: true, succeeded: true })
    assert.equal(readFileSync(path.join(fixture.skillPath, 'SKILL.md'), 'utf8'), 'old tracked', 'the reconciliation failure must not mutate owned state')
    assert.equal(existsSync(fixture.resultPath), false, 'the structured result must be removed during normal workspace cleanup')
    assert.equal(existsSync(fixture.manifestDir), false)
    const serialized = JSON.stringify(result)
    const parsed = JSON.parse(serialized) as UpdateResult
    assert.deepEqual(JSON.parse(JSON.stringify(parsed)), parsed, 'the parent result must remain exactly one stable JSON document')
  })

  it('never publishes child-controlled text carried inside the envelope', async () => {
    const fixture = await setupResultFixture()
    const result = await execute(fixture, childWritesEnvelope((nonce) => ({
      schema: 1,
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
      const quiet = childWritesEnvelope((nonce) => ({ schema: 1, nonce, code: 'FALLBACK_MCP_DRIFT', rollback: { attempted: false } }))(child)
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
    const result = await execute(fixture, () => ({ exitCode: 1, stdout: '', stderr: 'refresh failed\n', timedOut: false }))
    assert.equal(result.error?.code, 'FALLBACK_COMMAND_FAILED')
    assert.equal(result.error?.message, 'Fallback refresh command failed')
  })

  it('fails safe when the result file is malformed JSON', async () => {
    const fixture = await setupResultFixture()
    const result = await execute(fixture, (child) => {
      if (child.resultPath) writeFileSync(child.resultPath, 'not json', { mode: 0o600 })
      return { exitCode: 1, stdout: '', stderr: 'refresh failed\n', timedOut: false }
    })
    assert.equal(result.error?.code, 'FALLBACK_COMMAND_FAILED')
  })

  it('fails safe when the result file exceeds the bounded size', async () => {
    const fixture = await setupResultFixture()
    const result = await execute(fixture, childWritesEnvelope((nonce) => ({ schema: 1, nonce, code: 'MCP_RECONCILIATION_REQUIRED', pad: 'x'.repeat(8192) })))
    assert.equal(result.error?.code, 'FALLBACK_COMMAND_FAILED')
  })

  it('fails safe on a stale result bound to a different transaction nonce', async () => {
    const fixture = await setupResultFixture()
    const result = await execute(fixture, childWritesEnvelope(() => ({ schema: 1, nonce: randomUUID(), code: 'MCP_RECONCILIATION_REQUIRED' })))
    assert.equal(result.error?.code, 'FALLBACK_COMMAND_FAILED')
  })

  it('fails safe on an unknown child code', async () => {
    const fixture = await setupResultFixture()
    const result = await execute(fixture, childWritesEnvelope((nonce) => ({ schema: 1, nonce, code: 'TOTALLY_UNKNOWN_CODE' })))
    assert.equal(result.error?.code, 'FALLBACK_COMMAND_FAILED')
  })

  it('fails safe on an unsafe child code shape', async () => {
    const fixture = await setupResultFixture()
    const result = await execute(fixture, childWritesEnvelope((nonce) => ({ schema: 1, nonce, code: 'bad code' })))
    assert.equal(result.error?.code, 'FALLBACK_COMMAND_FAILED')
  })

  it('fails safe on a schema-version skew', async () => {
    const fixture = await setupResultFixture()
    const result = await execute(fixture, childWritesEnvelope((nonce) => ({ schema: 99, nonce, code: 'MCP_RECONCILIATION_REQUIRED' })))
    assert.equal(result.error?.code, 'FALLBACK_COMMAND_FAILED')
  })

  it('fails safe on a malformed rollback shape', async () => {
    const fixture = await setupResultFixture()
    const result = await execute(fixture, childWritesEnvelope((nonce) => ({ schema: 1, nonce, code: 'MCP_RECONCILIATION_REQUIRED', rollback: { attempted: 1 } })))
    assert.equal(result.error?.code, 'FALLBACK_COMMAND_FAILED')
  })

  it('fails safe when the result path is a symlink', async () => {
    const fixture = await setupResultFixture()
    const realDir = mkdtempSync(path.join(tmpdir(), 'nsolid-plugin-result-real-'))
    const realTarget = path.join(realDir, 'real.json')
    const nonce = fixture.identity.nonce
    writeFileSync(realTarget, JSON.stringify({ schema: 1, nonce, code: 'MCP_RECONCILIATION_REQUIRED' }), { mode: 0o600 })
    rmSync(fixture.resultPath, { force: true })
    symlinkSync(realTarget, fixture.resultPath)
    const result = await execute(fixture, () => ({ exitCode: 1, stdout: '', stderr: 'refresh failed\n', timedOut: false }))
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
        return { exitCode: 0, stdout: '', stderr: '', timedOut: false }
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
    // First execution: an unconfirmed-termination timeout preserves the
    // transaction workspace, and the child still publishes a structured
    // envelope before timing out.
    const first = await execute(fixture, (child) => {
      if (child.resultPath !== undefined) observedResultPaths.push(child.resultPath)
      const quiet = childWritesEnvelope((nonce) => ({ schema: 1, nonce, code: 'MCP_RECONCILIATION_REQUIRED' }))(child)
      return { ...quiet, timedOut: true }
    })
    assert.equal(first.error?.code, 'FALLBACK_TREE_TERMINATION_UNCONFIRMED')
    // Second execution of the SAME item: the fresh per-execution result path
    // must differ, and the first-run envelope must never surface.
    const second = await execute(fixture, (child) => {
      if (child.resultPath !== undefined) observedResultPaths.push(child.resultPath)
      return { exitCode: 1, stdout: '', stderr: 'refresh failed\n', timedOut: false }
    })
    assert.equal(second.error?.code, 'FALLBACK_COMMAND_FAILED', 'the second execution must not replay the first envelope')
    assert.equal(observedResultPaths.length, 2, 'both executions must receive an explicit result path')
    assert.notEqual(observedResultPaths[0], observedResultPaths[1], 'each execution must use a fresh result location')
  })

  it('fails safe when the planned result path escapes the parent-owned workspace', async () => {
    const fixture = await setupResultFixture()
    const foreignDir = mkdtempSync(path.join(tmpdir(), 'nsolid-plugin-result-foreign-'))
    const foreignResult = path.join(foreignDir, 'result.json')
    const nonce = fixture.identity.nonce
    writeFileSync(foreignResult, JSON.stringify({ schema: 1, nonce, code: 'MCP_RECONCILIATION_REQUIRED' }), { mode: 0o600 })
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
    const result = await execute(fixture, () => ({ exitCode: 1, stdout: '', stderr: 'refresh failed\n', timedOut: false }))
    assert.equal(result.error?.code, 'FALLBACK_COMMAND_FAILED', 'a result outside the parent-owned workspace must never be trusted')
    // The parent must also never DELETE a file it did not create: the stale-
    // result cleanup is bound to the recorded containment identity.
    assert.equal(existsSync(foreignResult), true, 'the escape attempt must leave the foreign file untouched')
    rmSync(foreignDir, { recursive: true, force: true })
  })

  it('fails safe when the plan item carries no transaction to bind the nonce', async () => {
    const fixture = await setupResultFixture()
    delete (fixture.item as { fallbackTransaction?: unknown }).fallbackTransaction
    const result = await execute(fixture, childWritesEnvelope((nonce) => ({ schema: 1, nonce, code: 'MCP_RECONCILIATION_REQUIRED' })))
    assert.equal(result.error?.code, 'FALLBACK_COMMAND_FAILED')
  })

  it('lets parent journal recovery stay authoritative over the child rollback claim', async () => {
    // The child claims its rollback FAILED, but the parent journal recovers
    // successfully: the public state must follow the verified parent outcome,
    // so the structured child code (not FALLBACK_ROLLBACK_FAILED) is reported.
    {
      const fixture = await setupResultFixture()
      const result = await execute(fixture, childWritesEnvelope((nonce) => ({ schema: 1, nonce, code: 'MCP_RECONCILIATION_REQUIRED', rollback: { attempted: true, succeeded: false } })))
      assert.equal(result.error?.code, 'MCP_RECONCILIATION_REQUIRED')
      assert.deepEqual(result.rollback, { attempted: true, succeeded: true })
    }
    // The child claims its rollback SUCCEEDED, but parent recovery verifiably
    // fails (a tampered backup aborts the restore preflight): the public state
    // must report the rollback failure the parent actually observed.
    {
      const fixture = await setupResultFixture()
      const result = await execute(fixture, (child) => {
        const outcome = childWritesEnvelope((nonce) => ({ schema: 1, nonce, code: 'MCP_RECONCILIATION_REQUIRED', rollback: { attempted: true, succeeded: true } }))(child)
        // Between the child failure and parent recovery, corrupt one journaled
        // backup so the parent restore preflight provably fails.
        const journal = JSON.parse(readFileSync(fallbackJournalPath(fixture.identity.trackingPath), 'utf8')) as { entries: Array<{ backup?: string }> }
        const backup = journal.entries.find((entry) => entry.backup)?.backup
        assert.ok(backup, 'the fixture journal must hold at least one backup')
        if (statSync(backup).isDirectory()) writeFileSync(path.join(backup, '__tampered__'), 'tampered')
        else writeFileSync(backup, 'tampered')
        return outcome
      })
      assert.equal(result.error?.code, 'FALLBACK_ROLLBACK_FAILED')
      assert.equal(result.error?.message, 'Fallback refresh command failed and its rollback was incomplete')
      assert.deepEqual(result.rollback, { attempted: true, succeeded: false })
    }
  })

  it('keeps FALLBACK_COMMAND_TIMEOUT precedence when the confirmed timeout carries a structured result', async () => {
    const fixture = await setupResultFixture()
    const result = await execute(fixture, (child) => {
      const quiet = childWritesEnvelope((nonce) => ({ schema: 1, nonce, code: 'MCP_RECONCILIATION_REQUIRED' }))(child)
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
    writeFileSync(fixture.resultPath, JSON.stringify({ schema: 1, nonce: fixture.identity.nonce, code: 'MCP_RECONCILIATION_REQUIRED', rollback: { attempted: false } }), { mode: 0o600 })
    const result = await execute(fixture, () => ({ exitCode: 1, stdout: '', stderr: 'refresh failed\n', timedOut: false }))
    assert.equal(result.error?.code, 'FALLBACK_COMMAND_FAILED', 'the stale envelope must not surface its structured code')
    // (The planned-path file may still be removed as part of the parent-owned
    // manifest workspace cleanup; the fresh-path design means it was never
    // READ, which is the property under test.)
  })

  it('keeps unconfirmed tree termination precedence and preserves recovery artifacts', async () => {
    const fixture = await setupResultFixture()
    const result = await execute(fixture, (child) => {
      const quiet = childWritesEnvelope((nonce) => ({ schema: 1, nonce, code: 'MCP_RECONCILIATION_REQUIRED' }))(child)
      return { ...quiet, timedOut: true }
    })
    assert.equal(result.error?.code, 'FALLBACK_TREE_TERMINATION_UNCONFIRMED')
    assert.equal(existsSync(fixture.manifestDir), true, 'recovery artifacts must be preserved for the unconfirmed case')
    rmSync(fixture.manifestDir, { recursive: true, force: true })
  })

  it('keeps MISSING_EXECUTABLE precedence when the spawn fails with a structured result present', async () => {
    const fixture = await setupResultFixture()
    const result = await execute(fixture, (child) => {
      const quiet = childWritesEnvelope((nonce) => ({ schema: 1, nonce, code: 'MCP_RECONCILIATION_REQUIRED' }))(child)
      return { ...quiet, spawnErrorCode: 'ENOENT' }
    })
    assert.equal(result.error?.code, 'MISSING_EXECUTABLE')
  })

  it('stays compatible with older children that publish no structured result', async () => {
    {
      const fixture = await setupResultFixture()
      const result = await execute(fixture, () => ({ exitCode: 1, stdout: '', stderr: 'Fallback MCP state changed but valid credentials are unavailable\nrollback: not-attempted\n', timedOut: false }))
      assert.equal(result.error?.code, 'FALLBACK_COMMAND_FAILED')
      assert.equal(result.error?.message, 'Fallback refresh command failed')
    }
    // legacy stdout/stderr rollback parsing still works
    {
      const fixture = await setupResultFixture()
      const result = await execute(fixture, () => ({ exitCode: 1, stdout: '', stderr: 'refresh failed\nrollback: succeeded\n', timedOut: false }))
      assert.equal(result.error?.code, 'FALLBACK_COMMAND_FAILED')
      assert.deepEqual(result.rollback, { attempted: true, succeeded: true })
    }
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
    assert.equal(parsed.status, 'failed')
    // The structured child code and the parent-owned safe message are public
    // state (rendered by --json, the human summary, and verbose diagnostics).
    assert.equal(parsed.error?.code, 'MCP_RECONCILIATION_REQUIRED')
    assert.ok(parsed.error?.message.includes('nsolid-plugin setup --harness claude'), 'the approved recovery guidance must name the planned harness')
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

describe('fallback change summary', () => {
  /** Minimal ustar builder so fixture creation never depends on a system tar. */
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

  it('never executes a PATH-resolved tar: a hostile PATH cannot change the summary', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'nsolid-plugin-changes-'))
    const previousPath = process.env.PATH
    try {
      const hostileBin = path.join(dir, 'hostile-bin')
      mkdirSync(hostileBin)
      const fakeTar = path.join(hostileBin, 'tar')
      writeFileSync(fakeTar, '#!/bin/sh\nprintf "TAMPERED"\n')
      chmodSync(fakeTar, 0o755)
      const tarball = writeTarball(dir, 'artifact.tgz', gzipSync(Buffer.concat([
        tarEntry('package/bundle.json', Buffer.from(JSON.stringify(sampleBundle())), '0'),
        Buffer.alloc(1024),
      ])))
      process.env.PATH = hostileBin
      const { summarizeFallbackChanges } = await import('../../../src/update/strategies/fallback.js')
      const summary = await summarizeFallbackChanges(
        { metadata: { trackedSkills: [], trackedMcpNames: [] } } as never,
        tarball
      )
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

  it('summarizes without any tar on PATH', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'nsolid-plugin-changes-'))
    const previousPath = process.env.PATH
    try {
      const tarball = writeTarball(dir, 'artifact.tgz', gzipSync(Buffer.concat([
        tarEntry('package/bundle.json', Buffer.from(JSON.stringify(sampleBundle())), '0'),
        Buffer.alloc(1024),
      ])))
      process.env.PATH = ''
      const { summarizeFallbackChanges } = await import('../../../src/update/strategies/fallback.js')
      const summary = await summarizeFallbackChanges({ metadata: { trackedSkills: [], trackedMcpNames: [] } } as never, tarball)
      assert.deepEqual(summary, {
        skillsAdded: ['kept', 'brand-new'],
        skillsRemoved: [],
        skillsUpdated: 0,
        mcpAdded: ['nsolid-console', 'brand-new-mcp'],
        mcpRemoved: [],
        mcpUpdated: 0,
      })
    } finally {
      if (previousPath === undefined) delete process.env.PATH
      else process.env.PATH = previousPath
      rmSync(dir, { recursive: true, force: true })
    }
  })

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
