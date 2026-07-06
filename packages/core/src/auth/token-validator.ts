import type { Logger } from '../types.js'
import { formatPluginError, toPluginError } from '../errors.js'

export type ValidationResult =
  | { valid: true; permissions: string[] }
  | { valid: false; reason: string }

export function deriveAccountsApiUrl (accountsUrl: string): string {
  const url = new URL(accountsUrl)
  if (url.hostname === 'accounts.nodesource.com') {
    url.hostname = 'api.nodesource.com'
  }
  return url.origin
}

export async function validateToken (
  token: string,
  orgId: string,
  accountsUrl: string,
  logger?: Logger
): Promise<ValidationResult> {
  const controller = new AbortController()
  const timeoutId = setTimeout(() => controller.abort(), 10000)

  try {
    const url = new URL('/accounts/org/access-token', deriveAccountsApiUrl(accountsUrl))
    url.searchParams.set('tokenId', token)
    url.searchParams.set('orgId', orgId)

    logger?.debug('auth.token.validate', { orgId, accountsUrl, apiUrl: url.origin })

    const response = await fetch(url.toString(), {
      signal: controller.signal,
    })

    if (response.status === 401 || response.status === 403 || response.status === 404) {
      return { valid: false, reason: 'Invalid credentials' }
    }

    if (!response.ok) {
      throw new Error(`NodeSource API returned ${response.status}`)
    }

    const contentType = response.headers?.get('content-type')
    if (contentType && !contentType.includes('application/json')) {
      throw new Error(`NodeSource API returned unexpected content type: ${contentType}`)
    }

    const data = await response.json() as unknown
    if (typeof data !== 'object' || data === null) {
      throw new Error('NodeSource API returned invalid response format')
    }
    const obj = data as Record<string, unknown>
    if (obj.permissions !== undefined && !Array.isArray(obj.permissions)) {
      throw new Error('NodeSource API returned invalid permissions format')
    }
    const permissions = Array.isArray(obj.permissions)
      ? obj.permissions.filter((p): p is string => typeof p === 'string')
      : []
    return { valid: true, permissions }
  } catch (err) {
    logger?.warn('auth.token.validate.failed', { orgId, error: (err as Error).message })
    if ((err as Error).name === 'AbortError') {
      const pluginErr = toPluginError(
        new Error('Token validation timed out'),
        'NETWORK_UNAVAILABLE',
        { action: 'Check network connectivity and retry.', cause: err }
      )
      throw new Error(formatPluginError(pluginErr), { cause: pluginErr })
    }
    throw err
  } finally {
    clearTimeout(timeoutId)
  }
}
