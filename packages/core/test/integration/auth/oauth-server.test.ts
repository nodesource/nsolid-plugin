import { describe, it, afterEach, expect } from 'vitest';
import { createServer } from 'node:http';

const cleanup: (() => void)[] = [];

afterEach(() => {
  for (const fn of cleanup.splice(0)) fn();
});

describe('oauth-server', () => {
  it('starts on default port and receives callback', async () => {
    const { startOAuthServer } = await import('../../../src/auth/oauth-server.js');
    const server = await startOAuthServer();
    cleanup.push(() => server.close());

    expect(server.port).toBe(8765);

    const callbackPromise = server.waitForCallback();

    const params = new URLSearchParams({
      success: 'true',
      token: 'test-token',
      consoleId: 'org-123',
      NSOLID_SAAS: 'test-saas-token',
      url: 'https://test.saas.nodesource.io',
    });
    const response = await fetch(`http://127.0.0.1:${server.port}/?${params}`);
    expect(response.status).toBe(200);

    const result = await callbackPromise;
    expect(result.success).toBeTruthy();
    if (result.success) {
      expect(result.token).toBe('test-token');
      expect(result.consoleId).toBe('org-123');
      expect(result.saasToken).toBe('test-saas-token');
      expect(result.consoleUrl).toBe('https://test.saas.nodesource.io');
    }
  });

  it('falls back to next port on conflict', async () => {
    const blocker = createServer();
    await new Promise<void>((resolve) => blocker.listen(8769, '127.0.0.1', resolve));
    cleanup.push(() => blocker.close());

    const { startOAuthServer } = await import('../../../src/auth/oauth-server.js');
    const server = await startOAuthServer(8769);
    cleanup.push(() => server.close());

    expect(server.port).toBe(8770);
  });

  it('resolves with timeout on close before callback', async () => {
    const { startOAuthServer } = await import('../../../src/auth/oauth-server.js');
    const server = await startOAuthServer();

    const callbackPromise = server.waitForCallback();
    server.close();

    const result = await callbackPromise;
    expect(result.success).toBeFalsy();
    if (!result.success) {
      expect(result.reason).toBe('timeout');
    }
  });

  it('returns 400 for missing params', async () => {
    const { startOAuthServer } = await import('../../../src/auth/oauth-server.js');
    const server = await startOAuthServer();
    cleanup.push(() => server.close());

    const response = await fetch(`http://127.0.0.1:${server.port}/?token=only-token`);
    expect(response.status).toBe(400);
  });

  it('validates state parameter when provided', async () => {
    const { startOAuthServer } = await import('../../../src/auth/oauth-server.js');
    const server = await startOAuthServer(undefined, 'expected-state-123');
    cleanup.push(() => server.close());

    const callbackPromise = server.waitForCallback();

    const params = new URLSearchParams({
      success: 'true',
      token: 'test-token',
      consoleId: 'org-123',
      NSOLID_SAAS: 'test-saas-token',
      url: 'https://test.saas.nodesource.io',
      state: 'expected-state-123',
    });
    const response = await fetch(`http://127.0.0.1:${server.port}/?${params}`);
    expect(response.status).toBe(200);

    const result = await callbackPromise;
    expect(result.success).toBeTruthy();
    if (result.success) {
      expect(result.token).toBe('test-token');
      expect(result.consoleId).toBe('org-123');
    }
  });

  it('rejects callback with invalid state', async () => {
    const { startOAuthServer } = await import('../../../src/auth/oauth-server.js');
    const server = await startOAuthServer(undefined, 'expected-state-123');
    cleanup.push(() => server.close());

    const params = new URLSearchParams({
      success: 'true',
      token: 'test-token',
      consoleId: 'org-123',
      NSOLID_SAAS: 'test-saas-token',
      url: 'https://test.saas.nodesource.io',
      state: 'wrong-state',
    });
    const response = await fetch(`http://127.0.0.1:${server.port}/?${params}`);
    expect(response.status).toBe(400);
  });

  it('rejects callback when success is false', async () => {
    const { startOAuthServer } = await import('../../../src/auth/oauth-server.js');
    const server = await startOAuthServer();
    cleanup.push(() => server.close());

    const callbackPromise = server.waitForCallback();

    const params = new URLSearchParams({
      success: 'false',
      token: 'test-token',
      consoleId: 'org-123',
    });
    const response = await fetch(`http://127.0.0.1:${server.port}/?${params}`);
    expect(response.status).toBe(400);

    const result = await callbackPromise;
    expect(result.success).toBeFalsy();
    if (!result.success) {
      expect(result.reason).toBe('auth-failed');
    }
  });
});
