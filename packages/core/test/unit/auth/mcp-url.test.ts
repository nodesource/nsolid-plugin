import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { deriveMcpUrlFromConsoleUrl } from '../../../src/auth/mcp-url.js'

describe('deriveMcpUrlFromConsoleUrl', () => {
  it('derives the MCP host from the org id, not the console URL label', () => {
    // Regression: an aliased console (e.g. a friendly display name) must not
    // leak into the MCP host — the org's UUID is the only label accounts-api
    // ever provisions a real .mcp. ingress route under.
    assert.strictEqual(
      deriveMcpUrlFromConsoleUrl('https://homedepot-nucleus-stage-1.saas.nodesource.io', '602b4703-8a7c-405a-ac1e-70bc98c3a915'),
      'https://602b4703-8a7c-405a-ac1e-70bc98c3a915.mcp.saas.nodesource.io/'
    )
  })

  it('still works when the console URL label already matches the org id', () => {
    assert.strictEqual(
      deriveMcpUrlFromConsoleUrl('https://org-123.saas.nodesource.io', 'org-123'),
      'https://org-123.mcp.saas.nodesource.io/'
    )
  })

  it('preserves a non-default environment suffix (e.g. staging)', () => {
    assert.strictEqual(
      deriveMcpUrlFromConsoleUrl('https://some-alias.staging.saas.nodesource.io', 'org-456'),
      'https://org-456.mcp.staging.saas.nodesource.io/'
    )
  })

  it('returns null for a non-NodeSource console URL', () => {
    assert.strictEqual(deriveMcpUrlFromConsoleUrl('https://console.example.test', 'org-123'), null)
  })

  it('returns null for an unparseable console URL', () => {
    assert.strictEqual(deriveMcpUrlFromConsoleUrl('not a url', 'org-123'), null)
  })

  it('returns null for a bare hostname with no suffix to trust', () => {
    assert.strictEqual(deriveMcpUrlFromConsoleUrl('https://localhost', 'org-123'), null)
  })

  it('rejects a console URL whose suffix only contains saas as a label substring', () => {
    // Regression: a dot-less endsWith check would accept `foo-saas.nodesource.io`
    // because the naive check matches "…saas.nodesource.io" as a suffix even
    // though `saas` is not a whole label. That host is not an ingress route.
    assert.strictEqual(deriveMcpUrlFromConsoleUrl('https://alias.extra-saas.nodesource.io', 'org-123'), null)
    assert.strictEqual(deriveMcpUrlFromConsoleUrl('https://alias.foosaas.nodesource.io', 'org-123'), null)
  })

  it('accepts the exact saas suffix and dot-delimited deeper suffixes only', () => {
    assert.strictEqual(
      deriveMcpUrlFromConsoleUrl('https://pretty-name.saas.nodesource.io', 'org-1'),
      'https://org-1.mcp.saas.nodesource.io/'
    )
    assert.strictEqual(
      deriveMcpUrlFromConsoleUrl('https://pretty-name.staging.saas.nodesource.io', 'org-2'),
      'https://org-2.mcp.staging.saas.nodesource.io/'
    )
  })
})
