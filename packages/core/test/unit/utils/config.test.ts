import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { readJsonFile, readTomlFile, parseJsonc, readJsoncFile } from '../../../src/utils/config.js'
import { writeTomlFileSync } from '../../../src/utils/config.js'

let tmpDir: string

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'nsolid-test-'))
})

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true })
})

describe('readJsonFile', () => {
  it('reads and parses valid JSON', () => {
    const file = join(tmpDir, 'test.json')
    writeFileSync(file, '{"key":"value","num":42}')
    const result = readJsonFile<{ key: string; num: number }>(file)
    assert.deepStrictEqual(result, { key: 'value', num: 42 })
  })

  it('returns null for missing file', () => {
    assert.strictEqual(readJsonFile(join(tmpDir, 'nonexistent.json')), null)
  })

  it('throws for invalid JSON', () => {
    const file = join(tmpDir, 'bad.json')
    writeFileSync(file, 'not json')
    assert.throws(() => readJsonFile(file), /Failed to parse/)
  })
})

describe('readTomlFile and writeTomlFileSync', () => {
  it('round-trips TOML data', () => {
    const file = join(tmpDir, 'config.toml')
    const data = {
      server: { host: 'localhost', port: 8080 },
      features: { enabled: true }
    }
    writeTomlFileSync(file, data)
    const result = readTomlFile<typeof data>(file)
    assert.deepStrictEqual(result, data)
  })

  it('returns null for missing TOML file', () => {
    assert.strictEqual(readTomlFile(join(tmpDir, 'none.toml')), null)
  })

  it('throws for invalid TOML', () => {
    const file = join(tmpDir, 'bad.toml')
    writeFileSync(file, '[[invalid]]]')
    assert.throws(() => readTomlFile(file), /Failed to parse/)
  })
})

describe('parseJsonc', () => {
  it('strips single-line comments', () => {
    const content = '{\n  // comment\n  "key": "value"\n}'
    assert.deepStrictEqual(parseJsonc(content), { key: 'value' })
  })

  it('strips block comments', () => {
    const content = '{\n  /* multi\n  line\n  comment */\n  "key": "value"\n}'
    assert.deepStrictEqual(parseJsonc(content), { key: 'value' })
  })

  it('handles trailing commas', () => {
    const content = '{"key": "value",}'
    assert.deepStrictEqual(parseJsonc(content), { key: 'value' })
  })

  it('preserves strings containing comment-like chars', () => {
    const content = '{"url": "https://example.com", "key": "value"}'
    assert.deepStrictEqual(parseJsonc(content), { url: 'https://example.com', key: 'value' })
  })

  it('preserves comma-close tokens inside strings', () => {
    const content = '{"token": ",}", "arrToken": ",]"}'
    assert.deepStrictEqual(parseJsonc(content), { token: ',}', arrToken: ',]' })
  })
})

describe('readJsoncFile', () => {
  it('parses JSONC file with comments', () => {
    const file = join(tmpDir, 'config.jsonc')
    writeFileSync(file, '{\n  // config\n  "name": "test",\n  "debug": true\n}')
    const result = readJsoncFile<{ name: string; debug: boolean }>(file)
    assert.deepStrictEqual(result, { name: 'test', debug: true })
  })

  it('returns null for missing JSONC file', () => {
    assert.strictEqual(readJsoncFile(join(tmpDir, 'nonexistent.jsonc')), null)
  })

  it('throws for invalid JSONC', () => {
    const file = join(tmpDir, 'bad.jsonc')
    writeFileSync(file, 'not json')
    assert.throws(() => readJsoncFile(file), /Failed to parse/)
  })
})
