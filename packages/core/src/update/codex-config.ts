import { readFileSync } from 'node:fs'
import { parse as parseToml } from 'smol-toml'
import { atomicWriteSync } from '../utils/fs.js'
import { readTomlFile } from '../utils/config.js'

const CODEX_ENGINE_OWNED_FIELDS = ['version', 'path', 'installPath', 'cachePath'] as const

export function readCodexPlugin (configPath: string, pluginId: string): Record<string, unknown> | undefined {
  try {
    const data = readTomlFile<Record<string, unknown>>(configPath)
    const plugins = data?.plugins
    const plugin = plugins && typeof plugins === 'object' && !Array.isArray(plugins)
      ? (plugins as Record<string, unknown>)[pluginId]
      : undefined
    return isRecord(plugin) ? { ...plugin } : undefined
  } catch {
    return undefined
  }
}

export function restoreCodexUserOwnedFields (
  configPath: string,
  pluginId: string,
  original: Record<string, unknown>,
  originalText: string | undefined
): boolean {
  try {
    if (originalText === undefined) return false
    const currentText = readFileSync(configPath, 'utf8')
    const currentData = readTomlFile<Record<string, unknown>>(configPath)
    if (!currentData) return false
    const plugins = currentData.plugins
    if (!isRecord(plugins)) return false
    const current = plugins[pluginId]
    if (!isRecord(current)) return false
    const patched = patchCodexPluginTable(originalText, pluginId, current)
    if (!patched) return false
    const parsed = parseToml(patched) as Record<string, unknown>
    const parsedPlugins = parsed.plugins
    const preserved = isRecord(parsedPlugins) ? parsedPlugins[pluginId] : undefined
    if (!isRecord(preserved) || !codexUserOwnedFieldsMatch(preserved, original)) return false
    for (const key of CODEX_ENGINE_OWNED_FIELDS) {
      if (Object.prototype.hasOwnProperty.call(current, key) !== Object.prototype.hasOwnProperty.call(preserved, key)) return false
      if (Object.prototype.hasOwnProperty.call(current, key) && !sameValue(current[key], preserved[key])) return false
    }
    if (patched !== currentText) atomicWriteSync(configPath, patched)
    return true
  } catch {
    return false
  }
}

export function codexUserOwnedFieldsMatch (current: Record<string, unknown>, original: Record<string, unknown>): boolean {
  for (const [key, value] of Object.entries(original)) {
    if (CODEX_ENGINE_OWNED_FIELDS.includes(key as typeof CODEX_ENGINE_OWNED_FIELDS[number])) continue
    if (!sameValue(current[key], value)) return false
  }
  return true
}

function patchCodexPluginTable (source: string, pluginId: string, current: Record<string, unknown>): string | undefined {
  const lines = splitTomlLines(source)
  const header = `[plugins.${JSON.stringify(pluginId)}]`
  const matchingHeaders = lines.filter((line) => line.text.trim().split('#', 1)[0].trim() === header)
  if (matchingHeaders.length !== 1) return undefined
  const headerLine = matchingHeaders[0]!
  const headerIndex = lines.indexOf(headerLine)
  const tableEndIndex = lines.findIndex((line, index) => index > headerIndex && /^\s*\[{1,2}[^\]]+\]/.test(line.text))
  const endIndex = tableEndIndex === -1 ? lines.length : tableEndIndex
  const engineLines = new Map<string, TomlLine>()
  const replacements: Array<{ start: number; end: number; value: string }> = []

  for (let index = headerIndex + 1; index < endIndex; index++) {
    const line = lines[index]!
    const assignment = line.text.match(/^(\s*)([A-Za-z0-9_-]+)(\s*=\s*)(.*)$/)
    if (!assignment || !CODEX_ENGINE_OWNED_FIELDS.includes(assignment[2] as typeof CODEX_ENGINE_OWNED_FIELDS[number])) continue
    const key = assignment[2]!
    if (engineLines.has(key) || !isSimpleTomlValue(assignment[4]!)) return undefined
    engineLines.set(key, line)
  }

  const missing: string[] = []
  for (const key of CODEX_ENGINE_OWNED_FIELDS) {
    const hasCurrent = Object.prototype.hasOwnProperty.call(current, key)
    const line = engineLines.get(key)
    if (line) {
      if (!hasCurrent) replacements.push({ start: line.start, end: line.end, value: '' })
      else {
        const formatted = formatTomlValue(current[key])
        if (formatted === undefined) return undefined
        replacements.push({ start: line.start, end: line.end, value: replaceTomlValue(line.text, formatted) + line.newline })
      }
    } else if (hasCurrent) {
      const formatted = formatTomlValue(current[key])
      if (formatted === undefined) return undefined
      missing.push(`${key} = ${formatted}`)
    }
  }

  if (missing.length > 0) {
    const endOffset = tableEndIndex === -1 ? source.length : lines[tableEndIndex]!.start
    const before = source.slice(0, endOffset)
    const hasNewline = before.endsWith('\n') || before.endsWith('\r')
    const followedByTable = tableEndIndex !== -1
    const newline = source.includes('\r\n') ? '\r\n' : '\n'
    const value = `${hasNewline ? '' : newline}${missing.join(newline)}${hasNewline || followedByTable ? newline : ''}`
    replacements.push({ start: endOffset, end: endOffset, value })
  }

  return replacements
    .sort((left, right) => right.start - left.start)
    .reduce((value, replacement) => value.slice(0, replacement.start) + replacement.value + value.slice(replacement.end), source)
}

interface TomlLine { start: number; end: number; text: string; newline: string }

function splitTomlLines (source: string): TomlLine[] {
  const lines: TomlLine[] = []
  let start = 0
  while (start < source.length) {
    const newlineIndex = source.indexOf('\n', start)
    if (newlineIndex === -1) {
      lines.push({ start, end: source.length, text: source.slice(start), newline: '' })
      break
    }
    const newline = newlineIndex > start && source[newlineIndex - 1] === '\r' ? '\r\n' : '\n'
    const contentEnd = newlineIndex - (newline === '\r\n' ? 1 : 0)
    lines.push({ start, end: newlineIndex + 1, text: source.slice(start, contentEnd), newline })
    start = newlineIndex + 1
  }
  return lines
}

function isSimpleTomlValue (value: string): boolean {
  const trimmed = value.trim()
  return trimmed.length > 0 && !trimmed.startsWith('[') && !trimmed.startsWith('{') && !trimmed.includes('"""') && !trimmed.includes("'''")
}

function formatTomlValue (value: unknown): string | undefined {
  if (typeof value === 'string') return JSON.stringify(value)
  if (typeof value === 'boolean') return String(value)
  if (typeof value === 'number' && Number.isFinite(value)) return String(value)
  return undefined
}

function replaceTomlValue (line: string, formatted: string): string {
  const equals = line.indexOf('=')
  let valueStart = equals + 1
  while (/\s/.test(line[valueStart] ?? '')) valueStart++
  const comment = findTomlComment(line, valueStart)
  const valueEnd = comment === -1 ? line.length : comment
  const whitespace = line.slice(valueStart, valueEnd).match(/\s*$/)?.[0] ?? ''
  return line.slice(0, valueStart) + formatted + whitespace + (comment === -1 ? '' : line.slice(comment))
}

function findTomlComment (line: string, start: number): number {
  let quote: '"' | "'" | undefined
  let escaped = false
  for (let index = start; index < line.length; index++) {
    const character = line[index]
    if (quote === '"' && character === '\\' && !escaped) {
      escaped = true
      continue
    }
    if (quote && character === quote && !escaped) quote = undefined
    else if (!quote && (character === '"' || character === "'")) quote = character
    else if (!quote && character === '#') return index
    escaped = false
  }
  return -1
}

function sameValue (left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true
  if (Array.isArray(left) && Array.isArray(right)) return left.length === right.length && left.every((value, index) => sameValue(value, right[index]))
  if (isRecord(left) && isRecord(right)) {
    const leftKeys = Object.keys(left)
    const rightKeys = Object.keys(right)
    return leftKeys.length === rightKeys.length && leftKeys.every((key) => Object.prototype.hasOwnProperty.call(right, key) && sameValue(left[key], right[key]))
  }
  return false
}

function isRecord (value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}
