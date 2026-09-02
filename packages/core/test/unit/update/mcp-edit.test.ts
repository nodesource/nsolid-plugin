import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { detectJsonMcpKey, editMcpJsonBytes, McpEditError, readMcpNodeValue } from '../../../src/update/mcp-edit.js'
import { harnessMcpKey, mcpFieldDigestsFromBytes, readMcpFieldDigests, readMcpServerRecord, valueDigest } from '../../../src/update/mcp-lookup.js'
import { parseJsonc } from '../../../src/utils/config.js'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

describe('MCP byte-preserving AST edits', () => {
  it('rewrites only the owned server and preserves comments, foreign servers, and formatting', () => {
    const raw = [
      '{',
      '  // User comments belong to the user.',
      '  "otherKey": true,',
      '  "mcpServers": {',
      '    // A foreign server with its own comment.',
      '    "foreign": {"command": "/usr/bin/foreign"},',
      '    "nsolid-console": {"url": "https://old.example.com/mcp", "headers": {"AUTH": "x"}}',
      '  }',
      '}',
      '',
    ].join('\n')
    const next = editMcpJsonBytes(raw, {
      upsertServers: { 'nsolid-console': { url: 'https://new.example.com/mcp', headers: { AUTH: 'y' } } },
    })

    // The owned server changed.
    assert.ok(next.includes('https://new.example.com/mcp'))
    // Every foreign byte survived.
    assert.ok(next.includes('// User comments belong to the user.'))
    assert.ok(next.includes('// A foreign server with its own comment.'))
    assert.ok(next.includes('"foreign": {"command": "/usr/bin/foreign"}'))
    assert.ok(next.includes('"otherKey": true'))
    assert.ok(!next.includes('https://old.example.com/mcp'))
    const reparsed = parseJsonc(next) as { mcpServers: Record<string, { url: string }> }
    assert.equal(reparsed.mcpServers['nsolid-console'].url, 'https://new.example.com/mcp')
  })

  it('keeps CRLF line endings outside the edited bytes and uses CRLF for inserted lines', () => {
    const raw = '{\r\n  "keep": true,\r\n  "mcpServers": {\r\n    "old": {"url": "https://old"}\r\n  }\r\n}\r\n'
    const next = editMcpJsonBytes(raw, { upsertServers: { fresh: { url: 'https://fresh' } }, removeServers: ['old'] })
    assert.ok(next.includes('\r\n'))
    assert.ok(next.includes('"keep": true'))
    assert.ok(next.includes('"fresh"'))
    assert.ok(!next.includes('"old"'))
  })

  it('updates a single owned field inside an existing server without touching sibling fields', () => {
    const raw = '{\n  "mcpServers": {\n    "nsolid-console": {"url": "https://old", "headers": {"A": "b"}, "custom": "user-value"}\n  }\n}\n'
    const next = editMcpJsonBytes(raw, { setFields: [{ server: 'nsolid-console', field: 'url', value: 'https://new' }] })
    const parsed = JSON.parse(next) as { mcpServers: Record<string, Record<string, unknown>> }
    assert.equal(parsed.mcpServers['nsolid-console'].url, 'https://new')
    assert.equal(parsed.mcpServers['nsolid-console'].custom, 'user-value')
    assert.ok(next.includes('"custom": "user-value"'))
  })

  it('removes owned servers without disturbing unrelated content', () => {
    const raw = '{\n  "mcpServers": {\n    "keep-me": {"url": "https://keep"},\n    "stale-nsolid": {"url": "https://stale"}\n  },\n  "note": "mine"\n}\n'
    const next = editMcpJsonBytes(raw, { removeServers: ['stale-nsolid'] })
    const parsed = JSON.parse(next) as { mcpServers: Record<string, unknown>; note: string }
    assert.deepEqual(Object.keys(parsed.mcpServers), ['keep-me'])
    assert.equal(parsed.note, 'mine')
  })

  it('inserts the MCP block into a document without one, preserving existing bytes', () => {
    const raw = '{\n  "unrelated": {"a": 1}\n}\n'
    const next = editMcpJsonBytes(raw, { upsertServers: { 'nsolid-console': { url: 'https://x' } } })
    const parsed = JSON.parse(next) as { unrelated: unknown; mcpServers: Record<string, { url: string }> }
    assert.ok(next.includes('"unrelated": {"a": 1}'))
    assert.equal(parsed.mcpServers['nsolid-console'].url, 'https://x')
  })

  it('fails closed instead of replacing scalar, null, or array MCP containers', () => {
    for (const scalar of ['null', '[]', '"applied"', '3']) {
      const raw = `{\n  "keep": true,\n  "mcp": ${scalar}\n}\n`
      assert.throws(
        () => editMcpJsonBytes(raw, { upsertServers: { fresh: { url: 'https://fresh' } } }, { mcpKey: detectJsonMcpKey(raw, 'mcp') }),
        (error: unknown) => error instanceof McpEditError && error.code === 'MCP_BLOCK_INVALID'
      )
    }
    // A scalar preferred key is never overwritten even when a legacy object exists.
    const withLegacy = '{\n  "mcpServers": {"old": {"url": "https://old"}},\n  "mcp": "text"\n}\n'
    assert.throws(() => detectJsonMcpKey(withLegacy, 'mcp'), (error: unknown) => error instanceof McpEditError && error.code === 'MCP_BLOCK_INVALID')
  })

  it('fails closed with MCP_BLOCK_INVALID for ownership edits over a scalar container', () => {
    const raw = '{\n  "mcp": "user data",\n  "other": true\n}\n'
    for (const edit of [
      { removeServers: ['nsolid-console'] },
      { setFields: [{ server: 'nsolid-console', field: 'url', value: 'https://x' }] },
      { removeFields: [{ server: 'nsolid-console', field: 'url' }] },
    ]) {
      let thrown: McpEditError | undefined
      try {
        editMcpJsonBytes(raw, edit, { mcpKey: 'mcp' })
      } catch (error) {
        thrown = error as McpEditError
      }
      assert.ok(thrown instanceof McpEditError, `edit ${JSON.stringify(edit)} must throw`)
      assert.equal(thrown!.code, 'MCP_BLOCK_INVALID')
    }
    // The document was not modified by any failed attempt.
    assert.equal(raw, '{\n  "mcp": "user data",\n  "other": true\n}\n')
  })

  it('selects the harness-preferred container and keeps live and staged digests identical', () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'nsolid-mcp-container-'))
    try {
      assert.equal(harnessMcpKey('opencode'), 'mcp')
      assert.equal(harnessMcpKey('claude'), 'mcpServers')
      const configPath = path.join(root, 'opencode.jsonc')
      const raw = '{\n  "mcpServers": {"server": {"url": "https://legacy"}},\n  "mcp": {"server": {"url": "https://preferred"}}\n}\n'
      writeFileSync(configPath, raw)
      // Preferred key wins over the legacy container.
      const record = readMcpServerRecord(configPath, 'server', { preferredKey: 'mcp' })
      assert.deepEqual(record, { url: 'https://preferred' })
      const liveDigests = readMcpFieldDigests(configPath, 'server', { preferredKey: 'mcp' })
      assert.equal(liveDigests?.url, valueDigest('https://preferred'))
      // Staged bytes produce identical evidence.
      const stagedDigests = mcpFieldDigestsFromBytes(configPath, raw, 'server', { preferredKey: 'mcp' })
      assert.deepEqual(stagedDigests, liveDigests)
      // Default precedence for non-OpenCode harnesses keeps mcpServers first.
      const defaultRecord = readMcpServerRecord(configPath, 'server')
      assert.deepEqual(defaultRecord, { url: 'https://legacy' })
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('leaves blank lines inside unrelated nested objects untouched when removing the block', () => {
    // The unrelated nested object deliberately contains a blank line; the
    // splice collapse must only touch whitespace at the removal junction.
    const raw = '{\n  "outer": {\n    "a": 1,\n\n    "b": 2\n  },\n  "mcp": {\n    "stale": {"url": "https://stale"}\n  }\n}\n'
    const next = editMcpJsonBytes(raw, { removeServers: ['stale'], removeBlock: true }, { mcpKey: 'mcp' })
    const parsed = parseJsonc(next) as { outer: Record<string, number> }
    assert.deepEqual(parsed.outer, { a: 1, b: 2 })
    assert.ok(next.includes('"a": 1,\n\n    "b": 2'), 'the unrelated nested blank line must survive')
    assert.ok(!next.includes('mcp'))
  })

  it('inserts the block via the parsed root when comments or strings contain braces', () => {
    const lineComment = '{\n  // a foreign } brace lives here\n  "keep": true\n}\n'
    const fromLine = editMcpJsonBytes(lineComment, { upsertServers: { fresh: { url: 'https://fresh' } } }, { mcpKey: 'mcpServers' })
    assert.deepEqual(parseJsonc(fromLine), { keep: true, mcpServers: { fresh: { url: 'https://fresh' } } })
    assert.ok(fromLine.includes('// a foreign } brace lives here'), 'the foreign line comment survives')

    const blockComment = '{\n  /* unbalanced } brace */\n  "keep": true\n}\n'
    const fromBlock = editMcpJsonBytes(blockComment, { upsertServers: { fresh: { url: 'https://fresh' } } }, { mcpKey: 'mcpServers' })
    assert.deepEqual(parseJsonc(fromBlock), { keep: true, mcpServers: { fresh: { url: 'https://fresh' } } })
    assert.ok(fromBlock.includes('/* unbalanced } brace */'), 'the foreign block comment survives')

    const withString = '{\n  "note": "brace } here",\n  "keep": true\n}\n'
    const fromString = editMcpJsonBytes(withString, { upsertServers: { fresh: { url: 'https://fresh' } } }, { mcpKey: 'mcpServers' })
    assert.deepEqual(parseJsonc(fromString), { note: 'brace } here', keep: true, mcpServers: { fresh: { url: 'https://fresh' } } })

    const crlfComment = '{\r\n  // closing } in comment\r\n  "keep": true\r\n}\r\n'
    const fromCrlf = editMcpJsonBytes(crlfComment, { upsertServers: { fresh: { url: 'https://fresh' } } }, { mcpKey: 'mcpServers' })
    assert.deepEqual(parseJsonc(fromCrlf), { keep: true, mcpServers: { fresh: { url: 'https://fresh' } } })
    assert.ok(fromCrlf.includes('\r\n'), 'CRLF endings survive')
  })

  it('rejects structurally invalid documents and impossible structural edits', () => {
    assert.throws(() => editMcpJsonBytes('{ not json', { removeBlock: true }), McpEditError)
    assert.throws(() => editMcpJsonBytes('{"unrelated": 1}', { removeServers: ['ghost'] }), (error: unknown) => {
      return error instanceof McpEditError && error.code === 'MCP_BLOCK_MISSING'
    })
  })

  it('fails closed with MCP_BLOCK_MISSING when an empty document receives structural edits', () => {
    for (const edit of [
      { removeServers: ['nsolid-console'] },
      { setFields: [{ server: 'nsolid-console', field: 'url', value: 'https://x' }] },
      { removeFields: [{ server: 'nsolid-console', field: 'url' }] },
    ]) {
      assert.throws(() => editMcpJsonBytes('', edit), (error: unknown) => {
        assert.ok(error instanceof McpEditError)
        assert.equal(error.code, 'MCP_BLOCK_MISSING')
        return true
      })
      // Whitespace-only documents behave the same as empty ones.
      assert.throws(() => editMcpJsonBytes(' \n\t ', edit), (error: unknown) => {
        assert.ok(error instanceof McpEditError)
        assert.equal(error.code, 'MCP_BLOCK_MISSING')
        return true
      })
    }
    // A pure upsert against an empty document still creates the container.
    const created = editMcpJsonBytes('', { upsertServers: { 'nsolid-console': { url: 'https://fresh' } } })
    assert.deepEqual(JSON.parse(created), { mcpServers: { 'nsolid-console': { url: 'https://fresh' } } })
  })

  it('reads node values without mutating the document', () => {
    const raw = '{\n  "mcpServers": {"s": {"url": "https://x", "n": 3, "b": true, "z": null}}\n}\n'
    assert.equal(readMcpNodeValue(raw, ['mcpServers', 's', 'url']), 'https://x')
    assert.equal(readMcpNodeValue(raw, ['mcpServers', 's', 'n']), 3)
    assert.equal(readMcpNodeValue(raw, ['mcpServers', 's', 'b']), true)
    assert.equal(readMcpNodeValue(raw, ['mcpServers', 's', 'z']), null)
    assert.equal(readMcpNodeValue(raw, ['mcpServers', 's', 'missing']), undefined)
  })
})
