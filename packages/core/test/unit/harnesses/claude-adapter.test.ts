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
      process.env.USERPROFILE = originalUserProfile
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
})
