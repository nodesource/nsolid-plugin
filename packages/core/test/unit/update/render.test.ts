import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  captureRender,
  printUpdateSummary,
  printUpdatePlan,
  shouldDisplayUpdatePlan,
  uniqueCommands,
} from '../../../src/update/render.js'
import type { UpdatePlan, UpdatePlanItem, UpdateResult, UpdateSummary } from '../../../src/update/types.js'

/** Direct unit coverage of the dedupe helper used by the summary renderer. */
describe('uniqueCommands', () => {
  it('removes only exactly identical commands and preserves order', () => {
    assert.deepEqual(uniqueCommands(['a', 'a', 'b', 'a', 'c']), ['a', 'b', 'c'])
    assert.deepEqual(uniqueCommands([]), [])
  })
})

function planItem (overrides: Partial<UpdatePlanItem> = {}): UpdatePlanItem {
  return {
    installationId: 'cli:global',
    target: 'cli',
    ownership: 'global-package',
    installed: true,
    source: { kind: 'global-package', packageManager: 'npm', packageName: 'nsolid-plugin' },
    version: { status: 'unknown' },
    steps: [],
    rollbackSteps: [],
    requiresConfirmation: false,
    ...overrides,
  }
}

function result (overrides: Partial<UpdateResult> = {}): UpdateResult {
  return {
    installationId: 'cli:global',
    target: 'cli',
    ownership: 'global-package',
    status: 'current',
    changed: false,
    ...overrides,
  }
}

function summary (results: UpdateResult[]): UpdateSummary {
  return { checkOnly: false, results, counts: {} as UpdateSummary['counts'], success: false, exitCode: 2 }
}

describe('update plan display decision', () => {
  const unknownMutablePlan: UpdatePlan = {
    checkOnly: false,
    items: [planItem({ version: { status: 'unknown', latest: '1.0.4' }, requiresConfirmation: true })],
  }

  it('shows the plan before the prompt for a mutable item with an unknown current version', () => {
    assert.equal(shouldDisplayUpdatePlan(unknownMutablePlan, { json: false, check: false, willConfirm: true }), true)
  })

  it('decides by requiresConfirmation, not only by update-available status', () => {
    assert.equal(unknownMutablePlan.items[0]?.version.status, 'unknown')
    assert.equal(unknownMutablePlan.items[0]?.requiresConfirmation, true)
    assert.equal(shouldDisplayUpdatePlan(unknownMutablePlan, { json: false, check: false, willConfirm: true }), true)
  })

  it('still shows the plan for a plain update-available item', () => {
    const plan: UpdatePlan = {
      checkOnly: false,
      items: [planItem({ version: { current: '1.0.3', latest: '1.0.4', status: 'update-available' }, requiresConfirmation: true })],
    }
    assert.equal(shouldDisplayUpdatePlan(plan, { json: false, check: false, willConfirm: true }), true)
  })

  it('stays quiet for an interactive run with nothing to confirm', () => {
    const plan: UpdatePlan = { checkOnly: false, items: [planItem({ version: { status: 'current' } })] }
    assert.equal(shouldDisplayUpdatePlan(plan, { json: false, check: false, willConfirm: true }), false)
  })

  it('stays quiet for approved --yes runs', () => {
    assert.equal(shouldDisplayUpdatePlan(unknownMutablePlan, { json: false, check: false, willConfirm: false }), false)
  })

  it('never contaminates --json output', () => {
    assert.equal(shouldDisplayUpdatePlan(unknownMutablePlan, { json: true, check: false, willConfirm: true }), false)
  })

  it('always renders in --check mode', () => {
    assert.equal(shouldDisplayUpdatePlan(unknownMutablePlan, { json: false, check: true, willConfirm: false }), true)
    assert.equal(shouldDisplayUpdatePlan(unknownMutablePlan, { json: true, check: true, willConfirm: false }), false, 'json beats check')
  })
})

describe('update summary rendering', () => {
  it('prints every exact-version recovery command for an unsupported CLI launch', () => {
    const text = captureRender((output) => printUpdateSummary(summary([result({
      status: 'unsupported',
      manualCommands: [
        'npm install --global nsolid-plugin@90.0.2',
        'pnpm add --global nsolid-plugin@90.0.2',
        'npx -y nsolid-plugin@90.0.2 <command>',
        'volta install nsolid-plugin@90.0.2',
      ],
    })]), false, output))

    for (const command of ['npm install --global nsolid-plugin@90.0.2', 'pnpm add --global nsolid-plugin@90.0.2', 'npx -y nsolid-plugin@90.0.2 <command>', 'volta install nsolid-plugin@90.0.2']) {
      assert.ok(text.includes(`→ ${command}`), `${command} must be printed in full:\n${text}`)
    }
    assert.ok(!text.includes('(+'), 'no truncation marker may appear')
  })

  it('deduplicates only exactly identical commands and preserves the deterministic order', () => {
    const text = captureRender((output) => printUpdateSummary(summary([result({
      status: 'unsupported',
      manualCommands: [
        'npm install --global nsolid-plugin@1.0.4',
        'npm install --global nsolid-plugin@1.0.4',
        'pnpm add --global nsolid-plugin@1.0.4',
      ],
    })]), false, output))

    assert.equal(text.split('npm install --global nsolid-plugin@1.0.4').length - 1, 1, 'an identical duplicate is printed once')
    assert.ok(text.indexOf('npm install') < text.indexOf('pnpm add'), 'order is preserved')
  })

  it('prints installable guidance under the not-installed message', () => {
    const text = captureRender((output) => printUpdateSummary(summary([result({
      installationId: 'pi:none',
      target: 'pi',
      ownership: 'none',
      status: 'not-installed',
      manualCommands: ['pi install npm:nsolid-pi-plugin', 'nsolid-plugin setup --harness pi'],
    })]), false, output))

    assert.ok(text.includes('pi:none — not installed'), `the not-installed message must stay:\n${text}`)
    assert.ok(text.includes('→ pi install npm:nsolid-pi-plugin'))
    assert.ok(text.includes('→ nsolid-plugin setup --harness pi'))
  })
})

describe('update plan rendering', () => {
  it('renders the mutable unknown-version item with its approval-relevant details', () => {
    const text = captureRender((output) => printUpdatePlan({
      checkOnly: false,
      items: [planItem({
        installationId: 'cli:global',
        version: { status: 'unknown', latest: '1.0.4' },
        requiresConfirmation: true,
        manualCommands: ['npm install --global nsolid-plugin@1.0.4'],
      })],
    }, false, false, output))

    assert.ok(text.includes('Updates available:'))
    assert.ok(text.includes('cli:global — version unknown'))
    assert.ok(text.includes('→ npm install --global nsolid-plugin@1.0.4'))
  })
})
