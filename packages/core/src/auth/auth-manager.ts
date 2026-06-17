import { randomUUID } from 'node:crypto'
import { execFile } from 'node:child_process'
import type { AuthConfig, Credentials } from '../types.js'
import { loadCredentials, saveCredentials, isExpired } from './token-storage.js'
import { validateToken } from './token-validator.js'
import { startOAuthServer } from './oauth-server.js'
import { PermissionError, InvalidCredentialsError } from './errors.js'

function openBrowser (url: string): void {
  try {
    // eslint-disable-next-line no-new
    new URL(url)
  } catch {
    console.warn(`Invalid URL: ${url}`)
    return
  }
  const cmd = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'cmd' : 'xdg-open'
  const args = process.platform === 'win32' ? ['/c', 'start', url] : [url]
  execFile(cmd, args, (err) => {
    if (err) console.warn(`Could not open browser: ${err.message}`)
  })
}

function checkRequiredPermissions (
  required: string[],
  available: string[]
): void {
  const missing = required.filter((p) => !available.includes(p))
  if (missing.length > 0) {
    throw new PermissionError(
      missing,
      `Missing required permissions: ${missing.join(', ')}. ` +
      'Please ensure your account has the required access.'
    )
  }
}

export async function ensureAuthenticated (authConfig: AuthConfig): Promise<Credentials> {
  const required = authConfig.requiredPermissions ?? []

  let existing: Credentials | null = null
  try {
    existing = loadCredentials()
  } catch {
    // Corrupt credentials file - fall through to re-authenticate
  }

  if (existing && !isExpired(existing)) {
    try {
      const result = await validateToken(existing.serviceToken, existing.organizationId, authConfig.accountsUrl)
      if (result.valid) {
        if (required.length > 0) {
          checkRequiredPermissions(required, result.permissions)
        }
        return { ...existing, permissions: result.permissions }
      }
    } catch (err) {
      // Re-throw permission errors (not API unavailability)
      if (err instanceof PermissionError) {
        throw err
      }
      // API unavailable - fall through to re-authenticate
    }
  }

  const state = randomUUID()
  const server = await startOAuthServer(authConfig.callbackPort, state)

  const signInUrl = new URL('/sign-in', authConfig.accountsUrl)
  signInUrl.searchParams.set('extension', 'nsolid-plugin')
  signInUrl.searchParams.set('port', String(server.port))
  signInUrl.searchParams.set('state', state)

  openBrowser(signInUrl.toString())

  const callback = await server.waitForCallback()
  await server.close()

  if (!callback.success) {
    const reason = callback.reason === 'auth-failed'
      ? 'Authentication failed. Please try again.'
      : 'Authentication timed out. Please try again.'
    throw new Error(reason)
  }

  if (!/^[a-zA-Z0-9_-]{1,64}$/.test(callback.consoleId)) {
    throw new Error('Invalid console ID format received from OAuth callback')
  }

  const mcpUrl = `https://${callback.consoleId}.mcp.saas.nodesource.io`

  try {
    const result = await validateToken(callback.token, callback.consoleId, authConfig.accountsUrl)
    if (!result.valid) {
      throw new InvalidCredentialsError(`Invalid credentials: ${result.reason}`)
    }

    if (required.length > 0) {
      checkRequiredPermissions(required, result.permissions)
    }

    const creds: Credentials = {
      serviceToken: callback.token,
      organizationId: callback.consoleId,
      saasToken: callback.saasToken,
      consoleUrl: callback.consoleUrl,
      mcpUrl,
      expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
      permissions: result.permissions,
    }

    saveCredentials(creds)
    return creds
  } catch (err) {
    if (err instanceof InvalidCredentialsError) {
      throw err
    }
    // API unavailable - store optimistically
    console.warn('Warning: Could not validate token. Storing credentials optimistically.')
    const creds: Credentials = {
      serviceToken: callback.token,
      organizationId: callback.consoleId,
      saasToken: callback.saasToken,
      consoleUrl: callback.consoleUrl,
      mcpUrl,
      expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
    }
    saveCredentials(creds)
    return creds
  }
}
