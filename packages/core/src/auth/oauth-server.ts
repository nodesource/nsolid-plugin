import { createServer } from 'node:http';
import { createServer as createNetServer } from 'node:net';
import { URL } from 'node:url';

/**
 * Local OAuth callback server.
 *
 * Security model:
 * - Binds to 127.0.0.1 only — not reachable from other machines
 * - Tokens arrive as URL query parameters (standard OAuth redirect pattern)
 * - CSRF protection via cryptographic state parameter (randomUUID)
 * - Server shuts down after first successful callback or 5-minute timeout
 * - Credentials stored as plaintext JSON with 0o600 permissions (typical for CLI tools)
 *   For stronger protection, consider OS keychain integration in the future
 */

export type OAuthCallbackResult =
  | { success: true; token: string; consoleId: string; saasToken: string; consoleUrl: string }
  | { success: false; reason: 'timeout' | 'auth-failed' };

export type OAuthServer = {
  port: number;
  waitForCallback(): Promise<OAuthCallbackResult>;
  close(): void;
};

const DEFAULT_PORT = 8765;
const MAX_PORT = 8770;
const TIMEOUT_MS = 5 * 60 * 1000;

function isPortAvailable(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const tester = createNetServer()
      .once('error', () => resolve(false))
      .listen(port, '127.0.0.1', () => {
        tester.close(() => resolve(true));
      });
  });
}

async function findAvailablePort(startPort: number): Promise<number> {
  for (let port = startPort; port <= MAX_PORT; port++) {
    if (await isPortAvailable(port)) {
      return port;
    }
  }
  throw new Error(`No available ports in range ${startPort}-${MAX_PORT}`);
}

export async function startOAuthServer(preferredPort?: number, expectedState?: string): Promise<OAuthServer> {
  const startPort = preferredPort ?? DEFAULT_PORT;
  const port = await findAvailablePort(startPort);
  let resolveCallback: ((result: OAuthCallbackResult) => void) | null = null;
  let settled = false;

  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', `http://127.0.0.1`);
    const success = url.searchParams.get('success') === 'true';
    const token = url.searchParams.get('token');
    const consoleId = url.searchParams.get('consoleId');
    const saasToken = url.searchParams.get('NSOLID_SAAS');
    const consoleUrl = url.searchParams.get('url');
    const state = url.searchParams.get('state');

    if (expectedState && state !== expectedState) {
      res.writeHead(400, { 'Content-Type': 'text/html' });
      res.end('<html><body><h1>Authentication failed</h1><p>Invalid state parameter.</p></body></html>');
      return;
    }

    if (!success) {
      res.writeHead(400, { 'Content-Type': 'text/html' });
      res.end('<html><body><h1>Authentication failed</h1><p>Authentication was not successful.</p></body></html>');
      if (!settled) {
        settled = true;
        resolveCallback?.({ success: false, reason: 'auth-failed' });
      }
      return;
    }

    if (token && consoleId && saasToken && consoleUrl && !settled) {
      settled = true;
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end('<html><body><h1>Authentication successful!</h1><p>You can close this window.</p></body></html>');
      resolveCallback?.({ success: true, token, consoleId, saasToken, consoleUrl });
    } else {
      res.writeHead(400, { 'Content-Type': 'text/html' });
      res.end('<html><body><h1>Authentication failed</h1><p>Missing required parameters.</p></body></html>');
    }
  });

  await new Promise<void>((resolve) => {
    server.listen(port, '127.0.0.1', () => resolve());
  });

  const timeoutId = setTimeout(() => {
    if (!settled) {
      settled = true;
      resolveCallback?.({ success: false, reason: 'timeout' });
    }
  }, TIMEOUT_MS);

  return {
    port,
    waitForCallback(): Promise<OAuthCallbackResult> {
      return new Promise((resolve) => {
        if (settled) {
          resolve({ success: false, reason: 'timeout' });
          return;
        }
        resolveCallback = (result) => {
          clearTimeout(timeoutId);
          resolve(result);
        };
      });
    },
    close() {
      clearTimeout(timeoutId);
      if (!settled) {
        settled = true;
        resolveCallback?.({ success: false, reason: 'timeout' });
      }
      server.close();
    },
  };
}
