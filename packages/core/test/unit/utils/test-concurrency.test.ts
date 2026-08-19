import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

// @ts-expect-error The repository's JavaScript test-runner helper has no TypeScript declarations.
import { parseTestConcurrency } from '../../../../../scripts/test-concurrency.mjs'

describe('parseTestConcurrency', () => {
  it('returns the fallback when unset or empty', () => {
    assert.strictEqual(parseTestConcurrency(undefined, 4), 4)
    assert.strictEqual(parseTestConcurrency('', 4), 4)
  })

  it('accepts a positive safe integer override', () => {
    assert.strictEqual(parseTestConcurrency('1', 4), 1)
    assert.strictEqual(parseTestConcurrency('8', 4), 8)
    assert.strictEqual(parseTestConcurrency(String(Number.MAX_SAFE_INTEGER), 4), Number.MAX_SAFE_INTEGER)
  })

  it('ignores surrounding whitespace as valid numeric input', () => {
    assert.strictEqual(parseTestConcurrency(' 2 ', 4), 2)
  })

  it('rejects zero and negatives', () => {
    assert.throws(() => parseTestConcurrency('0', 4), /Invalid NSOLID_TEST_CONCURRENCY/)
    assert.throws(() => parseTestConcurrency('-1', 4), /Invalid NSOLID_TEST_CONCURRENCY/)
  })

  it('rejects non-numeric input', () => {
    assert.throws(() => parseTestConcurrency('abc', 4), /Invalid NSOLID_TEST_CONCURRENCY/)
    assert.throws(() => parseTestConcurrency('Infinity', 4), /Invalid NSOLID_TEST_CONCURRENCY/)
    assert.throws(() => parseTestConcurrency('NaN', 4), /Invalid NSOLID_TEST_CONCURRENCY/)
  })

  it('rejects non-integer numbers', () => {
    assert.throws(() => parseTestConcurrency('2.5', 4), /Invalid NSOLID_TEST_CONCURRENCY/)
  })

  it('rejects values outside the safe-integer range', () => {
    assert.throws(() => parseTestConcurrency('9007199254740992', 4), /Invalid NSOLID_TEST_CONCURRENCY/)
  })
})
