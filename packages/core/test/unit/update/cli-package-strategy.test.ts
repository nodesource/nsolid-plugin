import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { cliPackageStrategy } from '../../../src/update/strategies/cli-package.js'

describe('CLI package update strategy', () => {
  it('uses the resolved version in unsupported-source manual commands', async () => {
    const item = await cliPackageStrategy.plan({
      installationId: 'cli:global',
      target: 'cli',
      ownership: 'none',
      installed: true,
      source: { kind: 'unsupported', source: '/workspace/cli.ts', reason: 'unsupported-manager' },
      version: { current: '1.0.0', latest: '1.2.3', status: 'update-available' },
    }, {
      options: {},
      commandRunner: { run: async () => ({ exitCode: 0, stdout: '', stderr: '', timedOut: false }) },
    })

    assert.deepEqual(item.manualCommands, [
      'npm install --global nsolid-plugin@1.2.3',
      'pnpm add --global nsolid-plugin@1.2.3',
      'npx -y nsolid-plugin@1.2.3 <command>',
    ])
  })
})
