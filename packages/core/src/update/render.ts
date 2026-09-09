import type { UpdatePlan, UpdatePlanItem, UpdateSummary } from './types.js'
import { C } from '../utils/format.js'

export interface UpdatePlanDisplayOptions {
  /** Machine-readable run: the plan never pollutes stdout. */
  json: boolean
  /** Read-only check: always render the plan. */
  check: boolean
  /** Interactive run without --yes: the plan precedes the confirmation prompt. */
  willConfirm: boolean
}

/**
 * Decide whether the human-readable update plan is rendered. The plan must be
 * visible before every interactive confirmation — including items whose
 * version is unknown, which are mutable (requiresConfirmation) without ever
 * carrying an update-available status — while --json runs and pre-approved
 * (--yes) runs stay quiet.
 */
export function shouldDisplayUpdatePlan (plan: UpdatePlan, options: UpdatePlanDisplayOptions): boolean {
  if (options.json) return false
  if (options.check) return true
  if (!options.willConfirm) return false
  return plan.items.some((item) => item.version.status === 'update-available' || item.requiresConfirmation)
}

/**
 * Deterministic order with only exactly identical commands collapsed: manual
 * commands are separate recovery paths (npm, pnpm, npx, Volta), never
 * variants of one another.
 */
export function uniqueCommands (commands: readonly string[]): string[] {
  return [...new Set(commands)]
}

export function humanVersionStatus (item: UpdatePlanItem): string {
  if (item.source.kind === 'unsupported') return 'manual update required'
  switch (item.version.status) {
    case 'update-available': return 'update available'
    case 'newer-than-registry': return 'up to date'
    case 'current': return 'up to date'
    case 'unknown': return 'version unknown'
  }
}

function formatChangeNames (names: readonly string[]): string {
  if (names.length <= 3) return names.join(', ')
  return `${names.slice(0, 3).join(', ')}, … (+${names.length - 3} more)`
}

function formatChanges (changes: NonNullable<UpdatePlanItem['changes']>): string {
  const parts: string[] = []
  const noun = (count: number, singular: string, plural: string) => count === 1 ? singular : plural
  if (changes.skillsAdded.length > 0) parts.push(`+${changes.skillsAdded.length} ${noun(changes.skillsAdded.length, 'skill', 'skills')} (${formatChangeNames(changes.skillsAdded)})`)
  if (changes.skillsRemoved.length > 0) parts.push(`−${changes.skillsRemoved.length} ${noun(changes.skillsRemoved.length, 'skill', 'skills')} (${formatChangeNames(changes.skillsRemoved)})`)
  if (changes.skillsUpdated > 0) parts.push(`${changes.skillsUpdated} ${noun(changes.skillsUpdated, 'skill', 'skills')} refreshed`)
  if (changes.mcpAdded.length > 0) parts.push(`+${changes.mcpAdded.length} MCP server${changes.mcpAdded.length === 1 ? '' : 's'} (${formatChangeNames(changes.mcpAdded)})`)
  if (changes.mcpRemoved.length > 0) parts.push(`−${changes.mcpRemoved.length} MCP server${changes.mcpRemoved.length === 1 ? '' : 's'} (${formatChangeNames(changes.mcpRemoved)})`)
  if (changes.mcpUpdated > 0) parts.push(`${changes.mcpUpdated} MCP server${changes.mcpUpdated === 1 ? '' : 's'} reconciled`)
  return parts.join(', ')
}

function formatCommand (executable: string, args: readonly string[]): string {
  return [executable, ...args].map((value) => /[\s"']/.test(value) ? JSON.stringify(value) : value).join(' ')
}

export function printUpdatePlan (plan: UpdatePlan, color: boolean, verbose: boolean, output: NodeJS.WritableStream = process.stderr): void {
  if (plan.items.length === 0) {
    output.write('No installations detected.\n')
    return
  }
  output.write(plan.checkOnly ? 'Update check:\n' : 'Updates available:\n')
  for (const item of plan.items) printUpdatePlanItem(item, color, verbose, output)
}

export function printUpdatePlanItem (item: UpdatePlanItem, color: boolean, verbose: boolean, output: NodeJS.WritableStream): void {
  const paint = (value: string) => color ? C.dim(value) : value
  if (item.planningError) {
    output.write(`  ✗ ${item.installationId} — ${item.planningError.message}\n`)
    return
  }
  output.write(`  ${item.installationId} — ${humanVersionStatus(item)}`)
  if (item.version.current && item.version.latest && item.version.status !== 'current') {
    if (item.version.status === 'newer-than-registry') output.write(` (${item.version.current}; registry has ${item.version.latest})`)
    else output.write(` (${item.version.current} → ${item.version.latest})`)
  } else if (item.version.current) output.write(` (${item.version.current})`)
  else if (item.version.latest) output.write(` (latest: ${item.version.latest})`)
  output.write('\n')
  if (item.changes) {
    const changeText = formatChanges(item.changes)
    if (changeText) output.write(`    ${paint('changes:')} ${changeText}\n`)
  }
  for (const command of item.manualCommands ?? []) output.write(`    → ${command}\n`)
  if (!verbose && item.steps.length > 0) {
    output.write(`    ${paint('(run with --verbose to see the full technical plan)')}\n`)
    return
  }
  for (const step of item.steps) {
    if (step.kind === 'command') output.write(`    ${paint('run:')} ${formatCommand(step.command.executable, step.command.args)}\n`)
    if (step.kind === 'filesystem') output.write(`    ${paint(`${step.operation}:`)} ${formatPlanPaths(step.paths)}\n`)
    if (step.kind === 'validation') output.write(`    ${paint('check:')} ${step.checks.join('; ')}\n`)
  }
  if (item.rollbackSteps.length > 0) {
    output.write(`    ${paint('rollback:')}\n`)
    for (const step of item.rollbackSteps) {
      if (step.kind === 'command') output.write(`      ${paint('run:')} ${formatCommand(step.command.executable, step.command.args)}\n`)
      if (step.kind === 'filesystem') output.write(`      ${paint(`${step.operation}:`)} ${formatPlanPaths(step.paths)}\n`)
      if (step.kind === 'validation') output.write(`      ${paint('check:')} ${step.checks.join('; ')}\n`)
    }
  }
}

/**
 * Human-readable plan rendering caps long path lists: the JSON output stays
 * complete, but a fallback plan must not print every tracked skill path three
 * times on stderr.
 */
function formatPlanPaths (paths: readonly string[], limit = 3): string {
  if (paths.length <= limit) return paths.join(', ')
  const remaining = paths.length - limit
  const noun = remaining === 1 ? 'path' : 'paths'
  return `${paths.slice(0, limit).join(', ')}, … (+${remaining} ${noun})`
}

export function printUpdateSummary (summary: UpdateSummary, color: boolean, output: NodeJS.WritableStream = process.stdout): void {
  const ok = (value: string) => color ? C.green(value) : value
  const bad = (value: string) => color ? C.red(value) : value
  for (const result of summary.results) {
    switch (result.status) {
      case 'updated': {
        const span = result.currentVersion && result.resultingVersion
          ? ` (${result.currentVersion} → ${result.resultingVersion})`
          : result.resultingVersion ? ` (${result.resultingVersion})` : ''
        output.write(`${ok('✓')} ${result.installationId} updated${span}\n`)
        if (result.restartHint) output.write(`  ${result.restartHint}\n`)
        break
      }
      case 'current': {
        const suffix = result.currentVersion ? ` (${result.currentVersion})` : ''
        output.write(`${ok('✓')} ${result.installationId} is up to date${suffix}\n`)
        break
      }
      case 'newer-than-registry': {
        const local = result.currentVersion ?? '?'
        const registry = result.latestVersion ? `; registry has ${result.latestVersion}` : ''
        output.write(`${ok('✓')} ${result.installationId} is up to date (${local}${registry})\n`)
        break
      }
      case 'unsupported': {
        output.write(`${bad('✗')} ${result.installationId} cannot be updated automatically\n`)
        // Every recovery path is printed: truncating to two commands hid the
        // remaining exact-version commands (npx, Volta) from the user.
        for (const command of uniqueCommands(result.manualCommands ?? [])) output.write(`  → ${command}\n`)
        break
      }
      case 'failed': {
        const error = result.error ? ` — ${result.error.message}` : ''
        output.write(`${bad('✗')} ${result.installationId} update failed${error}\n`)
        if (result.rollbackCommand) output.write(`  → restore: ${result.rollbackCommand}\n`)
        break
      }
      case 'skipped': {
        const error = result.error ? ` — ${result.error.message}` : ''
        output.write(`${bad('✗')} ${result.installationId} skipped${error}\n`)
        break
      }
      case 'unknown':
        output.write(`${result.installationId} — installed version unknown\n`)
        break
      case 'not-installed':
        output.write(`${result.installationId} — not installed\n`)
        // A requested-but-absent harness gets concrete installable guidance,
        // even though the result carries no actionable update.
        for (const command of uniqueCommands(result.manualCommands ?? [])) output.write(`  → ${command}\n`)
        break
      default:
        output.write(`${result.installationId}: ${result.status}\n`)
    }
  }
}

/** Capture helper for unit tests over the rendered output. */
export function captureRender (render: (output: NodeJS.WritableStream) => void): string {
  let text = ''
  const stream = {
    write (chunk: string | Uint8Array) {
      text += typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString()
    },
  } as unknown as NodeJS.WritableStream
  render(stream)
  return text
}
