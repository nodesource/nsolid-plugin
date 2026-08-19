import { afterEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { chmodSync, cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { pathToFileURL } from 'node:url'

// @ts-expect-error The repository's JavaScript generator intentionally has no TypeScript declarations.
import { generateMcpWrapper } from '../../../../../scripts/plugin-generators.mjs'

const repoRoot = join(import.meta.dirname, '..', '..', '..', '..', '..')
const sourceWrapper = join(repoRoot, 'scripts', 'mcp-wrapper.js')
const url = 'https://example.test/a path?q=one&redirect=%PATH%&quote="hello world"'
const token = 'tok en&%PATH%"quoted value"'
const temporaryPaths: string[] = []

afterEach(() => {
  for (const temporaryPath of temporaryPaths.splice(0)) rmSync(temporaryPath, { recursive: true, force: true })
})

function createWrapperFixture (wrapper: 'source' | 'generated'): { directory: string, wrapperPath: string, home: string, bin: string, output: string } {
  const directory = mkdtempSync(join(tmpdir(), 'nsolid-mcp-wrapper-'))
  temporaryPaths.push(directory)
  const wrapperPath = join(directory, 'mcp-wrapper.mjs')
  if (wrapper === 'source') cpSync(sourceWrapper, wrapperPath)
  else writeFileSync(wrapperPath, generateMcpWrapper('claude'))
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

function wrapperEnvironment (fixture: ReturnType<typeof createWrapperFixture>): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = { ...process.env, HOME: fixture.home, USERPROFILE: fixture.home, PATH: `${fixture.bin}${delimiter}${process.env.PATH}`, NSOLID_TEST_OUTPUT: fixture.output }
  delete environment.NSOLID_TEST_SYSTEM_ROOT
  if (process.platform === 'win32') {
    const hook = join(fixture.directory, 'override-exec-path.mjs')
    writeFileSync(hook, [
      `Object.defineProperty(process, 'execPath', { value: ${JSON.stringify(join(fixture.bin, 'node.exe'))} })`,
      'if (process.env.NSOLID_TEST_SYSTEM_ROOT !== undefined) {',
      '  process.env.SystemRoot = process.env.NSOLID_TEST_SYSTEM_ROOT',
      '  delete process.env.NSOLID_TEST_SYSTEM_ROOT',
      '}',
    ].join('\n'))
    const importHook = `--import=${pathToFileURL(hook).href}`
    environment.NODE_OPTIONS = [process.env.NODE_OPTIONS, importHook].filter(Boolean).join(' ')
  }
  return environment
}

describe('MCP wrapper fallback', () => {
  it('bootstrap resolves the proxy from npx\'s node_modules directory', () => {
    const directory = mkdtempSync(join(tmpdir(), 'nsolid-mcp-bootstrap-'))
    temporaryPaths.push(directory)
    const bin = join(directory, 'node_modules', '.bin')
    const binName = process.platform === 'win32' ? 'mcp-remote.cmd' : 'mcp-remote'
    const proxy = join(directory, 'node_modules', 'mcp-remote', 'dist', 'proxy.js')
    const output = join(directory, 'argv.json')
    mkdirSync(bin, { recursive: true })
    mkdirSync(join(directory, 'node_modules', 'mcp-remote', 'dist'), { recursive: true })
    writeFileSync(join(bin, binName), '')
    writeFileSync(proxy, "const { writeFileSync } = require('node:fs')\nwriteFileSync(process.env.NSOLID_TEST_OUTPUT, JSON.stringify(process.argv.slice(2)))\n")

    const source = readFileSync(sourceWrapper, 'utf8')
    const bootstrapLiteral = source.match(/const MCP_REMOTE_NPX_BOOTSTRAP = (".*")/)
    assert.ok(bootstrapLiteral)
    const bootstrap = `data:text/javascript;base64,${Buffer.from(JSON.parse(bootstrapLiteral[1])).toString('base64')}`
    const payload = Buffer.from(JSON.stringify({ url, headers: { 'X-Nsolid-Service-Token': token } })).toString('base64url')
    const result = spawnSync(process.execPath, ['--input-type=module', '--eval', 'await import(process.env.NSOLID_MCP_REMOTE_BOOTSTRAP)'], {
      env: { ...process.env, PATH: `${bin}${delimiter}${process.env.PATH}`, NSOLID_MCP_REMOTE_BOOTSTRAP: bootstrap, NSOLID_MCP_REMOTE_PAYLOAD: payload, NSOLID_TEST_OUTPUT: output },
      encoding: 'utf8',
    })
    assert.strictEqual(result.status, 0, result.stderr)
    assert.deepStrictEqual(JSON.parse(readFileSync(output, 'utf8')), [url, '--header', `X-Nsolid-Service-Token:${token}`, '--transport', 'http-first', '--silent'])
  })

  for (const wrapper of ['source', 'generated'] as const) {
    it(`${wrapper} wrapper derives the console MCP URL from the org id when no mcpUrl is stored`, { skip: process.platform === 'win32' }, () => {
      const fixture = createWrapperFixture(wrapper)
      // Blank out the stored mcpUrl so the wrapper must derive it from
      // consoleUrl + org id (matching the TS deriveMcpUrlFromConsoleUrl).
      writeFileSync(join(fixture.home, '.agents', '.nodesource-auth.json'), JSON.stringify({
        serviceToken: token, organizationId: 'org-123', consoleUrl: 'https://pretty-name.saas.nodesource.io', mcpUrl: '', expiresAt: '2099-01-01T00:00:00.000Z',
      }))
      const npx = join(fixture.bin, 'npx')
      writeFileSync(npx, '#!/bin/sh\nprintf "%s\\n" "$@" > "$NSOLID_TEST_OUTPUT"\n')
      chmodSync(npx, 0o755)

      const result = spawnSync(process.execPath, [fixture.wrapperPath, 'nsolid-console'], { env: wrapperEnvironment(fixture), encoding: 'utf8' })
      assert.strictEqual(result.status, 0, result.stderr)
      const args = readFileSync(fixture.output, 'utf8').trimEnd().split('\n')
      assert.strictEqual(args[2], 'https://org-123.mcp.saas.nodesource.io/')
    })

    it(`${wrapper} wrapper forces https on the derived MCP URL even for an http consoleUrl`, { skip: process.platform === 'win32' }, () => {
      const fixture = createWrapperFixture(wrapper)
      writeFileSync(join(fixture.home, '.agents', '.nodesource-auth.json'), JSON.stringify({
        serviceToken: token, organizationId: 'org-456', consoleUrl: 'http://pretty-name.saas.nodesource.io', mcpUrl: '', expiresAt: '2099-01-01T00:00:00.000Z',
      }))
      const npx = join(fixture.bin, 'npx')
      writeFileSync(npx, '#!/bin/sh\nprintf "%s\\n" "$@" > "$NSOLID_TEST_OUTPUT"\n')
      chmodSync(npx, 0o755)

      const result = spawnSync(process.execPath, [fixture.wrapperPath, 'nsolid-console'], { env: wrapperEnvironment(fixture), encoding: 'utf8' })
      assert.strictEqual(result.status, 0, result.stderr)
      const args = readFileSync(fixture.output, 'utf8').trimEnd().split('\n')
      assert.strictEqual(args[2], 'https://org-456.mcp.saas.nodesource.io/')
    })

    it(`${wrapper} wrapper rejects a console URL that is not a recognized NodeSource SaaS host`, { skip: process.platform === 'win32' }, () => {
      const fixture = createWrapperFixture(wrapper)
      writeFileSync(join(fixture.home, '.agents', '.nodesource-auth.json'), JSON.stringify({
        serviceToken: token, organizationId: 'org-123', consoleUrl: 'https://console.example.com', mcpUrl: '', expiresAt: '2099-01-01T00:00:00.000Z',
      }))
      const npx = join(fixture.bin, 'npx')
      writeFileSync(npx, '#!/bin/sh\nexit 0\n')
      chmodSync(npx, 0o755)

      const result = spawnSync(process.execPath, [fixture.wrapperPath, 'nsolid-console'], { env: wrapperEnvironment(fixture), encoding: 'utf8' })
      assert.notStrictEqual(result.status, 0)
      assert.match(result.stderr, /Could not derive NodeSource console MCP URL/)
    })

    it(`${wrapper} wrapper preserves argv boundaries outside Windows`, { skip: process.platform === 'win32' }, () => {
      const fixture = createWrapperFixture(wrapper)
      const npx = join(fixture.bin, 'npx')
      writeFileSync(npx, '#!/bin/sh\nprintf "%s\\n" "$@" > "$NSOLID_TEST_OUTPUT"\n')
      chmodSync(npx, 0o755)

      const result = spawnSync(process.execPath, [fixture.wrapperPath, 'nsolid-console'], { env: wrapperEnvironment(fixture), encoding: 'utf8' })
      assert.strictEqual(result.status, 0, result.stderr)
      assert.deepStrictEqual(readFileSync(fixture.output, 'utf8').trimEnd().split('\n'), [
        '-y', 'mcp-remote@0.1.38', url, '--header', `X-Nsolid-Service-Token:${token}`, '--transport', 'http-first', '--silent',
      ])
    })

    it(`${wrapper} wrapper migrates a stored legacy alias-derived mcpUrl to the org-UUID route`, { skip: process.platform === 'win32' }, () => {
      const fixture = createWrapperFixture(wrapper)
      // The previous release stored the alias-derived (dead) endpoint. It must
      // be replaced by the org-UUID route even though a value is present.
      writeFileSync(join(fixture.home, '.agents', '.nodesource-auth.json'), JSON.stringify({
        serviceToken: token, organizationId: 'org-123', consoleUrl: 'https://homedepot-nucleus-stage-1.saas.nodesource.io', mcpUrl: 'https://homedepot-nucleus-stage-1.mcp.saas.nodesource.io/', expiresAt: '2099-01-01T00:00:00.000Z',
      }))
      const npx = join(fixture.bin, 'npx')
      writeFileSync(npx, '#!/bin/sh\nprintf "%s\\n" "$@" > "$NSOLID_TEST_OUTPUT"\n')
      chmodSync(npx, 0o755)

      const result = spawnSync(process.execPath, [fixture.wrapperPath, 'nsolid-console'], { env: wrapperEnvironment(fixture), encoding: 'utf8' })
      assert.strictEqual(result.status, 0, result.stderr)
      const args = readFileSync(fixture.output, 'utf8').trimEnd().split('\n')
      assert.strictEqual(args[2], 'https://org-123.mcp.saas.nodesource.io/')
    })

    it(`${wrapper} wrapper preserves a genuine custom mcpUrl override`, { skip: process.platform === 'win32' }, () => {
      const fixture = createWrapperFixture(wrapper)
      writeFileSync(join(fixture.home, '.agents', '.nodesource-auth.json'), JSON.stringify({
        serviceToken: token, organizationId: 'org-123', consoleUrl: 'https://homedepot-nucleus-stage-1.saas.nodesource.io', mcpUrl: 'https://relay.example.com/mcp', expiresAt: '2099-01-01T00:00:00.000Z',
      }))
      const npx = join(fixture.bin, 'npx')
      writeFileSync(npx, '#!/bin/sh\nprintf "%s\\n" "$@" > "$NSOLID_TEST_OUTPUT"\n')
      chmodSync(npx, 0o755)

      const result = spawnSync(process.execPath, [fixture.wrapperPath, 'nsolid-console'], { env: wrapperEnvironment(fixture), encoding: 'utf8' })
      assert.strictEqual(result.status, 0, result.stderr)
      const args = readFileSync(fixture.output, 'utf8').trimEnd().split('\n')
      assert.strictEqual(args[2], 'https://relay.example.com/mcp')
    })

    it(`${wrapper} wrapper keeps URL and headers out of cmd.exe on Windows`, { skip: process.platform !== 'win32' }, () => {
      const fixture = createWrapperFixture(wrapper)
      writeFileSync(join(fixture.bin, 'npx.cmd'), '@echo off\r\n(echo %NSOLID_MCP_REMOTE_PAYLOAD%&echo %NSOLID_MCP_REMOTE_BOOTSTRAP%) > "%NSOLID_TEST_OUTPUT%"\r\n')
      const result = spawnSync(process.execPath, [fixture.wrapperPath, 'nsolid-console'], { env: wrapperEnvironment(fixture), encoding: 'utf8' })
      assert.strictEqual(result.status, 0, result.stderr)

      const [encodedPayload, bootstrap] = readFileSync(fixture.output, 'utf8').trimEnd().split(/\r?\n/)
      assert.deepStrictEqual(JSON.parse(Buffer.from(encodedPayload, 'base64url').toString('utf8')), {
        url,
        headers: { 'X-Nsolid-Service-Token': token },
      })
      const bootstrapSource = Buffer.from(bootstrap.replace('data:text/javascript;base64,', ''), 'base64').toString('utf8')
      assert.ok(!bootstrapSource.includes(url))
      assert.ok(!bootstrapSource.includes(token))
      assert.match(bootstrapSource, /mcp-remote executable was not installed by npx/)
    })

    it(`${wrapper} wrapper rejects a root-relative Windows system directory`, { skip: process.platform !== 'win32' }, () => {
      const fixture = createWrapperFixture(wrapper)
      writeFileSync(join(fixture.bin, 'npx.cmd'), '@echo off\r\nexit /b 0\r\n')
      const environment = wrapperEnvironment(fixture)
      // Setting SystemRoot before Node starts breaks Windows CSPRNG
      // initialization. The preload applies this invalid value after startup,
      // immediately before the wrapper validates it.
      environment.NSOLID_TEST_SYSTEM_ROOT = '\\Windows'

      const result = spawnSync(process.execPath, [fixture.wrapperPath, 'nsolid-console'], { env: environment, encoding: 'utf8' })

      assert.notStrictEqual(result.status, 0)
      assert.match(result.stderr, /Could not locate the Windows system directory/)
    })

    it(`${wrapper} wrapper ignores npx.cmd in the project directory on Windows`, { skip: process.platform !== 'win32' }, () => {
      const fixture = createWrapperFixture(wrapper)
      const attacker = join(fixture.directory, 'attacker')
      const mcpBin = join(fixture.directory, 'node_modules', '.bin')
      const proxy = join(fixture.directory, 'node_modules', 'mcp-remote', 'dist', 'proxy.js')
      mkdirSync(attacker)
      mkdirSync(mcpBin, { recursive: true })
      mkdirSync(join(fixture.directory, 'node_modules', 'mcp-remote', 'dist'), { recursive: true })
      writeFileSync(join(attacker, 'npx.cmd'), '@echo off\r\necho malicious > "%NSOLID_TEST_OUTPUT%"\r\nexit /b 97\r\n')
      writeFileSync(join(mcpBin, 'npx.cmd'), '@echo off\r\necho malicious-path > "%NSOLID_TEST_OUTPUT%"\r\nexit /b 98\r\n')
      writeFileSync(join(fixture.bin, 'npx.cmd'), '@echo off\r\nnode %4 %5 %6\r\n')
      writeFileSync(join(mcpBin, 'mcp-remote.cmd'), '')
      writeFileSync(proxy, "const { writeFileSync } = require('node:fs')\nwriteFileSync(process.env.NSOLID_TEST_OUTPUT, JSON.stringify(process.argv.slice(2)))\n")

      const environment = wrapperEnvironment(fixture)
      environment.PATH = `${mcpBin}${delimiter}${fixture.bin}${delimiter}${process.env.PATH}`
      const result = spawnSync(process.execPath, [fixture.wrapperPath, 'nsolid-console'], { cwd: attacker, env: environment, encoding: 'utf8' })
      assert.strictEqual(result.status, 0, result.stderr)
      assert.deepStrictEqual(JSON.parse(readFileSync(fixture.output, 'utf8')), [
        url, '--header', `X-Nsolid-Service-Token:${token}`, '--transport', 'http-first', '--silent',
      ])
    })
  }
})
