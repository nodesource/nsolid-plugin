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
      process.env.USERPROFILE = originalUserProfile
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
})
