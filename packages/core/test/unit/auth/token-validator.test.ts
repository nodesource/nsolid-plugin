import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import type { ValidationResult } from '../../../src/auth/token-validator.js'

let originalFetch: typeof globalThis.fetch

beforeEach(() => {
  originalFetch = globalThis.fetch
})

afterEach(() => {
  globalThis.fetch = originalFetch
})

describe('validateToken', () => {
  it('derives the API origin from production accounts origin', async () => {
    const { deriveAccountsApiUrl } = await import('../../../src/auth/token-validator.js')

    assert.strictEqual(
      deriveAccountsApiUrl('https://accounts.nodesource.com'),
      'https://api.nodesource.com'
    )
    assert.strictEqual(
      deriveAccountsApiUrl('https://accounts.example.com'),
      'https://accounts.example.com'
    )
  })

  it('calls the API origin for NodeSource accounts token validation', async () => {
    let requestedUrl = ''
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      requestedUrl = input.toString()
      return {
        ok: true,
        status: 200,
        headers: new Headers({ 'content-type': 'application/json' }),
        json: async () => ({ permissions: [] }),
      }
    }) as unknown as typeof fetch

    const { validateToken } = await import('../../../src/auth/token-validator.js')
    await validateToken('test-token', 'org-123', 'https://accounts.nodesource.com')

    const url = new URL(requestedUrl)
    assert.strictEqual(url.origin, 'https://api.nodesource.com')
    assert.strictEqual(url.pathname, '/accounts/org/access-token')
    assert.strictEqual(url.searchParams.get('tokenId'), 'test-token')
    assert.strictEqual(url.searchParams.get('orgId'), 'org-123')
  })

  it('returns valid with permissions on 200', async () => {
    globalThis.fetch = (async () => ({
      ok: true,
      status: 200,
      headers: new Headers({ 'content-type': 'application/json' }),
      json: async () => ({ permissions: ['nsolid:benchmark:run', 'nsolid:profile:read'] }),
    })) as unknown as typeof fetch

    const { validateToken } = await import('../../../src/auth/token-validator.js')
    const result = await validateToken('test-token', 'org-123', 'https://accounts.example.com')

    assert.deepStrictEqual(result, {
      valid: true,
      permissions: ['nsolid:benchmark:run', 'nsolid:profile:read'],
    } satisfies ValidationResult)
  })

  it('returns invalid on 401', async () => {
    globalThis.fetch = (async () => ({
      ok: false,
      status: 401,
    })) as unknown as typeof fetch

    const { validateToken } = await import('../../../src/auth/token-validator.js')
    const result = await validateToken('bad-token', 'org-123', 'https://accounts.example.com')

    assert.deepStrictEqual(result, {
      valid: false,
      reason: 'Invalid credentials',
    } satisfies ValidationResult)
  })

  it('returns invalid on 404 from the access-token endpoint', async () => {
    globalThis.fetch = (async () => ({
      ok: false,
      status: 404,
    })) as unknown as typeof fetch

    const { validateToken } = await import('../../../src/auth/token-validator.js')
    const result = await validateToken('missing-token', 'org-123', 'https://accounts.nodesource.com')

    assert.deepStrictEqual(result, {
      valid: false,
      reason: 'Invalid credentials',
    } satisfies ValidationResult)
  })

  it('throws on 500', async () => {
    globalThis.fetch = (async () => ({
      ok: false,
      status: 500,
    })) as unknown as typeof fetch

    const { validateToken } = await import('../../../src/auth/token-validator.js')
    await assert.rejects(
      validateToken('token', 'org-123', 'https://accounts.example.com'),
      /500/
    )
  })

  it('throws on timeout', { timeout: 15000 }, async () => {
    globalThis.fetch = (async (_url: string, init?: RequestInit) => {
      return new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          reject(new DOMException('The operation was aborted', 'AbortError'))
        })
      }) as Promise<Response>
    }) as unknown as typeof fetch

    const { validateToken } = await import('../../../src/auth/token-validator.js')
    await assert.rejects(
      validateToken('token', 'org-123', 'https://accounts.example.com'),
      /timed out/i
    )
  })

  it('handles malformed response (permissions not an array)', async () => {
    globalThis.fetch = (async () => ({
      ok: true,
      status: 200,
      headers: new Headers({ 'content-type': 'application/json' }),
      json: async () => ({ permissions: 'not-an-array' }),
    })) as unknown as typeof fetch

    const { validateToken } = await import('../../../src/auth/token-validator.js')
    await assert.rejects(
      validateToken('test-token', 'org-123', 'https://accounts.example.com'),
      /invalid permissions format/
    )
  })

  it('handles malformed response (non-string permissions filtered)', async () => {
    globalThis.fetch = (async () => ({
      ok: true,
      status: 200,
      headers: new Headers({ 'content-type': 'application/json' }),
      json: async () => ({ permissions: ['valid', 123, null, 'also-valid'] }),
    })) as unknown as typeof fetch

    const { validateToken } = await import('../../../src/auth/token-validator.js')
    const result = await validateToken('test-token', 'org-123', 'https://accounts.example.com')

    assert.deepStrictEqual(result, {
      valid: true,
      permissions: ['valid', 'also-valid'],
    } satisfies ValidationResult)
  })

  it('handles null response body', async () => {
    globalThis.fetch = (async () => ({
      ok: true,
      status: 200,
      headers: new Headers({ 'content-type': 'application/json' }),
      json: async () => null,
    })) as unknown as typeof fetch

    const { validateToken } = await import('../../../src/auth/token-validator.js')
    await assert.rejects(
      validateToken('token', 'org-123', 'https://accounts.example.com'),
      /invalid response format/
    )
  })

  it('rejects non-JSON content type', async () => {
    globalThis.fetch = (async () => ({
      ok: true,
      status: 200,
      headers: new Headers({ 'content-type': 'text/html' }),
      json: async () => ({ permissions: [] }),
    })) as unknown as typeof fetch

    const { validateToken } = await import('../../../src/auth/token-validator.js')
    await assert.rejects(
      validateToken('token', 'org-123', 'https://accounts.example.com'),
      /unexpected content type/
    )
  })
})
