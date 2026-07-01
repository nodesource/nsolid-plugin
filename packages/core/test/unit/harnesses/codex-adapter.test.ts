import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync, readFileSync, mkdirSync, existsSync } from 'node:fs'
import { join, dirname, sep } from 'node:path'
import { tmpdir } from 'node:os'

describe('CodexAdapter', () => {
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
    const { CodexAdapter } = await import('../../../src/harnesses/codex-adapter.js')
    const adapter = new CodexAdapter()

    const configPath = adapter.getMcpConfigPath()
    assert.ok(configPath.endsWith(['.codex', 'config.toml'].join(sep)))
    assert.ok(configPath.startsWith(tmpDir))
  })

  it('returns correct skills path', async () => {
    const { CodexAdapter } = await import('../../../src/harnesses/codex-adapter.js')
    const adapter = new CodexAdapter()

    const skillsPath = adapter.getSkillsPath()
    assert.ok(skillsPath.includes(['.codex', 'skills'].join(sep)))
  })

  it('supports MCP', async () => {
    const { CodexAdapter } = await import('../../../src/harnesses/codex-adapter.js')
    const adapter = new CodexAdapter()

    assert.strictEqual(adapter.supportsMcp(), true)
  })

  it('reads empty config when file does not exist', async () => {
    const { CodexAdapter } = await import('../../../src/harnesses/codex-adapter.js')
    const adapter = new CodexAdapter()

    const config = await adapter.readMcpConfig()
    assert.deepStrictEqual(config, { mcpServers: {} })
  })

  it('reads existing TOML config', async () => {
    const { CodexAdapter } = await import('../../../src/harnesses/codex-adapter.js')
    const { resolveHome } = await import('../../../src/utils/path.js')

    const configPath = resolveHome('~/.codex/config.toml')
    mkdirSync(dirname(configPath), { recursive: true })
    writeFileSync(configPath, '[mcp_servers.my-server]\nurl = "http://localhost:8080"\nheaders = {}\n')

    const adapter = new CodexAdapter()
    const config = await adapter.readMcpConfig()

    assert.ok('my-server' in config.mcpServers)
  })

  it('writes MCP config using TOML format', async () => {
    const { CodexAdapter } = await import('../../../src/harnesses/codex-adapter.js')
    const { resolveHome } = await import('../../../src/utils/path.js')
    const { parse: parseToml } = await import('smol-toml')

    const adapter = new CodexAdapter()
    await adapter.writeMcpConfig({
      mcpServers: {
        'ns-benchmark': {
          url: 'https://benchmark.mcp.saas.nodesource.io/mcp',
          headers: { Authorization: 'Bearer abc' },
        },
      },
    })

    const configPath = resolveHome('~/.codex/config.toml')
    assert.ok(existsSync(configPath))

    const content = parseToml(readFileSync(configPath, 'utf-8')) as Record<string, unknown>
    assert.ok('mcp_servers' in content)
    const servers = content.mcp_servers as Record<string, unknown>
    assert.ok('ns-benchmark' in servers)
  })

  it('returns correct name', async () => {
    const { CodexAdapter } = await import('../../../src/harnesses/codex-adapter.js')
    const adapter = new CodexAdapter()

    assert.strictEqual(adapter.name, 'codex')
  })

  describe('detectNativePlugin', () => {
    it('detects plugin by base name under any marketplace suffix', async () => {
      const { CodexAdapter } = await import('../../../src/harnesses/codex-adapter.js')
      const { resolveHome } = await import('../../../src/utils/path.js')
      const { mkdirSync } = await import('node:fs')
      const { dirname } = await import('node:path')
      const { stringify: stringifyToml } = await import('smol-toml')

      const configPath = resolveHome('~/.codex/config.toml')
      mkdirSync(dirname(configPath), { recursive: true })
      writeFileSync(configPath, stringifyToml({
        plugins: {
          'nsolid-plugin@claude-plugins-official': { enabled: true },
          'unrelated@somewhere': { enabled: true },
        },
      } as Record<string, unknown>))

      const adapter = new CodexAdapter()
      const status = adapter.detectNativePlugin()

      assert.strictEqual(status.installed, true)
      assert.deepStrictEqual(status.installedIds, ['nsolid-plugin@claude-plugins-official'])
      assert.strictEqual(status.enabled, true)
      assert.strictEqual(status.label, 'nsolid-plugin@claude-plugins-official')
    })

    it('detects the @nodesource marketplace id', async () => {
      const { CodexAdapter } = await import('../../../src/harnesses/codex-adapter.js')
      const { resolveHome } = await import('../../../src/utils/path.js')
      const { mkdirSync } = await import('node:fs')
      const { dirname } = await import('node:path')
      const { stringify: stringifyToml } = await import('smol-toml')

      const configPath = resolveHome('~/.codex/config.toml')
      mkdirSync(dirname(configPath), { recursive: true })
      writeFileSync(configPath, stringifyToml({
        plugins: { 'nsolid-plugin@nodesource': { enabled: true } },
      } as Record<string, unknown>))

      const adapter = new CodexAdapter()
      const status = adapter.detectNativePlugin()

      assert.strictEqual(status.installed, true)
      assert.deepStrictEqual(status.installedIds, ['nsolid-plugin@nodesource'])
    })

    it('reports not installed when absent', async () => {
      const { CodexAdapter } = await import('../../../src/harnesses/codex-adapter.js')
      const adapter = new CodexAdapter()

      const status = adapter.detectNativePlugin()
      assert.strictEqual(status.installed, false)
    })
  })
})
