import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, dirname, join, sep } from 'node:path'

import {
  MCP_REMOTE_VERSION,
  McpRemoteRuntimeError,
  ensureMcpRemoteRuntime,
  inspectMcpRemoteRuntime,
  resolveNpmCommand,
  resolveNpmCommandForExecPath,
  type NpmRunner,
  type PublishTestControls,
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

function runtimeParent (): string {
  return join(tmpHome, '.agents', 'nsolid-plugin', 'runtime', 'mcp-remote')
}

function runtimeRoot (): string {
  return join(runtimeParent(), MCP_REMOTE_VERSION)
}

function lockPath (): string {
  return join(runtimeParent(), `.publish-${MCP_REMOTE_VERSION}.lock`)
}

interface SeedOptions {
  /** Tree root to seed (defaults to the versioned runtime root). */
  root?: string
  version?: string
  withProxy?: boolean
  /** Packages actually present under node_modules; name/version/deps per package. */
  dependencies?: Record<string, { version?: string; name?: string; dependencies?: Record<string, string> }>
  /** Ranges mcp-remote declares for its dependencies (default ^1.0.0). */
  ranges?: Record<string, string>
  /** Extra dependencies declared but deliberately NOT installed. */
  declareWithoutInstalling?: string[]
}

/** Names mcp-remote declares as dependencies in the seeded fixture. */
const SEED_DECLARED = ['express', 'open', 'strict-url-sanitise', 'undici']
const EXPECTED_NPM_INSTALL_ARGS = [
  'install',
  '--omit=dev',
  '--ignore-scripts',
  '--no-audit',
  '--no-fund',
  '--save-exact',
  '--no-package-lock',
  `mcp-remote@${MCP_REMOTE_VERSION}`,
]

/** Seed a runtime tree directly (no npm). Defaults produce a fully valid runtime. */
function seedRuntime (options: SeedOptions = {}): void {
  const {
    root = runtimeRoot(),
    version = MCP_REMOTE_VERSION,
    withProxy = true,
    dependencies = {
      express: {},
      open: {},
      'strict-url-sanitise': {},
      undici: {},
    },
    ranges = {},
    declareWithoutInstalling = [],
  } = options
  const mcpRemoteDir = join(root, 'node_modules', 'mcp-remote')
  mkdirSync(mcpRemoteDir, { recursive: true })
  const declared = [...SEED_DECLARED, ...declareWithoutInstalling]
  writeFileSync(
    join(mcpRemoteDir, 'package.json'),
    JSON.stringify({
      name: 'mcp-remote',
      version,
      dependencies: Object.fromEntries(declared.map((name) => [name, ranges[name] ?? '^1.0.0'])),
    })
  )
  if (withProxy) {
    mkdirSync(join(mcpRemoteDir, 'dist'), { recursive: true })
    writeFileSync(join(mcpRemoteDir, 'dist', 'proxy.js'), '// proxy\n')
  }
  for (const [name, pkg] of Object.entries(dependencies)) {
    const depDir = join(root, 'node_modules', name)
    mkdirSync(depDir, { recursive: true })
    writeFileSync(join(depDir, 'package.json'), JSON.stringify({ name: pkg.name ?? name, version: pkg.version ?? '1.0.0', ...(pkg.dependencies ? { dependencies: pkg.dependencies } : {}) }))
  }
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'nsolid-plugin-mcp-remote-runtime', private: true }))
}

function runtimeParentEntries (): string[] {
  if (!existsSync(runtimeParent())) return []
  return readdirSync(runtimeParent())
}

/** Write a publication lock record directly (protocol tests). */
function seedLock (record: { token: string; pid: number; createdAt: number }): void {
  mkdirSync(runtimeParent(), { recursive: true })
  writeFileSync(lockPath(), JSON.stringify(record))
}

/** A PID that is definitely dead (spawned, reaped, exited). */
function deadPid (): number {
  const child = spawnSync(process.execPath, ['-e', ''], { timeout: 10_000 })
  assert.strictEqual(child.status, 0, 'probe child must exit cleanly')
  const pid = child.pid as number
  // The synchronous spawn reaped the child, so its pid is proven gone.
  assert.throws(() => process.kill(pid, 0), (err: NodeJS.ErrnoException) => err.code === 'ESRCH', 'probe pid must be dead')
  return pid
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
    assert.strictEqual(status.proxyPath, realpathSync(join(runtimeRoot(), 'node_modules', 'mcp-remote', 'dist', 'proxy.js')))
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

  it('reports invalid for a wrong-named transitive dependency', () => {
    seedRuntime({
      dependencies: {
        express: { name: 'not-express' },
        open: {},
        'strict-url-sanitise': {},
        undici: {},
      },
    })
    const status = inspectMcpRemoteRuntime()
    assert.strictEqual(status.status, 'invalid')
    assert.match(status.reason ?? '', /dependency "express" required by "mcp-remote" resolved to a package named "not-express"/)
  })

  it('reports invalid for an incompatible transitive version', () => {
    seedRuntime({
      dependencies: {
        express: { version: '1.0.0' },
        open: {},
        'strict-url-sanitise': {},
        undici: {},
      },
      ranges: { express: '^2.0.0' },
    })
    const status = inspectMcpRemoteRuntime()
    assert.strictEqual(status.status, 'invalid')
    assert.match(status.reason ?? '', /dependency "express".*"1\.0\.0" which does not satisfy "\^2\.0\.0"/)
  })

  it('reports invalid for an unparseable dependency range (fails closed)', () => {
    seedRuntime({
      dependencies: {
        express: {},
        open: {},
        'strict-url-sanitise': {},
        undici: {},
      },
      ranges: { express: 'workspace:*' },
    })
    const status = inspectMcpRemoteRuntime()
    assert.strictEqual(status.status, 'invalid')
    assert.match(status.reason ?? '', /dependency "express" required by "mcp-remote" declares the unsupported range "workspace:\*"/)
  })

  it('reports invalid when a resolved dependency escapes the runtime root via symlink', () => {
    seedRuntime()
    const outside = join(tmpHome, 'outside-pkgs', 'express')
    mkdirSync(outside, { recursive: true })
    writeFileSync(join(outside, 'package.json'), JSON.stringify({ name: 'express', version: '1.0.0' }))
    rmSync(join(runtimeRoot(), 'node_modules', 'express'), { recursive: true, force: true })
    symlinkSync(outside, join(runtimeRoot(), 'node_modules', 'express'))

    const status = inspectMcpRemoteRuntime()
    assert.strictEqual(status.status, 'invalid')
    assert.match(status.reason ?? '', /dependency "express" required by "mcp-remote" resolves outside the runtime root/)
  })

  it('rejects a whole runtime root symlink whose target escapes the controlled parent', () => {
    seedRuntime()
    const outside = join(tmpHome, 'outside-version-root')
    renameSync(runtimeRoot(), outside)
    symlinkSync(outside, runtimeRoot(), process.platform === 'win32' ? 'junction' : 'dir')

    const status = inspectMcpRemoteRuntime()
    assert.strictEqual(status.status, 'invalid')
    assert.match(status.reason ?? '', /runtime root .*outside the controlled runtime parent/)
  })

  it('rejects a runtime root symlink that resolves to exactly the controlled parent', () => {
    // Canonical equality with the parent must not satisfy "below the parent":
    // the versioned root is a strict descendant, so a tree living directly in
    // the parent can never stand in for the versioned runtime.
    seedRuntime({ root: runtimeParent() })
    symlinkSync(runtimeParent(), runtimeRoot(), process.platform === 'win32' ? 'junction' : 'dir')

    const status = inspectMcpRemoteRuntime()
    assert.strictEqual(status.status, 'invalid')
    assert.match(status.reason ?? '', /runtime root must resolve strictly below the controlled runtime parent/)
  })

  it('rejects a symlinked mcp-remote package directory whose target escapes the runtime root', () => {
    // A complete, valid-looking tree outside the root must not satisfy the
    // entry package through a symlink: lexical presence is not readiness.
    seedRuntime()
    const outside = join(tmpHome, 'outside-root', 'mcp-remote')
    mkdirSync(join(outside, 'dist'), { recursive: true })
    writeFileSync(join(outside, 'package.json'), JSON.stringify({ name: 'mcp-remote', version: MCP_REMOTE_VERSION, dependencies: {} }))
    writeFileSync(join(outside, 'dist', 'proxy.js'), '// proxy\n')
    rmSync(join(runtimeRoot(), 'node_modules', 'mcp-remote'), { recursive: true, force: true })
    symlinkSync(outside, join(runtimeRoot(), 'node_modules', 'mcp-remote'))

    const status = inspectMcpRemoteRuntime()
    assert.strictEqual(status.status, 'invalid')
    assert.match(status.reason ?? '', /node_modules\/mcp-remote .*outside the runtime root/)
  })

  it('rejects a symlinked dist/proxy.js whose target escapes the runtime root', () => {
    seedRuntime()
    const outsideProxy = join(tmpHome, 'outside-proxy.js')
    writeFileSync(outsideProxy, '// evil proxy\n')
    const proxy = join(runtimeRoot(), 'node_modules', 'mcp-remote', 'dist', 'proxy.js')
    rmSync(proxy)
    symlinkSync(outsideProxy, proxy)

    const status = inspectMcpRemoteRuntime()
    assert.strictEqual(status.status, 'invalid')
    assert.match(status.reason ?? '', /proxy\.js .*outside the runtime root/)
  })

  it('rejects a symlinked package manifest whose target escapes the runtime root', () => {
    seedRuntime()
    const outsideManifest = join(tmpHome, 'outside-manifest.json')
    writeFileSync(outsideManifest, JSON.stringify({ name: 'mcp-remote', version: MCP_REMOTE_VERSION, dependencies: {} }))
    const manifest = join(runtimeRoot(), 'node_modules', 'mcp-remote', 'package.json')
    rmSync(manifest)
    symlinkSync(outsideManifest, manifest)

    const status = inspectMcpRemoteRuntime()
    assert.strictEqual(status.status, 'invalid')
    assert.match(status.reason ?? '', /package\.json .*outside the runtime root/)
  })

  it('ignores peer and dev dependencies while walking the closure', () => {
    // Runtime-install semantics: only `dependencies` (required) and
    // `optionalDependencies` (tolerated when missing) participate. peer and
    // dev entries that are not installed must not invalidate the runtime.
    seedRuntime()
    const manifest = join(runtimeRoot(), 'node_modules', 'mcp-remote', 'package.json')
    const pkg = JSON.parse(readFileSync(manifest, 'utf8')) as Record<string, unknown>
    pkg.peerDependencies = { 'peer-only-pkg': '^1.0.0' }
    pkg.devDependencies = { 'dev-only-pkg': '^1.0.0' }
    writeFileSync(manifest, JSON.stringify(pkg))

    assert.strictEqual(inspectMcpRemoteRuntime().status, 'ready')
  })

  it('never satisfies the closure from a package.json above the runtime root', () => {
    seedRuntime({
      dependencies: {
        express: {},
        // open only exists ABOVE the runtime root — resolution must stop at the root.
      },
    })
    const above = join(runtimeParent(), 'node_modules', 'open')
    mkdirSync(above, { recursive: true })
    writeFileSync(join(above, 'package.json'), JSON.stringify({ name: 'open', version: '1.0.0' }))

    const status = inspectMcpRemoteRuntime()
    assert.strictEqual(status.status, 'invalid')
    assert.match(status.reason ?? '', /dependency "open" required by "mcp-remote" is missing inside the runtime root/)
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

  it('satisfied ranges use the declared syntax (x-ranges, hyphen, ||)', () => {
    seedRuntime({
      dependencies: {
        express: { version: '1.4.2' },
        open: { version: '9.0.0' },
        'strict-url-sanitise': { version: '1.0.1' },
        undici: { version: '5.28.0' },
      },
      ranges: {
        express: '1.x',
        open: '>=8.0.0 <10.0.0',
        'strict-url-sanitise': '1.0.0 - 1.0.2',
        undici: '^5.0.0 || ^6.0.0',
      },
    })
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
    assert.strictEqual(result.proxyPath, realpathSync(join(runtimeRoot(), 'node_modules', 'mcp-remote', 'dist', 'proxy.js')))
    assert.strictEqual(calls.length, 1)
    assert.strictEqual(dirname(calls[0].cwd), runtimeParent(), 'npm ran inside a same-parent staging sibling')
    assert.deepStrictEqual(calls[0].args.slice(-EXPECTED_NPM_INSTALL_ARGS.length), EXPECTED_NPM_INSTALL_ARGS)

    assert.strictEqual(inspectMcpRemoteRuntime().status, 'ready')
    assert.deepStrictEqual(runtimeParentEntries(), [MCP_REMOTE_VERSION], 'staging consumed, lock released')
  })

  it('fails closed on EXDEV publication without copying staging into the runtime root', async () => {
    const calls: Array<{ command: string; args: string[]; cwd: string }> = []
    let rejectedPublication = false

    await assert.rejects(
      ensureMcpRemoteRuntime({
        runner: createFakeRunner(calls),
        publish: {
          rename: (from, to) => {
            if (String(from).includes('.staging-') && String(to) === runtimeRoot()) {
              rejectedPublication = true
              throw Object.assign(new Error('cross-device link not permitted'), { code: 'EXDEV' })
            }
            renameSync(from, to)
          },
        },
      }),
      /Could not publish the mcp-remote runtime.*cross-device link not permitted/
    )

    assert.strictEqual(rejectedPublication, true, 'the publication rename was attempted')
    assert.strictEqual(existsSync(runtimeRoot()), false, 'no copy fallback published a runtime')
    assert.deepStrictEqual(runtimeParentEntries(), [], 'owned staging, sidecar and lock were cleaned')
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
    assert.deepStrictEqual(runtimeParentEntries(), [MCP_REMOTE_VERSION], 'no stale leftovers, lock released')
  })

  it('repairs a runtime root symlink whose target escapes the controlled parent', async () => {
    // The invalid root is a symlink pointing outside the managed parent.
    // Repair must still converge: publish the replacement, remove the
    // moved-aside link lexically (never following it — the referent must
    // survive untouched) and leave no stale artifacts behind.
    const outside = join(tmpHome, 'outside-root-referent')
    mkdirSync(outside, { recursive: true })
    const sentinel = join(outside, 'sentinel.txt')
    writeFileSync(sentinel, 'do not delete\n')
    mkdirSync(runtimeParent(), { recursive: true })
    symlinkSync(outside, runtimeRoot(), process.platform === 'win32' ? 'junction' : 'dir')
    const calls: Array<{ command: string; args: string[]; cwd: string }> = []

    const result = await ensureMcpRemoteRuntime({ runner: createFakeRunner(calls) })

    assert.strictEqual(result.installed, true)
    assert.strictEqual(inspectMcpRemoteRuntime().status, 'ready')
    assert.ok(lstatSync(runtimeRoot()).isDirectory(), 'published root is a real directory, not the link')
    assert.deepStrictEqual(runtimeParentEntries(), [MCP_REMOTE_VERSION], 'stale link and sidecar removed, lock released')
    assert.strictEqual(readFileSync(sentinel, 'utf8'), 'do not delete\n', 'link referent was never touched')
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

  it('reports timeouts distinctly and cleans staging after confirmed termination', async () => {
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
    // Termination was confirmed (no terminationError): staging is inert-free.
    assert.deepStrictEqual(runtimeParentEntries(), [], 'staging cleaned after confirmed termination')
  })

  it('surfaces a spawn error distinctly and cleans staging (no installer started)', async () => {
    const runner: NpmRunner = {
      async run () {
        return { status: null, stderr: '', spawnError: 'spawn npm ENOENT' }
      },
    }
    await assert.rejects(
      ensureMcpRemoteRuntime({ runner }),
      (err: unknown) => {
        assert.ok(err instanceof McpRemoteRuntimeError)
        const message = (err as Error).message
        assert.match(message, /Could not start the npm installer \(spawn npm ENOENT\)/)
        assert.doesNotMatch(message, /exit /, 'spawn failure is never encoded as an exit status')
        assert.match(message, /Install Node\.js with npm/)
        return true
      }
    )
    assert.deepStrictEqual(runtimeParentEntries(), [], 'staging cleaned when nothing was spawned')
    assert.strictEqual(inspectMcpRemoteRuntime().status, 'missing')
  })

  it('marks staging retained-live on an unconfirmed termination and never publishes it', async () => {
    // An invalid pre-existing root: ensure must try to replace it, fail on the
    // unconfirmed termination, and leave both staging (marked retained-live
    // with ownership metadata) and the prior tree untouched. (A ready root
    // short-circuits before npm entirely.)
    seedRuntime({ version: '0.1.37' })
    const priorPkg = readFileSync(join(runtimeRoot(), 'node_modules', 'mcp-remote', 'package.json'), 'utf8')

    const runner: NpmRunner = {
      async run () {
        return { status: null, stderr: '', timedOut: true, terminationError: 'managed npm process group still exists after the confirmation deadline' }
      },
    }
    await assert.rejects(
      ensureMcpRemoteRuntime({ runner, timeoutMs: 50 }),
      (err: unknown) => {
        const message = (err as Error).message
        assert.match(message, /could not be confirmed stopped/)
        assert.match(message, /retained-live/)
        assert.match(message, /Rerun setup/)
        return true
      }
    )

    // Staging remains on disk marked retained-live (a survivor may still
    // mutate it), with its ownership sidecar recording the state…
    const preserved = runtimeParentEntries()
    const stagingTrees = preserved.filter((e) => e.startsWith('.staging-') && !e.endsWith('.owner.json'))
    assert.strictEqual(stagingTrees.length, 1, 'staging preserved')
    const stagingSidecars = preserved.filter((e) => e.startsWith('.staging-') && e.endsWith('.owner.json'))
    assert.strictEqual(stagingSidecars.length, 1, 'ownership sidecar preserved')
    const sidecar = JSON.parse(readFileSync(join(runtimeParent(), stagingSidecars[0] as string), 'utf8')) as {
      state?: string
      pid?: number
      createdAt?: number
    }
    assert.strictEqual(sidecar.state, 'retained-live', 'sidecar records retained-live ownership')
    assert.ok(typeof sidecar.pid === 'number' && sidecar.pid > 0)
    assert.ok(typeof sidecar.createdAt === 'number')
    // …nothing was validated or published, and the previous root is intact.
    assert.strictEqual(inspectMcpRemoteRuntime().status, 'invalid', 'root never replaced after terminationError')
    assert.strictEqual(
      readFileSync(join(runtimeRoot(), 'node_modules', 'mcp-remote', 'package.json'), 'utf8'),
      priorPkg,
      'pre-existing runtime untouched'
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

  it('keeps every pre-existing invalid runtime untouched when npm or staging validation fails', async () => {
    // The invalidity kind must not matter: wrong version, missing proxy or an
    // incomplete dependency closure — a failed attempt (npm error or a
    // staging tree that fails validation) never modifies the prior tree.
    const variants: Array<[string, () => void]> = [
      ['wrong version', () => seedRuntime({ version: '0.1.37' })],
      ['missing proxy', () => seedRuntime({ withProxy: false })],
      ['incomplete dependency closure', () => seedRuntime({ dependencies: { express: {}, open: {}, 'strict-url-sanitise': {} } })],
    ]
    const snapshot = (): string[] => {
      const files: string[] = []
      const walk = (dir: string, prefix: string): void => {
        for (const entry of readdirSync(dir, { withFileTypes: true })) {
          const rel = prefix === '' ? entry.name : `${prefix}/${entry.name}`
          if (entry.isDirectory()) walk(join(dir, entry.name), rel)
          else if (entry.isFile()) files.push(`${rel}::${readFileSync(join(dir, entry.name), 'utf8')}`)
        }
      }
      walk(runtimeRoot(), '')
      return files.sort()
    }

    for (const [label, seed] of variants) {
      rmSync(runtimeParent(), { recursive: true, force: true })
      seed()
      const before = snapshot()

      await assert.rejects(
        ensureMcpRemoteRuntime({ runner: createFakeRunner([], 'fail') }),
        McpRemoteRuntimeError,
        `npm failure must reject (${label})`
      )
      assert.deepStrictEqual(snapshot(), before, `invalid runtime untouched after npm failure (${label})`)

      await assert.rejects(
        ensureMcpRemoteRuntime({ runner: createFakeRunner([], 'invalid') }),
        /Staged mcp-remote runtime failed validation/,
        `staging validation failure must reject (${label})`
      )
      assert.deepStrictEqual(snapshot(), before, `invalid runtime untouched after staging validation failure (${label})`)
    }
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
    assert.deepStrictEqual(runtimeParentEntries(), [MCP_REMOTE_VERSION], 'no staging/stale/lock leftovers')
    // Both raced before either published, so both staged; one publish won.
    assert.strictEqual(calls.length, 2)
    assert.strictEqual(a.root, b.root)
    assert.ok(statSync(runtimeRoot()).isDirectory())
  })

  it('two setups replacing the same invalid root converge under the lock', async () => {
    seedRuntime({ version: '0.1.37' })
    const runner: NpmRunner = {
      async run (_command, _args, options) {
        await new Promise((resolve) => setTimeout(resolve, 20))
        mkdirSync(join(options.cwd, 'node_modules', 'mcp-remote', 'dist'), { recursive: true })
        writeFileSync(join(options.cwd, 'node_modules', 'mcp-remote', 'package.json'), JSON.stringify({ name: 'mcp-remote', version: MCP_REMOTE_VERSION, dependencies: {} }))
        writeFileSync(join(options.cwd, 'node_modules', 'mcp-remote', 'dist', 'proxy.js'), '// proxy\n')
        return { status: 0, stderr: '' }
      },
    }

    await Promise.all([
      ensureMcpRemoteRuntime({ runner, publish: { lockWaitMs: 10_000 } }),
      ensureMcpRemoteRuntime({ runner, publish: { lockWaitMs: 10_000 } }),
    ])

    assert.strictEqual(inspectMcpRemoteRuntime().status, 'ready')
    assert.deepStrictEqual(runtimeParentEntries(), [MCP_REMOTE_VERSION], 'loser accepted the winner; own staging/stale removed')
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

describe('publication lock protocol', () => {
  it('never evicts a young lock, whatever the holder', async () => {
    const createdAt = Date.now()
    const record = JSON.stringify({ token: 'foreign-token', pid: process.pid, createdAt })
    seedLock({ token: 'foreign-token', pid: process.pid, createdAt })
    const calls: Array<{ command: string; args: string[]; cwd: string }> = []

    await assert.rejects(
      ensureMcpRemoteRuntime({ runner: createFakeRunner(calls), publish: { lockWaitMs: 120, staleLockMs: 60_000 } }),
      (err: unknown) => {
        assert.match((err as Error).message, /Another setup is publishing/)
        return true
      }
    )
    assert.strictEqual(inspectMcpRemoteRuntime().status, 'missing', 'root untouched')
    assert.strictEqual(readFileSync(lockPath(), 'utf8'), record, 'foreign lock byte-for-byte intact (token mismatch never unlinked)')
    assert.deepStrictEqual(runtimeParentEntries().sort(), ['.publish-0.1.38.lock'], 'only the foreign lock remains')
  })

  it('never evicts an aged lock held by a live process', async () => {
    const foreignToken = 'live-holder-token'
    seedLock({ token: foreignToken, pid: process.pid, createdAt: Date.now() - 600_000 })
    const calls: Array<{ command: string; args: string[]; cwd: string }> = []

    await assert.rejects(
      ensureMcpRemoteRuntime({ runner: createFakeRunner(calls), publish: { lockWaitMs: 120, staleLockMs: 1 } }),
      (err: unknown) => {
        assert.match((err as Error).message, /Another setup is publishing/)
        return true
      }
    )
    const record = JSON.parse(readFileSync(lockPath(), 'utf8')) as { token: string }
    assert.strictEqual(record.token, foreignToken, 'live holder never evicted by age alone')
    assert.strictEqual(inspectMcpRemoteRuntime().status, 'missing')
  })

  it('treats a permission-denied liveness check as a live holder (fail closed)', { skip: process.platform === 'win32' }, async () => {
    // PID 1 exists and is owned by another user: kill(pid, 0) → EPERM, which
    // must NOT authorize takeover.
    seedLock({ token: 'root-owned-token', pid: 1, createdAt: Date.now() - 600_000 })
    const calls: Array<{ command: string; args: string[]; cwd: string }> = []

    await assert.rejects(
      ensureMcpRemoteRuntime({ runner: createFakeRunner(calls), publish: { lockWaitMs: 120, staleLockMs: 1 } }),
      (err: unknown) => {
        assert.match((err as Error).message, /Another setup is publishing/)
        return true
      }
    )
    assert.ok(existsSync(lockPath()), 'lock intact')
  })

  it('treats a malformed lock record as owned (fail closed)', async () => {
    mkdirSync(runtimeParent(), { recursive: true })
    writeFileSync(lockPath(), 'this is not json')
    const calls: Array<{ command: string; args: string[]; cwd: string }> = []

    await assert.rejects(
      ensureMcpRemoteRuntime({ runner: createFakeRunner(calls), publish: { lockWaitMs: 120, staleLockMs: 1 } }),
      (err: unknown) => {
        assert.match((err as Error).message, /Another setup is publishing/)
        return true
      }
    )
    assert.strictEqual(readFileSync(lockPath(), 'utf8'), 'this is not json', 'malformed lock left in place')
  })

  it('breaks a dead stale lock and reacquires with a fresh O_EXCL create', async () => {
    const dead = deadPid()
    seedLock({ token: 'dead-holder-token', pid: dead, createdAt: Date.now() - 600_000 })
    const calls: Array<{ command: string; args: string[]; cwd: string }> = []

    const result = await ensureMcpRemoteRuntime({ runner: createFakeRunner(calls), publish: { staleLockMs: 1, lockWaitMs: 2_000 } })

    assert.strictEqual(result.installed, true)
    assert.strictEqual(inspectMcpRemoteRuntime().status, 'ready')
    assert.deepStrictEqual(runtimeParentEntries(), [MCP_REMOTE_VERSION], 'tombstone deleted, fresh lock released')
  })

  it('two simultaneous stale-lock breakers converge: exactly one publishes', async () => {
    const dead = deadPid()
    seedLock({ token: 'dead-holder-token', pid: dead, createdAt: Date.now() - 600_000 })
    const runner: NpmRunner = {
      async run (_command, _args, options) {
        await new Promise((resolve) => setTimeout(resolve, 10))
        mkdirSync(join(options.cwd, 'node_modules', 'mcp-remote', 'dist'), { recursive: true })
        writeFileSync(join(options.cwd, 'node_modules', 'mcp-remote', 'package.json'), JSON.stringify({ name: 'mcp-remote', version: MCP_REMOTE_VERSION, dependencies: {} }))
        writeFileSync(join(options.cwd, 'node_modules', 'mcp-remote', 'dist', 'proxy.js'), '// proxy\n')
        return { status: 0, stderr: '' }
      },
    }
    const publish: PublishTestControls = { staleLockMs: 1, lockWaitMs: 10_000 }

    const [a, b] = await Promise.all([
      ensureMcpRemoteRuntime({ runner, publish }),
      ensureMcpRemoteRuntime({ runner, publish }),
    ])

    assert.strictEqual(a.root, b.root)
    assert.strictEqual(inspectMcpRemoteRuntime().status, 'ready')
    assert.deepStrictEqual(runtimeParentEntries(), [MCP_REMOTE_VERSION], 'no tombstones, no leftover staging, lock released')
  })

  it('recovers deterministically after an interruption between the replacement renames', async () => {
    // An invalid runtime is being replaced; the replacing process dies after
    // `root → stale` but before `staging → root`.
    seedRuntime({ version: '0.1.37' })
    const dead = deadPid()
    const calls: Array<{ command: string; args: string[]; cwd: string }> = []

    await assert.rejects(
      ensureMcpRemoteRuntime({
        runner: createFakeRunner(calls),
        publish: {
          holderPid: dead,
          afterRootAside: () => { throw new Error('simulated kill -9 between the replacement renames') },
        },
      }),
      (err: unknown) => {
        assert.match((err as Error).message, /simulated kill -9/)
        return true
      }
    )

    // Post-crash state: root absent, stale sibling with its ownership
    // sidecar, orphaned staging with its sidecar, lock still on disk with the
    // dead holder.
    assert.strictEqual(existsSync(runtimeRoot()), false, 'root is absent')
    const staleSiblings = runtimeParentEntries().filter(
      (e) => e.startsWith(`${MCP_REMOTE_VERSION}.stale-`) && !e.endsWith('.owner.json')
    )
    assert.strictEqual(staleSiblings.length, 1, 'renamed-aside tree is an inert sibling')
    assert.strictEqual(
      runtimeParentEntries().filter((e) => e.startsWith(`${MCP_REMOTE_VERSION}.stale-`) && e.endsWith('.owner.json')).length,
      1,
      'stale tree keeps its ownership sidecar'
    )
    assert.strictEqual(
      runtimeParentEntries().filter((e) => e.startsWith('.staging-') && !e.endsWith('.owner.json')).length,
      1,
      'orphaned staging left in place'
    )
    assert.ok(existsSync(lockPath()), 'lock survived the interruption')

    // Retry: breaks the dead-holder lock, publishes through the root-absent
    // branch — the orphaned stale sibling is neither promoted nor required.
    const retry = await ensureMcpRemoteRuntime({ runner: createFakeRunner(calls), publish: { staleLockMs: 1, lockWaitMs: 5_000 } })
    assert.strictEqual(retry.installed, true)
    assert.strictEqual(inspectMcpRemoteRuntime().status, 'ready')

    const entries = runtimeParentEntries()
    assert.ok(entries.includes(MCP_REMOTE_VERSION), 'exactly one valid runtime published')
    assert.ok(entries.includes(staleSiblings[0] as string), 'orphaned stale sibling stays inert (never promoted, never GC)')
    assert.strictEqual(entries.filter((e) => e === MCP_REMOTE_VERSION).length, 1)
    assert.strictEqual(entries.filter((e) => e.startsWith('.publish-')).length, 0, 'lock released by the retry')
  })
})

describe('safe orphan reclamation', () => {
  interface OrphanSeed {
    kind: 'staging' | 'stale'
    state?: 'active' | 'retained-live'
    pid?: number
    /** Sidecar age (ms); defaults to well past any test grace period. */
    ageMs?: number
    managedPid?: number
    token?: string
    malformed?: boolean
  }

  /** Seed an orphaned temporary tree with its adjacent ownership sidecar. */
  function seedOrphan (seed: OrphanSeed): { tree: string; sidecar: string } {
    mkdirSync(runtimeParent(), { recursive: true })
    const name = seed.kind === 'staging'
      ? `.staging-1-${randomUUID()}`
      : `${MCP_REMOTE_VERSION}.stale-${randomUUID()}`
    const tree = join(runtimeParent(), name)
    mkdirSync(tree, { recursive: true })
    writeFileSync(join(tree, 'marker.txt'), 'orphan\n')
    const sidecar = `${tree}.owner.json`
    if (seed.malformed) {
      writeFileSync(sidecar, '{not json')
    } else {
      writeFileSync(sidecar, JSON.stringify({
        token: seed.token ?? `orphan-token-${randomUUID()}`,
        pid: seed.pid ?? deadPid(),
        createdAt: Date.now() - (seed.ageMs ?? 120_000),
        state: seed.state ?? 'retained-live',
        ...(seed.managedPid !== undefined ? { managedPid: seed.managedPid } : {}),
      }))
    }
    return { tree, sidecar }
  }

  it('reclaims a retained-live staging orphan after the grace period once its creator is proven dead', async () => {
    seedRuntime({ version: '0.1.37' }) // invalid root forces the publish path
    const orphan = seedOrphan({ kind: 'staging' })
    const calls: Array<{ command: string; args: string[]; cwd: string }> = []

    const result = await ensureMcpRemoteRuntime({
      runner: createFakeRunner(calls),
      publish: { reclaimGraceMs: 1 },
    })

    assert.strictEqual(result.installed, true)
    assert.strictEqual(inspectMcpRemoteRuntime().status, 'ready')
    assert.strictEqual(existsSync(orphan.tree), false, 'orphan tree reclaimed')
    assert.strictEqual(existsSync(orphan.sidecar), false, 'orphan sidecar reclaimed')
  })

  it('reclaims an orphan when the configured home resolves through a symlink', async () => {
    const linkedHome = `${tmpHome}-linked`
    symlinkSync(tmpHome, linkedHome, process.platform === 'win32' ? 'junction' : 'dir')
    process.env.HOME = linkedHome
    process.env.USERPROFILE = linkedHome

    try {
      seedRuntime({ version: '0.1.37' })
      const orphan = seedOrphan({ kind: 'staging' })

      await ensureMcpRemoteRuntime({
        runner: createFakeRunner([]),
        publish: { reclaimGraceMs: 1 },
      })

      assert.strictEqual(existsSync(orphan.tree), false, 'orphan tree reclaimed through canonical home')
      assert.strictEqual(existsSync(orphan.sidecar), false, 'orphan sidecar reclaimed through canonical home')
    } finally {
      process.env.HOME = tmpHome
      process.env.USERPROFILE = tmpHome
      rmSync(linkedHome, { recursive: true, force: true })
    }
  })

  it('retains an orphan whenever any single reclamation guard fails', async () => {
    // Each variant violates exactly one guard from the safe-reclamation
    // protocol; the tree and its sidecar must survive all of them.
    const variants: Array<{
      label: string
      seed: OrphanSeed
      graceMs?: number
      /** Runs before the orphan is seeded; may mutate `seed` (e.g. record a live managed pid). Returns a cleanup when needed. */
      setup?: (seed: OrphanSeed) => (() => void | Promise<void>) | void
    }> = [
      { label: 'grace period not elapsed', seed: { kind: 'staging', ageMs: 0 }, graceMs: 60_000 },
      { label: 'creator may still be alive', seed: { kind: 'staging', pid: process.pid } },
      { label: 'ownership metadata is malformed', seed: { kind: 'staging', malformed: true } },
      {
        label: 'a live publication lock carries the operation token',
        seed: { kind: 'staging', token: 'held-orphan-token' },
        setup: () => {
          // A lock for a different runtime version, held live, records the
          // orphan's operation token: its tree may still belong to a running
          // operation.
          mkdirSync(runtimeParent(), { recursive: true })
          writeFileSync(
            join(runtimeParent(), '.publish-0.1.99.lock'),
            JSON.stringify({ token: 'held-orphan-token', pid: process.pid, createdAt: Date.now() })
          )
        },
      },
      {
        label: 'the recorded managed process tree still exists',
        seed: { kind: 'staging' },
        setup: (seed) => {
          // A real detached group leader plays the surviving managed npm tree
          // (the runner spawns npm exactly this way).
          const survivor = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
            detached: true,
            stdio: 'ignore',
          })
          seed.managedPid = survivor.pid as number
          // Register the exit observation before any termination request is
          // sent, so a fast exit cannot race the listener.
          const exited = new Promise<void>((resolve) => {
            survivor.once('exit', () => resolve())
            survivor.once('close', () => resolve())
          })
          return async () => {
            const pid = survivor.pid as number
            if (process.platform === 'win32') {
              // Negative-PID process groups are a Unix-only construct (Node
              // throws for them on Windows); terminate the tree with
              // taskkill, matching the production runner's strategy.
              spawnSync('taskkill.exe', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' })
            } else {
              try {
                process.kill(-pid, 'SIGKILL')
              } catch {
                // Already gone.
              }
            }
            // Bound the confirmation wait: an unterminated survivor fails the
            // test instead of hanging the runner with a leaked process.
            const confirmed = await Promise.race([
              exited.then(() => true),
              new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 5_000)),
            ])
            assert.ok(confirmed, `cleanup could not confirm termination of the survivor process (pid ${pid})`)
            try {
              process.kill(pid, 0)
            } catch (err) {
              assert.strictEqual((err as NodeJS.ErrnoException).code, 'ESRCH', `survivor pid ${pid} must be fully gone after cleanup`)
              return
            }
            assert.fail(`survivor process (pid ${pid}) still exists after cleanup`)
          }
        },
      },
    ]

    for (const { label, seed, graceMs = 1, setup } of variants) {
      seedRuntime({ version: '0.1.37' }) // invalid root forces the publish path
      const cleanup = setup?.(seed)
      try {
        const orphan = seedOrphan(seed)
        await ensureMcpRemoteRuntime({ runner: createFakeRunner([]), publish: { reclaimGraceMs: graceMs } })
        assert.strictEqual(inspectMcpRemoteRuntime().status, 'ready', `${label}: the setup itself must still succeed`)
        assert.ok(existsSync(orphan.tree), `${label}: orphan tree retained`)
        assert.ok(existsSync(orphan.sidecar), `${label}: orphan sidecar retained`)
      } finally {
        await cleanup?.()
      }
    }
  })

  it('reclaims an orphaned stale tree only after a valid versioned root exists', async () => {
    // Phase 1: publish fails staging validation → the scan runs under the
    // lock, but the (still invalid) root forbids stale reclamation.
    seedRuntime({ version: '0.1.37' })
    const orphan = seedOrphan({ kind: 'stale' })
    await assert.rejects(
      ensureMcpRemoteRuntime({ runner: createFakeRunner([], 'invalid'), publish: { reclaimGraceMs: 1 } }),
      /Staged mcp-remote runtime failed validation/
    )
    assert.ok(existsSync(orphan.tree), 'stale orphan retained while no valid root exists')
    assert.ok(existsSync(orphan.sidecar), 'stale orphan sidecar retained while no valid root exists')

    // Phase 2: publish succeeds → root is valid under the lock → reclamation.
    await ensureMcpRemoteRuntime({ runner: createFakeRunner([]), publish: { reclaimGraceMs: 1 } })
    assert.strictEqual(inspectMcpRemoteRuntime().status, 'ready')
    assert.strictEqual(existsSync(orphan.tree), false, 'stale orphan reclaimed once a valid root exists')
    assert.strictEqual(existsSync(orphan.sidecar), false, 'stale orphan sidecar reclaimed')
  })

  it('reclaims a stale tree whose path is a symlink resolving outside the runtime parent', async () => {
    // A symlinked orphan is deleted lexically (its referent is never touched),
    // so it is reclaimable under the same ownership/liveness proofs even when
    // the link resolves outside the managed parent.
    seedRuntime({ version: '0.1.37' }) // invalid root forces the publish path
    const outside = join(tmpHome, 'outside-stale-referent')
    mkdirSync(outside, { recursive: true })
    const sentinel = join(outside, 'sentinel.txt')
    writeFileSync(sentinel, 'do not delete\n')
    const tree = join(runtimeParent(), `${MCP_REMOTE_VERSION}.stale-${randomUUID()}`)
    symlinkSync(outside, tree, process.platform === 'win32' ? 'junction' : 'dir')
    const sidecar = `${tree}.owner.json`
    writeFileSync(sidecar, JSON.stringify({
      token: `stale-token-${randomUUID()}`,
      pid: deadPid(),
      createdAt: Date.now() - 120_000,
      state: 'retained-live',
    }))

    const result = await ensureMcpRemoteRuntime({ runner: createFakeRunner([]), publish: { reclaimGraceMs: 1 } })

    assert.strictEqual(result.installed, true)
    assert.strictEqual(inspectMcpRemoteRuntime().status, 'ready')
    assert.strictEqual(existsSync(tree), false, 'symlinked stale tree reclaimed lexically')
    assert.strictEqual(existsSync(sidecar), false, 'symlinked stale tree sidecar reclaimed')
    assert.strictEqual(readFileSync(sentinel, 'utf8'), 'do not delete\n', 'link referent was never touched')
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
      assert.deepStrictEqual(recorded, EXPECTED_NPM_INSTALL_ARGS)
      assert.strictEqual(recorded.filter((a) => a.includes('&&') || a.includes(' ; ')).length, 0)
      assert.strictEqual(inspectMcpRemoteRuntime().status, 'ready')
    } finally {
      delete process.env.NSOLID_TEST_NPM_ARGV
      rmSync(fixtureDir, { recursive: true, force: true })
    }
  })

  it('kills npm and reports a timeout through the real spawn path (staging cleaned)', async () => {
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
      assert.deepStrictEqual(runtimeParentEntries(), [], 'termination confirmed, staging removed')
    } finally {
      rmSync(fixtureDir, { recursive: true, force: true })
    }
  })

  it('terminates the whole managed tree (grandchild included) before resolving', async () => {
    const fixtureDir = mkdtempSync(join(tmpdir(), 'nsolid-npm-tree-'))
    try {
      const treeNpm = join(fixtureDir, 'tree-npm.mjs')
      const pidsOut = join(fixtureDir, 'pids.json')
      writeFileSync(treeNpm, [
        "import { spawn } from 'node:child_process'",
        "import { writeFileSync } from 'node:fs'",
        "const grandchild = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' })",
        'writeFileSync(process.env.NSOLID_TEST_TREE_PIDS, JSON.stringify({ npm: process.pid, grandchild: grandchild.pid }))',
        'await new Promise(() => {})',
      ].join('\n'))
      process.env.NSOLID_TEST_TREE_PIDS = pidsOut

      await assert.rejects(
        ensureMcpRemoteRuntime({
          npmCommand: { command: process.execPath, args: [treeNpm] },
          timeoutMs: 300,
        }),
        (err: unknown) => {
          assert.match((err as Error).message, /timed out after \d+s/)
          return true
        }
      )

      const pids = JSON.parse(readFileSync(pidsOut, 'utf8')) as { npm: number; grandchild: number }
      assert.ok(Number.isInteger(pids.npm) && pids.npm > 0)
      assert.ok(Number.isInteger(pids.grandchild) && pids.grandchild > 0)
      for (const [label, pid] of Object.entries(pids)) {
        assert.throws(
          () => process.kill(pid as number, 0),
          (err: NodeJS.ErrnoException) => err.code === 'ESRCH',
          `${label} must be gone before the runner resolves`
        )
      }
      assert.deepStrictEqual(runtimeParentEntries(), [], 'termination confirmed, staging removed')
    } finally {
      delete process.env.NSOLID_TEST_TREE_PIDS
      rmSync(fixtureDir, { recursive: true, force: true })
    }
  })

  it('surfaces a real spawn failure (ENOENT) as spawnError, not an exit status', async () => {
    await assert.rejects(
      ensureMcpRemoteRuntime({
        npmCommand: { command: join(tmpHome, 'definitely-missing-npm'), args: [] },
      }),
      (err: unknown) => {
        const message = (err as Error).message
        assert.match(message, /Could not start the npm installer/)
        assert.match(message, /ENOENT/)
        assert.doesNotMatch(message, /exit /)
        return true
      }
    )
    assert.deepStrictEqual(runtimeParentEntries(), [], 'staging cleaned: no installer started')
  })

  it('keeps stderr bounded and never includes the environment', async () => {
    process.env.NSOLID_CANARY_SECRET = 'canary-env-secret-9012'
    const runner: NpmRunner = {
      async run () {
        return { status: 1, stderr: `leading-detail-that-must-be-truncated-away\n${'x'.repeat(10_000)}` }
      },
    }
    await assert.rejects(ensureMcpRemoteRuntime({ runner }), (err: unknown) => {
      const message = (err as Error).message
      assert.ok(message.length < 8192, 'error message bounded')
      assert.ok(!message.includes('leading-detail-that-must-be-truncated-away'), 'only the bounded tail is kept')
      assert.ok(!message.includes('canary-env-secret-9012'), 'environment never dumped')
      return true
    })
  })
})

describe('npm resolution (canonical, Node.js-anchored)', () => {
  /** Build a fake Node.js installation layout; the "node" binary is never executed. */
  function layoutDir (): string {
    // Canonicalize the fixture root: resolution returns realpath'd paths, and
    // on macOS the temp dir is a symlink (/var/folders → /private/var/folders).
    return realpathSync(mkdtempSync(join(tmpdir(), 'nsolid-node-layout-')))
  }
  function writeNode (dir: string, name = 'node'): string {
    mkdirSync(dir, { recursive: true })
    const exec = join(dir, name)
    writeFileSync(exec, '#!/bin/sh\nexit 0\n')
    chmodSync(exec, 0o755)
    return exec
  }
  function writeCli (dir: string, name = 'npm-cli.js'): string {
    const cli = join(dir, name)
    mkdirSync(dirname(cli), { recursive: true })
    writeFileSync(cli, '// npm cli\n')
    chmodSync(cli, 0o755) // shims are spawned directly and must be executable
    return cli
  }

  it('resolves the Windows installer layout: node-dir node_modules/npm CLI via [node, cli]', () => {
    const dir = layoutDir()
    try {
      const exec = writeNode(dir, 'node.exe')
      const cli = writeCli(join(dir, 'node_modules', 'npm', 'bin'))
      const resolved = resolveNpmCommandForExecPath(exec, 'win32')
      assert.deepStrictEqual(resolved, { command: exec, args: [cli] })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('resolves the Unix prefix layout: ../lib/node_modules/npm CLI via [node, cli]', () => {
    const dir = layoutDir()
    try {
      const bin = join(dir, 'bin')
      const exec = writeNode(bin)
      const cli = writeCli(join(dir, 'lib', 'node_modules', 'npm', 'bin'))
      const resolved = resolveNpmCommandForExecPath(exec, 'linux')
      assert.deepStrictEqual(resolved, { command: exec, args: [cli] })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('resolves an executable Unix npm sibling shim directly (no shell)', { skip: process.platform === 'win32' }, () => {
    const dir = layoutDir()
    try {
      const bin = join(dir, 'bin')
      const exec = writeNode(bin)
      const shim = join(bin, 'npm')
      writeFileSync(shim, '#!/bin/sh\nexec node npm-cli.js "$@"\n')
      chmodSync(shim, 0o755)
      const resolved = resolveNpmCommandForExecPath(exec, 'linux')
      assert.deepStrictEqual(resolved, { command: shim, args: [] })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('trusts an in-prefix symlink whose canonical target stays inside the prefix', { skip: process.platform === 'win32' }, () => {
    const dir = layoutDir()
    try {
      const bin = join(dir, 'bin')
      const exec = writeNode(bin)
      // Real CLI lives at a non-anchored path INSIDE the prefix; the anchored
      // sibling shim symlinks to it — the canonical target stays trusted.
      const cli = writeCli(join(dir, 'lib', 'node_modules', 'npm'), 'actual-cli.js')
      symlinkSync(cli, join(bin, 'npm'))
      const resolved = resolveNpmCommandForExecPath(exec, 'linux')
      assert.deepStrictEqual(resolved, { command: cli, args: [] })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('rejects a candidate whose symlink target escapes the canonical prefix', () => {
    const dir = layoutDir()
    try {
      const bin = join(dir, 'bin')
      const exec = writeNode(bin)
      const evil = layoutDir()
      const evilCli = writeCli(join(evil, 'node_modules', 'npm', 'bin'))
      // Anchored candidate at ../lib/node_modules/npm/bin/npm-cli.js → outside target.
      const anchored = join(dir, 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js')
      mkdirSync(dirname(anchored), { recursive: true })
      symlinkSync(evilCli, anchored)
      assert.throws(
        () => resolveNpmCommandForExecPath(exec, 'linux'),
        (err: unknown) => {
          assert.ok(err instanceof McpRemoteRuntimeError)
          assert.match((err as Error).message, /Could not locate a trusted npm/)
          assert.match((err as Error).message, /Install Node\.js with npm/)
          return true
        }
      )
      rmSync(evil, { recursive: true, force: true })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('rejects a lexical-prefix escape (prefix-evil is not inside prefix)', () => {
    const dir = layoutDir()
    try {
      const install = join(dir, 'node')
      const bin = join(install, 'bin')
      const exec = writeNode(bin)
      const evilCli = writeCli(join(`${install}-evil`, 'lib', 'node_modules', 'npm', 'bin'))
      const anchored = join(install, 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js')
      mkdirSync(dirname(anchored), { recursive: true })
      symlinkSync(evilCli, anchored) // target starts with <install>-evil, not <install>/
      assert.throws(() => resolveNpmCommandForExecPath(exec, 'linux'), McpRemoteRuntimeError)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('rejects a directory at the anchored CLI location', () => {
    const dir = layoutDir()
    try {
      const bin = join(dir, 'bin')
      const exec = writeNode(bin)
      mkdirSync(join(dir, 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'), { recursive: true })
      assert.throws(() => resolveNpmCommandForExecPath(exec, 'linux'), McpRemoteRuntimeError)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('rejects a non-executable sibling shim', () => {
    const dir = layoutDir()
    try {
      const bin = join(dir, 'bin')
      const exec = writeNode(bin)
      writeFileSync(join(bin, 'npm'), '#!/bin/sh\n') // no execute bit
      assert.throws(() => resolveNpmCommandForExecPath(exec, 'linux'), McpRemoteRuntimeError)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('fails closed when no anchored candidate exists', () => {
    const dir = layoutDir()
    try {
      const exec = writeNode(join(dir, 'bin'))
      assert.throws(
        () => resolveNpmCommandForExecPath(exec, 'linux'),
        (err: unknown) => {
          assert.match((err as Error).message, /Could not locate a trusted npm/)
          return true
        }
      )
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('never consults npm_execpath, PATH, or the project .bin (real resolution)', () => {
    const projectDir = mkdtempSync(join(tmpdir(), 'nsolid-evil-bin-'))
    const originalPath = process.env.PATH
    try {
      const evilBin = join(projectDir, 'node_modules', '.bin')
      mkdirSync(evilBin, { recursive: true })
      writeFileSync(join(evilBin, 'npm'), '#!/bin/sh\necho pwned\n')
      process.env.PATH = `${evilBin}${delimiter}${process.env.PATH}`

      // A fake npm-cli.js elsewhere plus npm_execpath pointing at it: the
      // basename and node_modules/npm segments must not make it trusted.
      const fakeCli = writeCli(join(projectDir, 'node_modules', 'npm', 'bin'))
      process.env.npm_execpath = fakeCli

      let resolved: { command: string; args: string[] } | undefined
      try {
        resolved = resolveNpmCommand()
      } catch (err) {
        assert.ok(err instanceof McpRemoteRuntimeError, 'unsupported layout fails with the actionable error')
        assert.match((err as Error).message, /Install Node\.js with npm/)
      }
      if (resolved !== undefined) {
        assert.ok(!resolved.command.includes(evilBin), 'must not resolve npm from project .bin')
        assert.ok(!resolved.command.includes('pwned'))
        assert.ok(!resolved.args.some((a) => a.includes(fakeCli) || a.includes(projectDir)), 'npm_execpath is never used')
        assert.ok(
          resolved.command === process.execPath || resolved.command.startsWith(dirname(process.execPath) + sep),
          `resolved npm must live next to node: ${resolved.command}`
        )
      }

      // A hostile relative npm_execpath is likewise ignored by construction.
      process.env.npm_execpath = 'relative/npm-cli.js'
      let relative: { command: string; args: string[] } | undefined
      try {
        relative = resolveNpmCommand()
      } catch {
        // Actionable error is fine on layouts without npm.
      }
      if (relative !== undefined) {
        assert.ok(!relative.args.some((a) => a === 'relative/npm-cli.js'))
      }
    } finally {
      process.env.PATH = originalPath
      rmSync(projectDir, { recursive: true, force: true })
    }
  })

  it('ignores a pnpm/yarn npm_execpath and falls back to the node-anchored resolution', () => {
    // Mirror real layouts: pnpm under a user prefix, yarn under ~/.yarn/releases.
    const pnpmCli = join(tmpHome, '.local', 'share', 'pnpm', 'lib', 'node_modules', 'pnpm', 'bin', 'pnpm.cjs')
    mkdirSync(dirname(pnpmCli), { recursive: true })
    writeFileSync(pnpmCli, '// pnpm cli\n')
    const yarnCli = join(tmpHome, '.yarn', 'releases', 'yarn-4.0.0.cjs')
    mkdirSync(dirname(yarnCli), { recursive: true })
    writeFileSync(yarnCli, '// yarn cli\n')

    // Baseline: what resolution looks like with no npm_execpath at all.
    delete process.env.npm_execpath
    let fallback: { command: string; args: string[] } | undefined
    try {
      fallback = resolveNpmCommand()
    } catch {
      fallback = undefined
    }

    for (const foreign of [pnpmCli, yarnCli]) {
      process.env.npm_execpath = foreign
      let resolved: { command: string; args: string[] }
      try {
        resolved = resolveNpmCommand()
      } catch (err) {
        // Layout without npm: the actionable error is correct; the point is
        // that the pnpm/yarn value was never executed.
        assert.ok(err instanceof McpRemoteRuntimeError)
        continue
      }
      assert.notStrictEqual(resolved.args[0], foreign, 'pnpm/yarn npm_execpath must not be used as npm')
      if (fallback !== undefined) {
        assert.deepStrictEqual(resolved, fallback, 'must fall back to the node-anchored resolution')
      }
      assert.ok(
        resolved.command === process.execPath || resolved.command.startsWith(dirname(process.execPath) + sep),
        `resolved npm must live next to node: ${resolved.command}`
      )
    }
  })

  it('ignores a missing npm_execpath', () => {
    process.env.npm_execpath = join(tmpHome, 'definitely-missing-npm.js')
    let resolved: { command: string; args: string[] } | undefined
    try {
      resolved = resolveNpmCommand()
    } catch {
      resolved = undefined
    }
    if (resolved !== undefined) {
      assert.notStrictEqual(resolved.args[0], process.env.npm_execpath)
    }
  })
})
