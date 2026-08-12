import type { DoctorReport } from '../types.js'

export const C = {
  green: (s: string) => `\x1b[32m${s}\x1b[0m`,
  yellow: (s: string) => `\x1b[33m${s}\x1b[0m`,
  red: (s: string) => `\x1b[31m${s}\x1b[0m`,
  dim: (s: string) => `\x1b[2m${s}\x1b[0m`,
}

/** Harnesses that install the plugin/package natively and get a Plugin line. */
const NATIVE_PLUGIN_HARNESSES = new Set(['claude', 'codex', 'antigravity', 'pi'])

/** Native install command shown when the plugin is missing for a harness. */
function nativeInstallHint (harness: string): string {
  switch (harness) {
    case 'claude':
      return 'claude plugin marketplace add NodeSource/nsolid-plugin && claude plugin install nsolid-plugin@nodesource'
    case 'codex':
      return 'codex plugin marketplace add NodeSource/nsolid-plugin && codex plugin add nsolid-plugin@nodesource'
    case 'antigravity':
      return 'agy plugin install https://github.com/NodeSource/nsolid-plugin.git'
    case 'pi':
      return 'pi install npm:nsolid-pi-plugin'
    default:
      return ''
  }
}

export function supportsColor (stream: { isTTY?: boolean } = process.stdout): boolean {
  if (process.env.NO_COLOR !== undefined) return false
  if (process.env.FORCE_COLOR === '0') return false
  if (process.env.FORCE_COLOR !== undefined) return true
  return stream.isTTY === true
}

function credLine (creds: DoctorReport['credentials'], color: boolean): string {
  // No hint on the 'ok' branch — telling a user to authenticate when creds are
  // valid is misleading. Hints only attach to missing/expired (actionable) states.
  const orgSuffix = creds.organizationId ? ` (org: ${creds.organizationId})` : ''
  if (creds.status === 'ok') return line('Credentials', `✓ ok${orgSuffix}`, C.green, '', color)
  if (creds.status === 'expired') return line('Credentials', `✗ expired${orgSuffix}`, C.red, 'Re-run installation to re-authenticate', color)
  return line('Credentials', '✗ missing', C.red, 'Run installation to authenticate', color)
}

function pluginLine (p: DoctorReport['plugin'], harness: string, color: boolean): string | null {
  // Non-native harnesses (e.g. opencode) have no plugin model — no line shown.
  if (!NATIVE_PLUGIN_HARNESSES.has(harness)) return null
  if (p.status === 'ok') {
    const label = p.label ? ` (${p.label})` : ''
    if (p.enabled === false) {
      return line('Plugin', `⚠ disabled${label}`, C.yellow, 'Enable the plugin in your harness', color)
    }
    return line('Plugin', `✓ installed${label}`, C.green, '', color)
  }
  return line('Plugin', '✗ not installed', C.red, nativeInstallHint(harness), color)
}

function skillsLine (s: DoctorReport['skills'], color: boolean): string {
  if (s.status === 'ok') return line('Skills', `✓ ok (${s.installed.length} installed)`, C.green, '', color)
  if (s.status === 'partial') return line('Skills', `⚠ partial (${s.installed.length} installed, ${s.missing.length} missing)`, C.yellow, 'Re-run installation to restore skills', color)
  if (s.status === 'missing') return line('Skills', `✗ missing (${s.missing.length} missing)`, C.red, 'Re-run installation to restore skills', color)
  return line('Skills', '? unknown', C.dim, '', color)
}

function mcpLine (m: DoctorReport['mcpServers'], color: boolean): string {
  if (m.status === 'ok') return line('MCP servers', `✓ ok (${m.reachable.length} reachable)`, C.green, '', color)
  if (m.status === 'partial') return line('MCP servers', `⚠ partial (${m.reachable.length} reachable, ${m.unreachable.length} unreachable)`, C.yellow, 'Check network connectivity or MCP server status', color)
  if (m.status === 'unreachable') return line('MCP servers', `✗ unreachable (${m.unreachable.length} unreachable)`, C.red, 'Check network connectivity or MCP server status', color)
  return line('MCP servers', '? unknown', C.dim, '', color)
}

function line (label: string, value: string, pick: (s: string) => string, fix: string, color: boolean): string {
  const v = color ? pick(value) : value
  const tail = fix ? `  ${color ? C.dim('— ' + fix) : '— ' + fix}` : ''
  return `${label.padEnd(13)} ${v}${tail}`
}

export function formatDoctorReport (report: DoctorReport, harness: string, color: boolean): string {
  const out: string[] = []
  const title = color ? C.dim(`NodeSource plugin health — ${harness}`) : `NodeSource plugin health — ${harness}`
  out.push(title, '─'.repeat(34))
  out.push(credLine(report.credentials, color))
  const plugin = pluginLine(report.plugin, harness, color)
  if (plugin) out.push(plugin)
  out.push(skillsLine(report.skills, color))
  out.push(mcpLine(report.mcpServers, color))

  if (harness === 'pi' && report.mcpServers.status !== 'unknown' && report.mcpServers.reachable.length > 0) {
    const note = 'ℹ Pi needs an MCP adapter extension to use these servers — run: pi install npm:pi-mcp-adapter'
    out.push(color ? C.yellow('  ' + note) : '  ' + note)
  }

  for (const e of report.errors) out.push((color ? C.yellow('  • ' + e) : '  • ' + e))
  out.push('')
  if (report.healthy) out.push(color ? C.green('✓ All checks passed') : '✓ All checks passed')
  else out.push(color ? C.red('✗ Problems found') : '✗ Problems found')
  return out.join('\n')
}

export interface SwitchOrgGuidanceInput {
  /** Raw harness id, e.g. "claude" — used to build the `--harness` value in printed commands. */
  harness: string;
  /** Display label for the harness, e.g. "Claude Code". */
  harnessLabel: string;
  /** True for claude/codex/antigravity — harnesses with a native plugin model. */
  isPluginOwned: boolean;
  /** Result of adapter.detectNativePlugin()?.installed for this harness. */
  nativeInstalled: boolean;
  /**
   * True when this harness has an on-disk MCP config written by the fallback
   * direct installer (nsolid-plugin install --harness <harness>), tracked via
   * listTrackedMcps(harness). Independent of nativeInstalled: a machine can
   * have BOTH a native plugin install and a leftover/parallel fallback
   * install at once, and Claude Code (or another harness) may route real
   * tool calls through whichever one is actually connected — so both must be
   * checked and reported on independently, not as an either/or.
   */
  fallbackTracked: boolean;
}

/**
 * Follow-up guidance printed after `switch-org` completes. Native-plugin
 * installs read credentials live on reconnect, so they only need a
 * reconnect/restart reminder. Fallback direct installs bake a resolved
 * token into the harness's on-disk MCP config at `install()` time, so they
 * stay stale until `install --harness <harness>` re-runs — regardless of
 * whether a native plugin is ALSO installed for the same harness.
 */
export function formatSwitchOrgGuidance (input: SwitchOrgGuidanceInput, color: boolean): string[] {
  const { harness, harnessLabel, isPluginOwned, nativeInstalled, fallbackTracked } = input
  const dim = (s: string) => color ? C.dim(s) : s
  const yellow = (s: string) => color ? C.yellow(s) : s
  const lines: string[] = []

  if (!isPluginOwned) {
    lines.push(`  ${dim('Reconnect:')} restart/reconnect ${harnessLabel} so it reloads the refreshed MCP config from disk.`)
    return lines
  }

  if (nativeInstalled) {
    lines.push(`  ${dim('Reconnect:')} restart/reconnect your ${harnessLabel} MCP session to pick up the new org.`)
  }

  if (fallbackTracked) {
    lines.push(`  ${yellow(`⚠ ${harnessLabel} also has a fallback direct install with a stale token baked in.`)}`)
    lines.push(`  ${yellow('  Run: nsolid-plugin install --harness ' + harness)} to refresh it with the new org's token, then reconnect it too.`)
  }

  if (!nativeInstalled && !fallbackTracked) {
    lines.push(`  ${dim('Reconnect:')} restart/reconnect ${harnessLabel} so it can pick up the refreshed credentials.`)
  }

  return lines
}

export interface SwitchOrgOutcomeInput {
  /** result.success — false when any step failed. */
  success: boolean
  /** result.authSucceeded — the org-switch signal, independent of `success`. */
  authSucceeded: boolean
  /** result.errors — non-empty when a step failed. */
  errors: string[]
  /** Org id signed in BEFORE the switch (undefined when none). */
  previousOrg?: string | null
  /** Org id signed in AFTER the switch (undefined when unknown). */
  currentOrg?: string | null
  harness: string
  harnessLabel: string
  isPluginOwned: boolean
}

export type SwitchOrgOutcomeKind = 'auth-failed' | 'partial' | 'success'

/**
 * Structured result of the `switch-org` orchestration, so the CLI handler and
 * its exit-code/output semantics are unit-testable without spawning a browser
 * or the CLI process. Deliberately separates an auth failure (the switch did
 * not happen) from a partial success (the org DID switch, but the selected
 * harness's direct config refresh failed afterward — credentials are live and
 * MUST NOT be rolled back).
 */
export interface SwitchOrgOutcome {
  kind: SwitchOrgOutcomeKind
  /** 1 for both auth-failure and partial (incomplete refresh); 0 only on full success. */
  exitCode: 0 | 1
  currentOrg: string
  orgChanged: boolean
  /** "Now signed in to org: X" / "Still signed in to org: X" (colorized green by caller). */
  stateLine: string
  /** Red header shown only when auth itself failed. */
  errorHeader: string | null
  /** Yellow warning shown only on partial success (config refresh incomplete). */
  warning: string | null
  /** Plain error detail lines (from result.errors). */
  detail: string[]
  /** Dim retry commands to print verbatim. */
  commands: string[]
}

export function buildSwitchOrgOutcome (input: SwitchOrgOutcomeInput): SwitchOrgOutcome {
  const { success, authSucceeded, errors, previousOrg, currentOrg, harness, harnessLabel, isPluginOwned } = input
  const org = currentOrg ?? '(unknown)'
  const orgChanged = currentOrg !== previousOrg
  const stateLine = `${orgChanged ? '✓ Now signed in to org' : '✓ Still signed in to org'}: ${org}`

  if (!success && !authSucceeded) {
    // Auth itself failed — the org was not switched.
    return {
      kind: 'auth-failed',
      exitCode: 1,
      currentOrg: org,
      orgChanged,
      stateLine,
      errorHeader: `✗ Switch organization failed for ${harness}:`,
      warning: null,
      detail: errors.map((e) => `  - ${e}`),
      commands: [],
    }
  }

  if (!success) {
    // Org switched (credentials live on disk) but the harness's direct MCP
    // config could not be refreshed. Partial success: report it accurately,
    // show the active org + retry command, and still exit nonzero.
    const commands = [`nsolid-plugin install --harness ${harness}`]
    if (!isPluginOwned) commands.push(`(or re-run: nsolid-plugin setup --harness ${harness})`)
    return {
      kind: 'partial',
      exitCode: 1,
      currentOrg: org,
      orgChanged,
      stateLine,
      errorHeader: null,
      warning: `! Organization switched to ${org}, but ${harnessLabel} MCP config could not be fully refreshed.`,
      detail: errors.map((e) => `  - ${e}`),
      commands,
    }
  }

  // Full success. Caller still appends formatSwitchOrgGuidance / the
  // "other direct-config harnesses" note.
  return {
    kind: 'success',
    exitCode: 0,
    currentOrg: org,
    orgChanged,
    stateLine,
    errorHeader: null,
    warning: null,
    detail: [],
    commands: [],
  }
}
