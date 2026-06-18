import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { createLogger, isVerboseEnabled } from '../../../src/utils/logger.js'

let originalVerbose: string | undefined
let originalWrite: typeof process.stderr.write | undefined
let stderrOutput: string

beforeEach(() => {
  originalVerbose = process.env.NSOLID_PLUGIN_VERBOSE
  delete process.env.NSOLID_PLUGIN_VERBOSE
  stderrOutput = ''
  originalWrite = process.stderr.write
  process.stderr.write = ((chunk: unknown, ...args: unknown[]) => {
    stderrOutput += String(chunk)
    return originalWrite!.apply(process.stderr, [chunk, ...args] as Parameters<typeof process.stderr.write>)
  }) as typeof process.stderr.write
})

afterEach(() => {
  if (originalWrite !== undefined) {
    process.stderr.write = originalWrite
    originalWrite = undefined
  }
  if (originalVerbose !== undefined) {
    process.env.NSOLID_PLUGIN_VERBOSE = originalVerbose
  } else {
    delete process.env.NSOLID_PLUGIN_VERBOSE
  }
})

describe('isVerboseEnabled', () => {
  it('returns explicit value when provided', () => {
    assert.strictEqual(isVerboseEnabled(true), true)
    assert.strictEqual(isVerboseEnabled(false), false)
  })

  it('reads NSOLID_PLUGIN_VERBOSE env var', () => {
    process.env.NSOLID_PLUGIN_VERBOSE = '1'
    assert.strictEqual(isVerboseEnabled(), true)
    process.env.NSOLID_PLUGIN_VERBOSE = 'true'
    assert.strictEqual(isVerboseEnabled(), true)
    process.env.NSOLID_PLUGIN_VERBOSE = 'yes'
    assert.strictEqual(isVerboseEnabled(), true)
    process.env.NSOLID_PLUGIN_VERBOSE = 'false'
    assert.strictEqual(isVerboseEnabled(), false)
  })
})

describe('createLogger', () => {
  it('suppresses debug and info by default', () => {
    const logger = createLogger()
    logger.debug('debug msg')
    logger.info('info msg')
    assert.strictEqual(stderrOutput, '')
  })

  it('emits warnings and errors by default', () => {
    const logger = createLogger()
    logger.warn('warn msg')
    logger.error('error msg')
    assert.ok(stderrOutput.includes('warn msg'))
    assert.ok(stderrOutput.includes('error msg'))
  })

  it('emits all levels in verbose mode', () => {
    const logger = createLogger({ verbose: true })
    logger.debug('debug msg')
    logger.info('info msg')
    assert.ok(stderrOutput.includes('debug msg'))
    assert.ok(stderrOutput.includes('info msg'))
  })

  it('redacts token-like meta values', () => {
    const logger = createLogger({ verbose: true })
    logger.info('call', { serviceToken: 'secret-token', safeKey: 'visible' })
    assert.ok(!stderrOutput.includes('secret-token'))
    assert.ok(stderrOutput.includes('<redacted>'))
    assert.ok(stderrOutput.includes('visible'))
  })

  it('redacts URL query tokens in messages', () => {
    const logger = createLogger({ verbose: true })
    logger.info('callback: http://127.0.0.1/?token=abc&state=xyz')
    assert.ok(!stderrOutput.includes('abc'))
    assert.ok(stderrOutput.includes('token=<redacted>'))
  })
})
