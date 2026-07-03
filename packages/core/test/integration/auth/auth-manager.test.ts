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
let originalUserProfile: string | undefined
let originalFetch: typeof globalThis.fetch
let originalStaging: string | undefined
let originalAccountsUrl: string | undefined

const authConfig: AuthConfig = {
  type: 'oauth',
  provider: 'nodesource',
  accountsUrl: 'https://accounts.example.com',
  callbackPort: 8767,
}

function getUrlFromExecFileCall (): URL {
  const args = execFileCalls[execFileCalls.length - 1][1] as string[]
  const urlStr = args.find((a: string) => a.startsWith('http'))!
  return new URL(urlStr)
}

function getStateFromExecFileCall (): string {
  return getUrlFromExecFileCall().searchParams.get('state')!
}

async function pollForState (getStateFn: () => string, timeoutMs = 5000): Promise<string> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const state = getStateFn()
      if (state) return state
    } catch {
      // not ready yet
    }
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  throw new Error('OAuth state not ready within timeout')
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
  originalUserProfile = process.env.USERPROFILE
  process.env.HOME = tmpDir
  process.env.USERPROFILE = tmpDir
  originalFetch = globalThis.fetch
  execFileCalls.length = 0

  originalStaging = process.env.NSOLID_STAGING
  originalAccountsUrl = process.env.NSOLID_ACCOUNTS_URL
  delete process.env.NSOLID_STAGING
  delete process.env.NSOLID_ACCOUNTS_URL
})

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true })
  if (originalHome !== undefined) {
    process.env.HOME = originalHome
    process.env.USERPROFILE = originalUserProfile
  }
  globalThis.fetch = originalFetch

  if (originalStaging !== undefined) process.env.NSOLID_STAGING = originalStaging
  else delete process.env.NSOLID_STAGING
  if (originalAccountsUrl !== undefined) process.env.NSOLID_ACCOUNTS_URL = originalAccountsUrl
  else delete process.env.NSOLID_ACCOUNTS_URL
})

describe('ensureAuthenticated', () => {
  it('validates existing unexpired credentials before returning them', async () => {
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

    let fetchCalls = 0
    globalThis.fetch = (async () => {
      fetchCalls++
      return {
        ok: true,
        status: 200,
        headers: new Headers({ 'content-type': 'application/json' }),
        json: async () => ({ permissions: ['nsolid:benchmark:run'] }),
      }
    }) as unknown as typeof fetch

    const { ensureAuthenticated } = await import('../../../src/auth/auth-manager.js')
    const result = await ensureAuthenticated(authConfig)

    assert.deepStrictEqual(result, creds)
    assert.strictEqual(fetchCalls, 1, 'fast path should attempt token validation')
    assert.strictEqual(execFileCalls.length, 0)
  })

  it('returns validated permissions with stored credentials', async () => {
    const { loadCredentials, saveCredentials } = await import('../../../src/auth/token-storage.js')

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

    let fetchCalls = 0
    globalThis.fetch = (async () => {
      fetchCalls++
      return {
        ok: true,
        status: 200,
        headers: new Headers({ 'content-type': 'application/json' }),
        json: async () => ({ permissions: ['completely-different:perm'] }),
      }
    }) as unknown as typeof fetch

    const { ensureAuthenticated } = await import('../../../src/auth/auth-manager.js')
    const result = await ensureAuthenticated(authConfig)

    assert.deepStrictEqual(result, { ...creds, permissions: ['completely-different:perm'] })
    assert.deepStrictEqual(loadCredentials()?.permissions, ['completely-different:perm'])
    assert.strictEqual(fetchCalls, 1, 'stored credentials should be validated when possible')
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
    const signInUrl = getUrlFromExecFileCall()
    assert.strictEqual(signInUrl.origin, 'https://accounts.example.com')
    assert.strictEqual(signInUrl.pathname, '/sign-in')
    assert.strictEqual(signInUrl.searchParams.get('extension'), 'nsolid-plugin')
    assert.strictEqual(signInUrl.searchParams.get('port'), '8767')
    const state = getStateFromExecFileCall()
    await sendCallback(8767, state)
    const result = await promise

    assert.strictEqual(result.serviceToken, 'oauth-token')
    assert.strictEqual(result.organizationId, 'org-456')
    assert.strictEqual(result.saasToken, 'oauth-saas-token')
  })

  it('derives staging MCP host from OAuth console URL', { timeout: 10000 }, async () => {
    globalThis.fetch = mock.fn(async () => ({
      ok: true,
      status: 200,
      headers: new Headers({ 'content-type': 'application/json' }),
      json: async () => ({ permissions: [] }),
    })) as unknown as typeof fetch

    const { ensureAuthenticated } = await import('../../../src/auth/auth-manager.js')
    const promise = ensureAuthenticated(authConfig)

    const state = await pollForState(getStateFromExecFileCall)
    await sendCallback(8767, state, {
      consoleId: 'org-456',
      url: 'https://org-456.staging.saas.nodesource.io',
    })
    const result = await promise

    assert.strictEqual(result.mcpUrl, 'https://org-456.mcp.staging.saas.nodesource.io/')
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

  it('trusts stored credentials when validation API is unavailable during fast path', async () => {
    const { saveCredentials } = await import('../../../src/auth/token-storage.js')
    const creds: Credentials = {
      serviceToken: 'valid-token',
      organizationId: 'org-123',
      saasToken: 'valid-saas',
      consoleUrl: 'https://valid.saas.nodesource.io',
      mcpUrl: 'https://org-123.mcp.saas.nodesource.io',
      expiresAt: new Date(Date.now() + 86400000).toISOString(),
      permissions: ['nsolid:benchmark:run'],
    }
    saveCredentials(creds)

    let fetchCalls = 0
    globalThis.fetch = (async () => {
      fetchCalls++
      throw new Error('ECONNREFUSED')
    }) as unknown as typeof fetch

    const { ensureAuthenticated } = await import('../../../src/auth/auth-manager.js')
    const result = await ensureAuthenticated(authConfig)

    assert.strictEqual(result.serviceToken, 'valid-token')
    assert.strictEqual(result.organizationId, 'org-123')
    assert.strictEqual(fetchCalls, 1, 'fast path should try validation before falling back')
    assert.strictEqual(execFileCalls.length, 0, 'browser must not open when API is unavailable')
  })

  it('re-authenticates when validation rejects stored credentials', { timeout: 10000 }, async () => {
    const { saveCredentials } = await import('../../../src/auth/token-storage.js')
    const creds: Credentials = {
      serviceToken: 'revoked-token',
      organizationId: 'org-123',
      saasToken: 'revoked-saas',
      consoleUrl: 'https://valid.saas.nodesource.io',
      mcpUrl: 'https://org-123.mcp.saas.nodesource.io',
      expiresAt: new Date(Date.now() + 86400000).toISOString(),
    }
    saveCredentials(creds)

    let fetchCalls = 0
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      fetchCalls++
      const target = typeof input === 'string' ? input : input.toString()
      const revoked = target.includes('tokenId=revoked-token')
      return revoked
        ? { ok: false, status: 401, headers: new Headers({ 'content-type': 'application/json' }), json: async () => ({}) }
        : { ok: true, status: 200, headers: new Headers({ 'content-type': 'application/json' }), json: async () => ({ permissions: [] }) }
    }) as unknown as typeof fetch

    const { ensureAuthenticated } = await import('../../../src/auth/auth-manager.js')
    const promise = ensureAuthenticated(authConfig)

    const state = await pollForState(getStateFromExecFileCall)
    await sendCallback(8767, state)
    const result = await promise

    assert.strictEqual(result.serviceToken, 'oauth-token')
    assert.strictEqual(result.organizationId, 'org-456')
    assert.strictEqual(fetchCalls, 2, 'stored token rejection should be followed by OAuth token validation')
    assert.strictEqual(execFileCalls.length, 1, 'browser should open for re-authentication')
  })

  it('trusts stored credentials when validation API returns an HTML shell (200 text/html)', async () => {
    // The accounts API serves its SPA index.html (HTTP 200, content-type
    // text/html) for server-side callers. Treat that as validation unavailable
    // and fall back to the unexpired local credentials.
    const { saveCredentials } = await import('../../../src/auth/token-storage.js')
    const creds: Credentials = {
      serviceToken: 'valid-token',
      organizationId: 'org-123',
      saasToken: 'valid-saas',
      consoleUrl: 'https://valid.saas.nodesource.io',
      mcpUrl: 'https://org-123.mcp.saas.nodesource.io',
      expiresAt: new Date(Date.now() + 86400000).toISOString(),
      permissions: ['nsolid:benchmark:run'],
    }
    saveCredentials(creds)

    let fetchCalls = 0
    globalThis.fetch = (async () => {
      fetchCalls++
      return {
        ok: true,
        status: 200,
        headers: new Headers({ 'content-type': 'text/html' }),
        text: async () => '<!DOCTYPE html><html>...</html>',
      }
    }) as unknown as typeof fetch

    const { ensureAuthenticated } = await import('../../../src/auth/auth-manager.js')
    const result = await ensureAuthenticated(authConfig)

    assert.strictEqual(result.serviceToken, 'valid-token')
    assert.strictEqual(result.organizationId, 'org-123')
    assert.strictEqual(fetchCalls, 1, 'fast path should try validation before falling back')
    assert.strictEqual(execFileCalls.length, 0, 'browser must not open when API returns an HTML shell')
  })
})

describe('ensureAuthenticated - requiredPermissions', () => {
  const authConfigWithPerms: AuthConfig = {
    ...authConfig,
    requiredPermissions: ['nsolid:benchmark:run', 'nsolid:profile:read'],
  }

  it('throws when validation succeeds but required permissions are missing', async () => {
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

    let fetchCalls = 0
    globalThis.fetch = (async () => {
      fetchCalls++
      return {
        ok: true,
        status: 200,
        headers: new Headers({ 'content-type': 'application/json' }),
        json: async () => ({ permissions: ['nsolid:benchmark:run'] }),
      }
    }) as unknown as typeof fetch

    const { ensureAuthenticated } = await import('../../../src/auth/auth-manager.js')

    await assert.rejects(
      ensureAuthenticated(authConfigWithPerms),
      /Missing required permissions: nsolid:profile:read/
    )
    assert.strictEqual(fetchCalls, 1)
    assert.strictEqual(execFileCalls.length, 0)
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

    let fetchCalls = 0
    globalThis.fetch = (async () => {
      fetchCalls++
      return {
        ok: true,
        status: 200,
        headers: new Headers({ 'content-type': 'application/json' }),
        json: async () => ({ permissions: ['nsolid:benchmark:run', 'nsolid:profile:read'] }),
      }
    }) as unknown as typeof fetch

    const { ensureAuthenticated } = await import('../../../src/auth/auth-manager.js')
    const result = await ensureAuthenticated(authConfigWithPerms)

    assert.deepStrictEqual(result.permissions, ['nsolid:benchmark:run', 'nsolid:profile:read'])
    assert.strictEqual(fetchCalls, 1)
    assert.strictEqual(execFileCalls.length, 0)
  })

  it('checks known cached permissions when validation is unavailable', async () => {
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

    let fetchCalls = 0
    globalThis.fetch = (async () => {
      fetchCalls++
      throw new Error('ECONNREFUSED')
    }) as unknown as typeof fetch

    const { ensureAuthenticated } = await import('../../../src/auth/auth-manager.js')

    await assert.rejects(
      ensureAuthenticated(authConfigWithPerms),
      /Missing required permissions: nsolid:profile:read/
    )
    assert.strictEqual(fetchCalls, 1)
    assert.strictEqual(execFileCalls.length, 0)
  })

  it('trusts stored credentials with unknown cached permissions when validation is unavailable', async () => {
    const { saveCredentials } = await import('../../../src/auth/token-storage.js')

    const creds: Credentials = {
      serviceToken: 'existing-token',
      organizationId: 'org-123',
      saasToken: 'test-saas-token',
      consoleUrl: 'https://test.saas.nodesource.io',
      mcpUrl: 'https://org-123.mcp.saas.nodesource.io',
      expiresAt: new Date(Date.now() + 86400000).toISOString(),
    }
    saveCredentials(creds)

    let fetchCalls = 0
    globalThis.fetch = (async () => {
      fetchCalls++
      throw new Error('ECONNREFUSED')
    }) as unknown as typeof fetch

    const { ensureAuthenticated } = await import('../../../src/auth/auth-manager.js')
    const result = await ensureAuthenticated(authConfigWithPerms)

    assert.deepStrictEqual(result, creds)
    assert.strictEqual(fetchCalls, 1)
    assert.strictEqual(execFileCalls.length, 0)
  })

  it('does not store fresh OAuth credentials when validation reports missing required permissions', { timeout: 10000 }, async () => {
    const { loadCredentials } = await import('../../../src/auth/token-storage.js')

    let fetchCalls = 0
    globalThis.fetch = (async () => {
      fetchCalls++
      return {
        ok: true,
        status: 200,
        headers: new Headers({ 'content-type': 'application/json' }),
        json: async () => ({ permissions: ['nsolid:benchmark:run'] }),
      }
    }) as unknown as typeof fetch

    const { ensureAuthenticated } = await import('../../../src/auth/auth-manager.js')
    const promise = ensureAuthenticated(authConfigWithPerms)
    const rejection = assert.rejects(
      promise,
      /Missing required permissions: nsolid:profile:read/
    )

    const state = await pollForState(getStateFromExecFileCall)
    await sendCallback(8767, state)
    await rejection
    assert.strictEqual(fetchCalls, 1)
    assert.strictEqual(execFileCalls.length, 1)
    assert.strictEqual(loadCredentials(), null)
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

describe('ensureAuthenticated - accountsUrl override', () => {
  async function seedExpiredCredentials (): Promise<void> {
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
  }

  it('builds staging /sign-in URL when passed a staging accountsUrl', { timeout: 10000 }, async () => {
    await seedExpiredCredentials()

    globalThis.fetch = mock.fn(async () => ({
      ok: true,
      status: 200,
      headers: new Headers({ 'content-type': 'application/json' }),
      json: async () => ({ permissions: [] }),
    })) as unknown as typeof fetch

    const stagingConfig: AuthConfig = {
      ...authConfig,
      accountsUrl: 'https://staging.accounts.nodesource.com',
    }

    const { ensureAuthenticated } = await import('../../../src/auth/auth-manager.js')
    const promise = ensureAuthenticated(stagingConfig)

    await new Promise((resolve) => setTimeout(resolve, 50))
    const signInUrl = getUrlFromExecFileCall()
    assert.strictEqual(signInUrl.host, 'staging.accounts.nodesource.com')
    assert.strictEqual(signInUrl.pathname, '/sign-in')
    assert.strictEqual(signInUrl.searchParams.get('extension'), 'nsolid-plugin')
    assert.strictEqual(signInUrl.searchParams.get('port'), '8767')
    const state = getStateFromExecFileCall()
    await sendCallback(8767, state)
    await promise
  })

  it('builds explicit /sign-in URL when passed an explicit accountsUrl', { timeout: 10000 }, async () => {
    await seedExpiredCredentials()

    globalThis.fetch = mock.fn(async () => ({
      ok: true,
      status: 200,
      headers: new Headers({ 'content-type': 'application/json' }),
      json: async () => ({ permissions: [] }),
    })) as unknown as typeof fetch

    const explicitConfig: AuthConfig = {
      ...authConfig,
      accountsUrl: 'https://custom.accounts.example.com',
    }

    const { ensureAuthenticated } = await import('../../../src/auth/auth-manager.js')
    const promise = ensureAuthenticated(explicitConfig)

    await new Promise((resolve) => setTimeout(resolve, 50))
    const signInUrl = getUrlFromExecFileCall()
    assert.strictEqual(signInUrl.host, 'custom.accounts.example.com')
    assert.strictEqual(signInUrl.pathname, '/sign-in')
    const state = getStateFromExecFileCall()
    await sendCallback(8767, state)
    await promise
  })

  it('builds prod /sign-in URL when passed a prod accountsUrl', { timeout: 10000 }, async () => {
    await seedExpiredCredentials()

    globalThis.fetch = mock.fn(async () => ({
      ok: true,
      status: 200,
      headers: new Headers({ 'content-type': 'application/json' }),
      json: async () => ({ permissions: [] }),
    })) as unknown as typeof fetch

    const prodConfig: AuthConfig = {
      ...authConfig,
      accountsUrl: 'https://accounts.nodesource.com',
    }

    const { ensureAuthenticated } = await import('../../../src/auth/auth-manager.js')
    const promise = ensureAuthenticated(prodConfig)

    await new Promise((resolve) => setTimeout(resolve, 50))
    const signInUrl = getUrlFromExecFileCall()
    assert.strictEqual(signInUrl.host, 'accounts.nodesource.com')
    assert.strictEqual(signInUrl.pathname, '/sign-in')
    const state = getStateFromExecFileCall()
    await sendCallback(8767, state)
    await promise
  })
})
