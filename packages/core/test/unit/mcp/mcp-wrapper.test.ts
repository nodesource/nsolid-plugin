import { afterEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { chmodSync, cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'

// @ts-expect-error The repository's JavaScript generator intentionally has no TypeScript declarations.
import { generateMcpWrapper, MCP_REMOTE_VERSION as GENERATOR_VERSION } from '../../../../../scripts/plugin-generators.mjs'
import { MCP_REMOTE_VERSION as CORE_VERSION } from '../../../src/mcp/mcp-remote-runtime.js'

const repoRoot = join(import.meta.dirname, '..', '..', '..', '..', '..')
const sourceWrapper = join(repoRoot, 'scripts', 'mcp-wrapper.js')
const rootPackageJson = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8')) as { dependencies?: Record<string, string> }
const url = 'https://example.test/a path?q=one&redirect=%PATH%&quote="hello world"'
const token = 'tok en&%PATH%"quoted value"'
const temporaryPaths: string[] = []

afterEach(() => {
  for (const temporaryPath of temporaryPaths.splice(0)) rmSync(temporaryPath, { recursive: true, force: true })
})

interface Fixture {
  directory: string
  wrapperPath: string
  home: string
  bin: string
  output: string
}

function createWrapperFixture (wrapper: 'source' | 'generated'): Fixture {
  const directory = mkdtempSync(join(tmpdir(), 'nsolid-mcp-wrapper-'))
  temporaryPaths.push(directory)
  // The wrapper lives in a directory WITHOUT node_modules so the dev
  // createRequire fallback cannot mask a broken stable-runtime path.
  const wrapperPath = join(directory, 'mcp-wrapper.mjs')
  if (wrapper === 'source') cpSync(sourceWrapper, wrapperPath)
  else writeFileSync(wrapperPath, generateMcpWrapper())
  const home = join(directory, 'home')
  const bin = join(directory, 'bin')
  const output = join(directory, 'captured')
  mkdirSync(join(home, '.agents'), { recursive: true })
  mkdirSync(bin)
  writeFileSync(join(home, '.agents', '.nodesource-auth.json'), JSON.stringify({
    serviceToken: token, organizationId: 'org', consoleUrl: 'https://console.example.test', mcpUrl: url, expiresAt: '2099-01-01T00:00:00.000Z',
  }))
  return { directory, wrapperPath, home, bin, output }
}

function seedRuntime (home: string, version: string = CORE_VERSION): string {
  const dir = join(home, '.agents', 'nsolid-plugin', 'runtime', 'mcp-remote', version, 'node_modules', 'mcp-remote')
  mkdirSync(join(dir, 'dist'), { recursive: true })
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'mcp-remote', version }))
  writeFileSync(join(dir, 'dist', 'proxy.js'), "const { writeFileSync } = require('node:fs')\nwriteFileSync(process.env.NSOLID_TEST_OUTPUT, JSON.stringify(process.argv.slice(2)))\n")
  return dir
}

function wrapperEnvironment (fixture: Fixture, extraPath?: string): NodeJS.ProcessEnv {
  const pathPrefix = extraPath ? `${extraPath}${delimiter}` : ''
  return {
    ...process.env,
    HOME: fixture.home,
    USERPROFILE: fixture.home,
    PATH: `${pathPrefix}${fixture.bin}${delimiter}${process.env.PATH}`,
    NSOLID_TEST_OUTPUT: fixture.output,
  }
}

function writeNpxSentinel (fixture: Fixture): string {
  const sentinelMarker = join(fixture.directory, 'npx-ran')
  const npxName = process.platform === 'win32' ? 'npx.cmd' : 'npx'
  const npx = join(fixture.bin, npxName)
  if (process.platform === 'win32') {
    writeFileSync(npx, `@echo off\r\necho pwned > "${sentinelMarker}"\r\nexit /b 97\r\n`)
  } else {
    writeFileSync(npx, `#!/bin/sh\necho pwned > "${sentinelMarker}"\nexit 97\n`)
    chmodSync(npx, 0o755)
  }
  return sentinelMarker
}

describe('MCP wrapper runtime contract', () => {
  it('keeps the mcp-remote version in sync across core, generator and package.json', () => {
    assert.strictEqual(GENERATOR_VERSION, CORE_VERSION)
    assert.strictEqual(rootPackageJson.dependencies?.['mcp-remote'], CORE_VERSION)
    // The generated wrapper embeds the version for its stable-path resolution.
    assert.ok(generateMcpWrapper().includes(`'${CORE_VERSION}'`))
  })

  it('contains no shell, npx or cmd.exe execution paths', () => {
    const stripComments = (source: string) =>
      source.replace(/\/\*[\s\S]*?\*\//g, '').split('\n').filter((line) => !line.trim().startsWith('//')).join('\n')
    for (const raw of [readFileSync(sourceWrapper, 'utf8'), generateMcpWrapper()]) {
      const source = stripComments(raw)
      assert.ok(!source.includes('child_process'), 'no child_process import')
      assert.ok(!/\bspawn\s*\(/.test(source), 'no spawn call')
      assert.ok(!source.includes('cmd.exe'), 'no cmd.exe')
      assert.ok(!source.includes('npx.cmd'), 'no npx.cmd')
      assert.ok(!source.includes('NSOLID_MCP_REMOTE_PAYLOAD'), 'no npx payload bootstrap')
      assert.ok(!/shell\s*:\s*true/.test(source), 'no shell:true')
    }
  })
})

describe('MCP wrapper stable runtime', () => {
  for (const wrapper of ['source', 'generated'] as const) {
    it(`${wrapper} wrapper imports the stable runtime and preserves argv boundaries`, () => {
      const fixture = createWrapperFixture(wrapper)
      seedRuntime(fixture.home)
      const sentinel = writeNpxSentinel(fixture)

      const result = spawnSync(process.execPath, [fixture.wrapperPath, 'nsolid-console', 'claude'], {
        cwd: fixture.directory,
        env: wrapperEnvironment(fixture),
        encoding: 'utf8',
      })
      assert.strictEqual(result.status, 0, result.stderr)
      // URL/token with spaces, quotes, & and %PATH% arrive as intact argv
      // elements — no shell ever re-parsed them.
      assert.deepStrictEqual(JSON.parse(readFileSync(fixture.output, 'utf8')), [
        url, '--header', `X-Nsolid-Service-Token:${token}`, '--transport', 'http-first', '--silent',
      ])
      assert.ok(!readFileSync(sentinel, { encoding: 'utf8', flag: 'a+' }).toString().includes('pwned'), 'npx sentinel never ran')
    })

    it(`${wrapper} wrapper passes the org header for ns-benchmark`, () => {
      const fixture = createWrapperFixture(wrapper)
      seedRuntime(fixture.home)

      const result = spawnSync(process.execPath, [fixture.wrapperPath, 'ns-benchmark', 'codex'], {
        cwd: fixture.directory,
        env: wrapperEnvironment(fixture),
        encoding: 'utf8',
      })
      assert.strictEqual(result.status, 0, result.stderr)
      assert.deepStrictEqual(JSON.parse(readFileSync(fixture.output, 'utf8')), [
        'https://benchmark.mcp.saas.nodesource.io/mcp',
        '--header', 'X-Nsolid-Org-Id:org',
        '--header', `X-Nsolid-Service-Token:${token}`,
        '--transport', 'http-first', '--silent',
      ])
    })

    it(`${wrapper} wrapper fails fast when the runtime is missing`, () => {
      const fixture = createWrapperFixture(wrapper)
      const sentinel = writeNpxSentinel(fixture)

      const result = spawnSync(process.execPath, [fixture.wrapperPath, 'nsolid-console', 'codex'], {
        cwd: fixture.directory,
        env: wrapperEnvironment(fixture),
        encoding: 'utf8',
        timeout: 15000,
      })

      assert.notStrictEqual(result.status, 0)
      assert.match(result.stderr, /MCP bridge runtime is not ready\. Run: npx -y nsolid-plugin setup --harness codex/)
      assert.ok(!readFileSync(sentinel, { encoding: 'utf8', flag: 'a+' }).toString().includes('pwned'), 'npx sentinel never ran')
      assert.ok(!fixture.output || !readFileSync(fixture.output, { encoding: 'utf8', flag: 'a+' }).toString(), 'no proxy output')
    })

    it(`${wrapper} wrapper fails fast when the runtime version does not match`, () => {
      const fixture = createWrapperFixture(wrapper)
      seedRuntime(fixture.home, '0.1.37')

      const result = spawnSync(process.execPath, [fixture.wrapperPath, 'nsolid-console', 'antigravity'], {
        cwd: fixture.directory,
        env: wrapperEnvironment(fixture),
        encoding: 'utf8',
        timeout: 15000,
      })

      assert.notStrictEqual(result.status, 0)
      assert.match(result.stderr, /MCP bridge runtime is not ready\. Run: npx -y nsolid-plugin setup --harness antigravity/)
    })

    it(`${wrapper} wrapper rejects a corrupt runtime (missing dist/proxy.js)`, () => {
      const fixture = createWrapperFixture(wrapper)
      const dir = seedRuntime(fixture.home)
      rmSync(join(dir, 'dist', 'proxy.js'))

      const result = spawnSync(process.execPath, [fixture.wrapperPath, 'ncm', 'claude'], {
        cwd: fixture.directory,
        env: wrapperEnvironment(fixture),
        encoding: 'utf8',
        timeout: 15000,
      })

      assert.notStrictEqual(result.status, 0)
      assert.match(result.stderr, /MCP bridge runtime is not ready\. Run: npx -y nsolid-plugin setup --harness claude/)
    })

    it(`${wrapper} wrapper reports credentials problems before touching the runtime`, () => {
      const fixture = createWrapperFixture(wrapper)
      writeFileSync(join(fixture.home, '.agents', '.nodesource-auth.json'), JSON.stringify({
        serviceToken: token, organizationId: 'org', consoleUrl: 'https://console.example.test', mcpUrl: url, expiresAt: '2020-01-01T00:00:00.000Z',
      }))
      const sentinel = writeNpxSentinel(fixture)

      const result = spawnSync(process.execPath, [fixture.wrapperPath, 'nsolid-console', 'codex'], {
        cwd: fixture.directory,
        env: wrapperEnvironment(fixture),
        encoding: 'utf8',
      })

      assert.notStrictEqual(result.status, 0)
      assert.match(result.stderr, /credentials are expired\. Run: npx -y nsolid-plugin setup --harness codex/)
      assert.ok(!readFileSync(sentinel, { encoding: 'utf8', flag: 'a+' }).toString().includes('pwned'), 'npx sentinel never ran')
    })

    it(`${wrapper} wrapper validates the server name and harness argument`, () => {
      const fixture = createWrapperFixture(wrapper)
      const invalidServer = spawnSync(process.execPath, [fixture.wrapperPath, 'not-a-server', 'codex'], {
        cwd: fixture.directory,
        env: wrapperEnvironment(fixture),
        encoding: 'utf8',
      })
      assert.notStrictEqual(invalidServer.status, 0)
      assert.match(invalidServer.stderr, /Unknown NodeSource MCP server: not-a-server/)

      const missingHarness = spawnSync(process.execPath, [fixture.wrapperPath, 'ncm'], {
        cwd: fixture.directory,
        env: wrapperEnvironment(fixture),
        encoding: 'utf8',
      })
      assert.notStrictEqual(missingHarness.status, 0)
      assert.match(missingHarness.stderr, /Invalid harness argument/)
    })

    it(`${wrapper} wrapper names the requesting harness in every repair message`, () => {
      const fixture = createWrapperFixture(wrapper)
      for (const harness of ['claude', 'codex', 'antigravity'] as const) {
        const result = spawnSync(process.execPath, [fixture.wrapperPath, 'ncm', harness], {
          cwd: fixture.directory,
          env: wrapperEnvironment(fixture),
          encoding: 'utf8',
          timeout: 15000,
        })
        assert.notStrictEqual(result.status, 0)
        assert.match(result.stderr, new RegExp(`setup --harness ${harness}`))
      }
    })
  }

  it('generated wrapper matches the committed source wrapper byte for byte', () => {
    // The root artifact must be the generator output — no manual drift.
    assert.strictEqual(readFileSync(sourceWrapper, 'utf8'), generateMcpWrapper())
  })

  it('never resolves mcp-remote from a node_modules next to the wrapper', () => {
    // Simulate a "dev checkout" resolution that would mask a missing stable
    // runtime: plant a copy next to the wrapper and prove it is NOT used
    // unless version-matched — here with the wrong version it must be ignored.
    const fixture = createWrapperFixture('source')
    const local = join(fixture.directory, 'node_modules', 'mcp-remote', 'dist')
    mkdirSync(local, { recursive: true })
    writeFileSync(join(fixture.directory, 'node_modules', 'mcp-remote', 'package.json'), JSON.stringify({ name: 'mcp-remote', version: '0.1.37' }))
    writeFileSync(join(local, 'proxy.js'), "require('node:fs').writeFileSync(process.env.NSOLID_TEST_OUTPUT, 'local-proxy')\n")

    const result = spawnSync(process.execPath, [fixture.wrapperPath, 'ncm', 'codex'], {
      cwd: fixture.directory,
      env: wrapperEnvironment(fixture),
      encoding: 'utf8',
      timeout: 15000,
    })

    assert.notStrictEqual(result.status, 0, 'wrong-version local copy must be rejected')
    assert.match(result.stderr, /MCP bridge runtime is not ready/)
  })
})
