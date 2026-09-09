import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { bytesMatchIntegrity, parseIntegrity } from '../../../src/update/integrity.js'

describe('npm artifact integrity', () => {
  it('accepts unpadded base64url SRI and canonicalizes its padding', () => {
    const bytes = new TextEncoder().encode('verified artifact bytes')
    const canonical = createHash('sha512').update(bytes).digest('base64')
    const base64url = canonical
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '')
    const integrity = `sha512-${base64url}`

    assert.equal(bytesMatchIntegrity(bytes, integrity), true)
    assert.equal(parseIntegrity(integrity)?.digest, canonical)
  })

  it('rejects malformed or mismatched integrity values', () => {
    const bytes = new TextEncoder().encode('artifact')
    assert.equal(bytesMatchIntegrity(bytes, 'md5-invalid'), false)
    assert.equal(bytesMatchIntegrity(bytes, 'sha512-d3Jvbmc='), false)
  })
})
