import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

describe('PiAdapter', () => {
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

  it('returns null for MCP config path', async () => {
    const { PiAdapter } = await import('../../../src/harnesses/pi-adapter.js')
    const adapter = new PiAdapter()

    assert.strictEqual(adapter.getMcpConfigPath(), null)
  })

  it('returns correct skills path', async () => {
    const { PiAdapter } = await import('../../../src/harnesses/pi-adapter.js')
    const adapter = new PiAdapter()

    const skillsPath = adapter.getSkillsPath()
    assert.ok(skillsPath.includes('.pi/agent/skills'))
  })

  it('does not support MCP', async () => {
    const { PiAdapter } = await import('../../../src/harnesses/pi-adapter.js')
    const adapter = new PiAdapter()

    assert.strictEqual(adapter.supportsMcp(), false)
  })

  it('returns empty config on read', async () => {
    const { PiAdapter } = await import('../../../src/harnesses/pi-adapter.js')
    const adapter = new PiAdapter()

    const config = await adapter.readMcpConfig()
    assert.deepStrictEqual(config, { mcpServers: {} })
  })

  it('writeMcpConfig is a no-op', async () => {
    const { PiAdapter } = await import('../../../src/harnesses/pi-adapter.js')
    const adapter = new PiAdapter()

    const result = await adapter.writeMcpConfig({
      mcpServers: {
        'ns-benchmark': { url: 'https://benchmark.mcp.saas.nodesource.io/mcp', headers: {} },
      },
    })

    assert.strictEqual(result, undefined)
  })

  it('returns correct name', async () => {
    const { PiAdapter } = await import('../../../src/harnesses/pi-adapter.js')
    const adapter = new PiAdapter()

    assert.strictEqual(adapter.name, 'pi')
  })
})
