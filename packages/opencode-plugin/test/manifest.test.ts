import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const PLUGIN_DIR = join(__dirname, '..')

function loadManifest () {
  const manifestPath = join(PLUGIN_DIR, 'package.json')
  return JSON.parse(readFileSync(manifestPath, 'utf-8'))
}

function loadIndex () {
  const indexPath = join(PLUGIN_DIR, 'index.js')
  return readFileSync(indexPath, 'utf-8')
}

describe('OpenCode plugin', () => {
  it('has required name field', () => {
    const manifest = loadManifest()
    assert.ok(manifest.name, 'manifest must have a name')
    assert.strictEqual(typeof manifest.name, 'string')
  })

  it('has main pointing to index.js', () => {
    const manifest = loadManifest()
    assert.strictEqual(manifest.main, 'index.js')
  })

  it('has plugin-core dependency', () => {
    const manifest = loadManifest()
    assert.ok(manifest.dependencies?.['@nodesource/plugin-core'], 'must depend on plugin-core')
  })

  it('index.js exports NsolidPlugin', () => {
    const index = loadIndex()
    assert.ok(index.includes('export const NsolidPlugin'), 'must export NsolidPlugin')
  })

  it('index.js sets NSOLID_HARNESS to opencode', () => {
    const index = loadIndex()
    assert.ok(index.includes("NSOLID_HARNESS = 'opencode'"), 'must set harness to opencode')
  })
})
