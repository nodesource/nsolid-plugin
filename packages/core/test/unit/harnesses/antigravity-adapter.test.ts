import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync, readFileSync, mkdirSync, existsSync } from 'node:fs'
import { join, dirname, sep } from 'node:path'
import { tmpdir } from 'node:os'

describe('AntigravityAdapter', () => {
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
    const { AntigravityAdapter } = await import('../../../src/harnesses/antigravity-adapter.js')
    const adapter = new AntigravityAdapter()

    const configPath = adapter.getMcpConfigPath()
    assert.ok(configPath.endsWith(['.gemini', 'config', 'mcp_config.json'].join(sep)))
    assert.ok(configPath.startsWith(tmpDir))
  })

  it('returns correct skills path', async () => {
    const { AntigravityAdapter } = await import('../../../src/harnesses/antigravity-adapter.js')
    const adapter = new AntigravityAdapter()

    const skillsPath = adapter.getSkillsPath()
    assert.ok(skillsPath.includes(['.gemini', 'config', 'skills'].join(sep)), `unexpected skills path: ${skillsPath}`)
  })

  it('supports MCP', async () => {
    const { AntigravityAdapter } = await import('../../../src/harnesses/antigravity-adapter.js')
    const adapter = new AntigravityAdapter()

    assert.strictEqual(adapter.supportsMcp(), true)
  })

  it('reads empty config when file does not exist', async () => {
    const { AntigravityAdapter } = await import('../../../src/harnesses/antigravity-adapter.js')
    const adapter = new AntigravityAdapter()

    const config = await adapter.readMcpConfig()
    assert.deepStrictEqual(config, { mcpServers: {} })
  })

  it('reads existing JSON config', async () => {
    const { AntigravityAdapter } = await import('../../../src/harnesses/antigravity-adapter.js')
    const { resolveHome } = await import('../../../src/utils/path.js')

    const configPath = resolveHome('~/.gemini/config/mcp_config.json')
    mkdirSync(dirname(configPath), { recursive: true })
    writeFileSync(configPath, JSON.stringify({
      mcpServers: {
        'my-server': { url: 'http://localhost:8080', headers: { Authorization: 'Bearer abc' } },
      },
    }, null, 2))

    const adapter = new AntigravityAdapter()
    const config = await adapter.readMcpConfig()

    assert.ok('my-server' in config.mcpServers)
    assert.strictEqual(config.mcpServers['my-server'].url, 'http://localhost:8080')
  })

  it('writes MCP config using JSON format', async () => {
    const { AntigravityAdapter } = await import('../../../src/harnesses/antigravity-adapter.js')
    const { resolveHome } = await import('../../../src/utils/path.js')

    const adapter = new AntigravityAdapter()
    await adapter.writeMcpConfig({
      mcpServers: {
        'ns-benchmark': {
          url: 'https://benchmark.mcp.saas.nodesource.io/mcp',
          headers: { Authorization: 'Bearer abc' },
        },
      },
    })

    const configPath = resolveHome('~/.gemini/config/mcp_config.json')
    assert.ok(existsSync(configPath))

    const content = JSON.parse(readFileSync(configPath, 'utf-8'))
    assert.ok('ns-benchmark' in content.mcpServers)
    assert.strictEqual(content.mcpServers['ns-benchmark'].serverUrl, 'https://benchmark.mcp.saas.nodesource.io/mcp')
  })

  it('returns correct name', async () => {
    const { AntigravityAdapter } = await import('../../../src/harnesses/antigravity-adapter.js')
    const adapter = new AntigravityAdapter()

    assert.strictEqual(adapter.name, 'antigravity')
  })

  it('round-trips config through write and read', async () => {
    const { AntigravityAdapter } = await import('../../../src/harnesses/antigravity-adapter.js')
    const adapter = new AntigravityAdapter()

    const input = {
      mcpServers: {
        'ns-benchmark': {
          url: 'https://benchmark.mcp.saas.nodesource.io/mcp',
          headers: { Authorization: 'Bearer abc' },
        },
        'ns-monitor': {
          url: 'https://monitor.mcp.saas.nodesource.io/mcp',
          headers: { Authorization: 'Bearer xyz' },
        },
      },
    }

    await adapter.writeMcpConfig(input)
    const read = await adapter.readMcpConfig()

    assert.strictEqual(Object.keys(read.mcpServers).length, 2)
    assert.strictEqual(read.mcpServers['ns-benchmark'].url, 'https://benchmark.mcp.saas.nodesource.io/mcp')
    assert.strictEqual(read.mcpServers['ns-benchmark'].headers.Authorization, 'Bearer abc')
    assert.strictEqual(read.mcpServers['ns-monitor'].url, 'https://monitor.mcp.saas.nodesource.io/mcp')
    assert.strictEqual(read.mcpServers['ns-monitor'].headers.Authorization, 'Bearer xyz')
  })
})
