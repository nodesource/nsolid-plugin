import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

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
    process.env.USERPROFILE = originalUserProfile
  }
})

const entries = [
  { name: 'ns-benchmark', configPath: '~/.claude.json' },
  { name: 'nsolid-console', configPath: '~/.claude.json' },
]

describe('addTrackedMcps', () => {
  it('creates tracking file with MCP entries', async () => {
    const { addTrackedMcps } = await import('../../../src/mcp/mcp-tracker.js')
    const { readTrackingFile } = await import('../../../src/skills/skill-tracker.js')

    await addTrackedMcps(entries, 'claude')

    const tracking = await readTrackingFile()
    assert.notStrictEqual(tracking, null)
    assert.strictEqual(tracking!.mcpServers.length, 2)
    assert.strictEqual(tracking!.mcpServers[0].name, 'ns-benchmark')
    assert.strictEqual(tracking!.mcpServers[0].harness, 'claude')
    assert.ok(tracking!.mcpServers[0].configuredAt)
  })

  it('does not duplicate identical MCP + harness entries', async () => {
    const { addTrackedMcps } = await import('../../../src/mcp/mcp-tracker.js')
    const { readTrackingFile } = await import('../../../src/skills/skill-tracker.js')

    await addTrackedMcps(entries, 'claude')
    await addTrackedMcps(entries, 'claude')

    const tracking = await readTrackingFile()
    assert.strictEqual(tracking!.mcpServers.length, 2)
  })

  it('allows same MCP name across different harnesses', async () => {
    const { addTrackedMcps } = await import('../../../src/mcp/mcp-tracker.js')
    const { readTrackingFile } = await import('../../../src/skills/skill-tracker.js')

    await addTrackedMcps([entries[0]], 'claude')
    await addTrackedMcps([entries[0]], 'codex')

    const tracking = await readTrackingFile()
    assert.strictEqual(tracking!.mcpServers.length, 2)
    assert.strictEqual(
      tracking!.mcpServers.filter((m) => m.name === 'ns-benchmark').length,
      2
    )
  })

  it('stores normalized absolute paths', async () => {
    const { addTrackedMcps } = await import('../../../src/mcp/mcp-tracker.js')
    const { readTrackingFile } = await import('../../../src/skills/skill-tracker.js')

    await addTrackedMcps([entries[0]], 'claude')

    const tracking = await readTrackingFile()
    const configPath = tracking!.mcpServers[0].configPath
    assert.ok(configPath.startsWith(tmpDir))
  })

  it('stores ISO8601 configuredAt timestamps', async () => {
    const { addTrackedMcps } = await import('../../../src/mcp/mcp-tracker.js')
    const { readTrackingFile } = await import('../../../src/skills/skill-tracker.js')

    await addTrackedMcps([entries[0]], 'claude')

    const tracking = await readTrackingFile()
    const entry = tracking!.mcpServers[0]
    assert.strictEqual(new Date(entry.configuredAt).toISOString(), entry.configuredAt)
  })
})

describe('removeTrackedMcps', () => {
  it('removes MCP entry for specific harness', async () => {
    const { addTrackedMcps, removeTrackedMcps, listTrackedMcps } = await import('../../../src/mcp/mcp-tracker.js')

    await addTrackedMcps(entries, 'claude')
    await addTrackedMcps([entries[0]], 'codex')
    await removeTrackedMcps(['ns-benchmark'], 'claude')

    const listed = await listTrackedMcps()
    assert.strictEqual(listed.length, 2)
    // Claude's ns-benchmark removed, Codex's ns-benchmark + Claude's nsolid-console remain
    const benchmarkEntries = listed.filter((m) => m.name === 'ns-benchmark')
    assert.strictEqual(benchmarkEntries.length, 1)
    assert.strictEqual(benchmarkEntries[0].harness, 'codex')
  })

  it('removes all matching names when no harness specified', async () => {
    const { addTrackedMcps, removeTrackedMcps, listTrackedMcps } = await import('../../../src/mcp/mcp-tracker.js')

    await addTrackedMcps([entries[0]], 'claude')
    await addTrackedMcps([entries[0]], 'codex')
    await removeTrackedMcps(['ns-benchmark'])

    const listed = await listTrackedMcps()
    assert.strictEqual(listed.length, 0)
  })

  it('deletes tracking file when skills and mcpServers are both empty', async () => {
    const { addTrackedMcps, removeTrackedMcps } = await import('../../../src/mcp/mcp-tracker.js')
    const { readTrackingFile } = await import('../../../src/skills/skill-tracker.js')
    const { getTrackingFilePath } = await import('../../../src/utils/path.js')
    const { existsSync } = await import('node:fs')

    await addTrackedMcps([entries[0]], 'claude')
    await removeTrackedMcps(['ns-benchmark'], 'claude')

    assert.ok(!existsSync(getTrackingFilePath()))
    assert.strictEqual(await readTrackingFile(), null)
  })

  it('does nothing when tracking file missing', async () => {
    const { removeTrackedMcps } = await import('../../../src/mcp/mcp-tracker.js')

    const result = await removeTrackedMcps(['ns-benchmark'])
    assert.strictEqual(result, undefined)
  })
})

describe('listTrackedMcps', () => {
  it('returns empty array when no tracking file', async () => {
    const { listTrackedMcps } = await import('../../../src/mcp/mcp-tracker.js')

    assert.deepStrictEqual(await listTrackedMcps(), [])
  })

  it('returns empty array for corrupted tracking file', async () => {
    const { listTrackedMcps } = await import('../../../src/mcp/mcp-tracker.js')
    const { mkdirSync } = await import('node:fs')
    const { getAgentsDir, getTrackingFilePath } = await import('../../../src/utils/path.js')

    mkdirSync(getAgentsDir(), { recursive: true })
    writeFileSync(getTrackingFilePath(), 'not valid json')

    assert.deepStrictEqual(await listTrackedMcps(), [])
  })

  it('returns all tracked MCPs without filter', async () => {
    const { addTrackedMcps, listTrackedMcps } = await import('../../../src/mcp/mcp-tracker.js')

    await addTrackedMcps(entries, 'claude')

    const listed = await listTrackedMcps()
    assert.strictEqual(listed.length, 2)
    assert.deepStrictEqual(
      listed.map((m) => m.name),
      ['ns-benchmark', 'nsolid-console']
    )
  })

  it('filters by harness', async () => {
    const { addTrackedMcps, listTrackedMcps } = await import('../../../src/mcp/mcp-tracker.js')

    await addTrackedMcps([entries[0]], 'claude')
    await addTrackedMcps([entries[1]], 'codex')

    const claudeEntries = await listTrackedMcps('claude')
    assert.strictEqual(claudeEntries.length, 1)
    assert.strictEqual(claudeEntries[0].name, 'ns-benchmark')

    const codexEntries = await listTrackedMcps('codex')
    assert.strictEqual(codexEntries.length, 1)
    assert.strictEqual(codexEntries[0].name, 'nsolid-console')
  })
})
