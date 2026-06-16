import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync, readFileSync, mkdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { tmpdir } from 'node:os'

describe('OpenCodeAdapter', () => {
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
    const { OpenCodeAdapter } = await import('../../../src/harnesses/opencode-adapter.js')
    const adapter = new OpenCodeAdapter()

    const configPath = adapter.getMcpConfigPath()
    assert.ok(configPath.endsWith('.config/opencode/opencode.jsonc'))
    assert.ok(configPath.startsWith(tmpDir))
  })

  it('returns correct skills path', async () => {
    const { OpenCodeAdapter } = await import('../../../src/harnesses/opencode-adapter.js')
    const adapter = new OpenCodeAdapter()

    const skillsPath = adapter.getSkillsPath()
    assert.ok(skillsPath.includes('.config/opencode/skills'))
  })

  it('supports MCP', async () => {
    const { OpenCodeAdapter } = await import('../../../src/harnesses/opencode-adapter.js')
    const adapter = new OpenCodeAdapter()

    assert.strictEqual(adapter.supportsMcp(), true)
  })

  it('reads empty config when file does not exist', async () => {
    const { OpenCodeAdapter } = await import('../../../src/harnesses/opencode-adapter.js')
    const adapter = new OpenCodeAdapter()

    const config = await adapter.readMcpConfig()
    assert.deepStrictEqual(config, { mcpServers: {} })
  })

  it('reads existing JSONC config', async () => {
    const { OpenCodeAdapter } = await import('../../../src/harnesses/opencode-adapter.js')
    const { resolveHome } = await import('../../../src/utils/path.js')

    const configPath = resolveHome('~/.config/opencode/opencode.jsonc')
    mkdirSync(dirname(configPath), { recursive: true })
    writeFileSync(configPath, '{\n  // Comment\n  "mcpServers": {\n    "my-server": { "url": "http://localhost:8080", "headers": {} }\n  }\n}\n')

    const adapter = new OpenCodeAdapter()
    const config = await adapter.readMcpConfig()

    assert.ok('my-server' in config.mcpServers)
    assert.strictEqual(config.mcpServers['my-server'].url, 'http://localhost:8080')
  })

  it('writes MCP config preserving comments', async () => {
    const { OpenCodeAdapter } = await import('../../../src/harnesses/opencode-adapter.js')
    const { resolveHome } = await import('../../../src/utils/path.js')

    const configPath = resolveHome('~/.config/opencode/opencode.jsonc')
    mkdirSync(dirname(configPath), { recursive: true })
    writeFileSync(configPath, '{\n  // Comment\n  "mcpServers": {\n    "my-server": { "url": "http://localhost:8080", "headers": {} }\n  }\n}\n')

    const adapter = new OpenCodeAdapter()
    await adapter.writeMcpConfig({
      mcpServers: {
        'ns-benchmark': { url: 'https://benchmark.mcp.saas.nodesource.io/mcp', headers: {} },
      },
    })

    const content = readFileSync(configPath, 'utf-8')
    assert.ok(content.includes('// Comment'))
    assert.ok(content.includes('ns-benchmark'))
  })

  it('returns correct name', async () => {
    const { OpenCodeAdapter } = await import('../../../src/harnesses/opencode-adapter.js')
    const adapter = new OpenCodeAdapter()

    assert.strictEqual(adapter.name, 'opencode')
  })
})
