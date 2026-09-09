import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { isNsolidPluginImport, isNsolidPluginImportKey } from '../../../src/update/antigravity-provenance.js'
import { detectAntigravityLayout } from '../../../src/update/inventory.js'
import { validateStagedPlugin } from '../../../src/update/antigravity-transaction.js'

describe('Antigravity registration provenance predicate', () => {
  it('accepts entries that declare the canonical identity with an accepted source', () => {
    assert.equal(isNsolidPluginImport({ name: 'nsolid-plugin', source: 'antigravity' }), true)
    assert.equal(isNsolidPluginImport({ name: 'nsolid-plugin', source: 'https://github.com/NodeSource/nsolid-plugin' }), true)
    assert.equal(isNsolidPluginImport({ name: 'nsolid-plugin', source: 'https://github.com/NodeSource/nsolid-plugin.git' }), true)
    // The `plugin` field is an accepted identity alias, as in the prior inventory contract.
    assert.equal(isNsolidPluginImport({ plugin: 'nsolid-plugin', source: 'antigravity' }), true)
    // Source matching stays case-insensitive, as in the prior inventory contract.
    assert.equal(isNsolidPluginImport({ name: 'nsolid-plugin', source: 'HTTPS://GITHUB.COM/NodeSource/nsolid-plugin.GIT' }), true)
  })

  it('rejects a correct name with a missing, foreign, or spoofed source', () => {
    assert.equal(isNsolidPluginImport({ name: 'nsolid-plugin' }), false)
    assert.equal(isNsolidPluginImport({ name: 'nsolid-plugin', source: 'https://github.com/Evil/nsolid-plugin.git' }), false)
    assert.equal(isNsolidPluginImport({ name: 'nsolid-plugin', source: 'https://github.com/NodeSource/nsolid-plugin.git/' }), false)
    assert.equal(isNsolidPluginImport({ name: 'nsolid-plugin', source: 'git@github.com:NodeSource/nsolid-plugin.git' }), false)
    assert.equal(isNsolidPluginImport({ name: 'nsolid-plugin', source: 'https://github.com/NodeSource/nsolid-plugin-extra.git' }), false)
    assert.equal(isNsolidPluginImport({ name: 'nsolid-plugin', source: true }), false)
    assert.equal(isNsolidPluginImport({ name: 'nsolid-plugin', source: null }), false)
  })

  it('rejects non-entries and foreign identities', () => {
    assert.equal(isNsolidPluginImport(undefined), false)
    assert.equal(isNsolidPluginImport(null), false)
    assert.equal(isNsolidPluginImport('nsolid-plugin'), false)
    assert.equal(isNsolidPluginImport(true), false)
    assert.equal(isNsolidPluginImport([]), false)
    assert.equal(isNsolidPluginImport({ name: 'my-nsolid-plugin-helper', source: 'antigravity' }), false)
    assert.equal(isNsolidPluginImport({ source: 'antigravity' }), false)
  })

  it('recognizes only the canonical object key', () => {
    assert.equal(isNsolidPluginImportKey('nsolid-plugin'), true)
    assert.equal(isNsolidPluginImportKey('my-nsolid-plugin-helper'), false)
    assert.equal(isNsolidPluginImportKey('nsolid-plugin '), false)
    assert.equal(isNsolidPluginImportKey(''), false)
  })
})

describe('Antigravity provenance contract alignment', () => {
  // Every accepted import shape must be recognized by both the inventory
  // detection and the staged-plugin validation, and every rejected shape must
  // be rejected by both. A manifest that passes one module while the other
  // rejects it lets a lookalike registration through one side of the update.
  const accepted = [
    { imports: [{ name: 'nsolid-plugin', source: 'antigravity' }] },
    { imports: [{ name: 'nsolid-plugin', source: 'https://github.com/NodeSource/nsolid-plugin' }] },
    { imports: [{ name: 'nsolid-plugin', source: 'https://github.com/NodeSource/nsolid-plugin.git' }] },
    { imports: [{ plugin: 'nsolid-plugin', source: 'antigravity' }] },
    { imports: { 'nsolid-plugin': { name: 'nsolid-plugin', source: 'antigravity' } } },
    { imports: { 'nsolid-plugin': { name: 'nsolid-plugin', source: 'https://github.com/NodeSource/nsolid-plugin.git' } } },
  ]
  const rejected = [
    { imports: [{ name: 'nsolid-plugin' }] },
    { imports: [{ name: 'nsolid-plugin', source: 'https://github.com/Evil/nsolid-plugin.git' }] },
    { imports: [{ name: 'nsolid-plugin', source: 'https://github.com/NodeSource/nsolid-plugin.git/' }] },
    { imports: { 'nsolid-plugin': true } },
    { imports: { 'nsolid-plugin': { name: 'nsolid-plugin' } } },
    { imports: { 'my-nsolid-plugin-helper': { name: 'nsolid-plugin', source: 'antigravity' } } },
    { imports: { 'nsolid-plugin': { name: 'my-nsolid-plugin-helper', source: 'antigravity' } } },
    { imports: { other: { path: '/keep' } } },
    { },
  ]

  function setupFixture (manifestValue: unknown): { home: string; root: string; manifest: string } {
    const home = mkdtempSync(path.join(os.tmpdir(), 'nsolid-plugin-agy-provenance-'))
    const root = path.join(home, '.gemini', 'config', 'plugins', 'nsolid-plugin')
    mkdirSync(path.join(root, 'skills', 'example'), { recursive: true })
    writeFileSync(path.join(root, 'plugin.json'), JSON.stringify({ name: 'nsolid-plugin' }))
    writeFileSync(path.join(root, 'bundle.json'), JSON.stringify({ version: '1.0.0', skills: [{ name: 'example', path: 'skills/example' }] }))
    writeFileSync(path.join(root, 'skills', 'example', 'SKILL.md'), '# example')
    const manifest = path.join(home, '.gemini', 'config', 'import_manifest.json')
    writeFileSync(manifest, JSON.stringify(manifestValue))
    return { home, root, manifest }
  }

  it('validates manifest import shapes identically in inventory and transaction validation', () => {
    const previousHome = process.env.HOME
    const previousUserProfile = process.env.USERPROFILE
    try {
      for (const [shape, expected] of [...accepted.map((value) => [value, true] as const), ...rejected.map((value) => [value, false] as const)]) {
        const fixture = setupFixture(shape)
        process.env.HOME = fixture.home
        process.env.USERPROFILE = fixture.home
        try {
          const layout = detectAntigravityLayout()
          assert.equal(layout.layout !== undefined, expected, `inventory detection for ${JSON.stringify(shape)}`)
          assert.equal(layout.reason === undefined, expected, `inventory reason for ${JSON.stringify(shape)}`)
          assert.equal(validateStagedPlugin(fixture.root, fixture.manifest), expected, `staged validation for ${JSON.stringify(shape)}`)
        } finally {
          rmSync(fixture.home, { recursive: true, force: true })
        }
      }
    } finally {
      if (previousHome === undefined) delete process.env.HOME
      else process.env.HOME = previousHome
      if (previousUserProfile === undefined) delete process.env.USERPROFILE
      else process.env.USERPROFILE = previousUserProfile
    }
  })
})
