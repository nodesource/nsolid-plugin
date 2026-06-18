import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'

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
    assert.strictEqual(adapter.supportsMcp(), true)
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
    assert.ok(codex.getMcpConfigPath()?.endsWith(['.codex', 'config.toml'].join(path.sep)))

    const opencode = getAdapter('opencode')
    assert.ok(opencode.getMcpConfigPath()?.endsWith(['.config', 'opencode', 'opencode.jsonc'].join(path.sep)))

    const pi = getAdapter('pi')
    assert.ok(pi.getMcpConfigPath()?.endsWith(['.pi', 'agent', 'mcp.json'].join(path.sep)))

    const antigravity = getAdapter('antigravity')
    assert.ok(antigravity.getMcpConfigPath()?.endsWith(['.gemini', 'antigravity-cli', 'mcp_config.json'].join(path.sep)))
  })
})
