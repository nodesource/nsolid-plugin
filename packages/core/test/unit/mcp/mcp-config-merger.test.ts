/* eslint-disable no-template-curly-in-string */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import type { McpServerRef } from '../../../src/types.js'

const serverA: McpServerRef = {
  name: 'ns-benchmark',
  url: 'https://benchmark.mcp.saas.nodesource.io/mcp',
  headers: { 'X-Nsolid-Service-Token': '${AUTH_TOKEN}', 'X-Nsolid-Org-Id': '${AUTH_ORG_ID}' },
}

const serverB: McpServerRef = {
  name: 'nsolid-console',
  url: '${MCP_URL}',
  headers: { 'X-Nsolid-Service-Token': '${AUTH_TOKEN}' },
}

describe('mergeMcpConfig', () => {
  it('adds servers to empty config', async () => {
    const { mergeMcpConfig } = await import('../../../src/mcp/mcp-config-merger.js')

    const result = mergeMcpConfig({ mcpServers: {} }, [serverA])

    assert.ok('ns-benchmark' in result.mcpServers)
    assert.strictEqual(result.mcpServers['ns-benchmark'].url, 'https://benchmark.mcp.saas.nodesource.io/mcp')
    assert.ok(result.mcpServers['ns-benchmark'].headers)
  })

  it('preserves existing user servers', async () => {
    const { mergeMcpConfig } = await import('../../../src/mcp/mcp-config-merger.js')

    const existing = {
      mcpServers: {
        'my-custom-server': { url: 'http://localhost:8080', headers: { Authorization: 'Bearer abc' } },
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
        'ns-benchmark': { url: 'https://old-url.example.com', headers: {} },
      },
    }

    const result = mergeMcpConfig(existing, [serverA])

    assert.strictEqual(result.mcpServers['ns-benchmark'].url, 'https://benchmark.mcp.saas.nodesource.io/mcp')
  })

  it('preserves extended server fields and headers when upserting', async () => {
    const { mergeMcpConfig } = await import('../../../src/mcp/mcp-config-merger.js')

    const existing = {
      mcpServers: {
        'ns-benchmark': {
          url: 'https://old-url.example.com',
          headers: { 'X-Nsolid-Service-Token': 'old-token', 'X-Custom': 'keep' },
          type: 'stdio',
          command: 'node',
          args: ['server.js'],
          env: { NODE_ENV: 'test' },
          customField: true,
        },
      },
    }

    const result = mergeMcpConfig(existing, [serverA])
    const server = result.mcpServers['ns-benchmark']

    assert.strictEqual(server.url, 'https://benchmark.mcp.saas.nodesource.io/mcp')
    assert.strictEqual(server.headers['X-Nsolid-Service-Token'], '${AUTH_TOKEN}')
    assert.strictEqual(server.headers['X-Custom'], 'keep')
    assert.strictEqual(server.type, 'stdio')
    assert.strictEqual(server.command, 'node')
    assert.deepStrictEqual(server.args, ['server.js'])
    assert.deepStrictEqual(server.env, { NODE_ENV: 'test' })
    assert.strictEqual(server.customField, true)
  })

  it('handles mixed scenario (preserves and updates)', async () => {
    const { mergeMcpConfig } = await import('../../../src/mcp/mcp-config-merger.js')

    const existing = {
      mcpServers: {
        'my-server': { url: 'http://localhost:3000', headers: {} },
        'ns-benchmark': { url: 'https://old.example.com', headers: {} },
      },
    }

    const result = mergeMcpConfig(existing, [serverA, serverB])

    assert.strictEqual(Object.keys(result.mcpServers).length, 3)
    assert.ok('my-server' in result.mcpServers)
    assert.ok('ns-benchmark' in result.mcpServers)
    assert.ok('nsolid-console' in result.mcpServers)
    assert.strictEqual(result.mcpServers['ns-benchmark'].url, 'https://benchmark.mcp.saas.nodesource.io/mcp')
  })

  it('does not mutate original config', async () => {
    const { mergeMcpConfig } = await import('../../../src/mcp/mcp-config-merger.js')

    const existing = {
      mcpServers: {
        'my-server': { url: 'http://localhost:3000', headers: {} },
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
        'ns-benchmark': { url: 'https://a.example.com', headers: {} },
        'nsolid-console': { url: 'https://b.example.com', headers: {} },
        'my-server': { url: 'http://localhost:3000', headers: {} },
      },
    }

    const result = removeMcpServers(existing, ['ns-benchmark'])

    assert.strictEqual(Object.keys(result.mcpServers).length, 2)
    assert.ok(!('ns-benchmark' in result.mcpServers))
    assert.ok('nsolid-console' in result.mcpServers)
    assert.ok('my-server' in result.mcpServers)
  })

  it('removes multiple servers', async () => {
    const { removeMcpServers } = await import('../../../src/mcp/mcp-config-merger.js')

    const existing = {
      mcpServers: {
        'ns-benchmark': { url: 'https://a.example.com', headers: {} },
        'nsolid-console': { url: 'https://b.example.com', headers: {} },
        ncm: { url: 'https://c.example.com', headers: {} },
      },
    }

    const result = removeMcpServers(existing, ['ns-benchmark', 'nsolid-console'])

    assert.strictEqual(Object.keys(result.mcpServers).length, 1)
    assert.ok(!('ns-benchmark' in result.mcpServers))
    assert.ok(!('nsolid-console' in result.mcpServers))
    assert.ok('ncm' in result.mcpServers)
  })

  it('handles nonexistent server name', async () => {
    const { removeMcpServers } = await import('../../../src/mcp/mcp-config-merger.js')

    const existing = {
      mcpServers: {
        'ns-benchmark': { url: 'https://a.example.com', headers: {} },
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
        'ns-benchmark': { url: 'https://a.example.com', headers: {} },
      },
    }

    const originalKeys = Object.keys(existing.mcpServers)
    removeMcpServers(existing, ['ns-benchmark'])

    assert.deepStrictEqual(Object.keys(existing.mcpServers), originalKeys)
  })
})

describe('expandVariables', () => {
  it('replaces variables in url', async () => {
    const { expandVariables } = await import('../../../src/mcp/mcp-config-merger.js')

    const servers: McpServerRef[] = [{
      name: 'test',
      url: '${MCP_URL}/entry',
      headers: {},
    }]

    const result = expandVariables(servers, { MCP_URL: 'https://abc.mcp.saas.nodesource.io' })

    assert.strictEqual(result[0].url, 'https://abc.mcp.saas.nodesource.io/entry')
  })

  it('replaces variables in headers', async () => {
    const { expandVariables } = await import('../../../src/mcp/mcp-config-merger.js')

    const servers: McpServerRef[] = [{
      name: 'test',
      url: 'https://example.com',
      headers: {
        TOKEN: '${AUTH_TOKEN}',
        ORG: '${AUTH_ORG_ID}',
      },
    }]

    const result = expandVariables(servers, { AUTH_TOKEN: 'tk_123', AUTH_ORG_ID: 'org_456' })

    assert.strictEqual(result[0].headers.TOKEN, 'tk_123')
    assert.strictEqual(result[0].headers.ORG, 'org_456')
  })

  it('leaves missing variables as-is', async () => {
    const { expandVariables } = await import('../../../src/mcp/mcp-config-merger.js')

    const servers: McpServerRef[] = [{
      name: 'test',
      url: '${UNKNOWN_VAR}/entry',
      headers: {},
    }]

    const result = expandVariables(servers, {})

    assert.strictEqual(result[0].url, '${UNKNOWN_VAR}/entry')
  })

  it('handles multiple variables in one string', async () => {
    const { expandVariables } = await import('../../../src/mcp/mcp-config-merger.js')

    const servers: McpServerRef[] = [{
      name: 'test',
      url: '${PROTOCOL}://${HOST}/${PATH}',
      headers: {},
    }]

    const result = expandVariables(servers, { PROTOCOL: 'https', HOST: 'example.com', PATH: 'mcp' })

    assert.strictEqual(result[0].url, 'https://example.com/mcp')
  })
})
