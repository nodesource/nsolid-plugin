import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import type { DoctorReport } from '../../../src/types.js'

function makeReport (overrides?: Partial<DoctorReport>): DoctorReport {
  return {
    healthy: true,
    credentials: { status: 'ok' },
    plugin: { status: 'ok', installed: true, label: 'nsolid-plugin@nodesource' },
    skills: { status: 'ok', installed: ['ns-skill-1', 'ns-skill-2'], missing: [] },
    mcpServers: { status: 'ok', reachable: ['nsolid-console', 'ns-benchmark'], unreachable: [] },
    errors: [],
    ...overrides,
  }
}

describe('formatDoctorReport', () => {
  let originalNoColor: string | undefined
  let originalForceColor: string | undefined

  beforeEach(() => {
    originalNoColor = process.env.NO_COLOR
    originalForceColor = process.env.FORCE_COLOR
  })

  afterEach(() => {
    if (originalNoColor === undefined) {
      delete process.env.NO_COLOR
    } else {
      process.env.NO_COLOR = originalNoColor
    }
    if (originalForceColor === undefined) {
      delete process.env.FORCE_COLOR
    } else {
      process.env.FORCE_COLOR = originalForceColor
    }
  })

  it('shows "✓ ok" on healthy report (no color)', async () => {
    const { formatDoctorReport } = await import('../../../src/utils/format.js')
    const report = makeReport()
    const out = formatDoctorReport(report, 'claude', false)

    assert.ok(out.includes('Credentials   ✓ ok'))
    assert.ok(out.includes('Skills        ✓ ok'))
    assert.ok(out.includes('MCP servers   ✓ ok'))
    assert.ok(out.includes('✓ All checks passed'))
  })

  it('shows "✗ missing" on missing credentials (no color)', async () => {
    const { formatDoctorReport } = await import('../../../src/utils/format.js')
    const report = makeReport({ credentials: { status: 'missing' }, healthy: false })
    const out = formatDoctorReport(report, 'claude', false)

    assert.ok(out.includes('Credentials   ✗ missing'))
    assert.ok(out.includes('Run installation to authenticate'))
    assert.ok(out.includes('✗ Problems found'))
  })

  it('shows "✗ expired" on expired credentials (no color)', async () => {
    const { formatDoctorReport } = await import('../../../src/utils/format.js')
    const report = makeReport({ credentials: { status: 'expired' }, healthy: false })
    const out = formatDoctorReport(report, 'claude', false)

    assert.ok(out.includes('Credentials   ✗ expired'))
    assert.ok(out.includes('Re-run installation to re-authenticate'))
  })

  it('appends the org id to the Credentials line when present (ok)', async () => {
    const { formatDoctorReport } = await import('../../../src/utils/format.js')
    const report = makeReport({ credentials: { status: 'ok', organizationId: 'org-123' } })
    const out = formatDoctorReport(report, 'claude', false)

    assert.ok(out.includes('Credentials   ✓ ok (org: org-123)'))
  })

  it('appends the org id to the Credentials line when present (expired)', async () => {
    const { formatDoctorReport } = await import('../../../src/utils/format.js')
    const report = makeReport({ credentials: { status: 'expired', organizationId: 'org-123' }, healthy: false })
    const out = formatDoctorReport(report, 'claude', false)

    assert.ok(out.includes('Credentials   ✗ expired (org: org-123)'))
  })

  it('omits the org suffix when organizationId is not present', async () => {
    const { formatDoctorReport } = await import('../../../src/utils/format.js')
    const report = makeReport({ credentials: { status: 'missing' }, healthy: false })
    const out = formatDoctorReport(report, 'claude', false)

    assert.ok(out.includes('Credentials   ✗ missing'))
    assert.ok(!out.includes('(org:'))
  })

  it('shows "✓ installed" Plugin line for an installed native plugin (no color)', async () => {
    const { formatDoctorReport } = await import('../../../src/utils/format.js')
    const report = makeReport()
    const out = formatDoctorReport(report, 'codex', false)

    assert.ok(out.includes('Plugin        ✓ installed (nsolid-plugin@nodesource)'))
  })

  it('shows "⚠ disabled" Plugin line for a disabled native plugin (no color)', async () => {
    const { formatDoctorReport } = await import('../../../src/utils/format.js')
    const report = makeReport({ plugin: { status: 'ok', installed: true, enabled: false, label: 'nsolid-plugin@nodesource' }, healthy: false })
    const out = formatDoctorReport(report, 'codex', false)

    assert.ok(out.includes('Plugin        ⚠ disabled (nsolid-plugin@nodesource)'))
    assert.ok(out.includes('Enable the plugin in your harness'))
  })

  it('shows "✗ not installed" Plugin line with install hint when plugin missing (no color)', async () => {
    const { formatDoctorReport } = await import('../../../src/utils/format.js')
    const report = makeReport({ plugin: { status: 'missing', installed: false }, healthy: false })
    const out = formatDoctorReport(report, 'codex', false)

    assert.ok(out.includes('Plugin        ✗ not installed'))
    assert.ok(out.includes('codex plugin marketplace add NodeSource/nsolid-plugin'))
  })

  it('shows the Pi install hint for a missing pi plugin', async () => {
    const { formatDoctorReport } = await import('../../../src/utils/format.js')
    const report = makeReport({ plugin: { status: 'missing', installed: false }, healthy: false })
    const out = formatDoctorReport(report, 'pi', false)

    assert.ok(out.includes('Plugin        ✗ not installed'))
    assert.ok(out.includes('pi install npm:nsolid-pi-plugin'))
  })

  it('omits the Plugin line for a non-native harness (opencode)', async () => {
    const { formatDoctorReport } = await import('../../../src/utils/format.js')
    const report = makeReport({ plugin: { status: 'n/a', installed: false } })
    const out = formatDoctorReport(report, 'opencode', false)

    assert.ok(!out.includes('Plugin'))
  })

  it('shows "⚠ partial" on partial skills (no color)', async () => {
    const { formatDoctorReport } = await import('../../../src/utils/format.js')
    const report = makeReport({
      healthy: false,
      skills: { status: 'partial', installed: ['ns-skill-1'], missing: ['ns-skill-2'] },
    })
    const out = formatDoctorReport(report, 'claude', false)

    assert.ok(out.includes('Skills        ⚠ partial (1 installed, 1 missing)'))
    assert.ok(out.includes('Re-run installation to restore skills'))
  })

  it('shows "✗ missing" on missing skills (no color)', async () => {
    const { formatDoctorReport } = await import('../../../src/utils/format.js')
    const report = makeReport({
      healthy: false,
      skills: { status: 'missing', installed: [], missing: ['ns-skill-1'] },
    })
    const out = formatDoctorReport(report, 'claude', false)

    assert.ok(out.includes('Skills        ✗ missing (1 missing)'))
    assert.ok(out.includes('Re-run installation to restore skills'))
  })

  it('shows "⚠ partial" on partial MCP servers (no color)', async () => {
    const { formatDoctorReport } = await import('../../../src/utils/format.js')
    const report = makeReport({
      healthy: false,
      mcpServers: { status: 'partial', reachable: ['nsolid-console'], unreachable: ['ns-benchmark'] },
    })
    const out = formatDoctorReport(report, 'claude', false)

    assert.ok(out.includes('MCP servers   ⚠ partial (1 reachable, 1 unreachable)'))
    assert.ok(out.includes('Check network connectivity or MCP server status'))
  })

  it('shows "✗ unreachable" on unreachable MCP servers (no color)', async () => {
    const { formatDoctorReport } = await import('../../../src/utils/format.js')
    const report = makeReport({
      healthy: false,
      mcpServers: { status: 'unreachable', reachable: [], unreachable: ['nsolid-console'] },
    })
    const out = formatDoctorReport(report, 'claude', false)

    assert.ok(out.includes('MCP servers   ✗ unreachable (1 unreachable)'))
    assert.ok(out.includes('Check network connectivity or MCP server status'))
  })

  it('shows "? unknown" on unknown skills/MCP (no color)', async () => {
    const { formatDoctorReport } = await import('../../../src/utils/format.js')
    const report = makeReport({
      healthy: false,
      skills: { status: 'unknown', installed: [], missing: [] },
      mcpServers: { status: 'unknown', reachable: [], unreachable: [] },
    })
    const out = formatDoctorReport(report, 'claude', false)

    assert.ok(out.includes('Skills        ? unknown'))
    assert.ok(out.includes('MCP servers   ? unknown'))
  })

  it('includes Pi adapter notice when harness is pi and has reachable servers', async () => {
    const { formatDoctorReport } = await import('../../../src/utils/format.js')
    const report = makeReport({
      mcpServers: { status: 'ok', reachable: ['nsolid-console', 'ns-benchmark', 'ncm'], unreachable: [] },
    })
    const out = formatDoctorReport(report, 'pi', false)

    assert.ok(out.includes('Pi needs an MCP adapter extension'))
  })

  it('does not include Pi adapter notice for claude', async () => {
    const { formatDoctorReport } = await import('../../../src/utils/format.js')
    const report = makeReport({
      mcpServers: { status: 'ok', reachable: ['nsolid-console'], unreachable: [] },
    })
    const out = formatDoctorReport(report, 'claude', false)

    assert.ok(!out.includes('Pi needs an MCP adapter extension'))
  })

  it('does not include Pi adapter notice when reachable is empty', async () => {
    const { formatDoctorReport } = await import('../../../src/utils/format.js')
    const report = makeReport({
      mcpServers: { status: 'unreachable', reachable: [], unreachable: ['nsolid-console'] },
    })
    const out = formatDoctorReport(report, 'pi', false)

    assert.ok(!out.includes('Pi needs an MCP adapter extension'))
  })

  it('contains no ANSI codes when color is false', async () => {
    const { formatDoctorReport } = await import('../../../src/utils/format.js')
    const report = makeReport()
    const out = formatDoctorReport(report, 'claude', false)

    assert.ok(!out.includes('\x1b['))
    assert.ok(!out.includes('\x1b'))
  })

  it('contains ANSI codes when color is true', async () => {
    const { formatDoctorReport } = await import('../../../src/utils/format.js')
    const report = makeReport()
    const out = formatDoctorReport(report, 'claude', true)

    assert.ok(out.includes('\x1b['))
  })

  it('lists errors in output', async () => {
    const { formatDoctorReport } = await import('../../../src/utils/format.js')
    const report = makeReport({
      healthy: false,
      errors: ['Something went wrong', 'Another error'],
    })
    const out = formatDoctorReport(report, 'claude', false)

    assert.ok(out.includes('Something went wrong'))
    assert.ok(out.includes('Another error'))
  })
})

describe('formatSwitchOrgGuidance', () => {
  it('tells a native-only plugin-owned harness to reconnect', async () => {
    const { formatSwitchOrgGuidance } = await import('../../../src/utils/format.js')
    const lines = formatSwitchOrgGuidance({
      harness: 'claude',
      harnessLabel: 'Claude Code',
      isPluginOwned: true,
      nativeInstalled: true,
      fallbackTracked: false,
    }, false)

    assert.ok(lines.some((l) => l.includes('Reconnect') && l.includes('Claude Code')))
    assert.ok(!lines.some((l) => l.includes('fallback direct install')))
  })

  it('tells a fallback-only plugin-owned harness to re-run install', async () => {
    const { formatSwitchOrgGuidance } = await import('../../../src/utils/format.js')
    const lines = formatSwitchOrgGuidance({
      harness: 'claude',
      harnessLabel: 'Claude Code',
      isPluginOwned: true,
      nativeInstalled: false,
      fallbackTracked: true,
    }, false)

    assert.ok(lines.some((l) => l.includes('fallback direct install')))
    assert.ok(lines.some((l) => l.includes('nsolid-plugin install --harness claude')))
  })

  it('reports BOTH warnings when native and fallback installs coexist', async () => {
    const { formatSwitchOrgGuidance } = await import('../../../src/utils/format.js')
    const lines = formatSwitchOrgGuidance({
      harness: 'claude',
      harnessLabel: 'Claude Code',
      isPluginOwned: true,
      nativeInstalled: true,
      fallbackTracked: true,
    }, false)

    assert.ok(lines.some((l) => l.includes('Reconnect') && l.includes('Claude Code')), 'should still tell the user to reconnect the native session')
    assert.ok(lines.some((l) => l.includes('fallback direct install')), 'should ALSO warn about the stale fallback install')
    assert.ok(lines.some((l) => l.includes('nsolid-plugin install --harness claude')))
  })

  it('falls back to a generic reconnect message when neither is detected', async () => {
    const { formatSwitchOrgGuidance } = await import('../../../src/utils/format.js')
    const lines = formatSwitchOrgGuidance({
      harness: 'claude',
      harnessLabel: 'Claude Code',
      isPluginOwned: true,
      nativeInstalled: false,
      fallbackTracked: false,
    }, false)

    assert.ok(lines.length > 0, 'should never leave the user with no guidance')
    assert.ok(lines.some((l) => l.includes('Reconnect')))
  })

  it('gives CLI-direct harnesses a plain reconnect message', async () => {
    const { formatSwitchOrgGuidance } = await import('../../../src/utils/format.js')
    const lines = formatSwitchOrgGuidance({
      harness: 'opencode',
      harnessLabel: 'OpenCode',
      isPluginOwned: false,
      nativeInstalled: false,
      fallbackTracked: false,
    }, false)

    assert.ok(lines.some((l) => l.includes('Reconnect') && l.includes('OpenCode')))
    assert.ok(!lines.some((l) => l.includes('fallback direct install')))
  })
})

describe('buildSwitchOrgOutcome', () => {
  it('treats a failed auth as a switch failure with a nonzero exit', async () => {
    const { buildSwitchOrgOutcome } = await import('../../../src/utils/format.js')
    const outcome = buildSwitchOrgOutcome({
      success: false,
      authSucceeded: false,
      errors: ['Authentication timed out. Please try again.'],
      harness: 'opencode',
      harnessLabel: 'OpenCode',
      isPluginOwned: false,
    })

    assert.strictEqual(outcome.kind, 'auth-failed')
    assert.strictEqual(outcome.exitCode, 1)
    assert.ok(outcome.errorHeader?.includes('Switch organization failed for opencode'))
    assert.ok(outcome.detail.some((l) => l.includes('Authentication timed out')))
    assert.strictEqual(outcome.warning, null)
  })

  it('treats missing auth as a switch failure even when other steps succeed', async () => {
    const { buildSwitchOrgOutcome } = await import('../../../src/utils/format.js')
    const outcome = buildSwitchOrgOutcome({
      success: true,
      authSucceeded: false,
      errors: [],
      previousOrg: 'org-original',
      harness: 'claude',
      harnessLabel: 'Claude Code',
      isPluginOwned: true,
    })

    assert.strictEqual(outcome.kind, 'auth-failed')
    assert.strictEqual(outcome.exitCode, 1, 'a bundle without auth never switches the org, so it must not exit 0')
    assert.ok(outcome.errorHeader?.includes('Switch organization failed for claude'))
    assert.match(outcome.stateLine, /\(unknown\)/, 'no org id exists to report when OAuth never ran')
  })

  it('reports a partial success (nonzero exit, org switched, retry guidance) when the post-auth config refresh fails', async () => {
    const { buildSwitchOrgOutcome } = await import('../../../src/utils/format.js')
    const outcome = buildSwitchOrgOutcome({
      success: false,
      authSucceeded: true,
      errors: ['MCP configuration failed: opencode.jsonc'],
      previousOrg: 'org-original',
      currentOrg: 'org-456',
      harness: 'opencode',
      harnessLabel: 'OpenCode',
      isPluginOwned: false,
    })

    assert.strictEqual(outcome.kind, 'partial')
    assert.strictEqual(outcome.exitCode, 1, 'incomplete refresh must still exit nonzero')
    assert.strictEqual(outcome.currentOrg, 'org-456')
    assert.strictEqual(outcome.orgChanged, true)
    assert.match(outcome.stateLine, /Now signed in to org: org-456/)
    assert.ok(outcome.warning?.includes('Organization switched to org-456'), 'must state the org switched (not that the switch failed)')
    assert.ok(outcome.warning?.includes('MCP config could not be fully refreshed'))
    assert.ok(outcome.detail.some((l) => l.includes('MCP configuration failed')))
    assert.ok(outcome.commands.some((c) => c === 'nsolid-plugin install --harness opencode'))
    assert.ok(outcome.commands.some((c) => c.includes('nsolid-plugin setup --harness opencode')))
  })

  it('words an unchanged selected org as "Still signed in to org"', async () => {
    const { buildSwitchOrgOutcome } = await import('../../../src/utils/format.js')
    const outcome = buildSwitchOrgOutcome({
      success: true,
      authSucceeded: true,
      errors: [],
      previousOrg: 'org-456',
      currentOrg: 'org-456',
      harness: 'opencode',
      harnessLabel: 'OpenCode',
      isPluginOwned: false,
    })

    assert.strictEqual(outcome.kind, 'success')
    assert.strictEqual(outcome.exitCode, 0)
    assert.strictEqual(outcome.orgChanged, false)
    assert.match(outcome.stateLine, /Still signed in to org: org-456/)
  })

  it('treats a full org change as success (exit 0) with a "Now signed in" line', async () => {
    const { buildSwitchOrgOutcome } = await import('../../../src/utils/format.js')
    const outcome = buildSwitchOrgOutcome({
      success: true,
      authSucceeded: true,
      errors: [],
      previousOrg: 'org-original',
      currentOrg: 'org-456',
      harness: 'pi',
      harnessLabel: 'Pi Agent',
      isPluginOwned: true,
    })

    assert.strictEqual(outcome.kind, 'success')
    assert.strictEqual(outcome.exitCode, 0)
    assert.strictEqual(outcome.orgChanged, true)
    assert.match(outcome.stateLine, /Now signed in to org: org-456/)
    assert.strictEqual(outcome.warning, null)
    assert.deepStrictEqual(outcome.commands, [])
  })
})

describe('supportsColor', () => {
  let originalNoColor: string | undefined
  let originalForceColor: string | undefined

  beforeEach(() => {
    originalNoColor = process.env.NO_COLOR
    originalForceColor = process.env.FORCE_COLOR
  })

  afterEach(() => {
    if (originalNoColor === undefined) {
      delete process.env.NO_COLOR
    } else {
      process.env.NO_COLOR = originalNoColor
    }
    if (originalForceColor === undefined) {
      delete process.env.FORCE_COLOR
    } else {
      process.env.FORCE_COLOR = originalForceColor
    }
  })

  it('returns false when NO_COLOR is set', async () => {
    process.env.NO_COLOR = '1'
    delete process.env.FORCE_COLOR
    const { supportsColor } = await import('../../../src/utils/format.js')
    assert.strictEqual(supportsColor(), false)
  })

  it('returns false when FORCE_COLOR is 0', async () => {
    delete process.env.NO_COLOR
    process.env.FORCE_COLOR = '0'
    const { supportsColor } = await import('../../../src/utils/format.js')
    assert.strictEqual(supportsColor(), false)
  })

  it('returns true when FORCE_COLOR is 1', async () => {
    delete process.env.NO_COLOR
    process.env.FORCE_COLOR = '1'
    const { supportsColor } = await import('../../../src/utils/format.js')
    assert.strictEqual(supportsColor(), true)
  })

  it('returns false for non-TTY stream', async () => {
    delete process.env.NO_COLOR
    delete process.env.FORCE_COLOR
    const { supportsColor } = await import('../../../src/utils/format.js')
    assert.strictEqual(supportsColor({ isTTY: false }), false)
  })

  it('returns true for TTY stream', async () => {
    delete process.env.NO_COLOR
    delete process.env.FORCE_COLOR
    const { supportsColor } = await import('../../../src/utils/format.js')
    assert.strictEqual(supportsColor({ isTTY: true }), true)
  })
})
