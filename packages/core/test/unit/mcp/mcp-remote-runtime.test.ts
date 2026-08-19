import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, dirname, join, sep, basename } from 'node:path'

import {
  MCP_REMOTE_VERSION,
  McpRemoteRuntimeError,
  ensureMcpRemoteRuntime,
  inspectMcpRemoteRuntime,
  resolveNpmCommand,
  type NpmRunner,
} from '../../../src/mcp/mcp-remote-runtime.js'

let tmpHome: string
let originalHome: string | undefined
let originalUserProfile: string | undefined
let originalNpmExecpath: string | undefined

beforeEach(() => {
  // Include a space in the home path: runtime paths must survive it.
  tmpHome = mkdtempSync(join(tmpdir(), 'nsolid runtime-'))
  originalHome = process.env.HOME
  originalUserProfile = process.env.USERPROFILE
  originalNpmExecpath = process.env.npm_execpath
  process.env.HOME = tmpHome
  process.env.USERPROFILE = tmpHome
  delete process.env.npm_execpath
})

afterEach(() => {
  rmSync(tmpHome, { recursive: true, force: true })
  if (originalHome !== undefined) process.env.HOME = originalHome
  else delete process.env.HOME
  if (originalUserProfile !== undefined) process.env.USERPROFILE = originalUserProfile
  else delete process.env.USERPROFILE
  if (originalNpmExecpath !== undefined) process.env.npm_execpath = originalNpmExecpath
  else delete process.env.npm_execpath
})

function runtimeRoot (): string {
  return join(tmpHome, '.agents', 'nsolid-plugin', 'runtime', 'mcp-remote', MCP_REMOTE_VERSION)
}

interface SeedOptions {
  version?: string
  withProxy?: boolean
  /** Packages actually present under node_modules. mcp-remote always declares all four. */
  dependencies?: Record<string, Record<string, unknown>>
  /** Extra dependencies declared but deliberately NOT installed. */
  declareWithoutInstalling?: string[]
}

/** Names mcp-remote declares as dependencies in the seeded fixture. */
const SEED_DECLARED = ['express', 'open', 'strict-url-sanitise', 'undici']

/** Seed a runtime tree directly (no npm). Defaults produce a fully valid runtime. */
function seedRuntime (options: SeedOptions = {}): void {
  const {
    version = MCP_REMOTE_VERSION,
    withProxy = true,
    dependencies = {
      express: { dependencies: {} },
      open: { dependencies: {} },
      'strict-url-sanitise': { dependencies: {} },
      undici: { dependencies: {} },
    },
    declareWithoutInstalling = [],
  } = options
  const mcpRemoteDir = join(runtimeRoot(), 'node_modules', 'mcp-remote')
  mkdirSync(mcpRemoteDir, { recursive: true })
  const declared = [...SEED_DECLARED, ...declareWithoutInstalling]
  writeFileSync(
    join(mcpRemoteDir, 'package.json'),
    JSON.stringify({ name: 'mcp-remote', version, dependencies: Object.fromEntries(declared.map((name) => [name, '^1.0.0'])) })
  )
  if (withProxy) {
    mkdirSync(join(mcpRemoteDir, 'dist'), { recursive: true })
    writeFileSync(join(mcpRemoteDir, 'dist', 'proxy.js'), '// proxy\n')
  }
  for (const [name, pkg] of Object.entries(dependencies)) {
    const depDir = join(runtimeRoot(), 'node_modules', name)
    mkdirSync(depDir, { recursive: true })
    writeFileSync(join(depDir, 'package.json'), JSON.stringify({ name, version: '1.0.0', ...pkg }))
  }
  writeFileSync(join(runtimeRoot(), 'package.json'), JSON.stringify({ name: 'nsolid-plugin-mcp-remote-runtime', private: true }))
}

function runtimeParentEntries (): string[] {
  const parent = join(tmpHome, '.agents', 'nsolid-plugin', 'runtime', 'mcp-remote')
  if (!existsSync(parent)) return []
  return readdirSync(parent)
}

/** Fake runner: "installs" a valid (or invalid) tree into cwd and records the spawn request. */
function createFakeRunner (calls: Array<{ command: string; args: string[]; cwd: string }>, behavior: 'ok' | 'fail' | 'invalid' = 'ok'): NpmRunner {
  return {
    async run (command, args, options) {
      calls.push({ command, args: [...args], cwd: options.cwd })
      if (behavior === 'fail') {
        return { status: 1, stderr: 'ECONNREFUSED registry ping failed\nplausible npm noise\nmore noise' }
      }
      const cwd = options.cwd
      if (behavior === 'invalid') {
        // Installs the wrong version: staging validation must reject it.
        mkdirSync(join(cwd, 'node_modules', 'mcp-remote'), { recursive: true })
        writeFileSync(join(cwd, 'node_modules', 'mcp-remote', 'package.json'), JSON.stringify({ name: 'mcp-remote', version: '0.0.1' }))
        return { status: 0, stderr: '' }
      }
      mkdirSync(join(cwd, 'node_modules', 'mcp-remote', 'dist'), { recursive: true })
      writeFileSync(join(cwd, 'node_modules', 'mcp-remote', 'package.json'), JSON.stringify({ name: 'mcp-remote', version: MCP_REMOTE_VERSION, dependencies: {} }))
      writeFileSync(join(cwd, 'node_modules', 'mcp-remote', 'dist', 'proxy.js'), '// proxy\n')
      return { status: 0, stderr: '' }
    },
  }
}

describe('inspectMcpRemoteRuntime()', () => {
  it('computes the versioned root under ~/.agents (spaces tolerated)', () => {
    const status = inspectMcpRemoteRuntime()
    assert.strictEqual(status.status, 'missing')
    assert.strictEqual(status.version, MCP_REMOTE_VERSION)
    assert.strictEqual(status.root, runtimeRoot())
    assert.ok(status.root.includes('nsolid runtime-'), 'uses the overridden home with a space')
  })

  it('reports ready for a fully valid runtime', () => {
    seedRuntime()
    const status = inspectMcpRemoteRuntime()
    assert.strictEqual(status.status, 'ready')
    assert.strictEqual(status.proxyPath, join(runtimeRoot(), 'node_modules', 'mcp-remote', 'dist', 'proxy.js'))
  })

  it('reports invalid for a wrong version', () => {
    seedRuntime({ version: '0.1.37' })
    const status = inspectMcpRemoteRuntime()
    assert.strictEqual(status.status, 'invalid')
    assert.match(status.reason ?? '', /expected mcp-remote@0\.1\.38/)
  })

  it('reports invalid when dist/proxy.js is missing', () => {
    seedRuntime({ withProxy: false })
    const status = inspectMcpRemoteRuntime()
    assert.strictEqual(status.status, 'invalid')
    assert.match(status.reason ?? '', /proxy\.js/)
  })

  it('reports invalid when a transitive dependency is missing', () => {
    seedRuntime({
      dependencies: {
        express: {},
        // open / strict-url-sanitise / undici deliberately absent
      },
    })
    const status = inspectMcpRemoteRuntime()
    assert.strictEqual(status.status, 'invalid')
    assert.match(status.reason ?? '', /dependency "open" required by "mcp-remote"/)
  })

  it('reports invalid when a nested transitive dependency is missing', () => {
    seedRuntime({
      dependencies: {
        express: { dependencies: { 'body-parser': '^1.0.0' } },
        open: {},
        'strict-url-sanitise': {},
        undici: {},
      },
    })
    const status = inspectMcpRemoteRuntime()
    assert.strictEqual(status.status, 'invalid')
    assert.match(status.reason ?? '', /dependency "body-parser" required by "express"/)
  })

  it('tolerates a missing optional dependency', () => {
    const mcpRemoteDir = join(runtimeRoot(), 'node_modules', 'mcp-remote')
    mkdirSync(mcpRemoteDir, { recursive: true })
    writeFileSync(
      join(mcpRemoteDir, 'package.json'),
      JSON.stringify({
        name: 'mcp-remote',
        version: MCP_REMOTE_VERSION,
        dependencies: { express: '^1.0.0' },
        optionalDependencies: { 'native-thing': '^1.0.0' },
      })
    )
    mkdirSync(join(mcpRemoteDir, 'dist'), { recursive: true })
    writeFileSync(join(mcpRemoteDir, 'dist', 'proxy.js'), '// proxy\n')
    const expressDir = join(runtimeRoot(), 'node_modules', 'express')
    mkdirSync(expressDir, { recursive: true })
    writeFileSync(join(expressDir, 'package.json'), JSON.stringify({ name: 'express', version: '1.0.0' }))

    assert.strictEqual(inspectMcpRemoteRuntime().status, 'ready')
  })
})

describe('ensureMcpRemoteRuntime()', () => {
  it('installs the runtime via the runner and publishes atomically', async () => {
    const calls: Array<{ command: string; args: string[]; cwd: string }> = []
    const result = await ensureMcpRemoteRuntime({ runner: createFakeRunner(calls) })

    assert.strictEqual(result.installed, true)
    assert.strictEqual(result.version, MCP_REMOTE_VERSION)
    assert.strictEqual(result.root, runtimeRoot())
    assert.strictEqual(result.proxyPath, join(runtimeRoot(), 'node_modules', 'mcp-remote', 'dist', 'proxy.js'))
    assert.strictEqual(calls.length, 1)
    const runtimeParent = join(tmpHome, '.agents', 'nsolid-plugin', 'runtime', 'mcp-remote')
    assert.ok(calls[0].cwd.startsWith(join(runtimeParent, '.staging-')), 'npm ran inside a staging sibling')
    assert.match(calls[0].args.at(-1) as string, new RegExp(`^mcp-remote@${MCP_REMOTE_VERSION.replace(/\./g, '\\.')}$`))
    assert.ok(calls[0].args.includes('--ignore-scripts'))
    assert.ok(calls[0].args.includes('--save-exact'))

    assert.strictEqual(inspectMcpRemoteRuntime().status, 'ready')
    assert.deepStrictEqual(runtimeParentEntries(), [MCP_REMOTE_VERSION], 'staging dir was consumed by the rename')
  })

  it('is idempotent: a second call does not invoke the runner', async () => {
    const calls: Array<{ command: string; args: string[]; cwd: string }> = []
    await ensureMcpRemoteRuntime({ runner: createFakeRunner(calls) })
    const second = await ensureMcpRemoteRuntime({ runner: createFakeRunner(calls) })

    assert.strictEqual(second.installed, false)
    assert.strictEqual(calls.length, 1)
    assert.strictEqual(inspectMcpRemoteRuntime().status, 'ready')
  })

  it('replaces an invalid pre-existing runtime only after staging validates', async () => {
    seedRuntime({ version: '0.1.37' })
    const calls: Array<{ command: string; args: string[]; cwd: string }> = []
    const result = await ensureMcpRemoteRuntime({ runner: createFakeRunner(calls) })

    assert.strictEqual(result.installed, true)
    assert.strictEqual(inspectMcpRemoteRuntime().status, 'ready')
    assert.deepStrictEqual(runtimeParentEntries(), [MCP_REMOTE_VERSION], 'no stale leftovers')
  })

  it('rejects a staging tree that fails validation (wrong version from npm)', async () => {
    const calls: Array<{ command: string; args: string[]; cwd: string }> = []
    await assert.rejects(
      ensureMcpRemoteRuntime({ runner: createFakeRunner(calls, 'invalid') }),
      (err: unknown) => {
        assert.ok(err instanceof McpRemoteRuntimeError)
        assert.match((err as Error).message, /Staged mcp-remote runtime failed validation/)
        return true
      }
    )
    assert.strictEqual(inspectMcpRemoteRuntime().status, 'missing', 'nothing was published')
    assert.deepStrictEqual(runtimeParentEntries(), [], 'staging was cleaned up')
  })

  it('returns an actionable error and cleans staging when npm fails', async () => {
    const calls: Array<{ command: string; args: string[]; cwd: string }> = []
    await assert.rejects(
      ensureMcpRemoteRuntime({ runner: createFakeRunner(calls, 'fail') }),
      (err: unknown) => {
        assert.ok(err instanceof McpRemoteRuntimeError)
        const message = (err as Error).message
        assert.match(message, new RegExp(`npm install of mcp-remote@${MCP_REMOTE_VERSION} failed`))
        assert.match(message, /Rerun setup/)
        assert.ok(message.includes('ECONNREFUSED'), 'keeps a bounded stderr tail')
        assert.ok(message.length < 8192, 'stderr tail is bounded')
        return true
      }
    )
    assert.deepStrictEqual(runtimeParentEntries(), [], 'staging cleaned on failure')
    assert.strictEqual(inspectMcpRemoteRuntime().status, 'missing')
  })

  it('reports timeouts distinctly', async () => {
    const runner: NpmRunner = {
      async run () {
        return { status: null, stderr: '', timedOut: true }
      },
    }
    await assert.rejects(
      ensureMcpRemoteRuntime({ runner, timeoutMs: 50 }),
      (err: unknown) => {
        assert.match((err as Error).message, /timed out after \d+s/)
        assert.match((err as Error).message, /rerun setup/i)
        return true
      }
    )
  })

  it('a failed reinstall never worsens the on-disk state', async () => {
    // Valid prior runtime: ensure must not even attempt a reinstall.
    seedRuntime()
    const idleCalls: Array<{ command: string; args: string[]; cwd: string }> = []
    const kept = await ensureMcpRemoteRuntime({ runner: createFakeRunner(idleCalls, 'fail') })
    assert.strictEqual(kept.installed, false)
    assert.strictEqual(idleCalls.length, 0)
    assert.strictEqual(inspectMcpRemoteRuntime().status, 'ready')

    // Invalid prior runtime: npm fails; the prior tree must remain exactly as
    // it was (never deleted to “make room”), and a retry can then fix it.
    rmSync(runtimeRoot(), { recursive: true, force: true })
    seedRuntime({ version: '0.1.37' })
    const priorPkg = readFileSync(join(runtimeRoot(), 'node_modules', 'mcp-remote', 'package.json'), 'utf8')
    const calls: Array<{ command: string; args: string[]; cwd: string }> = []
    await assert.rejects(ensureMcpRemoteRuntime({ runner: createFakeRunner(calls, 'fail') }))
    assert.strictEqual(inspectMcpRemoteRuntime().status, 'invalid')
    assert.strictEqual(
      readFileSync(join(runtimeRoot(), 'node_modules', 'mcp-remote', 'package.json'), 'utf8'),
      priorPkg,
      'invalid prior runtime untouched by the failed attempt'
    )

    const fixed = await ensureMcpRemoteRuntime({ runner: createFakeRunner(calls) })
    assert.strictEqual(fixed.installed, true)
    assert.strictEqual(inspectMcpRemoteRuntime().status, 'ready')
    assert.deepStrictEqual(runtimeParentEntries(), [MCP_REMOTE_VERSION])
  })

  it('concurrent installs converge on a single valid runtime', async () => {
    const calls: Array<{ command: string; args: string[]; cwd: string }> = []
    const runner: NpmRunner = {
      async run (command, args, options) {
        calls.push({ command, args: [...args], cwd: options.cwd })
        await new Promise((resolve) => setTimeout(resolve, 20))
        mkdirSync(join(options.cwd, 'node_modules', 'mcp-remote', 'dist'), { recursive: true })
        writeFileSync(join(options.cwd, 'node_modules', 'mcp-remote', 'package.json'), JSON.stringify({ name: 'mcp-remote', version: MCP_REMOTE_VERSION, dependencies: {} }))
        writeFileSync(join(options.cwd, 'node_modules', 'mcp-remote', 'dist', 'proxy.js'), '// proxy\n')
        return { status: 0, stderr: '' }
      },
    }

    const [a, b] = await Promise.all([
      ensureMcpRemoteRuntime({ runner }),
      ensureMcpRemoteRuntime({ runner }),
    ])

    assert.strictEqual(inspectMcpRemoteRuntime().status, 'ready')
    assert.deepStrictEqual(runtimeParentEntries(), [MCP_REMOTE_VERSION], 'no staging/stale leftovers')
    // Both raced before either published, so both staged; one publish won.
    assert.strictEqual(calls.length, 2)
    assert.strictEqual(a.root, b.root)
    assert.ok(statSync(runtimeRoot()).isDirectory())
  })

  it('never leaks stored credentials in error output', async () => {
    const agentsDir = join(tmpHome, '.agents')
    mkdirSync(agentsDir, { recursive: true })
    writeFileSync(join(agentsDir, '.nodesource-auth.json'), JSON.stringify({
      serviceToken: 'super-secret-service-token-1234',
      organizationId: 'org-id-secret-5678',
    }))
    process.env.NSOLID_CANARY_SECRET = 'canary-env-secret-9012'

    let captured = ''
    const runner: NpmRunner = {
      async run () {
        return { status: 1, stderr: 'plain npm failure' }
      },
    }
    try {
      await ensureMcpRemoteRuntime({ runner })
    } catch (err) {
      captured = `${(err as Error).message}\n${(err as Error).stack ?? ''}`
    }
    assert.ok(captured.length > 0)
    for (const secret of ['super-secret-service-token-1234', 'org-id-secret-5678', 'canary-env-secret-9012']) {
      assert.ok(!captured.includes(secret), `output must not contain ${secret}`)
    }
  })
})

describe('default runner and npm resolution', () => {
  it('runs npm without a shell, with separated argv, from the injected entry point', async () => {
    const fixtureDir = mkdtempSync(join(tmpdir(), 'nsolid-npm-fixture-'))
    const fakeNpm = join(fixtureDir, 'fake-npm.mjs')
    const argvOut = join(fixtureDir, 'argv.json')
    process.env.NSOLID_TEST_NPM_ARGV = argvOut
    try {
      writeFileSync(fakeNpm, [
        "import { mkdirSync, writeFileSync } from 'node:fs'",
        "import path from 'node:path'",
        'const out = process.env.NSOLID_TEST_NPM_ARGV',
        'if (out) writeFileSync(out, JSON.stringify(process.argv.slice(2)))',
        'const cwd = process.cwd()',
        "mkdirSync(path.join(cwd, 'node_modules', 'mcp-remote', 'dist'), { recursive: true })",
        `writeFileSync(path.join(cwd, 'node_modules', 'mcp-remote', 'package.json'), JSON.stringify({ name: 'mcp-remote', version: '${MCP_REMOTE_VERSION}', dependencies: {} }))`,
        "writeFileSync(path.join(cwd, 'node_modules', 'mcp-remote', 'dist', 'proxy.js'), '// proxy')",
        'process.exit(0)',
      ].join('\n'))

      const result = await ensureMcpRemoteRuntime({
        npmCommand: { command: process.execPath, args: [fakeNpm] },
      })

      assert.strictEqual(result.installed, true)
      const recorded = JSON.parse(readFileSync(argvOut, 'utf8')) as string[]
      // The real spawn path: one argv element per flag/value, no shell string.
      assert.deepStrictEqual(recorded.slice(0, 2), ['install', '--omit=dev'])
      assert.strictEqual(recorded.at(-1), `mcp-remote@${MCP_REMOTE_VERSION}`)
      assert.strictEqual(recorded.filter((a) => a.includes('&&') || a.includes(' ; ')).length, 0)
      assert.strictEqual(inspectMcpRemoteRuntime().status, 'ready')
    } finally {
      delete process.env.NSOLID_TEST_NPM_ARGV
      rmSync(fixtureDir, { recursive: true, force: true })
    }
  })

  it('kills npm and reports a timeout through the real spawn path', async () => {
    const fixtureDir = mkdtempSync(join(tmpdir(), 'nsolid-npm-timeout-'))
    try {
      const slowNpm = join(fixtureDir, 'slow-npm.mjs')
      // Keep the event loop alive so only the kill timer can end this process.
      writeFileSync(slowNpm, 'setInterval(() => {}, 1000)\nawait new Promise(() => {})\n')
      await assert.rejects(
        ensureMcpRemoteRuntime({
          npmCommand: { command: process.execPath, args: [slowNpm] },
          timeoutMs: 300,
        }),
        (err: unknown) => {
          assert.match((err as Error).message, /timed out after \d+s/)
          assert.match((err as Error).message, /rerun setup/i)
          return true
        }
      )
      assert.deepStrictEqual(runtimeParentEntries(), [])
    } finally {
      rmSync(fixtureDir, { recursive: true, force: true })
    }
  })

  it('prefers a validated absolute npm_execpath and never PATH or project .bin', () => {
    const projectDir = mkdtempSync(join(tmpdir(), 'nsolid-evil-bin-'))
    const originalPath = process.env.PATH
    try {
      const evilBin = join(projectDir, 'node_modules', '.bin')
      mkdirSync(evilBin, { recursive: true })
      writeFileSync(join(evilBin, 'npm'), '#!/bin/sh\necho pwned\n')
      process.env.PATH = `${evilBin}${delimiter}${process.env.PATH}`

      // No npm_execpath: resolution must come from the Node installation dir,
      // never from PATH (which now has the attacker's bin first).
      delete process.env.npm_execpath
      const resolved = resolveNpmCommand()
      assert.ok(!resolved.command.includes(evilBin), 'must not resolve npm from project .bin')
      assert.ok(!resolved.command.includes('pwned'))
      assert.ok(
        resolved.command === process.execPath || resolved.command.startsWith(dirname(process.execPath) + sep),
        `resolved npm must live next to node: ${resolved.command}`
      )

      // A valid npm_execpath wins and is executed with node + separated argv.
      const fakeCli = join(projectDir, 'npm-cli.js')
      writeFileSync(fakeCli, '// fake npm cli\n')
      process.env.npm_execpath = fakeCli
      const byEnv = resolveNpmCommand()
      assert.deepStrictEqual(byEnv, { command: process.execPath, args: [fakeCli] })
    } finally {
      process.env.PATH = originalPath
      rmSync(projectDir, { recursive: true, force: true })
    }
  })

  it('ignores a non-npm npm_execpath (pnpm/yarn) and falls back to node-dir npm', () => {
    // Mirror real layouts: pnpm under a user prefix, yarn under ~/.yarn/releases.
    const pnpmCli = join(tmpHome, '.local', 'share', 'pnpm', 'lib', 'node_modules', 'pnpm', 'bin', 'pnpm.cjs')
    mkdirSync(dirname(pnpmCli), { recursive: true })
    writeFileSync(pnpmCli, '// pnpm cli\n')
    const yarnCli = join(tmpHome, '.yarn', 'releases', 'yarn-4.0.0.cjs')
    mkdirSync(dirname(yarnCli), { recursive: true })
    writeFileSync(yarnCli, '// yarn cli\n')

    // Baseline: what resolution looks like with no npm_execpath at all.
    delete process.env.npm_execpath
    const fallback = resolveNpmCommand()

    for (const foreign of [pnpmCli, yarnCli]) {
      process.env.npm_execpath = foreign
      const resolved = resolveNpmCommand()
      assert.notStrictEqual(resolved.args[0], foreign, `${basename(foreign)} must not be used as npm`)
      assert.deepStrictEqual(resolved, fallback, 'must fall back to the node-dir npm resolution')
      assert.ok(
        resolved.command === process.execPath || resolved.command.startsWith(dirname(process.execPath) + sep),
        `resolved npm must live next to node: ${resolved.command}`
      )
    }
  })

  it('ignores a non-absolute or missing npm_execpath', () => {
    process.env.npm_execpath = 'relative/npm-cli.js'
    const resolved = resolveNpmCommand()
    assert.notStrictEqual(resolved.args[0], 'relative/npm-cli.js')
    process.env.npm_execpath = join(tmpHome, 'definitely-missing-npm.js')
    const resolved2 = resolveNpmCommand()
    assert.notStrictEqual(resolved2.args[0], process.env.npm_execpath)
  })
})
