import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, existsSync } from 'node:fs'
import path from 'node:path'

describe('Pi plugin', () => {
  const pkg = JSON.parse(readFileSync(path.resolve('packages/pi-plugin/package.json'), 'utf8'))

  it('has correct name', () => {
    assert.strictEqual(pkg.name, '@nodesource/pi-plugin')
  })

  it('has pi-package keyword', () => {
    assert.ok(pkg.keywords?.includes('pi-package'))
  })

  it('declares a pi extension', () => {
    assert.ok(Array.isArray(pkg.pi?.extensions))
    assert.ok(pkg.pi.extensions.includes('./index.js'))
  })

  it('depends on plugin-core', () => {
    assert.ok(pkg.dependencies?.['@nodesource/plugin-core'])
  })

  it('is private', () => {
    assert.strictEqual(pkg.private, true)
  })

  it('index.js exists', () => {
    assert.ok(existsSync(path.resolve('packages/pi-plugin/index.js')))
  })
})
