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

    if (expectedState && state !== expectedState) {
      logger?.warn('auth.server.csrf.mismatch', { receivedState: state })
      res.writeHead(400, { 'Content-Type': 'text/html' })
      res.end('<html><body><h1>Authentication failed</h1><p>Invalid state parameter.</p></body></html>')
      if (!settled) {
        settled = true
        settledResult = { success: false, reason: 'auth-failed' }
        resolveCallback?.(settledResult)
      }
      return
    }

    if (!success) {
      logger?.warn('auth.server.callback.failed')
      res.writeHead(400, { 'Content-Type': 'text/html' })
      res.end('<html><body><h1>Authentication failed</h1><p>Authentication was not successful.</p></body></html>')
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
      res.writeHead(200, { 'Content-Type': 'text/html' })
      res.end('<html><body><h1>Authentication successful!</h1><p>You can close this window.</p></body></html>')
      resolveCallback?.(settledResult)
    } else {
      logger?.warn('auth.server.callback.missingParams')
      res.writeHead(400, { 'Content-Type': 'text/html' })
      res.end('<html><body><h1>Authentication failed</h1><p>Missing required parameters.</p></body></html>')
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
