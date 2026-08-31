import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { isRemotePath } from '../../../src/update/fallback-ownership.js'

describe('fallback ownership paths', () => {
  it('classifies UNC and Windows device paths as remote destructive targets', () => {
    assert.equal(isRemotePath('\\\\server\\share\\skills'), true)
    assert.equal(isRemotePath('//server/share/skills'), true)
    assert.equal(isRemotePath('\\\\?\\UNC\\server\\share\\skills'), true)
    assert.equal(isRemotePath('C:\\Users\\alice\\skills'), false)
  })
})
