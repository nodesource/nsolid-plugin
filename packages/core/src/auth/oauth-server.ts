import { createServer } from 'node:http'
import { createServer as createNetServer } from 'node:net'
import { URL } from 'node:url'

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
  | { success: false; reason: 'timeout' | 'auth-failed' }

export type OAuthServer = {
  port: number;
  waitForCallback(): Promise<OAuthCallbackResult>;
  close(): Promise<void>;
}

import type { Logger } from '../types.js'

const DEFAULT_PORT = 8765
const MAX_PORT = 8770
const TIMEOUT_MS = 5 * 60 * 1000

/**
 * Build a styled HTML response page for the callback tab.
 *
 * Mirrors the accounts-ui OAuth redirect screen: Source Sans Pro, a
 * font-weight 300 / 36px white header, gray300 muted body text, on the dark4
 * background used by the facetBg container (without the raster background
 * image, which is impractical to embed here).
 *
 * The page is fully static — all styling is inline CSS with zero network
 * requests. It is served from a loopback URL and avoids any external resource.
 */
function renderCallbackPage (opts: {
  ok: boolean
  title: string
  message: string
}): string {
  const { ok, title, message } = opts
  const closer = ok
    ? '<p class="ns-text">This tab will close automatically. If it doesn\u2019t, you can close it manually.</p><script>setTimeout(function(){try{window.close()}catch(e){}},800)</script>'
    : '<p class="ns-text">Please return to N\u002FSolid and try again.</p>'

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title>
<style>
  * { box-sizing: border-box; }
  html, body {
    margin: 0;
    padding: 0;
    min-height: 100%;
    /* dark4 (facetBg base) — solid stand-in for the accounts-ui background image */
    background: rgb(32, 37, 37);
    /* white foreground, mirroring Screen theme='dark' */
    color: rgb(255, 255, 255);
    font-family: 'Source Sans Pro', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;
    font-size: 16px;
    line-height: 1.25;
  }
  .ns-screen {
    min-height: 100vh;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    padding: 24px;
  }
  .ns-center {
    display: flex;
    flex-direction: column;
    margin: auto;
    align-items: center;
    justify-content: center;
    text-align: center;
    max-width: 480px;
  }
  /* Header (accounts-ui @ns-private/elements Header) */
  .ns-header {
    margin: 0 0 5px 0;
    font-weight: 300;
    line-height: 1;
    font-size: 36px;
    align-self: center;
  }
  /* Text muted — accounts-ui OAuthRedirectScreen uses fontsize 17px, mt 30px, gray300 */
  .ns-text {
    margin-top: 30px;
    font-size: 17px;
    /* gray300 = #89a19d */
    color: rgb(137, 161, 157);
  }
</style>
</head>
<body>
  <div class="ns-screen">
    <div class="ns-center">
      <h1 class="ns-header">${title}</h1>
      <p class="ns-text">${message}</p>
      ${closer}
    </div>
  </div>
</body>
</html>`
}

function isPortAvailable (port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const tester = createNetServer()
      .once('error', () => resolve(false))
      .listen(port, '127.0.0.1', () => {
        tester.close(() => resolve(true))
      })
  })
}

async function findAvailablePort (startPort: number): Promise<number> {
  for (let port = startPort; port <= MAX_PORT; port++) {
    if (await isPortAvailable(port)) {
      return port
    }
  }
  throw new Error(`No available ports in range ${startPort}-${MAX_PORT}`)
}

export async function startOAuthServer (preferredPort?: number, expectedState?: string, logger?: Logger): Promise<OAuthServer> {
  const startPort = preferredPort ?? DEFAULT_PORT
  let port = await findAvailablePort(startPort)
  let resolveCallback: ((result: OAuthCallbackResult) => void) | null = null
  let settled = false
  let settledResult: OAuthCallbackResult | null = null

  logger?.debug('auth.server.starting', { port, expectedState: expectedState ? 'set' : 'none' })

  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    const success = url.searchParams.get('success') === 'true'
    const token = url.searchParams.get('token')
    const consoleId = url.searchParams.get('consoleId')
    const saasToken = url.searchParams.get('NSOLID_SAAS')
    const consoleUrl = url.searchParams.get('url')
    const state = url.searchParams.get('state')

    const headers = {
      'Content-Type': 'text/html',
      'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'",
      Connection: 'close',
    }

    if (expectedState && state !== expectedState) {
      logger?.warn('auth.server.csrf.mismatch', { receivedState: state })
      res.writeHead(400, headers)
      res.end(renderCallbackPage({ ok: false, title: 'Authentication failed', message: 'Invalid state parameter.' }))
      return
    }

    if (!success) {
      logger?.warn('auth.server.callback.failed')
      res.writeHead(400, headers)
      res.end(renderCallbackPage({ ok: false, title: 'Authentication failed', message: 'Authentication was not successful.' }))
      if (!settled) {
        settled = true
        settledResult = { success: false, reason: 'auth-failed' }
        resolveCallback?.(settledResult)
      }
      return
    }

    if (token && consoleId && saasToken && consoleUrl && !settled) {
      logger?.debug('auth.server.callback.success', { consoleId })
      settled = true
      settledResult = { success: true, token, consoleId, saasToken, consoleUrl }
      res.writeHead(200, headers)
      res.end(renderCallbackPage({ ok: true, title: 'Authentication successful', message: 'You can close this window.' }))
      resolveCallback?.(settledResult)
    } else {
      logger?.warn('auth.server.callback.missingParams')
      res.writeHead(400, headers)
      res.end(renderCallbackPage({ ok: false, title: 'Authentication failed', message: 'Missing required parameters.' }))
      if (!settled) {
        settled = true
        settledResult = { success: false, reason: 'auth-failed' }
        resolveCallback?.(settledResult)
      }
    }
  })

  // Retry loop to handle TOCTOU race between port check and bind
  while (port <= MAX_PORT) {
    try {
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject)
        server.listen(port, '127.0.0.1', () => {
          server.removeListener('error', reject)
          resolve()
        })
      })
      break // Successfully bound
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'EADDRINUSE') {
        port = await findAvailablePort(port + 1)
      } else {
        throw err
      }
    }
  }

  if (port > MAX_PORT) {
    throw new Error(`No available ports in range ${startPort}-${MAX_PORT}`)
  }

  const timeoutId = setTimeout(() => {
    if (!settled) {
      logger?.warn('auth.server.timeout', { timeoutMs: TIMEOUT_MS })
      settled = true
      settledResult = { success: false, reason: 'timeout' }
      resolveCallback?.(settledResult)
    }
  }, TIMEOUT_MS)

  return {
    port,
    waitForCallback (): Promise<OAuthCallbackResult> {
      return new Promise((resolve) => {
        if (settled) {
          resolve(settledResult!)
          return
        }
        resolveCallback = (result) => {
          clearTimeout(timeoutId)
          resolve(result)
        }
      })
    },
    close (): Promise<void> {
      clearTimeout(timeoutId)
      if (!settled) {
        settled = true
        settledResult = { success: false, reason: 'timeout' }
        resolveCallback?.(settledResult)
      }
      return new Promise<void>((resolve) => {
        if ('closeAllConnections' in server) {
          server.closeAllConnections()
        }
        server.close(() => resolve())
      })
    },
  }
}
