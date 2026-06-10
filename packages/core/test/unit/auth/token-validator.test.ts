import { describe, it, beforeEach, afterEach, expect } from 'vitest';
import type { ValidationResult } from '../../../src/auth/token-validator.js';

let originalFetch: typeof globalThis.fetch;

beforeEach(() => {
  originalFetch = globalThis.fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe('validateToken', () => {
  it('returns valid with permissions on 200', async () => {
    globalThis.fetch = (async () => ({
      ok: true,
      status: 200,
      headers: new Headers({ 'content-type': 'application/json' }),
      json: async () => ({ permissions: ['nsolid:benchmark:run', 'nsolid:profile:read'] }),
    })) as unknown as typeof fetch;

    const { validateToken } = await import('../../../src/auth/token-validator.js');
    const result = await validateToken('test-token', 'org-123', 'https://accounts.example.com');

    expect(result).toEqual({
      valid: true,
      permissions: ['nsolid:benchmark:run', 'nsolid:profile:read'],
    } satisfies ValidationResult);
  });

  it('returns invalid on 401', async () => {
    globalThis.fetch = (async () => ({
      ok: false,
      status: 401,
    })) as unknown as typeof fetch;

    const { validateToken } = await import('../../../src/auth/token-validator.js');
    const result = await validateToken('bad-token', 'org-123', 'https://accounts.example.com');

    expect(result).toEqual({
      valid: false,
      reason: 'Invalid credentials',
    } satisfies ValidationResult);
  });

  it('throws on 500', async () => {
    globalThis.fetch = (async () => ({
      ok: false,
      status: 500,
    })) as unknown as typeof fetch;

    const { validateToken } = await import('../../../src/auth/token-validator.js');
    await expect(
      validateToken('token', 'org-123', 'https://accounts.example.com')
    ).rejects.toThrow(/500/);
  });

  it('throws on timeout', { timeout: 15000 }, async () => {
    globalThis.fetch = (async (_url: string, init?: RequestInit) => {
      return new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          reject(new DOMException('The operation was aborted', 'AbortError'));
        });
      }) as Promise<Response>;
    }) as unknown as typeof fetch;

    const { validateToken } = await import('../../../src/auth/token-validator.js');
    await expect(
      validateToken('token', 'org-123', 'https://accounts.example.com')
    ).rejects.toThrow(/timed out/i);
  });

  it('handles malformed response (permissions not an array)', async () => {
    globalThis.fetch = (async () => ({
      ok: true,
      status: 200,
      headers: new Headers({ 'content-type': 'application/json' }),
      json: async () => ({ permissions: 'not-an-array' }),
    })) as unknown as typeof fetch;

    const { validateToken } = await import('../../../src/auth/token-validator.js');
    await expect(
      validateToken('test-token', 'org-123', 'https://accounts.example.com')
    ).rejects.toThrow(/invalid permissions format/);
  });

  it('handles malformed response (non-string permissions filtered)', async () => {
    globalThis.fetch = (async () => ({
      ok: true,
      status: 200,
      headers: new Headers({ 'content-type': 'application/json' }),
      json: async () => ({ permissions: ['valid', 123, null, 'also-valid'] }),
    })) as unknown as typeof fetch;

    const { validateToken } = await import('../../../src/auth/token-validator.js');
    const result = await validateToken('test-token', 'org-123', 'https://accounts.example.com');

    expect(result).toEqual({
      valid: true,
      permissions: ['valid', 'also-valid'],
    } satisfies ValidationResult);
  });

  it('handles null response body', async () => {
    globalThis.fetch = (async () => ({
      ok: true,
      status: 200,
      headers: new Headers({ 'content-type': 'application/json' }),
      json: async () => null,
    })) as unknown as typeof fetch;

    const { validateToken } = await import('../../../src/auth/token-validator.js');
    await expect(
      validateToken('token', 'org-123', 'https://accounts.example.com')
    ).rejects.toThrow(/invalid response format/);
  });

  it('rejects non-JSON content type', async () => {
    globalThis.fetch = (async () => ({
      ok: true,
      status: 200,
      headers: new Headers({ 'content-type': 'text/html' }),
      json: async () => ({ permissions: [] }),
    })) as unknown as typeof fetch;

    const { validateToken } = await import('../../../src/auth/token-validator.js');
    await expect(
      validateToken('token', 'org-123', 'https://accounts.example.com')
    ).rejects.toThrow(/unexpected content type/);
  });
});
