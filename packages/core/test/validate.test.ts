import { describe, it } from 'node:test';
import { deepStrictEqual, strictEqual, throws } from 'node:assert';
import { validateBundle } from '../src/validate.js';
import type { BundleDescriptor } from '../src/types.js';

const validBundle: BundleDescriptor = {
  name: 'test-bundle',
  version: '1.0.0',
  description: 'Test bundle',
  skills: [
    { name: 'ns-test', path: 'skills/ns-test', description: 'Test skill' }
  ],
  mcpServers: [
    { name: 'test-mcp', command: 'node', args: ['server.js'] }
  ]
};

describe('validateBundle', () => {
  it('validates a complete bundle descriptor', () => {
    const result = validateBundle(validBundle);
    deepStrictEqual(result, validBundle);
  });

  it('validates bundle with all optional fields', () => {
    const bundle: BundleDescriptor = {
      name: 'full-bundle',
      version: '2.0.0',
      description: 'Full bundle with auth',
      skills: [
        {
          name: 'ns-analyze-cpu',
          path: 'skills/ns-analyze-cpu',
          description: 'CPU profiling',
          requiresMcp: ['nsolid-mcp']
        },
        {
          name: 'ns-audit-deps',
          path: 'skills/ns-audit-deps',
          description: 'Dependency audit',
          requiresMcp: ['ncm-mcp']
        }
      ],
      mcpServers: [
        {
          name: 'nsolid-mcp',
          command: 'node',
          args: ['${MCP_ROOT}/nsolid-mcp/src/mcp-entrypoint.js'],
          env: {
            NSOLID_SERVICE_TOKEN: '${AUTH_TOKEN}',
            NSOLID_ORG_ID: '${AUTH_ORG_ID}'
          }
        },
        {
          name: 'ncm-mcp',
          command: 'node',
          args: ['${MCP_ROOT}/ncm-mcp/src/mcp-entrypoint.js']
        }
      ],
      auth: {
        type: 'oauth',
        provider: 'nodesource',
        accountsUrl: 'https://accounts.nodesource.com',
        callbackPort: 8765,
        requiredPermissions: ['nsolid:benchmark:run']
      }
    };
    const result = validateBundle(bundle);
    deepStrictEqual(result, bundle);
  });

  it('rejects bundle missing required fields', () => {
    throws(() => validateBundle({}), /validation failed/i);
  });

  it('rejects bundle with missing name', () => {
    throws(
      () => validateBundle({ ...validBundle, name: undefined }),
      /validation failed/i
    );
  });

  it('rejects bundle with empty skills array', () => {
    throws(
      () => validateBundle({ ...validBundle, skills: [] }),
      /validation failed/i
    );
  });

  it('rejects bundle with empty mcpServers array', () => {
    throws(
      () => validateBundle({ ...validBundle, mcpServers: [] }),
      /validation failed/i
    );
  });

  it('rejects skill missing required name', () => {
    const bad = {
      ...validBundle,
      skills: [{ path: 'skills/x', description: 'No name' }]
    };
    throws(() => validateBundle(bad), /validation failed/i);
  });

  it('rejects auth with wrong type enum', () => {
    const bad = {
      ...validBundle,
      auth: { type: 'apikey' }
    };
    throws(() => validateBundle(bad), /validation failed/i);
  });

  it('rejects skill with duplicate requiresMcp entries', () => {
    const bad = {
      ...validBundle,
      skills: [{
        name: 'ns-test',
        path: 'skills/ns-test',
        description: 'Test skill',
        requiresMcp: ['nsolid-mcp', 'nsolid-mcp']
      }]
    };
    throws(() => validateBundle(bad), /validation failed/i);
  });
});