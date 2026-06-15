import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { getAdapter } from '../../src/index.js'
import type { HarnessAdapter, HarnessType, McpConfig, McpServerConfig } from '../../src/index.js'

describe('public entrypoint', () => {
  it('exports getAdapter', () => {
    assert.strictEqual(typeof getAdapter, 'function')
  })

  it('getAdapter returns a HarnessAdapter for each harness type', () => {
    const harnesses: HarnessType[] = ['claude', 'codex', 'opencode', 'pi', 'antigravity']
    for (const harness of harnesses) {
      const adapter = getAdapter(harness)
      assert.ok(adapter, `expected adapter for ${harness}`)
      assert.strictEqual(adapter.name, harness)
      assert.strictEqual(typeof adapter.getMcpConfigPath, 'function')
      assert.strictEqual(typeof adapter.getSkillsPath, 'function')
      assert.strictEqual(typeof adapter.supportsMcp, 'function')
      assert.strictEqual(typeof adapter.readMcpConfig, 'function')
      assert.strictEqual(typeof adapter.writeMcpConfig, 'function')
    }
  })

  it('type exports are available at runtime as type-only', () => {
    // This test mainly exists to ensure the type imports above compile.
    // Runtime values for type-only exports are not asserted.
    assert.ok(getAdapter)
  })
})

export type { HarnessAdapter, McpConfig, McpServerConfig }
