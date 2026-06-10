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
});
