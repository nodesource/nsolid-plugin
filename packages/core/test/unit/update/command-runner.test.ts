import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { deriveShimEntrypoint, isCommandSuccessful, isTreeTerminationUnconfirmed, resolveExecutableIdentity, runCommand, windowsTaskkillPath } from '../../../src/update/command-runner.js'
import type { CommandResult } from '../../../src/update/types.js'

describe('update command runner', () => {
  for (const [exitCode, stripToken] of [[0, false], [0, true], [1, false], [1, true]] as const) {
    it(`accounts for reparented descendants after early exit (code: ${exitCode}, strip token: ${stripToken})`, { skip: process.platform !== 'linux' }, async () => {
      const root = mkdtempSync(path.join(os.tmpdir(), 'nsolid-early-exit-'))
      const pidFile = path.join(root, 'descendant.pid')
      const trigger = path.join(root, 'write-now')
      const output = path.join(root, 'late.txt')
      const worker = `const fs=require('node:fs');fs.writeFileSync(${JSON.stringify(pidFile)},String(process.pid));setInterval(()=>{if(fs.existsSync(${JSON.stringify(trigger)}))fs.writeFileSync(${JSON.stringify(output)},'late')},10)`
      // The parent waits for the final descendant's readiness, then exits.
      // No timeout or fixed startup delay is needed to produce reparenting.
      const parent = `const fs=require('node:fs');const env={...process.env};${stripToken ? 'delete env.NSOLID_COMMAND_TREE_TOKEN;' : ''}require('node:child_process').spawn(process.execPath,['-e',${JSON.stringify(worker)}],{detached:true,stdio:'ignore',env}).unref();const timer=setInterval(()=>{if(fs.existsSync(${JSON.stringify(pidFile)})){clearInterval(timer);process.exit(${exitCode})}},10)`
      let pid: number | undefined
      try {
        const result = await runCommand({ executable: process.execPath, args: ['-e', parent], timeoutMs: 10_000 })
        pid = Number(readFileSync(pidFile, 'utf8'))
        assert.equal(result.timedOut, false)
        assert.equal(result.exitCode, exitCode)
        if (stripToken) {
          assert.equal(result.treeTerminated, false)
          assert.equal(result.spawnErrorCode, 'TREE_TERMINATION_UNCONFIRMED')
          assert.doesNotThrow(() => process.kill(pid!, 0), 'unattributed processes must not be killed')
        } else {
          assert.equal(result.treeTerminated, true)
          writeFileSync(trigger, 'go')
          await new Promise((resolve) => setTimeout(resolve, 100))
          assert.equal(existsSync(output), false, 'no descendant may write after termination was confirmed')
        }
      } finally {
        if (pid !== undefined) { try { process.kill(pid, 'SIGKILL') } catch { /* already gone */ } }
        rmSync(root, { recursive: true, force: true })
      }
    })
  }

  it('resolves taskkill from an absolute local System32 path', () => {
    assert.equal(windowsTaskkillPath('D:\\Windows'), 'D:\\Windows\\System32\\taskkill.exe')
    assert.equal(windowsTaskkillPath('\\\\attacker\\share'), 'C:\\Windows\\System32\\taskkill.exe')
    assert.equal(path.win32.isAbsolute(windowsTaskkillPath()), true)
  })

  it('requires explicit tree termination evidence at runtime', () => {
    for (const exitCode of [0, 1]) {
      // Deliberately bypass the required TypeScript field to model a legacy
      // injected runner returning an incomplete result at runtime.
      const result = { exitCode, stdout: '', stderr: '', timedOut: false } as unknown as CommandResult
      assert.equal(isTreeTerminationUnconfirmed(result), true, `exit ${exitCode} must remain unconfirmed`)
      assert.equal(isCommandSuccessful(result), false, `exit ${exitCode} must not authorize success`)
    }
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

  it('terminates a detached descendant before confirming a timeout', { skip: process.platform === 'win32' }, async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'nsolid-detached-descendant-'))
    const lateWrite = path.join(root, 'late-write.txt')
    const childCode = `const fs=require('node:fs');setTimeout(()=>fs.writeFileSync(${JSON.stringify(lateWrite)},'late'),400);setInterval(()=>{},10000)`
    const parentCode = `const {spawn}=require('node:child_process');spawn(process.execPath,['-e',${JSON.stringify(childCode)}],{detached:true,stdio:'ignore'}).unref();setInterval(()=>{},10000)`
    try {
      const result = await runCommand({ executable: process.execPath, args: ['-e', parentCode], timeoutMs: 100 })
      await new Promise((resolve) => setTimeout(resolve, 600))

      assert.equal(result.timedOut, true)
      assert.equal(result.treeTerminated, true)
      assert.equal(existsSync(lateWrite), false)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('terminates a detached descendant that was reparented before timeout', { skip: process.platform !== 'linux' }, async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'nsolid-reparented-descendant-'))
    const pidFile = path.join(root, 'descendant.pid')
    const intermediateExit = path.join(root, 'intermediate-exit.json')
    const lateWrite = path.join(root, 'late-write.txt')
    const timeoutMs = 1000
    const descendantCode = `const fs=require('node:fs');fs.writeFileSync(${JSON.stringify(pidFile)},String(process.pid));setTimeout(()=>fs.writeFileSync(${JSON.stringify(lateWrite)},'late'),2000);setInterval(()=>{},10000)`
    const intermediateCode = `const {spawn}=require('node:child_process');spawn(process.execPath,['-e',${JSON.stringify(descendantCode)}],{detached:true,stdio:'ignore'}).unref()`
    // Only the final descendant escapes the group. Detaching the short-lived
    // intermediate too introduces a separate /proc evidence-loss scenario
    // during its startup/exit; the token-stripped escape test covers refusal.
    const parentCode = `const {spawn}=require('node:child_process');const child=spawn(process.execPath,['-e',${JSON.stringify(intermediateCode)}],{stdio:'ignore'});child.once('exit',(code,signal)=>require('node:fs').writeFileSync(${JSON.stringify(intermediateExit)},JSON.stringify({code,signal,at:Date.now()})));child.unref();setInterval(()=>{},10000)`
    let descendantPid: number | undefined
    try {
      const startedAt = Date.now()
      const result = await runCommand({ executable: process.execPath, args: ['-e', parentCode], timeoutMs })
      await new Promise((resolve) => setTimeout(resolve, 700))
      descendantPid = existsSync(pidFile) ? Number(readFileSync(pidFile, 'utf8')) : undefined

      assert.ok(descendantPid !== undefined, 'the descendant must have started; a missing fixture cannot prove termination')
      const intermediate = JSON.parse(readFileSync(intermediateExit, 'utf8')) as { code: number | null; signal: string | null; at: number }
      assert.equal(intermediate.code, 0)
      assert.equal(intermediate.signal, null)
      assert.ok(intermediate.at < startedAt + timeoutMs, 'the intermediate must exit naturally and reparent its descendant before timeout')
      assert.equal(result.timedOut, true)
      assert.equal(result.treeTerminated, true)
      assert.equal(existsSync(lateWrite), false)
      const terminatedPid = descendantPid
      assert.throws(() => process.kill(terminatedPid, 0), 'the descendant must be gone, so it cannot write later')
    } finally {
      if (descendantPid !== undefined) {
        try { process.kill(descendantPid, 'SIGKILL') } catch { /* already terminated */ }
      }
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('refuses to confirm termination when a token-stripped detached grandchild survives', { skip: process.platform === 'win32' }, async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'nsolid-escaped-grandchild-'))
    const pidFile = path.join(root, 'escaped.pid')
    // The intermediate exits immediately after spawning, so by the time the
    // command times out the grandchild has been reparented to the nearest
    // ancestor subreaper: it is invisible to the process group, PPID ancestry,
    // session, and token enumeration. Its environment is rebuilt without
    // NSOLID_COMMAND_TREE_TOKEN, so nothing identifies it as part of the
    // command tree, termination cannot be proven, and the runner must fail
    // closed instead of claiming a terminated tree.
    const grandchildCode = `const fs=require('node:fs');fs.writeFileSync(${JSON.stringify(pidFile)},String(process.pid));setInterval(()=>{},10000)`
    const intermediateCode = `const {spawn}=require('node:child_process');const env={...process.env};delete env.NSOLID_COMMAND_TREE_TOKEN;spawn(process.execPath,['-e',${JSON.stringify(grandchildCode)}],{detached:true,stdio:'ignore',env}).unref()`
    const parentCode = `const {spawn}=require('node:child_process');spawn(process.execPath,['-e',${JSON.stringify(intermediateCode)}],{detached:true,stdio:'ignore'}).unref();setInterval(()=>{},10000)`
    let escapedPid: number | undefined
    try {
      const result = await runCommand({ executable: process.execPath, args: ['-e', parentCode], timeoutMs: 300 })
      // The grandchild is deliberately left alive. Read its pid (waiting out a
      // slow boot so cleanup cannot leak it) and prove the escape happened.
      const deadline = Date.now() + 1_500
      while (escapedPid === undefined && Date.now() < deadline) {
        escapedPid = existsSync(pidFile) ? Number(readFileSync(pidFile, 'utf8')) : undefined
        if (escapedPid === undefined) await new Promise((resolve) => setTimeout(resolve, 50))
      }
      assert.ok(escapedPid !== undefined, 'the escaped grandchild never announced its pid')
      const survivedPid = escapedPid

      assert.equal(result.timedOut, true)
      assert.equal(result.treeTerminated, false)
      assert.doesNotThrow(() => process.kill(survivedPid, 0))
    } finally {
      if (escapedPid !== undefined) {
        try { process.kill(escapedPid, 'SIGKILL') } catch { /* already gone */ }
      }
      rmSync(root, { recursive: true, force: true })
    }
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

  it('derives the entrypoint of a node_modules/.bin cmd shim (npm dependency layout, cross-platform)', () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'nsolid-plugin-shim-bin-'))
    const entrypoint = path.join(root, 'node_modules', 'pnpm', 'bin', 'pnpm.cjs')
    const shim = path.join(root, 'node_modules', '.bin', 'pnpm.cmd')
    mkdirSync(path.dirname(entrypoint), { recursive: true })
    mkdirSync(path.dirname(shim), { recursive: true })
    writeFileSync(entrypoint, '#!/usr/bin/env node\n')
    writeFileSync(path.join(root, 'node_modules', 'pnpm', 'package.json'), JSON.stringify({ name: 'pnpm', bin: { pnpm: 'bin/pnpm.cjs' } }))
    // npm's cmd-shim writes the target relative to the shim directory, which
    // for a node_modules/.bin shim is one `..` level up (this is the layout
    // pnpm/action-setup produces on Windows runners, where only pnpm.cmd —
    // no pnpm.exe — exists on PATH).
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
      'endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & set PATHEXT=%PATHEXT:;.JS;=;% & "%_prog%"  "%dp0%\\..\\pnpm\\bin\\pnpm.cjs" %*',
      '',
    ].join('\r\n'))
    try {
      assert.equal(deriveShimEntrypoint(shim, 'win32'), entrypoint)
      assert.deepEqual(resolveExecutableIdentity('pnpm', { Path: path.join(root, 'node_modules', '.bin'), PATHEXT: '.cmd' }, 'win32'), {
        kind: 'node',
        executable: process.execPath,
        entrypoint,
      })
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('rejects a .bin cmd shim whose target escapes the node_modules root', () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'nsolid-plugin-shim-bin-'))
    const evil = path.join(root, 'evil', 'dummy.js')
    const shim = path.join(root, 'node_modules', '.bin', 'pnpm.cmd')
    mkdirSync(path.dirname(evil), { recursive: true })
    mkdirSync(path.dirname(shim), { recursive: true })
    writeFileSync(evil, '#!/usr/bin/env node\n')
    writeFileSync(shim, 'endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\..\\..\\evil\\dummy.js" %*\r\n')
    try {
      assert.equal(deriveShimEntrypoint(shim, 'win32'), undefined)
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
