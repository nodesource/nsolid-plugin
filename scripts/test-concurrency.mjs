#!/usr/bin/env node
/**
 * Validate the `NSOLID_TEST_CONCURRENCY` override used by scripts/run-tests.mjs.
 *
 * Kept as a pure, separately-importable module so it can be unit-tested
 * without recursively spawning the test runner it feeds.
 *
 * @param {string | undefined} raw - The env value (undefined when unset).
 * @param {number} fallback - The default concurrency to return when unset/empty.
 * @returns {number} A validated positive safe-integer concurrency.
 * @throws {RangeError} When `raw` is present but not a finite positive safe integer.
 */
export function parseTestConcurrency (raw, fallback) {
  if (raw === undefined || raw === '') return fallback
  const value = Number(raw)
  if (typeof value !== 'number' || !Number.isFinite(value) || !Number.isSafeInteger(value) || value <= 0) {
    throw new RangeError(
      `Invalid NSOLID_TEST_CONCURRENCY value: "${raw}" (must be a finite positive safe integer).`
    )
  }
  return value
}
