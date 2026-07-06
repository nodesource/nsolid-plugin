import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { resolveAccountsUrl } from '../../../src/index.js'

let originalAccountsUrl: string | undefined

beforeEach(() => {
  originalAccountsUrl = process.env.NSOLID_ACCOUNTS_URL
  delete process.env.NSOLID_ACCOUNTS_URL
})

afterEach(() => {
  if (originalAccountsUrl !== undefined) process.env.NSOLID_ACCOUNTS_URL = originalAccountsUrl
  else delete process.env.NSOLID_ACCOUNTS_URL
})

describe('resolveAccountsUrl', () => {
  it('returns the default URL unchanged when env vars are unset', () => {
    const result = resolveAccountsUrl('https://accounts.nodesource.com')
    assert.strictEqual(result, 'https://accounts.nodesource.com')
  })

  it('uses explicit NSOLID_ACCOUNTS_URL override', () => {
    process.env.NSOLID_ACCOUNTS_URL = 'https://custom.accounts.example.com'
    const result = resolveAccountsUrl('https://accounts.nodesource.com')
    assert.strictEqual(result, 'https://custom.accounts.example.com')
  })

  it('throws when override includes a path', () => {
    process.env.NSOLID_ACCOUNTS_URL = 'https://accounts.example.com/api/v1'
    assert.throws(
      () => resolveAccountsUrl('https://accounts.nodesource.com'),
      /origin-only/
    )
  })

  it('throws when override includes a query', () => {
    process.env.NSOLID_ACCOUNTS_URL = 'https://accounts.example.com?foo=bar'
    assert.throws(
      () => resolveAccountsUrl('https://accounts.nodesource.com'),
      /origin-only/
    )
  })

  it('throws when override includes a hash', () => {
    process.env.NSOLID_ACCOUNTS_URL = 'https://accounts.example.com#foo'
    assert.throws(
      () => resolveAccountsUrl('https://accounts.nodesource.com'),
      /origin-only/
    )
  })

  it('throws when override is not a valid URL', () => {
    process.env.NSOLID_ACCOUNTS_URL = 'not-a-url'
    assert.throws(
      () => resolveAccountsUrl('https://accounts.nodesource.com'),
      /Invalid NSOLID_ACCOUNTS_URL/
    )
  })

  it('warns when the URL is overridden', () => {
    const warnings: string[] = []
    const logger = {
      debug: () => {},
      info: () => {},
      warn: (msg: string, meta?: Record<string, unknown>) => { warnings.push(`${msg} ${JSON.stringify(meta)}`) },
      error: () => {},
    }
    process.env.NSOLID_ACCOUNTS_URL = 'https://custom.accounts.example.com'
    resolveAccountsUrl('https://accounts.nodesource.com', logger)
    assert.ok(warnings.some((w) => w.includes('auth.accountsUrl.overridden')))
  })
})
