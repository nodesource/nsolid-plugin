/* eslint-disable no-template-curly-in-string */

import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { McpServerRef } from '../../../src/types.js'

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

const serverA: McpServerRef = {
  name: 'ns-benchmark',
  command: 'node',
  args: ['/path/to/ns-benchmark/src/mcp-entrypoint.js'],
  env: { NSOLID_SERVICE_TOKEN: '${AUTH_TOKEN}', NSOLID_ORG_ID: '${AUTH_ORG_ID}' },
}

describe('writeMcpConfig', () => {
  it('writes JSON config for Claude', async () => {
    const { writeMcpConfig } = await import('../../../src/mcp/mcp-config-writer.js')
    const { resolveHome } = await import('../../../src/utils/path.js')

    await writeMcpConfig('claude', [serverA])

    const configPath = resolveHome('~/.claude.json')
    assert.ok(existsSync(configPath))

    const content = JSON.parse(readFileSync(configPath, 'utf-8'))
    assert.ok('mcpServers' in content)
    assert.ok('ns-benchmark' in content.mcpServers)
    assert.strictEqual(content.mcpServers['ns-benchmark'].command, 'node')
  })

  it('preserves existing user servers in JSON config', async () => {
    const { writeMcpConfig } = await import('../../../src/mcp/mcp-config-writer.js')
    const { resolveHome } = await import('../../../src/utils/path.js')
    const { mkdirSync } = await import('node:fs')
    const { dirname } = await import('node:path')

    const configPath = resolveHome('~/.claude.json')
    mkdirSync(dirname(configPath), { recursive: true })
    writeFileSync(configPath, JSON.stringify({
      mcpServers: {
        'my-server': { command: 'python', args: ['server.py'] },
      },
    }, null, 2) + '\n')

    await writeMcpConfig('claude', [serverA])

    const content = JSON.parse(readFileSync(configPath, 'utf-8'))
    assert.ok('my-server' in content.mcpServers)
    assert.ok('ns-benchmark' in content.mcpServers)
    assert.strictEqual(Object.keys(content.mcpServers).length, 2)
  })

  it('writes TOML config for Codex', async () => {
    const { writeMcpConfig } = await import('../../../src/mcp/mcp-config-writer.js')
    const { resolveHome } = await import('../../../src/utils/path.js')
    const { parse: parseToml } = await import('smol-toml')

    await writeMcpConfig('codex', [serverA])

    const configPath = resolveHome('~/.codex/config.toml')
    assert.ok(existsSync(configPath))

    const content = parseToml(readFileSync(configPath, 'utf-8')) as Record<string, unknown>
    assert.ok('mcp_servers' in content)
    const servers = content.mcp_servers as Record<string, unknown>
    assert.ok('ns-benchmark' in servers)
  })

  it('reads TOML mcp_servers and maps back correctly', async () => {
    const { writeMcpConfig } = await import('../../../src/mcp/mcp-config-writer.js')
    const { resolveHome } = await import('../../../src/utils/path.js')
    const { mkdirSync } = await import('node:fs')
    const { dirname } = await import('node:path')

    const configPath = resolveHome('~/.codex/config.toml')
    mkdirSync(dirname(configPath), { recursive: true })
    writeFileSync(configPath, '[mcp_servers.ns-benchmark]\ncommand = "node"\nargs = ["old.js"]\n')

    await writeMcpConfig('codex', [serverA])

    const content = readFileSync(configPath, 'utf-8')
    assert.ok(content.includes('ns-benchmark'))
    assert.ok(content.includes('/path/to/ns-benchmark/src/mcp-entrypoint.js'))
  })

  it('writes JSONC config for OpenCode with comment preservation', async () => {
    const { writeMcpConfig } = await import('../../../src/mcp/mcp-config-writer.js')
    const { resolveHome } = await import('../../../src/utils/path.js')
    const { mkdirSync } = await import('node:fs')
    const { dirname } = await import('node:path')

    const configPath = resolveHome('~/.config/opencode/opencode.jsonc')
    mkdirSync(dirname(configPath), { recursive: true })
    writeFileSync(configPath, '{\n  // This is a comment\n  "version": "1.0",\n  "mcpServers": {\n    // Existing MCP server comment\n    "my-server": { "command": "python", "args": ["server.py"] }\n  }\n}\n')

    await writeMcpConfig('opencode', [serverA])

    const content = readFileSync(configPath, 'utf-8')
    assert.ok(content.includes('// This is a comment'))
    assert.ok(content.includes('ns-benchmark'))
    assert.ok(content.includes('my-server'))
  })

  it('writes JSONC with no existing mcpServers key', async () => {
    const { writeMcpConfig } = await import('../../../src/mcp/mcp-config-writer.js')
    const { resolveHome } = await import('../../../src/utils/path.js')
    const { mkdirSync } = await import('node:fs')
    const { dirname } = await import('node:path')

    const configPath = resolveHome('~/.config/opencode/opencode.jsonc')
    mkdirSync(dirname(configPath), { recursive: true })
    writeFileSync(configPath, '{\n  // Config comment\n  "version": "1.0"\n}\n')

    await writeMcpConfig('opencode', [serverA])

    const content = readFileSync(configPath, 'utf-8')
    assert.ok(content.includes('// Config comment'))
    assert.ok(content.includes('"mcpServers"'))
    assert.ok(content.includes('ns-benchmark'))
  })

  it('writes JSONC to new file', async () => {
    const { writeMcpConfig } = await import('../../../src/mcp/mcp-config-writer.js')
    const { resolveHome } = await import('../../../src/utils/path.js')

    await writeMcpConfig('opencode', [serverA])

    const configPath = resolveHome('~/.config/opencode/opencode.jsonc')
    assert.ok(existsSync(configPath))

    const content = JSON.parse(readFileSync(configPath, 'utf-8'))
    assert.ok('ns-benchmark' in content.mcpServers)
  })

  it('preserves other top-level keys in JSON config', async () => {
    const { writeMcpConfig } = await import('../../../src/mcp/mcp-config-writer.js')
    const { resolveHome } = await import('../../../src/utils/path.js')
    const { mkdirSync } = await import('node:fs')
    const { dirname } = await import('node:path')

    const configPath = resolveHome('~/.claude.json')
    mkdirSync(dirname(configPath), { recursive: true })
    writeFileSync(configPath, JSON.stringify({
      version: '1.0',
      theme: 'dark',
      mcpServers: {
        'my-server': { command: 'python', args: ['server.py'] },
      },
    }, null, 2) + '\n')

    await writeMcpConfig('claude', [serverA])

    const content = JSON.parse(readFileSync(configPath, 'utf-8'))
    assert.strictEqual(content.version, '1.0')
    assert.strictEqual(content.theme, 'dark')
    assert.ok('my-server' in content.mcpServers)
    assert.ok('ns-benchmark' in content.mcpServers)
  })

  it('preserves other top-level keys in TOML config', async () => {
    const { writeMcpConfig } = await import('../../../src/mcp/mcp-config-writer.js')
    const { resolveHome } = await import('../../../src/utils/path.js')
    const { mkdirSync } = await import('node:fs')
    const { dirname } = await import('node:path')
    const { parse: parseToml } = await import('smol-toml')

    const configPath = resolveHome('~/.codex/config.toml')
    mkdirSync(dirname(configPath), { recursive: true })
    writeFileSync(configPath, '[model]\nname = "gpt-4"\ntemperature = 0.7\n\n[mcp_servers.existing]\ncommand = "node"\nargs = ["server.js"]\n')

    await writeMcpConfig('codex', [serverA])

    const content = parseToml(readFileSync(configPath, 'utf-8')) as Record<string, unknown>
    const model = content.model as Record<string, unknown>
    assert.strictEqual(model.name, 'gpt-4')
    assert.strictEqual(model.temperature, 0.7)
    assert.ok('mcp_servers' in content)
    const servers = content.mcp_servers as Record<string, unknown>
    assert.ok('existing' in servers)
    assert.ok('ns-benchmark' in servers)
  })

  it('skips Pi harness', async () => {
    const { writeMcpConfig } = await import('../../../src/mcp/mcp-config-writer.js')

    const result = await writeMcpConfig('pi', [serverA])
    assert.strictEqual(result, undefined)
  })

  it('expands variables when provided', async () => {
    const { writeMcpConfig } = await import('../../../src/mcp/mcp-config-writer.js')
    const { resolveHome } = await import('../../../src/utils/path.js')

    const variables = { AUTH_TOKEN: 'tk_123', AUTH_ORG_ID: 'org_456' }
    await writeMcpConfig('claude', [serverA], variables)

    const configPath = resolveHome('~/.claude.json')
    const content = JSON.parse(readFileSync(configPath, 'utf-8'))
    const server = content.mcpServers['ns-benchmark']
    assert.strictEqual(server.env.NSOLID_SERVICE_TOKEN, 'tk_123')
    assert.strictEqual(server.env.NSOLID_ORG_ID, 'org_456')
  })

  it('writes JSONC with existing trailing comma', async () => {
    const { writeMcpConfig } = await import('../../../src/mcp/mcp-config-writer.js')
    const { resolveHome } = await import('../../../src/utils/path.js')
    const { mkdirSync } = await import('node:fs')
    const { dirname } = await import('node:path')
    const { parseJsonc } = await import('../../../src/utils/config.js')

    const configPath = resolveHome('~/.config/opencode/opencode.jsonc')
    mkdirSync(dirname(configPath), { recursive: true })
    writeFileSync(configPath, '{\n  // Comment\n  "version": "1.0",\n}\n')

    await writeMcpConfig('opencode', [serverA])

    const content = readFileSync(configPath, 'utf-8')
    assert.ok(content.includes('// Comment'))
    assert.ok(content.includes('ns-benchmark'))

    const parsed = parseJsonc(content) as Record<string, unknown>
    assert.strictEqual(parsed.version, '1.0')
    const mcpServers = parsed.mcpServers as Record<string, unknown>
    assert.ok('ns-benchmark' in mcpServers)
  })

  it('writes JSONC with multi-property trailing comma', async () => {
    const { writeMcpConfig } = await import('../../../src/mcp/mcp-config-writer.js')
    const { resolveHome } = await import('../../../src/utils/path.js')
    const { mkdirSync } = await import('node:fs')
    const { dirname } = await import('node:path')

    const configPath = resolveHome('~/.config/opencode/opencode.jsonc')
    mkdirSync(dirname(configPath), { recursive: true })
    writeFileSync(configPath, '{\n  "version": "1.0",\n  "theme": "dark",\n}\n')

    await writeMcpConfig('opencode', [serverA])

    const content = readFileSync(configPath, 'utf-8')
    assert.ok(content.includes('ns-benchmark'))

    const parsed = JSON.parse(content)
    assert.strictEqual(parsed.version, '1.0')
    assert.strictEqual(parsed.theme, 'dark')
    assert.ok('ns-benchmark' in parsed.mcpServers)
  })
})

describe('removeMcpConfig', () => {
  it('removes servers from JSON config', async () => {
    const { writeMcpConfig, removeMcpConfig } = await import('../../../src/mcp/mcp-config-writer.js')
    const { resolveHome } = await import('../../../src/utils/path.js')

    await writeMcpConfig('claude', [serverA])
    await removeMcpConfig('claude', ['ns-benchmark'])

    const configPath = resolveHome('~/.claude.json')
    assert.ok(existsSync(configPath))
    const content = JSON.parse(readFileSync(configPath, 'utf-8'))
    assert.deepStrictEqual(content.mcpServers, {})
  })

  it('removes servers from JSONC config preserving comments', async () => {
    const { removeMcpConfig } = await import('../../../src/mcp/mcp-config-writer.js')
    const { resolveHome } = await import('../../../src/utils/path.js')
    const { mkdirSync } = await import('node:fs')
    const { dirname } = await import('node:path')

    const configPath = resolveHome('~/.config/opencode/opencode.jsonc')
    mkdirSync(dirname(configPath), { recursive: true })
    writeFileSync(configPath, '{\n  // Top comment\n  "mcpServers": {\n    // Server comment\n    "ns-benchmark": { "command": "node", "args": ["a.js"] }\n  }\n}\n')

    await removeMcpConfig('opencode', ['ns-benchmark'])

    const content = readFileSync(configPath, 'utf-8')
    assert.ok(content.includes('// Top comment'))
    assert.ok(!content.includes('ns-benchmark'))
  })

  it('handles nonexistent config file', async () => {
    const { removeMcpConfig } = await import('../../../src/mcp/mcp-config-writer.js')
    const { resolveHome } = await import('../../../src/utils/path.js')

    const result = await removeMcpConfig('antigravity', ['ns-benchmark'])
    assert.strictEqual(result, undefined)
    assert.strictEqual(existsSync(resolveHome('~/.gemini/antigravity-cli/mcp_config.json')), false)
  })

  it('removes mcpServers when it is not the last property in JSONC', async () => {
    const { removeMcpConfig } = await import('../../../src/mcp/mcp-config-writer.js')
    const { resolveHome } = await import('../../../src/utils/path.js')
    const { mkdirSync } = await import('node:fs')
    const { dirname } = await import('node:path')

    const configPath = resolveHome('~/.config/opencode/opencode.jsonc')
    mkdirSync(dirname(configPath), { recursive: true })
    writeFileSync(configPath, '{\n  "mcpServers": {\n    "ns-benchmark": { "command": "node", "args": ["a.js"] }\n  },\n  "version": "1.0"\n}\n')

    await removeMcpConfig('opencode', ['ns-benchmark'])

    const content = readFileSync(configPath, 'utf-8')
    assert.ok(!content.includes('ns-benchmark'))
    assert.ok(content.includes('"version": "1.0"'))

    // Verify it's valid JSON
    const parsed = JSON.parse(content)
    assert.strictEqual(parsed.version, '1.0')
    assert.ok(!('mcpServers' in parsed))
  })

  it('does not create JSON config when file is missing', async () => {
    const { removeMcpConfig } = await import('../../../src/mcp/mcp-config-writer.js')
    const { resolveHome } = await import('../../../src/utils/path.js')

    await removeMcpConfig('claude', ['ns-benchmark'])

    const configPath = resolveHome('~/.claude.json')
    assert.strictEqual(existsSync(configPath), false)
  })

  it('does not create TOML config when file is missing', async () => {
    const { removeMcpConfig } = await import('../../../src/mcp/mcp-config-writer.js')
    const { resolveHome } = await import('../../../src/utils/path.js')

    await removeMcpConfig('codex', ['ns-benchmark'])

    const configPath = resolveHome('~/.codex/config.toml')
    assert.strictEqual(existsSync(configPath), false)
  })

  it('does not create JSONC config when file is missing', async () => {
    const { removeMcpConfig } = await import('../../../src/mcp/mcp-config-writer.js')
    const { resolveHome } = await import('../../../src/utils/path.js')

    await removeMcpConfig('opencode', ['ns-benchmark'])

    const configPath = resolveHome('~/.config/opencode/opencode.jsonc')
    assert.strictEqual(existsSync(configPath), false)
  })

  it('does not create antigravity config when file is missing', async () => {
    const { removeMcpConfig } = await import('../../../src/mcp/mcp-config-writer.js')
    const { resolveHome } = await import('../../../src/utils/path.js')

    await removeMcpConfig('antigravity', ['ns-benchmark'])

    const configPath = resolveHome('~/.gemini/antigravity-cli/mcp_config.json')
    assert.strictEqual(existsSync(configPath), false)
  })

  it('removes mcpServers when it is not the last property in JSONC', async () => {
    const { removeMcpConfig } = await import('../../../src/mcp/mcp-config-writer.js')
    const { resolveHome } = await import('../../../src/utils/path.js')
    const { mkdirSync } = await import('node:fs')
    const { dirname } = await import('node:path')

    const configPath = resolveHome('~/.config/opencode/opencode.jsonc')
    mkdirSync(dirname(configPath), { recursive: true })
    writeFileSync(configPath, '{\n  "mcpServers": {\n    "ns-benchmark": { "command": "node", "args": ["a.js"] }\n  },\n  "version": "1.0"\n}\n')

    await removeMcpConfig('opencode', ['ns-benchmark'])

    const content = readFileSync(configPath, 'utf-8')
    assert.ok(!content.includes('ns-benchmark'))
    assert.ok(content.includes('"version": "1.0"'))

    // Verify it's valid JSON
    const parsed = JSON.parse(content)
    assert.strictEqual(parsed.version, '1.0')
    assert.ok(!('mcpServers' in parsed))
  })
})
