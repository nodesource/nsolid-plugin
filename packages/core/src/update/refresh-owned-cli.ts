#!/usr/bin/env node

import path from 'node:path'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { refreshOwnedInstallation } from './fallback-transaction.js'
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
  console.error(result.error?.message ?? 'Owned refresh failed')
  if (result.rollbackAttempted) console.error(`rollback: ${result.rollbackSucceeded ? 'succeeded' : 'failed'}`)
  else console.error('rollback: not-attempted')
  process.exit(result.rollbackAttempted && result.rollbackSucceeded === false ? 2 : 1)
}
