import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync, readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { tmpdir } from 'node:os'

describe('removeNativePlugin', () => {
  let tmpDir: string
  let originalHome: string | undefined
  let originalUserProfile: string | undefined

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'nsolid-test-'))
    originalHome = process.env.HOME
    originalUserProfile = process.env.USERPROFILE
    process.env.HOME = tmpDir
    process.env.USERPROFILE = tmpDir
  })

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true })
    if (originalHome !== undefined) {
      process.env.HOME = originalHome
    } else {
      delete process.env.HOME
    }
    if (originalUserProfile !== undefined) {
      process.env.USERPROFILE = originalUserProfile
    } else {
      delete process.env.USERPROFILE
    }
  })

  // A runner that always behaves as if the harness binary is absent, forcing
  // the fallback config-edit path to run.
  const binaryMissing = async (): Promise<number> => {
    throw new Error('ENOENT')
  }

  it('claude fallback: removes the id from v2 installed_plugins.json and enabledPlugins', async () => {
    const { getAdapter } = await import('../../../src/harnesses/index.js')
    const { removeNativePlugin } = await import('../../../src/harnesses/native-plugin-uninstaller.js')
    const { resolveHome } = await import('../../../src/utils/path.js')

    const installedPath = resolveHome('~/.claude/plugins/installed_plugins.json')
    mkdirSync(dirname(installedPath), { recursive: true })
    writeFileSync(installedPath, JSON.stringify({
      version: 2,
      plugins: {
        'nsolid-plugin@nodesource': [{ scope: 'user' }],
        'other-plugin@x': [{ scope: 'user' }],
      },
    }, null, 2))

    const claudeJsonPath = resolveHome('~/.claude.json')
    writeFileSync(claudeJsonPath, JSON.stringify({
      enabledPlugins: { 'nsolid-plugin@nodesource': true, 'other-plugin@x': true },
    }, null, 2))

    const adapter = getAdapter('claude')
    const result = await removeNativePlugin('claude', adapter, { runCli: binaryMissing })

    assert.strictEqual(result.removed, true)
    assert.deepStrictEqual(result.warnings, [])

    const remaining = JSON.parse(readFileSync(installedPath, 'utf-8'))
    assert.ok(!('nsolid-plugin@nodesource' in remaining.plugins))
    assert.ok('other-plugin@x' in remaining.plugins)

    const claudeJson = JSON.parse(readFileSync(claudeJsonPath, 'utf-8'))
    assert.ok(!('nsolid-plugin@nodesource' in claudeJson.enabledPlugins))
    assert.ok('other-plugin@x' in claudeJson.enabledPlugins)
  })

  it('claude fallback: matches a community-marketplace id', async () => {
    const { getAdapter } = await import('../../../src/harnesses/index.js')
    const { removeNativePlugin } = await import('../../../src/harnesses/native-plugin-uninstaller.js')
    const { resolveHome } = await import('../../../src/utils/path.js')

    const installedPath = resolveHome('~/.claude/plugins/installed_plugins.json')
    mkdirSync(dirname(installedPath), { recursive: true })
    writeFileSync(installedPath, JSON.stringify({
      version: 2,
      plugins: { 'nsolid-plugin@claude-plugins-official': [{ scope: 'user' }] },
    }, null, 2))

    const adapter = getAdapter('claude')
    const result = await removeNativePlugin('claude', adapter, { runCli: binaryMissing })

    assert.strictEqual(result.removed, true)
    const remaining = JSON.parse(readFileSync(installedPath, 'utf-8'))
    assert.ok(!('nsolid-plugin@claude-plugins-official' in remaining.plugins))
  })

  it('antigravity fallback: removes the staged dir and the manifest import', async () => {
    const { getAdapter } = await import('../../../src/harnesses/index.js')
    const { removeNativePlugin } = await import('../../../src/harnesses/native-plugin-uninstaller.js')
    const { resolveHome } = await import('../../../src/utils/path.js')

    const pluginDir = resolveHome('~/.gemini/config/plugins/nsolid-plugin')
    mkdirSync(pluginDir, { recursive: true })
    writeFileSync(join(pluginDir, 'plugin.json'), '{"name":"nsolid-plugin"}')

    const manifestPath = resolveHome('~/.gemini/config/import_manifest.json')
    mkdirSync(dirname(manifestPath), { recursive: true })
    writeFileSync(manifestPath, JSON.stringify({
      imports: [
        { name: 'nsolid-plugin', source: 'antigravity' },
        { name: 'unrelated-plugin', source: 'antigravity' },
      ],
    }, null, 2))

    const adapter = getAdapter('antigravity')
    const result = await removeNativePlugin('antigravity', adapter, { runCli: binaryMissing })

    assert.strictEqual(result.removed, true)
    assert.strictEqual(existsSync(pluginDir), false)

    const manifest = JSON.parse(readFileSync(manifestPath, 'utf-8'))
    assert.ok(!manifest.imports.some((i: { name: string }) => i.name === 'nsolid-plugin'))
    assert.ok(manifest.imports.some((i: { name: string }) => i.name === 'unrelated-plugin'))
  })

  it('codex fallback: removes the plugin table from config.toml', async () => {
    const { getAdapter } = await import('../../../src/harnesses/index.js')
    const { removeNativePlugin } = await import('../../../src/harnesses/native-plugin-uninstaller.js')
    const { resolveHome } = await import('../../../src/utils/path.js')
    const { stringify: stringifyToml, parse: parseToml } = await import('smol-toml')

    const configPath = resolveHome('~/.codex/config.toml')
    mkdirSync(dirname(configPath), { recursive: true })
    writeFileSync(configPath, stringifyToml({
      plugins: {
        'nsolid-plugin@nodesource': { enabled: true },
        'other@x': { enabled: true },
      },
    } as Record<string, unknown>))

    const adapter = getAdapter('codex')
    const result = await removeNativePlugin('codex', adapter, { runCli: binaryMissing })

    assert.strictEqual(result.removed, true)
    const data = parseToml(readFileSync(configPath, 'utf-8')) as { plugins: Record<string, unknown> }
    assert.ok(!('nsolid-plugin@nodesource' in data.plugins))
    assert.ok('other@x' in data.plugins)
  })

  it('is a no-op when the plugin is not installed', async () => {
    const { getAdapter } = await import('../../../src/harnesses/index.js')
    const { removeNativePlugin } = await import('../../../src/harnesses/native-plugin-uninstaller.js')

    const adapter = getAdapter('claude')
    const result = await removeNativePlugin('claude', adapter, { runCli: binaryMissing })
    assert.strictEqual(result.removed, true)
    assert.deepStrictEqual(result.warnings, [])
  })

  it('reports removed when the harness CLI succeeds', async () => {
    // Simulate the CLI removing the plugin by deleting the manifest entry
    // ourselves, then returning exit 0.
    const { getAdapter } = await import('../../../src/harnesses/index.js')
    const { removeNativePlugin } = await import('../../../src/harnesses/native-plugin-uninstaller.js')
    const { resolveHome } = await import('../../../src/utils/path.js')

    const pluginDir = resolveHome('~/.gemini/config/plugins/nsolid-plugin')
    mkdirSync(pluginDir, { recursive: true })

    const adapter = getAdapter('antigravity')
    const runCli = async (): Promise<number> => {
      rmSync(pluginDir, { recursive: true, force: true })
      return 0
    }
    const result = await removeNativePlugin('antigravity', adapter, { runCli })

    assert.strictEqual(result.removed, true)
    assert.strictEqual(existsSync(pluginDir), false)
  })

  it('reconciles when the agy CLI exits 0 but leaves the manifest entry and dir', async () => {
    // agy exits 0 (so delegated=true) but leaves the staged dir and the manifest
    // import behind. The fallback cleanup must run to finish the job rather than
    // emit a spurious "remove it manually" warning.
    const { getAdapter } = await import('../../../src/harnesses/index.js')
    const { removeNativePlugin } = await import('../../../src/harnesses/native-plugin-uninstaller.js')
    const { resolveHome } = await import('../../../src/utils/path.js')

    const pluginDir = resolveHome('~/.gemini/config/plugins/nsolid-plugin')
    mkdirSync(pluginDir, { recursive: true })
    const manifestPath = resolveHome('~/.gemini/config/import_manifest.json')
    mkdirSync(dirname(manifestPath), { recursive: true })
    writeFileSync(manifestPath, JSON.stringify({
      imports: [
        { name: 'nsolid-plugin', source: 'antigravity' },
        { name: 'other-plugin', source: 'antigravity' },
      ],
    }, null, 2))

    const adapter = getAdapter('antigravity')
    // CLI "succeeds" but does nothing — leaves state intact.
    const runCli = async (): Promise<number> => 0
    const result = await removeNativePlugin('antigravity', adapter, { runCli })

    assert.strictEqual(result.removed, true)
    assert.deepStrictEqual(result.warnings, [])
    assert.strictEqual(existsSync(pluginDir), false)
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf-8'))
    assert.ok(!manifest.imports.some((i: { name: string }) => i.name === 'nsolid-plugin'))
    assert.ok(manifest.imports.some((i: { name: string }) => i.name === 'other-plugin'))
  })
})
