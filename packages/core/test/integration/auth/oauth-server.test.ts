import { describe, it, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'

const timeout = (ms: number) => new Promise<never>((_resolve, reject) =>
  setTimeout(() => reject(new Error(`timed out after ${ms}ms`)), ms))

const cleanup: (() => Promise<void>)[] = []

afterEach(async () => {
  for (const fn of cleanup.splice(0)) await fn()
})

describe('oauth-server', () => {
  it('starts on default port and receives callback', async () => {
    const { startOAuthServer } = await import('../../../src/auth/oauth-server.js')
    const server = await startOAuthServer()
    cleanup.push(() => server.close())

    assert.strictEqual(server.port, 8765)

    const callbackPromise = server.waitForCallback()

    const params = new URLSearchParams({
      success: 'true',
      token: 'test-token',
      consoleId: 'org-123',
      NSOLID_SAAS: 'test-saas-token',
      url: 'https://test.saas.nodesource.io',
    })
    const response = await fetch(`http://127.0.0.1:${server.port}/?${params}`)
    assert.strictEqual(response.status, 200)

    const result = await callbackPromise
    assert.ok(result.success)
    if (result.success) {
      assert.strictEqual(result.token, 'test-token')
      assert.strictEqual(result.consoleId, 'org-123')
      assert.strictEqual(result.saasToken, 'test-saas-token')
      assert.strictEqual(result.consoleUrl, 'https://test.saas.nodesource.io')
    }
  })

  it('falls back to next port on conflict', async () => {
    const blocker = createServer()
    await new Promise<void>((resolve) => blocker.listen({ port: 8769, host: '127.0.0.1', reuseAddr: true }, resolve))
    cleanup.push(() => new Promise<void>((resolve) => blocker.close(() => resolve())))

    const { startOAuthServer } = await import('../../../src/auth/oauth-server.js')
    const server = await startOAuthServer(8769)
    cleanup.push(() => server.close())

    assert.strictEqual(server.port, 8770)
  })

  it('retries on EADDRINUSE during listen callback', async () => {
    const blocker = createServer()
    cleanup.push(() => new Promise<void>((resolve) => blocker.close(() => resolve())))

    await new Promise<void>((resolve, reject) => {
      blocker.once('error', reject)
      blocker.listen({ port: 8768, host: '127.0.0.1', reuseAddr: true }, () => {
        blocker.removeListener('error', reject)
        resolve()
      })
    })

    const { startOAuthServer } = await import('../../../src/auth/oauth-server.js')
    const server = await startOAuthServer(8768)
    cleanup.push(() => server.close())

    assert.strictEqual(server.port, 8769)
  })

  it('resolves with timeout on close before callback', async () => {
    const { startOAuthServer } = await import('../../../src/auth/oauth-server.js')
    const server = await startOAuthServer()

    const callbackPromise = server.waitForCallback()
    await server.close()

    const result = await callbackPromise
    assert.ok(!result.success)
    if (!result.success) {
      assert.strictEqual(result.reason, 'timeout')
    }
  })

  it('returns 400 for missing params', async () => {
    const { startOAuthServer } = await import('../../../src/auth/oauth-server.js')
    const server = await startOAuthServer()
    cleanup.push(() => server.close())

    const response = await fetch(`http://127.0.0.1:${server.port}/?token=only-token`)
    assert.strictEqual(response.status, 400)
  })

  it('validates state parameter when provided', async () => {
    const { startOAuthServer } = await import('../../../src/auth/oauth-server.js')
    const server = await startOAuthServer(undefined, 'expected-state-123')
    cleanup.push(() => server.close())

    const callbackPromise = server.waitForCallback()

    const params = new URLSearchParams({
      success: 'true',
      token: 'test-token',
      consoleId: 'org-123',
      NSOLID_SAAS: 'test-saas-token',
      url: 'https://test.saas.nodesource.io',
      state: 'expected-state-123',
    })
    const response = await fetch(`http://127.0.0.1:${server.port}/?${params}`)
    assert.strictEqual(response.status, 200)

    const result = await callbackPromise
    assert.ok(result.success)
    if (result.success) {
      assert.strictEqual(result.token, 'test-token')
      assert.strictEqual(result.consoleId, 'org-123')
    }
  })

  it('rejects callback with invalid state', async () => {
    const { startOAuthServer } = await import('../../../src/auth/oauth-server.js')
    const server = await startOAuthServer(undefined, 'expected-state-123')
    cleanup.push(() => server.close())

    const params = new URLSearchParams({
      success: 'true',
      token: 'test-token',
      consoleId: 'org-123',
      NSOLID_SAAS: 'test-saas-token',
      url: 'https://test.saas.nodesource.io',
      state: 'wrong-state',
    })
    const response = await fetch(`http://127.0.0.1:${server.port}/?${params}`)
    assert.strictEqual(response.status, 400)
  })

  it('rejects callback when success is false', async () => {
    const { startOAuthServer } = await import('../../../src/auth/oauth-server.js')
    const server = await startOAuthServer()
    cleanup.push(() => server.close())

    const callbackPromise = server.waitForCallback()

    const params = new URLSearchParams({
      success: 'false',
      token: 'test-token',
      consoleId: 'org-123',
    })
    const response = await fetch(`http://127.0.0.1:${server.port}/?${params}`)
    assert.strictEqual(response.status, 400)

    const result = await callbackPromise
    assert.ok(!result.success)
    if (!result.success) {
      assert.strictEqual(result.reason, 'auth-failed')
    }
  })

  it('settles auth-failed immediately on a state-mismatch callback', async () => {
    const { startOAuthServer } = await import('../../../src/auth/oauth-server.js')
    const server = await startOAuthServer(undefined, 'expected-state')
    cleanup.push(() => server.close())

    const callbackPromise = server.waitForCallback()

    const params = new URLSearchParams({
      success: 'true',
      token: 'test-token',
      consoleId: 'org-123',
      NSOLID_SAAS: 'test-saas-token',
      url: 'https://test.saas.nodesource.io',
      state: 'wrong-state',
    })
    const response = await fetch(`http://127.0.0.1:${server.port}/?${params}`)
    assert.strictEqual(response.status, 400)

    const result = await Promise.race([callbackPromise, timeout(1000)])
    assert.ok(!result.success)
    if (!result.success) {
      assert.strictEqual(result.reason, 'auth-failed')
    }
  })

  it('settles auth-failed immediately on a missing-params callback', async () => {
    const { startOAuthServer } = await import('../../../src/auth/oauth-server.js')
    const server = await startOAuthServer()
    cleanup.push(() => server.close())

    const callbackPromise = server.waitForCallback()

    const response = await fetch(`http://127.0.0.1:${server.port}/?success=true`)
    assert.strictEqual(response.status, 400)

    const result = await Promise.race([callbackPromise, timeout(1000)])
    assert.ok(!result.success)
    if (!result.success) {
      assert.strictEqual(result.reason, 'auth-failed')
    }
  })
})
