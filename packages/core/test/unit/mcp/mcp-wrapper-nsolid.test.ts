import { afterEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// @ts-expect-error The repository's JavaScript generator intentionally has no TypeScript declarations.
import { generateMcpWrapper, MCP_REMOTE_VERSION } from '../../../../../scripts/plugin-generators.mjs'
import { readNsolidSettings } from '../../../src/auth/nsolid-settings.js'

const temporaryPaths: string[] = []

afterEach(() => {
  for (const temporaryPath of temporaryPaths.splice(0)) rmSync(temporaryPath, { recursive: true, force: true })
})

interface Fixture {
  directory: string
  home: string
  output: string
  wrapperPath: string
}

/** A home with an mcp-remote runtime whose proxy records its arguments, and no NodeSource credentials. */
function createFixture (): Fixture {
  const directory = mkdtempSync(join(tmpdir(), 'nsolid-server-wrapper-'))
  temporaryPaths.push(directory)
  const home = join(directory, 'home')
  const runtime = join(home, '.agents', 'nsolid-plugin', 'runtime', 'mcp-remote', MCP_REMOTE_VERSION, 'node_modules', 'mcp-remote')
  mkdirSync(join(runtime, 'dist'), { recursive: true })
  writeFileSync(join(runtime, 'package.json'), JSON.stringify({ name: 'mcp-remote', version: MCP_REMOTE_VERSION }))
  writeFileSync(join(runtime, 'dist', 'proxy.js'), "const { writeFileSync } = require('node:fs')\nwriteFileSync(process.env.NSOLID_TEST_OUTPUT, JSON.stringify(process.argv.slice(2)))\n")
  const wrapperPath = join(directory, 'mcp-wrapper.mjs')
  writeFileSync(wrapperPath, generateMcpWrapper())
  return { directory, home, output: join(directory, 'captured'), wrapperPath }
}

function runNsolid (fixture: Fixture, env: Record<string, string> = {}) {
  const base: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: fixture.home,
    USERPROFILE: fixture.home,
    NSOLID_TEST_OUTPUT: fixture.output,
  }
  delete base.NSOLID_MCP_RUNTIME_DEV_FALLBACK
  delete base.NSOLID_MCP_URL
  delete base.NSOLID_API_TOKEN
  return spawnSync(process.execPath, [fixture.wrapperPath, 'nsolid', 'claude'], {
    cwd: fixture.directory,
    env: { ...base, ...env },
    encoding: 'utf8',
    timeout: 15000,
  })
}

const proxyArgs = (fixture: Fixture) => JSON.parse(readFileSync(fixture.output, 'utf8')) as string[]

describe('nsolid MCP server through the wrapper', () => {
  it('bridges with nsolid settings from the environment, without NodeSource credentials', () => {
    const fixture = createFixture()
    const result = runNsolid(fixture, { NSOLID_MCP_URL: 'https://nsolid.example.test/mcp', NSOLID_API_TOKEN: 'sk_test' })
    assert.strictEqual(result.status, 0, result.stderr)
    assert.deepEqual(proxyArgs(fixture).slice(0, 3), ['https://nsolid.example.test/mcp', '--header', 'Authorization:Bearer sk_test'])
  })

  it('reads them from ~/.agents/.nsolid-auth.json, the environment winning', () => {
    const fixture = createFixture()
    writeFileSync(join(fixture.home, '.agents', '.nsolid-auth.json'), JSON.stringify({
      mcpUrl: 'https://file.example.test/mcp',
      token: 'from-file',
    }))
    assert.strictEqual(runNsolid(fixture).status, 0)
    assert.deepEqual(proxyArgs(fixture).slice(0, 3), ['https://file.example.test/mcp', '--header', 'Authorization:Bearer from-file'])
    assert.strictEqual(runNsolid(fixture, { NSOLID_API_TOKEN: 'from-env' }).status, 0)
    assert.strictEqual(proxyArgs(fixture)[2], 'Authorization:Bearer from-env')
  })

  it('says how to configure the N|Solid server when nothing is set', () => {
    const result = runNsolid(createFixture())
    assert.notStrictEqual(result.status, 0)
    assert.match(result.stderr, /N\|Solid is not configured: set NSOLID_MCP_URL and NSOLID_API_TOKEN/)
  })

  it('sends the token over plain http only to this machine', () => {
    const fixture = createFixture()
    const remote = runNsolid(fixture, { NSOLID_MCP_URL: 'http://nsolid.example.test/mcp', NSOLID_API_TOKEN: 't' })
    assert.notStrictEqual(remote.status, 0)
    assert.match(remote.stderr, /must use https/)
    const local = runNsolid(fixture, { NSOLID_MCP_URL: 'http://localhost:47091/mcp', NSOLID_API_TOKEN: 't' })
    assert.strictEqual(local.status, 0, local.stderr)
    assert.strictEqual(proxyArgs(fixture)[0], 'http://localhost:47091/mcp')
  })
})

describe('readNsolidSettings', () => {
  it('needs both the MCP URL and a token', () => {
    assert.deepEqual(readNsolidSettings({ NSOLID_MCP_URL: 'https://s.test/mcp', NSOLID_API_TOKEN: 'x' }), {
      mcpUrl: 'https://s.test/mcp',
      token: 'x',
    })
    if (readNsolidSettings({}) === null) {
      assert.strictEqual(readNsolidSettings({ NSOLID_MCP_URL: 'https://s.test/mcp' }), null)
    }
  })
})
