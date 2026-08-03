import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const cp = require('node:child_process')

describe('openBrowser', () => {
  let originalPlatform: PropertyDescriptor | undefined
  let execFileCalls: unknown[][]
  let originalExecFile: typeof cp.execFile

  beforeEach(() => {
    execFileCalls = []
    originalExecFile = cp.execFile
    cp.execFile = (...args: unknown[]) => {
      execFileCalls.push(args)
    }
    originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform')
  })

  afterEach(() => {
    cp.execFile = originalExecFile
    if (originalPlatform) {
      Object.defineProperty(process, 'platform', originalPlatform)
    }
  })

  it('opens the URL with rundll32 on Windows', async () => {
    Object.defineProperty(process, 'platform', { value: 'win32' })

    const { openBrowser } = await import('../../../src/auth/auth-manager.js')
    const url = 'https://accounts.example.com/sign-in?extension=nsolid-plugin&port=8765&state=abc'
    openBrowser(url)

    assert.strictEqual(execFileCalls.length, 1)
    const [cmd, args] = execFileCalls[0] as [string, string[]]
    assert.strictEqual(cmd, 'rundll32')
    assert.deepStrictEqual(args.slice(0, -1), ['url.dll,FileProtocolHandler'])
    assert.strictEqual(args[args.length - 1], url)
  })

  it('opens the URL with open on macOS', async () => {
    Object.defineProperty(process, 'platform', { value: 'darwin' })

    const { openBrowser } = await import('../../../src/auth/auth-manager.js')
    const url = 'https://accounts.example.com/sign-in?extension=nsolid-plugin&port=8765&state=abc'
    openBrowser(url)

    assert.strictEqual(execFileCalls.length, 1)
    const [cmd, args] = execFileCalls[0] as [string, string[]]
    assert.strictEqual(cmd, 'open')
    assert.deepStrictEqual(args, [url])
  })

  it('opens the URL with xdg-open on Linux', async () => {
    Object.defineProperty(process, 'platform', { value: 'linux' })

    const { openBrowser } = await import('../../../src/auth/auth-manager.js')
    const url = 'https://accounts.example.com/sign-in?extension=nsolid-plugin&port=8765&state=abc'
    openBrowser(url)

    assert.strictEqual(execFileCalls.length, 1)
    const [cmd, args] = execFileCalls[0] as [string, string[]]
    assert.strictEqual(cmd, 'xdg-open')
    assert.deepStrictEqual(args, [url])
  })

  it('does nothing for an invalid URL', async () => {
    Object.defineProperty(process, 'platform', { value: 'win32' })

    const { openBrowser } = await import('../../../src/auth/auth-manager.js')
    openBrowser('not a url')

    assert.strictEqual(execFileCalls.length, 0)
  })
})
