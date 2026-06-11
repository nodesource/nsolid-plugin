/* eslint-disable no-template-curly-in-string */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import type { McpServerRef } from '../../../src/types.js'

const serverA: McpServerRef = {
  name: 'ns-benchmark',
  command: 'node',
  args: ['/path/to/ns-benchmark/src/mcp-entrypoint.js'],
  env: { NSOLID_SERVICE_TOKEN: '${AUTH_TOKEN}', NSOLID_ORG_ID: '${AUTH_ORG_ID}' },
}

const serverB: McpServerRef = {
  name: 'nsolid-mcp',
  command: 'node',
  args: ['/path/to/nsolid-mcp/src/mcp-entrypoint.js'],
}

describe('mergeMcpConfig', () => {
  it('adds servers to empty config', async () => {
    const { mergeMcpConfig } = await import('../../../src/mcp/mcp-config-merger.js')

    const result = mergeMcpConfig({ mcpServers: {} }, [serverA])

    assert.ok('ns-benchmark' in result.mcpServers)
    assert.strictEqual(result.mcpServers['ns-benchmark'].command, 'node')
    assert.strictEqual(result.mcpServers['ns-benchmark'].args[0], '/path/to/ns-benchmark/src/mcp-entrypoint.js')
    assert.ok(result.mcpServers['ns-benchmark'].env)
  })

  it('preserves existing user servers', async () => {
    const { mergeMcpConfig } = await import('../../../src/mcp/mcp-config-merger.js')

    const existing = {
      mcpServers: {
        'my-custom-server': { command: 'python', args: ['server.py'] },
      },
    }

    const result = mergeMcpConfig(existing, [serverA])

    assert.ok('my-custom-server' in result.mcpServers)
    assert.ok('ns-benchmark' in result.mcpServers)
  })

  it('updates existing NodeSource servers (upsert)', async () => {
    const { mergeMcpConfig } = await import('../../../src/mcp/mcp-config-merger.js')

    const existing = {
      mcpServers: {
        'ns-benchmark': { command: 'node', args: ['old-path.js'] },
      },
    }

    const result = mergeMcpConfig(existing, [serverA])

    assert.strictEqual(result.mcpServers['ns-benchmark'].args[0], '/path/to/ns-benchmark/src/mcp-entrypoint.js')
  })

  it('handles mixed scenario (preserves and updates)', async () => {
    const { mergeMcpConfig } = await import('../../../src/mcp/mcp-config-merger.js')

    const existing = {
      mcpServers: {
        'my-server': { command: 'go', args: ['run'] },
        'ns-benchmark': { command: 'node', args: ['old.js'] },
      },
    }

    const result = mergeMcpConfig(existing, [serverA, serverB])

    assert.strictEqual(Object.keys(result.mcpServers).length, 3)
    assert.ok('my-server' in result.mcpServers)
    assert.ok('ns-benchmark' in result.mcpServers)
    assert.ok('nsolid-mcp' in result.mcpServers)
    assert.strictEqual(result.mcpServers['ns-benchmark'].args[0], '/path/to/ns-benchmark/src/mcp-entrypoint.js')
  })

  it('does not mutate original config', async () => {
    const { mergeMcpConfig } = await import('../../../src/mcp/mcp-config-merger.js')

    const existing = {
      mcpServers: {
        'my-server': { command: 'go', args: ['run'] },
      },
    }

    const originalKeys = Object.keys(existing.mcpServers)
    mergeMcpConfig(existing, [serverA])

    assert.deepStrictEqual(Object.keys(existing.mcpServers), originalKeys)
  })
})

describe('removeMcpServers', () => {
  it('removes named servers', async () => {
    const { removeMcpServers } = await import('../../../src/mcp/mcp-config-merger.js')

    const existing = {
      mcpServers: {
        'ns-benchmark': { command: 'node', args: ['a.js'] },
        'nsolid-mcp': { command: 'node', args: ['b.js'] },
        'my-server': { command: 'go', args: ['run'] },
      },
    }

    const result = removeMcpServers(existing, ['ns-benchmark'])

    assert.strictEqual(Object.keys(result.mcpServers).length, 2)
    assert.ok(!('ns-benchmark' in result.mcpServers))
    assert.ok('nsolid-mcp' in result.mcpServers)
    assert.ok('my-server' in result.mcpServers)
  })

  it('removes multiple servers', async () => {
    const { removeMcpServers } = await import('../../../src/mcp/mcp-config-merger.js')

    const existing = {
      mcpServers: {
        'ns-benchmark': { command: 'node', args: ['a.js'] },
        'nsolid-mcp': { command: 'node', args: ['b.js'] },
        'ncm-mcp': { command: 'node', args: ['c.js'] },
      },
    }

    const result = removeMcpServers(existing, ['ns-benchmark', 'nsolid-mcp'])

    assert.strictEqual(Object.keys(result.mcpServers).length, 1)
    assert.ok(!('ns-benchmark' in result.mcpServers))
    assert.ok(!('nsolid-mcp' in result.mcpServers))
    assert.ok('ncm-mcp' in result.mcpServers)
  })

  it('handles nonexistent server name', async () => {
    const { removeMcpServers } = await import('../../../src/mcp/mcp-config-merger.js')

    const existing = {
      mcpServers: {
        'ns-benchmark': { command: 'node', args: ['a.js'] },
      },
    }

    const result = removeMcpServers(existing, ['nonexistent'])

    assert.strictEqual(Object.keys(result.mcpServers).length, 1)
    assert.ok('ns-benchmark' in result.mcpServers)
  })

  it('does not mutate original config', async () => {
    const { removeMcpServers } = await import('../../../src/mcp/mcp-config-merger.js')

    const existing = {
      mcpServers: {
        'ns-benchmark': { command: 'node', args: ['a.js'] },
      },
    }

    const originalKeys = Object.keys(existing.mcpServers)
    removeMcpServers(existing, ['ns-benchmark'])

    assert.deepStrictEqual(Object.keys(existing.mcpServers), originalKeys)
  })
})

describe('expandVariables', () => {
  it('replaces variables in args', async () => {
    const { expandVariables } = await import('../../../src/mcp/mcp-config-merger.js')

    const servers: McpServerRef[] = [{
      name: 'test',
      command: 'node',
      args: ['${MCP_ROOT}/entry.js'],
    }]

    const result = expandVariables(servers, { MCP_ROOT: '/home/user/.agents/mcp-servers' })

    assert.strictEqual(result[0].args[0], '/home/user/.agents/mcp-servers/entry.js')
  })

  it('replaces variables in env', async () => {
    const { expandVariables } = await import('../../../src/mcp/mcp-config-merger.js')

    const servers: McpServerRef[] = [{
      name: 'test',
      command: 'node',
      args: [],
      env: {
        TOKEN: '${AUTH_TOKEN}',
        ORG: '${AUTH_ORG_ID}',
      },
    }]

    const result = expandVariables(servers, { AUTH_TOKEN: 'tk_123', AUTH_ORG_ID: 'org_456' })

    assert.strictEqual(result[0].env!.TOKEN, 'tk_123')
    assert.strictEqual(result[0].env!.ORG, 'org_456')
  })

  it('leaves missing variables as-is', async () => {
    const { expandVariables } = await import('../../../src/mcp/mcp-config-merger.js')

    const servers: McpServerRef[] = [{
      name: 'test',
      command: 'node',
      args: ['${UNKNOWN_VAR}/entry.js'],
    }]

    const result = expandVariables(servers, {})

    assert.strictEqual(result[0].args[0], '${UNKNOWN_VAR}/entry.js')
  })

  it('handles multiple variables in one string', async () => {
    const { expandVariables } = await import('../../../src/mcp/mcp-config-merger.js')

    const servers: McpServerRef[] = [{
      name: 'test',
      command: 'node',
      args: ['${ROOT}/${SUB}/file.js'],
    }]

    const result = expandVariables(servers, { ROOT: '/a', SUB: 'b' })

    assert.strictEqual(result[0].args[0], '/a/b/file.js')
  })
})
