import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

describe('getAdapter', () => {
  it('returns ClaudeAdapter for claude', async () => {
    const { getAdapter } = await import('../../../src/harnesses/index.js')
    const adapter = getAdapter('claude')

    assert.strictEqual(adapter.name, 'claude')
    assert.strictEqual(adapter.supportsMcp(), true)
  })

  it('returns CodexAdapter for codex', async () => {
    const { getAdapter } = await import('../../../src/harnesses/index.js')
    const adapter = getAdapter('codex')

    assert.strictEqual(adapter.name, 'codex')
    assert.strictEqual(adapter.supportsMcp(), true)
  })

  it('returns OpenCodeAdapter for opencode', async () => {
    const { getAdapter } = await import('../../../src/harnesses/index.js')
    const adapter = getAdapter('opencode')

    assert.strictEqual(adapter.name, 'opencode')
    assert.strictEqual(adapter.supportsMcp(), true)
  })

  it('returns PiAdapter for pi', async () => {
    const { getAdapter } = await import('../../../src/harnesses/index.js')
    const adapter = getAdapter('pi')

    assert.strictEqual(adapter.name, 'pi')
    assert.strictEqual(adapter.supportsMcp(), false)
  })

  it('returns AntigravityAdapter for antigravity', async () => {
    const { getAdapter } = await import('../../../src/harnesses/index.js')
    const adapter = getAdapter('antigravity')

    assert.strictEqual(adapter.name, 'antigravity')
    assert.strictEqual(adapter.supportsMcp(), true)
  })

  it('returns correct MCP config paths', async () => {
    const { getAdapter } = await import('../../../src/harnesses/index.js')

    const claude = getAdapter('claude')
    assert.ok(claude.getMcpConfigPath()?.endsWith('.claude.json'))

    const codex = getAdapter('codex')
    assert.ok(codex.getMcpConfigPath()?.endsWith('.codex/config.toml'))

    const opencode = getAdapter('opencode')
    assert.ok(opencode.getMcpConfigPath()?.endsWith('.config/opencode/opencode.jsonc'))

    const pi = getAdapter('pi')
    assert.strictEqual(pi.getMcpConfigPath(), null)

    const antigravity = getAdapter('antigravity')
    assert.ok(antigravity.getMcpConfigPath()?.endsWith('.gemini/config/mcp_config.json'))
  })
})
