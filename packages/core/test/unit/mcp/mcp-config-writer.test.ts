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

describe('writeAdapterMcpConfig', () => {
  it('writes JSON config replacing existing servers (round-trip)', async () => {
    const { writeAdapterMcpConfig } = await import('../../../src/mcp/mcp-config-writer.js')
    const { resolveHome } = await import('../../../src/utils/path.js')
    const { mkdirSync } = await import('node:fs')
    const { dirname } = await import('node:path')

    const configPath = resolveHome('~/.claude.json')
    mkdirSync(dirname(configPath), { recursive: true })
    writeFileSync(configPath, JSON.stringify({
      mcpServers: {
        'old-server': { command: 'python', args: ['old.py'] },
        'keep-this': { command: 'node', args: ['keep.js'] },
      },
    }, null, 2) + '\n')

    writeAdapterMcpConfig('claude', {
      mcpServers: {
        'keep-this': { command: 'node', args: ['keep.js'] },
        'new-server': { command: 'go', args: ['new.go'] },
      },
    })

    const content = JSON.parse(readFileSync(configPath, 'utf-8'))
    assert.ok('keep-this' in content.mcpServers)
    assert.ok('new-server' in content.mcpServers)
    assert.ok(!('old-server' in content.mcpServers))
    assert.strictEqual(Object.keys(content.mcpServers).length, 2)
  })

  it('writes empty config clearing existing servers (JSON)', async () => {
    const { writeAdapterMcpConfig } = await import('../../../src/mcp/mcp-config-writer.js')
    const { resolveHome } = await import('../../../src/utils/path.js')
    const { mkdirSync } = await import('node:fs')
    const { dirname } = await import('node:path')

    const configPath = resolveHome('~/.claude.json')
    mkdirSync(dirname(configPath), { recursive: true })
    writeFileSync(configPath, JSON.stringify({
      mcpServers: { 'old-server': { command: 'python', args: ['old.py'] } },
    }, null, 2) + '\n')

    writeAdapterMcpConfig('claude', { mcpServers: {} })

    const content = JSON.parse(readFileSync(configPath, 'utf-8'))
    assert.deepStrictEqual(content.mcpServers, {})
  })

  it('writes to fresh file (JSON)', async () => {
    const { writeAdapterMcpConfig } = await import('../../../src/mcp/mcp-config-writer.js')
    const { resolveHome } = await import('../../../src/utils/path.js')

    writeAdapterMcpConfig('claude', {
      mcpServers: {
        'ns-benchmark': {
          command: 'node',
          args: ['/path/to/server.js'],
          env: { TOKEN: 'abc' },
        },
      },
    })

    const configPath = resolveHome('~/.claude.json')
    assert.ok(existsSync(configPath))
    const content = JSON.parse(readFileSync(configPath, 'utf-8'))
    assert.ok('ns-benchmark' in content.mcpServers)
    assert.strictEqual(content.mcpServers['ns-benchmark'].command, 'node')
  })

  it('preserves top-level keys in JSON config', async () => {
    const { writeAdapterMcpConfig } = await import('../../../src/mcp/mcp-config-writer.js')
    const { resolveHome } = await import('../../../src/utils/path.js')
    const { mkdirSync } = await import('node:fs')
    const { dirname } = await import('node:path')

    const configPath = resolveHome('~/.claude.json')
    mkdirSync(dirname(configPath), { recursive: true })
    writeFileSync(configPath, JSON.stringify({
      version: '2.0',
      theme: 'dark',
      mcpServers: {
        'old-server': { command: 'python', args: ['old.py'] },
      },
    }, null, 2) + '\n')

    writeAdapterMcpConfig('claude', {
      mcpServers: {
        'new-server': { command: 'node', args: ['new.js'] },
      },
    })

    const content = JSON.parse(readFileSync(configPath, 'utf-8'))
    assert.strictEqual(content.version, '2.0')
    assert.strictEqual(content.theme, 'dark')
    assert.ok(!('old-server' in content.mcpServers))
    assert.ok('new-server' in content.mcpServers)
  })

  it('writes JSONC config replacing existing servers preserving comments', async () => {
    const { writeAdapterMcpConfig } = await import('../../../src/mcp/mcp-config-writer.js')
    const { resolveHome } = await import('../../../src/utils/path.js')
    const { mkdirSync } = await import('node:fs')
    const { dirname } = await import('node:path')
    const { parseJsonc } = await import('../../../src/utils/config.js')

    const configPath = resolveHome('~/.config/opencode/opencode.jsonc')
    mkdirSync(dirname(configPath), { recursive: true })
    writeFileSync(configPath, '{\n  // Top comment\n  "version": "1.0",\n  "mcpServers": {\n    // Old server comment\n    "old-server": { "command": "python", "args": ["old.py"] }\n  }\n}\n')

    writeAdapterMcpConfig('opencode', {
      mcpServers: {
        'ns-benchmark': {
          command: 'node',
          args: ['/path/to/server.js'],
        },
      },
    })

    const content = readFileSync(configPath, 'utf-8')
    assert.ok(content.includes('// Top comment'))
    assert.ok(content.includes('ns-benchmark'))
    assert.ok(!content.includes('old-server'))
    assert.ok(!content.includes('// Old server comment'))

    const parsed = parseJsonc(content) as Record<string, unknown>
    assert.strictEqual(parsed.version, '1.0')
    const mcpServers = parsed.mcpServers as Record<string, unknown>
    assert.ok('ns-benchmark' in mcpServers)
    assert.ok(!('old-server' in mcpServers))
  })

  it('writes empty config clearing JSONC mcpServers block', async () => {
    const { writeAdapterMcpConfig } = await import('../../../src/mcp/mcp-config-writer.js')
    const { resolveHome } = await import('../../../src/utils/path.js')
    const { mkdirSync } = await import('node:fs')
    const { dirname } = await import('node:path')
    const { parseJsonc } = await import('../../../src/utils/config.js')

    const configPath = resolveHome('~/.config/opencode/opencode.jsonc')
    mkdirSync(dirname(configPath), { recursive: true })
    writeFileSync(configPath, '{\n  // Top comment\n  "version": "1.0",\n  "mcpServers": {\n    "old-server": { "command": "python", "args": ["old.py"] }\n  }\n}\n')

    writeAdapterMcpConfig('opencode', { mcpServers: {} })

    const content = readFileSync(configPath, 'utf-8')
    assert.ok(content.includes('// Top comment'))
    assert.ok(!content.includes('mcpServers'))
    assert.ok(!content.includes('old-server'))

    const parsed = parseJsonc(content) as Record<string, unknown>
    assert.strictEqual(parsed.version, '1.0')
    assert.ok(!('mcpServers' in parsed))
  })

  it('writes TOML config replacing existing servers', async () => {
    const { writeAdapterMcpConfig } = await import('../../../src/mcp/mcp-config-writer.js')
    const { resolveHome } = await import('../../../src/utils/path.js')
    const { mkdirSync } = await import('node:fs')
    const { dirname } = await import('node:path')
    const { parse: parseToml } = await import('smol-toml')

    const configPath = resolveHome('~/.codex/config.toml')
    mkdirSync(dirname(configPath), { recursive: true })
    writeFileSync(configPath, '[model]\nname = "gpt-4"\ntemperature = 0.7\n\n[mcp_servers.old-server]\ncommand = "python"\nargs = ["old.py"]\n')

    writeAdapterMcpConfig('codex', {
      mcpServers: {
        'new-server': { command: 'node', args: ['new.js'] },
      },
    })

    const content = parseToml(readFileSync(configPath, 'utf-8')) as Record<string, unknown>
    const model = content.model as Record<string, unknown>
    assert.strictEqual(model.name, 'gpt-4')
    assert.strictEqual(model.temperature, 0.7)
    const servers = content.mcp_servers as Record<string, unknown>
    assert.ok(!('old-server' in servers))
    assert.ok('new-server' in servers)
  })

  it('writes empty config clearing TOML mcp_servers', async () => {
    const { writeAdapterMcpConfig } = await import('../../../src/mcp/mcp-config-writer.js')
    const { resolveHome } = await import('../../../src/utils/path.js')
    const { mkdirSync } = await import('node:fs')
    const { dirname } = await import('node:path')
    const { parse: parseToml } = await import('smol-toml')

    const configPath = resolveHome('~/.codex/config.toml')
    mkdirSync(dirname(configPath), { recursive: true })
    writeFileSync(configPath, '[model]\nname = "gpt-4"\n\n[mcp_servers.old-server]\ncommand = "python"\nargs = ["old.py"]\n')

    writeAdapterMcpConfig('codex', { mcpServers: {} })

    const content = parseToml(readFileSync(configPath, 'utf-8')) as Record<string, unknown>
    assert.ok(!('mcp_servers' in content))
    const model = content.model as Record<string, unknown>
    assert.strictEqual(model.name, 'gpt-4')
  })

  it('writes Antigravity JSON config replacing existing', async () => {
    const { writeAdapterMcpConfig } = await import('../../../src/mcp/mcp-config-writer.js')
    const { resolveHome } = await import('../../../src/utils/path.js')
    const { mkdirSync } = await import('node:fs')
    const { dirname } = await import('node:path')

    const configPath = resolveHome('~/.gemini/antigravity-cli/mcp_config.json')
    mkdirSync(dirname(configPath), { recursive: true })
    writeFileSync(configPath, JSON.stringify({
      mcpServers: { 'old-server': { command: 'python', args: ['old.py'] } },
    }, null, 2))

    writeAdapterMcpConfig('antigravity', {
      mcpServers: {
        'new-server': { command: 'node', args: ['new.js'] },
      },
    })

    const content = JSON.parse(readFileSync(configPath, 'utf-8'))
    assert.ok('new-server' in content.mcpServers)
    assert.ok(!('old-server' in content.mcpServers))
  })

  it('Pi is a no-op', async () => {
    const { writeAdapterMcpConfig } = await import('../../../src/mcp/mcp-config-writer.js')

    const result = writeAdapterMcpConfig('pi', {
      mcpServers: { test: { command: 'node', args: ['test.js'] } },
    })
    assert.strictEqual(result, undefined)
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
})
