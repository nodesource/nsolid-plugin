import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { Credentials } from '../../../src/types.js'

let tmpDir: string
let originalHome: string | undefined

let originalUserProfile: string | undefined
beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'nsolid-test-'))
  originalHome = process.env.HOME
  originalUserProfile = process.env.USERPROFILE
  process.env.HOME = tmpDir
  process.env.USERPROFILE = tmpDir
})

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true })
  if (originalHome !== undefined) {
    process.env.HOME = originalHome
    process.env.USERPROFILE = originalUserProfile
  }
})

describe('token-storage', () => {
  it('saveCredentials and loadCredentials roundtrip', async () => {
    const { saveCredentials, loadCredentials } = await import('../../../src/auth/token-storage.js')

    const creds: Credentials = {
      serviceToken: 'test-service-token',
      organizationId: 'org-456',
      saasToken: 'test-saas-token',
      consoleUrl: 'https://test.saas.nodesource.io',
      mcpUrl: 'https://org-456.mcp.saas.nodesource.io',
      expiresAt: '2026-12-31T23:59:59Z',
      permissions: ['nsolid:benchmark:run']
    }

    saveCredentials(creds)
    const loaded = loadCredentials()

    assert.notStrictEqual(loaded, null)
    assert.deepStrictEqual(loaded, creds)
  })

  it('loadCredentials returns null when file does not exist', async () => {
    const { loadCredentials } = await import('../../../src/auth/token-storage.js')

    const result = loadCredentials()
    assert.strictEqual(result, null)
  })

  it('loadCredentials throws on invalid JSON', async () => {
    const { loadCredentials } = await import('../../../src/auth/token-storage.js')
    const { mkdirSync } = await import('node:fs')
    const { getAgentsDir, getAuthFilePath } = await import('../../../src/utils/path.js')

    mkdirSync(getAgentsDir(), { recursive: true })
    writeFileSync(getAuthFilePath(), 'not valid json')

    assert.throws(() => loadCredentials(), /Failed to parse/)
  })

  it('isExpired returns true for past date', async () => {
    const { isExpired } = await import('../../../src/auth/token-storage.js')

    const creds: Credentials = {
      serviceToken: 'token',
      organizationId: 'org',
      saasToken: 'saas',
      consoleUrl: 'https://test.saas.nodesource.io',
      mcpUrl: 'https://org.mcp.saas.nodesource.io',
      expiresAt: '2020-01-01T00:00:00Z'
    }

    assert.strictEqual(isExpired(creds), true)
  })

  it('isExpired returns false for future date', async () => {
    const { isExpired } = await import('../../../src/auth/token-storage.js')

    const futureDate = new Date(Date.now() + 86400000).toISOString()
    const creds: Credentials = {
      serviceToken: 'token',
      organizationId: 'org',
      saasToken: 'saas',
      consoleUrl: 'https://test.saas.nodesource.io',
      mcpUrl: 'https://org.mcp.saas.nodesource.io',
      expiresAt: futureDate
    }

    assert.strictEqual(isExpired(creds), false)
  })

  it('isExpired returns true for invalid date', async () => {
    const { isExpired } = await import('../../../src/auth/token-storage.js')

    const creds: Credentials = {
      serviceToken: 'token',
      organizationId: 'org',
      saasToken: 'saas',
      consoleUrl: 'https://test.saas.nodesource.io',
      mcpUrl: 'https://org.mcp.saas.nodesource.io',
      expiresAt: 'not-a-valid-date'
    }

    assert.strictEqual(isExpired(creds), true)
  })
})
