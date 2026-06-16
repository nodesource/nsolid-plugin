import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const PLUGIN_DIR = join(__dirname, '..')

function loadManifest () {
  const manifestPath = join(PLUGIN_DIR, '.claude-plugin', 'plugin.json')
  return JSON.parse(readFileSync(manifestPath, 'utf-8'))
}

describe('Claude plugin manifest', () => {
  it('has required name field', () => {
    const manifest = loadManifest()
    assert.ok(manifest.name, 'manifest must have a name')
    assert.strictEqual(typeof manifest.name, 'string')
  })

  it('has hooks pointing to valid path', () => {
    const manifest = loadManifest()
    assert.ok(manifest.hooks, 'manifest must have hooks')
    assert.ok(manifest.hooks.endsWith('.json'))
  })

  it('has version field', () => {
    const manifest = loadManifest()
    assert.ok(manifest.version, 'manifest must have a version')
  })

  it('has displayName', () => {
    const manifest = loadManifest()
    assert.ok(manifest.displayName, 'manifest must have displayName')
  })
})
