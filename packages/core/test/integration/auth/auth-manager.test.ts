import { describe, it, beforeEach, afterEach, expect, vi } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import http from 'node:http';
import { execFile } from 'node:child_process';
import type { AuthConfig, Credentials } from '../../../src/types.js';
import { getAuthFilePath, getAgentsDir } from '../../../src/utils/path.js';

vi.mock('node:child_process', () => ({
  execFile: vi.fn(),
}));

let tmpDir: string;
let originalHome: string | undefined;
let originalFetch: typeof globalThis.fetch;

const authConfig: AuthConfig = {
  type: 'oauth',
  provider: 'nodesource',
  accountsUrl: 'https://accounts.example.com',
  callbackPort: 8768,
};

function getStateFromMock(): string {
  const calls = vi.mocked(execFile).mock.calls;
  const args = calls[calls.length - 1][1] as string[];
  // Find the URL in args - it's the one that starts with http
  const urlStr = args.find((a: string) => a.startsWith('http'))!;
  const url = new URL(urlStr);
  return url.searchParams.get('state')!;
}

function sendOAuthCallback(port: number, delayMs = 200): Promise<void> {
  return new Promise((resolve, reject) => {
    setTimeout(() => {
      const state = getStateFromMock();
      const params = new URLSearchParams({
        success: 'true',
        token: 'oauth-token',
        consoleId: 'org-456',
        NSOLID_SAAS: 'oauth-saas-token',
        url: 'https://org-456.saas.nodesource.io',
        state,
      });
      http.get(`http://127.0.0.1:${port}/?${params}`, (res) => {
        res.resume();
        resolve();
      }).on('error', reject);
    }, delayMs);
  });
}

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'nsolid-test-'));
  originalHome = process.env.HOME;
  process.env.HOME = tmpDir;
  originalFetch = globalThis.fetch;
  vi.mocked(execFile).mockClear();
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
  if (originalHome !== undefined) {
    process.env.HOME = originalHome;
  }
  globalThis.fetch = originalFetch;
});

describe('ensureAuthenticated', () => {
  it('returns existing valid credentials (fast path)', async () => {
    const { saveCredentials } = await import('../../../src/auth/token-storage.js');

    const creds: Credentials = {
      serviceToken: 'existing-token',
      organizationId: 'org-123',
      saasToken: 'test-saas-token',
      consoleUrl: 'https://test.saas.nodesource.io',
      mcpUrl: 'https://org-123.mcp.saas.nodesource.io',
      expiresAt: new Date(Date.now() + 86400000).toISOString(),
      permissions: ['nsolid:benchmark:run'],
    };
    saveCredentials(creds);

    globalThis.fetch = (async () => ({
      ok: true,
      status: 200,
      headers: new Headers({ 'content-type': 'application/json' }),
      json: async () => ({ permissions: ['nsolid:benchmark:run'] }),
    })) as unknown as typeof fetch;

    const { ensureAuthenticated } = await import('../../../src/auth/auth-manager.js');
    const result = await ensureAuthenticated(authConfig);

    expect(result).toEqual(creds);
  });

  it('re-authenticates when credentials file is corrupt', { timeout: 10000 }, async () => {
    mkdirSync(getAgentsDir(), { recursive: true });
    writeFileSync(getAuthFilePath(), 'not valid json{{{', 'utf-8');

    const callback = sendOAuthCallback(8768);

    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Headers({ 'content-type': 'application/json' }),
      json: async () => ({ permissions: [] }),
    });

    const { ensureAuthenticated } = await import('../../../src/auth/auth-manager.js');
    const result = await ensureAuthenticated(authConfig);

    expect(result.serviceToken).toBe('oauth-token');
    expect(result.organizationId).toBe('org-456');
    expect(result.saasToken).toBe('oauth-saas-token');
    await callback;
  });

  it('re-authenticates when credentials are expired', { timeout: 10000 }, async () => {
    const { saveCredentials } = await import('../../../src/auth/token-storage.js');
    const expiredCreds: Credentials = {
      serviceToken: 'expired-token',
      organizationId: 'org-123',
      saasToken: 'expired-saas',
      consoleUrl: 'https://expired.saas.nodesource.io',
      mcpUrl: 'https://org-123.mcp.saas.nodesource.io',
      expiresAt: new Date(Date.now() - 1000).toISOString(),
    };
    saveCredentials(expiredCreds);

    const callback = sendOAuthCallback(8768);

    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Headers({ 'content-type': 'application/json' }),
      json: async () => ({ permissions: [] }),
    });

    const { ensureAuthenticated } = await import('../../../src/auth/auth-manager.js');
    const result = await ensureAuthenticated(authConfig);

    expect(result.serviceToken).toBe('oauth-token');
    expect(result.organizationId).toBe('org-456');
    await callback;
  });

  it('falls back to OAuth when API is unavailable during fast path', { timeout: 10000 }, async () => {
    const { saveCredentials } = await import('../../../src/auth/token-storage.js');
    const creds: Credentials = {
      serviceToken: 'valid-token',
      organizationId: 'org-123',
      saasToken: 'valid-saas',
      consoleUrl: 'https://valid.saas.nodesource.io',
      mcpUrl: 'https://org-123.mcp.saas.nodesource.io',
      expiresAt: new Date(Date.now() + 86400000).toISOString(),
    };
    saveCredentials(creds);

    const callback = sendOAuthCallback(8768, 300);

    globalThis.fetch = vi.fn().mockRejectedValue(new Error('ECONNREFUSED'));

    const { ensureAuthenticated } = await import('../../../src/auth/auth-manager.js');
    const result = await ensureAuthenticated(authConfig);

    expect(result.serviceToken).toBe('oauth-token');
    expect(result.organizationId).toBe('org-456');
    await callback;
  });
});

describe('ensureAuthenticated - requiredPermissions', () => {
  const authConfigWithPerms: AuthConfig = {
    ...authConfig,
    requiredPermissions: ['nsolid:benchmark:run', 'nsolid:profile:read'],
  };

  it('throws when required permissions are missing (fast path)', { timeout: 10000 }, async () => {
    const { saveCredentials } = await import('../../../src/auth/token-storage.js');

    const creds: Credentials = {
      serviceToken: 'existing-token',
      organizationId: 'org-123',
      saasToken: 'test-saas-token',
      consoleUrl: 'https://test.saas.nodesource.io',
      mcpUrl: 'https://org-123.mcp.saas.nodesource.io',
      expiresAt: new Date(Date.now() + 86400000).toISOString(),
      permissions: ['nsolid:benchmark:run'], // Missing nsolid:profile:read
    };
    saveCredentials(creds);

    globalThis.fetch = (async () => ({
      ok: true,
      status: 200,
      headers: new Headers({ 'content-type': 'application/json' }),
      json: async () => ({ permissions: ['nsolid:benchmark:run'] }),
    })) as unknown as typeof fetch;

    const { ensureAuthenticated } = await import('../../../src/auth/auth-manager.js');
    await expect(ensureAuthenticated(authConfigWithPerms)).rejects.toThrow(
      /Missing required permissions: nsolid:profile:read/
    );
  });

  it('returns credentials when all required permissions are present', async () => {
    const { saveCredentials } = await import('../../../src/auth/token-storage.js');

    const creds: Credentials = {
      serviceToken: 'existing-token',
      organizationId: 'org-123',
      saasToken: 'test-saas-token',
      consoleUrl: 'https://test.saas.nodesource.io',
      mcpUrl: 'https://org-123.mcp.saas.nodesource.io',
      expiresAt: new Date(Date.now() + 86400000).toISOString(),
      permissions: ['nsolid:benchmark:run', 'nsolid:profile:read'],
    };
    saveCredentials(creds);

    globalThis.fetch = (async () => ({
      ok: true,
      status: 200,
      headers: new Headers({ 'content-type': 'application/json' }),
      json: async () => ({ permissions: ['nsolid:benchmark:run', 'nsolid:profile:read'] }),
    })) as unknown as typeof fetch;

    const { ensureAuthenticated } = await import('../../../src/auth/auth-manager.js');
    const result = await ensureAuthenticated(authConfigWithPerms);

    expect(result.permissions).toEqual(['nsolid:benchmark:run', 'nsolid:profile:read']);
  });
});

describe('ensureAuthenticated - Windows browser launch', () => {
  it('uses cmd /c start on Windows', { timeout: 10000 }, async () => {
    const originalPlatform = process.platform;
    Object.defineProperty(process, 'platform', { value: 'win32' });

    try {
      const { saveCredentials } = await import('../../../src/auth/token-storage.js');
      const expiredCreds: Credentials = {
        serviceToken: 'expired-token',
        organizationId: 'org-123',
        saasToken: 'expired-saas',
        consoleUrl: 'https://expired.saas.nodesource.io',
        mcpUrl: 'https://org-123.mcp.saas.nodesource.io',
        expiresAt: new Date(Date.now() - 1000).toISOString(),
      };
      saveCredentials(expiredCreds);

      const callback = sendOAuthCallback(8768);

      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        headers: new Headers({ 'content-type': 'application/json' }),
        json: async () => ({ permissions: [] }),
      });

      const { ensureAuthenticated } = await import('../../../src/auth/auth-manager.js');
      await ensureAuthenticated(authConfig);

      const calls = vi.mocked(execFile).mock.calls;
      const lastCall = calls[calls.length - 1];
      expect(lastCall[0]).toBe('cmd');
      expect(lastCall[1]).toEqual(expect.arrayContaining(['/c', 'start']));

      await callback;
    } finally {
      Object.defineProperty(process, 'platform', { value: originalPlatform });
    }
  });
});

describe('ensureAuthenticated - consoleId validation', () => {
  it('throws on invalid consoleId format', { timeout: 10000 }, async () => {
    const { saveCredentials } = await import('../../../src/auth/token-storage.js');
    const expiredCreds: Credentials = {
      serviceToken: 'expired-token',
      organizationId: 'org-123',
      saasToken: 'expired-saas',
      consoleUrl: 'https://expired.saas.nodesource.io',
      mcpUrl: 'https://org-123.mcp.saas.nodesource.io',
      expiresAt: new Date(Date.now() - 1000).toISOString(),
    };
    saveCredentials(expiredCreds);

    // Mock execFile to capture the state from the URL
    vi.mocked(execFile).mockImplementation((_cmd, args) => {
      const urlStr = (args as string[]).find((a: string) => a.startsWith('http'))!;
      const url = new URL(urlStr);
      const capturedState = url.searchParams.get('state')!;

      // Send callback with the captured state and invalid consoleId
      setTimeout(() => {
        const callbackParams = new URLSearchParams({
          success: 'true',
          token: 'oauth-token',
          consoleId: 'invalid@console!',
          NSOLID_SAAS: 'oauth-saas-token',
          url: 'https://invalid.saas.nodesource.io',
          state: capturedState,
        });
        http.get(`http://127.0.0.1:8768/?${callbackParams}`, (res) => {
          res.resume();
        });
      }, 200);

      return null as unknown as ReturnType<typeof execFile>;
    });

    const { ensureAuthenticated } = await import('../../../src/auth/auth-manager.js');
    await expect(ensureAuthenticated(authConfig)).rejects.toThrow(
      /Invalid console ID format/
    );
  });
});
