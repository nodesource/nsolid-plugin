import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, existsSync } from 'node:fs'
import path from 'node:path'

describe('Pi plugin', () => {
  const pkg = JSON.parse(readFileSync(path.resolve('packages/pi-plugin/package.json'), 'utf8'))

  it('keeps the npm package name and uses N|Solid Plugin in description', () => {
    assert.strictEqual(pkg.name, 'nsolid-pi-plugin')
    assert.match(pkg.description, /N\|Solid Plugin/)
  })

  it('has pi-package keyword', () => {
    assert.ok(pkg.keywords?.includes('pi-package'))
  })

  it('declares a pi extension and package-owned skills', () => {
    assert.ok(Array.isArray(pkg.pi?.extensions))
    assert.ok(pkg.pi.extensions.includes('./index.js'))
    assert.ok(Array.isArray(pkg.pi?.skills))
    assert.ok(pkg.pi.skills.includes('./skills'))
  })

  it('depends on nsolid-plugin (core)', () => {
    assert.ok(pkg.dependencies?.['nsolid-plugin'])
  })

  it('is publishable (not private)', () => {
    assert.notStrictEqual(pkg.private, true)
  })

  it('uses canonical root skills instead of committed package skill copies', () => {
    assert.strictEqual(existsSync(path.resolve('packages/pi-plugin/skills')), false, 'source tree should not keep generated package skill copies')
    assert.strictEqual(existsSync(path.resolve('packages/core/skills')), false, 'source tree should not keep generated core package skill copies')
    assert.ok(existsSync(path.resolve('skills/ns-analyze-asset/SKILL.md')), 'canonical root skill must exist')
  })

  it('index.js exists and has no install/setup side effects', () => {
    const indexPath = path.resolve('packages/pi-plugin/index.js')
    assert.ok(existsSync(indexPath))
    const source = readFileSync(indexPath, 'utf8')
    assert.match(source, /side-effect free/)
    assert.doesNotMatch(source, /require\(|import\(/)
    assert.doesNotMatch(source, /install\(|setup\(/)
  })
})
