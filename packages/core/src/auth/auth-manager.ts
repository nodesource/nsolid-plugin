import { randomUUID } from 'node:crypto'
import { execFile } from 'node:child_process'
import type { AuthConfig, Credentials, Logger, AuthConfirmation, HarnessType } from '../types.js'
import { loadCredentials, saveCredentials, isExpired } from './token-storage.js'
import { validateToken } from './token-validator.js'
import { startOAuthServer } from './oauth-server.js'
import { PermissionError, InvalidCredentialsError } from './errors.js'
import { formatPluginError, toPluginError } from '../errors.js'
import { deriveMcpUrlFromConsoleUrl } from './mcp-url.js'

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

function failUnknownRequiredPermissions (
  required: string[],
  reason: string,
  cause?: unknown
): never {
  throw new PermissionError(
    required,
    `Cannot verify required permissions: ${required.join(', ')}. ` +
    `${reason} Retry when validation is available or re-authenticate.`,
    { cause }
  )
}

function checkCachedPermissions (
  required: string[],
  existing: Credentials,
  logger?: Logger,
  cause?: unknown
): void {
  if (required.length === 0) return
  if (existing.permissions === undefined) {
    logger?.debug('auth.credentials.cachedPermissionsUnknown', { orgId: existing.organizationId })
    failUnknownRequiredPermissions(
      required,
      'Token validation is unavailable and cached credentials do not include permission evidence.',
      cause
    )
  }
  checkRequiredPermissions(required, existing.permissions)
}

function samePermissions (left: string[] | undefined, right: string[]): boolean {
  if (left === undefined || left.length !== right.length) return false
  const known = new Set(left)
  return right.every((permission) => known.has(permission))
}

export interface EnsureAuthenticatedOptions {
  harness?: HarnessType;
  confirmAuth?: AuthConfirmation;
}

export async function ensureAuthenticated (authConfig: AuthConfig, logger?: Logger, options: EnsureAuthenticatedOptions = {}): Promise<Credentials> {
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
    if (existing.accountsUrl && existing.accountsUrl !== authConfig.accountsUrl) {
      logger?.info('auth.credentials.originMismatch', { stored: existing.accountsUrl, current: authConfig.accountsUrl })
    } else {
      try {
        const validationAccountsUrl = existing.accountsUrl ?? authConfig.accountsUrl
        const result = await validateToken(existing.serviceToken, existing.organizationId, validationAccountsUrl, logger)
        if (result.valid) {
          if (required.length > 0) {
            checkRequiredPermissions(required, result.permissions)
          }
          logger?.debug('auth.credentials.valid', { orgId: existing.organizationId })
          const refreshed = { ...existing, permissions: result.permissions }
          if (!samePermissions(existing.permissions, result.permissions)) {
            saveCredentials(refreshed)
          }
          return refreshed
        }
        logger?.info('auth.credentials.invalid', { orgId: existing.organizationId })
      } catch (err) {
        if (err instanceof PermissionError) {
          throw err
        }
        // API unavailable, timed out, or served a non-JSON fallback: keep setup
        // idempotent by trusting the unexpired, origin-matching credentials
        // only when no permissions are required, or when cached permissions
        // locally prove the requested access.
        logger?.warn('auth.credentials.validationUnavailable', { error: (err as Error).message })
        checkCachedPermissions(required, existing, logger, err)
        return existing
      }
    }
  }

  if (options.confirmAuth && options.harness) {
    await options.confirmAuth({
      harness: options.harness,
      accountsUrl: authConfig.accountsUrl,
    })
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

  const mcpUrl = deriveMcpUrlFromConsoleUrl(callback.consoleUrl) ?? `https://${callback.consoleId}.mcp.saas.nodesource.io`

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
      accountsUrl: authConfig.accountsUrl,
    }

    saveCredentials(creds)
    logger?.info('auth.credentials.saved', { orgId: creds.organizationId })
    return creds
  } catch (err) {
    if (err instanceof InvalidCredentialsError || err instanceof PermissionError) {
      throw err
    }
    if (required.length > 0) {
      failUnknownRequiredPermissions(
        required,
        'Token validation is unavailable, so fresh OAuth credentials cannot be authorized locally.',
        err
      )
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
      accountsUrl: authConfig.accountsUrl,
    }
    saveCredentials(creds)
    return creds
  }
}
