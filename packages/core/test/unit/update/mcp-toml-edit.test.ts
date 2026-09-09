import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { editMcpTomlBytes, McpTomlEditError } from '../../../src/update/mcp-toml-edit.js'

describe('editMcpTomlBytes', () => {
  it('rewrites only owned value ranges in a CRLF document with comments, foreign tables, and inline comments', () => {
    const original = [
      '# top-level user comment',
      '[model]',
      'name = "gpt-5"',
      '',
      '[mcp_servers.alpha-console]',
      'url = "https://old.example/mcp"   # owned endpoint',
      'note = "keep-note"',
      'user_token = "user-secret"',
      '',
      '[mcp_servers.other]',
      'url = "https://other.example/mcp"',
    ].join('\r\n') + '\r\n'
    const expected = [
      '# top-level user comment',
      '[model]',
      'name = "gpt-5"',
      '',
      '[mcp_servers.alpha-console]',
      'url = "https://new.example.com/mcp"   # owned endpoint',
      'user_token = "user-secret"',
      '',
      '[mcp_servers.other]',
      'url = "https://other.example/mcp"',
    ].join('\r\n') + '\r\n'

    const next = editMcpTomlBytes(original, {
      setFields: [{ server: 'alpha-console', field: 'url', value: 'https://new.example.com/mcp' }],
      removeFields: [{ server: 'alpha-console', field: 'note' }],
    })

    assert.equal(next, expected)
    // The user-owned field survives byte-for-byte, including its CRLF ending.
    assert.ok(next.includes('user_token = "user-secret"\r\n'), next)
  })

  it('updates an owned structured value represented by a child table without rewriting siblings', () => {
    const original = [
      '[mcp_servers.alpha]',
      'url = "https://old.example/mcp"',
      'token = "t"',
      '',
      '[mcp_servers.alpha.headers]',
      'X-Old = "1"',
      '',
      '[mcp_servers.beta]',
      'url = "https://beta.example/mcp"',
    ].join('\n')
    const expected = [
      '[mcp_servers.alpha]',
      'url = "https://old.example/mcp"',
      'token = "t"',
      '',
      '[mcp_servers.alpha.headers]',
      'X-New = "2"',
      '',
      '[mcp_servers.beta]',
      'url = "https://beta.example/mcp"',
    ].join('\n')

    const next = editMcpTomlBytes(original, {
      setFields: [{ server: 'alpha', field: 'headers', value: { 'X-New': '2' } }],
    })

    assert.equal(next, expected)
  })

  it('removes an exclusively owned server including descendant tables and preserves ambiguous leading comments', () => {
    const original = [
      '# before alpha',
      '[mcp_servers.alpha]',
      'url = "https://a.example/mcp"',
      '',
      '[mcp_servers.alpha.cache]',
      'ttl = 30',
      '',
      '[model]',
      'name = "m"',
      '',
      '[mcp_servers.beta]',
      'url = "https://b.example/mcp"',
    ].join('\n')
    const expected = [
      '# before alpha',
      '[model]',
      'name = "m"',
      '',
      '[mcp_servers.beta]',
      'url = "https://b.example/mcp"',
    ].join('\n')

    const next = editMcpTomlBytes(original, { removeServers: ['alpha'] })

    assert.equal(next, expected)
  })

  it('fails closed when a removed server body contains an ambiguous standalone comment', () => {
    const original = '[mcp_servers.alpha]\n# why is this here\nurl = "https://a.example/mcp"\n'

    assert.throws(() => editMcpTomlBytes(original, { removeServers: ['alpha'] }), (error: unknown) => {
      assert.ok(error instanceof McpTomlEditError)
      assert.equal(error.code, 'MCP_BLOCK_INVALID')
      return true
    })
  })

  it('inserts a new exclusively owned server at the end using the document EOL without rewriting the prefix', () => {
    const original = '# user config\n[model]\nname = "m"\n'
    const expected = '# user config\n[model]\nname = "m"\n[mcp_servers.nsolid-console]\nurl = "https://n.example/mcp"\nheaders = {}\n'

    const next = editMcpTomlBytes(original, {
      upsertServers: { 'nsolid-console': { url: 'https://n.example/mcp', headers: {} } },
    })

    assert.equal(next, expected)
    assert.ok(next.startsWith(original), next)
  })

  it('inserts a new mixed server with structured-first key order into an empty document', () => {
    const next = editMcpTomlBytes('', {
      upsertServers: { alpha: { headers: { Authorization: 'x' }, url: 'https://example/mcp' } },
    })

    // Direct scalars must land under the server table; child tables come
    // after them regardless of source key order.
    assert.equal(next, '[mcp_servers.alpha]\nurl = "https://example/mcp"\n[mcp_servers.alpha.headers]\nAuthorization = "x"\n')
  })

  it('inserts a new mixed server with scalar-first key order into an empty document', () => {
    const next = editMcpTomlBytes('', {
      upsertServers: { alpha: { url: 'https://example/mcp', headers: { Authorization: 'x' } } },
    })

    assert.equal(next, '[mcp_servers.alpha]\nurl = "https://example/mcp"\n[mcp_servers.alpha.headers]\nAuthorization = "x"\n')
  })

  it('inserts a new mixed server into a populated CRLF document without rewriting the prefix', () => {
    const original = '# user config\r\n[owned-by-user]\r\nkey = 1\r\n'
    const next = editMcpTomlBytes(original, {
      upsertServers: { alpha: { headers: { Authorization: 'x' }, url: 'https://example/mcp' } },
    })

    assert.equal(next, original + '[mcp_servers.alpha]\r\nurl = "https://example/mcp"\r\n[mcp_servers.alpha.headers]\r\nAuthorization = "x"\r\n')
  })

  it('inserts a new mixed server with scalar-first key order into a populated LF document', () => {
    const original = '[owned-by-user]\nkey = 1\n'
    const next = editMcpTomlBytes(original, {
      upsertServers: { alpha: { url: 'https://example/mcp', headers: { Authorization: 'x' } } },
    })

    assert.equal(next, original + '[mcp_servers.alpha]\nurl = "https://example/mcp"\n[mcp_servers.alpha.headers]\nAuthorization = "x"\n')
  })

  it('rejects malformed TOML before any mutation', () => {
    const original = '[mcp_servers.alpha\nurl = "https://a.example/mcp"\n'

    assert.throws(() => editMcpTomlBytes(original, { removeServers: ['alpha'] }), (error: unknown) => {
      assert.ok(error instanceof McpTomlEditError)
      assert.equal(error.code, 'MCP_PARSE_FAILED')
      return true
    })
  })

  it('returns the original document when the requested operations are a semantic no-op', () => {
    const original = '[mcp_servers.alpha]\nurl = "https://a.example/mcp"\n'

    const next = editMcpTomlBytes(original, {
      setFields: [{ server: 'alpha', field: 'url', value: 'https://a.example/mcp' }],
    })

    assert.equal(next, original)
  })

  it('distinguishes TOML datetimes by instant instead of comparing them as empty records', () => {
    // smol-toml parses TOML datetimes as TomlDate, a Date subclass with no own
    // enumerable keys: without an explicit Date branch the deep comparison
    // would treat every datetime as an empty object and distinct datetimes as
    // equal. The editor must therefore refuse to install a changed datetime
    // value it cannot render byte-exactly, instead of silently accepting it.
    const original = '[mcp_servers.alpha]\nurl = "https://a.example/mcp"\nupdated_at = 2024-01-01T00:00:00Z\n'

    assert.throws(
      () => editMcpTomlBytes(original, {
        setFields: [{ server: 'alpha', field: 'updated_at', value: new Date('2024-01-02T00:00:00Z') }],
      }),
      (error: unknown) => {
        assert.ok(error instanceof McpTomlEditError)
        assert.equal(error.code, 'MCP_BLOCK_INVALID')
        return true
      }
    )

    // The identical instant is a semantic no-op: the document is returned
    // byte-for-byte, proving datetimes are compared by instant.
    const noOp = editMcpTomlBytes(original, {
      setFields: [{ server: 'alpha', field: 'updated_at', value: new Date('2024-01-01T00:00:00Z') }],
    })
    assert.equal(noOp, original)
  })

  it('matches quoted server and field names by decoded value', () => {
    const original = '[mcp_servers."alpha-console"]\nurl = "https://old.example/mcp"\n'
    const expected = '[mcp_servers."alpha-console"]\nurl = "https://new.example.com/mcp"\n'

    const next = editMcpTomlBytes(original, {
      setFields: [{ server: 'alpha-console', field: 'url', value: 'https://new.example.com/mcp' }],
    })

    assert.equal(next, expected)
  })

  it('removes an owned field represented by a descendant table and keeps following tables intact', () => {
    const original = [
      '[mcp_servers.alpha]',
      'url = "https://a.example/mcp"',
      '',
      '[mcp_servers.alpha.headers]',
      'X-Old = "1"',
      '',
      '[mcp_servers.beta]',
      'url = "https://beta.example/mcp"',
    ].join('\n')
    const expected = [
      '[mcp_servers.alpha]',
      'url = "https://a.example/mcp"',
      '',
      '[mcp_servers.beta]',
      'url = "https://beta.example/mcp"',
    ].join('\n')

    const next = editMcpTomlBytes(original, {
      removeFields: [{ server: 'alpha', field: 'headers' }],
    })

    assert.equal(next, expected)
  })
})
