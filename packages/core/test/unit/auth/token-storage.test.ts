import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync, existsSync, mkdirSync } from 'node:fs'
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
  } else {
    delete process.env.HOME
  }
  if (originalUserProfile !== undefined) {
    process.env.USERPROFILE = originalUserProfile
  } else {
    delete process.env.USERPROFILE
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

  describe('removeCredentials', () => {
    it('removes an existing credentials file', async () => {
      const { saveCredentials, removeCredentials } = await import('../../../src/auth/token-storage.js')
      const { getAuthFilePath, getAgentsDir } = await import('../../../src/utils/path.js')
      const { mkdirSync } = await import('node:fs')

      mkdirSync(getAgentsDir(), { recursive: true })
      saveCredentials({
        serviceToken: 'token',
        organizationId: 'org',
        saasToken: 'saas',
        consoleUrl: 'https://test.saas.nodesource.io',
        mcpUrl: 'https://org.mcp.saas.nodesource.io',
        expiresAt: '2099-01-01T00:00:00Z',
      })

      assert.ok(removeCredentials(), 'returns true when file existed')
      assert.ok(!existsSync(getAuthFilePath()), 'credentials file is gone')
    })

    it('returns false when no credentials file exists', async () => {
      const { removeCredentials } = await import('../../../src/auth/token-storage.js')

      assert.strictEqual(removeCredentials(), false)
    })

    it('throws a descriptive error when removal fails', async () => {
      const { removeCredentials } = await import('../../../src/auth/token-storage.js')
      const { getAuthFilePath, getAgentsDir } = await import('../../../src/utils/path.js')

      // Make the auth path a directory so unlinkSync of the "file" fails,
      // independent of filesystem permissions (works even when running as root).
      mkdirSync(getAgentsDir(), { recursive: true })
      mkdirSync(getAuthFilePath(), { recursive: true })

      // Use a predicate (not new RegExp(path)) so Windows backslash separators in the
      // path (e.g. `\nsolid-...`) are not reinterpreted as regex escapes (`\n` => newline).
      assert.throws(
        () => removeCredentials(),
        (err: Error) =>
          err.message.includes('Failed to remove credentials at') &&
          err.message.includes(getAuthFilePath()),
        'removeCredentials should throw an error containing the failing path'
      )
    })
  })
})
