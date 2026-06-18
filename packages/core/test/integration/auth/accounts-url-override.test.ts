import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { resolveAccountsUrl } from '../../../src/index.js'

let originalStaging: string | undefined
let originalAccountsUrl: string | undefined

beforeEach(() => {
  originalStaging = process.env.NSOLID_STAGING
  originalAccountsUrl = process.env.NSOLID_ACCOUNTS_URL
  delete process.env.NSOLID_STAGING
  delete process.env.NSOLID_ACCOUNTS_URL
})

afterEach(() => {
  if (originalStaging !== undefined) process.env.NSOLID_STAGING = originalStaging
  else delete process.env.NSOLID_STAGING
  if (originalAccountsUrl !== undefined) process.env.NSOLID_ACCOUNTS_URL = originalAccountsUrl
  else delete process.env.NSOLID_ACCOUNTS_URL
})

describe('resolveAccountsUrl', () => {
  it('returns the default URL unchanged when env vars are unset', () => {
    const result = resolveAccountsUrl('https://accounts.nodesource.com')
    assert.strictEqual(result, 'https://accounts.nodesource.com')
  })

  it('overrides to staging when NSOLID_STAGING=1', () => {
    process.env.NSOLID_STAGING = '1'
    const result = resolveAccountsUrl('https://accounts.nodesource.com')
    assert.strictEqual(result, 'https://staging.accounts.nodesource.com')
  })

  it('overrides to staging when NSOLID_STAGING=true', () => {
    process.env.NSOLID_STAGING = 'true'
    const result = resolveAccountsUrl('https://accounts.nodesource.com')
    assert.strictEqual(result, 'https://staging.accounts.nodesource.com')
  })

  it('explicit NSOLID_ACCOUNTS_URL wins over NSOLID_STAGING', () => {
    process.env.NSOLID_STAGING = '1'
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
    process.env.NSOLID_STAGING = '1'
    resolveAccountsUrl('https://accounts.nodesource.com', logger)
    assert.ok(warnings.some((w) => w.includes('auth.accountsUrl.overridden')))
  })
})
