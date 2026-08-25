import { afterEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { chmodSync, cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'

// @ts-expect-error The repository's JavaScript generator intentionally has no TypeScript declarations.
import { generateMcpWrapper, MCP_REMOTE_VERSION as GENERATOR_VERSION, PLUGIN_VERSION as GENERATOR_PLUGIN_VERSION, HARNESS_VALUES as GENERATOR_HARNESS_VALUES } from '../../../../../scripts/plugin-generators.mjs'
import { MCP_REMOTE_VERSION as CORE_VERSION } from '../../../src/mcp/mcp-remote-runtime.js'
import { HARNESS_VALUES as CORE_HARNESS_VALUES, PLUGIN_OWNED_HARNESSES, NATIVE_PLUGIN_HARNESSES } from '../../../src/types.js'

const repoRoot = join(import.meta.dirname, '..', '..', '..', '..', '..')
const sourceWrapper = join(repoRoot, 'scripts', 'mcp-wrapper.js')
const rootPackageJson = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8')) as { dependencies?: Record<string, string> }
const corePackageJson = JSON.parse(readFileSync(join(repoRoot, 'packages', 'core', 'package.json'), 'utf8')) as { version?: string }
const url = 'https://example.test/a path?q=one&redirect=%PATH%&quote="hello world"'
const token = 'tok en&%PATH%"quoted value"'
const temporaryPaths: string[] = []

/** Escaped plugin version for building repair-message regexes. */
const pinnedPlugin = `nsolid-plugin@${GENERATOR_PLUGIN_VERSION.replace(/\./g, '\\.')}`
const repairFor = (harness: string): RegExp =>
  new RegExp(`MCP bridge runtime is not ready\\. Run: npx -y ${pinnedPlugin} setup --harness ${harness}`)

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

/**
 * Seed a runtime whose proxy.js passes the wrapper's light validation but
 * fails while being imported or initialized.
 */
function seedBrokenRuntime (home: string, proxySource: string): string {
  const dir = seedRuntime(home)
  writeFileSync(join(dir, 'dist', 'proxy.js'), proxySource)
  return dir
}

function replaceWithSymlink (target: string, replacement: string, kind: 'file' | 'dir'): boolean {
  rmSync(target, { recursive: true, force: true })
  try {
    symlinkSync(replacement, target, process.platform === 'win32' && kind === 'dir' ? 'junction' : kind)
    return true
  } catch (err) {
    if (process.platform === 'win32' && (err as NodeJS.ErrnoException).code === 'EPERM') return false
    throw err
  }
}

function wrapperEnvironment (fixture: Fixture, extraPath?: string): NodeJS.ProcessEnv {
  const pathPrefix = extraPath ? `${extraPath}${delimiter}` : ''
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: fixture.home,
    USERPROFILE: fixture.home,
    PATH: `${pathPrefix}${fixture.bin}${delimiter}${process.env.PATH}`,
    NSOLID_TEST_OUTPUT: fixture.output,
  }
  // The development fallback is opt-in per test — never inherit a stray flag.
  delete env.NSOLID_MCP_RUNTIME_DEV_FALLBACK
  return env
}

/**
 * Plant a sentinel `command` (npx/npm) on the fixture PATH: if the wrapper
 * ever executes it, a marker appears and the process exits with the
 * command-specific code (97 = npx, 98 = npm).
 */
function writeCommandSentinel (fixture: Fixture, command: 'npx' | 'npm'): string {
  const sentinelMarker = join(fixture.directory, `${command}-ran`)
  const exitCode = command === 'npx' ? 97 : 98
  const fileName = process.platform === 'win32' ? `${command}.cmd` : command
  const sentinel = join(fixture.bin, fileName)
  if (process.platform === 'win32') {
    writeFileSync(sentinel, `@echo off\r\necho pwned > "${sentinelMarker}"\r\nexit /b ${exitCode}\r\n`)
  } else {
    writeFileSync(sentinel, `#!/bin/sh\necho pwned > "${sentinelMarker}"\nexit ${exitCode}\n`)
    chmodSync(sentinel, 0o755)
  }
  return sentinelMarker
}

/** Plant a local mcp-remote copy next to the wrapper (dev-checkout layout). */
function seedLocalCopy (fixture: Fixture, version: string): string {
  const dir = join(fixture.directory, 'node_modules', 'mcp-remote')
  mkdirSync(join(dir, 'dist'), { recursive: true })
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'mcp-remote', version }))
  writeFileSync(
    join(dir, 'dist', 'proxy.js'),
    "const { writeFileSync } = require('node:fs')\nwriteFileSync(process.env.NSOLID_TEST_OUTPUT, 'local-proxy ' + JSON.stringify(process.argv.slice(2)))\n"
  )
  return dir
}

/** Sentinel never ran: the marker file was never created. */
function neverRan (marker: string): boolean {
  return !readFileSync(marker, { encoding: 'utf8', flag: 'a+' }).toString().includes('pwned')
}

describe('MCP wrapper runtime contract', () => {
  it('keeps the mcp-remote version in sync across core, generator and package.json', () => {
    assert.strictEqual(GENERATOR_VERSION, CORE_VERSION)
    assert.strictEqual(rootPackageJson.dependencies?.['mcp-remote'], CORE_VERSION)
    // The generated wrapper embeds the version for its stable-path resolution.
    assert.ok(generateMcpWrapper().includes(`'${CORE_VERSION}'`))
  })

  it('pins the repair command to the generating release', () => {
    // The wrapper's embedded plugin version is the release that generated it
    // (bundle + core package version), so `npx -y nsolid-plugin@X` provisions
    // exactly X's pinned runtime version.
    assert.strictEqual(GENERATOR_PLUGIN_VERSION, corePackageJson.version)
    const generated = generateMcpWrapper()
    assert.ok(generated.includes(`const PLUGIN_VERSION = '${GENERATOR_PLUGIN_VERSION}'`))
    // The wrapper builds the command at runtime from the embedded release.
    assert.ok(generated.includes('npx -y nsolid-plugin@'))
    const interpolation = '${'
    assert.ok(generated.includes(`nsolid-plugin@${interpolation}PLUGIN_VERSION} setup --harness ${interpolation}harness}`))
  })

  it('keeps the harness lists in sync across core, generator and the generated wrapper', () => {
    // The generator's list feeds the wrapper's HARNESS_NAMES literal; core's
    // HARNESS_VALUES drives --harness validation. They must not diverge.
    assert.deepEqual(GENERATOR_HARNESS_VALUES, CORE_HARNESS_VALUES)
    const generated = generateMcpWrapper()
    const harnessNames = generated.match(/const HARNESS_NAMES = new Set\(\[([^\]]*)\]\)/)?.[1]
    assert.ok(harnessNames, 'generated wrapper embeds a HARNESS_NAMES set')
    assert.deepEqual(
      harnessNames.split(',').map((s: string) => s.trim().replaceAll("'", '')),
      CORE_HARNESS_VALUES
    )
    // Ownership semantics: opencode belongs to neither set; pi is native
    // (package-owned) but not plugin-owned.
    assert.deepEqual([...PLUGIN_OWNED_HARNESSES], ['claude', 'codex', 'antigravity'])
    assert.deepEqual([...NATIVE_PLUGIN_HARNESSES], ['claude', 'codex', 'antigravity', 'pi'])
  })

  it('contains no shell, npx or cmd.exe execution paths', () => {
    const stripComments = (source: string) =>
      source.replace(/\/\*[\s\S]*?\*\//g, '').split('\n').filter((line: string) => !line.trim().startsWith('//')).join('\n')
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

  it('generated wrapper matches the committed source wrapper byte for byte', () => {
    // The root artifact must be the generator output — no manual drift.
    assert.strictEqual(readFileSync(sourceWrapper, 'utf8'), generateMcpWrapper())
  })
})

describe('MCP wrapper stable runtime', () => {
  for (const wrapper of ['source', 'generated'] as const) {
    it(`${wrapper} wrapper derives the console MCP URL from the org id when no mcpUrl is stored`, () => {
      const fixture = createWrapperFixture(wrapper)
      seedRuntime(fixture.home)
      // Blank out the stored mcpUrl so the wrapper must derive it from
      // consoleUrl + org id (matching the TS deriveMcpUrlFromConsoleUrl).
      writeFileSync(join(fixture.home, '.agents', '.nodesource-auth.json'), JSON.stringify({
        serviceToken: token, organizationId: 'org-123', consoleUrl: 'https://pretty-name.saas.nodesource.io', mcpUrl: '', expiresAt: '2099-01-01T00:00:00.000Z',
      }))

      const result = spawnSync(process.execPath, [fixture.wrapperPath, 'nsolid-console', 'claude'], { env: wrapperEnvironment(fixture), encoding: 'utf8' })
      assert.strictEqual(result.status, 0, result.stderr)
      const args = JSON.parse(readFileSync(fixture.output, 'utf8')) as string[]
      assert.strictEqual(args[0], 'https://org-123.mcp.saas.nodesource.io/')
    })

    it(`${wrapper} wrapper forces https on the derived MCP URL even for an http consoleUrl`, () => {
      const fixture = createWrapperFixture(wrapper)
      seedRuntime(fixture.home)
      writeFileSync(join(fixture.home, '.agents', '.nodesource-auth.json'), JSON.stringify({
        serviceToken: token, organizationId: 'org-456', consoleUrl: 'http://pretty-name.saas.nodesource.io', mcpUrl: '', expiresAt: '2099-01-01T00:00:00.000Z',
      }))

      const result = spawnSync(process.execPath, [fixture.wrapperPath, 'nsolid-console', 'claude'], { env: wrapperEnvironment(fixture), encoding: 'utf8' })
      assert.strictEqual(result.status, 0, result.stderr)
      const args = JSON.parse(readFileSync(fixture.output, 'utf8')) as string[]
      assert.strictEqual(args[0], 'https://org-456.mcp.saas.nodesource.io/')
    })

    it(`${wrapper} wrapper rejects a console URL that is not a recognized NodeSource SaaS host`, () => {
      const fixture = createWrapperFixture(wrapper)
      seedRuntime(fixture.home)
      writeFileSync(join(fixture.home, '.agents', '.nodesource-auth.json'), JSON.stringify({
        serviceToken: token, organizationId: 'org-123', consoleUrl: 'https://console.example.com', mcpUrl: '', expiresAt: '2099-01-01T00:00:00.000Z',
      }))

      const result = spawnSync(process.execPath, [fixture.wrapperPath, 'nsolid-console', 'claude'], { env: wrapperEnvironment(fixture), encoding: 'utf8' })
      assert.notStrictEqual(result.status, 0)
      assert.match(result.stderr, /Could not derive NodeSource console MCP URL/)
    })

    it(`${wrapper} wrapper imports the stable runtime and preserves argv boundaries`, () => {
      const fixture = createWrapperFixture(wrapper)
      seedRuntime(fixture.home)
      const sentinel = writeCommandSentinel(fixture, 'npx')

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
      assert.ok(neverRan(sentinel), 'npx sentinel never ran')
    })

    it(`${wrapper} wrapper migrates a stored legacy alias-derived mcpUrl to the org-UUID route`, () => {
      const fixture = createWrapperFixture(wrapper)
      seedRuntime(fixture.home)
      // The previous release stored the alias-derived (dead) endpoint. It must
      // be replaced by the org-UUID route even though a value is present.
      writeFileSync(join(fixture.home, '.agents', '.nodesource-auth.json'), JSON.stringify({
        serviceToken: token, organizationId: 'org-123', consoleUrl: 'https://homedepot-nucleus-stage-1.saas.nodesource.io', mcpUrl: 'https://homedepot-nucleus-stage-1.mcp.saas.nodesource.io/', expiresAt: '2099-01-01T00:00:00.000Z',
      }))

      const result = spawnSync(process.execPath, [fixture.wrapperPath, 'nsolid-console', 'claude'], { env: wrapperEnvironment(fixture), encoding: 'utf8' })
      assert.strictEqual(result.status, 0, result.stderr)
      const args = JSON.parse(readFileSync(fixture.output, 'utf8')) as string[]
      assert.strictEqual(args[0], 'https://org-123.mcp.saas.nodesource.io/')
    })

    it(`${wrapper} wrapper preserves a genuine custom mcpUrl override`, () => {
      const fixture = createWrapperFixture(wrapper)
      seedRuntime(fixture.home)
      writeFileSync(join(fixture.home, '.agents', '.nodesource-auth.json'), JSON.stringify({
        serviceToken: token, organizationId: 'org-123', consoleUrl: 'https://homedepot-nucleus-stage-1.saas.nodesource.io', mcpUrl: 'https://relay.example.com/mcp', expiresAt: '2099-01-01T00:00:00.000Z',
      }))

      const result = spawnSync(process.execPath, [fixture.wrapperPath, 'nsolid-console', 'claude'], { env: wrapperEnvironment(fixture), encoding: 'utf8' })
      assert.strictEqual(result.status, 0, result.stderr)
      const args = JSON.parse(readFileSync(fixture.output, 'utf8')) as string[]
      assert.strictEqual(args[0], 'https://relay.example.com/mcp')
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

    it(`${wrapper} wrapper fails fast when the runtime is missing (version-pinned repair)`, () => {
      const fixture = createWrapperFixture(wrapper)
      const sentinel = writeCommandSentinel(fixture, 'npx')

      const result = spawnSync(process.execPath, [fixture.wrapperPath, 'nsolid-console', 'codex'], {
        cwd: fixture.directory,
        env: wrapperEnvironment(fixture),
        encoding: 'utf8',
        timeout: 15000,
      })

      assert.notStrictEqual(result.status, 0)
      assert.match(result.stderr, repairFor('codex'))
      assert.ok(neverRan(sentinel), 'npx sentinel never ran (repair text may mention npx, never execute it)')
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
      assert.match(result.stderr, repairFor('antigravity'))
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
      assert.match(result.stderr, repairFor('claude'))
    })

    for (const escapedEntry of ['runtime root', 'package directory', 'manifest', 'proxy'] as const) {
      it(`${wrapper} wrapper rejects a post-publication ${escapedEntry} symlink escape before import`, (t) => {
        const fixture = createWrapperFixture(wrapper)
        const runtimeDir = seedRuntime(fixture.home)
        const outsideDir = join(fixture.directory, `outside-${escapedEntry.replace(' ', '-')}`)

        let linked: boolean
        if (escapedEntry === 'runtime root') {
          const outsideRuntimeDir = seedRuntime(outsideDir)
          writeFileSync(join(outsideRuntimeDir, 'dist', 'proxy.js'), "throw new Error('escaped runtime root imported')\n")
          const versionRoot = join(fixture.home, '.agents', 'nsolid-plugin', 'runtime', 'mcp-remote', CORE_VERSION)
          const outsideRoot = join(outsideDir, '.agents', 'nsolid-plugin', 'runtime', 'mcp-remote', CORE_VERSION)
          linked = replaceWithSymlink(versionRoot, outsideRoot, 'dir')
        } else if (escapedEntry === 'package directory') {
          mkdirSync(outsideDir, { recursive: true })
          mkdirSync(join(outsideDir, 'dist'))
          writeFileSync(join(outsideDir, 'package.json'), JSON.stringify({ name: 'mcp-remote', version: CORE_VERSION }))
          writeFileSync(join(outsideDir, 'dist', 'proxy.js'), "throw new Error('escaped package imported')\n")
          linked = replaceWithSymlink(runtimeDir, outsideDir, 'dir')
        } else if (escapedEntry === 'manifest') {
          mkdirSync(outsideDir, { recursive: true })
          const outsideManifest = join(outsideDir, 'package.json')
          writeFileSync(outsideManifest, JSON.stringify({ name: 'mcp-remote', version: CORE_VERSION }))
          linked = replaceWithSymlink(join(runtimeDir, 'package.json'), outsideManifest, 'file')
        } else {
          mkdirSync(outsideDir, { recursive: true })
          writeFileSync(join(outsideDir, 'proxy.js'), "throw new Error('escaped proxy imported')\n")
          linked = replaceWithSymlink(join(runtimeDir, 'dist'), outsideDir, 'dir')
        }

        if (!linked) {
          t.skip('symlinks require additional privileges on this Windows host')
          return
        }

        const result = spawnSync(process.execPath, [fixture.wrapperPath, 'ncm', 'claude'], {
          cwd: fixture.directory,
          env: wrapperEnvironment(fixture),
          encoding: 'utf8',
          timeout: 15000,
        })

        assert.notStrictEqual(result.status, 0, `${escapedEntry} escape must fail before import`)
        assert.match(result.stderr, repairFor('claude'))
        assert.doesNotMatch(result.stderr, /escaped (?:runtime root|package|proxy) imported/)
      })
    }

    it(`${wrapper} wrapper reports credentials problems before touching the runtime`, () => {
      const fixture = createWrapperFixture(wrapper)
      writeFileSync(join(fixture.home, '.agents', '.nodesource-auth.json'), JSON.stringify({
        serviceToken: token, organizationId: 'org', consoleUrl: 'https://console.example.test', mcpUrl: url, expiresAt: '2020-01-01T00:00:00.000Z',
      }))
      const sentinel = writeCommandSentinel(fixture, 'npx')

      const result = spawnSync(process.execPath, [fixture.wrapperPath, 'nsolid-console', 'codex'], {
        cwd: fixture.directory,
        env: wrapperEnvironment(fixture),
        encoding: 'utf8',
      })

      assert.notStrictEqual(result.status, 0)
      assert.match(result.stderr, new RegExp(`credentials are expired\\. Run: npx -y ${pinnedPlugin} setup --harness codex`))
      assert.ok(neverRan(sentinel), 'npx sentinel never ran')
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
        assert.match(result.stderr, new RegExp(`npx -y ${pinnedPlugin} setup --harness ${harness}`))
      }
    })

    it(`${wrapper} wrapper translates a missing transitive into the repair message`, () => {
      const fixture = createWrapperFixture(wrapper)
      // Light validation passes (name/version/proxy file); the import fails
      // with a real ERR_MODULE_NOT_FOUND for a missing transitive.
      seedBrokenRuntime(fixture.home, "import { helper } from './helpers.js'\nconsole.log(helper)\n")
      const sentinel = writeCommandSentinel(fixture, 'npx')

      const result = spawnSync(process.execPath, [fixture.wrapperPath, 'nsolid-console', 'claude'], {
        cwd: fixture.directory,
        env: wrapperEnvironment(fixture),
        encoding: 'utf8',
        timeout: 15000,
      })

      assert.notStrictEqual(result.status, 0)
      assert.match(result.stderr, repairFor('claude'))
      // The underlying module error appears only as a secondary cause line.
      assert.match(result.stderr, /cause: Cannot find module/)
      // The primary guidance is the repair message, never a raw stack.
      assert.doesNotMatch(result.stderr.split('\n')[0] ?? '', /Cannot find module|ERR_MODULE_NOT_FOUND/)
      assert.ok(neverRan(sentinel), 'npx sentinel never ran')
    })

    it(`${wrapper} wrapper translates an incompatible transitive into the repair message`, () => {
      const fixture = createWrapperFixture(wrapper)
      // A "helper" exists but itself fails to resolve its own dependency —
      // the classic incompatible/missing transitive shape at import time.
      const dir = seedRuntime(fixture.home)
      mkdirSync(join(dir, 'dist', 'helpers'), { recursive: true })
      writeFileSync(join(dir, 'dist', 'helpers', 'index.js'), "import 'nonexistent-transitive-pkg'\n")
      writeFileSync(join(dir, 'dist', 'proxy.js'), "import './helpers/index.js'\n")

      const result = spawnSync(process.execPath, [fixture.wrapperPath, 'ns-benchmark', 'codex'], {
        cwd: fixture.directory,
        env: wrapperEnvironment(fixture),
        encoding: 'utf8',
        timeout: 15000,
      })

      assert.notStrictEqual(result.status, 0)
      assert.match(result.stderr, repairFor('codex'))
    })

    it(`${wrapper} wrapper translates an arbitrary initialization throw into the repair message`, () => {
      const fixture = createWrapperFixture(wrapper)
      seedBrokenRuntime(fixture.home, "throw new Error('proxy failed during initialization')\n")

      const result = spawnSync(process.execPath, [fixture.wrapperPath, 'ncm', 'antigravity'], {
        cwd: fixture.directory,
        env: wrapperEnvironment(fixture),
        encoding: 'utf8',
        timeout: 15000,
      })

      assert.notStrictEqual(result.status, 0)
      assert.match(result.stderr, repairFor('antigravity'))
      assert.match(result.stderr, /cause: proxy failed during initialization/)
      assert.doesNotMatch(result.stderr.split('\n')[0] ?? '', /proxy failed during initialization/)
    })

    it(`${wrapper} wrapper translates an async initialization rejection into the repair message`, () => {
      const fixture = createWrapperFixture(wrapper)
      seedBrokenRuntime(fixture.home, "Promise.reject(new Error('async initialization failure'))\nsetInterval(() => {}, 1000)\n")

      const result = spawnSync(process.execPath, [fixture.wrapperPath, 'nsolid-console', 'claude'], {
        cwd: fixture.directory,
        env: wrapperEnvironment(fixture),
        encoding: 'utf8',
        timeout: 15000,
      })

      assert.notStrictEqual(result.status, 0)
      assert.match(result.stderr, repairFor('claude'))
    })

    it(`${wrapper} wrapper ignores a hostile PATH (nothing is ever spawned)`, () => {
      const fixture = createWrapperFixture(wrapper)
      const sentinel = writeCommandSentinel(fixture, 'npx')
      // An attacker-controlled directory fronts PATH with npm/node shims.
      const hostile = join(fixture.directory, 'hostile-bin')
      mkdirSync(hostile)
      for (const name of process.platform === 'win32' ? ['npm.cmd', 'node.exe'] : ['npm', 'node']) {
        const p = join(hostile, name)
        writeFileSync(p, process.platform === 'win32' ? '@echo off\r\necho pwned > "%SENTINEL%"\r\n' : `#!/bin/sh\necho pwned > "${sentinel}"\n`)
        if (process.platform !== 'win32') chmodSync(p, 0o755)
      }
      // Runtime missing: the wrapper must fail with the repair message
      // without executing anything from PATH.
      const result = spawnSync(process.execPath, [fixture.wrapperPath, 'ncm', 'codex'], {
        cwd: fixture.directory,
        env: wrapperEnvironment(fixture, hostile),
        encoding: 'utf8',
        timeout: 15000,
      })

      assert.notStrictEqual(result.status, 0)
      assert.match(result.stderr, repairFor('codex'))
      assert.ok(neverRan(sentinel), 'nothing from the hostile PATH ever ran')
    })
  }

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
    assert.match(result.stderr, repairFor('codex'))
  })

  for (const wrapper of ['source', 'generated'] as const) {
    it(`${wrapper} wrapper ignores a matching local node_modules copy without the dev flag`, () => {
      const fixture = createWrapperFixture(wrapper)
      seedLocalCopy(fixture, CORE_VERSION)

      const result = spawnSync(process.execPath, [fixture.wrapperPath, 'ncm', 'codex'], {
        cwd: fixture.directory,
        env: wrapperEnvironment(fixture),
        encoding: 'utf8',
        timeout: 15000,
      })

      assert.notStrictEqual(result.status, 0, 'a project dependency must not bypass the managed runtime')
      assert.match(result.stderr, repairFor('codex'))
      assert.ok(
        !readFileSync(fixture.output, { encoding: 'utf8', flag: 'a+' }).toString().includes('local-proxy'),
        'local proxy never imported'
      )
    })

    it(`${wrapper} wrapper uses the dev fallback only when explicitly enabled and version-matched`, () => {
      const fixture = createWrapperFixture(wrapper)
      seedLocalCopy(fixture, CORE_VERSION)

      const dev = spawnSync(process.execPath, [fixture.wrapperPath, 'ncm', 'codex'], {
        cwd: fixture.directory,
        env: { ...wrapperEnvironment(fixture), NSOLID_MCP_RUNTIME_DEV_FALLBACK: '1' },
        encoding: 'utf8',
        timeout: 15000,
      })
      assert.strictEqual(dev.status, 0, dev.stderr)
      assert.ok(readFileSync(fixture.output, 'utf8').includes('local-proxy'), 'dev fallback imported the pinned checkout')

      // Same flag, wrong pinned version → still rejected with the repair path.
      writeFileSync(
        join(fixture.directory, 'node_modules', 'mcp-remote', 'package.json'),
        JSON.stringify({ name: 'mcp-remote', version: '0.1.37' })
      )
      const wrong = spawnSync(process.execPath, [fixture.wrapperPath, 'ncm', 'codex'], {
        cwd: fixture.directory,
        env: { ...wrapperEnvironment(fixture), NSOLID_MCP_RUNTIME_DEV_FALLBACK: '1' },
        encoding: 'utf8',
        timeout: 15000,
      })
      assert.notStrictEqual(wrong.status, 0)
      assert.match(wrong.stderr, repairFor('codex'))
    })

    for (const escapedEntry of ['manifest', 'proxy'] as const) {
      it(`${wrapper} wrapper confines the dev fallback ${escapedEntry} to its canonical package directory`, (t) => {
        const fixture = createWrapperFixture(wrapper)
        const localDir = seedLocalCopy(fixture, CORE_VERSION)
        const outsideDir = join(fixture.directory, `outside-dev-${escapedEntry}`)
        mkdirSync(outsideDir)

        let linked: boolean
        if (escapedEntry === 'manifest') {
          const outsideManifest = join(outsideDir, 'package.json')
          writeFileSync(outsideManifest, JSON.stringify({ name: 'mcp-remote', version: CORE_VERSION }))
          linked = replaceWithSymlink(join(localDir, 'package.json'), outsideManifest, 'file')
        } else {
          writeFileSync(join(outsideDir, 'proxy.js'), "throw new Error('escaped dev proxy imported')\n")
          linked = replaceWithSymlink(join(localDir, 'dist'), outsideDir, 'dir')
        }

        if (!linked) {
          t.skip('file symlinks require additional privileges on this Windows host')
          return
        }

        const result = spawnSync(process.execPath, [fixture.wrapperPath, 'ncm', 'codex'], {
          cwd: fixture.directory,
          env: { ...wrapperEnvironment(fixture), NSOLID_MCP_RUNTIME_DEV_FALLBACK: '1' },
          encoding: 'utf8',
          timeout: 15000,
        })

        assert.notStrictEqual(result.status, 0, `dev fallback ${escapedEntry} escape must fail before import`)
        assert.match(result.stderr, repairFor('codex'))
        assert.doesNotMatch(result.stderr, /escaped dev proxy imported/)
      })
    }

    it(`${wrapper} wrapper never executes a direct npm sentinel in stable or dev-fallback mode`, () => {
      // Stable mode: runtime present, npm on PATH must never run.
      const stable = createWrapperFixture(wrapper)
      seedRuntime(stable.home)
      const stableSentinel = writeCommandSentinel(stable, 'npm')
      const stableResult = spawnSync(process.execPath, [stable.wrapperPath, 'nsolid-console', 'claude'], {
        cwd: stable.directory,
        env: wrapperEnvironment(stable),
        encoding: 'utf8',
        timeout: 15000,
      })
      assert.strictEqual(stableResult.status, 0, stableResult.stderr)
      assert.ok(neverRan(stableSentinel), 'npm sentinel never ran (stable mode)')

      // Dev-fallback mode: local checkout in use, npm still must never run.
      const dev = createWrapperFixture(wrapper)
      seedLocalCopy(dev, CORE_VERSION)
      const devSentinel = writeCommandSentinel(dev, 'npm')
      const devResult = spawnSync(process.execPath, [dev.wrapperPath, 'nsolid-console', 'claude'], {
        cwd: dev.directory,
        env: { ...wrapperEnvironment(dev), NSOLID_MCP_RUNTIME_DEV_FALLBACK: '1' },
        encoding: 'utf8',
        timeout: 15000,
      })
      assert.strictEqual(devResult.status, 0, devResult.stderr)
      assert.ok(readFileSync(dev.output, 'utf8').includes('local-proxy'), 'dev fallback in use')
      assert.ok(neverRan(devSentinel), 'npm sentinel never ran (dev-fallback mode)')
    })
  }

  it('an old wrapper prints the repair command of its own release, not the newest CLI', () => {
    // A wrapper generated by plugin release X (here: an older embedded
    // PLUGIN_VERSION) must print nsolid-plugin@X — and release X provisions
    // exactly X's pinned runtime version.
    const generated = generateMcpWrapper()
    const oldVersion = '0.0.1-old-release'
    const oldWrapper = generated.replace(
      new RegExp(`const PLUGIN_VERSION = '${GENERATOR_PLUGIN_VERSION.replace(/\./g, '\\.')}'`),
      `const PLUGIN_VERSION = '${oldVersion}'`
    )
    assert.ok(oldWrapper.includes(`const PLUGIN_VERSION = '${oldVersion}'`), 'fixture rewrote the embedded version')

    const fixture = createWrapperFixture('source')
    writeFileSync(fixture.wrapperPath, oldWrapper)
    const result = spawnSync(process.execPath, [fixture.wrapperPath, 'ncm', 'claude'], {
      cwd: fixture.directory,
      env: wrapperEnvironment(fixture),
      encoding: 'utf8',
      timeout: 15000,
    })

    assert.notStrictEqual(result.status, 0)
    assert.match(result.stderr, new RegExp(`Run: npx -y nsolid-plugin@${oldVersion} setup --harness claude`))
    assert.ok(!result.stderr.includes(`nsolid-plugin@${GENERATOR_PLUGIN_VERSION} setup`), 'must not advertise a newer CLI than the wrapper release')
  })
})
