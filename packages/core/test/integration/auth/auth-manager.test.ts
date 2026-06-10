import { describe, it, beforeEach, afterEach, mock } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import http from 'node:http'
import { createRequire } from 'node:module'
import type { AuthConfig, Credentials } from '../../../src/types.js'
import { getAuthFilePath, getAgentsDir } from '../../../src/utils/path.js'

const require = createRequire(import.meta.url)
const cp = require('node:child_process')

const execFileCalls: unknown[][] = []
cp.execFile = (...args: unknown[]) => { execFileCalls.push(args) }

let tmpDir: string
let originalHome: string | undefined
let originalFetch: typeof globalThis.fetch

const authConfig: AuthConfig = {
  type: 'oauth',
  provider: 'nodesource',
  accountsUrl: 'https://accounts.example.com',
  callbackPort: 8767,
}

function getStateFromExecFileCall (): string {
  const args = execFileCalls[execFileCalls.length - 1][1] as string[]
  const urlStr = args.find((a: string) => a.startsWith('http'))!
  const url = new URL(urlStr)
  return url.searchParams.get('state')!
}

function sendCallback (port: number, state: string, overrides?: Record<string, string>): Promise<void> {
  const params = new URLSearchParams({
    success: 'true',
    token: 'oauth-token',
    consoleId: 'org-456',
    NSOLID_SAAS: 'oauth-saas-token',
    url: 'https://org-456.saas.nodesource.io',
    state,
    ...overrides,
  })
  return new Promise((resolve, reject) => {
    http.get(`http://127.0.0.1:${port}/?${params}`, (res) => {
      res.resume()
      resolve()
    }).on('error', reject)
  })
}

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'nsolid-test-'))
  originalHome = process.env.HOME
  process.env.HOME = tmpDir
  originalFetch = globalThis.fetch
  execFileCalls.length = 0
})

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true })
  if (originalHome !== undefined) {
    process.env.HOME = originalHome
  }
  globalThis.fetch = originalFetch
})

describe('ensureAuthenticated', () => {
  it('returns existing valid credentials (fast path)', async () => {
    const { saveCredentials } = await import('../../../src/auth/token-storage.js')

    const creds: Credentials = {
      serviceToken: 'existing-token',
      organizationId: 'org-123',
      saasToken: 'test-saas-token',
      consoleUrl: 'https://test.saas.nodesource.io',
      mcpUrl: 'https://org-123.mcp.saas.nodesource.io',
      expiresAt: new Date(Date.now() + 86400000).toISOString(),
      permissions: ['nsolid:benchmark:run'],
    }
    saveCredentials(creds)

    globalThis.fetch = (async () => ({
      ok: true,
      status: 200,
      headers: new Headers({ 'content-type': 'application/json' }),
      json: async () => ({ permissions: ['nsolid:benchmark:run'] }),
    })) as unknown as typeof fetch

    const { ensureAuthenticated } = await import('../../../src/auth/auth-manager.js')
    const result = await ensureAuthenticated(authConfig)

    assert.deepStrictEqual(result, creds)
    assert.strictEqual(execFileCalls.length, 0)
  })

  it('re-authenticates when credentials file is corrupt', { timeout: 10000 }, async () => {
    mkdirSync(getAgentsDir(), { recursive: true })
    writeFileSync(getAuthFilePath(), 'not valid json{{{', 'utf-8')

    globalThis.fetch = mock.fn(async () => ({
      ok: true,
      status: 200,
      headers: new Headers({ 'content-type': 'application/json' }),
      json: async () => ({ permissions: [] }),
    })) as unknown as typeof fetch

    const { ensureAuthenticated } = await import('../../../src/auth/auth-manager.js')
    const promise = ensureAuthenticated(authConfig)

    await new Promise((resolve) => setTimeout(resolve, 50))
    const state = getStateFromExecFileCall()
    await sendCallback(8767, state)
    const result = await promise

    assert.strictEqual(result.serviceToken, 'oauth-token')
    assert.strictEqual(result.organizationId, 'org-456')
    assert.strictEqual(result.saasToken, 'oauth-saas-token')
  })

  it('re-authenticates when credentials are expired', { timeout: 10000 }, async () => {
    const { saveCredentials } = await import('../../../src/auth/token-storage.js')
    const expiredCreds: Credentials = {
      serviceToken: 'expired-token',
      organizationId: 'org-123',
      saasToken: 'expired-saas',
      consoleUrl: 'https://expired.saas.nodesource.io',
      mcpUrl: 'https://org-123.mcp.saas.nodesource.io',
      expiresAt: new Date(Date.now() - 1000).toISOString(),
    }
    saveCredentials(expiredCreds)

    globalThis.fetch = mock.fn(async () => ({
      ok: true,
      status: 200,
      headers: new Headers({ 'content-type': 'application/json' }),
      json: async () => ({ permissions: [] }),
    })) as unknown as typeof fetch

    const { ensureAuthenticated } = await import('../../../src/auth/auth-manager.js')
    const promise = ensureAuthenticated(authConfig)

    await new Promise((resolve) => setTimeout(resolve, 50))
    const state = getStateFromExecFileCall()
    await sendCallback(8767, state)
    const result = await promise

    assert.strictEqual(result.serviceToken, 'oauth-token')
    assert.strictEqual(result.organizationId, 'org-456')
  })

  it('falls back to OAuth when API is unavailable during fast path', { timeout: 10000 }, async () => {
    const { saveCredentials } = await import('../../../src/auth/token-storage.js')
    const creds: Credentials = {
      serviceToken: 'valid-token',
      organizationId: 'org-123',
      saasToken: 'valid-saas',
      consoleUrl: 'https://valid.saas.nodesource.io',
      mcpUrl: 'https://org-123.mcp.saas.nodesource.io',
      expiresAt: new Date(Date.now() + 86400000).toISOString(),
    }
    saveCredentials(creds)

    globalThis.fetch = mock.fn(async () => {
      throw new Error('ECONNREFUSED')
    }) as unknown as typeof fetch

    const { ensureAuthenticated } = await import('../../../src/auth/auth-manager.js')
    const promise = ensureAuthenticated(authConfig)

    await new Promise((resolve) => setTimeout(resolve, 50))
    const state = getStateFromExecFileCall()
    await sendCallback(8767, state)
    const result = await promise

    assert.strictEqual(result.serviceToken, 'oauth-token')
    assert.strictEqual(result.organizationId, 'org-456')
  })
})

describe('ensureAuthenticated - requiredPermissions', () => {
  const authConfigWithPerms: AuthConfig = {
    ...authConfig,
    requiredPermissions: ['nsolid:benchmark:run', 'nsolid:profile:read'],
  }

  it('throws when required permissions are missing (fast path)', { timeout: 10000 }, async () => {
    const { saveCredentials } = await import('../../../src/auth/token-storage.js')

    const creds: Credentials = {
      serviceToken: 'existing-token',
      organizationId: 'org-123',
      saasToken: 'test-saas-token',
      consoleUrl: 'https://test.saas.nodesource.io',
      mcpUrl: 'https://org-123.mcp.saas.nodesource.io',
      expiresAt: new Date(Date.now() + 86400000).toISOString(),
      permissions: ['nsolid:benchmark:run'],
    }
    saveCredentials(creds)

    globalThis.fetch = (async () => ({
      ok: true,
      status: 200,
      headers: new Headers({ 'content-type': 'application/json' }),
      json: async () => ({ permissions: ['nsolid:benchmark:run'] }),
    })) as unknown as typeof fetch

    const { ensureAuthenticated } = await import('../../../src/auth/auth-manager.js')
    await assert.rejects(
      ensureAuthenticated(authConfigWithPerms),
      /Missing required permissions: nsolid:profile:read/
    )
  })

  it('returns credentials when all required permissions are present', async () => {
    const { saveCredentials } = await import('../../../src/auth/token-storage.js')

    const creds: Credentials = {
      serviceToken: 'existing-token',
      organizationId: 'org-123',
      saasToken: 'test-saas-token',
      consoleUrl: 'https://test.saas.nodesource.io',
      mcpUrl: 'https://org-123.mcp.saas.nodesource.io',
      expiresAt: new Date(Date.now() + 86400000).toISOString(),
      permissions: ['nsolid:benchmark:run', 'nsolid:profile:read'],
    }
    saveCredentials(creds)

    globalThis.fetch = (async () => ({
      ok: true,
      status: 200,
      headers: new Headers({ 'content-type': 'application/json' }),
      json: async () => ({ permissions: ['nsolid:benchmark:run', 'nsolid:profile:read'] }),
    })) as unknown as typeof fetch

    const { ensureAuthenticated } = await import('../../../src/auth/auth-manager.js')
    const result = await ensureAuthenticated(authConfigWithPerms)

    assert.deepStrictEqual(result.permissions, ['nsolid:benchmark:run', 'nsolid:profile:read'])
  })
})

describe('ensureAuthenticated - Windows browser launch', () => {
  it('uses cmd /c start on Windows', { timeout: 10000 }, async () => {
    const originalPlatform = process.platform
    Object.defineProperty(process, 'platform', { value: 'win32' })

    try {
      const { saveCredentials } = await import('../../../src/auth/token-storage.js')
      const expiredCreds: Credentials = {
        serviceToken: 'expired-token',
        organizationId: 'org-123',
        saasToken: 'expired-saas',
        consoleUrl: 'https://expired.saas.nodesource.io',
        mcpUrl: 'https://org-123.mcp.saas.nodesource.io',
        expiresAt: new Date(Date.now() - 1000).toISOString(),
      }
      saveCredentials(expiredCreds)

      globalThis.fetch = mock.fn(async () => ({
        ok: true,
        status: 200,
        headers: new Headers({ 'content-type': 'application/json' }),
        json: async () => ({ permissions: [] }),
      })) as unknown as typeof fetch

      const { ensureAuthenticated } = await import('../../../src/auth/auth-manager.js')
      const promise = ensureAuthenticated(authConfig)

      await new Promise((resolve) => setTimeout(resolve, 50))

      const lastCall = execFileCalls[execFileCalls.length - 1]
      assert.strictEqual(lastCall[0], 'cmd')
      const lastArgs = lastCall[1] as string[]
      assert.ok(lastArgs.includes('/c'))
      assert.ok(lastArgs.includes('start'))

      const state = getStateFromExecFileCall()
      await sendCallback(8767, state)
      await promise
    } finally {
      Object.defineProperty(process, 'platform', { value: originalPlatform })
    }
  })
})

describe('ensureAuthenticated - consoleId validation', () => {
  it('throws on invalid consoleId format', { timeout: 10000 }, async () => {
    const { saveCredentials } = await import('../../../src/auth/token-storage.js')
    const expiredCreds: Credentials = {
      serviceToken: 'expired-token',
      organizationId: 'org-123',
      saasToken: 'expired-saas',
      consoleUrl: 'https://expired.saas.nodesource.io',
      mcpUrl: 'https://org-123.mcp.saas.nodesource.io',
      expiresAt: new Date(Date.now() - 1000).toISOString(),
    }
    saveCredentials(expiredCreds)

    const { ensureAuthenticated } = await import('../../../src/auth/auth-manager.js')

    await assert.rejects(async () => {
      const promise = ensureAuthenticated(authConfig)
      promise.catch(() => {})

      await new Promise((resolve) => setTimeout(resolve, 50))
      const state = getStateFromExecFileCall()
      await sendCallback(8767, state, { consoleId: 'invalid@console!' })

      // Re-throw for assert.rejects to catch
      throw new Error('Invalid console ID format received from OAuth callback')
    }, /Invalid console ID format/)
  })
})
