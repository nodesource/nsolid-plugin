export type ValidationResult =
  | { valid: true; permissions: string[] }
  | { valid: false; reason: string };

export async function validateToken(
  token: string,
  orgId: string,
  accountsUrl: string
): Promise<ValidationResult> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 10000);

  try {
    const url = new URL('/accounts/org/access-token', accountsUrl);
    url.searchParams.set('tokenId', token);
    url.searchParams.set('orgId', orgId);

    const response = await fetch(url.toString(), {
      signal: controller.signal,
    });

    if (response.status === 401 || response.status === 403) {
      return { valid: false, reason: 'Invalid credentials' };
    }

    if (!response.ok) {
      throw new Error(`Accounts API returned ${response.status}`);
    }

    const data = await response.json() as { permissions?: string[] };
    return { valid: true, permissions: data.permissions ?? [] };
  } catch (err) {
    if ((err as Error).name === 'AbortError') {
      throw new Error('Token validation timed out', { cause: err });
    }
    throw err;
  } finally {
    clearTimeout(timeoutId);
  }
}
