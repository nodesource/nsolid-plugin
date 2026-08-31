import { randomUUID } from 'node:crypto'
import { execFile } from 'node:child_process'
import { win32 } from 'node:path'
import type { AuthConfig, Credentials, Logger, AuthConfirmation, HarnessType, BrowserLauncher } from '../types.js'
import { loadCredentials, saveCredentials, isExpired } from './token-storage.js'
import { validateToken } from './token-validator.js'
import { startOAuthServer } from './oauth-server.js'
import { PermissionError, InvalidCredentialsError } from './errors.js'
import { formatPluginError, toPluginError } from '../errors.js'
import { deriveMcpUrlFromConsoleUrl } from './mcp-url.js'

export function openBrowser (url: string, logger?: Logger): void {
  try {
    // eslint-disable-next-line no-new
    new URL(url)
  } catch {
    logger?.warn('auth.openBrowser.invalidUrl', { url })
    return
  }
  if (process.platform === 'win32') {
    // Use ShellExecute directly instead of cmd /c start to avoid & being
    // interpreted as a command separator on Windows. Resolve rundll32 from
    // the Windows directory explicitly: a bare executable name can otherwise
    // be found in the current working directory before the system directory.
    const systemRoot = process.env.SystemRoot ?? process.env.WINDIR
    // win32.isAbsolute accepts root-relative paths such as `\\Windows`, which
    // would still depend on the current drive. Only accept a drive-qualified
    // or UNC system root.
    if (!systemRoot || !/^(?:[a-zA-Z]:[\\/]|\\\\[^\\/]+[\\/][^\\/]+)/.test(systemRoot)) {
      logger?.warn('auth.openBrowser.failed', { error: 'Windows system root is unavailable' })
      return
    }
    const rundll32 = win32.join(systemRoot, 'System32', 'rundll32.exe')
    execFile(rundll32, ['url.dll,FileProtocolHandler', url], (err) => {
      if (err) logger?.warn('auth.openBrowser.failed', { error: err.message })
    })
    return
  }
  const cmd = process.platform === 'darwin' ? 'open' : 'xdg-open'
  execFile(cmd, [url], (err) => {
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
  /** Force a fresh OAuth round-trip even if valid credentials exist (used to switch NodeSource organizations). */
  force?: boolean;
  /** Injectable stdout/stderr sink for headless OAuth sign-in instructions. Defaults to `process.stderr.write`. */
  notify?: (text: string) => void;
  /**
   * Injectable browser launcher for the sign-in URL. Defaults to the
   * production `openBrowser()` (rundll32/open/xdg-open). Tests inject a
   * capture-only launcher so authentication never spawns a real browser.
   * Must not throw (see {@link BrowserLauncher}).
   */
  browserLauncher?: BrowserLauncher;
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

  if (existing && !isExpired(existing) && !options.force) {
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

  // Headless-safe manual fallback: surface the sign-in URL on stderr so a
  // failed `open`/`xdg-open` (devcontainer, CI, agent host) does not leave the
  // user waiting out the full timeout with no path to authenticate. The URL
  // carries only the loopback port + CSRF state — never tokens — and is always
  // printed regardless of whether the browser launch succeeds.
  const notify = options.notify ?? ((text: string) => process.stderr.write(text))
  notify('\nNodeSource authentication started.\n')
  notify('If a browser did not open automatically, open this sign-in URL manually:\n')
  notify(`${signInUrl.toString()}\n\n`)

  const launchBrowser = options.browserLauncher ?? openBrowser
  launchBrowser(signInUrl.toString(), logger)

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

  // Never guess a production MCP host when the console URL is not a recognized
  // NodeSource SaaS origin. Silently persisting a wrong endpoint here would
  // make it sticky (install and the runtime wrapper both prefer stored
  // `mcpUrl` over re-deriving). Fail with an actionable error instead, leaving
  // the previous credentials untouched on disk.
  const mcpUrl = deriveMcpUrlFromConsoleUrl(callback.consoleUrl, callback.consoleId)
  if (mcpUrl === null) {
    const pluginErr = toPluginError(
      new Error(`Could not determine the N|Solid MCP endpoint from the console URL for org "${callback.consoleId}" (unrecognized NodeSource console host).`),
      'AUTH_FAILED',
      {
        action: 'Re-run setup after confirming the console URL, or contact NodeSource support for your organization\'s MCP endpoint. Existing credentials were left unchanged.',
      }
    )
    throw new Error(formatPluginError(pluginErr), { cause: pluginErr })
  }

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
