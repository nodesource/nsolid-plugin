import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { deriveMcpUrlFromConsoleUrl, isLegacyAliasMcpUrl, resolveMcpUrl } from '../../../src/auth/mcp-url.js'

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

describe('isLegacyAliasMcpUrl', () => {
  it('flags a stored mcpUrl rebuilt from the console URL alias label', () => {
    // Regression: the previous release stored the alias-derived endpoint
    // (e.g. `<alias>.mcp.saas.nodesource.io/`), which is dead for aliased
    // consoles. It must be detected so callers can migrate to the org-UUID
    // route.
    assert.strictEqual(
      isLegacyAliasMcpUrl(
        'https://homedepot-nucleus-stage-1.mcp.saas.nodesource.io/',
        'https://homedepot-nucleus-stage-1.saas.nodesource.io',
        '602b4703-8a7c-405a-ac1e-70bc98c3a915'
      ),
      true
    )
  })

  it('flags a legacy value for a staging console', () => {
    assert.strictEqual(
      isLegacyAliasMcpUrl(
        'https://alias.staging.mcp.saas.nodesource.io/',
        'https://alias.staging.saas.nodesource.io',
        'org-456'
      ),
      true
    )
  })

  it('does not flag a stored mcpUrl whose label already matches the org id', () => {
    assert.strictEqual(
      isLegacyAliasMcpUrl('https://org-123.mcp.saas.nodesource.io/', 'https://org-123.saas.nodesource.io', 'org-123'),
      false
    )
  })

  it('preserves a genuine custom override on a different host', () => {
    assert.strictEqual(
      isLegacyAliasMcpUrl('https://relay.example.com/mcp', 'https://alias.saas.nodesource.io', 'org-123'),
      false
    )
  })

  it('preserves a custom override on a different NodeSource host', () => {
    assert.strictEqual(
      isLegacyAliasMcpUrl('https://custom-relay.mcp.saas.nodesource.io/', 'https://alias.saas.nodesource.io', 'org-123'),
      false
    )
  })

  it('is false for a non-NodeSource console URL', () => {
    assert.strictEqual(
      isLegacyAliasMcpUrl('https://alias.mcp.example.com/', 'https://alias.example.com', 'org-123'),
      false
    )
  })

  it('is false for unparseable input', () => {
    assert.strictEqual(isLegacyAliasMcpUrl('not a url', 'https://alias.saas.nodesource.io', 'org-123'), false)
    assert.strictEqual(isLegacyAliasMcpUrl('https://alias.mcp.saas.nodesource.io/', 'not a url', 'org-123'), false)
  })
})

describe('resolveMcpUrl', () => {
  const credentials = (mcpUrl: string, consoleUrl: string, organizationId: string) => ({ mcpUrl, consoleUrl, organizationId })

  it('migrates a legacy alias-derived stored value to the org-UUID route', () => {
    assert.strictEqual(
      resolveMcpUrl(credentials('https://homedepot-nucleus-stage-1.mcp.saas.nodesource.io/', 'https://homedepot-nucleus-stage-1.saas.nodesource.io', '602b4703-8a7c-405a-ac1e-70bc98c3a915')),
      'https://602b4703-8a7c-405a-ac1e-70bc98c3a915.mcp.saas.nodesource.io/'
    )
  })

  it('preserves a genuine custom override', () => {
    assert.strictEqual(
      resolveMcpUrl(credentials('https://relay.example.com/mcp', 'https://alias.saas.nodesource.io', 'org-123')),
      'https://relay.example.com/mcp'
    )
  })

  it('prefers an explicit stored value over derivation', () => {
    assert.strictEqual(
      resolveMcpUrl(credentials('https://org-123.mcp.saas.nodesource.io/', 'https://org-123.saas.nodesource.io', 'org-123')),
      'https://org-123.mcp.saas.nodesource.io/'
    )
  })

  it('derives from consoleUrl + organizationId when no mcpUrl is stored', () => {
    assert.strictEqual(
      resolveMcpUrl(credentials('', 'https://pretty-name.saas.nodesource.io', 'org-1')),
      'https://org-1.mcp.saas.nodesource.io/'
    )
  })

  it('returns null when derivation is impossible', () => {
    assert.strictEqual(resolveMcpUrl(credentials('', 'https://console.example.test', 'org-123')), null)
  })
})
