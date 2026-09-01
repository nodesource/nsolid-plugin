import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { isRemotePath, mcpRecordIsExclusivelyOwned } from '../../../src/update/fallback-ownership.js'
import { readMcpFieldDigests, valueDigest } from '../../../src/update/mcp-lookup.js'

describe('fallback ownership paths', () => {
  it('classifies UNC and Windows device paths as remote destructive targets', () => {
    assert.equal(isRemotePath('\\\\server\\share\\skills'), true)
    assert.equal(isRemotePath('//server/share/skills'), true)
    assert.equal(isRemotePath('\\\\?\\UNC\\server\\share\\skills'), true)
    assert.equal(isRemotePath('C:\\Users\\alice\\skills'), false)
  })
})

describe('mcpRecordIsExclusivelyOwned', () => {
  let tmpDir: string

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'nsolid-ownership-'))
  })

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true })
  })

  function writeConfig (content: Record<string, unknown>): string {
    const configPath = join(tmpDir, '.claude.json')
    writeFileSync(configPath, JSON.stringify(content))
    return configPath
  }

  it('passes when live digests match the owned evidence exactly', () => {
    const configPath = writeConfig({
      mcpServers: { 'ns-benchmark': { url: 'https://example.com/mcp' } },
    })
    const owned = { url: valueDigest('https://example.com/mcp') }

    assert.equal(mcpRecordIsExclusivelyOwned(configPath, 'ns-benchmark', owned, 'mcpServers'), true)
  })

  it('fails when a foreign field was added to the owned record', () => {
    const configPath = writeConfig({
      mcpServers: { 'ns-benchmark': { url: 'https://example.com/mcp', headers: { 'x-a': '1' } } },
    })
    const owned = { url: valueDigest('https://example.com/mcp') }

    assert.equal(mcpRecordIsExclusivelyOwned(configPath, 'ns-benchmark', owned, 'mcpServers'), false)
  })

  it('fails when an owned field drifted', () => {
    const configPath = writeConfig({
      mcpServers: { 'ns-benchmark': { url: 'https://drifted.example/mcp' } },
    })
    const owned = { url: valueDigest('https://example.com/mcp') }

    assert.equal(mcpRecordIsExclusivelyOwned(configPath, 'ns-benchmark', owned, 'mcpServers'), false)
  })

  it('fails closed over missing records, foreign fields, and absent owned evidence', () => {
    const configPath = writeConfig({
      mcpServers: { 'ns-benchmark': { url: 'https://example.com/mcp' } },
    })

    // Missing record, foreign fields, and absent owned evidence all fail closed.
    assert.equal(mcpRecordIsExclusivelyOwned(configPath, 'foreign-server', { url: valueDigest('x') }, 'mcpServers'), false)
    assert.equal(mcpRecordIsExclusivelyOwned(configPath, 'ns-benchmark', { url: valueDigest('x') }, 'mcpServers'), false)
    assert.equal(mcpRecordIsExclusivelyOwned(configPath, 'ns-benchmark', undefined, 'mcpServers'), false)
    assert.equal(mcpRecordIsExclusivelyOwned(configPath, 'ns-benchmark', {}, 'mcpServers'), false)
  })

  it('requires every owned field to match, not merely the field set', () => {
    const configPath = writeConfig({
      mcpServers: { 'ns-benchmark': { url: 'https://example.com/mcp', note: 'kept' } },
    })
    const owned = { url: valueDigest('https://example.com/mcp'), note: valueDigest('drifted') }

    assert.equal(mcpRecordIsExclusivelyOwned(configPath, 'ns-benchmark', owned, 'mcpServers'), false)
  })

  it('describes the same container the harness prefers', () => {
    // The opencode container is "mcp"; a legacy "mcpServers" sibling must not
    // be digested. Verify the preferredKey is honored end to end.
    const configPath = writeConfig({
      mcpServers: { 'ns-benchmark': { url: 'https://legacy.example/mcp' } },
      mcp: { 'ns-benchmark': { type: 'remote', url: 'https://current.example/mcp' } },
    })
    const owned = { type: valueDigest('remote'), url: valueDigest('https://current.example/mcp') }

    assert.equal(mcpRecordIsExclusivelyOwned(configPath, 'ns-benchmark', owned, 'mcp'), true)
    assert.equal(mcpRecordIsExclusivelyOwned(configPath, 'ns-benchmark', { url: valueDigest('https://legacy.example/mcp') }, 'mcp'), false)
  })

  it('uses the same field digests the field-digests module computes', () => {
    const configPath = writeConfig({
      mcpServers: { 'ns-benchmark': { url: 'https://example.com/mcp' } },
    })
    const owned = readMcpFieldDigests(configPath, 'ns-benchmark', { preferredKey: 'mcpServers' })

    assert.equal(mcpRecordIsExclusivelyOwned(configPath, 'ns-benchmark', owned, 'mcpServers'), true)
  })
})
