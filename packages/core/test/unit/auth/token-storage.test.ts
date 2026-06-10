import { describe, it, beforeEach, afterEach, expect } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { Credentials } from '../../../src/types.js';

let tmpDir: string;
let originalHome: string | undefined;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'nsolid-test-'));
  originalHome = process.env.HOME;
  process.env.HOME = tmpDir;
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
  if (originalHome !== undefined) {
    process.env.HOME = originalHome;
  }
});

describe('token-storage', () => {
  it('saveCredentials and loadCredentials roundtrip', async () => {
    const { saveCredentials, loadCredentials } = await import('../../../src/auth/token-storage.js');
    
    const creds: Credentials = {
      serviceToken: 'test-token-123',
      organizationId: 'org-456',
      saasToken: 'test-saas-token',
      consoleUrl: 'https://test.saas.nodesource.io',
      mcpUrl: 'https://org-456.mcp.saas.nodesource.io',
      expiresAt: '2026-12-31T23:59:59Z',
      permissions: ['nsolid:benchmark:run']
    };
    
    saveCredentials(creds);
    const loaded = loadCredentials();
    
    expect(loaded).not.toBeNull();
    expect(loaded).toEqual(creds);
  });

  it('loadCredentials returns null when file does not exist', async () => {
    const { loadCredentials } = await import('../../../src/auth/token-storage.js');
    
    const result = loadCredentials();
    expect(result).toBeNull();
  });

  it('loadCredentials throws on invalid JSON', async () => {
    const { loadCredentials } = await import('../../../src/auth/token-storage.js');
    const { mkdirSync } = await import('node:fs');
    const { getAgentsDir, getAuthFilePath } = await import('../../../src/utils/path.js');
    
    mkdirSync(getAgentsDir(), { recursive: true });
    writeFileSync(getAuthFilePath(), 'not valid json');
    
    expect(() => loadCredentials()).toThrow(/Failed to parse/);
  });

  it('isExpired returns true for past date', async () => {
    const { isExpired } = await import('../../../src/auth/token-storage.js');
    
    const creds: Credentials = {
      serviceToken: 'token',
      organizationId: 'org',
      saasToken: 'saas',
      consoleUrl: 'https://test.saas.nodesource.io',
      mcpUrl: 'https://org.mcp.saas.nodesource.io',
      expiresAt: '2020-01-01T00:00:00Z'
    };
    
    expect(isExpired(creds)).toBe(true);
  });

  it('isExpired returns false for future date', async () => {
    const { isExpired } = await import('../../../src/auth/token-storage.js');
    
    const futureDate = new Date(Date.now() + 86400000).toISOString();
    const creds: Credentials = {
      serviceToken: 'token',
      organizationId: 'org',
      saasToken: 'saas',
      consoleUrl: 'https://test.saas.nodesource.io',
      mcpUrl: 'https://org.mcp.saas.nodesource.io',
      expiresAt: futureDate
    };
    
    expect(isExpired(creds)).toBe(false);
  });

  it('isExpired returns true for invalid date', async () => {
    const { isExpired } = await import('../../../src/auth/token-storage.js');
    
    const creds: Credentials = {
      serviceToken: 'token',
      organizationId: 'org',
      saasToken: 'saas',
      consoleUrl: 'https://test.saas.nodesource.io',
      mcpUrl: 'https://org.mcp.saas.nodesource.io',
      expiresAt: 'not-a-valid-date'
    };
    
    expect(isExpired(creds)).toBe(true);
  });
});
