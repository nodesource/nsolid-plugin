import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { CommandResult, CommandRunner, CommandSpec, ResolvedArtifactIdentity } from '../../../src/update/types.js'
import { executeClaudeTransaction, installedClaudePayloadRoot, restoreClaudeNativeState } from '../../../src/update/claude-transaction.js'
import type { OwnedPathKind } from '../../../src/update/fs-transaction.js'
import { nativePayloadDigest } from '../../../src/update/native-evidence.js'

// Windows chmod only toggles the read-only bit: a writable file reports mode
// 0o666, so 0600 is not observable there. Assert the strongest mode contract
// each platform can express.
const privateFileMode = process.platform === 'win32' ? 0o666 : 0o600

interface Fixture {
  home: string
  registryPath: string
  marketplacesPath: string
  payloadRoot: string
  payloadDigest: string
  registryBytes: string
}

function setupInstallation (): Fixture {
  const home = mkdtempSync(path.join(os.tmpdir(), 'nsolid-claude-transaction-'))
  const pluginsDir = path.join(home, '.claude', 'plugins')
  const payloadRoot = path.join(home, '.claude', 'plugins', 'cache', 'nsolid-plugin', '1.0.0')
  mkdirSync(path.join(payloadRoot, 'skills', 'example'), { recursive: true })
  writeFileSync(path.join(payloadRoot, 'bundle.json'), '{"version":"1.0.0"}\n')
  writeFileSync(path.join(payloadRoot, 'skills', 'example', 'SKILL.md'), '# v1.0.0\n')
  mkdirSync(pluginsDir, { recursive: true })
  const registryPath = path.join(pluginsDir, 'installed_plugins.json')
  const registryBytes = JSON.stringify({
    plugins: {
      'nsolid-plugin@nodesource': [{ version: '1.0.0', installPath: payloadRoot, scope: 'user' }],
    },
  }) + '\n'
  writeFileSync(registryPath, registryBytes)
  const marketplacesPath = path.join(pluginsDir, 'known_marketplaces.json')
  writeFileSync(marketplacesPath, '{"nodesource":{"source":"github.com/NodeSource/nsolid-plugin"}}\n')
  return { home, registryPath, marketplacesPath, payloadRoot, payloadDigest: nativePayloadDigest(payloadRoot)!, registryBytes }
}

function sha256 (value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex')
}

const okResult: CommandResult = { exitCode: 0, stdout: '', stderr: '', timedOut: false }
const failedResult: CommandResult = { exitCode: 1, stdout: '', stderr: 'boom', timedOut: false }

function runner (behavior: (spec: CommandSpec, index: number) => Promise<CommandResult> | CommandResult): CommandRunner & { commands: CommandSpec[] } {
  const commands: CommandSpec[] = []
  let index = 0
  return {
    commands,
    async run (spec: CommandSpec) {
      commands.push(spec)
      return behavior(spec, index++)
    },
  }
}

function recoveryDeps (fixture: Fixture): { recoveryRoot: string, deps: { allocateWorkspace: () => string } } {
  const recoveryRoot = path.join(fixture.home, 'recovery-root')
  return { recoveryRoot, deps: { allocateWorkspace: () => recoveryRoot } }
}

function makeArtifact (fixture: Fixture): ResolvedArtifactIdentity {
  return { kind: 'git', repository: 'https://github.com/NodeSource/nsolid-plugin', commit: 'a'.repeat(40), contentDigest: fixture.payloadDigest, payloadPath: '' }
}

describe('Claude native replacement transaction', () => {
  it('restores registration records and payload bytes when a command fails', async () => {
    const fixture = setupInstallation()
    try {
      // The first command "installs" a new version; the second one fails.
      const newPayload = path.join(fixture.home, '.claude', 'plugins', 'cache', 'nsolid-plugin', '1.0.1')
      const runnerStub = runner((_spec, index) => {
        if (index === 0) {
          mkdirSync(path.join(newPayload, 'skills', 'example'), { recursive: true })
          writeFileSync(path.join(newPayload, 'bundle.json'), '{"version":"1.0.1"}\n')
          writeFileSync(path.join(newPayload, 'skills', 'example', 'SKILL.md'), '# v1.0.1\n')
          const registry = JSON.parse(readFileSync(fixture.registryPath, 'utf8')) as { plugins: Record<string, Array<Record<string, unknown>>> }
          registry.plugins['nsolid-plugin@nodesource'] = [{ version: '1.0.1', installPath: newPayload, scope: 'user' }]
          writeFileSync(fixture.registryPath, JSON.stringify(registry) + '\n')
          return okResult
        }
        return failedResult
      })

      const result = await executeClaudeTransaction({
        commands: [{ executable: 'claude', args: ['one'], timeoutMs: 1_000 }, { executable: 'claude', args: ['two'], timeoutMs: 1_000 }],
        registrationPaths: [fixture.registryPath, fixture.marketplacesPath],
        configPath: fixture.registryPath,
        pluginId: 'nsolid-plugin@nodesource',
        scope: 'user',
        expectedVersion: '1.0.1',
      }, runnerStub)

      assert.equal(result.success, false)
      assert.equal(result.rollbackAttempted, true)
      assert.equal(result.rollbackSucceeded, true)
      assert.equal(result.error?.code, 'CLAUDE_COMMAND_FAILED')
      // The new payload directory is gone and the old bytes are back.
      assert.equal(existsSync(newPayload), false)
      assert.equal(readFileSync(fixture.registryPath, 'utf8'), fixture.registryBytes)
      assert.equal(readFileSync(path.join(fixture.payloadRoot, 'skills/example/SKILL.md'), 'utf8'), '# v1.0.0\n')
    } finally {
      rmSync(fixture.home, { recursive: true, force: true })
    }
  })

  it('rejects an exit-zero update that removes unrelated registry and enabled-plugin entries', async () => {
    const fixture = setupInstallation()
    const claudeConfigPath = path.join(fixture.home, '.claude.json')
    const registry = JSON.parse(readFileSync(fixture.registryPath, 'utf8')) as { plugins: Record<string, unknown> }
    registry.plugins['other-plugin@vendor'] = [{ version: '3.0.0', installPath: path.join(fixture.home, 'other'), scope: 'user' }]
    const registryWithForeign = JSON.stringify(registry) + '\n'
    const configWithForeign = JSON.stringify({ enabledPlugins: { 'nsolid-plugin@nodesource': true, 'other-plugin@vendor': true }, theme: 'dark' }) + '\n'
    writeFileSync(fixture.registryPath, registryWithForeign)
    writeFileSync(claudeConfigPath, configWithForeign)
    try {
      const result = await executeClaudeTransaction({
        commands: [{ executable: 'claude', args: ['update'], timeoutMs: 1_000 }],
        registrationPaths: [fixture.registryPath, fixture.marketplacesPath, claudeConfigPath],
        configPath: fixture.registryPath,
        pluginId: 'nsolid-plugin@nodesource',
        scope: 'user',
        expectedVersion: '1.0.0',
      }, runner(() => {
        const nextRegistry = JSON.parse(readFileSync(fixture.registryPath, 'utf8')) as { plugins: Record<string, unknown> }
        delete nextRegistry.plugins['other-plugin@vendor']
        writeFileSync(fixture.registryPath, JSON.stringify(nextRegistry) + '\n')
        writeFileSync(claudeConfigPath, JSON.stringify({ enabledPlugins: { 'nsolid-plugin@nodesource': true }, theme: 'dark' }) + '\n')
        return okResult
      }))

      assert.equal(result.success, false)
      assert.equal(result.error?.code, 'CLAUDE_FOREIGN_STATE_CHANGED')
      assert.equal(result.rollbackSucceeded, true)
      assert.equal(readFileSync(fixture.registryPath, 'utf8'), registryWithForeign)
      assert.equal(readFileSync(claudeConfigPath, 'utf8'), configWithForeign)
    } finally {
      rmSync(fixture.home, { recursive: true, force: true })
    }
  })

  it('accepts a successful update that preserves unrelated registry and enabled-plugin entries', async () => {
    const fixture = setupInstallation()
    const claudeConfigPath = path.join(fixture.home, '.claude.json')
    const registry = JSON.parse(readFileSync(fixture.registryPath, 'utf8')) as { plugins: Record<string, unknown> }
    registry.plugins['other-plugin@vendor'] = [{ version: '3.0.0', installPath: path.join(fixture.home, 'other'), scope: 'user' }]
    writeFileSync(fixture.registryPath, JSON.stringify(registry) + '\n')
    writeFileSync(claudeConfigPath, JSON.stringify({ enabledPlugins: { 'nsolid-plugin@nodesource': true, 'other-plugin@vendor': true } }) + '\n')
    try {
      const result = await executeClaudeTransaction({
        commands: [{ executable: 'claude', args: ['update'], timeoutMs: 1_000 }],
        registrationPaths: [fixture.registryPath, fixture.marketplacesPath, claudeConfigPath],
        configPath: fixture.registryPath,
        pluginId: 'nsolid-plugin@nodesource',
        scope: 'user',
        expectedVersion: '1.0.0',
      }, runner(() => okResult))

      assert.equal(result.success, true)
      assert.match(readFileSync(fixture.registryPath, 'utf8'), /other-plugin@vendor/)
      assert.match(readFileSync(claudeConfigPath, 'utf8'), /other-plugin@vendor/)
    } finally {
      rmSync(fixture.home, { recursive: true, force: true })
    }
  })

  it('reports CLAUDE_CONTENT_MISMATCH and rolls back when the installed payload diverges', async () => {
    const fixture = setupInstallation()
    try {
      const artifact = makeArtifact(fixture)
      const runnerStub = runner(() => {
        // The plugin update "succeeded" but rewrote the payload differently.
        writeFileSync(path.join(fixture.payloadRoot, 'skills/example/SKILL.md'), '# rewritten\n')
        return okResult
      })

      const result = await executeClaudeTransaction({
        commands: [{ executable: 'claude', args: ['update'], timeoutMs: 1_000 }],
        registrationPaths: [fixture.registryPath, fixture.marketplacesPath],
        configPath: fixture.registryPath,
        pluginId: 'nsolid-plugin@nodesource',
        scope: 'user',
        expectedVersion: '1.0.0',
        artifact,
      }, runnerStub)

      assert.equal(result.success, false)
      assert.equal(result.error?.code, 'CLAUDE_CONTENT_MISMATCH')
      assert.equal(result.rollbackSucceeded, true)
      assert.equal(readFileSync(path.join(fixture.payloadRoot, 'skills/example/SKILL.md'), 'utf8'), '# v1.0.0\n')
      assert.equal(nativePayloadDigest(fixture.payloadRoot), fixture.payloadDigest)
    } finally {
      rmSync(fixture.home, { recursive: true, force: true })
    }
  })

  it('completes successfully when the installed payload matches the planned digest', async () => {
    const fixture = setupInstallation()
    try {
      const runnerStub = runner(() => okResult)
      const result = await executeClaudeTransaction({
        commands: [{ executable: 'claude', args: ['marketplace'], timeoutMs: 1_000 }, { executable: 'claude', args: ['update'], timeoutMs: 1_000 }],
        registrationPaths: [fixture.registryPath, fixture.marketplacesPath],
        configPath: fixture.registryPath,
        pluginId: 'nsolid-plugin@nodesource',
        scope: 'user',
        expectedVersion: '1.0.0',
        artifact: makeArtifact(fixture),
      }, runnerStub)

      assert.equal(result.success, true)
      assert.equal(result.rollbackAttempted, false)
      assert.equal(nativePayloadDigest(fixture.payloadRoot), fixture.payloadDigest)
    } finally {
      rmSync(fixture.home, { recursive: true, force: true })
    }
  })

  it('never restores from a partial backup: backup failure aborts before any mutation', async () => {
    const fixture = setupInstallation()
    try {
      const runnerStub = runner(() => okResult)
      // A partially completed copy that then explodes: the backup container
      // holds content but is not recoverable evidence.
      const partialCopy = async (_source: string, destination: string): Promise<OwnedPathKind> => {
        writeFileSync(path.join(destination, 'bundle.json'), '{"version":"0.0.1"}\n')
        throw new Error('EIO: copy failed midway')
      }

      const result = await executeClaudeTransaction({
        commands: [{ executable: 'claude', args: ['marketplace'], timeoutMs: 1_000 }],
        registrationPaths: [fixture.registryPath, fixture.marketplacesPath],
        configPath: fixture.registryPath,
        pluginId: 'nsolid-plugin@nodesource',
        scope: 'user',
        expectedVersion: '1.0.0',
        artifact: makeArtifact(fixture),
      }, runnerStub, { copyOwnedPath: partialCopy })

      assert.equal(result.success, false)
      assert.equal(result.error?.code, 'CLAUDE_BACKUP_FAILED')
      assert.equal(result.rollbackAttempted, false)
      // The command phase never started.
      assert.equal(runnerStub.commands.length, 0)
      // Live bytes are untouched.
      assert.equal(readFileSync(path.join(fixture.payloadRoot, 'skills/example/SKILL.md'), 'utf8'), '# v1.0.0\n')
      assert.equal(readFileSync(fixture.registryPath, 'utf8'), fixture.registryBytes)
      // The partial backup container was removed: it is not recoverable evidence.
      const siblings = readdirSync(path.dirname(fixture.payloadRoot)).filter((name) => name.includes('.nsolid-payload-backup-'))
      assert.deepEqual(siblings, [])
    } finally {
      rmSync(fixture.home, { recursive: true, force: true })
    }
  })

  it('defers rollback when a timeout leaves descendant termination unconfirmed', async () => {
    const fixture = setupInstallation()
    try {
      // First command installs a new version; the second times out without
      // confirmed tree termination. Restoring now would race live writers.
      const runnerStub = runner((_spec, index) => {
        if (index === 0) {
          writeFileSync(path.join(fixture.payloadRoot, 'skills/example/SKILL.md'), '# mid-flight\n')
          return okResult
        }
        return { exitCode: null, stdout: '', stderr: '', timedOut: true, treeTerminated: false }
      })

      const result = await executeClaudeTransaction({
        commands: [{ executable: 'claude', args: ['update'], timeoutMs: 1_000 }, { executable: 'claude', args: ['update'], timeoutMs: 1_000 }],
        registrationPaths: [fixture.registryPath, fixture.marketplacesPath],
        configPath: fixture.registryPath,
        pluginId: 'nsolid-plugin@nodesource',
        scope: 'user',
        expectedVersion: '1.0.1',
      }, runnerStub)

      assert.equal(result.success, false)
      assert.equal(result.error?.code, 'CLAUDE_TREE_TERMINATION_UNCONFIRMED')
      assert.equal(result.rollbackAttempted, false)
      // The live bytes were left alone and the backup remains recoverable.
      assert.equal(readFileSync(path.join(fixture.payloadRoot, 'skills/example/SKILL.md'), 'utf8'), '# mid-flight\n')
      const siblings = readdirSync(path.dirname(fixture.payloadRoot)).filter((name) => name.includes('.nsolid-payload-backup-'))
      assert.equal(siblings.length, 1)
    } finally {
      rmSync(fixture.home, { recursive: true, force: true })
    }
  })

  it('refuses to restore when the payload backup changed after its initial verification', async () => {
    const fixture = setupInstallation()
    try {
      const runnerStub = runner((_spec, index) => {
        if (index === 0) {
          // The failed update rewrites the live payload.
          writeFileSync(path.join(fixture.payloadRoot, 'skills/example/SKILL.md'), '# mid-flight\n')
          return okResult
        }
        // The already-verified backup is tampered before the rollback runs.
        // The backup container wraps the copied payload tree one level down.
        const cacheDir = path.dirname(fixture.payloadRoot)
        const containers = readdirSync(cacheDir).filter((name) => name.includes('.nsolid-payload-backup-'))
        if (containers.length !== 1) throw new Error('payload backup sibling missing')
        const container = path.join(cacheDir, containers[0])
        const backupSkill = readdirSync(container, { recursive: true }).map(String).find((rel) => rel.endsWith('SKILL.md'))
        if (!backupSkill) throw new Error('backup SKILL.md missing')
        writeFileSync(path.join(container, backupSkill), '# tampered\n')
        return failedResult
      })

      const result = await executeClaudeTransaction({
        commands: [{ executable: 'claude', args: ['marketplace'], timeoutMs: 1_000 }, { executable: 'claude', args: ['update'], timeoutMs: 1_000 }],
        registrationPaths: [fixture.registryPath, fixture.marketplacesPath],
        configPath: fixture.registryPath,
        pluginId: 'nsolid-plugin@nodesource',
        scope: 'user',
        expectedVersion: '1.0.1',
      }, runnerStub)

      assert.equal(result.success, false)
      // The tampered backup must never be restored or reported as success.
      assert.equal(result.rollbackSucceeded, false)
      assert.equal(result.error?.code, 'CLAUDE_ROLLBACK_FAILED')
      // The live payload was NOT overwritten with tampered bytes.
      assert.equal(readFileSync(path.join(fixture.payloadRoot, 'skills/example/SKILL.md'), 'utf8'), '# mid-flight\n')
      // The recovery evidence stays preserved for human recovery.
      assert.ok(result.recoveryPath)
    } finally {
      rmSync(fixture.home, { recursive: true, force: true })
    }
  })

  it('restores registration files with mode 0600 even when the live file had wider permissions', async () => {
    const fixture = setupInstallation()
    try {
      chmodSync(fixture.registryPath, 0o644)
      const runnerStub = runner(() => failedResult)

      const result = await executeClaudeTransaction({
        commands: [{ executable: 'claude', args: ['marketplace'], timeoutMs: 1_000 }],
        registrationPaths: [fixture.registryPath, fixture.marketplacesPath],
        configPath: fixture.registryPath,
        pluginId: 'nsolid-plugin@nodesource',
        scope: 'user',
        expectedVersion: '1.0.0',
      }, runnerStub)

      assert.equal(result.success, false)
      assert.equal(result.rollbackSucceeded, true)
      // The restored registration evidence keeps the private mode even
      // though the live file existed with 0644 before the restore.
      assert.equal(statSync(fixture.registryPath).mode & 0o777, privateFileMode)
      assert.equal(readFileSync(fixture.registryPath, 'utf8'), fixture.registryBytes)
    } finally {
      rmSync(fixture.home, { recursive: true, force: true })
    }
  })

  it('restores registration files with mode 0600 regardless of the process umask', async () => {
    const fixture = setupInstallation()
    try {
      // The on-disk backup is created before the restrictive umask window so
      // only the restore write itself runs under it.
      const backupPath = `${fixture.registryPath}.rollback-backup`
      writeFileSync(backupPath, fixture.registryBytes, { mode: 0o600 })
      const registration = [{
        path: fixture.registryPath,
        existed: true,
        bytes: Buffer.from(fixture.registryBytes),
        digest: sha256(fixture.registryBytes),
        backupPath,
        postDigest: sha256(readFileSync(fixture.registryPath)),
      }]
      const previousUmask = process.umask(0o277)
      try {
        // open(2) creation modes are umask-filtered: the restored file must
        // still carry the exact private mode afterwards.
        const restored = await restoreClaudeNativeState({} as Parameters<typeof restoreClaudeNativeState>[0], registration)
        assert.equal(restored, true)
        assert.equal(statSync(fixture.registryPath).mode & 0o777, privateFileMode)
        assert.equal(readFileSync(fixture.registryPath, 'utf8'), fixture.registryBytes)
      } finally {
        process.umask(previousUmask)
      }
    } finally {
      rmSync(fixture.home, { recursive: true, force: true })
    }
  })

  it('restores the original payload when the failed update removed the registration entirely', async () => {
    const fixture = setupInstallation()
    try {
      const runnerStub = runner((_spec, index) => {
        if (index === 0) {
          // A failed native update can unregister the plugin and remove the
          // payload directory outright.
          rmSync(fixture.payloadRoot, { recursive: true, force: true })
          const registry = JSON.parse(fixture.registryBytes) as { plugins: Record<string, unknown> }
          delete registry.plugins['nsolid-plugin@nodesource']
          writeFileSync(fixture.registryPath, JSON.stringify(registry) + '\n')
          return okResult
        }
        return failedResult
      })

      const result = await executeClaudeTransaction({
        commands: [{ executable: 'claude', args: ['update'], timeoutMs: 1_000 }, { executable: 'claude', args: ['update'], timeoutMs: 1_000 }],
        registrationPaths: [fixture.registryPath, fixture.marketplacesPath],
        configPath: fixture.registryPath,
        pluginId: 'nsolid-plugin@nodesource',
        scope: 'user',
      }, runnerStub)

      assert.equal(result.success, false)
      assert.equal(result.rollbackAttempted, true)
      assert.equal(result.rollbackSucceeded, true)
      // Registration and payload both came back from the backup.
      assert.equal(readFileSync(fixture.registryPath, 'utf8'), fixture.registryBytes)
      assert.equal(nativePayloadDigest(fixture.payloadRoot), fixture.payloadDigest)
      assert.equal(readFileSync(path.join(fixture.payloadRoot, 'skills/example/SKILL.md'), 'utf8'), '# v1.0.0\n')
    } finally {
      rmSync(fixture.home, { recursive: true, force: true })
    }
  })

  it('refuses to restore over concurrent drift and reports CLAUDE_ROLLBACK_FAILED', async () => {
    const fixture = setupInstallation()
    try {
      // The failed transaction left the payload rewritten (authorized state).
      writeFileSync(path.join(fixture.payloadRoot, 'skills/example/SKILL.md'), '# drifted-in-flight\n')
      // ...but then a concurrent writer changed it again before the restore.
      const registration = [{
        path: fixture.registryPath,
        existed: true,
        bytes: Buffer.from(fixture.registryBytes),
        digest: sha256(fixture.registryBytes),
        postDigest: sha256(readFileSync(fixture.registryPath)),
      }]
      const payload = {
        root: fixture.payloadRoot,
        kind: 'directory' as const,
        postRoot: fixture.payloadRoot,
        postDigest: sha256('not-even-the-transaction-state'),
      }
      const restored = await restoreClaudeNativeState(payload, registration)
      assert.equal(restored, false)
      // The drifted bytes are untouched.
      assert.equal(readFileSync(path.join(fixture.payloadRoot, 'skills/example/SKILL.md'), 'utf8'), '# drifted-in-flight\n')
    } finally {
      rmSync(fixture.home, { recursive: true, force: true })
    }
  })

  it('preserves a complete recovery bundle when tree termination stays unconfirmed', async () => {
    const fixture = setupInstallation()
    const { recoveryRoot, deps } = recoveryDeps(fixture)
    try {
      const marketplacesBytes = readFileSync(fixture.marketplacesPath)
      const runnerStub = runner((_spec, index) => {
        if (index === 0) {
          writeFileSync(path.join(fixture.payloadRoot, 'skills/example/SKILL.md'), '# mid-flight\n')
          return okResult
        }
        return { exitCode: null, stdout: '', stderr: '', timedOut: true, treeTerminated: false }
      })

      const result = await executeClaudeTransaction({
        commands: [{ executable: 'claude', args: ['update'], timeoutMs: 1_000 }, { executable: 'claude', args: ['update'], timeoutMs: 1_000 }],
        registrationPaths: [fixture.registryPath, fixture.marketplacesPath],
        configPath: fixture.registryPath,
        pluginId: 'nsolid-plugin@nodesource',
        scope: 'user',
        expectedVersion: '1.0.1',
      }, runnerStub, deps)

      assert.equal(result.success, false)
      assert.equal(result.error?.code, 'CLAUDE_TREE_TERMINATION_UNCONFIRMED')
      assert.equal(result.rollbackAttempted, false)
      assert.equal(result.recoveryPath, recoveryRoot)
      const manifestFile = path.join(recoveryRoot, 'recovery.json')
      assert.equal(existsSync(manifestFile), true)
      const manifest = JSON.parse(readFileSync(manifestFile, 'utf8')) as {
        version: number,
        complete: boolean,
        createdAt: string,
        registration: Array<{ path: string, existed: boolean, digest?: string, backup?: string }>,
        payload?: { backupPath?: string },
      }
      assert.equal(manifest.complete, true)
      assert.equal(typeof manifest.createdAt, 'string')
      assert.equal(manifest.registration.length, 2)
      assert.equal(manifest.registration[0].path, fixture.registryPath)
      assert.equal(manifest.registration[0].existed, true)
      assert.equal(manifest.registration[0].digest, sha256(fixture.registryBytes))
      assert.equal(manifest.registration[0].backup, path.join('registration', '0000.bin'))
      const backup0 = path.join(recoveryRoot, 'registration', '0000.bin')
      const backup1 = path.join(recoveryRoot, 'registration', '0001.bin')
      assert.equal(existsSync(backup0), true)
      assert.equal(existsSync(backup1), true)
      assert.equal(statSync(backup0).mode & 0o777, privateFileMode)
      assert.equal(readFileSync(backup0).equals(Buffer.from(fixture.registryBytes)), true)
      assert.equal(readFileSync(backup1).equals(marketplacesBytes), true)
      // The manifest references the separately allocated same-volume payload backup.
      const payloadSiblings = readdirSync(path.dirname(fixture.payloadRoot)).filter((name) => name.includes('.nsolid-payload-backup-'))
      assert.equal(payloadSiblings.length, 1)
      assert.equal(manifest.payload?.backupPath, path.join(path.dirname(fixture.payloadRoot), payloadSiblings[0], path.basename(fixture.payloadRoot)))
    } finally {
      rmSync(fixture.home, { recursive: true, force: true })
    }
  })

  it('keeps the recovery bundle when the drift gate rejects the rollback', async () => {
    const fixture = setupInstallation()
    const { recoveryRoot, deps } = recoveryDeps(fixture)
    try {
      const registryBytesBefore = fixture.registryBytes
      const runnerStub = runner((_spec, index) => {
        if (index === 0) {
          writeFileSync(path.join(fixture.payloadRoot, 'skills/example/SKILL.md'), '# mutated-by-update\n')
          return okResult
        }
        return failedResult
      })

      const result = await executeClaudeTransaction({
        commands: [{ executable: 'claude', args: ['install'], timeoutMs: 1_000 }, { executable: 'claude', args: ['validate'], timeoutMs: 1_000 }],
        registrationPaths: [fixture.registryPath, fixture.marketplacesPath],
        configPath: fixture.registryPath,
        pluginId: 'nsolid-plugin@nodesource',
        scope: 'user',
      }, runnerStub, { ...deps, restoreState: async () => false })

      assert.equal(result.success, false)
      assert.equal(result.rollbackAttempted, true)
      assert.equal(result.rollbackSucceeded, false)
      assert.equal(result.error?.code, 'CLAUDE_ROLLBACK_FAILED')
      assert.equal(result.recoveryPath, recoveryRoot)
      assert.equal(existsSync(path.join(recoveryRoot, 'recovery.json')), true)
      const backup0 = path.join(recoveryRoot, 'registration', '0000.bin')
      assert.equal(existsSync(backup0), true)
      assert.equal(statSync(backup0).mode & 0o777, privateFileMode)
      assert.equal(sha256(readFileSync(backup0)), sha256(registryBytesBefore))
      const payloadSiblings = readdirSync(path.dirname(fixture.payloadRoot)).filter((name) => name.includes('.nsolid-payload-backup-'))
      assert.equal(payloadSiblings.length, 1)
      // The drifted live bytes are untouched.
      assert.equal(readFileSync(path.join(fixture.payloadRoot, 'skills/example/SKILL.md'), 'utf8'), '# mutated-by-update\n')
    } finally {
      rmSync(fixture.home, { recursive: true, force: true })
    }
  })

  it('removes the recovery bundle after a successful update', async () => {
    const fixture = setupInstallation()
    const { recoveryRoot, deps } = recoveryDeps(fixture)
    try {
      const runnerStub = runner(() => okResult)
      const result = await executeClaudeTransaction({
        commands: [{ executable: 'claude', args: ['marketplace'], timeoutMs: 1_000 }, { executable: 'claude', args: ['update'], timeoutMs: 1_000 }],
        registrationPaths: [fixture.registryPath, fixture.marketplacesPath],
        configPath: fixture.registryPath,
        pluginId: 'nsolid-plugin@nodesource',
        scope: 'user',
        expectedVersion: '1.0.0',
        artifact: makeArtifact(fixture),
      }, runnerStub, deps)

      assert.equal(result.success, true)
      assert.equal(result.recoveryPath, undefined)
      assert.equal(existsSync(recoveryRoot), false)
      const payloadSiblings = readdirSync(path.dirname(fixture.payloadRoot)).filter((name) => name.includes('.nsolid-payload-backup-'))
      assert.deepEqual(payloadSiblings, [])
    } finally {
      rmSync(fixture.home, { recursive: true, force: true })
    }
  })

  it('removes the recovery bundle after a verified rollback', async () => {
    const fixture = setupInstallation()
    const { recoveryRoot, deps } = recoveryDeps(fixture)
    try {
      const runnerStub = runner((_spec, index) => {
        if (index === 0) {
          writeFileSync(path.join(fixture.payloadRoot, 'skills/example/SKILL.md'), '# rewritten\n')
          return okResult
        }
        return failedResult
      })

      const result = await executeClaudeTransaction({
        commands: [{ executable: 'claude', args: ['install'], timeoutMs: 1_000 }, { executable: 'claude', args: ['validate'], timeoutMs: 1_000 }],
        registrationPaths: [fixture.registryPath, fixture.marketplacesPath],
        configPath: fixture.registryPath,
        pluginId: 'nsolid-plugin@nodesource',
        scope: 'user',
      }, runnerStub, deps)

      assert.equal(result.success, false)
      assert.equal(result.rollbackAttempted, true)
      assert.equal(result.rollbackSucceeded, true)
      assert.equal(result.recoveryPath, undefined)
      assert.equal(existsSync(recoveryRoot), false)
      const payloadSiblings = readdirSync(path.dirname(fixture.payloadRoot)).filter((name) => name.includes('.nsolid-payload-backup-'))
      assert.deepEqual(payloadSiblings, [])
      assert.equal(readFileSync(path.join(fixture.payloadRoot, 'skills/example/SKILL.md'), 'utf8'), '# v1.0.0\n')
      assert.equal(readFileSync(fixture.registryPath, 'utf8'), fixture.registryBytes)
    } finally {
      rmSync(fixture.home, { recursive: true, force: true })
    }
  })

  it('aborts before any command when the recovery bundle cannot be written', async () => {
    const fixture = setupInstallation()
    try {
      // An allocator pointing inside a regular file makes every bundle write fail.
      const blocker = path.join(fixture.home, 'blocker')
      writeFileSync(blocker, 'not a directory\n')
      const runnerStub = runner(() => okResult)

      const result = await executeClaudeTransaction({
        commands: [{ executable: 'claude', args: ['marketplace'], timeoutMs: 1_000 }],
        registrationPaths: [fixture.registryPath, fixture.marketplacesPath],
        configPath: fixture.registryPath,
        pluginId: 'nsolid-plugin@nodesource',
        scope: 'user',
        expectedVersion: '1.0.0',
        artifact: makeArtifact(fixture),
      }, runnerStub, { allocateWorkspace: () => path.join(blocker, 'recovery') })

      assert.equal(result.success, false)
      assert.equal(result.error?.code, 'CLAUDE_BACKUP_FAILED')
      assert.equal(result.rollbackAttempted, false)
      assert.equal(result.recoveryPath, undefined)
      // The command phase never started.
      assert.equal(runnerStub.commands.length, 0)
      // Live bytes are untouched.
      assert.equal(readFileSync(path.join(fixture.payloadRoot, 'skills/example/SKILL.md'), 'utf8'), '# v1.0.0\n')
      assert.equal(readFileSync(fixture.registryPath, 'utf8'), fixture.registryBytes)
      // Every partial recovery artifact was removed.
      const payloadSiblings = readdirSync(path.dirname(fixture.payloadRoot)).filter((name) => name.includes('.nsolid-payload-backup-'))
      assert.deepEqual(payloadSiblings, [])
    } finally {
      rmSync(fixture.home, { recursive: true, force: true })
    }
  })

  it('records missing registration paths in the recovery manifest without fabricating backups', async () => {
    const fixture = setupInstallation()
    const { recoveryRoot, deps } = recoveryDeps(fixture)
    try {
      const missingPath = path.join(fixture.home, '.claude', 'plugins', 'absent.json')
      const runnerStub = runner((_spec, index) => {
        if (index === 0) {
          writeFileSync(path.join(fixture.payloadRoot, 'skills/example/SKILL.md'), '# mid-flight\n')
          return okResult
        }
        return { exitCode: null, stdout: '', stderr: '', timedOut: true, treeTerminated: false }
      })

      const result = await executeClaudeTransaction({
        commands: [{ executable: 'claude', args: ['update'], timeoutMs: 1_000 }, { executable: 'claude', args: ['update'], timeoutMs: 1_000 }],
        registrationPaths: [fixture.registryPath, fixture.marketplacesPath, missingPath],
        configPath: fixture.registryPath,
        pluginId: 'nsolid-plugin@nodesource',
        scope: 'user',
        expectedVersion: '1.0.1',
      }, runnerStub, deps)

      assert.equal(result.error?.code, 'CLAUDE_TREE_TERMINATION_UNCONFIRMED')
      assert.equal(result.recoveryPath, recoveryRoot)
      const manifest = JSON.parse(readFileSync(path.join(recoveryRoot, 'recovery.json'), 'utf8')) as {
        registration: Array<{ path: string, existed: boolean, digest?: string, backup?: string }>,
      }
      assert.equal(manifest.registration.length, 3)
      assert.deepEqual(manifest.registration[2], { path: missingPath, existed: false })
      assert.deepEqual(readdirSync(path.join(recoveryRoot, 'registration')).sort(), ['0000.bin', '0001.bin'])
    } finally {
      rmSync(fixture.home, { recursive: true, force: true })
    }
  })

  it('resolves the single installed payload root for a scoped plugin', async () => {
    const fixture = setupInstallation()
    try {
      assert.equal(installedClaudePayloadRoot(fixture.registryPath, 'nsolid-plugin@nodesource', 'user'), fixture.payloadRoot)
      assert.equal(installedClaudePayloadRoot(fixture.registryPath, 'nsolid-plugin@nodesource', 'project'), undefined)
      assert.equal(installedClaudePayloadRoot(fixture.registryPath, 'other-plugin@x', 'user'), undefined)
      assert.equal(installedClaudePayloadRoot(undefined, 'nsolid-plugin@nodesource', 'user'), undefined)
    } finally {
      rmSync(fixture.home, { recursive: true, force: true })
    }
  })
})
