import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, existsSync } from 'node:fs'
import path from 'node:path'

describe('Antigravity plugin', () => {
  const pkg = JSON.parse(readFileSync(path.resolve('packages/antigravity-plugin/package.json'), 'utf8'))
  const manifest = JSON.parse(readFileSync(path.resolve('packages/antigravity-plugin/plugin.json'), 'utf8'))

  it('has a name', () => {
    assert.strictEqual(typeof manifest.name, 'string')
    assert.ok(manifest.name.length > 0)
  })

  it('depends on plugin-core', () => {
    assert.ok(pkg.dependencies?.['@nodesource/plugin-core'])
  })

  it('is private', () => {
    assert.strictEqual(pkg.private, true)
  })

  it('install.js exists', () => {
    assert.ok(existsSync(path.resolve('packages/antigravity-plugin/scripts/install.js')))
  })

  it('does not bundle mcp_config.json.template', () => {
    assert.ok(!existsSync(path.resolve('packages/antigravity-plugin/mcp_config.json.template')))
  })
})
