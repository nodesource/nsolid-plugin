import type { Logger } from '../types.js'

export type LogLevel = 'debug' | 'info' | 'warn' | 'error'

export interface CreateLoggerOptions {
  verbose?: boolean
  /** Optional prefix prepended to every message. */
  prefix?: string
}

const SENSITIVE_KEYS = /token|authorization|auth|saas|secret|password|cookie/i
const URL_PARAM_RE = /([?&])(token|NSOLID_SAAS|saas|authorization|auth|password|secret)=[^&]*/gi

export function isVerboseEnabled (explicit?: boolean): boolean {
  if (explicit !== undefined) return explicit
  const env = process.env.NSOLID_PLUGIN_VERBOSE
  if (!env) return false
  return /^(1|true|yes|on)$/i.test(env)
}

function redactString (message: string): string {
  return message.replace(URL_PARAM_RE, (_, sep, key) => `${sep}${key}=<redacted>`)
}

function redactMeta (meta: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  if (!meta) return meta
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(meta)) {
    if (SENSITIVE_KEYS.test(key)) {
      out[key] = typeof value === 'boolean' ? value : '<redacted>'
    } else if (typeof value === 'string') {
      out[key] = redactString(value)
    } else {
      out[key] = value
    }
  }
  return out
}

function formatLogLine (
  level: LogLevel,
  message: string,
  meta: Record<string, unknown> | undefined,
  prefix?: string
): string {
  const timestamp = new Date().toISOString()
  const safeMessage = redactString(message)
  const parts: string[] = [timestamp, level.toUpperCase()]
  if (prefix) parts.push(prefix)
  parts.push(safeMessage)
  const safeMeta = redactMeta(meta)
  if (safeMeta && Object.keys(safeMeta).length > 0) {
    parts.push(JSON.stringify(safeMeta))
  }
  return parts.join(' ')
}

export function createLogger (options: CreateLoggerOptions = {}): Logger {
  const verbose = isVerboseEnabled(options.verbose)

  const write = (level: LogLevel, message: string, meta?: Record<string, unknown>): void => {
    // Operational logs (debug/info/warn) are opt-in via --verbose or
    // NSOLID_PLUGIN_VERBOSE. User-actionable failures are surfaced through
    // command results/progress; only errors bypass verbose mode.
    if (level !== 'error' && !verbose) return
    process.stderr.write(formatLogLine(level, message, meta, options.prefix) + '\n')
  }

  return {
    debug: (message: string, meta?: Record<string, unknown>) => write('debug', message, meta),
    info: (message: string, meta?: Record<string, unknown>) => write('info', message, meta),
    warn: (message: string, meta?: Record<string, unknown>) => write('warn', message, meta),
    error: (message: string, meta?: Record<string, unknown>) => write('error', message, meta),
  }
}
