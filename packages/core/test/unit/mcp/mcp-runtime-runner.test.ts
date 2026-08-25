import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { tmpdir } from 'node:os'

import { cancelManagedTree, defaultNpmRunner } from '../../../src/mcp/mcp-runtime-runner.js'

/**
 * The Windows termination branch of the default npm runner is exercised
 * through injected behaviour: the fake taskkill process never touches the
 * real system, so a "stuck taskkill" is deterministic and instant.
 */

interface FakeKiller extends EventEmitter {
  kill: () => boolean
  killed: boolean
}

function fakeKiller (): FakeKiller {
  const killer = new EventEmitter() as FakeKiller
  killer.killed = false
  killer.kill = () => {
    killer.killed = true
    return true
  }
  return killer
}

/** A root-process close promise that never settles (surviving npm). */
function neverCloses (): Promise<void> {
  return new Promise<void>(() => {})
}

/** Best-effort kill of a real child spawned by the runner (test cleanup). */
function killTree (pid: number): void {
  if (process.platform === 'win32') {
    spawnSync('taskkill.exe', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' })
  } else {
    try {
      process.kill(-pid, 'SIGKILL') // runner spawns a detached group leader
    } catch {
      // Already gone.
    }
  }
}

describe('cancelManagedTree (Windows termination branch)', () => {
  it('returns a bounded terminationError when taskkill never exits', async () => {
    const killer = fakeKiller()
    const start = Date.now()
    const outcome = await cancelManagedTree({ pid: 1234 }, neverCloses(), {
      platform: 'win32',
      confirmMs: 50,
      spawnKiller: () => killer,
    })
    const elapsed = Date.now() - start

    assert.strictEqual(outcome.confirmed, false)
    assert.match(outcome.error ?? '', /taskkill did not exit within the termination confirmation deadline/)
    assert.ok(elapsed < 5_000, `termination must stay bounded by the deadline (took ${elapsed}ms)`)
    assert.strictEqual(killer.killed, true, 'the stuck killer process is stopped on the deadline')
  })

  it('confirms termination when taskkill exits 0 and the root process closes', async () => {
    const killer = fakeKiller()
    const outcomePromise = cancelManagedTree({ pid: 1234 }, Promise.resolve(), {
      platform: 'win32',
      confirmMs: 5_000,
      spawnKiller: () => killer,
    })
    killer.emit('close', 0)
    assert.deepStrictEqual(await outcomePromise, { confirmed: true })
  })

  it('reports the npm process still running when taskkill fails and the root survives', async () => {
    const killer = fakeKiller()
    const start = Date.now()
    const outcomePromise = cancelManagedTree({ pid: 1234 }, neverCloses(), {
      platform: 'win32',
      confirmMs: 50,
      spawnKiller: () => killer,
    })
    killer.emit('close', 1)
    const outcome = await outcomePromise
    const elapsed = Date.now() - start

    assert.strictEqual(outcome.confirmed, false)
    assert.match(outcome.error ?? '', /taskkill exited with 1/)
    assert.match(outcome.error ?? '', /npm process still running/)
    assert.ok(elapsed < 5_000, `termination must stay bounded by the deadline (took ${elapsed}ms)`)
  })
})

describe('defaultNpmRunner timeout settlement', () => {
  it('settles with terminationError when cancellation fails and the child never closes', async () => {
    // A real child that stays alive: cancellation is forced to fail through
    // the injected stuck taskkill, so the child's close event never fires.
    // The runner must settle from the timeout path instead of waiting for a
    // close that never comes.
    const killer = fakeKiller()
    let pid: number | undefined
    const start = Date.now()
    try {
      const result = await defaultNpmRunner.run(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
        cwd: tmpdir(),
        timeoutMs: 50,
        onSpawned: (identity) => { pid = identity.pid },
        terminationControls: { platform: 'win32', confirmMs: 50, spawnKiller: () => killer },
      })
      const elapsed = Date.now() - start

      assert.strictEqual(result.timedOut, true)
      assert.strictEqual(result.status, null)
      assert.match(result.terminationError ?? '', /taskkill did not exit within the termination confirmation deadline/)
      assert.ok(elapsed < 5_000, `the runner must settle within the termination deadline (took ${elapsed}ms)`)
      assert.strictEqual(killer.killed, true, 'the stuck killer process is stopped on the deadline')
    } finally {
      if (pid !== undefined) killTree(pid)
    }
  })
})
