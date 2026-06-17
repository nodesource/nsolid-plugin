import { randomUUID } from 'node:crypto'
import { execFile } from 'node:child_process'
import type { AuthConfig, Credentials, Logger } from '../types.js'
import { loadCredentials, saveCredentials, isExpired } from './token-storage.js'
import { validateToken } from './token-validator.js'
import { startOAuthServer } from './oauth-server.js'
import { PermissionError, InvalidCredentialsError } from './errors.js'
import { formatPluginError, toPluginError } from '../errors.js'

function openBrowser (url: string, logger?: Logger): void {
  try {
    // eslint-disable-next-line no-new
    new URL(url)
  } catch {
    logger?.warn('auth.openBrowser.invalidUrl', { url })
    return
  }
  const cmd = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'cmd' : 'xdg-open'
  const args = process.platform === 'win32' ? ['/c', 'start', url] : [url]
  execFile(cmd, args, (err) => {
    if (err) logger?.warn('auth.openBrowser.failed', { error: err.message })
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

export async function ensureAuthenticated (authConfig: AuthConfig, logger?: Logger): Promise<Credentials> {
  const required = authConfig.requiredPermissions ?? []

  let existing: Credentials | null = null
  try {
    existing = loadCredentials()
    logger?.debug('auth.credentials.load', { found: !!existing })
  } catch {
    // Corrupt credentials file - fall through to re-authenticate
    logger?.warn('auth.credentials.corrupt')
  }

  if (existing && !isExpired(existing)) {
    try {
      const result = await validateToken(existing.serviceToken, existing.organizationId, authConfig.accountsUrl, logger)
      if (result.valid) {
        if (required.length > 0) {
          checkRequiredPermissions(required, result.permissions)
        }
        logger?.debug('auth.credentials.valid', { orgId: existing.organizationId })
        return { ...existing, permissions: result.permissions }
      }
    } catch (err) {
      // Re-throw permission errors (not API unavailability)
      if (err instanceof PermissionError) {
        throw err
      }
      // API unavailable - fall through to re-authenticate
      logger?.warn('auth.credentials.validationUnavailable', { error: (err as Error).message })
    }
  }

  const state = randomUUID()
  const server = await startOAuthServer(authConfig.callbackPort, state, logger)

  const signInUrl = new URL('/sign-in', authConfig.accountsUrl)
  signInUrl.searchParams.set('extension', 'nsolid-plugin')
  signInUrl.searchParams.set('port', String(server.port))
  signInUrl.searchParams.set('state', state)
  logger?.info('auth.oauth.start', { accountsUrl: authConfig.accountsUrl })

  openBrowser(signInUrl.toString(), logger)

  const callback = await server.waitForCallback()
  await server.close()

  if (!callback.success) {
    const message = callback.reason === 'auth-failed'
      ? 'Authentication failed. Please try again.'
      : 'Authentication timed out. Please try again.'
    const pluginErr = toPluginError(
      new Error(message),
      'AUTH_FAILED',
      { action: 'Re-run installation to retry OAuth.' }
    )
    throw new Error(formatPluginError(pluginErr), { cause: pluginErr })
  }

  if (!/^[a-zA-Z0-9_-]{1,64}$/.test(callback.consoleId)) {
    const pluginErr = toPluginError(
      new Error('Invalid console ID format received from OAuth callback'),
      'AUTH_FAILED',
      { action: 'Check the OAuth callback URL and retry.' }
    )
    throw new Error(formatPluginError(pluginErr), { cause: pluginErr })
  }

  const mcpUrl = `https://${callback.consoleId}.mcp.saas.nodesource.io`

  try {
    const result = await validateToken(callback.token, callback.consoleId, authConfig.accountsUrl, logger)
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
    logger?.info('auth.credentials.saved', { orgId: creds.organizationId })
    return creds
  } catch (err) {
    if (err instanceof InvalidCredentialsError) {
      throw err
    }
    // API unavailable - store optimistically
    logger?.warn('Could not validate token. Storing credentials optimistically.', { consoleId: callback.consoleId })
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
