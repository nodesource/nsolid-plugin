import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { planMcpReconciliation } from '../../../src/update/mcp-reconciliation.js'

const desired = [{ name: 'nsolid-console', url: 'https://example.com/mcp', headers: {} }]

function values (servers: readonly { name: string }[]): Record<string, Record<string, unknown>> {
  return Object.fromEntries(servers.map((server) => [server.name, { url: 'https://example.com/mcp', headers: {} }]))
}

describe('MCP multi-config reconciliation planning', () => {
  it('keeps an existing server in its registered configuration file', () => {
    const plan = planMcpReconciliation({
      previousServers: [{ name: 'nsolid-console', configPath: '/home/user/.config/opencode/other.jsonc', fields: { url: 'a' } }],
      desiredServers: desired,
      desiredValues: values(desired),
      canonicalConfigPath: '/home/user/.config/opencode/opencode.jsonc',
    })
    assert.equal(plan.kind, 'planned')
    if (plan.kind !== 'planned') return
    assert.deepEqual(plan.destinations, { 'nsolid-console': '/home/user/.config/opencode/other.jsonc' })
    const entry = plan.entries.find((candidate) => candidate.configPath === '/home/user/.config/opencode/other.jsonc')
    assert.ok(entry)
    assert.deepEqual(entry.updateFields.map((field) => field.field), ['url', 'headers'])
    assert.deepEqual(entry.ownedFieldDigests.map((field) => field.field), ['url'])
  })

  it('plans stale-server removal only in the file that owns the record', () => {
    const plan = planMcpReconciliation({
      previousServers: [
        { name: 'stale-server', configPath: '/configs/first.json', fields: { url: 'a' } },
        { name: 'stale-server', configPath: '/configs/second.json', fields: { url: 'b' } },
      ].slice(0, 1),
      desiredServers: [],
      desiredValues: {},
      canonicalConfigPath: '/configs/canonical.json',
    })
    assert.equal(plan.kind, 'planned')
    if (plan.kind !== 'planned') return
    assert.deepEqual(plan.entries, [{
      configPath: '/configs/first.json',
      removeServers: ['stale-server'],
      upsertServers: [],
      updateFields: [],
      removeFields: [],
      ownedFieldDigests: [],
    }])
  })

  it('sends new servers to the single pre-existing configuration path', () => {
    const plan = planMcpReconciliation({
      previousServers: [{ name: 'old-server', configPath: '/configs/custom.json', fields: { url: 'a' } }],
      desiredServers: [...desired, { name: 'brand-new', url: 'https://example.com/mcp', headers: {} }],
      desiredValues: values([...desired, { name: 'brand-new', url: 'https://example.com/mcp', headers: {} }]),
      canonicalConfigPath: '/configs/canonical.json',
    })
    assert.equal(plan.kind, 'planned')
    if (plan.kind !== 'planned') return
    assert.equal(plan.destinations['brand-new'], '/configs/custom.json')
    assert.equal(plan.destinations['nsolid-console'], '/configs/custom.json')
  })

  it('falls back to the canonical adapter path when previous paths are split', () => {
    const plan = planMcpReconciliation({
      previousServers: [
        { name: 'one', configPath: '/configs/a.json', fields: { url: 'a' } },
        { name: 'two', configPath: '/configs/b.json', fields: { url: 'b' } },
      ],
      desiredServers: [...desired, { name: 'brand-new', url: 'https://example.com/mcp', headers: {} }],
      desiredValues: values([...desired, { name: 'brand-new', url: 'https://example.com/mcp', headers: {} }]),
      canonicalConfigPath: '/configs/canonical.json',
    })
    assert.equal(plan.kind, 'planned')
    if (plan.kind !== 'planned') return
    assert.equal(plan.destinations['brand-new'], '/configs/canonical.json')
    assert.equal(plan.destinations['nsolid-console'], '/configs/canonical.json')
    // Stale previous servers are removals in their own files.
    const removals = plan.entries.flatMap((entry) => entry.removeServers)
    assert.deepEqual(removals.sort(), ['one', 'two'])
  })

  it('returns MCP_RECONCILIATION_REQUIRED for a server registered in multiple files', () => {
    const plan = planMcpReconciliation({
      previousServers: [
        { name: 'nsolid-console', configPath: '/configs/a.json', fields: { url: 'a' } },
        { name: 'nsolid-console', configPath: '/configs/b.json', fields: { url: 'b' } },
      ],
      desiredServers: desired,
      desiredValues: values(desired),
      canonicalConfigPath: '/configs/canonical.json',
    })
    assert.equal(plan.kind, 'reconciliation-required')
    if (plan.kind !== 'reconciliation-required') return
    assert.equal(plan.code, 'MCP_RECONCILIATION_REQUIRED')
  })

  it('returns MCP_RECONCILIATION_REQUIRED when a new server has no resolvable destination', () => {
    const plan = planMcpReconciliation({
      previousServers: [],
      desiredServers: desired,
      desiredValues: values(desired),
    })
    assert.equal(plan.kind, 'reconciliation-required')
    if (plan.kind !== 'reconciliation-required') return
    assert.equal(plan.code, 'MCP_RECONCILIATION_REQUIRED')
  })

  it('tracks owned-field digests for drift validation before patching', () => {
    const plan = planMcpReconciliation({
      previousServers: [{ name: 'nsolid-console', configPath: '/configs/a.json', fields: { url: 'digest-url', headers: 'digest-headers' } }],
      desiredServers: desired,
      desiredValues: { 'nsolid-console': { url: 'https://new', headers: {} } },
      canonicalConfigPath: '/configs/canonical.json',
    })
    assert.equal(plan.kind, 'planned')
    if (plan.kind !== 'planned') return
    const entry = plan.entries[0]
    assert.deepEqual(entry.ownedFieldDigests, [
      { server: 'nsolid-console', field: 'url', expectedDigest: 'digest-url' },
      { server: 'nsolid-console', field: 'headers', expectedDigest: 'digest-headers' },
    ])
    // Both tracked fields exist in the desired value, so both are updates.
    assert.deepEqual(entry.updateFields, [
      { server: 'nsolid-console', field: 'url', value: 'https://new' },
      { server: 'nsolid-console', field: 'headers', value: {} },
    ])
    assert.deepEqual(entry.removeFields, [])
  })
})
