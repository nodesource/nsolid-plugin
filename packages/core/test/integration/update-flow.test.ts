import { afterEach, beforeEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { AddressInfo } from 'node:net'
import { checkUpdates, executeUpdatePlan, planUpdates, update } from '../../src/update/index.js'
import { resolveExecutableIdentity } from '../../src/update/command-runner.js'

let home: string
let project: string
let previousHome: string | undefined
let previousUserProfile: string | undefined
let previousCodexConfigPath: string | undefined
const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')

beforeEach(() => {
  home = mkdtempSync(path.join(os.tmpdir(), 'nsolid-plugin-update-home-'))
  project = mkdtempSync(path.join(os.tmpdir(), 'nsolid-plugin-update-project-'))
  previousHome = process.env.HOME
  previousUserProfile = process.env.USERPROFILE
  previousCodexConfigPath = process.env.CODEX_CONFIG_PATH
  process.env.HOME = home
  process.env.USERPROFILE = home
  delete process.env.CODEX_CONFIG_PATH
})

afterEach(() => {
  rmSync(home, { recursive: true, force: true })
  rmSync(project, { recursive: true, force: true })
  if (previousHome === undefined) delete process.env.HOME
  else process.env.HOME = previousHome
  if (previousUserProfile === undefined) delete process.env.USERPROFILE
  else process.env.USERPROFILE = previousUserProfile
  if (previousCodexConfigPath === undefined) delete process.env.CODEX_CONFIG_PATH
  else process.env.CODEX_CONFIG_PATH = previousCodexConfigPath
})

function registryFetch (version: string): typeof fetch {
  return async () => new Response(JSON.stringify({ 'dist-tags': { latest: version } }), { status: 200 })
}

/** A positively structured npm-global CLI installation with its own launcher. */
function cliGlobalFixture (version: string): { root: string; launcher: string } {
  const root = path.join(home, 'prefix', 'lib', 'node_modules', 'nsolid-plugin')
  mkdirSync(path.join(root, 'dist', 'src'), { recursive: true })
  writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'nsolid-plugin', version }))
  writeFileSync(path.join(root, 'bundle.json'), JSON.stringify({ name: 'nsolid-plugin', version }))
  const entrypoint = path.join(root, 'dist', 'src', 'cli.js')
  writeFileSync(entrypoint, '#!/usr/bin/env node\n')
  const launcher = path.join(home, 'prefix', 'bin', 'nsolid-plugin')
  mkdirSync(path.dirname(launcher), { recursive: true })
  symlinkSync(entrypoint, launcher)
  return { root, launcher }
}

describe('update flow coordinator', () => {
  it('checks a proven global CLI without probing a package manager', async () => {
    const { root, launcher } = cliGlobalFixture('90.0.0')
    let calls = 0
    const commandRunner = {
      run: async () => {
        calls++
        throw new Error('read-only check must not probe npm or pnpm')
      },
    }
    const summary = await checkUpdates({
      packageRoot: root,
      executablePath: launcher,
      cwd: project,
      fetchImpl: registryFetch('999.0.0'),
      commandRunner,
    })

    const cli = summary.results.find((result) => result.installationId === 'cli:global')
    assert.equal(cli?.status, 'update-available')
    assert.equal(cli?.ownership, 'global-package')
    assert.equal(cli?.currentVersion, '90.0.0')
    assert.equal(calls, 0)
  })

  it('does not probe a package manager for a global CLI newer than the registry during a check', async () => {
    const { root, launcher } = cliGlobalFixture('90.0.0')
    let calls = 0
    const commandRunner = {
      run: async () => {
        calls++
        throw new Error('newer-than-registry check must not probe npm or pnpm')
      },
    }
    const plan = await planUpdates({
      packageRoot: root,
      executablePath: launcher,
      cwd: project,
      check: true,
      fetchImpl: registryFetch('0.0.1'),
      commandRunner,
    })

    const cli = plan.items.find((item) => item.installationId === 'cli:global')
    assert.equal(cli?.source.kind, 'global-package')
    assert.equal(cli?.version.status, 'newer-than-registry')
    assert.equal(cli?.requiresConfirmation, false)
    assert.equal(calls, 0)
  })

  it('runs no package-manager command for a proven global CLI newer than the registry', async () => {
    const { root, launcher } = cliGlobalFixture('90.0.0')
    const commands: string[] = []
    const summary = await update({
      packageRoot: root,
      executablePath: launcher,
      cwd: project,
      yes: true,
      registry: 'https://registry.example',
      fetchImpl: registryFetch('0.0.1'),
      commandRunner: {
        run: async (spec: { executable: string; args: readonly string[] }) => {
          commands.push([spec.executable, ...spec.args].join(' '))
          return { exitCode: 1, stdout: '', stderr: '', timedOut: false }
        },
      },
    })

    const cli = summary.results.find((result) => result.installationId === 'cli:global')
    assert.equal(cli?.status, 'newer-than-registry')
    assert.equal(cli?.currentVersion, '90.0.0')
    assert.equal(cli?.latestVersion, '0.0.1')
    assert.equal(summary.exitCode, 0)
    assert.deepEqual(commands, [], 'a newer-than-registry no-op must not probe a package manager')
  })

  it('runs no package-manager command for a proven global CLI already current', async () => {
    const { root, launcher } = cliGlobalFixture('90.0.0')
    const commands: string[] = []
    const summary = await update({
      packageRoot: root,
      executablePath: launcher,
      cwd: project,
      yes: true,
      registry: 'https://registry.example',
      fetchImpl: registryFetch('90.0.0'),
      commandRunner: {
        run: async (spec: { executable: string; args: readonly string[] }) => {
          commands.push([spec.executable, ...spec.args].join(' '))
          return { exitCode: 1, stdout: '', stderr: '', timedOut: false }
        },
      },
    })

    const cli = summary.results.find((result) => result.installationId === 'cli:global')
    assert.equal(cli?.status, 'current')
    assert.equal(cli?.currentVersion, '90.0.0')
    assert.equal(cli?.latestVersion, '90.0.0')
    assert.equal(summary.exitCode, 0)
    assert.deepEqual(commands, [], 'a current no-op must not probe a package manager')
  })

  it('emits a non-mutating not-installed item for an absent requested harness', async () => {
    const calls: string[] = []
    const commandRunner = {
      run: async (spec: { executable: string }) => {
        calls.push(spec.executable)
        return { exitCode: 1, stdout: '', stderr: '', timedOut: false }
      },
    }
    const summary = await checkUpdates({
      harness: 'pi',
      cwd: project,
      fetchImpl: registryFetch('1.0.2'),
      commandRunner,
    })

    assert.equal(summary.checkOnly, true)
    assert.equal(summary.results[0]?.status, 'not-installed')
    assert.equal(summary.success, true)
    assert.ok(!calls.includes('pi'))
  })

  it('keeps update plans immutable and does not execute check plans', async () => {
    const commandRunner = {
      run: async () => {
        throw new Error('check mode must not execute')
      },
    }
    const plan = await planUpdates({
      harness: 'pi',
      cwd: project,
      check: true,
      fetchImpl: registryFetch('1.0.2'),
      commandRunner,
    })
    const summary = await executeUpdatePlan(plan, { check: true, commandRunner })
    assert.equal(summary.checkOnly, true)
    assert.equal(plan.items[0]?.steps.length, 0)
  })

  it('reports a workspace launch as unsupported from the compiled CLI', async (t) => {
    const distCli = path.join(packageRoot, 'dist', 'src', 'cli.js')
    // Release gates opt into requiring the built public seam; focused source
    // test runs may still skip it before the build step.
    if (!existsSync(distCli) && process.env.NSOLID_TEST_REQUIRE_BUILD === '1') assert.fail('compiled CLI is required but packages/core/dist/src/cli.js is missing')
    if (!existsSync(distCli)) return t.skip('compiled CLI is not built; run pnpm build first')

    const server = http.createServer((request, response) => {
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ 'dist-tags': { latest: '90.0.2' } }))
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const registry = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`
    try {
      const run = await new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve) => {
        const child = spawn(process.execPath, [distCli, 'update', '--check', '--json'], {
          cwd: path.resolve(packageRoot, '..', '..'),
          env: {
            ...process.env,
            HOME: home,
            USERPROFILE: home,
            npm_config_registry: registry,
            NPM_CONFIG_REGISTRY: registry,
          },
        })
        let stdout = ''
        let stderr = ''
        child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString() })
        child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString() })
        child.on('close', (code) => resolve({ code, stdout, stderr }))
      })

      assert.equal(run.code, 0, `expected exit 0, stderr: ${run.stderr}`)
      const summary = JSON.parse(run.stdout) as {
        exitCode: number
        results: Array<{ installationId: string; status: string; currentVersion?: string; latestVersion?: string; manualCommands?: string[] }>
      }
      const cli = summary.results.find((result) => result.installationId === 'cli:global')
      assert.ok(cli, 'the workspace launch must produce a cli result')
      assert.equal(cli.status, 'unsupported')
      assert.equal(cli.currentVersion, undefined)
      assert.equal(cli.latestVersion, '90.0.2')
      assert.deepEqual(cli.manualCommands, [
        'npm install --global nsolid-plugin@90.0.2',
        'pnpm add --global nsolid-plugin@90.0.2',
        'npx -y nsolid-plugin@90.0.2 <command>',
      ])
      assert.equal(summary.exitCode, 0)
    } finally {
      server.close()
    }
  })

  it('performs zero package-manager commands when a workspace launch mutates unsupported', async (t) => {
    const distCli = path.join(packageRoot, 'dist', 'src', 'cli.js')
    if (!existsSync(distCli) && process.env.NSOLID_TEST_REQUIRE_BUILD === '1') assert.fail('compiled CLI is required but packages/core/dist/src/cli.js is missing')
    if (!existsSync(distCli)) return t.skip('compiled CLI is not built; run pnpm build first')

    // Sentinels on PATH: any invocation of npm or pnpm writes to the log.
    // They must be identities production would actually EXECUTE, otherwise
    // the zero-invocation assertion below would be vacuous: POSIX sentinels
    // are executable scripts (resolveExecutableIdentity: native), Windows
    // sentinels are verified cmd-shims whose entrypoint appends to the log
    // (resolveExecutableIdentity: node).
    const sentinelDir = mkdtempSync(path.join(os.tmpdir(), 'nsolid-plugin-sentinel-'))
    const sentinelLog = path.join(sentinelDir, 'invoked.log')
    try {
      if (process.platform === 'win32') {
        const entrypointDir = path.join(sentinelDir, 'node_modules', 'nsolid-plugin', 'dist', 'src')
        mkdirSync(entrypointDir, { recursive: true })
        writeFileSync(path.join(entrypointDir, 'sentinel.js'), "require('fs').appendFileSync(process.env.NSOLID_SENTINEL_LOG, (process.argv.slice(2) || []).join(' ') + '\\n')\n")
        writeFileSync(path.join(sentinelDir, 'node_modules', 'nsolid-plugin', 'package.json'), JSON.stringify({ name: 'nsolid-plugin', bin: { npm: 'dist/src/sentinel.js', pnpm: 'dist/src/sentinel.js' } }))
        for (const name of ['npm', 'pnpm']) {
          writeFileSync(path.join(sentinelDir, `${name}.cmd`), [
            '@ECHO off',
            'GOTO start',
            ':find_dp0',
            'SET dp0=%~dp0',
            'EXIT /b',
            ':start',
            'SETLOCAL',
            'CALL :find_dp0',
            '',
            'IF EXIST "%dp0%\\node.exe" (',
            '  SET "_prog=%dp0%\\node.exe"',
            ') ELSE (',
            '  SET "_prog=node"',
            '  SET PATHEXT=%PATHEXT:;.JS;=;%',
            ')',
            '',
            'endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\node_modules\\nsolid-plugin\\dist\\src\\sentinel.js" %*',
            '',
          ].join('\r\n'))
        }
      } else {
        for (const name of ['npm', 'pnpm']) {
          writeFileSync(path.join(sentinelDir, name), '#!/bin/sh\necho "$@" >> "$NSOLID_SENTINEL_LOG"\n', { mode: 0o755 })
        }
      }

      // Self-check: each sentinel must be an identity production would invoke,
      // and must have the exact shape for this platform.
      for (const name of ['npm', 'pnpm']) {
        const identity = resolveExecutableIdentity(name, { ...process.env, PATH: `${sentinelDir}${path.delimiter}${process.env.PATH ?? ''}`, Path: sentinelDir, PATHEXT: '.CMD' }, process.platform)
        assert.equal(identity.kind, process.platform === 'win32' ? 'node' : 'native', `sentinel ${name} must be invocable as ${process.platform === 'win32' ? 'node' : 'native'}, got ${identity.kind}`)
      }

      const server = http.createServer((request, response) => {
        response.writeHead(200, { 'content-type': 'application/json' })
        response.end(JSON.stringify({ 'dist-tags': { latest: '90.0.2' } }))
      })
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
      const registry = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`
      try {
        const run = await new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve) => {
          const child = spawn(process.execPath, [distCli, 'update', '--yes', '--json'], {
            cwd: path.resolve(packageRoot, '..', '..'),
            env: {
              ...process.env,
              HOME: home,
              USERPROFILE: home,
              npm_config_registry: registry,
              NPM_CONFIG_REGISTRY: registry,
              NSOLID_SENTINEL_LOG: sentinelLog,
              PATHEXT: process.env.PATHEXT ?? '.CMD;.BAT;.EXE;.COM',
              PATH: `${sentinelDir}${path.delimiter}${process.env.PATH ?? ''}`,
            },
          })
          let stdout = ''
          let stderr = ''
          child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString() })
          child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString() })
          child.on('close', (code) => resolve({ code, stdout, stderr }))
        })

        assert.equal(run.code, 2, `expected exit 2 for an unsupported mutation, stderr: ${run.stderr}`)
        const summary = JSON.parse(run.stdout) as {
          exitCode: number
          results: Array<{ installationId: string; status: string; currentVersion?: string; latestVersion?: string; manualCommands?: string[] }>
        }
        const cli = summary.results.find((result) => result.installationId === 'cli:global')
        assert.ok(cli, 'the workspace launch must produce a cli result')
        assert.equal(cli.status, 'unsupported')
        assert.equal(cli.currentVersion, undefined)
        assert.equal(cli.latestVersion, '90.0.2')
        assert.deepEqual(cli.manualCommands, [
          'npm install --global nsolid-plugin@90.0.2',
          'pnpm add --global nsolid-plugin@90.0.2',
          'npx -y nsolid-plugin@90.0.2 <command>',
        ])
        assert.equal(summary.exitCode, 2)
        assert.equal(existsSync(sentinelLog), false, 'no npm/pnpm command may be invoked for an unsupported mutation')
      } finally {
        server.close()
      }
    } finally {
      rmSync(sentinelDir, { recursive: true, force: true })
    }
  })
})
