import { afterEach, beforeEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { claudeStrategy } from '../../../src/update/strategies/claude.js'
import { codexStrategy } from '../../../src/update/strategies/codex.js'
import { piStrategy } from '../../../src/update/strategies/pi.js'
import { antigravityStrategy } from '../../../src/update/strategies/antigravity.js'
import type { UpdateInstallation, UpdateSource } from '../../../src/update/types.js'
import { nativePayloadDigest } from '../../../src/update/native-evidence.js'

let previousPath: string | undefined
let previousPathExt: string | undefined
let previousHome: string | undefined
let previousUserProfile: string | undefined
let evidenceRoot: string
let evidenceSequence = 0

beforeEach(() => {
  previousPath = process.env.PATH
  previousPathExt = process.env.PATHEXT
  previousHome = process.env.HOME
  previousUserProfile = process.env.USERPROFILE
  evidenceRoot = mkdtempSync(path.join(os.tmpdir(), 'nsolid-strategy-evidence-'))
})

afterEach(() => {
  rmSync(evidenceRoot, { recursive: true, force: true })
  if (previousPath === undefined) delete process.env.PATH
  else process.env.PATH = previousPath
  if (previousPathExt === undefined) delete process.env.PATHEXT
  else process.env.PATHEXT = previousPathExt
  if (previousHome === undefined) delete process.env.HOME
  else process.env.HOME = previousHome
  if (previousUserProfile === undefined) delete process.env.USERPROFILE
  else process.env.USERPROFILE = previousUserProfile
})

function installation (target: UpdateInstallation['target'], source: UpdateSource): UpdateInstallation {
  const evidencePath = path.join(evidenceRoot, `${target}-${evidenceSequence++}.json`)
  const evidence = JSON.stringify({ target, source })
  writeFileSync(evidencePath, evidence)
  return {
    installationId: `${target}:native:nsolid-plugin@nodesource`,
    target,
    ownership: target === 'pi' ? 'package-owned' : 'native-plugin',
    installed: true,
    source,
    version: { current: undefined, latest: '1.0.1', status: 'update-available' },
    metadata: {
      nativeEvidence: [{ path: evidencePath, digest: createHash('sha256').update(evidence).digest('hex') }],
    },
  }
}

function context () {
  return {
    options: {},
    commandRunner: { run: async () => ({ exitCode: 0, stdout: '', stderr: '', timedOut: false }) },
  }
}

function writeVerifiedLauncher (directory: string, name: string): string {
  const executable = path.join(directory, process.platform === 'win32' ? `${name}.exe` : name)
  writeFileSync(executable, process.platform === 'win32' ? '' : '#!/bin/sh\nexit 0\n', { mode: 0o755 })
  if (process.platform === 'win32') process.env.PATHEXT = '.EXE;.COM;.CMD;.BAT'
  return executable
}

// Windows is case-insensitive: PATHEXT (.EXE) + NTFS resolution may return a
// different case than the path the fixture wrote (.exe). Compare accordingly.
function normalizeExecutable (p: string): string {
  return process.platform === 'win32' ? p.toLowerCase() : p
}

function assertSameExecutable (actual: string, expected: string): void {
  assert.equal(normalizeExecutable(actual), normalizeExecutable(expected))
}

function assertNativeIdentity (identity: unknown, exe: string): void {
  assert.ok(identity !== null && typeof identity === 'object')
  const id = identity as { kind?: string; executable?: string }
  assert.equal(id.kind, 'native')
  assertSameExecutable(id.executable ?? '', exe)
}

function claudeSource (): UpdateSource {
  return {
    kind: 'claude-marketplace',
    pluginId: 'nsolid-plugin@nodesource',
    marketplace: 'nodesource',
    scope: 'user',
    versionSource: {
      kind: 'git',
      repository: 'https://github.com/NodeSource/nsolid-plugin.git',
      revision: 'bc9c87e6ce6ca73756dc20fdd41a3219bcd5b60c',
      commit: 'bc9c87e6ce6ca73756dc20fdd41a3219bcd5b60c',
      manifestPath: 'bundle.json',
    },
  }
}

function codexSource (): UpdateSource {
  return {
    kind: 'codex-marketplace',
    pluginId: 'nsolid-plugin@nodesource',
    marketplace: 'nodesource',
    versionSource: {
      kind: 'git',
      repository: 'https://github.com/NodeSource/nsolid-plugin.git',
      revision: 'bc9c87e6ce6ca73756dc20fdd41a3219bcd5b60c',
      commit: 'bc9c87e6ce6ca73756dc20fdd41a3219bcd5b60c',
      manifestPath: 'bundle.json',
    },
  }
}

function antigravitySource (): UpdateSource {
  return {
    kind: 'antigravity-git',
    url: 'https://github.com/NodeSource/nsolid-plugin.git',
    layout: { kind: 'shared', pluginRoot: '~/.gemini/config/plugins/nsolid-plugin', manifestPath: '~/.gemini/config/import_manifest.json' },
  }
}

function piInstallation (root: string, source: UpdateSource): UpdateInstallation {
  const candidate = installation('pi', source)
  const tarballPath = path.join(root, 'nsolid-pi-plugin-1.0.1.tgz')
  writeFileSync(tarballPath, 'verified tarball fixture')
  candidate.artifact = {
    kind: 'npm',
    packageName: 'nsolid-pi-plugin',
    version: '1.0.1',
    registry: 'https://registry.npmjs.org/',
    tarball: 'https://registry.npmjs.org/nsolid-pi-plugin/-/nsolid-pi-plugin-1.0.1.tgz',
    tarballPath,
    integrity: 'sha512-dGVzdA==',
  }
  const packageRoot = path.join(root, 'npm', 'node_modules', 'nsolid-pi-plugin')
  const evidencePath = path.join(root, 'npm', 'package-lock.json')
  mkdirSync(packageRoot, { recursive: true })
  writeFileSync(path.join(packageRoot, 'package.json'), JSON.stringify({ name: 'nsolid-pi-plugin', version: '1.0.0' }))
  writeFileSync(evidencePath, JSON.stringify({
    packages: {
      'node_modules/nsolid-pi-plugin': {
        name: 'nsolid-pi-plugin',
        version: '1.0.0',
        resolved: 'https://registry.npmjs.org/nsolid-pi-plugin/-/nsolid-pi-plugin-1.0.0.tgz',
        integrity: 'sha512-dGVzdA==',
      },
    },
  }))
  candidate.metadata = { ...candidate.metadata, packageRoots: [packageRoot], packageEvidencePaths: [evidencePath] }
  return candidate
}

describe('harness strategies degrade unsupported launchers at plan time', () => {
  it('native strategies reject a mutable marketplace source that cannot honor the resolved commit', async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'nsolid-strategy-unpinned-'))
    writeVerifiedLauncher(root, 'claude')
    writeVerifiedLauncher(root, 'codex')
    process.env.PATH = root
    try {
      for (const [strategy, target, source] of [
        [claudeStrategy, 'claude', claudeSource()],
        [codexStrategy, 'codex', codexSource()],
      ] as const) {
        if (source.kind !== 'claude-marketplace' && source.kind !== 'codex-marketplace') continue
        source.versionSource = {
          kind: 'git',
          repository: 'https://github.com/NodeSource/nsolid-plugin.git',
          revision: 'main',
          commit: 'bc9c87e6ce6ca73756dc20fdd41a3219bcd5b60c',
          manifestPath: 'bundle.json',
        }
        const candidate = installation(target, source)
        candidate.artifact = {
          kind: 'git',
          repository: 'https://github.com/NodeSource/nsolid-plugin.git',
          commit: 'bc9c87e6ce6ca73756dc20fdd41a3219bcd5b60c',
          contentDigest: 'planned-content',
        }

        const item = await strategy.plan(candidate, context())
        assert.equal(item.steps.length, 0, target)
        assert.equal(item.planningError?.code, 'NATIVE_SOURCE_NOT_PINNED', target)
      }
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('native strategies refuse to plan when no immutable artifact pins the source', async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'nsolid-strategy-no-artifact-'))
    writeVerifiedLauncher(root, 'claude')
    writeVerifiedLauncher(root, 'codex')
    process.env.PATH = root
    try {
      for (const [strategy, target, source] of [
        [claudeStrategy, 'claude', claudeSource()],
        [codexStrategy, 'codex', codexSource()],
      ] as const) {
        const candidate = installation(target, source)
        // No resolved artifact at all: a marketplace mutation must never be
        // authorized without one.
        const item = await strategy.plan(candidate, context())
        assert.equal(item.steps.length, 0, target)
        assert.equal(item.planningError?.code, 'NATIVE_SOURCE_NOT_PINNED', target)
      }
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('native strategies refuse to plan for an unsupported artifact class', async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'nsolid-strategy-bad-artifact-'))
    writeVerifiedLauncher(root, 'claude')
    process.env.PATH = root
    try {
      const candidate = installation('claude', claudeSource())
      candidate.artifact = { kind: 'tarball', url: 'https://example.com/x.tgz' } as never
      const item = await claudeStrategy.plan(candidate, context())
      assert.equal(item.steps.length, 0)
      assert.equal(item.planningError?.code, 'NATIVE_SOURCE_NOT_PINNED')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('refuses native execution when marketplace records changed after planning', async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'nsolid-strategy-drift-'))
    writeVerifiedLauncher(root, 'claude')
    process.env.PATH = root
    try {
      const candidate = installation('claude', claudeSource())
      // The source is legitimately pinned: only the evidence drifts below.
      candidate.artifact = {
        kind: 'git',
        repository: 'https://github.com/NodeSource/nsolid-plugin.git',
        commit: 'bc9c87e6ce6ca73756dc20fdd41a3219bcd5b60c',
        contentDigest: 'planned-content',
      }
      const item = await claudeStrategy.plan(candidate, context())
      writeFileSync(candidate.metadata!.nativeEvidence![0].path, '{"revision":"main"}')
      let commands = 0
      const result = await claudeStrategy.execute(item, {
        options: {},
        commandRunner: { run: async () => { commands++; return { exitCode: 0, stdout: '', stderr: '', timedOut: false } } },
      })

      assert.equal(result.status, 'failed')
      assert.equal(result.error?.code, 'NATIVE_SOURCE_DRIFT')
      assert.equal(commands, 0)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('native execution refuses to run commands when the planned item lost its artifact', async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'nsolid-strategy-execute-unpinned-'))
    writeVerifiedLauncher(root, 'claude')
    process.env.PATH = root
    try {
      const candidate = installation('claude', claudeSource())
      candidate.artifact = {
        kind: 'git',
        repository: 'https://github.com/NodeSource/nsolid-plugin.git',
        commit: 'bc9c87e6ce6ca73756dc20fdd41a3219bcd5b60c',
        contentDigest: 'planned-content',
      }
      const item = await claudeStrategy.plan(candidate, context())
      assert.equal(item.planningError, undefined)
      // Simulate an item reaching execution without its immutable identity.
      const unpinned = { ...item, artifact: undefined }
      let commands = 0
      const result = await claudeStrategy.execute(unpinned, {
        options: {},
        commandRunner: { run: async () => { commands++; return { exitCode: 0, stdout: '', stderr: '', timedOut: false } } },
      })

      assert.equal(result.status, 'failed')
      assert.equal(result.error?.code, 'NATIVE_SOURCE_NOT_PINNED')
      assert.equal(commands, 0)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('claude: plans a spawn-safe command with embedded identity for a verified launcher', async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'nsolid-strategy-claude-'))
    const exe = writeVerifiedLauncher(root, 'claude')
    process.env.PATH = root
    try {
      const candidate = installation('claude', claudeSource())
      // A pinned marketplace plan carries the resolved immutable artifact.
      candidate.artifact = {
        kind: 'git',
        repository: 'https://github.com/NodeSource/nsolid-plugin.git',
        commit: 'bc9c87e6ce6ca73756dc20fdd41a3219bcd5b60c',
        contentDigest: 'planned-content',
      }
      const item = await claudeStrategy.plan(candidate, context())
      assert.equal(item.planningError, undefined)
      const commands = item.steps.filter((step) => step.kind === 'command')
      assert.equal(commands.length, 2)
      for (const step of commands) {
        if (step.kind !== 'command') continue
        assertSameExecutable(step.command.executable, exe)
        assertNativeIdentity(step.command.executableIdentity, exe)
      }
      assert.deepEqual(commands.map((step) => (step.kind === 'command' ? step.command.args : [])), [
        ['plugin', 'marketplace', 'update', 'nodesource'],
        ['plugin', 'update', 'nsolid-plugin@nodesource', '--scope', 'user'],
      ])
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('claude: degrades an unverifiable launcher to planningError + manualCommands', async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'nsolid-strategy-claude-'))
    writeFileSync(path.join(root, 'claude'), 'not executable\n', { mode: 0o644 })
    process.env.PATH = root
    try {
      const candidate = installation('claude', claudeSource())
      candidate.artifact = {
        kind: 'git',
        repository: 'https://github.com/NodeSource/nsolid-plugin.git',
        commit: 'bc9c87e6ce6ca73756dc20fdd41a3219bcd5b60c',
        contentDigest: 'planned-content',
      }
      const item = await claudeStrategy.plan(candidate, context())
      assert.equal(item.steps.length, 0)
      assert.equal(item.planningError?.code, 'UNSAFE_HARNESS_LAUNCHER')
      assert.deepEqual(item.manualCommands, [
        'claude plugin marketplace update nodesource',
        'claude plugin update nsolid-plugin@nodesource --scope user',
      ])
      const result = await claudeStrategy.execute(item, context())
      assert.equal(result.status, 'failed')
      assert.equal(result.error?.code, 'UNSAFE_HARNESS_LAUNCHER')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('claude: validates the newly registered versioned payload after update', async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'nsolid-strategy-claude-update-'))
    const bin = path.join(root, 'bin')
    const oldPayload = path.join(root, '.claude', 'plugins', 'cache', 'nodesource', 'nsolid-plugin', '1.0.0')
    const newPayload = path.join(root, '.claude', 'plugins', 'cache', 'nodesource', 'nsolid-plugin', '1.0.1')
    const installedPath = path.join(root, '.claude', 'plugins', 'installed_plugins.json')
    const newBundle = JSON.stringify({ name: 'nsolid-plugin', version: '1.0.1' })
    mkdirSync(bin, { recursive: true })
    mkdirSync(oldPayload, { recursive: true })
    mkdirSync(newPayload, { recursive: true })
    writeVerifiedLauncher(bin, 'claude')
    writeFileSync(path.join(oldPayload, 'bundle.json'), JSON.stringify({ name: 'nsolid-plugin', version: '1.0.0' }))
    writeFileSync(path.join(newPayload, 'bundle.json'), newBundle)
    process.env.PATH = bin
    process.env.HOME = root
    process.env.USERPROFILE = root
    try {
      const candidate = installation('claude', claudeSource())
      candidate.metadata = { ...candidate.metadata, packageRoot: oldPayload, configPath: installedPath }
      candidate.artifact = {
        kind: 'git',
        repository: 'https://github.com/NodeSource/nsolid-plugin.git',
        commit: 'bc9c87e6ce6ca73756dc20fdd41a3219bcd5b60c',
        contentDigest: nativePayloadDigest(newPayload)!,
      }
      const item = await claudeStrategy.plan(candidate, context())
      const result = await claudeStrategy.execute(item, {
        ...context(),
        commandRunner: {
          run: async (command) => {
            if (command.args[1] === 'update') {
              writeFileSync(installedPath, JSON.stringify({
                version: 2,
                plugins: {
                  'nsolid-plugin@nodesource': [{ scope: 'user', installPath: newPayload, version: '1.0.1' }],
                },
              }))
            }
            return { exitCode: 0, stdout: '', stderr: '', timedOut: false }
          },
        },
      })

      assert.equal(result.status, 'updated')
      assert.equal(result.resultingVersion, '1.0.1')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('claude: uses inventory-compatible scope fields during payload validation', async () => {
    for (const scopeField of ['installationScope', 'metadata'] as const) {
      const root = mkdtempSync(path.join(os.tmpdir(), `nsolid-strategy-claude-${scopeField}-`))
      const bin = path.join(root, 'bin')
      const newPayload = path.join(root, '.claude', 'plugins', 'cache', 'nodesource', 'nsolid-plugin', '1.0.1')
      const installedPath = path.join(root, '.claude', 'plugins', 'installed_plugins.json')
      const newBundle = JSON.stringify({ name: 'nsolid-plugin', version: '1.0.1' })
      mkdirSync(bin, { recursive: true })
      mkdirSync(newPayload, { recursive: true })
      writeVerifiedLauncher(bin, 'claude')
      writeFileSync(path.join(newPayload, 'bundle.json'), newBundle)
      process.env.PATH = bin
      process.env.HOME = root
      process.env.USERPROFILE = root
      try {
        const candidate = installation('claude', claudeSource())
        candidate.metadata = { ...candidate.metadata, configPath: installedPath }
        candidate.artifact = {
          kind: 'git',
          repository: 'https://github.com/NodeSource/nsolid-plugin.git',
          commit: 'bc9c87e6ce6ca73756dc20fdd41a3219bcd5b60c',
          contentDigest: nativePayloadDigest(newPayload)!,
        }
        const item = await claudeStrategy.plan(candidate, context())
        const result = await claudeStrategy.execute(item, {
          ...context(),
          commandRunner: {
            run: async (command) => {
              if (command.args[1] === 'update') {
                const registration = {
                  ...(scopeField === 'installationScope' ? { installationScope: 'user' } : { metadata: { scope: 'user' } }),
                  installPath: newPayload,
                  version: '1.0.1',
                }
                writeFileSync(installedPath, JSON.stringify({ plugins: { 'nsolid-plugin@nodesource': [registration] } }))
              }
              return { exitCode: 0, stdout: '', stderr: '', timedOut: false }
            },
          },
        })

        assert.equal(result.status, 'updated', scopeField)
      } finally {
        rmSync(root, { recursive: true, force: true })
      }
    }
  })

  it('codex: resolves the launcher once and shares the identity across all three commands', async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'nsolid-strategy-codex-'))
    const exe = writeVerifiedLauncher(root, 'codex')
    process.env.PATH = root
    try {
      const candidate = installation('codex', codexSource())
      const configPath = path.join(root, 'config.toml')
      const cachePath = path.join(root, 'plugins', 'cache', 'nodesource', 'nsolid-plugin')
      mkdirSync(cachePath, { recursive: true })
      writeFileSync(configPath, '')
      candidate.metadata = { ...candidate.metadata, configPath, packageRoot: cachePath }
      candidate.artifact = {
        kind: 'git',
        repository: 'https://github.com/NodeSource/nsolid-plugin.git',
        commit: 'bc9c87e6ce6ca73756dc20fdd41a3219bcd5b60c',
        contentDigest: 'planned-content',
      }
      const item = await codexStrategy.plan(candidate, context())
      assert.equal(item.planningError, undefined)
      const commands = item.steps.filter((step) => step.kind === 'command')
      assert.equal(commands.length, 3)
      for (const step of commands) {
        if (step.kind !== 'command') continue
        assertSameExecutable(step.command.executable, exe)
        assertNativeIdentity(step.command.executableIdentity, exe)
      }
      assert.deepEqual(commands.map((step) => (step.kind === 'command' ? step.command.args : [])), [
        ['plugin', 'marketplace', 'upgrade', 'nodesource'],
        ['plugin', 'remove', 'nsolid-plugin@nodesource'],
        ['plugin', 'add', 'nsolid-plugin@nodesource'],
      ])
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('codex: degrades an unverifiable launcher to planningError + manualCommands', async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'nsolid-strategy-codex-'))
    writeFileSync(path.join(root, 'codex'), 'not executable\n', { mode: 0o644 })
    process.env.PATH = root
    try {
      const candidate = installation('codex', codexSource())
      candidate.artifact = {
        kind: 'git',
        repository: 'https://github.com/NodeSource/nsolid-plugin.git',
        commit: 'bc9c87e6ce6ca73756dc20fdd41a3219bcd5b60c',
        contentDigest: 'planned-content',
      }
      const item = await codexStrategy.plan(candidate, context())
      assert.equal(item.steps.length, 0)
      assert.equal(item.planningError?.code, 'UNSAFE_HARNESS_LAUNCHER')
      assert.deepEqual(item.manualCommands, [
        'codex plugin marketplace upgrade nodesource',
        'codex plugin remove nsolid-plugin@nodesource',
        'codex plugin add nsolid-plugin@nodesource',
      ])
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('pi: plans a spawn-safe command with embedded identity for a verified launcher', async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'nsolid-strategy-pi-'))
    const exe = writeVerifiedLauncher(root, 'pi')
    process.env.PATH = root
    try {
      const source: UpdateSource = { kind: 'pi-package', spec: 'npm:nsolid-pi-plugin', scopes: ['project'], projectRoot: '/tmp/project' }
      const item = await piStrategy.plan(piInstallation(root, source), context())
      assert.equal(item.planningError, undefined)
      const step = item.steps.find((entry) => entry.kind === 'command')
      assert.equal(step?.kind, 'command')
      if (!step || step.kind !== 'command') return
      assertSameExecutable(step.command.executable, exe)
      assertNativeIdentity(step.command.executableIdentity, exe)
      assert.deepEqual(step.command.args, ['update', path.join(root, 'nsolid-pi-plugin-1.0.1.tgz'), '--approve'])
      assert.equal(step.command.cwd, '/tmp/project')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('pi: degrades an unverifiable launcher to planningError + manualCommands', async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'nsolid-strategy-pi-'))
    writeFileSync(path.join(root, 'pi'), 'not executable\n', { mode: 0o644 })
    process.env.PATH = root
    try {
      const source: UpdateSource = { kind: 'pi-package', spec: 'npm:nsolid-pi-plugin', scopes: ['user'] }
      const item = await piStrategy.plan(piInstallation(root, source), context())
      assert.equal(item.steps.length, 0)
      assert.equal(item.planningError?.code, 'UNSAFE_HARNESS_LAUNCHER')
      assert.deepEqual(item.manualCommands, ['pi update npm:nsolid-pi-plugin --no-approve'])
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('antigravity: plans spawn-safe commands with embedded identity for a verified launcher', async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'nsolid-strategy-agy-'))
    const exe = writeVerifiedLauncher(root, 'agy')
    process.env.PATH = root
    try {
      const item = await antigravityStrategy.plan(installation('antigravity', antigravitySource()), context())
      assert.equal(item.planningError, undefined)
      const commands = item.steps.filter((step) => step.kind === 'command')
      assert.equal(commands.length, 2)
      for (const step of commands) {
        if (step.kind !== 'command') continue
        assertSameExecutable(step.command.executable, exe)
        assertNativeIdentity(step.command.executableIdentity, exe)
      }
      assert.deepEqual(commands.map((step) => (step.kind === 'command' ? step.command.args : [])), [
        ['plugin', 'uninstall', 'nsolid-plugin'],
        ['plugin', 'install', 'https://github.com/NodeSource/nsolid-plugin.git'],
      ])
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('antigravity: degrades an unverifiable launcher to planningError + manualCommands', async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'nsolid-strategy-agy-'))
    writeFileSync(path.join(root, 'agy'), 'not executable\n', { mode: 0o644 })
    process.env.PATH = root
    try {
      const item = await antigravityStrategy.plan(installation('antigravity', antigravitySource()), context())
      assert.equal(item.steps.length, 0)
      assert.equal(item.planningError?.code, 'UNSAFE_HARNESS_LAUNCHER')
      assert.deepEqual(item.manualCommands, [
        'agy plugin uninstall nsolid-plugin',
        'agy plugin install https://github.com/NodeSource/nsolid-plugin.git',
      ])
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
