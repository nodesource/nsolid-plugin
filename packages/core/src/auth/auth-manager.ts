import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { platform } from 'node:os';
import type { AuthConfig, Credentials } from '../types.js';
import { loadCredentials, saveCredentials, isExpired } from './token-storage.js';
import { validateToken } from './token-validator.js';
import { startOAuthServer } from './oauth-server.js';

function openBrowser(url: string): void {
  const cmd = platform() === 'darwin' ? 'open' : platform() === 'win32' ? 'start' : 'xdg-open';
  execFile(cmd, [url], (err) => {
    if (err) console.warn(`Could not open browser: ${err.message}`);
  });
}

export async function ensureAuthenticated(authConfig: AuthConfig): Promise<Credentials> {
  let existing: Credentials | null = null;
  try {
    existing = loadCredentials();
  } catch {
    // Corrupt credentials file - fall through to re-authenticate
  }

  if (existing && !isExpired(existing)) {
    try {
      const result = await validateToken(existing.serviceToken, existing.organizationId, authConfig.accountsUrl);
      if (result.valid) {
        return existing;
      }
    } catch {
      // API unavailable - existing creds might still be valid
    }
  }

  const state = randomUUID();
  const signInUrl = `${authConfig.accountsUrl}/sign-in?extension=nsolid-plugin&state=${state}`;

  const server = await startOAuthServer(authConfig.callbackPort, state);

  openBrowser(signInUrl);

  const callback = await server.waitForCallback();
  server.close();

  if (!callback.success) {
    const reason = callback.reason === 'auth-failed' 
      ? 'Authentication failed. Please try again.'
      : 'Authentication timed out. Please try again.';
    throw new Error(reason);
  }

  const mcpUrl = `https://${callback.consoleId}.mcp.saas.nodesource.io`;

  try {
    const result = await validateToken(callback.token, callback.consoleId, authConfig.accountsUrl);
    if (!result.valid) {
      throw new Error(`Invalid credentials: ${result.reason}`);
    }

    const creds: Credentials = {
      serviceToken: callback.token,
      organizationId: callback.consoleId,
      saasToken: callback.saasToken,
      consoleUrl: callback.consoleUrl,
      mcpUrl,
      expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
      permissions: result.permissions,
    };

    saveCredentials(creds);
    return creds;
  } catch (err) {
    if ((err as Error).message.includes('Invalid credentials')) {
      throw err;
    }
    // API unavailable - store optimistically
    console.warn('Warning: Could not validate token. Storing credentials optimistically.');
    const creds: Credentials = {
      serviceToken: callback.token,
      organizationId: callback.consoleId,
      saasToken: callback.saasToken,
      consoleUrl: callback.consoleUrl,
      mcpUrl,
      expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
    };
    saveCredentials(creds);
    return creds;
  }
}
