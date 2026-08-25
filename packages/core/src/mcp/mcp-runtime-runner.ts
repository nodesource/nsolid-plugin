import { spawn, type ChildProcess } from 'node:child_process'
import path from 'node:path'

/**
 * Managed npm execution for the MCP bridge runtime: spawn npm without a
 * shell, bound its lifetime, and on timeout terminate the whole managed
 * process tree — confirming it actually stopped before the caller is allowed
 * to clean up. Neither failure to spawn nor unconfirmed termination is ever
 * encoded as a fake exit status.
 */

/** Bounded tail of npm stderr kept for actionable error messages. */
const STDERR_TAIL_LIMIT = 4096

/** Unix: wait this long after SIGTERM before escalating the group to SIGKILL. */
const TERMINATION_GRACE_MS = 500

/** Bounded deadline to confirm the managed npm process tree actually stopped. */
const TERMINATION_CONFIRM_MS = 5 * 1000

/** Sentinel for a taskkill process that outlived the confirmation deadline. */
const KILLER_STUCK = Symbol('taskkill-stuck')

/**
 * Minimal surface of the spawned taskkill process that the termination logic
 * needs. Structural, so tests can inject a fake killer without spawning a
 * real system process.
 */
export interface KillerProcess {
  on (event: 'close', listener: (code: number | null) => void): unknown
  on (event: 'error', listener: (err: Error) => void): unknown
  kill (): boolean
}

/**
 * Test-injectable controls for `cancelManagedTree`: the platform branch, the
 * confirmation deadline, and the taskkill spawner can be overridden so the
 * Windows termination path is exercised deterministically (a genuinely stuck
 * system process is never spawned in tests).
 */
export interface TerminationControls {
  platform?: NodeJS.Platform
  confirmMs?: number
  spawnKiller?: (pid: number) => KillerProcess
}

/** Spawn the platform process-tree killer (isolated so tests can inject it). */
function spawnTaskkill (pid: number): ChildProcess {
  const systemRoot = process.env.SystemRoot ?? 'C:\\Windows'
  const taskkill = path.join(systemRoot, 'System32', 'taskkill.exe')
  return spawn(taskkill, ['/PID', String(pid), '/T', '/F'], {
    shell: false,
    windowsHide: true,
    stdio: 'ignore',
  })
}

/**
 * The single result shape used by the npm runner interface and its internal
 * completion helper. `spawnError` represents failure to create the process;
 * `terminationError` represents a timed-out process whose managed tree could
 * not be confirmed stopped. Neither failure is encoded as a fake exit status.
 */
export interface NpmRunnerRunResult {
  status: number | null
  stderr: string
  timedOut?: boolean
  /** Set when the npm process could not be spawned at all (ENOENT/EACCES/EPERM). */
  spawnError?: string
  /** Set when timeout cancellation could not confirm that the managed tree stopped. */
  terminationError?: string
}

export interface NpmRunner {
  /**
   * Runs npm without a shell. On timeout, terminates the managed npm process
   * tree and confirms that it stopped before cleanup is allowed. If that
   * confirmation fails, returns `terminationError` and the caller leaves
   * staging marked retained-live and excluded from publication/cleanup. Spawn
   * failures surface as `spawnError`, never as a fake exit status.
   * `onSpawned` is called immediately after the managed process spawns so the
   * caller can record the process identity in its ownership sidecar.
   */
  run(
    command: string,
    args: string[],
    options: {
      cwd: string
      timeoutMs: number
      /** Reports the managed process identity as soon as it exists. */
      onSpawned?: (identity: { pid: number }) => void
      /**
       * Test hook: overrides for the termination confirmation (e.g. a fake
       * taskkill), so the failure paths of timeout cancellation can be
       * exercised deterministically. Never set in production.
       */
      terminationControls?: TerminationControls
    }
  ): Promise<NpmRunnerRunResult>
}

export const defaultNpmRunner: NpmRunner = {
  async run (command, args, options) {
    const { cwd, timeoutMs } = options
    return await new Promise<NpmRunnerRunResult>((resolve) => {
      const isWindows = process.platform === 'win32'
      let stderr = ''
      let timedOut = false
      let settled = false
      // Unix: spawn npm as the leader of a detached process group so the
      // whole managed tree can be signalled; Windows relies on taskkill /T.
      const child = spawn(command, args, {
        cwd,
        shell: false,
        windowsHide: true,
        detached: !isWindows,
        stdio: ['ignore', 'ignore', 'pipe'],
      })
      // Report the managed process identity immediately after spawn so the
      // caller can record it in its ownership sidecar.
      if (child.pid !== undefined) {
        options.onSpawned?.({ pid: child.pid })
      }

      let termination: Promise<TerminationOutcome> | undefined
      const closed = new Promise<void>((resolve) => {
        child.on('close', () => resolve())
      })

      const finish = (result: NpmRunnerRunResult) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        resolve(result)
      }

      // On timeout the result is only complete once termination of the
      // managed tree has been confirmed (or definitively failed).
      const finishWithTermination = (outcome: Promise<TerminationOutcome>) => {
        outcome
          .then((result) => {
            if (result.confirmed) {
              finish({ status: null, stderr, timedOut: true })
            } else {
              finish({ status: null, stderr, timedOut: true, terminationError: result.error ?? 'unconfirmed' })
            }
          })
          .catch(() => {
            finish({ status: null, stderr, timedOut: true, terminationError: 'termination confirmation failed' })
          })
      }

      const timer = setTimeout(() => {
        timedOut = true
        termination = cancelManagedTree(child, closed, options.terminationControls)
        // The managed tree can survive cancellation, in which case the
        // child's close event never fires: settle the runner from here too,
        // so a failed (but bounded) termination can never hang the operation.
        finishWithTermination(termination)
      }, timeoutMs)

      child.stderr?.on('data', (chunk: Buffer) => {
        // Keep only a bounded tail; never capture or log the environment.
        stderr = bounded(stderr + chunk.toString('utf8'))
      })
      child.on('error', (err) => {
        // The process could not be created (ENOENT/EACCES/EPERM): surfaced as
        // an explicit spawnError, never as a fake exit status.
        finish({ status: null, stderr: bounded(`${stderr}\n${err.message}`), spawnError: err.message })
      })
      child.on('close', (code) => {
        if (!timedOut) {
          finish({ status: code ?? null, stderr })
          return
        }
        finishWithTermination(termination ?? Promise.resolve<TerminationOutcome>({ confirmed: true }))
      })
    })
  },
}

/**
 * Terminate the managed npm process tree and confirm it stopped.
 * - Unix: SIGTERM the detached process group, wait a bounded grace period,
 *   escalate to SIGKILL, await the root process close, then poll until the
 *   process group no longer exists.
 * - Windows: `taskkill /PID <pid> /T /F`, await it and the root close — both
 *   bounded by the confirmation deadline, so a stuck taskkill surfaces as a
 *   `terminationError` instead of waiting indefinitely.
 * Arbitrary descendants that deliberately detach from the managed group are
 * outside this portable guarantee (`--ignore-scripts` prevents package
 * lifecycle code from creating such escapees).
 * Exported (but not re-exported from the package barrel) so tests can drive
 * the termination branches deterministically via `controls`.
 */
export async function cancelManagedTree (
  child: { pid?: number },
  closed: Promise<void>,
  controls: TerminationControls = {}
): Promise<TerminationOutcome> {
  const platform = controls.platform ?? process.platform
  const confirmMs = controls.confirmMs ?? TERMINATION_CONFIRM_MS
  const deadline = Date.now() + confirmMs
  try {
    if (child.pid === undefined) return { confirmed: true }
    if (platform === 'win32') {
      const killer = (controls.spawnKiller ?? spawnTaskkill)(child.pid)
      const killerExit = new Promise<number | null>((resolve) => {
        killer.on('close', (code) => resolve(code))
        killer.on('error', () => resolve(null))
      })
      let stuckTimer: NodeJS.Timeout | undefined
      const killStatus = await Promise.race([
        killerExit,
        new Promise<typeof KILLER_STUCK>((resolve) => {
          stuckTimer = setTimeout(() => resolve(KILLER_STUCK), Math.max(0, deadline - Date.now()))
        }),
      ]).finally(() => clearTimeout(stuckTimer))
      if (killStatus === KILLER_STUCK) {
        // taskkill itself hung: best-effort stop the killer and report a
        // bounded termination failure rather than waiting indefinitely.
        try {
          killer.kill()
        } catch {
          // Killer already gone.
        }
        return { confirmed: false, error: 'taskkill did not exit within the termination confirmation deadline' }
      }
      const rootClosed = await waitFor(closed, deadline)
      if (killStatus === 0 && rootClosed) return { confirmed: true }
      return {
        confirmed: false,
        error: `taskkill exited with ${killStatus ?? 'error'}${rootClosed ? '' : '; npm process still running'}`,
      }
    }

    const groupId = -child.pid
    try {
      process.kill(groupId, 'SIGTERM')
    } catch {
      // Group already gone — fall through to the poll below.
    }
    await waitFor(closed, Date.now() + TERMINATION_GRACE_MS)
    try {
      process.kill(groupId, 'SIGKILL')
    } catch {
      // Already terminated.
    }
    if (!(await waitFor(closed, deadline))) {
      return { confirmed: false, error: 'npm process did not exit after SIGKILL' }
    }
    while (Date.now() < deadline) {
      try {
        process.kill(groupId, 0)
        await sleep(25) // group still exists (e.g. a grandchild) — keep polling
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ESRCH') return { confirmed: true }
        return { confirmed: false, error: `process group check failed (${(err as NodeJS.ErrnoException).code})` }
      }
    }
    return { confirmed: false, error: 'managed npm process group still exists after the confirmation deadline' }
  } catch (err) {
    return { confirmed: false, error: (err as Error).message }
  }
}

interface TerminationOutcome {
  confirmed: boolean
  error?: string
}

/** Bounded await: resolves false when the deadline passes first. */
async function waitFor (promise: Promise<void>, deadline: number): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined
  const expired = new Promise<false>((resolve) => {
    timer = setTimeout(() => resolve(false), Math.max(0, deadline - Date.now()))
  })
  // Clear the losing timer so a resolved race never keeps the event loop alive.
  return await Promise.race([promise.then(() => true), expired]).finally(() => clearTimeout(timer))
}

/** Small timed wait, shared with the publication-lock backoff. */
export function sleep (ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function bounded (text: string): string {
  return text.slice(-STDERR_TAIL_LIMIT)
}

/** Render a bounded npm stderr tail for install failure messages. */
export function formatTail (stderr: string): string {
  const tail = stderr.trim().split('\n').slice(-6).join('\n').trim().slice(-STDERR_TAIL_LIMIT)
  if (!tail) return ''
  return ` npm said:\n${tail}\n`
}
