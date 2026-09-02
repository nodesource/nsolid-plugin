import { applyEdits, findNodeAtLocation, getNodeValue, modify, parseTree, type FormattingOptions, type JSONPath, type ModificationOptions, type Node, type ParseError } from 'jsonc-parser'

export type JsonMcpKey = 'mcpServers' | 'mcp'

export interface McpByteEdit {
  /** Full server records to create or replace wholesale (new, exclusively owned servers). */
  upsertServers?: Readonly<Record<string, unknown>>
  /** Server records to delete entirely (proven exclusively owned). */
  removeServers?: readonly string[]
  /** Owned-field updates inside an existing server record. */
  setFields?: readonly { server: string; field: string; value: unknown }[]
  /** Owned-field removals inside an existing server record. */
  removeFields?: readonly { server: string; field: string }[]
  /** Remove the whole MCP container property (no servers remain). */
  removeBlock?: boolean
  /** Legacy container keys (for example a pre-migration mcpServers block) removed wholesale. */
  removeKeys?: readonly string[]
}

export class McpEditError extends Error {
  constructor (public readonly code: 'MCP_PARSE_FAILED' | 'MCP_BLOCK_MISSING' | 'MCP_BLOCK_INVALID', message: string) {
    super(message)
  }
}

/** Detect the MCP container key already present in the document. */
export function detectJsonMcpKey (raw: string, preferred: JsonMcpKey = 'mcpServers'): JsonMcpKey {
  const tree = parseTree(raw)
  if (!tree || tree.type !== 'object') return preferred
  const preferredNode = findNodeAtLocation(tree, [preferred])
  if (preferredNode) {
    if (preferredNode.type !== 'object') throw new McpEditError('MCP_BLOCK_INVALID', `Existing ${preferred} value is not an object`)
    return preferred
  }
  const alternate: JsonMcpKey = preferred === 'mcpServers' ? 'mcp' : 'mcpServers'
  const alternateNode = findNodeAtLocation(tree, [alternate])
  if (alternateNode) {
    if (alternateNode.type !== 'object') throw new McpEditError('MCP_BLOCK_INVALID', `Existing ${alternate} value is not an object`)
    return alternate
  }
  return preferred
}

/** Read the parsed value at an MCP path without altering anything. */
export function readMcpNodeValue (raw: string, segments: readonly string[]): unknown {
  const tree = parseTree(raw)
  if (!tree) return undefined
  activeRaw = raw
  try {
    const node = findNodeAtLocation(tree, [...segments] as JSONPath)
    if (!node) return undefined
    return jsonNodeValue(node)
  } finally {
    activeRaw = ''
  }
}

function jsonNodeValue (node: Node): unknown {
  const text = activeRaw.slice(node.offset, node.offset + node.length)
  if (node.type === 'string' || node.type === 'number' || node.type === 'boolean' || node.type === 'null') {
    try { return JSON.parse(text) } catch { return text }
  }
  try { return JSON.parse(text) } catch { return text }
}

let activeRaw = ''

/**
 * Apply localized AST edits to a JSON/JSONC document, preserving every byte
 * outside the edited properties: comments, CRLF line endings, indentation,
 * foreign servers, and fields this plugin does not own. The result is a
 * complete document string the caller validates and installs atomically.
 */
export function editMcpJsonBytes (raw: string, edit: McpByteEdit, options?: { mcpKey?: JsonMcpKey }): string {
  const mcpKey = options?.mcpKey ?? detectJsonMcpKey(raw)
  const hasStructuralEdits = (edit.removeServers?.length ?? 0) > 0 || (edit.setFields?.length ?? 0) > 0 || (edit.removeFields?.length ?? 0) > 0
  if (raw.trim().length === 0) {
    // Fail closed like the TOML editor: an empty document has no MCP block to
    // own, so requested removals/field edits must never be dropped silently.
    if (hasStructuralEdits) {
      throw new McpEditError('MCP_BLOCK_MISSING', `The ${mcpKey} block is absent`)
    }
    const servers = edit.upsertServers ?? {}
    return JSON.stringify({ [mcpKey]: servers }, null, 2) + '\n'
  }
  activeRaw = raw
  try {
    const errors: ParseError[] = []
    const tree = parseTree(raw, errors, { allowTrailingComma: true })
    if (!tree || tree.type !== 'object' || errors.length > 0) {
      throw new McpEditError('MCP_PARSE_FAILED', 'The MCP configuration is not a valid JSON object')
    }
    const mcpNode = findNodeAtLocation(tree, [mcpKey])
    if (mcpNode && mcpNode.type !== 'object') {
      throw new McpEditError('MCP_BLOCK_INVALID', `The ${mcpKey} container is ${mcpNode.type} and cannot be replaced safely`)
    }
    if (!mcpNode) {
      if (hasStructuralEdits) {
        throw new McpEditError('MCP_BLOCK_MISSING', `The ${mcpKey} block is absent`)
      }
      // Only wholesale upserts against a document without the MCP block:
      // insert one localized block before the outer closing brace so every
      // other byte of the document is preserved. Legacy keys still migrate.
      let inserted = insertMcpBlockBeforeClosingBrace(raw, mcpKey, edit.upsertServers ?? {})
      for (const legacyKey of edit.removeKeys ?? []) {
        inserted = removeRootProperty(inserted, legacyKey)
      }
      return inserted
    }
    let current = raw
    const modification: ModificationOptions = { formattingOptions: formattingOptionsFor(raw) }
    // jsonc-parser edits from separate modify() calls can overlap, so each
    // operation is applied and re-parsed sequentially.
    const apply = (path: JSONPath, value: unknown): void => {
      const edits = modify(current, path, value, modification)
      if (edits && edits.length > 0) current = applyEdits(current, edits)
    }

    for (const [name, value] of Object.entries(edit.upsertServers ?? {})) {
      apply([mcpKey, name], value)
    }
    for (const name of edit.removeServers ?? []) {
      const liveTree = parseTree(current)
      const liveMcp = liveTree ? findNodeAtLocation(liveTree, [mcpKey]) : undefined
      if (!liveMcp || !findNodeAtLocation(liveMcp, [name])) throw new McpEditError('MCP_BLOCK_MISSING', `Server ${name} is absent from ${mcpKey}`)
      apply([mcpKey, name], undefined)
    }
    for (const { server, field, value } of edit.setFields ?? []) {
      // A field already holding the desired value is not rewritten: a no-op
      // AST edit still re-serializes the node and would cosmetically drift
      // bytes the transaction does not need to touch.
      const liveTree = parseTree(current)
      const liveMcp = liveTree ? findNodeAtLocation(liveTree, [mcpKey]) : undefined
      const liveServer = liveMcp ? findNodeAtLocation(liveMcp, [server]) : undefined
      const liveField = liveServer ? findNodeAtLocation(liveServer, [field]) : undefined
      if (liveField && JSON.stringify(getNodeValue(liveField)) === JSON.stringify(value)) continue
      apply([mcpKey, server, field], value)
    }
    for (const { server, field } of edit.removeFields ?? []) {
      const liveTree = parseTree(current)
      const liveMcp = liveTree ? findNodeAtLocation(liveTree, [mcpKey]) : undefined
      const liveServer = liveMcp ? findNodeAtLocation(liveMcp, [server]) : undefined
      if (!liveServer || !findNodeAtLocation(liveServer, [field])) throw new McpEditError('MCP_BLOCK_MISSING', `Field ${server}.${field} is absent`)
      apply([mcpKey, server, field], undefined)
    }
    // Whole-container and legacy-key removals run last: an empty MCP block is
    // deleted only after its servers were removed individually, and legacy
    // container keys (for example a pre-migration mcpServers block in an
    // OpenCode config) are migrated away wholesale.
    if (edit.removeBlock) {
      current = removeRootProperty(current, mcpKey)
    }
    for (const legacyKey of edit.removeKeys ?? []) {
      current = removeRootProperty(current, legacyKey)
    }
    return current
  } finally {
    activeRaw = ''
  }
}

function formattingOptionsFor (raw: string): FormattingOptions {
  const match = raw.match(/^[^\S\n]*(?=\S)/m)
  const indent = match?.[0] ?? '  '
  return {
    tabSize: indent.includes('\t') ? 4 : Math.max(indent.replace(/\t/g, '  ').length, 1),
    insertSpaces: !indent.includes('\t'),
    eol: raw.includes('\r\n') ? '\r\n' : '\n',
  }
}

/**
 * Remove a root-level property (the MCP container or a legacy key) with a
 * localized text splice so bytes outside it (comments in particular) survive
 * byte-for-byte. Any whitespace-only line left at the splice junction is
 * collapsed locally; nothing else in the document is touched.
 */
function removeRootProperty (raw: string, key: string): string {
  const tree = parseTree(raw)
  if (!tree || tree.type !== 'object') return raw
  const property = (tree.children ?? []).find((candidate) => {
    const keyNode = candidate.children?.[0]
    return keyNode && getNodeValue(keyNode) === key
  })
  if (!property) return raw
  let start = property.offset
  let end = property.offset + property.length
  // Drop a trailing comma after the block when one follows it.
  let look = end
  while (look < raw.length && (raw[look] === ' ' || raw[look] === '\t')) look++
  if (raw[look] === ',') {
    end = look + 1
    while (end < raw.length && (raw[end] === ' ' || raw[end] === '\t')) end++
  } else {
    // Otherwise drop a preceding comma before the block.
    const head = raw.slice(0, start)
    const trimmedHead = head.replace(/,\s*$/, '')
    if (trimmedHead.length !== head.length) {
      start = trimmedHead.length
    }
  }
  let head = raw.slice(0, start)
  let tail = raw.slice(end)
  // Collapse whitespace left at the splice junction only: the indentation of
  // a now-empty last line in head, and a single blank line between head and
  // tail. Nothing else in the document is touched.
  const lastNewline = head.lastIndexOf('\n')
  const lastLine = head.slice(lastNewline + 1)
  if (tail.startsWith('\n') && lastLine.length > 0 && lastLine.trim() === '') {
    head = head.slice(0, lastNewline + 1)
  }
  if (head.endsWith('\n') && tail.startsWith('\n')) {
    tail = tail.slice(1)
  }
  return head + tail
}

function insertMcpBlockBeforeClosingBrace (raw: string, mcpKey: string, servers: Readonly<Record<string, unknown>>): string {
  // Locate the root object's real closing brace from the parsed tree: braces
  // inside comments or strings never participate in the structure.
  const errors: ParseError[] = []
  const tree = parseTree(raw, errors, { allowTrailingComma: true })
  if (!tree || tree.type !== 'object' || errors.length > 0) {
    return JSON.stringify({ [mcpKey]: servers }, null, 2) + '\n'
  }
  const lastCloseBrace = tree.offset + tree.length - 1
  const lineStart = raw.lastIndexOf('\n', lastCloseBrace)
  const indent = lineStart === -1 ? '  ' : (raw.slice(lineStart + 1, lastCloseBrace).match(/^(\s+)/)?.[1] ?? '  ')
  const innerIndent = indent.repeat(2)
  const eol = raw.includes('\r\n') ? '\r\n' : '\n'
  const innerContent = Object.entries(servers)
    .map(([name, value]) => innerIndent + JSON.stringify(name) + ': ' + JSON.stringify(value))
    .join(',' + eol)
  const block = JSON.stringify(mcpKey) + ': {' + eol + innerContent + eol + indent + '}'
  const before = raw.slice(0, lastCloseBrace)
  const after = raw.slice(lastCloseBrace)
  if (before.trimEnd().endsWith('{')) {
    return before + eol + indent + block + eol + after
  }
  // A trailing comma before the closing brace must not be duplicated.
  const trimmed = before.trimEnd().replace(/,\s*$/, '')
  return trimmed + ',' + eol + indent + block + eol + after
}
