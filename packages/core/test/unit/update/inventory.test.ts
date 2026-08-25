import { afterEach, beforeEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { detectInstallations } from '../../../src/update/inventory.js'
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

  it('keeps a canonical Pi scope updateable when the other scope is non-canonical', async () => {
    const project = mkdtempSync(path.join(os.tmpdir(), 'nsolid-plugin-pi-project-'))
    try {
      const userSettings = path.join(home, '.pi', 'agent', 'settings.json')
      const projectSettings = path.join(project, '.pi', 'settings.json')
      writeJson(userSettings, { packages: ['npm:nsolid-pi-plugin'] })
      writeJson(projectSettings, { packages: ['npm:nsolid-pi-plugin@1.0.0'] })
      packageRoot(path.join(home, '.pi', 'agent', 'npm', 'node_modules', 'nsolid-pi-plugin'), '1.0.0')

      const detected = await detectInstallations({ includeCli: false, cwd: project, commandRunner: runner() })
      const pi = detected.find((installation) => installation.target === 'pi')

      assert.equal(pi?.installationId, 'pi:package:user')
      assert.equal(pi?.source.kind, 'pi-package')
      if (pi?.source.kind === 'pi-package') assert.deepEqual(pi.source.scopes, ['user'])
      assert.deepEqual(pi?.metadata?.settingsPaths, [userSettings])

      writeJson(userSettings, { packages: ['npm:nsolid-pi-plugin@1.0.0'] })
      writeJson(projectSettings, { packages: ['npm:nsolid-pi-plugin'] })
      packageRoot(path.join(project, '.pi', 'npm', 'node_modules', 'nsolid-pi-plugin'), '1.0.0')

      const inverse = await detectInstallations({ includeCli: false, cwd: project, commandRunner: runner() })
      const inversePi = inverse.find((installation) => installation.target === 'pi')

      assert.equal(inversePi?.installationId, 'pi:package:project')
      assert.equal(inversePi?.source.kind, 'pi-package')
      if (inversePi?.source.kind === 'pi-package') assert.deepEqual(inversePi.source.scopes, ['project'])
      assert.deepEqual(inversePi?.metadata?.settingsPaths, [projectSettings])
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
    const skillPath = path.join(home, '.agents', 'skills', 'tracked')
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
    writeJson(path.join(pluginRoot, 'bundle.json'), { version: '1.0.0' })
    writeJson(path.join(home, '.gemini', 'config', 'import_manifest.json'), { imports: [{ name: 'nsolid-plugin' }] })
    writeJson(path.join(home, '.gemini', 'antigravity-cli', 'import_manifest.json'), { imports: [{ name: 'unrelated-plugin' }] })

    const detected = await detectInstallations({ includeCli: false, cwd: home, commandRunner: runner() })
    const antigravity = detected.find((installation) => installation.target === 'antigravity')

    assert.equal(antigravity?.source.kind, 'antigravity-git')
  })
})
