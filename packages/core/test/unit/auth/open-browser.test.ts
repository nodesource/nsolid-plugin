import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { createRequire, syncBuiltinESMExports } from 'node:module'

const require = createRequire(import.meta.url)
const cp = require('node:child_process')
let moduleLoadId = 0

async function loadOpenBrowser () {
  return await import(`../../../src/auth/auth-manager.js?open-browser-test=${moduleLoadId++}`)
}

describe('openBrowser', () => {
  let originalPlatform: PropertyDescriptor | undefined
  let execFileCalls: unknown[][]
  let originalExecFile: typeof cp.execFile
  let originalSystemRoot: string | undefined
  let originalWindir: string | undefined

  beforeEach(() => {
    execFileCalls = []
    originalExecFile = cp.execFile
    cp.execFile = (...args: unknown[]) => {
      execFileCalls.push(args)
    }
    syncBuiltinESMExports()
    originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform')
    originalSystemRoot = process.env.SystemRoot
    originalWindir = process.env.WINDIR
  })

  afterEach(() => {
    cp.execFile = originalExecFile
    syncBuiltinESMExports()
    if (originalPlatform) {
      Object.defineProperty(process, 'platform', originalPlatform)
    }
    if (originalSystemRoot === undefined) delete process.env.SystemRoot
    else process.env.SystemRoot = originalSystemRoot
    if (originalWindir === undefined) delete process.env.WINDIR
    else process.env.WINDIR = originalWindir
  })

  it('opens the URL with the trusted rundll32 path on Windows', async () => {
    Object.defineProperty(process, 'platform', { value: 'win32' })
    process.env.SystemRoot = 'C:\\Windows'

    const { openBrowser } = await loadOpenBrowser()
    const url = 'https://accounts.example.com/sign-in?extension=nsolid-plugin&port=8765&state=abc'
    openBrowser(url)

    assert.strictEqual(execFileCalls.length, 1)
    const [cmd, args] = execFileCalls[0] as [string, string[]]
    assert.strictEqual(cmd, 'C:\\Windows\\System32\\rundll32.exe')
    assert.deepStrictEqual(args.slice(0, -1), ['url.dll,FileProtocolHandler'])
    assert.strictEqual(args[args.length - 1], url)
  })

  it('does not launch a relative rundll32 when Windows system root is unavailable', async () => {
    Object.defineProperty(process, 'platform', { value: 'win32' })
    delete process.env.SystemRoot
    delete process.env.WINDIR

    const warnings: unknown[][] = []
    const logger = { warn: (...args: unknown[]) => warnings.push(args) }
    const { openBrowser } = await loadOpenBrowser()
    openBrowser('https://accounts.example.com/sign-in', logger as never)

    assert.strictEqual(execFileCalls.length, 0)
    assert.deepStrictEqual(warnings, [['auth.openBrowser.failed', {
      error: 'Windows system root is unavailable',
    }]])
  })

  it('does not use a root-relative Windows system directory', async () => {
    Object.defineProperty(process, 'platform', { value: 'win32' })
    process.env.SystemRoot = '\\Windows'

    const warnings: unknown[][] = []
    const logger = { warn: (...args: unknown[]) => warnings.push(args) }
    const { openBrowser } = await loadOpenBrowser()
    openBrowser('https://accounts.example.com/sign-in', logger as never)

    assert.strictEqual(execFileCalls.length, 0)
    assert.deepStrictEqual(warnings, [['auth.openBrowser.failed', {
      error: 'Windows system root is unavailable',
    }]])
  })

  it('uses WINDIR when SystemRoot is unavailable', async () => {
    Object.defineProperty(process, 'platform', { value: 'win32' })
    delete process.env.SystemRoot
    process.env.WINDIR = 'D:\\Windows'

    const { openBrowser } = await loadOpenBrowser()
    openBrowser('https://accounts.example.com/sign-in')

    const [cmd, args] = execFileCalls[0] as [string, string[]]
    assert.strictEqual(cmd, 'D:\\Windows\\System32\\rundll32.exe')
    assert.deepStrictEqual(args, ['url.dll,FileProtocolHandler', 'https://accounts.example.com/sign-in'])
  })

  it('preserves a Windows URL as one exact argument and reports spawn errors', async () => {
    Object.defineProperty(process, 'platform', { value: 'win32' })
    process.env.SystemRoot = 'C:\\Windows'
    cp.execFile = (...args: unknown[]) => {
      execFileCalls.push(args)
      const callback = args[2] as (err: Error | null) => void
      callback(new Error('browser launch failed'))
    }
    syncBuiltinESMExports()

    const warnings: unknown[][] = []
    const logger = { warn: (...args: unknown[]) => warnings.push(args) }
    const { openBrowser } = await loadOpenBrowser()
    const url = 'https://accounts.example.com/sign-in?next=a%2Fb&value=one%20two&emoji=%F0%9F%9A%80'
    openBrowser(url, logger as never)

    const [cmd, args] = execFileCalls[0] as [string, string[]]
    assert.strictEqual(cmd, 'C:\\Windows\\System32\\rundll32.exe')
    assert.deepStrictEqual(args, ['url.dll,FileProtocolHandler', url])
    assert.deepStrictEqual(warnings, [['auth.openBrowser.failed', { error: 'browser launch failed' }]])
  })

  it('opens the URL with open on macOS', async () => {
    Object.defineProperty(process, 'platform', { value: 'darwin' })

    const { openBrowser } = await loadOpenBrowser()
    const url = 'https://accounts.example.com/sign-in?extension=nsolid-plugin&port=8765&state=abc'
    openBrowser(url)

    assert.strictEqual(execFileCalls.length, 1)
    const [cmd, args] = execFileCalls[0] as [string, string[]]
    assert.strictEqual(cmd, 'open')
    assert.deepStrictEqual(args, [url])
  })

  it('opens the URL with xdg-open on Linux', async () => {
    Object.defineProperty(process, 'platform', { value: 'linux' })

    const { openBrowser } = await loadOpenBrowser()
    const url = 'https://accounts.example.com/sign-in?extension=nsolid-plugin&port=8765&state=abc'
    openBrowser(url)

    assert.strictEqual(execFileCalls.length, 1)
    const [cmd, args] = execFileCalls[0] as [string, string[]]
    assert.strictEqual(cmd, 'xdg-open')
    assert.deepStrictEqual(args, [url])
  })

  it('does nothing for an invalid URL', async () => {
    Object.defineProperty(process, 'platform', { value: 'win32' })

    const { openBrowser } = await loadOpenBrowser()
    openBrowser('not a url')

    assert.strictEqual(execFileCalls.length, 0)
  })
})
