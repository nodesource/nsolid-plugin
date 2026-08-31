import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fallbackStrategy } from '../../../src/update/strategies/fallback.js'
import type { UpdatePlanItem } from '../../../src/update/types.js'

function item (): UpdatePlanItem {
  return {
    installationId: 'opencode:fallback',
    target: 'opencode',
    ownership: 'fallback',
    installed: true,
    source: { kind: 'fallback', bundleVersion: '1.0.0', executor: 'npm-exec' },
    version: { current: '1.0.0', latest: '1.0.1', status: 'update-available' },
    steps: [{ kind: 'command', description: 'refresh', command: { executable: 'npm', args: ['exec'], cwd: tmpdir(), timeoutMs: 1000 } }],
    rollbackSteps: [],
    requiresConfirmation: true,
  }
}

describe('fallback update strategy', () => {
  it('uses a private temporary cwd and propagates the child rollback result', async () => {
    let observedCwd = ''
    const result = await fallbackStrategy.execute(item(), {
      options: {},
      commandRunner: {
        run: async (command) => {
          observedCwd = command.cwd ?? ''
          assert.notEqual(observedCwd, tmpdir())
          // POSIX exposes the restrictive mode bits that the implementation
          // applies. Windows filesystems do not expose chmod(0700) through
          // stat(), so verify the private temp location there instead.
          if (process.platform !== 'win32') {
            assert.equal(statSync(observedCwd).mode & 0o777, 0o700)
          } else {
            assert.equal(path.dirname(observedCwd), path.resolve(tmpdir()))
          }
          return { exitCode: 1, stdout: '', stderr: 'refresh failed\nrollback: succeeded\n', timedOut: false }
        },
      },
    })

    assert.equal(result.status, 'failed')
    assert.deepEqual(result.rollback, { attempted: true, succeeded: true })
    assert.equal(existsSync(path.resolve(observedCwd)), false)
  })

  it('removes only the recorded manifest directory, never a path derived from command args', async () => {
    const recorded = mkdtempSync(path.join(tmpdir(), 'nsolid-plugin-recorded-'))
    const foreign = mkdtempSync(path.join(tmpdir(), 'nsolid-plugin-foreign-'))
    // The command references a foreign directory that this process did not
    // create; only the recorded temporary directory may be removed.
    const candidate = {
      ...item(),
      steps: [{ kind: 'command' as const, description: 'refresh', command: { executable: 'npm', args: ['--transaction', path.join(foreign, 'transaction.json')], cwd: tmpdir(), timeoutMs: 1000 } }],
      temporaryDirectories: [recorded],
    }

    const result = await fallbackStrategy.execute(candidate, {
      options: {},
      commandRunner: { run: async () => ({ exitCode: 1, stdout: '', stderr: 'refresh failed\n', timedOut: false, treeTerminated: true }) },
    })

    assert.equal(result.status, 'failed')
    assert.equal(existsSync(recorded), false)
    assert.equal(existsSync(foreign), true, 'a directory not created by this process must never be deleted')
  })

  it('reports a missing package executor as unsupported instead of failed planning', async () => {
    const previousPath = process.env.PATH
    const previousHome = process.env.HOME
    const previousUserProfile = process.env.USERPROFILE
    const home = mkdtempSync(path.join(tmpdir(), 'nsolid-plugin-fallback-plan-'))
    const skillPath = path.join(home, '.agents', 'skills', 'tracked')
    const trackingPath = path.join(home, '.agents', '.nodesource-installed.json')
    mkdirSync(skillPath, { recursive: true })
    writeFileSync(trackingPath, JSON.stringify({
      version: '1.0.0',
      installedAt: new Date().toISOString(),
      harness: 'opencode',
      skills: [{ name: 'tracked', path: skillPath, paths: { opencode: skillPath }, installedAt: new Date().toISOString(), harnesses: ['opencode'] }],
      mcpServers: [],
    }))
    process.env.PATH = ''
    process.env.HOME = home
    process.env.USERPROFILE = home
    try {
      const planned = await fallbackStrategy.plan({
        ...item(),
        source: { kind: 'fallback', bundleVersion: '1.0.0' },
        metadata: { trackedSkills: [{ name: 'tracked', path: skillPath }] },
      }, { options: {}, commandRunner: { run: async () => ({ exitCode: 0, stdout: '', stderr: '', timedOut: false }) } })
      assert.equal(planned.planningError, undefined)
      assert.equal(planned.source.kind, 'unsupported')
      assert.equal(planned.manualCommands?.length, 2)
      assert.ok(planned.manualCommands?.every((command) => command.includes(' update --harness opencode --yes') && !command.includes(' --transaction ')))
    } finally {
      if (previousPath === undefined) delete process.env.PATH
      else process.env.PATH = previousPath
      if (previousHome === undefined) delete process.env.HOME
      else process.env.HOME = previousHome
      if (previousUserProfile === undefined) delete process.env.USERPROFILE
      else process.env.USERPROFILE = previousUserProfile
      rmSync(home, { recursive: true, force: true })
    }
  })
})
