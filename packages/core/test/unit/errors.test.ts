import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  PluginError,
  PermissionError,
  InvalidCredentialsError,
  isNodeErrno,
  toPluginError,
  permissionGuidance,
  formatPluginError,
} from '../../src/errors.js'

describe('PluginError', () => {
  it('carries code and options', () => {
    const err = new PluginError('BUNDLE_INVALID', 'bad bundle', {
      action: 'Check the file.',
      path: '/x/bundle.json',
      harness: 'claude',
      platform: 'linux',
    })
    assert.strictEqual(err.code, 'BUNDLE_INVALID')
    assert.strictEqual(err.action, 'Check the file.')
    assert.strictEqual(err.path, '/x/bundle.json')
    assert.strictEqual(err.harness, 'claude')
    assert.strictEqual(err.platform, 'linux')
    assert.strictEqual(err.name, 'PluginError')
  })
})

describe('PermissionError', () => {
  it('has AUTH_PERMISSION_DENIED code and action', () => {
    const err = new PermissionError(['read'], 'Missing read')
    assert.strictEqual(err.code, 'AUTH_PERMISSION_DENIED')
    assert.ok(err.action)
    assert.deepStrictEqual(err.missingPermissions, ['read'])
  })
})

describe('InvalidCredentialsError', () => {
  it('has AUTH_INVALID_CREDENTIALS code and action', () => {
    const err = new InvalidCredentialsError('bad creds')
    assert.strictEqual(err.code, 'AUTH_INVALID_CREDENTIALS')
    assert.ok(err.action)
  })
})

describe('isNodeErrno', () => {
  it('matches known errno codes', () => {
    assert.ok(isNodeErrno(new Error('x') as NodeJS.ErrnoException, 'ENOENT') === false)
    const e: NodeJS.ErrnoException = new Error('no file')
    e.code = 'ENOENT'
    assert.ok(isNodeErrno(e))
    assert.ok(isNodeErrno(e, 'ENOENT'))
    assert.strictEqual(isNodeErrno(e, 'EACCES'), false)
  })
})

describe('toPluginError', () => {
  it('returns existing PluginError unchanged', () => {
    const original = new PluginError('BUNDLE_NOT_FOUND', 'x')
    assert.strictEqual(toPluginError(original, 'UNKNOWN'), original)
  })

  it('maps EACCES to PERMISSION_DENIED with guidance', () => {
    const err: NodeJS.ErrnoException = new Error('permission denied')
    err.code = 'EACCES'
    const pluginErr = toPluginError(err, 'UNKNOWN', { path: '/x' })
    assert.strictEqual(pluginErr.code, 'PERMISSION_DENIED')
    assert.ok(pluginErr.action)
  })

  it('maps ENOENT to BUNDLE_NOT_FOUND', () => {
    const err: NodeJS.ErrnoException = new Error('no file')
    err.code = 'ENOENT'
    const pluginErr = toPluginError(err, 'UNKNOWN', { path: '/x' })
    assert.strictEqual(pluginErr.code, 'BUNDLE_NOT_FOUND')
  })

  it('maps EADDRINUSE to AUTH_FAILED', () => {
    const err: NodeJS.ErrnoException = new Error('address in use')
    err.code = 'EADDRINUSE'
    const pluginErr = toPluginError(err, 'UNKNOWN')
    assert.strictEqual(pluginErr.code, 'AUTH_FAILED')
  })
})

describe('permissionGuidance', () => {
  it('suggests chown on Unix', () => {
    const guidance = permissionGuidance('~/.claude.json', 'linux')
    assert.ok(guidance.includes('chown'))
    assert.ok(!guidance.includes('icacls'))
  })

  it('suggests icacls on Windows', () => {
    const guidance = permissionGuidance('~/.claude.json', 'win32')
    assert.ok(guidance.includes('icacls'))
    assert.ok(!guidance.includes('chown'))
  })
})

describe('formatPluginError', () => {
  it('formats PluginError with path, harness, and action', () => {
    const err = new PluginError('MCP_CONFIG_WRITE_FAILED', 'write failed', {
      path: '/x',
      harness: 'claude',
      action: 'Check permissions.',
    })
    const formatted = formatPluginError(err)
    assert.ok(formatted.includes('MCP_CONFIG_WRITE_FAILED'))
    assert.ok(formatted.includes('/x'))
    assert.ok(formatted.includes('claude'))
    assert.ok(formatted.includes('Check permissions.'))
  })

  it('falls back to string for non-PluginError', () => {
    assert.strictEqual(formatPluginError(new Error('plain')), 'plain')
    assert.strictEqual(formatPluginError('oops'), 'oops')
  })
})
