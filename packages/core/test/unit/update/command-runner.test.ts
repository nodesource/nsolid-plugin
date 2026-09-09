import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createHmac, randomBytes } from 'node:crypto'
import { once } from 'node:events'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'

/**
 * Fixture-local control server for the escaped-grandchild test below. It is
 * deliberately NOT a general process-control framework. It exists so that one
 * fixture can:
 * - establish a private, nonce-authenticated loopback connection from the
 *   escaped grandchild BEFORE the intermediate exits (the grandchild writes
 *   its pid file only after its first authenticated response, and the
 *   intermediate exits only after seeing that file);
 * - prove, with a fresh challenge-response over the SAME connection after
 *   `runCommand` resolves, that the escaped process is still the original,
 *   live grandchild — application-level liveness evidence, not a bare
 *   `kill(pid, 0)` probe that can neither establish identity nor exclude a
 *   recycled PID;
 * - shut the grandchild down over that same channel without ever signaling an
 *   unverified or potentially recycled PID (the grandchild exits when its
 *   control socket closes; the child-side self-exit TTL is leak backup only).
 *
 * Protocol: the server sends a fresh random challenge; the peer answers with
 * HMAC-SHA256(nonce, challenge) and its own PID. Only the fixture-spawned
 * grandchild knows the nonce.
 */
interface EscapeControlFixture {
  /** Resolves with the loopback port once the server is listening. */
  readonly portReady: Promise<number>
  /** The nonce the fixture-spawned grandchild must answer challenges with. */
  readonly nonceHex: string
  /** Resolves with the authenticated peer's self-reported PID. */
  readonly ready: Promise<number>
  /** Fresh challenge-response over the SAME established connection. */
  challenge (): Promise<number>
  /** Bounded, idempotent teardown that is safe on every path. */
  shutdown (): Promise<void>
}

function createEscapeControlFixture (): EscapeControlFixture {
  const nonce = randomBytes(32)
  const server = net.createServer()
  // Every socket the server accepted. net.Server has no closeAllConnections
  // (that API belongs to http.Server), so teardown tracks and destroys the
  // server-owned sockets explicitly instead of waiting on remote peers.
  const ownedSockets = new Set<net.Socket>()
  let mode: 'accepting' | 'closing' = 'accepting'
  let control: net.Socket | undefined
  let expectedMac: string | undefined
  let handshakeTimer: NodeJS.Timeout | undefined
  let responseTimer: NodeJS.Timeout | undefined
  let readyTimer: NodeJS.Timeout | undefined
  let readySettled = false
  let readyResolve: ((pid: number) => void) | undefined
  let readyReject: ((error: Error) => void) | undefined
  let challengeResolve: ((pid: number) => void) | undefined
  let challengeReject: ((error: Error) => void) | undefined
  let shutdownPromise: Promise<void> | undefined

  const ready = new Promise<number>((resolve, reject) => {
    readyResolve = resolve
    readyReject = reject
  })
  // Every `ready` rejection is either awaited by the escape test or triggered
  // by teardown after the test already failed elsewhere (for example on
  // `portReady`); this handler keeps the latter case from becoming an
  // unhandled rejection while the awaiting caller still observes the error.
  ready.catch(() => { /* observed by the awaiting fixture or by shutdown */ })

  const portReady = new Promise<number>((resolve, reject) => {
    server.once('listening', () => {
      const address = server.address()
      if (address === null || typeof address === 'string') {
        reject(new Error('the escape fixture control server has no loopback port'))
        return
      }
      // Bounded wait for the grandchild's authenticated connection so a
      // fixture that never connects fails instead of hanging.
      readyTimer = setTimeout(() => {
        failReady(new Error('no grandchild authenticated with the escape fixture control server'))
      }, 10_000)
      resolve(address.port)
    })
    server.once('error', reject)
  })
  // Awaited by the escape test; teardown also settles `ready` on this path.
  portReady.catch(() => { /* observed by the awaiting fixture */ })

  const failReady = (error: Error) => {
    if (readySettled) return
    readySettled = true
    if (readyTimer !== undefined) {
      clearTimeout(readyTimer)
      readyTimer = undefined
    }
    readyReject?.(error)
  }

  const clearResponseTimer = () => {
    if (responseTimer !== undefined) {
      clearTimeout(responseTimer)
      responseTimer = undefined
    }
    expectedMac = undefined
  }

  const settleChallenge = (error: Error | undefined, pid?: number) => {
    clearResponseTimer()
    const resolve = challengeResolve
    const reject = challengeReject
    challengeResolve = undefined
    challengeReject = undefined
    if (resolve === undefined || reject === undefined) return
    if (error !== undefined) reject(error)
    else resolve(pid as number)
  }

  const destroySocket = (socket: net.Socket) => {
    ownedSockets.delete(socket)
    socket.removeAllListeners()
    socket.destroy()
  }

  const sendChallenge = (socket: net.Socket, timeoutMs: number) => {
    const challenge = randomBytes(16).toString('hex')
    expectedMac = createHmac('sha256', nonce).update(challenge).digest('hex')
    socket.write(challenge)
    responseTimer = setTimeout(() => {
      destroySocket(socket)
      settleChallenge(new Error('the authenticated peer stopped responding to challenges'))
    }, timeoutMs)
  }

  server.on('connection', (socket) => {
    ownedSockets.add(socket)
    // Closing mode handles late handshakes by shutting them down immediately.
    if (mode === 'closing') {
      destroySocket(socket)
      return
    }
    handshakeTimer = setTimeout(() => {
      destroySocket(socket)
      failReady(new Error('the connecting peer never completed the nonce handshake'))
    }, 5_000)
    socket.on('error', () => { /* 'close' follows and handles the failure */ })
    socket.on('close', () => {
      ownedSockets.delete(socket)
      if (mode === 'closing') return
      failReady(new Error('the peer disconnected before authenticating'))
      settleChallenge(new Error('the authenticated control connection closed unexpectedly'))
      const wasControl = control
      if (wasControl === socket) {
        control = undefined
      }
    })
    socket.on('data', (chunk: Buffer) => {
      const [mac, pidText] = chunk.toString('utf8').trim().split(':')
      if (expectedMac === undefined || mac !== expectedMac || !/^\d+$/.test(pidText ?? '')) {
        destroySocket(socket)
        failReady(new Error('the connected peer does not know the fixture nonce'))
        return
      }
      if (handshakeTimer !== undefined) {
        clearTimeout(handshakeTimer)
        handshakeTimer = undefined
      }
      clearResponseTimer()
      const pid = Number(pidText)
      if (!readySettled) {
        readySettled = true
        if (readyTimer !== undefined) {
          clearTimeout(readyTimer)
          readyTimer = undefined
        }
        // Exactly one authenticated peer owns the control channel.
        control = socket
        readyResolve?.(pid)
        return
      }
      settleChallenge(undefined, pid)
    })
    // The first challenge goes out immediately: the grandchild must answer
    // with the nonce-derived MAC before it is trusted at all.
    sendChallenge(socket, 5_000)
  })

  server.on('error', (error) => {
    failReady(error instanceof Error ? error : new Error(String(error)))
    settleChallenge(new Error('the escape fixture control server errored'))
  })

  server.listen(0, '127.0.0.1')

  return {
    portReady,
    nonceHex: nonce.toString('hex'),
    ready,
    challenge () {
      const peer = control
      if (mode === 'closing' || peer === undefined) {
        return Promise.reject(new Error('the escape fixture control connection is not available'))
      }
      return new Promise((resolve, reject) => {
        challengeResolve = resolve
        challengeReject = reject
        sendChallenge(peer, 2_000)
      })
    },
    shutdown () {
      if (shutdownPromise !== undefined) return shutdownPromise
      mode = 'closing'
      // Settle every pending promise immediately so teardown can neither hang
      // nor produce unhandled rejections, on any failure path.
      failReady(new Error('the escape fixture shut down before a peer authenticated'))
      settleChallenge(new Error('the escape fixture shut down before a response arrived'))
      if (handshakeTimer !== undefined) {
        clearTimeout(handshakeTimer)
        handshakeTimer = undefined
      }
      if (control !== undefined) {
        destroySocket(control)
        control = undefined
      }
      shutdownPromise = new Promise<void>((resolve) => {
        // Bounded: resolve even if the server's close callback stalls.
        const deadline = setTimeout(() => resolve(), 2_000)
        server.close(() => {
          clearTimeout(deadline)
          resolve()
        })
        // The server owns its sockets: destroy every one of them (late or
        // stray handshakes included) instead of waiting on remote peers.
        for (const socket of ownedSockets) destroySocket(socket)
      })
      return shutdownPromise
    },
  }
}
import { deriveShimEntrypoint, isCommandSuccessful, isTreeTerminationUnconfirmed, resolveExecutableIdentity, runCommand, terminationVerdict, windowsTaskkillPath } from '../../../src/update/command-runner.js'
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

  it('confirms descendant-tree termination before returning a timeout where the platform can prove it', async () => {
    const result = await runCommand({
      executable: process.execPath,
      args: ['-e', 'setInterval(() => {}, 10_000)'],
      timeoutMs: 50,
    })

    assert.equal(result.timedOut, true)
    if (process.platform === 'linux' || process.platform === 'win32') {
      // Linux proves whole-tree termination from pre-spawn /proc identity
      // snapshots; Windows reports taskkill's own /T success.
      assert.equal(result.treeTerminated, true)
    } else {
      // Without pre-spawn identity evidence (macOS) a detached, token-stripped,
      // reparented descendant is unattributable, so the verdict must refuse
      // confirmation even though the observable tree was terminated.
      assert.equal(result.treeTerminated, false)
      assert.equal(result.spawnErrorCode, 'TREE_TERMINATION_UNCONFIRMED')
    }
  })

  it('terminates a detached descendant on timeout; confirmation follows platform evidence', { skip: process.platform === 'win32' }, async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'nsolid-detached-descendant-'))
    const lateWrite = path.join(root, 'late-write.txt')
    const childCode = `const fs=require('node:fs');setTimeout(()=>fs.writeFileSync(${JSON.stringify(lateWrite)},'late'),400);setInterval(()=>{},10000)`
    const parentCode = `const {spawn}=require('node:child_process');spawn(process.execPath,['-e',${JSON.stringify(childCode)}],{detached:true,stdio:'ignore'}).unref();setInterval(()=>{},10000)`
    try {
      const result = await runCommand({ executable: process.execPath, args: ['-e', parentCode], timeoutMs: 100 })
      await new Promise((resolve) => setTimeout(resolve, 600))

      assert.equal(result.timedOut, true)
      if (process.platform === 'linux') {
        assert.equal(result.treeTerminated, true)
      } else {
        // Without pre-spawn identity evidence (macOS) the termination of the
        // observable tree cannot be proven whole; the verdict fails closed.
        assert.equal(result.treeTerminated, false)
        assert.equal(result.spawnErrorCode, 'TREE_TERMINATION_UNCONFIRMED')
      }
      // The descendant itself was still terminated: the late write it would
      // have performed must never appear, independent of the verdict.
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
    const exitMarker = path.join(root, 'escaped-exit.json')
    const intermediateExit = path.join(root, 'intermediate-exit.json')
    const timeoutMs = 2_000
    // Private, nonce-authenticated control channel for this fixture alone,
    // created before anything spawns (see the helper's contract).
    const fixture = createEscapeControlFixture()
    try {
      const controlPort = await fixture.portReady
      // The grandchild strips the tree token and stays alive on the control
      // connection. Its self-exit TTL is pure leak backup (the observation
      // window below is a fraction of it) and never part of the assertions:
      // it exits when the fixture closes the control socket.
      const grandchildCode = `const net=require('node:net'),crypto=require('node:crypto'),fs=require('node:fs');const socket=net.connect(${controlPort},'127.0.0.1');let announced=false;socket.on('data',(d)=>{const c=d.toString('utf8').trim();if(!c)return;const mac=crypto.createHmac('sha256',Buffer.from(${JSON.stringify(fixture.nonceHex)},'hex')).update(c).digest('hex');socket.write(mac+':'+process.pid);if(!announced){announced=true;fs.writeFileSync(${JSON.stringify(pidFile)},String(process.pid))}});const bail=(why)=>{try{fs.writeFileSync(${JSON.stringify(exitMarker)},JSON.stringify({pid:process.pid,why}))}catch{}process.exit(0)};socket.on('close',()=>bail('disconnected'));socket.on('error',()=>bail('error'));setTimeout(()=>bail('ttl'),30000)`
      // The intermediate waits for the grandchild's pid announcement — which
      // the grandchild only writes after its first authenticated control
      // response — and only then exits, so the control connection is
      // established before the intermediate exits and the grandchild is
      // reparented before the command can time out (proven below from the
      // recorded exit time). Its environment is rebuilt without
      // NSOLID_COMMAND_TREE_TOKEN, so nothing identifies the grandchild as
      // part of the command tree: it is invisible to the process group, PPID
      // ancestry, session, and token enumeration, termination cannot be
      // proven, and the runner must fail closed instead of claiming a
      // terminated tree.
      const intermediateCode = `const {spawn}=require('node:child_process');const fs=require('node:fs');const env={...process.env};delete env.NSOLID_COMMAND_TREE_TOKEN;const child=spawn(process.execPath,['-e',${JSON.stringify(grandchildCode)}],{detached:true,stdio:'ignore',env});child.unref();const bail=setTimeout(()=>process.exit(1),15000);const timer=setInterval(()=>{if(fs.existsSync(${JSON.stringify(pidFile)})){clearTimeout(bail);clearInterval(timer);process.exit(0)}},10)`
      const parentCode = `const {spawn}=require('node:child_process');const child=spawn(process.execPath,['-e',${JSON.stringify(intermediateCode)}],{detached:true,stdio:'ignore'});child.once('exit',(code,signal)=>require('node:fs').writeFileSync(${JSON.stringify(intermediateExit)},JSON.stringify({code,signal,at:Date.now()})));child.unref();setInterval(()=>{},10000)`
      try {
        const startedAt = Date.now()
        const result = await runCommand({ executable: process.execPath, args: ['-e', parentCode], timeoutMs })
        // The grandchild announced its pid only after its first authenticated
        // control response, so this resolves with the live peer's own
        // self-reported identity on the private connection.
        const authenticatedPid = await fixture.ready
        assert.equal(Number(readFileSync(pidFile, 'utf8')), authenticatedPid, 'the authenticated peer must be the process that announced the pid file')
        const intermediate = JSON.parse(readFileSync(intermediateExit, 'utf8')) as { code: number | null; signal: string | null; at: number }
        assert.equal(intermediate.code, 0)
        assert.equal(intermediate.signal, null)
        // Bounded startup evidence: the intermediate exited (and therefore
        // the authenticated control connection readied) before the runner's
        // timeout fired. There is no runCommand cancellation seam, so the
        // fixed timeout is not gated on readiness; on a pathologically slow
        // machine this assertion fails honestly instead of passing silently.
        assert.ok(intermediate.at < startedAt + timeoutMs, 'the intermediate must exit and reparent the grandchild before the timeout')
        // Fresh challenge-response over the SAME connection, before the
        // verdict assertions: proves the escaped process is still the
        // original live grandchild executing fixture protocol code, not
        // merely that some pid answers a probe.
        assert.equal(await fixture.challenge(), authenticatedPid)

        assert.equal(result.timedOut, true)
        assert.equal(result.treeTerminated, false)
        assert.equal(result.spawnErrorCode, 'TREE_TERMINATION_UNCONFIRMED')

        // Assertion-independent shutdown over the same channel: closing the
        // control socket makes the grandchild exit (EOF backup; the TTL is
        // leak backup only). No unverified or recycled PID is ever signaled.
        await fixture.shutdown()
        // Bounded closure evidence from the owned child itself: the exit
        // marker is written by the grandchild process when its control
        // socket closes, so the fixture never equates "socket closed" with
        // "OS process gone" without the child's own confirmation.
        const closureDeadline = Date.now() + 2_000
        while (!existsSync(exitMarker) && Date.now() < closureDeadline) {
          await new Promise((resolve) => setTimeout(resolve, 25))
        }
        assert.ok(existsSync(exitMarker), 'the escaped grandchild must exit when the fixture closes the control connection')
      } finally {
        // Teardown on every path: stops accepting, settles pending promises
        // immediately, destroys every server-owned socket, and closes the
        // server under a bounded deadline. Idempotent with the shutdown
        // above; on failure paths the same mechanism still runs even though
        // the exit-marker assertion is not re-evaluated there.
        await fixture.shutdown()
        rmSync(root, { recursive: true, force: true })
      }
    } finally {
      // Covers a `portReady` rejection (setup failure) before the inner try
      // exists; shutdown is idempotent.
      await fixture.shutdown()
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('escape fixture teardown rejects pending challenges and shuts down stray and late peers', async () => {
    const fixture = createEscapeControlFixture()
    const port = await fixture.portReady
    // A challenge before any authenticated peer exists must reject
    // immediately, never hang and never become an unhandled rejection.
    await assert.rejects(fixture.challenge(), /control connection is not available/)
    // A peer that connects but never completes the nonce handshake is a
    // server-owned socket that teardown must destroy, not leave to the
    // grandchild's TTL.
    const stray = net.connect(port, '127.0.0.1')
    // Teardown destroys the server-owned socket, so this peer sees a reset;
    // an unhandled 'error' event would crash the run instead of closing.
    stray.on('error', () => { /* expected: the fixture destroyed the connection */ })
    // The fixture sends a nonce challenge on every connection. Consuming it
    // drains the receive buffer so teardown's EOF reaches this socket — an
    // unread receive buffer defers the client-side 'close' event indefinitely.
    stray.on('data', () => { /* the fixture challenge; a stray never answers it */ })
    await once(stray, 'connect')
    // Attach the close observation BEFORE teardown: the socket can already be
    // closed by the time shutdown resolves, and a late-attached observer never
    // settles on an event that fired before it attached. The observer is
    // resolve-only on purpose: teardown's expected reset must not fail the
    // close-wait (an attached 'error' listener only prevents the unhandled
    // event; it does not stop once() from rejecting on 'error').
    const strayClosed = new Promise<void>((resolve) => { stray.once('close', () => resolve()) })
    await fixture.shutdown()
    await strayClosed
    // After teardown the server no longer accepts: late arrivals are
    // refused instead of being left half-open.
    const late = net.connect(port, '127.0.0.1')
    late.on('error', () => { /* expected: the server socket is closed */ })
    await assert.rejects(once(late, 'connect'), /ECONNREFUSED/)
    // Teardown is idempotent and bounded.
    await fixture.shutdown()
  })

  it('refuses to confirm timeout termination when pre-spawn identity evidence is absent', () => {
    // Deterministic regression for the macOS CI discrepancy (PR 56): without
    // a pre-spawn /proc identity snapshot, PPID/token enumeration cannot
    // attribute a detached, token-stripped, reparented descendant, so the
    // timeout verdict must refuse confirmation instead of defaulting to
    // success. A missing pid announcement in the macOS CI run also proved
    // execution, not survival; missing evidence is not proof of termination.
    assert.equal(terminationVerdict(undefined, undefined, 4242, undefined, undefined), false)
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
