import type { DoctorReport } from '../types.js'

const C = {
  green: (s: string) => `\x1b[32m${s}\x1b[0m`,
  yellow: (s: string) => `\x1b[33m${s}\x1b[0m`,
  red: (s: string) => `\x1b[31m${s}\x1b[0m`,
  dim: (s: string) => `\x1b[2m${s}\x1b[0m`,
}

export function supportsColor (stream: { isTTY?: boolean } = process.stdout): boolean {
  if (process.env.NO_COLOR !== undefined) return false
  if (process.env.FORCE_COLOR === '0') return false
  if (process.env.FORCE_COLOR !== undefined) return true
  return stream.isTTY === true
}

function credLine (status: DoctorReport['credentials']['status'], color: boolean): string {
  // No hint on the 'ok' branch — telling a user to authenticate when creds are
  // valid is misleading. Hints only attach to missing/expired (actionable) states.
  if (status === 'ok') return line('Credentials', '✓ ok', C.green, '', color)
  if (status === 'expired') return line('Credentials', '✗ expired', C.red, 'Re-run installation to re-authenticate', color)
  return line('Credentials', '✗ missing', C.red, 'Run installation to authenticate', color)
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
  out.push(credLine(report.credentials.status, color))
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
