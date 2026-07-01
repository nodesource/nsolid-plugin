import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync, readFileSync, mkdirSync, existsSync } from 'node:fs'
import { join, dirname, sep } from 'node:path'
import { tmpdir } from 'node:os'

describe('ClaudeAdapter', () => {
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

  it('returns correct MCP config path', async () => {
    const { ClaudeAdapter } = await import('../../../src/harnesses/claude-adapter.js')
    const adapter = new ClaudeAdapter()

    const configPath = adapter.getMcpConfigPath()
    assert.ok(configPath.endsWith('.claude.json'))
    assert.ok(configPath.startsWith(tmpDir))
  })

  it('returns correct skills path', async () => {
    const { ClaudeAdapter } = await import('../../../src/harnesses/claude-adapter.js')
    const adapter = new ClaudeAdapter()

    const skillsPath = adapter.getSkillsPath()
    assert.ok(skillsPath.includes(['.claude', 'skills'].join(sep)))
  })

  it('supports MCP', async () => {
    const { ClaudeAdapter } = await import('../../../src/harnesses/claude-adapter.js')
    const adapter = new ClaudeAdapter()

    assert.strictEqual(adapter.supportsMcp(), true)
  })

  it('reads empty config when file does not exist', async () => {
    const { ClaudeAdapter } = await import('../../../src/harnesses/claude-adapter.js')
    const adapter = new ClaudeAdapter()

    const config = await adapter.readMcpConfig()
    assert.deepStrictEqual(config, { mcpServers: {} })
  })

  it('reads existing JSON config', async () => {
    const { ClaudeAdapter } = await import('../../../src/harnesses/claude-adapter.js')
    const { resolveHome } = await import('../../../src/utils/path.js')

    const configPath = resolveHome('~/.claude.json')
    mkdirSync(dirname(configPath), { recursive: true })
    writeFileSync(configPath, JSON.stringify({
      mcpServers: {
        'my-server': { url: 'http://localhost:8080', headers: { Authorization: 'Bearer abc' } },
      },
    }, null, 2))

    const adapter = new ClaudeAdapter()
    const config = await adapter.readMcpConfig()

    assert.ok('my-server' in config.mcpServers)
    assert.strictEqual(config.mcpServers['my-server'].url, 'http://localhost:8080')
  })

  it('writes MCP config using JSON format', async () => {
    const { ClaudeAdapter } = await import('../../../src/harnesses/claude-adapter.js')
    const { resolveHome } = await import('../../../src/utils/path.js')

    const adapter = new ClaudeAdapter()
    await adapter.writeMcpConfig({
      mcpServers: {
        'ns-benchmark': {
          url: 'https://benchmark.mcp.saas.nodesource.io/mcp',
          headers: { Authorization: 'Bearer abc' },
        },
      },
    })

    const configPath = resolveHome('~/.claude.json')
    assert.ok(existsSync(configPath))

    const content = JSON.parse(readFileSync(configPath, 'utf-8'))
    assert.ok('ns-benchmark' in content.mcpServers)
    assert.strictEqual(content.mcpServers['ns-benchmark'].url, 'https://benchmark.mcp.saas.nodesource.io/mcp')
  })

  it('returns correct name', async () => {
    const { ClaudeAdapter } = await import('../../../src/harnesses/claude-adapter.js')
    const adapter = new ClaudeAdapter()

    assert.strictEqual(adapter.name, 'claude')
  })

  describe('detectNativePlugin', () => {
    it('detects plugin from v2 map schema {version, plugins:{<id>:[...]}}', async () => {
      const { ClaudeAdapter } = await import('../../../src/harnesses/claude-adapter.js')
      const { resolveHome } = await import('../../../src/utils/path.js')
      const { mkdirSync } = await import('node:fs')
      const { dirname } = await import('node:path')

      const installedPath = resolveHome('~/.claude/plugins/installed_plugins.json')
      mkdirSync(dirname(installedPath), { recursive: true })
      writeFileSync(installedPath, JSON.stringify({
        version: 2,
        plugins: {
          'nsolid-plugin@nodesource': [
            { scope: 'user', version: '1.0.0', installedAt: '2026-06-30T20:31:51.571Z' },
          ],
        },
      }, null, 2))

      const adapter = new ClaudeAdapter()
      const status = adapter.detectNativePlugin()

      assert.strictEqual(status.installed, true)
      assert.deepStrictEqual(status.installedIds, ['nsolid-plugin@nodesource'])
      assert.strictEqual(status.label, 'nsolid-plugin@nodesource')
    })

    it('matches a community-marketplace id like nsolid-plugin@claude-plugins-official', async () => {
      const { ClaudeAdapter } = await import('../../../src/harnesses/claude-adapter.js')
      const { resolveHome } = await import('../../../src/utils/path.js')
      const { mkdirSync } = await import('node:fs')
      const { dirname } = await import('node:path')

      const installedPath = resolveHome('~/.claude/plugins/installed_plugins.json')
      mkdirSync(dirname(installedPath), { recursive: true })
      writeFileSync(installedPath, JSON.stringify({
        version: 2,
        plugins: {
          'nsolid-plugin@claude-plugins-official': [
            { scope: 'user', version: '1.0.0' },
          ],
        },
      }, null, 2))

      const adapter = new ClaudeAdapter()
      const status = adapter.detectNativePlugin()

      assert.strictEqual(status.installed, true)
      assert.deepStrictEqual(status.installedIds, ['nsolid-plugin@claude-plugins-official'])
    })

    it('still supports the legacy array plugins schema', async () => {
      const { ClaudeAdapter } = await import('../../../src/harnesses/claude-adapter.js')
      const { resolveHome } = await import('../../../src/utils/path.js')
      const { mkdirSync } = await import('node:fs')
      const { dirname } = await import('node:path')

      const installedPath = resolveHome('~/.claude/plugins/installed_plugins.json')
      mkdirSync(dirname(installedPath), { recursive: true })
      writeFileSync(installedPath, JSON.stringify({
        plugins: [{ id: 'nsolid-plugin@nodesource' }, { id: 'other-plugin@somewhere' }],
      }, null, 2))

      const adapter = new ClaudeAdapter()
      const status = adapter.detectNativePlugin()

      assert.strictEqual(status.installed, true)
      assert.deepStrictEqual(status.installedIds, ['nsolid-plugin@nodesource'])
    })

    it('reports not installed when absent', async () => {
      const { ClaudeAdapter } = await import('../../../src/harnesses/claude-adapter.js')
      const adapter = new ClaudeAdapter()

      const status = adapter.detectNativePlugin()
      assert.strictEqual(status.installed, false)
    })

    it('reads enabled=true from ~/.claude.json enabledPlugins', async () => {
      const { ClaudeAdapter } = await import('../../../src/harnesses/claude-adapter.js')
      const { resolveHome } = await import('../../../src/utils/path.js')
      const { mkdirSync } = await import('node:fs')
      const { dirname } = await import('node:path')

      const installedPath = resolveHome('~/.claude/plugins/installed_plugins.json')
      mkdirSync(dirname(installedPath), { recursive: true })
      writeFileSync(installedPath, JSON.stringify({
        version: 2,
        plugins: { 'nsolid-plugin@nodesource': [{ scope: 'user' }] },
      }, null, 2))

      const claudeJsonPath = resolveHome('~/.claude.json')
      writeFileSync(claudeJsonPath, JSON.stringify({
        enabledPlugins: { 'nsolid-plugin@nodesource': true, 'other@x': false },
      }, null, 2))

      const adapter = new ClaudeAdapter()
      const status = adapter.detectNativePlugin()

      assert.strictEqual(status.installed, true)
      assert.strictEqual(status.enabled, true)
    })

    it('respects enabledPlugins=false as disabled', async () => {
      const { ClaudeAdapter } = await import('../../../src/harnesses/claude-adapter.js')
      const { resolveHome } = await import('../../../src/utils/path.js')
      const { mkdirSync } = await import('node:fs')
      const { dirname } = await import('node:path')

      const installedPath = resolveHome('~/.claude/plugins/installed_plugins.json')
      mkdirSync(dirname(installedPath), { recursive: true })
      writeFileSync(installedPath, JSON.stringify({
        version: 2,
        plugins: { 'nsolid-plugin@nodesource': [{ scope: 'user' }] },
      }, null, 2))

      const claudeJsonPath = resolveHome('~/.claude.json')
      writeFileSync(claudeJsonPath, JSON.stringify({
        enabledPlugins: { 'nsolid-plugin@nodesource': false },
      }, null, 2))

      const adapter = new ClaudeAdapter()
      const status = adapter.detectNativePlugin()

      assert.strictEqual(status.installed, true)
      assert.strictEqual(status.enabled, false)
    })
  })
})
