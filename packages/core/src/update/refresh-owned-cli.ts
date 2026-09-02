#!/usr/bin/env node

import path from 'node:path'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { refreshOwnedInstallation } from './fallback-transaction.js'
import { writeFallbackChildResult } from './fallback-result-protocol.js'
import { resolvePackageRoot } from './version.js'
import type { FallbackTransactionIdentity } from './types.js'
import { HARNESS_VALUES } from '../types.js'

const args = process.argv.slice(2)
const transactionIndex = args.indexOf('--transaction')
const transactionPath = transactionIndex >= 0 ? args[transactionIndex + 1] : undefined
if (!transactionPath) {
  console.error('nsolid-plugin-refresh-owned requires --transaction <manifest>')
  process.exit(2)
}
// Optional structured result path: newer parents plan it inside their private
// workspace; older parents never pass it and the envelope is skipped safely.
const resultIndex = args.indexOf('--result')
const resultPath = resultIndex >= 0 ? args[resultIndex + 1] : undefined

let transaction: FallbackTransactionIdentity
try {
  transaction = JSON.parse(await readFile(transactionPath, 'utf8')) as FallbackTransactionIdentity
} catch {
  console.error('Fallback transaction manifest could not be read')
  process.exit(2)
}
const harness = transaction.harness
if (!HARNESS_VALUES.includes(harness)) {
  console.error('Fallback transaction manifest has an unsupported harness')
  process.exit(2)
}

let result
try {
  const sourceRoot = resolvePackageRoot(path.dirname(fileURLToPath(import.meta.url)))
  result = await refreshOwnedInstallation({
    harness,
    bundlePath: path.join(sourceRoot, 'bundle.json'),
    skillsSource: sourceRoot,
    transaction,
  })
} catch {
  console.error('Owned refresh failed before mutation')
  console.error('rollback: not-attempted')
  process.exit(1)
}
if (!result.success) {
  // Publish the structured, nonce-bound envelope before the legacy human
  // output so the parent can surface an allowlisted code without trusting
  // this process's stdout/stderr. The envelope carries no free-form text.
  if (resultPath && transaction.nonce) {
    const rollback = result.rollbackAttempted === true
      ? { attempted: true, succeeded: result.rollbackSucceeded === true }
      : { attempted: false }
    await writeFallbackChildResult(resultPath, transaction.nonce, result.error?.code ?? '', rollback)
  }
  console.error(result.error?.message ?? 'Owned refresh failed')
  if (result.rollbackAttempted) console.error(`rollback: ${result.rollbackSucceeded ? 'succeeded' : 'failed'}`)
  else console.error('rollback: not-attempted')
  process.exit(result.rollbackAttempted && result.rollbackSucceeded === false ? 2 : 1)
}
