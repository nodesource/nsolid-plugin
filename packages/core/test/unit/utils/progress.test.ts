import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { createConsoleProgress, silentProgress } from '../../../src/utils/progress.js'

let originalWrite: typeof process.stderr.write | undefined
let stderrOutput: string

beforeEach(() => {
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
})

describe('createConsoleProgress', () => {
  it('prints plain strings when color is disabled', () => {
    const progress = createConsoleProgress({ color: false })

    progress.header('NodeSource installer — claude')
    progress.step('Reading bundle config', '1 skills, 1 MCP servers')
    progress.step('Opening browser to sign in', 'complete sign-in in the browser\n(waiting up to 5 min — Ctrl+C to cancel)')
    progress.done('Authenticated')
    progress.warn('Completed with errors', '1 issue(s)')

    const expected = [
      'NodeSource installer — claude',
      ' → Reading bundle config …  1 skills, 1 MCP servers',
      ' → Opening browser to sign in …  complete sign-in in the browser\n    (waiting up to 5 min — Ctrl+C to cancel)',
      ' ✓ Authenticated',
      ' ⚠ Completed with errors  1 issue(s)',
    ].join('\n') + '\n'

    assert.strictEqual(stderrOutput, expected)
  })

  it('wraps output in color escape codes when color is enabled', () => {
    const progress = createConsoleProgress({ color: true })

    progress.done('Authenticated')
    progress.warn('Completed with errors')

    assert.ok(stderrOutput.includes('\x1b[32m'))
    assert.ok(stderrOutput.includes('\x1b[33m'))
    assert.ok(stderrOutput.includes('Authenticated'))
    assert.ok(stderrOutput.includes('Completed with errors'))
  })
})

describe('silentProgress', () => {
  it('writes nothing to stderr', () => {
    silentProgress.header('ignored')
    silentProgress.step('ignored')
    silentProgress.done('ignored')
    silentProgress.warn('ignored')

    assert.strictEqual(stderrOutput, '')
  })
})
