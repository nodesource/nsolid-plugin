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

  it('uses the shared complete guidance for Volta and never emits placeholders', async () => {
    const context = {
      options: {},
      commandRunner: { run: async () => ({ exitCode: 0, stdout: '', stderr: '', timedOut: false }) },
    }
    const volta = await cliPackageStrategy.plan({
      installationId: 'cli:global',
      target: 'cli',
      ownership: 'none',
      installed: true,
      source: { kind: 'unsupported', source: '/home/test/.volta/bin/nsolid-plugin', reason: 'unsupported-manager' },
      version: { latest: '1.2.3', status: 'unknown' },
    }, context)
    assert.deepEqual(volta.manualCommands, [
      'npm install --global nsolid-plugin@1.2.3',
      'pnpm add --global nsolid-plugin@1.2.3',
      'npx -y nsolid-plugin@1.2.3 <command>',
      'volta install nsolid-plugin@1.2.3',
    ])

    const unresolved = await cliPackageStrategy.plan({
      installationId: 'cli:global',
      target: 'cli',
      ownership: 'none',
      installed: true,
      source: { kind: 'unsupported', source: '/workspace/cli.ts', reason: 'unsupported-manager' },
      version: { status: 'unknown' },
    }, context)
    assert.deepEqual(unresolved.manualCommands, [])
  })
})
