export type ValidationResult =
  | { valid: true; permissions: string[] }
  | { valid: false; reason: string }

export async function validateToken (
  token: string,
  orgId: string,
  accountsUrl: string
): Promise<ValidationResult> {
  const controller = new AbortController()
  const timeoutId = setTimeout(() => controller.abort(), 10000)

  try {
    const url = new URL('/accounts/org/access-token', accountsUrl)
    url.searchParams.set('tokenId', token)
    url.searchParams.set('orgId', orgId)

    const response = await fetch(url.toString(), {
      signal: controller.signal,
    })

    if (response.status === 401 || response.status === 403) {
      return { valid: false, reason: 'Invalid credentials' }
    }

    if (!response.ok) {
      throw new Error(`Accounts API returned ${response.status}`)
    }

    const contentType = response.headers?.get('content-type')
    if (contentType && !contentType.includes('application/json')) {
      throw new Error(`Accounts API returned unexpected content type: ${contentType}`)
    }

    const data = await response.json() as unknown
    if (typeof data !== 'object' || data === null) {
      throw new Error('Accounts API returned invalid response format')
    }
    const obj = data as Record<string, unknown>
    if (obj.permissions !== undefined && !Array.isArray(obj.permissions)) {
      throw new Error('Accounts API returned invalid permissions format')
    }
    const permissions = Array.isArray(obj.permissions)
      ? obj.permissions.filter((p): p is string => typeof p === 'string')
      : []
    return { valid: true, permissions }
  } catch (err) {
    if ((err as Error).name === 'AbortError') {
      throw new Error('Token validation timed out', { cause: err })
    }
    throw err
  } finally {
    clearTimeout(timeoutId)
  }
}
