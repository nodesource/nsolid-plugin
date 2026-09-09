import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { classifyVersionSet, classifyVersions, compareVersions, isStableVersion, parseStableVersion } from '../../../src/update/version.js'

describe('update semantic versions', () => {
  it('parses only stable semantic versions', () => {
    assert.deepEqual(parseStableVersion('1.2.3'), { major: 1, minor: 2, patch: 3 })
    assert.equal(parseStableVersion('1.2'), null)
    assert.equal(parseStableVersion('1.2.3-beta.1'), null)
    assert.equal(parseStableVersion(' 1.2.3 '), null)
    assert.equal(isStableVersion('0.0.0'), true)
  })

  it('compares versions without a runtime semver dependency', () => {
    assert.equal(compareVersions('1.2.3', '1.2.3'), 0)
    assert.ok(compareVersions('1.2.4', '1.2.3') > 0)
    assert.ok(compareVersions('2.0.0', '10.0.0') < 0)
  })

  it('distinguishes current, update, newer, and unknown states', () => {
    assert.equal(classifyVersions('1.0.0', '1.0.0').status, 'current')
    assert.equal(classifyVersions('1.0.0', '1.0.1').status, 'update-available')
    assert.equal(classifyVersions('1.0.2', '1.0.1').status, 'newer-than-registry')
    assert.equal(classifyVersions(undefined, '1.0.1').status, 'unknown')
  })

  it('marks a multi-cache target updateable when any affected cache is stale or missing', () => {
    const result = classifyVersionSet(['1.0.2', '1.0.0'], '1.0.2')
    assert.equal(result.status, 'update-available')
    assert.equal(result.current, '1.0.0')
    assert.deepEqual(result.currentVersions, ['1.0.2', '1.0.0'])
    assert.equal(classifyVersionSet(['1.0.2', undefined], '1.0.2').status, 'update-available')
  })

  it('does not update a multi-cache target when every copy is at least latest', () => {
    const result = classifyVersionSet(['1.0.1', '1.0.2'], '1.0.1')
    assert.equal(result.status, 'newer-than-registry')
    assert.equal(result.current, '1.0.1')
  })
})
