import { afterEach, beforeEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { detectCliInstallation, detectInstallations } from '../../../src/update/inventory.js'
import { resolveMarketplaceVersion } from '../../../src/update/version-source.js'
import { nativePayloadDigest } from '../../../src/update/native-evidence.js'
import { checkUpdates, planUpdates, update } from '../../../src/update/coordinator.js'

let home: string
let previousHome: string | undefined
let previousUserProfile: string | undefined
let previousCodexConfigPath: string | undefined

beforeEach(() => {
  home = mkdtempSync(path.join(os.tmpdir(), 'nsolid-plugin-inventory-'))
  previousHome = process.env.HOME
  previousUserProfile = process.env.USERPROFILE
  previousCodexConfigPath = process.env.CODEX_CONFIG_PATH
  process.env.HOME = home
  process.env.USERPROFILE = home
  delete process.env.CODEX_CONFIG_PATH
})

afterEach(() => {
  rmSync(home, { recursive: true, force: true })
  if (previousHome === undefined) delete process.env.HOME
  else process.env.HOME = previousHome
  if (previousUserProfile === undefined) delete process.env.USERPROFILE
  else process.env.USERPROFILE = previousUserProfile
  if (previousCodexConfigPath === undefined) delete process.env.CODEX_CONFIG_PATH
  else process.env.CODEX_CONFIG_PATH = previousCodexConfigPath
})

function writeJson (filePath: string, value: unknown): void {
  mkdirSync(path.dirname(filePath), { recursive: true })
  writeFileSync(filePath, JSON.stringify(value, null, 2))
}

function packageRoot (root: string, version: string): string {
  writeJson(path.join(root, 'package.json'), { name: 'nsolid-pi-plugin', version })
  return root
}

function runner () {
  return { run: async () => ({ exitCode: 0, stdout: '', stderr: '', timedOut: false }) }
}

function registryFetch (version: string): typeof fetch {
  return async () => new Response(JSON.stringify({
    'dist-tags': { latest: version },
    versions: {
      [version]: {
        name: 'nsolid-pi-plugin',
        version,
        dist: { tarball: `https://registry.example/nsolid-pi-plugin-${version}.tgz`, integrity: 'sha512-dGVzdA==' },
      },
    },
  }), { status: 200 })
}

describe('update installation inventory', () => {
  it('evaluates user and project Pi caches instead of selecting the first valid one', async () => {
    const project = mkdtempSync(path.join(os.tmpdir(), 'nsolid-plugin-pi-project-'))
    try {
      writeJson(path.join(home, '.pi', 'agent', 'settings.json'), { packages: ['npm:nsolid-pi-plugin'] })
      writeJson(path.join(project, '.pi', 'settings.json'), { packages: ['npm:nsolid-pi-plugin'] })
      packageRoot(path.join(home, '.pi', 'agent', 'npm', 'node_modules', 'nsolid-pi-plugin'), '1.0.2')
      packageRoot(path.join(project, '.pi', 'npm', 'node_modules', 'nsolid-pi-plugin'), '1.0.0')

      const detected = await detectInstallations({ includeCli: false, cwd: project, commandRunner: runner() })
      const pi = detected.find((installation) => installation.target === 'pi')
      assert.equal(pi?.version.current, '1.0.0')
      assert.deepEqual(pi?.version.currentVersions, ['1.0.2', '1.0.0'])

      const plan = await planUpdates({
        harness: 'pi',
        check: true,
        cwd: project,
        fetchImpl: registryFetch('1.0.2'),
        commandRunner: runner(),
      })
      assert.equal(plan.items[0]?.version.status, 'update-available')
    } finally {
      rmSync(project, { recursive: true, force: true })
    }
  })

  it('reports each Pi scope independently when one is non-canonical', async () => {
    const project = mkdtempSync(path.join(os.tmpdir(), 'nsolid-plugin-pi-project-'))
    try {
      const userSettings = path.join(home, '.pi', 'agent', 'settings.json')
      const projectSettings = path.join(project, '.pi', 'settings.json')
      writeJson(userSettings, { packages: ['npm:nsolid-pi-plugin'] })
      writeJson(projectSettings, { packages: ['npm:nsolid-pi-plugin@1.0.0'] })
      packageRoot(path.join(home, '.pi', 'agent', 'npm', 'node_modules', 'nsolid-pi-plugin'), '1.0.0')

      const detected = await detectInstallations({ includeCli: false, cwd: project, commandRunner: runner() })
      const pi = detected.find((installation) => installation.installationId === 'pi:package:user')
      const unsupportedProject = detected.find((installation) => installation.installationId === 'pi:package:unsupported:project')

      assert.equal(pi?.installationId, 'pi:package:user')
      assert.equal(pi?.source.kind, 'pi-package')
      if (pi?.source.kind === 'pi-package') assert.deepEqual(pi.source.scopes, ['user'])
      assert.deepEqual(pi?.metadata?.settingsPaths, [userSettings])
      assert.equal(unsupportedProject?.source.kind, 'unsupported')
      if (unsupportedProject?.source.kind === 'unsupported') assert.equal(unsupportedProject.source.reason, 'pinned')
      assert.deepEqual(unsupportedProject?.metadata?.settingsPaths, [projectSettings])

      writeJson(userSettings, { packages: ['npm:nsolid-pi-plugin@1.0.0'] })
      writeJson(projectSettings, { packages: ['npm:nsolid-pi-plugin'] })
      packageRoot(path.join(project, '.pi', 'npm', 'node_modules', 'nsolid-pi-plugin'), '1.0.0')

      const inverse = await detectInstallations({ includeCli: false, cwd: project, commandRunner: runner() })
      const inversePi = inverse.find((installation) => installation.installationId === 'pi:package:project')
      const unsupportedUser = inverse.find((installation) => installation.installationId === 'pi:package:unsupported:user')

      assert.equal(inversePi?.installationId, 'pi:package:project')
      assert.equal(inversePi?.source.kind, 'pi-package')
      if (inversePi?.source.kind === 'pi-package') assert.deepEqual(inversePi.source.scopes, ['project'])
      assert.deepEqual(inversePi?.metadata?.settingsPaths, [projectSettings])
      assert.equal(unsupportedUser?.source.kind, 'unsupported')
      if (unsupportedUser?.source.kind === 'unsupported') assert.equal(unsupportedUser.source.reason, 'pinned')
      assert.deepEqual(unsupportedUser?.metadata?.settingsPaths, [userSettings])
    } finally {
      rmSync(project, { recursive: true, force: true })
    }
  })

  it('does not infer a Pi source from a leftover package cache', async () => {
    const root = path.join(home, '.pi', 'agent', 'npm', 'node_modules', 'nsolid-pi-plugin')
    packageRoot(root, '1.0.0')
    assert.equal(existsSync(root), true)
    const detected = await detectInstallations({ includeCli: false, cwd: home, commandRunner: runner() })
    assert.equal(detected.some((installation) => installation.target === 'pi'), false)
  })

  it('ignores unrelated Pi npm package names', async () => {
    writeJson(path.join(home, '.pi', 'agent', 'settings.json'), {
      packages: ['npm:nsolid-pi-plugin-helper', { source: 'npm:another-pi-plugin' }],
    })

    const detected = await detectInstallations({ includeCli: false, cwd: home, commandRunner: runner() })
    assert.equal(detected.some((installation) => installation.target === 'pi'), false)
  })

  it('does not accept a different package name as Pi cache version evidence', async () => {
    writeJson(path.join(home, '.pi', 'agent', 'settings.json'), { packages: ['npm:nsolid-pi-plugin'] })
    const root = path.join(home, '.pi', 'agent', 'npm', 'node_modules', 'nsolid-pi-plugin')
    writeJson(path.join(root, 'package.json'), { name: 'different-package', version: '1.0.1' })

    const detected = await detectInstallations({ includeCli: false, cwd: home, commandRunner: runner() })
    const pi = detected.find((installation) => installation.target === 'pi')
    assert.equal(pi?.version.current, undefined)

    const plan = await planUpdates({
      harness: 'pi',
      check: true,
      cwd: home,
      fetchImpl: registryFetch('1.0.1'),
      commandRunner: runner(),
    })
    assert.equal(plan.items[0]?.version.status, 'update-available')
  })

  it('carries the approved custom Codex config path into inventory metadata', async () => {
    const configPath = path.join(home, 'custom-codex', 'config.toml')
    process.env.CODEX_CONFIG_PATH = configPath
    mkdirSync(path.dirname(configPath), { recursive: true })
    writeFileSync(configPath, [
      '[marketplaces.nodesource]',
      'source = "https://github.com/NodeSource/nsolid-plugin.git"',
      '',
      '[plugins."nsolid-plugin@nodesource"]',
      'enabled = true',
      '',
    ].join('\n'))

    const detected = await detectInstallations({ includeCli: false, cwd: home, commandRunner: runner() })
    const codex = detected.find((installation) => installation.target === 'codex')
    assert.equal(codex?.metadata?.configPath, configPath)
  })

  it('reports an existing invalid Codex config as a planning failure', async () => {
    const configPath = path.join(home, '.codex', 'config.toml')
    process.env.CODEX_CONFIG_PATH = configPath
    mkdirSync(path.dirname(configPath), { recursive: true })
    writeFileSync(configPath, '[plugins."nsolid-plugin@nodesource"\n')

    let fetchCalls = 0
    let runnerCalls = 0
    const detected = await detectInstallations({ includeCli: false, cwd: home, commandRunner: runner() })
    const codex = detected.find((installation) => installation.target === 'codex')
    assert.equal(codex?.inventoryError?.code, 'CODEX_CONFIG_PARSE_FAILED')

    const summary = await checkUpdates({
      harness: 'codex',
      cwd: home,
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

    assert.equal(summary.results[0]?.status, 'failed')
    assert.equal(summary.results[0]?.error?.code, 'CODEX_CONFIG_PARSE_FAILED')
    assert.equal(summary.success, false)
    assert.equal(summary.exitCode, 1)
    assert.equal(fetchCalls, 0)
    assert.equal(runnerCalls, 0)
    assert.doesNotMatch(summary.results[0]?.error?.message ?? '', /plugins|nsolid-plugin@nodesource/)
  })

  it('reads the current Codex version from the uniquely registered marketplace cache', async () => {
    const configPath = path.join(home, '.codex', 'config.toml')
    const cacheRoot = path.join(home, '.codex', 'plugins', 'cache', 'nodesource', 'nsolid-plugin')
    process.env.CODEX_CONFIG_PATH = configPath
    mkdirSync(path.join(cacheRoot, '1.0.1'), { recursive: true })
    writeFileSync(configPath, [
      '[marketplaces.nodesource]',
      'source = "https://github.com/NodeSource/nsolid-plugin.git"',
      'ref = "qa/update-flow-e2e"',
      '',
      '[plugins."nsolid-plugin@nodesource"]',
      'enabled = true',
      '',
    ].join('\n'))
    writeJson(path.join(cacheRoot, '1.0.1', 'bundle.json'), { name: 'nsolid-plugin', version: '1.0.1' })

    const detected = await detectInstallations({ includeCli: false, cwd: home, commandRunner: runner() })
    const codex = detected.find((installation) => installation.target === 'codex')
    assert.equal(codex?.version.current, '1.0.1')
    assert.equal(codex?.metadata?.packageRoot, cacheRoot)
  })

  it('narrows a nested local-snapshot manifest to its payload root and basename', async () => {
    const snapshotRoot = path.join(home, 'marketplace-repo')
    const payloadRoot = path.join(snapshotRoot, 'plugins', 'nsolid')
    mkdirSync(path.join(payloadRoot, 'skills', 'example'), { recursive: true })
    writeFileSync(path.join(payloadRoot, 'plugin.json'), JSON.stringify({ name: 'nsolid-plugin', version: '1.0.1' }))
    writeFileSync(path.join(payloadRoot, 'bundle.json'), JSON.stringify({ name: 'nsolid-plugin', version: '1.0.1' }))
    writeFileSync(path.join(payloadRoot, 'skills', 'example', 'SKILL.md'), '# example\n')
    writeJson(path.join(home, '.claude', 'plugins', 'installed_plugins.json'), {
      plugins: {
        'nsolid-plugin@nodesource': [{
          scope: 'user',
          version: '1.0.1',
          installPath: snapshotRoot,
          relativeManifestPath: 'plugins/nsolid/plugin.json',
          freshness: 'verified',
        }],
      },
    })

    const detected = await detectInstallations({ includeCli: false, cwd: home, commandRunner: runner() })
    const claude = detected.find((installation) => installation.target === 'claude')
    const versionSource = claude?.source.kind === 'claude-marketplace' ? claude.source.versionSource : undefined
    assert.equal(versionSource?.kind, 'local-snapshot')
    if (versionSource?.kind !== 'local-snapshot') return
    // The root is the payload subdirectory and the manifest is relative to it.
    assert.equal(versionSource.root, payloadRoot)
    assert.equal(versionSource.manifestPath, 'plugin.json')
    assert.equal(versionSource.contentDigest, nativePayloadDigest(payloadRoot))

    // The narrowed source resolves: root and digest describe the same bytes.
    const resolved = await resolveMarketplaceVersion({ ...versionSource }, { requireImmutable: false })
    assert.equal(resolved.version, '1.0.1')
    assert.equal(resolved.artifact?.kind, 'local-snapshot')
    if (resolved.artifact?.kind === 'local-snapshot') {
      assert.equal(resolved.artifact.root, payloadRoot)
      assert.equal(resolved.artifact.contentDigest, versionSource.contentDigest)
    }
  })

  it('classifies a Claude registration without marketplace metadata as unsupported', async () => {
    writeJson(path.join(home, '.claude', 'plugins', 'installed_plugins.json'), {
      plugins: { 'nsolid-plugin@nodesource': [{ scope: 'user' }] },
    })

    const detected = await detectInstallations({ includeCli: false, cwd: home, commandRunner: runner() })
    const claude = detected.find((installation) => installation.target === 'claude')
    assert.equal(claude?.source.kind, 'unsupported')

    const check = await checkUpdates({
      harness: 'claude',
      cwd: home,
      fetchImpl: registryFetch('1.0.1'),
      commandRunner: runner(),
    })
    assert.equal(check.results[0]?.status, 'unsupported')

    const result = await update({
      harness: 'claude',
      cwd: home,
      yes: true,
      fetchImpl: registryFetch('1.0.1'),
      commandRunner: runner(),
    })
    assert.equal(result.results[0]?.status, 'unsupported')
    assert.equal(result.success, false)
  })

  it('classifies a Codex registration without marketplace metadata as unsupported', async () => {
    const configPath = path.join(home, '.codex', 'config.toml')
    mkdirSync(path.dirname(configPath), { recursive: true })
    writeFileSync(configPath, [
      '[plugins."nsolid-plugin@nodesource"]',
      'enabled = true',
      '',
    ].join('\n'))
    process.env.CODEX_CONFIG_PATH = configPath

    const detected = await detectInstallations({ includeCli: false, cwd: home, commandRunner: runner() })
    const codex = detected.find((installation) => installation.target === 'codex')
    assert.equal(codex?.source.kind, 'unsupported')

    const check = await checkUpdates({
      harness: 'codex',
      cwd: home,
      fetchImpl: registryFetch('1.0.1'),
      commandRunner: runner(),
    })
    assert.equal(check.results[0]?.status, 'unsupported')

    const result = await update({
      harness: 'codex',
      cwd: home,
      yes: true,
      fetchImpl: registryFetch('1.0.1'),
      commandRunner: runner(),
    })
    assert.equal(result.results[0]?.status, 'unsupported')
    assert.equal(result.success, false)
  })

  it('sanitizes unsupported Pi sources before they enter the update plan', async () => {
    writeJson(path.join(home, '.pi', 'agent', 'settings.json'), {
      packages: ['https://user:token@host/nsolid-pi-plugin\nmalicious'],
    })
    const detected = await detectInstallations({ includeCli: false, cwd: home, commandRunner: runner() })
    const pi = detected.find((installation) => installation.target === 'pi')
    assert.equal(pi?.source.kind, 'unsupported')
    if (pi?.source.kind === 'unsupported') {
      assert.equal(pi.source.source.includes('token'), false)
      assert.equal(pi.source.source.includes('\n'), false)
      assert.equal(pi.source.source.includes('https://host/'), true)
    }
  })

  it('does not let one fallback harness reuse another harness version evidence', async () => {
    const sharedSkill = path.join(home, '.agents', 'skills', 'shared')
    writeJson(path.join(home, '.agents', '.nodesource-installed.json'), {
      version: '1.0.0',
      installedAt: new Date().toISOString(),
      harness: 'opencode',
      bundleVersion: '1.0.0',
      bundleVersions: { opencode: '1.0.0' },
      skills: [{ name: 'shared', path: sharedSkill, paths: { claude: sharedSkill, opencode: sharedSkill }, installedAt: new Date().toISOString(), harnesses: ['claude', 'opencode'] }],
      mcpServers: [],
    })
    const detected = await detectInstallations({ includeCli: false, cwd: home, commandRunner: runner() })
    const claude = detected.find((installation) => installation.installationId === 'claude:fallback')
    const opencode = detected.find((installation) => installation.installationId === 'opencode:fallback')
    assert.equal(claude?.version.current, undefined)
    assert.equal(opencode?.version.current, '1.0.0')
  })

  it('keeps malformed tracking isolated from native inventory discovery', async () => {
    writeJson(path.join(home, '.agents', '.nodesource-installed.json'), {
      version: '1.0.0',
      installedAt: new Date().toISOString(),
      harness: 'opencode',
      skills: {},
      mcpServers: [],
    })
    const detected = await detectInstallations({ includeCli: false, cwd: home, commandRunner: runner() })
    const fallback = detected.find((installation) => installation.installationId === 'opencode:fallback')
    assert.equal(fallback?.source.kind, 'unsupported')
  })

  it('does not require npm or pnpm to report a fallback update in check mode', async () => {
    const skillPath = path.join(home, '.config', 'opencode', 'skills', 'tracked')
    writeJson(path.join(home, '.agents', '.nodesource-installed.json'), {
      version: '1.0.0',
      installedAt: new Date().toISOString(),
      harness: 'opencode',
      bundleVersion: '1.0.0',
      bundleVersions: { opencode: '1.0.0' },
      skills: [{ name: 'tracked', path: skillPath, paths: { opencode: skillPath }, installedAt: new Date().toISOString(), harnesses: ['opencode'] }],
      mcpServers: [],
    })
    const summary = await checkUpdates({
      harness: 'opencode',
      cwd: home,
      fetchImpl: registryFetch('1.0.1'),
      commandRunner: { run: async () => { throw new Error('check must not probe an executor') } },
    })
    assert.equal(summary.results[0]?.status, 'update-available')
    assert.equal(summary.success, true)
  })

  it('never classifies an unrelated absolute tracking path as fallback-owned', async () => {
    const victim = path.join(home, 'user-owned', 'tracked')
    mkdirSync(victim, { recursive: true })
    writeFileSync(path.join(victim, 'keep.txt'), 'keep\n')
    writeJson(path.join(home, '.agents', '.nodesource-installed.json'), {
      version: '1.0.0',
      installedAt: new Date().toISOString(),
      harness: 'claude',
      bundleVersions: { claude: '1.0.0' },
      skills: [{ name: 'tracked', path: victim, paths: { claude: victim }, installedAt: new Date().toISOString(), harnesses: ['claude'] }],
      mcpServers: [],
    })

    const detected = await detectInstallations({ includeCli: false, cwd: home, commandRunner: runner() })
    const fallback = detected.find((installation) => installation.installationId === 'claude:fallback')
    assert.equal(fallback?.source.kind, 'unsupported')
    assert.equal(readFileSync(path.join(victim, 'keep.txt'), 'utf8'), 'keep\n')
  })

  it('does not emit a Pi fallback target for MCP-only tracking', async () => {
    writeJson(path.join(home, '.pi', 'agent', 'settings.json'), { packages: ['npm:nsolid-pi-plugin'] })
    packageRoot(path.join(home, '.pi', 'agent', 'npm', 'node_modules', 'nsolid-pi-plugin'), '1.0.0')
    writeJson(path.join(home, '.agents', '.nodesource-installed.json'), {
      version: '1.0.0',
      installedAt: new Date().toISOString(),
      harness: 'pi',
      skills: [],
      mcpServers: [{ name: 'nsolid-console', configPath: path.join(home, '.pi', 'settings.json'), harness: 'pi', configuredAt: new Date().toISOString() }],
    })

    const detected = await detectInstallations({ includeCli: false, cwd: home, commandRunner: runner() })

    assert.equal(detected.some((installation) => installation.installationId === 'pi:fallback'), false)
    assert.equal(detected.some((installation) => installation.installationId === 'pi:package:user'), true)
  })

  it('ignores an unrelated Antigravity import manifest when checking ambiguity', async () => {
    const pluginRoot = path.join(home, '.gemini', 'config', 'plugins', 'nsolid-plugin')
    mkdirSync(pluginRoot, { recursive: true })
    writeJson(path.join(pluginRoot, 'plugin.json'), { name: 'nsolid-plugin' })
    writeJson(path.join(pluginRoot, 'bundle.json'), { version: '1.0.0' })
    writeJson(path.join(home, '.gemini', 'config', 'import_manifest.json'), { imports: [{ name: 'nsolid-plugin', source: 'antigravity' }] })
    writeJson(path.join(home, '.gemini', 'antigravity-cli', 'import_manifest.json'), { imports: [{ name: 'unrelated-plugin' }] })

    const detected = await detectInstallations({ includeCli: false, cwd: home, commandRunner: runner() })
    const antigravity = detected.find((installation) => installation.target === 'antigravity')

    assert.equal(antigravity?.source.kind, 'antigravity-git')
  })

  it('rejects Antigravity substring imports and foreign conventional roots', async () => {
    const pluginRoot = path.join(home, '.gemini', 'config', 'plugins', 'nsolid-plugin')
    mkdirSync(pluginRoot, { recursive: true })
    writeJson(path.join(pluginRoot, 'plugin.json'), { name: 'my-nsolid-plugin-helper' })
    writeJson(path.join(pluginRoot, 'bundle.json'), { version: '9.9.9' })
    writeJson(path.join(home, '.gemini', 'config', 'import_manifest.json'), {
      imports: { 'my-nsolid-plugin-helper': { name: 'nsolid-plugin', source: 'https://github.com/foreign/plugin.git' } },
    })

    const detected = await detectInstallations({ includeCli: false, cwd: home, commandRunner: runner() })
    const antigravity = detected.find((installation) => installation.target === 'antigravity')
    assert.notEqual(antigravity?.source.kind, 'antigravity-git')
  })

  it('rejects Antigravity imports without canonical source provenance', async () => {
    const pluginRoot = path.join(home, '.gemini', 'config', 'plugins', 'nsolid-plugin')
    const manifestPath = path.join(home, '.gemini', 'config', 'import_manifest.json')
    mkdirSync(pluginRoot, { recursive: true })
    writeJson(path.join(pluginRoot, 'plugin.json'), { name: 'nsolid-plugin' })
    writeJson(path.join(pluginRoot, 'bundle.json'), { version: '9.9.9' })

    const unprovenImports = [
      { imports: { 'nsolid-plugin': true } },
      { imports: [{ name: 'nsolid-plugin' }] },
    ]
    for (const manifest of unprovenImports) {
      writeJson(manifestPath, manifest)
      const detected = await detectInstallations({ includeCli: false, cwd: home, commandRunner: runner() })
      const antigravity = detected.find((installation) => installation.target === 'antigravity')
      assert.notEqual(antigravity?.source.kind, 'antigravity-git', JSON.stringify(manifest))
    }
  })
})

describe('CLI installation provenance', () => {
  function cliPackageRoot (root: string, version: string): string {
    writeJson(path.join(root, 'package.json'), { name: 'nsolid-plugin', version })
    writeJson(path.join(root, 'bundle.json'), { name: 'nsolid-plugin', version })
    return root
  }

  function cliLauncher (root: string, relative = path.join('dist', 'src', 'cli.js')): string {
    const launcher = path.join(root, relative)
    mkdirSync(path.dirname(launcher), { recursive: true })
    writeFileSync(launcher, '#!/usr/bin/env node\n')
    return launcher
  }

  function noProbeRunner () {
    return {
      run: async () => {
        throw new Error('read-only inventory must not probe package managers')
      },
    }
  }

  it('reports an unproven workspace launcher as unsupported without a current version', async () => {
    const root = cliPackageRoot(path.join(home, 'repo', 'packages', 'core'), '1.0.3')
    const launcher = cliLauncher(root)

    const installation = await detectCliInstallation({
      commandRunner: noProbeRunner(),
      packageRoot: root,
      readOnly: true,
      executablePath: launcher,
    })

    assert.equal(installation.ownership, 'none')
    if (installation.source.kind !== 'unsupported') assert.fail(JSON.stringify(installation.source))
    assert.equal(installation.source.source, launcher)
    assert.equal(installation.version.current, undefined)
  })

  it('proves an npm global installation only through its matching prefix bin link', async () => {
    const prefix = path.join(home, 'node-v24')
    const root = cliPackageRoot(path.join(prefix, 'lib', 'node_modules', 'nsolid-plugin'), '90.0.1')
    const entrypoint = cliLauncher(root)
    const launcher = path.join(prefix, 'bin', 'nsolid-plugin')
    mkdirSync(path.dirname(launcher), { recursive: true })
    symlinkSync(entrypoint, launcher)

    const installation = await detectCliInstallation({
      commandRunner: noProbeRunner(),
      packageRoot: root,
      readOnly: true,
      executablePath: launcher,
    })

    assert.equal(installation.ownership, 'global-package')
    if (installation.source.kind !== 'global-package') assert.fail(JSON.stringify(installation.source))
    assert.equal(installation.source.packageManager, 'npm')
    assert.equal(installation.version.current, '90.0.1')
  })

  it('does not treat a workspace path ending in lib/node_modules as npm global ownership', async () => {
    const root = cliPackageRoot(path.join(home, 'workspace', 'lib', 'node_modules', 'nsolid-plugin'), '1.0.3')
    const launcher = cliLauncher(root)

    const installation = await detectCliInstallation({
      commandRunner: noProbeRunner(),
      packageRoot: root,
      readOnly: true,
      executablePath: launcher,
    })

    assert.equal(installation.ownership, 'none')
    assert.equal(installation.source.kind, 'unsupported')
    assert.equal(installation.version.current, undefined)
  })

  it('keeps Volta package images and their shim launchers unsupported', async () => {
    const root = cliPackageRoot(path.join(home, '.volta', 'tools', 'image', 'packages', 'nsolid-plugin', 'lib', 'node_modules', 'nsolid-plugin'), '90.0.1')
    const realLauncher = cliLauncher(root)

    const imageInstallation = await detectCliInstallation({
      commandRunner: noProbeRunner(),
      packageRoot: root,
      readOnly: true,
      executablePath: realLauncher,
    })
    assert.equal(imageInstallation.ownership, 'none', 'a Volta tool image never proves npm-global ownership')
    assert.equal(imageInstallation.source.kind, 'unsupported')
    assert.equal(imageInstallation.version.current, undefined)

    const shim = path.join(home, '.volta', 'bin', 'nsolid-plugin')
    mkdirSync(path.dirname(shim), { recursive: true })
    symlinkSync(realLauncher, shim)
    const shimInstallation = await detectCliInstallation({
      commandRunner: noProbeRunner(),
      packageRoot: root,
      readOnly: true,
      executablePath: shim,
    })
    assert.equal(shimInstallation.ownership, 'none')
    assert.equal(shimInstallation.source.kind, 'unsupported')
    assert.equal(shimInstallation.version.current, undefined)
  })

  it('keeps a fabricated npm prefix without a bin link unsupported', async () => {
    // A tree that only ends in lib/node_modules/nsolid-plugin (no
    // <prefix>/bin/nsolid-plugin shim resolving into the payload) cannot
    // claim npm-global ownership by suffix alone.
    const root = cliPackageRoot(path.join(home, 'fake-prefix', 'lib', 'node_modules', 'nsolid-plugin'), '90.0.1')
    const launcher = cliLauncher(root)

    const installation = await detectCliInstallation({
      commandRunner: noProbeRunner(),
      packageRoot: root,
      readOnly: true,
      executablePath: launcher,
    })
    assert.equal(installation.ownership, 'none')
    assert.equal(installation.source.kind, 'unsupported')
    assert.equal(installation.version.current, undefined)
  })

  it('skips the positive ownership probe for Volta image launchers in mutating inventory', async () => {
    const root = cliPackageRoot(path.join(home, '.volta', 'tools', 'image', 'packages', 'nsolid-plugin', 'lib', 'node_modules', 'nsolid-plugin'), '90.0.1')
    const launcher = cliLauncher(root)
    let calls = 0
    const installation = await detectCliInstallation({
      commandRunner: {
        run: async () => {
          calls += 1
          return { exitCode: 0, stdout: path.join(home, '.volta', 'tools', 'image', 'packages', 'nsolid-plugin', 'lib'), stderr: '', timedOut: false }
        },
      },
      packageRoot: root,
      readOnly: false,
      executablePath: launcher,
    })
    assert.equal(calls, 0, 'a definitely-unsupported launcher must fail closed before any manager probe')
    assert.equal(installation.ownership, 'none')
    assert.equal(installation.source.kind, 'unsupported')
    assert.equal(installation.version.current, undefined)
  })

  it('proves a real pnpm global symlink into its versioned store without probing', async () => {
    const pnpmHome = path.join(home, '.local', 'share', 'pnpm')
    const globalVersion = path.join(pnpmHome, 'global', '5')
    const storeRoot = cliPackageRoot(path.join(globalVersion, '.pnpm', 'nsolid-plugin@90.0.1', 'node_modules', 'nsolid-plugin'), '90.0.1')
    const entrypoint = cliLauncher(storeRoot)
    const root = path.join(globalVersion, 'node_modules', 'nsolid-plugin')
    mkdirSync(path.dirname(root), { recursive: true })
    symlinkSync(storeRoot, root, 'dir')
    const launcher = path.join(pnpmHome, 'nsolid-plugin')
    symlinkSync(entrypoint, launcher)

    const installation = await detectCliInstallation({
      commandRunner: noProbeRunner(),
      packageRoot: root,
      readOnly: true,
      executablePath: launcher,
    })

    assert.equal(installation.ownership, 'global-package')
    if (installation.source.kind !== 'global-package') assert.fail(JSON.stringify(installation.source))
    assert.equal(installation.source.packageManager, 'pnpm')
    assert.equal(installation.version.current, '90.0.1')
  })

  it('keeps npx cache, Volta image, and mismatched-root launches unsupported without a current version', async () => {
    const cases = [
      {
        name: 'npx cache',
        root: cliPackageRoot(path.join(home, '.npm', '_npx', 'abc123', 'node_modules', 'nsolid-plugin'), '90.0.1'),
      },
      {
        name: 'volta package image',
        root: cliPackageRoot(path.join(home, '.volta', 'tools', 'image', 'packages', 'nsolid-plugin'), '90.0.0'),
      },
    ].map((entry) => ({ ...entry, launcher: cliLauncher(entry.root) }))
    const mismatchedRoot = cliPackageRoot(path.join(home, 'repo', 'packages', 'core'), '1.0.3')
    cases.push({ name: 'launcher outside running root', root: mismatchedRoot, launcher: cliLauncher(path.join(home, 'elsewhere')) })

    for (const { name, root, launcher } of cases) {
      const installation = await detectCliInstallation({
        commandRunner: noProbeRunner(),
        packageRoot: root,
        readOnly: true,
        executablePath: launcher,
      })

      assert.equal(installation.source.kind, 'unsupported', name)
      assert.equal(installation.ownership, 'none', name)
      assert.equal(installation.version.current, undefined, name)
    }
  })

  it('still requires the real ownership probe when a mutation is planned', async () => {
    const root = cliPackageRoot(path.join(home, 'node-v24', 'lib', 'node_modules', 'nsolid-plugin'), '90.0.1')
    const launcher = cliLauncher(root)
    let calls = 0

    const installation = await detectCliInstallation({
      commandRunner: {
        run: async () => {
          calls++
          return { exitCode: 1, stdout: '', stderr: '', timedOut: false }
        },
      },
      packageRoot: root,
      readOnly: false,
      executablePath: launcher,
    })

    // Structural evidence is check-only: a mutating plan demands the real
    // probe, and the failing probe leaves the installation unsupported.
    assert.ok(calls > 0)
    assert.equal(installation.source.kind, 'unsupported')
    assert.equal(installation.version.current, undefined)
  })

  it('recognizes a Windows npm .cmd shim next to the npm prefix as owned npm', async () => {
    // npm on Windows installs the .cmd/.ps1 shim in the prefix root itself,
    // next to node_modules (no separate bin directory).
    const prefix = path.join(home, 'nodejs')
    const root = cliPackageRoot(path.join(prefix, 'node_modules', 'nsolid-plugin'), '90.0.1')
    cliLauncher(root)
    const shim = path.join(prefix, 'nsolid-plugin.cmd')
    writeFileSync(shim, '@ECHO off\r\n"%~dp0node_modules\\nsolid-plugin\\dist\\src\\cli.js" %*\r\n')

    const installation = await detectCliInstallation({
      commandRunner: noProbeRunner(),
      packageRoot: root,
      readOnly: true,
      executablePath: shim,
    })

    assert.equal(installation.ownership, 'global-package')
    if (installation.source.kind !== 'global-package') assert.fail(JSON.stringify(installation.source))
    assert.equal(installation.source.packageManager, 'npm')
    assert.equal(installation.version.current, '90.0.1')
  })

  it('recognizes a Windows pnpm .cmd shim in the pnpm home as owned pnpm', async () => {
    const pnpmHome = path.join(home, '.local', 'share', 'pnpm')
    const globalVersion = path.join(pnpmHome, 'global', '5')
    const storeRoot = cliPackageRoot(path.join(globalVersion, '.pnpm', 'nsolid-plugin@90.0.1', 'node_modules', 'nsolid-plugin'), '90.0.1')
    cliLauncher(storeRoot)
    const root = path.join(globalVersion, 'node_modules', 'nsolid-plugin')
    mkdirSync(path.dirname(root), { recursive: true })
    symlinkSync(storeRoot, root, 'dir')
    const shim = path.join(pnpmHome, 'nsolid-plugin.cmd')
    writeFileSync(shim, '@ECHO off\r\n"%~dp0global\\5\\node_modules\\nsolid-plugin\\dist\\src\\cli.js" %*\r\n')

    const installation = await detectCliInstallation({
      commandRunner: noProbeRunner(),
      packageRoot: root,
      readOnly: true,
      executablePath: shim,
    })

    assert.equal(installation.ownership, 'global-package')
    if (installation.source.kind !== 'global-package') assert.fail(JSON.stringify(installation.source))
    assert.equal(installation.source.packageManager, 'pnpm')
    assert.equal(installation.version.current, '90.0.1')
  })

  it('keeps a workspace .cmd shim outside any documented global layout unsupported', async () => {
    const root = cliPackageRoot(path.join(home, 'workspace', 'lib', 'node_modules', 'nsolid-plugin'), '1.0.3')
    cliLauncher(root)
    // The shim sits at the workspace root: neither the npm prefix root (next
    // to node_modules), the prefix bin directory, nor the pnpm home.
    const shim = path.join(home, 'workspace', 'nsolid-plugin.cmd')
    writeFileSync(shim, '@ECHO off\r\n"%~dp0lib\\node_modules\\nsolid-plugin\\dist\\src\\cli.js" %*\r\n')

    const installation = await detectCliInstallation({
      commandRunner: noProbeRunner(),
      packageRoot: root,
      readOnly: true,
      executablePath: shim,
    })

    assert.equal(installation.ownership, 'none')
    assert.equal(installation.source.kind, 'unsupported')
    assert.equal(installation.version.current, undefined)
  })

  it('recognizes a real Windows npm-global launch through the payload entrypoint', async () => {
    // npm on Windows generates the prefix shim, and the shim invokes node with
    // the payload entrypoint, so process.argv[1] is
    // <prefix>/node_modules/nsolid-plugin/dist/src/cli.js — not the shim.
    const prefix = path.join(home, 'npm-global')
    const root = cliPackageRoot(path.join(prefix, 'node_modules', 'nsolid-plugin'), '90.0.1')
    const launcher = cliLauncher(root)
    writeFileSync(path.join(prefix, 'nsolid-plugin.cmd'), '@ECHO off\r\n"%~dp0node_modules\\nsolid-plugin\\dist\\src\\cli.js" %*\r\n')

    const installation = await detectCliInstallation({
      commandRunner: noProbeRunner(),
      packageRoot: root,
      readOnly: true,
      executablePath: launcher,
    })

    assert.equal(installation.ownership, 'global-package')
    if (installation.source.kind !== 'global-package') assert.fail(JSON.stringify(installation.source))
    assert.equal(installation.source.packageManager, 'npm')
    assert.equal(installation.version.current, '90.0.1')
  })

  it('keeps a payload entrypoint without a generated prefix shim unsupported', async () => {
    // A node_modules tree containing the payload but no npm-generated shim is
    // a project-local install (or a fabricated prefix), never a proven global.
    const prefix = path.join(home, 'project', 'node_modules')
    const root = cliPackageRoot(path.join(prefix, 'nsolid-plugin'), '1.0.3')
    const launcher = cliLauncher(root)

    const installation = await detectCliInstallation({
      commandRunner: noProbeRunner(),
      packageRoot: root,
      readOnly: true,
      executablePath: launcher,
    })

    assert.equal(installation.ownership, 'none')
    assert.equal(installation.source.kind, 'unsupported')
    assert.equal(installation.version.current, undefined)
  })

  it('keeps a fabricated prefix whose shim body does not reference the payload unsupported', async () => {
    const prefix = path.join(home, 'fabricated')
    const root = cliPackageRoot(path.join(prefix, 'node_modules', 'nsolid-plugin'), '1.0.3')
    const launcher = cliLauncher(root)
    writeFileSync(path.join(prefix, 'nsolid-plugin.cmd'), '@ECHO off\r\necho unrelated\r\n')

    const installation = await detectCliInstallation({
      commandRunner: noProbeRunner(),
      packageRoot: root,
      readOnly: true,
      executablePath: launcher,
    })

    assert.equal(installation.ownership, 'none')
    assert.equal(installation.source.kind, 'unsupported')
  })

  it('keeps a payload-internal launcher that is not the documented bin entrypoint unsupported', async () => {
    const prefix = path.join(home, 'npm-global-wrong-entry')
    const root = cliPackageRoot(path.join(prefix, 'node_modules', 'nsolid-plugin'), '1.0.3')
    const launcher = cliLauncher(root, path.join('dist', 'src', 'other.js'))
    writeFileSync(path.join(prefix, 'nsolid-plugin.cmd'), '@ECHO off\r\n"%~dp0node_modules\\nsolid-plugin\\dist\\src\\cli.js" %*\r\n')

    const installation = await detectCliInstallation({
      commandRunner: noProbeRunner(),
      packageRoot: root,
      readOnly: true,
      executablePath: launcher,
    })

    assert.equal(installation.ownership, 'none')
    assert.equal(installation.source.kind, 'unsupported')
  })

  it('recognizes the resolved pnpm store layout through a pnpm-home sh script', async () => {
    // Node resolves the payload module through the global link, so production
    // observes the RESOLVED versioned-store path as the package root, and the
    // pnpm launcher is a regular sh script at the pnpm home whose body embeds
    // that store path. PNPM_HOME is user-configurable and does not need to be
    // named "pnpm".
    const pnpmHome = path.join(home, 'tooling', 'pnpm-home')
    const storeRoot = cliPackageRoot(path.join(pnpmHome, 'global', '5', '.pnpm', 'nsolid-plugin@90.0.1', 'node_modules', 'nsolid-plugin'), '90.0.1')
    cliLauncher(storeRoot)
    const root = path.join(pnpmHome, 'global', '5', 'node_modules', 'nsolid-plugin')
    mkdirSync(path.dirname(root), { recursive: true })
    symlinkSync(storeRoot, root, 'dir')
    const shim = path.join(pnpmHome, 'nsolid-plugin')
    writeFileSync(shim, `#!/bin/sh\nexec node "${storeRoot}/dist/src/cli.js" "$@"\n`, { mode: 0o755 })

    const installation = await detectCliInstallation({
      commandRunner: noProbeRunner(),
      packageRoot: storeRoot,
      readOnly: true,
      executablePath: shim,
    })

    assert.equal(installation.ownership, 'global-package')
    if (installation.source.kind !== 'global-package') assert.fail(JSON.stringify(installation.source))
    assert.equal(installation.source.packageManager, 'pnpm')
    assert.equal(installation.version.current, '90.0.1')
  })

  it('rejects a pnpm-home shim whose body references a different payload', async () => {
    const pnpmHome = path.join(home, '.local', 'share', 'pnpm')
    const storeRoot = cliPackageRoot(path.join(pnpmHome, 'global', '5', '.pnpm', 'nsolid-plugin@90.0.1', 'node_modules', 'nsolid-plugin'), '90.0.1')
    cliLauncher(storeRoot)
    const root = path.join(pnpmHome, 'global', '5', 'node_modules', 'nsolid-plugin')
    mkdirSync(path.dirname(root), { recursive: true })
    symlinkSync(storeRoot, root, 'dir')
    const shim = path.join(pnpmHome, 'nsolid-plugin')
    writeFileSync(shim, `#!/bin/sh\nexec node "${pnpmHome}/global/3/.pnpm/other-plugin@1.0.0/node_modules/other-plugin/cli.js" "$@"\n`, { mode: 0o755 })

    const installation = await detectCliInstallation({
      commandRunner: noProbeRunner(),
      packageRoot: storeRoot,
      readOnly: true,
      executablePath: shim,
    })

    assert.equal(installation.ownership, 'none', 'a shim bound to another payload must not prove ownership')
    assert.equal(installation.source.kind, 'unsupported')
    assert.equal(installation.version.current, undefined)
  })
})
