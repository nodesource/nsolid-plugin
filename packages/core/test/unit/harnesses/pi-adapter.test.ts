import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs'
import path, { join } from 'node:path'
import { tmpdir } from 'node:os'

describe('PiAdapter', () => {
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

  it('returns Pi MCP config path', async () => {
    const { PiAdapter } = await import('../../../src/harnesses/pi-adapter.js')
    const adapter = new PiAdapter()

    const configPath = adapter.getMcpConfigPath()
    assert.ok(configPath)
    assert.ok(configPath.includes(['.pi', 'agent', 'mcp.json'].join(path.sep)))
  })

  it('returns correct skills path', async () => {
    const { PiAdapter } = await import('../../../src/harnesses/pi-adapter.js')
    const adapter = new PiAdapter()

    const skillsPath = adapter.getSkillsPath()
    assert.ok(skillsPath.includes(['.pi', 'agent', 'skills'].join(path.sep)))
  })

  it('supports MCP', async () => {
    const { PiAdapter } = await import('../../../src/harnesses/pi-adapter.js')
    const adapter = new PiAdapter()

    assert.strictEqual(adapter.supportsMcp(), true)
  })

  it('reads existing MCP config', async () => {
    const { PiAdapter } = await import('../../../src/harnesses/pi-adapter.js')
    const adapter = new PiAdapter()
    const configPath = adapter.getMcpConfigPath()

    mkdirSync(path.dirname(configPath), { recursive: true })
    writeFileSync(configPath, JSON.stringify({
      mcpServers: {
        'ns-benchmark': { url: 'https://benchmark.mcp.saas.nodesource.io/mcp', headers: {} },
      },
    }, null, 2))

    const config = await adapter.readMcpConfig()
    assert.deepStrictEqual(config, {
      mcpServers: {
        'ns-benchmark': { url: 'https://benchmark.mcp.saas.nodesource.io/mcp', headers: {} },
      },
    })
  })

  it('writes MCP config', async () => {
    const { PiAdapter } = await import('../../../src/harnesses/pi-adapter.js')
    const adapter = new PiAdapter()
    const configPath = adapter.getMcpConfigPath()

    await adapter.writeMcpConfig({
      mcpServers: {
        'ns-benchmark': { url: 'https://benchmark.mcp.saas.nodesource.io/mcp', headers: {} },
      },
    })

    const written = JSON.parse(readFileSync(configPath, 'utf-8'))
    assert.deepStrictEqual(written, {
      mcpServers: {
        'ns-benchmark': { url: 'https://benchmark.mcp.saas.nodesource.io/mcp', headers: {} },
      },
    })
  })

  it('returns correct name', async () => {
    const { PiAdapter } = await import('../../../src/harnesses/pi-adapter.js')
    const adapter = new PiAdapter()

    assert.strictEqual(adapter.name, 'pi')
  })
})
