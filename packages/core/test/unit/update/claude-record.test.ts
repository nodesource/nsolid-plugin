import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readClaudePluginScope } from '../../../src/update/claude-record.js'

describe('Claude plugin scope records', () => {
  it('accepts equivalent scope aliases and rejects conflicting aliases', () => {
    assert.equal(readClaudePluginScope({ scope: 'user', installationScope: 'user', metadata: { scope: 'user' } }), 'user')
    assert.equal(readClaudePluginScope({ scope: 'user', installationScope: 'project' }), undefined)
    assert.equal(readClaudePluginScope({ installationScope: 'local' }), 'local')
  })
})
