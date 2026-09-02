import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { publicPlanSteps } from '../../../src/update/plan-projection.js'
import { resultFromPlan } from '../../../src/update/strategies/common.js'
import type { UpdatePlanItem, UpdatePlanStep } from '../../../src/update/types.js'

const tempDir = tmpdir()

function planItem (overrides: Partial<UpdatePlanItem> = {}): UpdatePlanItem {
  return {
    installationId: 'opencode:fallback',
    target: 'opencode',
    ownership: 'fallback',
    installed: true,
    source: { kind: 'fallback', bundleVersion: '1.0.0' },
    version: { current: '1.0.0', latest: '1.0.1', status: 'update-available' },
    steps: [],
    rollbackSteps: [],
    requiresConfirmation: true,
    ...overrides,
  }
}

describe('public plan step projection', () => {
  it('projects a command step without environment, working directory, spawn identity, or timeout', () => {
    const steps: UpdatePlanStep[] = [{
      kind: 'command',
      description: 'refresh',
      command: {
        executable: 'npm',
        executableIdentity: { kind: 'node', executable: '/usr/bin/node', entrypoint: '/usr/lib/npm.js' },
        args: ['exec', '--yes'],
        cwd: path.join(tempDir, 'nsolid-plugin-update-x'),
        env: { NPM_CONFIG_USERCONFIG: path.join(tempDir, 'ws', '.npmrc') },
        timeoutMs: 120_000,
      },
    }]

    assert.deepEqual(publicPlanSteps(steps), [{
      kind: 'command',
      description: 'refresh',
      executable: 'npm',
      args: ['exec', '--yes'],
    }])
  })

  it('redacts transient temporary paths inside command arguments and filesystem paths', () => {
    const manifestPath = path.join(tempDir, 'nsolid-plugin-manifest-x', 'transaction.json')
    const tarballPath = path.join(tempDir, 'nsolid-plugin-download-x', 'nsolid-plugin-1.0.1.tgz')
    const steps: UpdatePlanStep[] = [
      {
        kind: 'command',
        description: 'refresh',
        command: { executable: 'npm', args: ['exec', '--yes', `--package=${tarballPath}`, '--', 'nsolid-plugin-refresh-owned', '--transaction', manifestPath], timeoutMs: 1000 },
      },
      {
        kind: 'filesystem',
        description: 'back up',
        operation: 'backup',
        paths: [path.join(tempDir, 'nsolid-plugin-backup-x', 'skill.md'), '/home/user/.config/opencode/skills/kept'],
      },
    ]

    const projected = publicPlanSteps(steps)
    const command = projected[0]
    assert.ok(command?.kind === 'command')
    assert.deepEqual(command.args, [
      'exec', '--yes', `--package=${path.join('<temp>', 'nsolid-plugin-1.0.1.tgz')}`,
      '--', 'nsolid-plugin-refresh-owned', '--transaction', path.join('<temp>', 'transaction.json'),
    ])
    const filesystem = projected[1]
    assert.ok(filesystem?.kind === 'filesystem')
    assert.deepEqual(filesystem.paths, [path.join('<temp>', 'skill.md'), '/home/user/.config/opencode/skills/kept'])
  })

  it('projects validation steps verbatim', () => {
    const steps: UpdatePlanStep[] = [{
      kind: 'validation',
      description: 'postconditions',
      checks: ['tracked skills match new bundle'],
    }]
    assert.deepEqual(publicPlanSteps(steps), [{
      kind: 'validation',
      description: 'postconditions',
      checks: ['tracked skills match new bundle'],
    }])
  })
})

describe('structured result plan data', () => {
  it('carries the projected technical plan: target, steps, changes, and manual commands', () => {
    const steps: UpdatePlanStep[] = [
      { kind: 'filesystem', description: 'back up', operation: 'backup', paths: ['/home/user/.config/opencode/skills/kept'] },
      { kind: 'command', description: 'refresh', command: { executable: 'npm', args: ['exec'], timeoutMs: 1000 } },
    ]
    const item = planItem({
      steps,
      manualCommands: ['nsolid-plugin install --harness opencode'],
      changes: { skillsAdded: ['new'], skillsRemoved: ['old'], skillsUpdated: 1, mcpAdded: [], mcpRemoved: [], mcpUpdated: 0 },
    })

    const result = resultFromPlan(item, 'updated', { resultingVersion: '1.0.1' })
    assert.equal(result.target, 'opencode')
    assert.equal(result.steps?.length, 2)
    assert.ok(result.steps?.every((step) => step.kind !== 'command' || !('env' in step || 'cwd' in step || 'executableIdentity' in step)))
    assert.deepEqual(result.changes, item.changes)
    assert.deepEqual(result.manualCommands, ['nsolid-plugin install --harness opencode'])
  })

  it('keeps the serialized result a single stable JSON document with the plan embedded', () => {
    const item = planItem({
      steps: [{ kind: 'command', description: 'refresh', command: { executable: 'npm', args: ['exec', '--yes', `--package=${path.join(tempDir, 'x.tgz')}`], timeoutMs: 1000 } }],
    })
    const result = resultFromPlan(item, 'skipped', { error: { code: 'CONFIRMATION_REQUIRED', message: 'not approved' } })
    const serialized = JSON.stringify(result)
    const parsed = JSON.parse(serialized) as UpdatePlanItem
    assert.deepEqual(parsed, JSON.parse(JSON.stringify(result)))
    const step = (result.steps ?? [])[0]
    assert.ok(step?.kind === 'command')
    assert.ok(!JSON.stringify(parsed).includes(tempDir), 'no transient temporary path may leak into the structured output')
  })
})
