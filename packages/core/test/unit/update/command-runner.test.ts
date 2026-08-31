import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { deriveShimEntrypoint, resolveExecutableIdentity, runCommand, windowsTaskkillPath } from '../../../src/update/command-runner.js'

describe('update command runner', () => {
  it('resolves taskkill from an absolute local System32 path', () => {
    assert.equal(windowsTaskkillPath('D:\\Windows'), 'D:\\Windows\\System32\\taskkill.exe')
    assert.equal(windowsTaskkillPath('\\\\attacker\\share'), 'C:\\Windows\\System32\\taskkill.exe')
    assert.equal(path.win32.isAbsolute(windowsTaskkillPath()), true)
  })

  it('preserves ENOENT as a structured missing-executable error', async () => {
    const result = await runCommand({
      executable: 'nsolid-plugin-command-that-does-not-exist',
      args: [],
      timeoutMs: 1_000,
    })

    assert.equal(result.exitCode, null)
    assert.equal(result.spawnErrorCode, 'ENOENT')
    assert.equal(result.treeTerminated, true)
  })

  it('confirms descendant-tree termination before returning a timeout', async () => {
    const result = await runCommand({
      executable: process.execPath,
      args: ['-e', 'setInterval(() => {}, 10_000)'],
      timeoutMs: 50,
    })

    assert.equal(result.timedOut, true)
    assert.equal(result.treeTerminated, true)
  })

  it('derives a verified npm Windows shim through mixed-case Path and PATHEXT', { skip: process.platform !== 'win32' }, () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'nsolid-plugin-shim-'))
    const entrypoint = path.join(root, 'node_modules', 'npm', 'bin', 'npm-cli.js')
    const shim = path.join(root, 'npm.CMD')
    mkdirSync(path.dirname(entrypoint), { recursive: true })
    writeFileSync(entrypoint, '#!/usr/bin/env node\n')
    writeFileSync(path.join(root, 'node_modules', 'npm', 'package.json'), JSON.stringify({ name: 'npm', bin: { npm: 'bin/npm-cli.js' } }))
    writeFileSync(shim, '@ECHO off\r\n"node" "%~dp0\\node_modules\\npm\\bin\\npm-cli.js" %*\r\n')

    assert.deepEqual(resolveExecutableIdentity('npm', { PaTh: root, pathext: '.PS1;.CMD' }), {
      kind: 'node',
      executable: process.execPath,
      entrypoint,
    })
  })

  it('rejects an unverified Windows command shim', { skip: process.platform !== 'win32' }, () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'nsolid-plugin-shim-'))
    writeFileSync(path.join(root, 'npm.cmd'), '@ECHO off\r\necho unsafe\r\n')

    assert.deepEqual(resolveExecutableIdentity('npm', { Path: root, PATHEXT: '.CMD' }), {
      kind: 'unsupported',
      reason: 'unverifiable-shim',
    })
  })

  it('derives the entrypoint only from the node invocation line', { skip: process.platform !== 'win32' }, () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'nsolid-plugin-shim-'))
    const realEntrypoint = path.join(root, 'node_modules', 'npm', 'bin', 'npm-cli.js')
    const decoyEntrypoint = path.join(root, 'node_modules', 'decoy', 'dummy.js')
    mkdirSync(path.dirname(realEntrypoint), { recursive: true })
    mkdirSync(path.dirname(decoyEntrypoint), { recursive: true })
    writeFileSync(realEntrypoint, '#!/usr/bin/env node\n')
    writeFileSync(decoyEntrypoint, 'throw new Error("must not execute")\n')
    writeFileSync(path.join(root, 'node_modules', 'npm', 'package.json'), JSON.stringify({ name: 'npm', bin: { npm: 'bin/npm-cli.js' } }))
    writeFileSync(path.join(root, 'npm.cmd'), [
      '@ECHO off',
      'echo node_modules\\decoy\\dummy.js',
      '"node" "%~dp0\\node_modules\\npm\\bin\\npm-cli.js" %*',
      '',
    ].join('\r\n'))

    const identity = resolveExecutableIdentity('npm', { Path: root, PATHEXT: '.CMD' })
    assert.equal(identity.kind, 'node')
    if (identity.kind === 'node') assert.equal(identity.entrypoint, realEntrypoint)
  })

  it('derives the exact modern cmd-shim invocation template to a verified node identity (cross-platform)', () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'nsolid-plugin-shim-'))
    const entrypoint = path.join(root, 'node_modules', 'npm', 'bin', 'npm-cli.js')
    const shim = path.join(root, 'npm.cmd')
    mkdirSync(path.dirname(entrypoint), { recursive: true })
    writeFileSync(entrypoint, '#!/usr/bin/env node\n')
    writeFileSync(path.join(root, 'node_modules', 'npm', 'package.json'), JSON.stringify({ name: 'npm', bin: { npm: 'bin/npm-cli.js' } }))
    writeFileSync(shim, [
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
      'endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\node_modules\\npm\\bin\\npm-cli.js" %*',
      '',
    ].join('\r\n'))
    try {
      assert.deepEqual(resolveExecutableIdentity('npm', { Path: root, PATHEXT: '.cmd' }, 'win32'), {
        kind: 'node',
        executable: process.execPath,
        entrypoint,
      })
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('rejects a modern shim whose entrypoint has no owning package manifest', () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'nsolid-plugin-shim-'))
    const evil = path.join(root, 'node_modules', 'evil', 'dummy.js')
    const shim = path.join(root, 'npm.cmd')
    mkdirSync(path.dirname(evil), { recursive: true })
    writeFileSync(evil, '#!/usr/bin/env node\n')
    writeFileSync(shim, 'endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\node_modules\\evil\\dummy.js" %*\r\n')
    try {
      assert.equal(deriveShimEntrypoint(shim, 'win32'), undefined)
      assert.deepEqual(resolveExecutableIdentity('npm', { Path: root, PATHEXT: '.cmd' }, 'win32'), {
        kind: 'unsupported',
        reason: 'unverifiable-shim',
      })
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('skips a decoy invocation line whose package does not own a matching bin', () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'nsolid-plugin-shim-'))
    const realEntrypoint = path.join(root, 'node_modules', 'npm', 'bin', 'npm-cli.js')
    const decoyEntrypoint = path.join(root, 'node_modules', 'evil', 'decoy.js')
    const shim = path.join(root, 'npm.cmd')
    mkdirSync(path.dirname(realEntrypoint), { recursive: true })
    mkdirSync(path.dirname(decoyEntrypoint), { recursive: true })
    writeFileSync(realEntrypoint, '#!/usr/bin/env node\n')
    writeFileSync(decoyEntrypoint, 'throw new Error("must not execute")\n')
    writeFileSync(path.join(root, 'node_modules', 'npm', 'package.json'), JSON.stringify({ name: 'npm', bin: { npm: 'bin/npm-cli.js' } }))
    writeFileSync(path.join(root, 'node_modules', 'evil', 'package.json'), JSON.stringify({ name: 'evil', bin: { evil: 'decoy.js' } }))
    writeFileSync(shim, [
      'endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\node_modules\\evil\\decoy.js" %*',
      '"node" "%~dp0\\node_modules\\npm\\bin\\npm-cli.js" %*',
      '',
    ].join('\r\n'))
    try {
      assert.equal(deriveShimEntrypoint(shim, 'win32'), realEntrypoint)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('derives a scoped package shim (bin object) declared by the owning package (cross-platform)', () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'nsolid-plugin-shim-'))
    const entrypoint = path.join(root, 'node_modules', '@anthropic-ai', 'claude-code', 'cli.js')
    const shim = path.join(root, 'claude.cmd')
    mkdirSync(path.dirname(entrypoint), { recursive: true })
    writeFileSync(entrypoint, '#!/usr/bin/env node\n')
    writeFileSync(path.join(root, 'node_modules', '@anthropic-ai', 'claude-code', 'package.json'), JSON.stringify({ name: '@anthropic-ai/claude-code', bin: { claude: './cli.js' } }))
    writeFileSync(shim, 'endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\node_modules\\@anthropic-ai\\claude-code\\cli.js" %*\r\n')
    try {
      assert.deepEqual(resolveExecutableIdentity('claude', { Path: root, PATHEXT: '.cmd' }, 'win32'), {
        kind: 'node',
        executable: process.execPath,
        entrypoint,
      })
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('derives a renamed non-scoped bin owned by a differently named package (cross-platform)', () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'nsolid-plugin-shim-'))
    const entrypoint = path.join(root, 'node_modules', 'foo', 'lib', 'bar.js')
    const shim = path.join(root, 'bar.cmd')
    mkdirSync(path.dirname(entrypoint), { recursive: true })
    writeFileSync(entrypoint, '#!/usr/bin/env node\n')
    writeFileSync(path.join(root, 'node_modules', 'foo', 'package.json'), JSON.stringify({ name: 'foo', bin: { bar: './lib/bar.js' } }))
    writeFileSync(shim, 'endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\node_modules\\foo\\lib\\bar.js" %*\r\n')
    try {
      assert.deepEqual(resolveExecutableIdentity('bar', { Path: root, PATHEXT: '.cmd' }, 'win32'), {
        kind: 'node',
        executable: process.execPath,
        entrypoint,
      })
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('derives a shim whose owning package declares bin as a string (cross-platform)', () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'nsolid-plugin-shim-'))
    const entrypoint = path.join(root, 'node_modules', 'my-tool', 'bin', 'my-tool.js')
    const shim = path.join(root, 'my-tool.cmd')
    mkdirSync(path.dirname(entrypoint), { recursive: true })
    writeFileSync(entrypoint, '#!/usr/bin/env node\n')
    writeFileSync(path.join(root, 'node_modules', 'my-tool', 'package.json'), JSON.stringify({ name: 'my-tool', bin: './bin/my-tool.js' }))
    writeFileSync(shim, 'endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\node_modules\\my-tool\\bin\\my-tool.js" %*\r\n')
    try {
      assert.deepEqual(resolveExecutableIdentity('my-tool', { Path: root, PATHEXT: '.cmd' }, 'win32'), {
        kind: 'node',
        executable: process.execPath,
        entrypoint,
      })
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('rejects a shim whose package bin value points to a different file (cross-platform)', () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'nsolid-plugin-shim-'))
    const entrypoint = path.join(root, 'node_modules', 'npm', 'bin', 'npm-cli.js')
    const shim = path.join(root, 'npm.cmd')
    mkdirSync(path.dirname(entrypoint), { recursive: true })
    writeFileSync(entrypoint, '#!/usr/bin/env node\n')
    writeFileSync(path.join(root, 'node_modules', 'npm', 'package.json'), JSON.stringify({ name: 'npm', bin: { npm: 'bin/other.js' } }))
    writeFileSync(shim, 'endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\node_modules\\npm\\bin\\npm-cli.js" %*\r\n')
    try {
      assert.equal(deriveShimEntrypoint(shim, 'win32'), undefined)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('rejects a shim whose owning package has no bin field (cross-platform)', () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'nsolid-plugin-shim-'))
    const entrypoint = path.join(root, 'node_modules', 'npm', 'bin', 'npm-cli.js')
    const shim = path.join(root, 'npm.cmd')
    mkdirSync(path.dirname(entrypoint), { recursive: true })
    writeFileSync(entrypoint, '#!/usr/bin/env node\n')
    writeFileSync(path.join(root, 'node_modules', 'npm', 'package.json'), JSON.stringify({ name: 'npm' }))
    writeFileSync(shim, 'endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\node_modules\\npm\\bin\\npm-cli.js" %*\r\n')
    try {
      assert.equal(deriveShimEntrypoint(shim, 'win32'), undefined)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('rejects a shim whose target traverses out of node_modules (cross-platform)', () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'nsolid-plugin-shim-'))
    const shim = path.join(root, 'npm.cmd')
    writeFileSync(shim, 'endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\node_modules\\..\\evil\\dummy.js" %*\r\n')
    try {
      assert.equal(deriveShimEntrypoint(shim, 'win32'), undefined)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('rejects a shim whose verified entrypoint does not exist (cross-platform)', () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'nsolid-plugin-shim-'))
    const shim = path.join(root, 'npm.cmd')
    mkdirSync(path.join(root, 'node_modules', 'npm'), { recursive: true })
    writeFileSync(path.join(root, 'node_modules', 'npm', 'package.json'), JSON.stringify({ name: 'npm', bin: { npm: 'bin/npm-cli.js' } }))
    // The bin is declared and matches, but the entrypoint file is absent.
    writeFileSync(shim, 'endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\node_modules\\npm\\bin\\npm-cli.js" %*\r\n')
    try {
      assert.equal(deriveShimEntrypoint(shim, 'win32'), undefined)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('reports identity drift when the planned native executable no longer exists', async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'nsolid-plugin-drift-'))
    const dead = path.join(root, 'planned-native.exe')
    writeFileSync(dead, '')
    rmSync(dead)
    try {
      const result = await runCommand({
        executable: process.execPath,
        executableIdentity: { kind: 'native', executable: dead },
        args: ['-e', 'process.exit(0)'],
        timeoutMs: 1_000,
      })
      assert.equal(result.spawnErrorCode, 'EXECUTABLE_IDENTITY_DRIFT')
      assert.equal(result.exitCode, null)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('reports identity drift when the planned node entrypoint does not match the command', async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'nsolid-plugin-drift-'))
    const alive = path.join(root, 'node_modules', 'npm', 'bin', 'npm-cli.js')
    mkdirSync(path.dirname(alive), { recursive: true })
    writeFileSync(alive, '#!/usr/bin/env node\n')
    try {
      const result = await runCommand({
        executable: process.execPath,
        executableIdentity: { kind: 'node', executable: process.execPath, entrypoint: path.join(root, 'planned-entry.js') },
        args: [alive],
        timeoutMs: 1_000,
      })
      assert.equal(result.spawnErrorCode, 'EXECUTABLE_IDENTITY_DRIFT')
      assert.equal(result.exitCode, null)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
