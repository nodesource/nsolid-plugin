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
import { readFileSync, writeFileSync } from 'node:fs'
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
const { manifestDigestOf } = await import('../../../src/update/fallback-journal.js')

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
      args: ['--import', tsxLoader, childEntry, '--transaction', fixture.manifestPath, '--manifest-digest', manifestDigestOf(fixture.identity), '--result', fixture.resultPath],
      timeoutMs: 60_000,
    },
  }],
  rollbackSteps: [],
  requiresConfirmation: true,
  fallbackTransaction: fixture.identity,
  temporaryDirectories: [fixture.manifestDir],
  resultContainment: [await recordContainmentDirectoryIdentity(fixture.manifestDir)],
}

const runner = createCommandRunner()
const result = await fallbackStrategy.execute(item, {
  options: {},
  commandRunner: {
    async run (command) {
      const completion = await runner.run(command)
      const envelope = JSON.parse(readFileSync(command.args[command.args.indexOf('--result') + 1]!, 'utf8'))
      // Observe the real runner without changing its verdict or forwarding raw
      // child output. This evidence belongs to the test's isolated HOME.
      writeFileSync(path.join(fixture.home, 'command-completion.json'), JSON.stringify({
        exitCode: completion.exitCode,
        timedOut: completion.timedOut,
        treeTerminated: completion.treeTerminated,
        spawnErrorCode: completion.spawnErrorCode,
        childCode: envelope.code,
        childNonce: envelope.nonce,
      }))
      return completion
    },
  },
})
// Exactly one JSON document on stdout, mirroring the CLI's --json rendering.
console.log(JSON.stringify(result))
