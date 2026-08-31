import { parse as parseToml } from 'smol-toml'

/**
 * Byte-localized TOML editor for the NodeSource-owned MCP slice of a user's
 * configuration. Every byte outside the exact owned server/field ranges is
 * preserved verbatim: comments, CRLF endings, spacing, key spelling, unrelated
 * tables, and user credentials. The full document is never re-serialized.
 *
 * The editor is fail closed: ambiguous constructs inside an owned range
 * (standalone comments, dotted partial keys, array-of-tables servers) return a
 * structured error instead of guessing, and every generated result is
 * re-parsed and deep-compared against an independently computed model before
 * it may be installed.
 */
export class McpTomlEditError extends Error {
  constructor (public readonly code: 'MCP_PARSE_FAILED' | 'MCP_BLOCK_MISSING' | 'MCP_BLOCK_INVALID' | 'MCP_RECONCILIATION_REQUIRED', message: string) {
    super(message)
  }
}

export interface McpTomlEdit {
  /** Whole server records to append as new, exclusively owned tables. */
  upsertServers?: Readonly<Record<string, unknown>>
  /** Server base+descendant tables to delete (proven exclusively owned). */
  removeServers?: readonly string[]
  /** Owned-field updates inside an existing server table. */
  setFields?: readonly { server: string; field: string; value: unknown }[]
  /** Owned-field removals inside an existing server table. */
  removeFields?: readonly { server: string; field: string }[]
}

interface AssignmentSpan {
  keyPath: string[]
  keyStart: number
  lineStart: number
  lineEnd: number
  valueStart: number
  valueEnd: number
}

interface TableSpan {
  path: string[]
  isArrayTable: boolean
  headerLineStart: number
  headerEnd: number
  /** Line start of the next header in the document, or EOF. */
  nextHeaderLineStart: number
  assignments: AssignmentSpan[]
  /** A standalone comment line inside the body: ownership is ambiguous. */
  looseComments: boolean
}

interface TomlIndex {
  eol: '\n' | '\r\n'
  tables: TableSpan[]
}

interface SpanEdit {
  start: number
  end: number
  text: string
}

const SERVERS_KEY = 'mcp_servers'

/**
 * Apply owned MCP edits to raw TOML bytes while preserving every other byte.
 * Returns the original string when the requested operations are a semantic
 * no-op.
 */
export function editMcpTomlBytes (raw: string, edit: McpTomlEdit): string {
  const original = parseTomlSafe(raw, 'MCP_PARSE_FAILED')
  const expected = modelAfterOps(original, edit)
  // A semantic no-op must not rewrite a single byte.
  if (deepEqual(expected, original)) return raw
  const index = indexToml(raw)
  const edits: SpanEdit[] = []
  for (const name of edit.removeServers ?? []) applyRemoveServer(edits, index, name)
  for (const removal of edit.removeFields ?? []) applyRemoveField(edits, index, removal.server, removal.field)
  for (const update of edit.setFields ?? []) applySetField(edits, index, raw, update.server, update.field, update.value)
  for (const [name, value] of Object.entries(edit.upsertServers ?? {})) applyUpsertServer(edits, index, raw, name, value)
  let out = raw
  for (const span of edits.sort((left, right) => right.start - left.start)) {
    out = out.slice(0, span.start) + span.text + out.slice(span.end)
  }
  // Independent verification: the result must parse and deep-compare equal to
  // the model produced by applying the same operations to the pre-edit parse.
  let finalParsed: Record<string, unknown>
  try {
    finalParsed = parseToml(out) as Record<string, unknown>
  } catch (error) {
    throw new McpTomlEditError('MCP_BLOCK_INVALID', `The localized TOML edit produced an invalid document: ${(error as Error).message}`)
  }
  if (!deepEqual(finalParsed, expected)) {
    throw new McpTomlEditError('MCP_BLOCK_INVALID', 'The localized TOML edit did not produce the expected document model; refusing to install it')
  }
  return out
}

function parseTomlSafe (raw: string, code: 'MCP_PARSE_FAILED' | 'MCP_BLOCK_INVALID'): Record<string, unknown> {
  try {
    return parseToml(raw) as Record<string, unknown>
  } catch (error) {
    throw new McpTomlEditError(code, `The MCP TOML configuration could not be parsed: ${(error as Error).message}`)
  }
}

// ---------------------------------------------------------------------------
// Lexical index
// ---------------------------------------------------------------------------

function indexToml (raw: string): TomlIndex {
  const eol: '\n' | '\r\n' = raw.includes('\r\n') ? '\r\n' : '\n'
  const tables: TableSpan[] = []
  let current: TableSpan | undefined
  let lineStart = 0
  let i = 0
  while (i < raw.length) {
    const ch = raw[i]
    if (ch === ' ' || ch === '\t' || ch === '\r' || ch === '\n') {
      if (ch === '\n') lineStart = i + 1
      i++
      continue
    }
    if (ch === '#') {
      // A standalone comment line inside a table body has ambiguous
      // ownership: remember it so destructive edits can fail closed.
      if (current) current.looseComments = true
      i = skipToLineEnd(raw, i)
      continue
    }
    if (ch === '[') {
      const header = parseTableHeader(raw, i)
      if (!header) {
        i = skipToLineEnd(raw, i)
        continue
      }
      if (current) current.nextHeaderLineStart = lineStart
      current = {
        path: header.path,
        isArrayTable: header.isArrayTable,
        headerLineStart: lineStart,
        headerEnd: header.end,
        nextHeaderLineStart: raw.length,
        assignments: [],
        looseComments: false,
      }
      tables.push(current)
      i = skipToLineEnd(raw, header.end)
      continue
    }
    const key = parseKeySegments(raw, i)
    if (!key) {
      i = skipToLineEnd(raw, i)
      continue
    }
    let cursor = skipSpaces(raw, key.end)
    if (raw[cursor] !== '=') {
      i = skipToLineEnd(raw, i)
      continue
    }
    cursor = skipSpaces(raw, cursor + 1)
    const value = scanValue(raw, cursor)
    if (!value) {
      i = skipToLineEnd(raw, i)
      continue
    }
    if (current) {
      current.assignments.push({
        keyPath: key.segments,
        keyStart: i,
        lineStart,
        lineEnd: lineEndOf(raw, lineStart),
        valueStart: value.start,
        valueEnd: value.end,
      })
    }
    i = lineEndOf(raw, lineStartOfValueLine(raw, value.end))
    // The jump skipped the assignment's newline: keep the walk's line anchor
    // in sync so every assignment records its own line bounds.
    lineStart = i
  }
  return { eol, tables }
}

function lineStartOfValueLine (raw: string, end: number): number {
  // The assignment's owning line is the one containing the end of its value
  // (multiline values span lines; destructive edits cut whole final lines).
  const nl = raw.lastIndexOf('\n', Math.max(end - 1, 0))
  return nl === -1 ? 0 : nl + 1
}

function lineEndOf (raw: string, lineStart: number): number {
  const nl = raw.indexOf('\n', lineStart)
  return nl === -1 ? raw.length : nl + 1
}

function skipToLineEnd (raw: string, i: number): number {
  while (i < raw.length && raw[i] !== '\n') i++
  return i
}

function skipSpaces (raw: string, i: number): number {
  while (i < raw.length && (raw[i] === ' ' || raw[i] === '\t' || raw[i] === '\r')) i++
  return i
}

/** Parse `[a.b]` / `[["a".b]]` headers with quote awareness. */
function parseTableHeader (raw: string, start: number): { path: string[]; isArrayTable: boolean; end: number } | undefined {
  const isArrayTable = raw.startsWith('[[', start)
  const closing = isArrayTable ? ']]' : ']'
  let i = isArrayTable ? start + 2 : start + 1
  const segments: string[] = []
  for (;;) {
    i = skipSpaces(raw, i)
    const segment = parseKeySegment(raw, i)
    if (!segment) return undefined
    segments.push(segment.value)
    i = skipSpaces(raw, segment.end)
    if (raw.startsWith(closing, i)) {
      return { path: segments, isArrayTable, end: i + closing.length }
    }
    if (raw[i] !== '.') return undefined
    i++
  }
}

/** Parse a dotted key: bare or quoted segments joined by dots. */
function parseKeySegments (raw: string, start: number): { segments: string[]; end: number } | undefined {
  const segments: string[] = []
  let i = start
  for (;;) {
    const segment = parseKeySegment(raw, i)
    if (!segment) return undefined
    segments.push(segment.value)
    i = skipSpaces(raw, segment.end)
    if (raw[i] !== '.') return { segments, end: segment.end }
    i++
    i = skipSpaces(raw, i)
  }
}

function parseKeySegment (raw: string, start: number): { value: string; end: number } | undefined {
  const ch = raw[start]
  if (ch === '"') return scanBasicString(raw, start)
  if (ch === "'") return scanLiteralString(raw, start)
  if (ch === undefined || !/[A-Za-z0-9_-]/.test(ch)) return undefined
  let i = start
  while (i < raw.length && /[A-Za-z0-9_-]/.test(raw[i])) i++
  return { value: raw.slice(start, i), end: i }
}

/** Scan one TOML value; returns its exact [start, end) span. */
function scanValue (raw: string, start: number): { start: number; end: number } | undefined {
  const first = skipSpaces(raw, start)
  if (first >= raw.length || raw[first] === '\n') return undefined
  const ch = raw[first]
  let end: number
  if (ch === '"') {
    const scanned = scanBasicString(raw, first)
    if (!scanned) return undefined
    end = scanned.end
  } else if (ch === "'") {
    const scanned = scanLiteralString(raw, first)
    if (!scanned) return undefined
    end = scanned.end
  } else if (ch === '{') {
    end = scanBalanced(raw, first, '{', '}')
    if (end === -1) return undefined
  } else if (ch === '[') {
    end = scanBalanced(raw, first, '[', ']')
    if (end === -1) return undefined
  } else {
    end = first
    while (end < raw.length && !',}]#\n'.includes(raw[end]) && raw[end] !== '\r') end++
    // Trailing spaces belong to the line, not the value.
    while (end > first && (raw[end - 1] === ' ' || raw[end - 1] === '\t')) end--
    if (end === first) return undefined
  }
  return { start: first, end }
}

function scanBasicString (raw: string, start: number): { value: string; end: number } | undefined {
  const multiline = raw.startsWith('"""', start)
  const opener = multiline ? 3 : 1
  let i = start + opener
  for (;;) {
    if (i >= raw.length) return undefined
    if (!multiline && raw[i] === '\n') return undefined
    if (raw[i] === '\\') {
      // Skip escape sequences; escapes are decoded only for key segments.
      i += 2
      continue
    }
    if (raw.startsWith(multiline ? '"""' : '"', i)) {
      const text = raw.slice(start + opener, i)
      return { value: decodeBasicEscapes(text), end: i + (multiline ? 3 : 1) }
    }
    i++
  }
}

function decodeBasicEscapes (text: string): string {
  try {
    return JSON.parse('"' + text.replace(/\\e/g, '\\u001b') + '"')
  } catch {
    return text
  }
}

function scanLiteralString (raw: string, start: number): { value: string; end: number } | undefined {
  const multiline = raw.startsWith("'''", start)
  const opener = multiline ? 3 : 1
  let i = start + opener
  for (;;) {
    if (i >= raw.length) return undefined
    if (!multiline && raw[i] === '\n') return undefined
    if (raw.startsWith(multiline ? "'''" : "'", i)) {
      return { value: raw.slice(start + opener, i), end: i + (multiline ? 3 : 1) }
    }
    i++
  }
}

function scanBalanced (raw: string, start: number, open: string, close: string): number {
  let depth = 0
  let i = start
  while (i < raw.length) {
    const ch = raw[i]
    if (ch === '"' || ch === "'") {
      const scanned = ch === '"' ? scanBasicString(raw, i) : scanLiteralString(raw, i)
      if (!scanned) return -1
      i = scanned.end
      continue
    }
    if (ch === '#') {
      i = skipToLineEnd(raw, i)
      continue
    }
    if (ch === open) depth++
    if (ch === close) {
      depth--
      if (depth === 0) return i + 1
    }
    i++
  }
  return -1
}

// ---------------------------------------------------------------------------
// Model verification
// ---------------------------------------------------------------------------

function isRecord (value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/** Structured owned values must be TOML tables; anything else fails closed. */
function asRecord (value: unknown): Record<string, unknown> {
  if (!isRecord(value)) {
    throw new McpTomlEditError('MCP_BLOCK_INVALID', 'Structured owned values must be rendered as TOML tables')
  }
  return value
}

/**
 * Apply the requested operations to an independent copy of the pre-edit model
 * so the localized result can be verified structurally. Missing targets fail
 * closed with the same codes the editor uses for the byte-level path.
 */
function modelAfterOps (model: Record<string, unknown>, edit: McpTomlEdit): Record<string, unknown> {
  const next = structuredClone(model)
  const root = next as Record<string, unknown>
  const ensureServers = (): Record<string, unknown> => {
    const existing = root[SERVERS_KEY]
    if (existing === undefined) {
      const created: Record<string, unknown> = {}
      root[SERVERS_KEY] = created
      return created
    }
    if (isRecord(existing)) return existing
    throw new McpTomlEditError('MCP_BLOCK_INVALID', `The ${SERVERS_KEY} entry is not a TOML table`)
  }
  for (const [name, value] of Object.entries(edit.upsertServers ?? {})) {
    const servers = ensureServers()
    if (Object.hasOwn(servers, name)) {
      throw new McpTomlEditError('MCP_RECONCILIATION_REQUIRED', `A server named ${name} already exists in the TOML MCP configuration`)
    }
    servers[name] = structuredClone(value)
  }
  for (const name of edit.removeServers ?? []) {
    const servers = root[SERVERS_KEY]
    if (!isRecord(servers) || !Object.hasOwn(servers, name)) {
      throw new McpTomlEditError('MCP_BLOCK_MISSING', `Server ${name} is absent from the TOML MCP configuration`)
    }
    if (Array.isArray(servers[name])) {
      throw new McpTomlEditError('MCP_BLOCK_INVALID', `Server ${name} is an array of tables and cannot be edited safely`)
    }
    delete servers[name]
  }
  for (const { server, field } of edit.removeFields ?? []) {
    const servers = root[SERVERS_KEY]
    const record = isRecord(servers) ? servers[server] : undefined
    if (!isRecord(record) || !Object.hasOwn(record, field)) {
      throw new McpTomlEditError('MCP_BLOCK_MISSING', `Field ${server}.${field} is absent from the TOML MCP configuration`)
    }
    delete record[field]
  }
  for (const { server, field, value } of edit.setFields ?? []) {
    const servers = root[SERVERS_KEY]
    const record = isRecord(servers) ? servers[server] : undefined
    if (!isRecord(record)) {
      throw new McpTomlEditError('MCP_BLOCK_MISSING', `Server ${server} is absent from the TOML MCP configuration`)
    }
    record[field] = structuredClone(value)
  }
  return next
}

function deepEqual (left: unknown, right: unknown): boolean {
  if (left === right) return true
  if (typeof left === 'number' && typeof right === 'number' && Number.isNaN(left) && Number.isNaN(right)) return true
  if (Array.isArray(left) && Array.isArray(right)) {
    return left.length === right.length && left.every((value, i) => deepEqual(value, right[i]))
  }
  if (isRecord(left) && isRecord(right)) {
    const leftKeys = Object.keys(left)
    return leftKeys.length === Object.keys(right).length &&
      leftKeys.every((key) => Object.hasOwn(right, key) && deepEqual(left[key], right[key]))
  }
  return false
}

// ---------------------------------------------------------------------------
// Byte-localized edit builders
// ---------------------------------------------------------------------------

function serverTables (index: TomlIndex, name: string): TableSpan[] {
  return index.tables.filter((table) => !table.isArrayTable && table.path.length >= 2 && table.path[0] === SERVERS_KEY && table.path[1] === name)
}

function findTable (index: TomlIndex, path: string[]): TableSpan | undefined {
  return index.tables.find((table) => !table.isArrayTable && table.path.length === path.length && table.path.every((segment, i) => segment === path[i]))
}

function rejectAmbiguousServer (table: TableSpan, name: string): void {
  if (table.looseComments) {
    throw new McpTomlEditError('MCP_BLOCK_INVALID', `Server ${name} contains standalone comments whose ownership is ambiguous; refusing to rewrite those bytes`)
  }
}

function applyRemoveServer (edits: SpanEdit[], index: TomlIndex, name: string): void {
  const tables = serverTables(index, name)
  if (tables.length === 0) {
    throw new McpTomlEditError('MCP_BLOCK_MISSING', `Server ${name} is absent from the TOML MCP configuration`)
  }
  for (const table of tables) {
    rejectAmbiguousServer(table, name)
    edits.push({ start: table.headerLineStart, end: table.nextHeaderLineStart, text: '' })
  }
}

function applyRemoveField (edits: SpanEdit[], index: TomlIndex, server: string, field: string): void {
  const basePath = [SERVERS_KEY, server]
  const child = findTable(index, [...basePath, field])
  if (child) {
    rejectAmbiguousServer(child, `${server}.${field}`)
    edits.push({ start: child.headerLineStart, end: child.nextHeaderLineStart, text: '' })
    return
  }
  const base = findTable(index, basePath)
  if (!base) {
    if (index.tables.some((table) => table.path[0] === SERVERS_KEY && table.path[1] === server)) {
      throw new McpTomlEditError('MCP_BLOCK_INVALID', `Server ${server} is an array of tables and cannot be edited safely`)
    }
    throw new McpTomlEditError('MCP_BLOCK_MISSING', `Server ${server} is absent from the TOML MCP configuration`)
  }
  const assignment = base.assignments.find((candidate) => candidate.keyPath.length === 1 && candidate.keyPath[0] === field)
  if (assignment) {
    // The whole line goes, including its trailing comment; standalone comments
    // above the line are ambiguous and stay untouched.
    edits.push({ start: assignment.lineStart, end: assignment.lineEnd, text: '' })
    return
  }
  if (base.assignments.some((candidate) => candidate.keyPath[0] === field)) {
    throw new McpTomlEditError('MCP_BLOCK_INVALID', `Field ${server}.${field} uses dotted-key syntax that cannot be removed safely`)
  }
  throw new McpTomlEditError('MCP_BLOCK_MISSING', `Field ${server}.${field} is absent from the TOML MCP configuration`)
}

function applySetField (edits: SpanEdit[], index: TomlIndex, raw: string, server: string, field: string, value: unknown): void {
  const eol = index.eol
  const basePath = [SERVERS_KEY, server]
  const base = findTable(index, basePath)
  if (!base) {
    if (index.tables.some((table) => table.path[0] === SERVERS_KEY && table.path[1] === server)) {
      throw new McpTomlEditError('MCP_BLOCK_INVALID', `Server ${server} is an array of tables and cannot be edited safely`)
    }
    throw new McpTomlEditError('MCP_BLOCK_MISSING', `Server ${server} is absent from the TOML MCP configuration`)
  }
  const child = findTable(index, [...basePath, field])
  if (child) {
    rejectAmbiguousServer(child, `${server}.${field}`)
    // Replace only this exact subtree; the blank lines separating it from the
    // following table stay so the surrounding layout is untouched.
    const blanks = trailingBlankBytes(raw, child.nextHeaderLineStart)
    const replacement = isRecord(value)
      ? renderTableHeader([...basePath, field]) + eol + renderAssignments(asRecord(value), [...basePath, field], eol) + blanks
      : indentOf(raw, base) + renderKey(field) + ' = ' + inlineValue(value) + eol + blanks
    edits.push({ start: child.headerLineStart, end: child.nextHeaderLineStart, text: replacement })
    return
  }
  const assignment = base.assignments.find((candidate) => candidate.keyPath.length === 1 && candidate.keyPath[0] === field)
  if (assignment) {
    if (inlineSerializable(value)) {
      // Replace only the value span: key spelling, spacing around '=', the
      // trailing comment, and the EOL are preserved byte-for-byte.
      edits.push({ start: assignment.valueStart, end: assignment.valueEnd, text: inlineValue(value) })
      return
    }
    // Scalar to structured: drop the line and append the child table at the
    // end of this server's subtree.
    edits.push({ start: assignment.lineStart, end: assignment.lineEnd, text: '' })
    const subtreeEnd = serverSubtreeEnd(index, server)
    const structured = asRecord(value)
    edits.push({
      start: subtreeEnd,
      end: subtreeEnd,
      text: eolPrefix(raw, subtreeEnd, eol) + renderTableHeader([...basePath, field]) + eol + renderAssignments(structured, [...basePath, field], eol),
    })
    return
  }
  if (base.assignments.some((candidate) => candidate.keyPath[0] === field)) {
    throw new McpTomlEditError('MCP_BLOCK_INVALID', `Field ${server}.${field} uses dotted-key syntax that cannot be edited safely`)
  }
  // New field: scalars land inside the base table right after its last
  // assignment; structured values become a child table at the end of the
  // server's subtree so TOML table scoping stays correct.
  if (inlineSerializable(value)) {
    const insertPoint = base.assignments.length > 0
      ? base.assignments[base.assignments.length - 1].lineEnd
      : lineEndOf(raw, base.headerLineStart)
    const line = indentOf(raw, base) + renderKey(field) + ' = ' + inlineValue(value) + eol
    edits.push({ start: insertPoint, end: insertPoint, text: eolPrefix(raw, insertPoint, eol) + line })
    return
  }
  const subtreeEnd = serverSubtreeEnd(index, server)
  const structured = asRecord(value)
  edits.push({
    start: subtreeEnd,
    end: subtreeEnd,
    text: eolPrefix(raw, subtreeEnd, eol) + renderTableHeader([...basePath, field]) + eol + renderAssignments(structured, [...basePath, field], eol),
  })
}

function applyUpsertServer (edits: SpanEdit[], index: TomlIndex, raw: string, name: string, value: unknown): void {
  if (serverTables(index, name).length > 0) {
    throw new McpTomlEditError('MCP_RECONCILIATION_REQUIRED', `A server named ${name} already exists in the TOML MCP configuration`)
  }
  const eol = index.eol
  const path = [SERVERS_KEY, name]
  const fragment = renderTableHeader(path) + eol + renderAssignments(asRecord(value), path, eol)
  if (raw.length === 0) {
    edits.push({ start: 0, end: 0, text: fragment })
    return
  }
  edits.push({ start: raw.length, end: raw.length, text: eolPrefix(raw, raw.length, eol) + fragment })
}

function serverSubtreeEnd (index: TomlIndex, server: string): number {
  const tables = serverTables(index, server)
  if (tables.length === 0) {
    throw new McpTomlEditError('MCP_BLOCK_MISSING', `Server ${server} is absent from the TOML MCP configuration`)
  }
  const last = tables.reduce((acc, table) => (table.headerLineStart > acc.headerLineStart ? table : acc), tables[0])
  return last.nextHeaderLineStart
}

/** Bytes of blank lines immediately before `end`, preserved across replaces. */
function trailingBlankBytes (raw: string, end: number): string {
  let cursor = end
  for (;;) {
    const nl = raw.lastIndexOf('\n', cursor - 1)
    if (nl === -1) break
    const lineStart = raw.lastIndexOf('\n', nl - 1) + 1
    const lineEnd = raw.endsWith('\r', nl) ? nl - 1 : nl
    if (raw.slice(lineStart, lineEnd).trim() !== '') break
    cursor = lineStart
  }
  return raw.slice(cursor, end)
}

function eolPrefix (raw: string, insertPoint: number, eol: string): string {
  // A final line without a newline needs one before an appended fragment.
  return insertPoint >= raw.length && raw.length > 0 && !raw.endsWith('\n') ? eol : ''
}

function indentOf (raw: string, table: TableSpan): string {
  const first = table.assignments[0]
  return first ? raw.slice(first.lineStart, first.keyStart) : ''
}

// ---------------------------------------------------------------------------
// TOML fragment rendering (synthetic owned values only; never a full document)
// ---------------------------------------------------------------------------

function renderKey (key: string): string {
  return /^[A-Za-z0-9_-]+$/.test(key) ? key : JSON.stringify(key)
}

function renderTableHeader (path: readonly string[]): string {
  return '[' + path.map(renderKey).join('.') + ']'
}

function inlineSerializable (value: unknown): boolean {
  return !isRecord(value) || Object.keys(value).length === 0
}

function inlineValue (value: unknown): string {
  if (value === null || value === undefined) {
    throw new McpTomlEditError('MCP_BLOCK_INVALID', 'TOML cannot represent a null owned field value')
  }
  if (typeof value === 'string') return JSON.stringify(value)
  if (typeof value === 'number') {
    if (Number.isNaN(value)) return 'nan'
    if (value === Number.POSITIVE_INFINITY) return 'inf'
    if (value === Number.NEGATIVE_INFINITY) return '-inf'
    return String(value)
  }
  if (typeof value === 'boolean') return value ? 'true' : 'false'
  if (Array.isArray(value)) return '[' + value.map(inlineValue).join(', ') + ']'
  if (Object.keys(value).length === 0) return '{}'
  // Non-empty objects never serialize inline: they become child tables via
  // renderAssignments so sibling bytes stay untouched.
  throw new McpTomlEditError('MCP_BLOCK_INVALID', 'Structured owned values must be rendered as child tables')
}

function renderAssignments (record: Record<string, unknown>, path: readonly string[], eol: string): string {
  // Two-pass rendering: every direct scalar/inline assignment of this table
  // must be emitted before its child tables, otherwise later scalars would
  // be scoped under a child-table header.
  let scalars = ''
  let children = ''
  for (const [key, value] of Object.entries(record)) {
    if (inlineSerializable(value)) {
      scalars += renderKey(key) + ' = ' + inlineValue(value) + eol
    } else {
      children += renderTableHeader([...path, key]) + eol + renderAssignments(asRecord(value), [...path, key], eol)
    }
  }
  return scalars + children
}
