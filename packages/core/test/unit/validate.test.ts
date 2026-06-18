import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { validateBundle } from '../../src/validate.js'
import type { BundleDescriptor } from '../../src/types.js'

const validBundle: BundleDescriptor = {
  name: 'test-bundle',
  version: '1.0.0',
  description: 'Test bundle',
  skills: [
    { name: 'ns-test', path: 'skills/ns-test', description: 'Test skill' }
  ],
  mcpServers: [
    { name: 'test-mcp', url: 'https://mcp.example.com', headers: { Authorization: 'Bearer token' } }
  ]
}

describe('validateBundle', () => {
  it('validates a complete bundle descriptor', () => {
    const result = validateBundle(validBundle)
    assert.deepStrictEqual(result, validBundle)
  })

  it('validates bundle with all optional fields', () => {
    const bundle: BundleDescriptor = {
      name: 'full-bundle',
      version: '2.0.0',
      description: 'Full bundle with auth',
      skills: [
        {
          name: 'ns-analyze-cpu',
          path: 'skills/ns-analyze-cpu',
          description: 'Analyze CPU usage',
          requiresMcp: ['nsolid-console']
        }
      ],
      mcpServers: [
        {
          name: 'nsolid-console',
          // eslint-disable-next-line no-template-curly-in-string
          url: '${MCP_URL}',
          headers: {
            // eslint-disable-next-line no-template-curly-in-string
            'X-Nsolid-Service-Token': '${AUTH_TOKEN}',
          }
        },
        {
          name: 'ncm',
          url: 'https://mcp.ncm.nodesource.com',
          headers: {
            // eslint-disable-next-line no-template-curly-in-string
            'X-Nsolid-Service-Token': '${AUTH_TOKEN}',
          }
        }
      ],
      auth: {
        type: 'oauth',
        provider: 'nodesource',
        accountsUrl: 'https://accounts.nodesource.com',
        callbackPort: 8765,
        requiredPermissions: ['nsolid:benchmark:run']
      }
    }
    const result = validateBundle(bundle)
    assert.deepStrictEqual(result, bundle)
  })

  it('rejects bundle missing required fields', () => {
    assert.throws(() => validateBundle({}), /validation failed/i)
  })

  it('rejects bundle with missing name', () => {
    assert.throws(() => validateBundle({ ...validBundle, name: undefined }), /validation failed/i)
  })

  it('rejects bundle with empty skills array', () => {
    assert.throws(() => validateBundle({ ...validBundle, skills: [] }), /validation failed/i)
  })

  it('rejects bundle with empty mcpServers array', () => {
    assert.throws(() => validateBundle({ ...validBundle, mcpServers: [] }), /validation failed/i)
  })

  it('rejects skill missing required name', () => {
    const bad = {
      ...validBundle,
      skills: [{ path: 'skills/x', description: 'No name' }]
    }
    assert.throws(() => validateBundle(bad), /validation failed/i)
  })

  it('rejects auth with wrong type enum', () => {
    const bad = {
      ...validBundle,
      auth: { type: 'apikey' }
    }
    assert.throws(() => validateBundle(bad), /validation failed/i)
  })

  it('accepts valid origin-only accountsUrl values', () => {
    const urls = [
      'https://accounts.nodesource.com',
      'https://accounts.nodesource.com/',
      'https://accounts.nodesource.com:8080',
      'https://accounts.nodesource.com:8080/',
    ]
    for (const accountsUrl of urls) {
      const bundle = {
        ...validBundle,
        auth: {
          type: 'oauth',
          provider: 'nodesource',
          accountsUrl,
        }
      }
      assert.doesNotThrow(() => validateBundle(bundle), `Expected ${accountsUrl} to be valid`)
    }
  })

  it('rejects accountsUrl with path, query, or hash', () => {
    const urls = [
      'https://accounts.nodesource.com/api/v1',
      'https://accounts.nodesource.com?foo=bar',
      'https://accounts.nodesource.com#section',
      'https://accounts.nodesource.com/path?query=1#hash',
      'not-a-url',
    ]
    for (const accountsUrl of urls) {
      const bundle = {
        ...validBundle,
        auth: {
          type: 'oauth',
          provider: 'nodesource',
          accountsUrl,
        }
      }
      assert.throws(() => validateBundle(bundle), /validation failed/i, `Expected ${accountsUrl} to be invalid`)
    }
  })

  it('rejects skill with duplicate requiresMcp entries', () => {
    const bad = {
      ...validBundle,
      skills: [{
        name: 'ns-test',
        path: 'skills/ns-test',
        description: 'Test skill',
        requiresMcp: ['nsolid-console', 'nsolid-console']
      }]
    }
    assert.throws(() => validateBundle(bad), /validation failed/i)
  })
})
