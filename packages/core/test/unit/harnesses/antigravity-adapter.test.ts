import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync, readFileSync, mkdirSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { tmpdir } from 'node:os'

describe('AntigravityAdapter', () => {
  let tmpDir: string
  let originalHome: string | undefined

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'nsolid-test-'))
    originalHome = process.env.HOME
    process.env.HOME = tmpDir
  })

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true })
    if (originalHome !== undefined) {
      process.env.HOME = originalHome
    }
  })

  it('returns correct MCP config path', async () => {
    const { AntigravityAdapter } = await import('../../../src/harnesses/antigravity-adapter.js')
    const adapter = new AntigravityAdapter()

    const configPath = adapter.getMcpConfigPath()
    assert.ok(configPath.endsWith('.gemini/antigravity-cli/mcp_config.json'))
    assert.ok(configPath.startsWith(tmpDir))
  })

  it('returns correct skills path', async () => {
    const { AntigravityAdapter } = await import('../../../src/harnesses/antigravity-adapter.js')
    const adapter = new AntigravityAdapter()

    const skillsPath = adapter.getSkillsPath()
    assert.ok(skillsPath.includes('.gemini/antigravity-cli/skills'))
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

    const configPath = resolveHome('~/.gemini/antigravity-cli/mcp_config.json')
    mkdirSync(dirname(configPath), { recursive: true })
    writeFileSync(configPath, JSON.stringify({
      mcpServers: {
        'my-server': { command: 'python', args: ['server.py'] },
      },
    }, null, 2))

    const adapter = new AntigravityAdapter()
    const config = await adapter.readMcpConfig()

    assert.ok('my-server' in config.mcpServers)
    assert.strictEqual(config.mcpServers['my-server'].command, 'python')
  })

  it('writes MCP config using JSON format', async () => {
    const { AntigravityAdapter } = await import('../../../src/harnesses/antigravity-adapter.js')
    const { resolveHome } = await import('../../../src/utils/path.js')

    const adapter = new AntigravityAdapter()
    await adapter.writeMcpConfig({
      mcpServers: {
        'ns-benchmark': {
          command: 'node',
          args: ['/path/to/server.js'],
          env: { TOKEN: 'abc' },
        },
      },
    })

    const configPath = resolveHome('~/.gemini/antigravity-cli/mcp_config.json')
    assert.ok(existsSync(configPath))

    const content = JSON.parse(readFileSync(configPath, 'utf-8'))
    assert.ok('ns-benchmark' in content.mcpServers)
    assert.strictEqual(content.mcpServers['ns-benchmark'].command, 'node')
  })

  it('returns correct name', async () => {
    const { AntigravityAdapter } = await import('../../../src/harnesses/antigravity-adapter.js')
    const adapter = new AntigravityAdapter()

    assert.strictEqual(adapter.name, 'antigravity')
  })
})
