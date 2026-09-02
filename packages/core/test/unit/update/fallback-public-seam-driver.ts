/**
 * Real-process driver for the fallback public-seam test. It runs the real
 * fallbackStrategy.execute() against the real `nsolid-plugin-refresh-owned`
 * child entrypoint (the repository TypeScript sources through tsx) and then
 * renders the resulting UpdateResult exactly the way the CLI does: one single
 * JSON document on stdout (packages/core/src/cli.ts prints
 * console.log(JSON.stringify(summary))) and nothing else.
 *
 * Usage: node --import tsx/esm fallback-public-seam-driver.ts '<fixture-json>'
 */

import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath, pathToFileURL } from 'node:url'
import type { FallbackTransactionIdentity, UpdatePlanItem } from '../../../src/update/types.js'

const fixture = JSON.parse(process.argv[2] ?? '{}') as {
  home: string
  manifestDir: string
  manifestPath: string
  resultPath: string
  identity: FallbackTransactionIdentity
}

// The isolated HOME must be in place before any module that resolves user
// paths (credentials, tracking) is evaluated.
process.env.HOME = fixture.home
process.env.USERPROFILE = fixture.home
delete process.env.NSOLID_ACCOUNTS_URL

const { fallbackStrategy } = await import('../../../src/update/strategies/fallback.js')
const { createCommandRunner } = await import('../../../src/update/command-runner.js')
const { recordContainmentDirectoryIdentity } = await import('../../../src/update/fallback-result-protocol.js')

const require = createRequire(import.meta.url)
// Absolute loader URL so the child does not depend on its cwd to resolve tsx.
const tsxLoader = pathToFileURL(require.resolve('tsx/esm')).href
const childEntry = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../src/update/refresh-owned-cli.ts')

const item: UpdatePlanItem = {
  installationId: fixture.identity.installationId,
  target: fixture.identity.harness,
  ownership: 'fallback',
  installed: true,
  source: { kind: 'fallback', bundleVersion: '1.0.0' },
  version: { current: '1.0.0', latest: '1.0.3', status: 'update-available' },
  steps: [{
    kind: 'command',
    description: 'refresh',
    command: {
      executable: process.execPath,
      args: ['--import', tsxLoader, childEntry, '--transaction', fixture.manifestPath, '--result', fixture.resultPath],
      timeoutMs: 60_000,
    },
  }],
  rollbackSteps: [],
  requiresConfirmation: true,
  fallbackTransaction: fixture.identity,
  temporaryDirectories: [fixture.manifestDir],
  resultContainment: [await recordContainmentDirectoryIdentity(fixture.manifestDir)],
}

const result = await fallbackStrategy.execute(item, { options: {}, commandRunner: createCommandRunner() })
// Exactly one JSON document on stdout, mirroring the CLI's --json rendering.
console.log(JSON.stringify(result))
