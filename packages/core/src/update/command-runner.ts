import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { accessSync, constants, existsSync, readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'
import type { CommandResult, CommandRunner, CommandSpec, ResolvedExecutable } from './types.js'
import { redactSecrets } from './redaction.js'

export const DEFAULT_COMMAND_TIMEOUT_MS = 120_000
export const MAX_COMMAND_OUTPUT = 64 * 1024
const COMMAND_TREE_TOKEN_ENV = 'NSOLID_COMMAND_TREE_TOKEN'

export function sanitizeOutput (value: string): string {
  return redactSecrets(value).slice(0, MAX_COMMAND_OUTPUT)
}

export function createCommandRunner (): CommandRunner {
  return { run: runCommand }
}

/**
 * Resolves the effective spawn command for an executable step:
 * - a validated absolute native executable (`.exe`/`.com` on Windows or an
 *   executable bit on POSIX) is spawned directly with `shell: false`;
 * - a Windows `.cmd`/`.bat` shim produced by npm is NOT spawned through a
 *   reconstructed command line (that reintroduces cmd.exe interpretation).
 *   Instead its immutable JS entrypoint is derived and run with
 *   `process.execPath` under `shell: false`;
 * - an unverifiable `.cmd`/`.bat` shim, a `.ps1`-only launcher, or a bare
 *   name that cannot be resolved to an absolute path resolves to
 *   `unsupported`; `shell: true` / `cmd.exe` are never used.
 */
export async function runCommand (spec: CommandSpec): Promise<CommandResult> {
  const timeoutMs = Number.isFinite(spec.timeoutMs) && spec.timeoutMs > 0
    ? spec.timeoutMs
    : DEFAULT_COMMAND_TIMEOUT_MS

  // Plans must freeze an absolute executable identity. PATH lookup belongs to
  // planning/detection; execution never re-resolves a bare name against a
  // potentially changed environment.
  if (!path.isAbsolute(spec.executable)) {
    return {
      exitCode: null,
      spawnErrorCode: 'ENOENT',
      stdout: '',
      stderr: 'executable not found',
      timedOut: false,
      treeTerminated: true,
    }
  }

  const env = mergeCommandEnvironment(spec.env)
  // Resolve the identity once; it is the single authoritative spawn target.
  const identity = resolveExecutableIdentity(spec.executable, env)
  if (identity.kind === 'unsupported') {
    return {
      exitCode: null,
      spawnErrorCode: identity.reason === 'not-found' ? 'ENOENT' : 'UNSAFE_LAUNCHER',
      stdout: '',
      stderr: identity.reason === 'not-found' ? 'executable not found' : `${spec.executable} launcher cannot be executed safely`,
      timedOut: false,
      treeTerminated: true,
    }
  }

  // Revalidate the freshly resolved identity against the planned evidence
  // immediately before spawn: a previously resolved shim/entrypoint may have
  // been replaced or removed between planning and execution.
  if (!revalidatePlannedIdentity(spec, identity)) {
    return {
      exitCode: null,
      spawnErrorCode: 'EXECUTABLE_IDENTITY_DRIFT',
      stdout: '',
      stderr: 'planned executable identity changed before execution',
      timedOut: false,
      treeTerminated: true,
    }
  }

  const spawnArgs = identity.kind === 'node'
    ? [identity.entrypoint, ...spec.args]
    : [...spec.args]
  const executable = identity.kind === 'node' ? process.execPath : identity.executable
  // A detached grandchild can be reparented before timeout handling begins,
  // at which point PPID-only discovery can no longer connect it to the command.
  // Give every POSIX command a unique inherited lineage marker so termination
  // can still enumerate descendants after reparenting.
  const treeToken = process.platform === 'win32' ? undefined : randomUUID()
  const spawnEnv = treeToken ? { ...env, [COMMAND_TREE_TOKEN_ENV]: treeToken } : env

  return await new Promise((resolve) => {
    let stdout = ''
    let stderr = ''
    let timedOut = false
    let treeTerminated = true
    let settled = false
    let timeoutTermination: Promise<boolean> | undefined

    const child = spawn(executable, spawnArgs, {
      cwd: spec.cwd,
      env: spawnEnv,
      shell: false,
      detached: process.platform !== 'win32',
      stdio: ['ignore', 'pipe', 'pipe'],
    })

    const append = (target: 'stdout' | 'stderr', chunk: Buffer | string) => {
      const text = typeof chunk === 'string' ? chunk : chunk.toString('utf8')
      if (target === 'stdout') stdout += text
      else stderr += text
      if (stdout.length > MAX_COMMAND_OUTPUT) stdout = stdout.slice(0, MAX_COMMAND_OUTPUT)
      if (stderr.length > MAX_COMMAND_OUTPUT) stderr = stderr.slice(0, MAX_COMMAND_OUTPUT)
    }

    child.stdout?.on('data', (chunk: Buffer | string) => append('stdout', chunk))
    child.stderr?.on('data', (chunk: Buffer | string) => append('stderr', chunk))

    const timer = setTimeout(() => {
      timedOut = true
      treeTerminated = false
      // Terminate the whole descendant tree, then confirm termination before
      // any caller proceeds to rollback.
      const pid = child.pid
      if (pid !== undefined) {
        timeoutTermination = terminateTree(pid, treeToken)
        timeoutTermination.then((terminated) => {
          treeTerminated = terminated
          finish(null, undefined, terminated ? undefined : 'TREE_TERMINATION_UNCONFIRMED')
        }).catch(() => finish(null, undefined, 'TREE_TERMINATION_UNCONFIRMED'))
      } else {
        child.kill('SIGTERM')
        finish(null, undefined, 'TREE_TERMINATION_UNCONFIRMED')
      }
    }, timeoutMs)

    function finish (exitCode: number | null, signal?: NodeJS.Signals, spawnErrorCode?: string, errorText?: string) {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (spawnErrorCode === 'ENOENT') stderr += 'executable not found'
      if (errorText) stderr += errorText
      resolve({
        exitCode,
        signal,
        spawnErrorCode,
        stdout: sanitizeOutput(stdout),
        stderr: sanitizeOutput(stderr),
        timedOut,
        treeTerminated,
      })
    }

    child.once('error', (error: NodeJS.ErrnoException) => {
      finish(null, undefined, error.code)
    })
    child.once('exit', (code, signal) => {
      if (timedOut && timeoutTermination) return
      finish(code, signal ?? undefined)
    })
  })
}

export function isCommandSuccessful (result: CommandResult): boolean {
  return !result.timedOut && result.exitCode === 0
}

/**
 * Resolves an executable/entrypoint name to an absolute, identity-verified
 * spawn target. Never trusts a bare name, a cwd-relative path, an empty path
 * segment, an unvalidated `.cmd`/`.bat` shim, or a `.ps1`-only launcher.
 */
export function resolveExecutableIdentity (executable: string, env: Readonly<Record<string, string | undefined>> = process.env, platform: NodeJS.Platform = process.platform): ResolvedExecutable {
  const isWindows = platform === 'win32'

  if (!executable) return { kind: 'unsupported', reason: 'not-found' }

  const resolved = findExecutable(executable, env, platform)
  if (!resolved) return { kind: 'unsupported', reason: 'not-found' }

  // On a POSIX host forced to win32 semantics (the parser's cross-platform
  // tests), the win32 resolver returns backslash-separated paths that must be
  // mapped to native separators before touching the real filesystem. On the
  // host Windows platform this is a no-op.
  const resolvedPath = platform === 'win32' && process.platform !== 'win32'
    ? resolved.split('\\').join(path.sep)
    : resolved

  if (isWindows) {
    const ext = path.posix.extname(resolvedPath).toLowerCase() || path.win32.extname(resolvedPath).toLowerCase()
    if (ext === '.exe' || ext === '.com') return { kind: 'native', executable: resolvedPath }
    if (ext === '.ps1') return { kind: 'unsupported', reason: 'powershell-only' }
    if (ext === '.cmd' || ext === '.bat') {
      const entrypoint = deriveShimEntrypoint(resolvedPath, platform)
      if (!entrypoint) return { kind: 'unsupported', reason: 'unverifiable-shim' }
      return { kind: 'node', executable: process.execPath, entrypoint }
    }
    // Extensionless or unknown extension: only trust it as a native target if
    // it is a real file; otherwise refuse rather than guessing a shim.
    if (existsSync(resolvedPath)) return { kind: 'native', executable: resolvedPath }
    return { kind: 'unsupported', reason: 'not-found' }
  }

  return { kind: 'native', executable: resolvedPath }
}

/**
 * Locate an executable by name. On Windows the lookup is case-insensitive over
 * `PATH`/`Path` and honours `PATHEXT` (preferring `.exe`/`.com` over
 * `.cmd`/`.bat` shims); empty and cwd-relative path segments are ignored. On
 * POSIX the returned path is checked for the executable bit. A name containing
 * a path separator is returned only if it passes the same checks, so a caller
 * can never launch an arbitrary relative path via PATH lookup.
 */
export function findExecutable (
  executable: string,
  env: Readonly<Record<string, string | undefined>> = process.env,
  platform: NodeJS.Platform = process.platform
): string | undefined {
  if (!executable) return undefined

  const isWindows = platform === 'win32'
  const pathApi = isWindows ? path.win32 : path.posix
  const pathValue = environmentValue(env, 'PATH') ?? ''
  const candidates = pathValue.split(pathApi.delimiter).filter((segment) => pathApi.isAbsolute(segment))
  const requestedExtension = pathApi.extname(executable)
  const extensions = isWindows && !requestedExtension
    ? preferredWindowsExtensions(environmentValue(env, 'PATHEXT') ?? '.EXE;.COM;.CMD;.BAT')
    : ['']

  if (!/[\\/]/.test(executable)) {
    for (const directory of candidates) {
      for (const extension of extensions) {
        const candidate = pathApi.join(directory, executable + extension)
        if (isExecutable(candidate, platform)) return pathApi.resolve(candidate)
      }
    }
  }

  // A name carrying a path separator was not found in PATH. Accept a direct
  // absolute path only after strict identity checks (Windows extensions and
  // verify it is a file; POSIX requires the executable bit).
  if (/[\\/]/.test(executable)) {
    if (!pathApi.isAbsolute(executable)) return undefined
    if (isWindows) {
      const directExtensions = requestedExtension ? [''] : ['.exe', '.com', '.cmd', '.bat', '.ps1', '']
      for (const extension of directExtensions) {
        const candidate = executable.toLowerCase().endsWith(extension) ? executable : executable + extension
        if (isExecutable(candidate, platform)) {
          if (extension === '' && !/\.(exe|com|cmd|bat|ps1)$/i.test(candidate)) {
            // Extensionless-with-separator-path: only trust real files.
            return existsSync(candidate) ? pathApi.resolve(candidate) : undefined
          }
          return pathApi.resolve(candidate)
        }
      }
      return undefined
    }
    return isExecutable(executable, platform) ? pathApi.resolve(executable) : undefined
  }

  return undefined
}

const SHIM_INVOCATION_RE = /(?:^|[&;])\s*@?(?:"(?:%_prog%|%dp0%\\node\.exe|node(?:\.exe)?)"|node(?:\.exe)?)\s+/i
const SHIM_ENTRYPOINT_RE = /node_modules[\\/]([^"\r\n']+?\.(?:js|cjs))/i

/**
 * Parse an npm-generated Windows `.cmd`/`.bat` shim and return the absolute
 * path of the immutable JS entrypoint it invokes
 * (`...\node_modules\<pkg>\bin\*.js|cjs`). Returns undefined when the shim
 * cannot be verified as an npm shim, so the launcher is treated as unsafe
 * rather than executed through cmd.exe.
 *
 * The invocation line is recognised by a quoted program token (`"%_prog%"`,
 * `"%dp0%\node.exe"`, `"node"`/`"node.exe"`, or a legacy bare `node`) near the
 * line start or after a `&`/`;`, together with a `%*` suffix. This covers the
 * modern cmd-shim template, which emits the program token mid-line
 * (`... || title %COMSPEC% & "%_prog%"  "%dp0%\node_modules\npm\bin\npm-cli.js" %*`),
 * as well as the legacy `@node "%~dp0\..." %*` forms.
 *
 * Ownership is proven from the package manifest, not from a directory-name
 * match: the package that contains the entrypoint must declare a `bin` whose
 * name equals the shim basename without extension and whose value points to
 * the captured entrypoint within the package. When several lines have
 * invocation form, the first one whose ownership verifies wins; earlier decoy
 * lines pointing elsewhere are skipped, and if none verifies the shim is
 * unverifiable (fail-closed). Traversal (`..`) and existence of the entrypoint
 * are still enforced.
 *
 * `platform` only influences path resolution and case sensitivity so the
 * parser can run for `win32` semantics on a POSIX host during tests; it
 * defaults to the host platform.
 */
export function deriveShimEntrypoint (shimPath: string, platform: NodeJS.Platform = process.platform): string | undefined {
  let content: string
  try {
    content = readFileSync(shimPath, 'utf8')
  } catch {
    return undefined
  }
  const isWindows = platform === 'win32'
  const shimName = path.win32.basename(shimPath, path.win32.extname(shimPath))
  const namesEqual = (left: string, right: string): boolean =>
    isWindows ? left.toLowerCase() === right.toLowerCase() : left === right
  const invocationLines = content.split(/\r?\n/).filter((line) => SHIM_INVOCATION_RE.test(line) && /%\*/.test(line))
  for (const invocation of invocationLines) {
    if (!/node_modules[\\/]/.test(invocation) || !/\.(?:js|cjs)["\s]/i.test(invocation)) continue
    // Match a `node_modules\<...>...\*.js|cjs` target (npm's cmd-shim emits the
    // entrypoint relative to the shim directory via %dp0%). Since every
    // character inside the entrypoint path is constrained to a Windows path we
    // strip quotes and whitespace around it.
    const match = SHIM_ENTRYPOINT_RE.exec(invocation)
    if (!match) continue
    const relative = match[1]
    if (relative.length === 0 || /\.\./.test(relative)) continue
    const packageEntry = verifyPackageBinOwnership(shimPath, shimName, relative, namesEqual, isWindows)
    if (!packageEntry) continue
    const entrypoint = path.win32
      .resolve(path.win32.dirname(shimPath), 'node_modules', relative)
      .split('\\')
      .join(path.sep)
    if (!existsSync(entrypoint)) continue
    return entrypoint
  }
  return undefined
}

/**
 * Prove that the package containing `relative` (a path under
 * `node_modules\...` captured from a shim invocation line) declares a `bin`
 * named after the shim and pointing at that exact entrypoint. Returns the bin
 * entry name on success, undefined on any failure (fail-closed).
 */
function verifyPackageBinOwnership (
  shimPath: string,
  shimName: string,
  relative: string,
  namesEqual: (left: string, right: string) => boolean,
  isWindows: boolean
): string | undefined {
  const segments = relative.split(/[\\/]+/)
  if (segments.length === 0 || segments[0].length === 0) return undefined
  // The package directory is one segment, or two for a scoped package.
  const packageSegments = segments[0].startsWith('@') ? 2 : 1
  if (segments.length <= packageSegments) return undefined
  const packageDir = segments.slice(0, packageSegments).join('\\')
  const inPackageRelative = segments.slice(packageSegments).join('\\')

  const manifestPath = path.win32
    .resolve(path.win32.dirname(shimPath), 'node_modules', packageDir, 'package.json')
    .split('\\')
    .join(path.sep)
  let manifest: unknown
  try {
    manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  } catch {
    return undefined
  }
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) return undefined
  const record = manifest as Record<string, unknown>
  const bin = record.bin

  // A `bin` object: some key must equal the shim name.
  if (bin && typeof bin === 'object' && !Array.isArray(bin)) {
    const binObject = bin as Record<string, unknown>
    const matchingKey = Object.keys(binObject).find((key) => namesEqual(key, shimName))
    if (matchingKey === undefined) return undefined
    const value = binObject[matchingKey]
    return typeof value === 'string' && binValueMatches(value, inPackageRelative, namesEqual) ? matchingKey : undefined
  }
  // A `bin` string: the bin name is the package name (last segment when scoped).
  if (typeof bin === 'string') {
    const packageName = typeof record.name === 'string' ? record.name : ''
    const binName = packageName.includes('/') ? packageName.split('/').at(-1) ?? '' : packageName
    if (!namesEqual(binName, shimName)) return undefined
    return binValueMatches(bin, inPackageRelative, namesEqual) ? shimName : undefined
  }
  return undefined
}

/** Compare a `bin` value against the in-package entrypoint path, normalising
 * separators and a leading `./`, case-sensitively on POSIX. */
function binValueMatches (binValue: string, inPackageRelative: string, namesEqual: (left: string, right: string) => boolean): boolean {
  const normalize = (value: string): string => value.replace(/\\/g, '/').replace(/^\.\//, '')
  return namesEqual(normalize(binValue), normalize(inPackageRelative))
}

/**
 * Terminate a process and its entire descendant tree, returning whether
 * termination was issued (and can be assumed) rather than silent/reconstructed
 * single-process kill. On Windows uses `taskkill`'s `/T` to include children;
 * on POSIX signals the process group. Callers must only proceed to rollback
 * after this reports the tree was terminated.
 */
async function terminateTree (pid: number, treeToken?: string): Promise<boolean> {
  if (process.platform === 'win32') {
    // `taskkill /T` includes descendants. Do not report success until taskkill
    // itself exits successfully and the original pid is no longer observable.
    const exitCode = await new Promise<number | null>((resolve) => {
      const killer = spawn(windowsTaskkillPath(process.env.SystemRoot), ['/pid', String(pid), '/T', '/F'], {
        shell: false,
        windowsHide: true,
        stdio: 'ignore',
      })
      let settled = false
      const finish = (code: number | null) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        resolve(code)
      }
      const timer = setTimeout(() => {
        killer.kill()
        finish(null)
      }, 5_000)
      killer.once('error', () => finish(null))
      killer.once('exit', (code) => finish(code))
    })
    return exitCode === 0 && await waitForProcessExit(pid)
  }
  // Capture the ancestry before signaling: a descendant may have called
  // setsid() and escaped the original process group while retaining its PPID.
  const tracked = await collectPosixProcessTree(pid)
  const marked = treeToken ? await processesWithTreeToken(treeToken) : undefined
  const enumerationAvailable = tracked !== undefined && marked !== undefined
  const observed = new Set([pid, ...(tracked ?? []), ...(marked ?? [])])
  try {
    process.kill(-pid, 'SIGTERM')
  } catch { /* group may not exist */ }
  signalProcesses(observed, 'SIGTERM')
  if (enumerationAvailable && treeToken && await waitForPosixTreeExit(pid, observed, treeToken, 'SIGTERM', 500)) return true
  // Refresh while parents are still observable so children created during
  // timeout handling are included before the final, non-catchable signal.
  const refreshed = await collectPosixProcessTree(pid, observed)
  if (refreshed) for (const descendant of refreshed) observed.add(descendant)
  const refreshedMarked = treeToken ? await processesWithTreeToken(treeToken) : undefined
  if (refreshedMarked) for (const descendant of refreshedMarked) observed.add(descendant)
  try { process.kill(-pid, 'SIGKILL') } catch { /* group may already be gone */ }
  signalProcesses(observed, 'SIGKILL')
  return enumerationAvailable && refreshed !== undefined && refreshedMarked !== undefined && treeToken !== undefined &&
    await waitForPosixTreeExit(pid, observed, treeToken, 'SIGKILL', 1_000)
}

export function windowsTaskkillPath (systemRoot = 'C:\\Windows'): string {
  if (!path.win32.isAbsolute(systemRoot) || /^[\\/]{2}/.test(systemRoot)) return 'C:\\Windows\\System32\\taskkill.exe'
  return path.win32.join(path.win32.normalize(systemRoot), 'System32', 'taskkill.exe')
}

async function waitForProcessExit (pid: number, timeoutMs = 1_000): Promise<boolean> {
  return await waitUntilGone(() => process.kill(pid, 0), timeoutMs)
}

async function waitForPosixTreeExit (
  pid: number,
  tracked: Set<number>,
  treeToken: string,
  signal: NodeJS.Signals,
  timeoutMs: number
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const marked = await processesWithTreeToken(treeToken)
    if (marked === undefined) return false
    for (const descendant of marked) tracked.add(descendant)
    signalProcesses(marked, signal)
    if (marked.size === 0 && processGroupIsGone(pid) && [...tracked].every(processIsGone)) return true
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  const marked = await processesWithTreeToken(treeToken)
  if (marked === undefined) return false
  for (const descendant of marked) tracked.add(descendant)
  signalProcesses(marked, signal)
  return marked.size === 0 && processGroupIsGone(pid) && [...tracked].every(processIsGone)
}

function processGroupIsGone (pid: number): boolean {
  try { process.kill(-pid, 0); return false } catch { return true }
}

function processIsGone (pid: number): boolean {
  if (process.platform === 'linux') {
    try {
      const stat = readFileSync(`/proc/${pid}/stat`, 'utf8')
      const state = stat.slice(stat.lastIndexOf(')') + 2).trim().split(/\s+/, 1)[0]
      if (state === 'Z' || state === 'X') return true
    } catch { return true }
  }
  try { process.kill(pid, 0); return false } catch { return true }
}

async function processesWithTreeToken (treeToken: string): Promise<Set<number> | undefined> {
  return process.platform === 'linux'
    ? linuxProcessesWithTreeToken(treeToken)
    : await psProcessesWithTreeToken(treeToken)
}

function linuxProcessesWithTreeToken (treeToken: string): Set<number> | undefined {
  let entries: string[]
  try { entries = readdirSync('/proc') } catch { return undefined }
  const marker = `${COMMAND_TREE_TOKEN_ENV}=${treeToken}`
  const matches = new Set<number>()
  for (const entry of entries) {
    if (!/^\d+$/.test(entry)) continue
    try {
      const environment = readFileSync(`/proc/${entry}/environ`, 'utf8').split('\0')
      if (environment.includes(marker)) matches.add(Number(entry))
    } catch { /* process exited or belongs to another user */ }
  }
  return matches
}

async function psProcessesWithTreeToken (treeToken: string): Promise<Set<number> | undefined> {
  return await new Promise((resolve) => {
    const matches = new Set<number>()
    const marker = `${COMMAND_TREE_TOKEN_ENV}=${treeToken}`
    const ps = spawn('/bin/ps', ['eww', '-axo', 'pid=,command='], { shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] })
    let output = ''
    ps.stdout?.setEncoding('utf8')
    ps.stdout?.on('data', (chunk: string) => { output += chunk })
    ps.once('error', () => resolve(undefined))
    ps.once('exit', (code) => {
      if (code !== 0) return resolve(undefined)
      for (const line of output.split('\n')) {
        const match = /^\s*(\d+)\s+/.exec(line)
        if (match && line.includes(marker)) matches.add(Number(match[1]))
      }
      resolve(matches)
    })
  })
}

function signalProcesses (pids: ReadonlySet<number>, signal: NodeJS.Signals): void {
  for (const childPid of pids) {
    try { process.kill(childPid, signal) } catch { /* process may already be gone */ }
  }
}

async function collectPosixProcessTree (rootPid: number, existing: ReadonlySet<number> = new Set()): Promise<Set<number> | undefined> {
  const parents = process.platform === 'linux' ? linuxProcessParents() : await psProcessParents()
  if (!parents) return undefined
  const collected = new Set<number>([rootPid, ...existing])
  let changed = true
  while (changed) {
    changed = false
    for (const [child, parent] of parents) {
      if (collected.has(parent) && !collected.has(child)) {
        collected.add(child)
        changed = true
      }
    }
  }
  return collected
}

function linuxProcessParents (): Map<number, number> | undefined {
  const parents = new Map<number, number>()
  let entries: string[] = []
  try { entries = readdirSync('/proc') } catch { return undefined }
  for (const entry of entries) {
    if (!/^\d+$/.test(entry)) continue
    try {
      const stat = readFileSync(`/proc/${entry}/stat`, 'utf8')
      const fields = stat.slice(stat.lastIndexOf(')') + 2).trim().split(/\s+/)
      const child = Number(entry)
      const parent = Number(fields[1])
      if (Number.isSafeInteger(child) && Number.isSafeInteger(parent)) parents.set(child, parent)
    } catch { /* process exited during the snapshot */ }
  }
  return parents
}

async function psProcessParents (): Promise<Map<number, number> | undefined> {
  return await new Promise((resolve) => {
    const parents = new Map<number, number>()
    const ps = spawn('/bin/ps', ['-axo', 'pid=,ppid='], { shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] })
    let output = ''
    ps.stdout?.setEncoding('utf8')
    ps.stdout?.on('data', (chunk: string) => { output += chunk })
    ps.once('error', () => resolve(undefined))
    ps.once('exit', (code) => {
      if (code !== 0) return resolve(undefined)
      for (const line of output.split('\n')) {
        const match = /^\s*(\d+)\s+(\d+)\s*$/.exec(line)
        if (match) parents.set(Number(match[1]), Number(match[2]))
      }
      resolve(parents)
    })
  })
}

async function waitUntilGone (probe: () => void, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try { probe() } catch { return true }
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  try { probe(); return false } catch { return true }
}

function isExecutable (filePath: string, platform: NodeJS.Platform = process.platform): boolean {
  // When a POSIX host is forced to win32 semantics (cross-platform tests) the
  // win32 resolver emits backslash-separated paths; map them to native before
  // touching the real filesystem. On the host platform this is a no-op.
  const nativePath = process.platform === 'win32' ? filePath : filePath.split('\\').join(path.sep)
  try {
    if (platform === 'win32') {
      accessSync(nativePath, constants.F_OK)
      return true
    }
    accessSync(nativePath, constants.X_OK)
    return true
  } catch {
    return false
  }
}

function environmentValue (env: Readonly<Record<string, string | undefined>>, key: string): string | undefined {
  const exact = env[key]
  if (exact !== undefined) return exact
  const conventional = key === 'PATH' ? env.Path : key === 'PATHEXT' ? env.PathExt : undefined
  if (conventional !== undefined) return conventional
  const match = Object.entries(env).find(([name, value]) => name.toLowerCase() === key.toLowerCase() && value !== undefined)
  return match?.[1]
}

function mergeCommandEnvironment (overrides?: Readonly<Record<string, string>>): NodeJS.ProcessEnv {
  const merged: NodeJS.ProcessEnv = { ...process.env }
  for (const [name, value] of Object.entries(overrides ?? {})) {
    if (process.platform === 'win32') {
      for (const existing of Object.keys(merged)) {
        if (existing.toLowerCase() === name.toLowerCase()) delete merged[existing]
      }
    }
    merged[name] = value
  }
  return merged
}

function revalidatePlannedIdentity (spec: CommandSpec, fresh: ResolvedExecutable): boolean {
  const planned = spec.executableIdentity
  if (!planned) return true
  if (planned.kind === 'unsupported') return false
  if (fresh.kind === 'unsupported') return false
  // The freshly resolved spawn target must match the planned executable. For a
  // `node` identity `spec.executable` is `process.execPath`, which resolves
  // fresh to a `native` executable whose path must equal the planned one.
  if (fresh.executable !== planned.executable) return false
  if (planned.kind === 'native') return fresh.kind === 'native' && path.isAbsolute(planned.executable) && existsSync(planned.executable)
  // For a `node` identity the derived entrypoint is spawned as spec.args[0]; it
  // must match the planned entrypoint and still exist.
  return path.isAbsolute(planned.entrypoint) && spec.args[0] === planned.entrypoint && existsSync(planned.entrypoint)
}

function preferredWindowsExtensions (value: string): string[] {
  const extensions = value.split(';').map((extension) => extension.trim()).filter(Boolean)
  return extensions.sort((left, right) => windowsExtensionPriority(left) - windowsExtensionPriority(right))
}

function windowsExtensionPriority (extension: string): number {
  const normalized = extension.toLowerCase()
  if (normalized === '.exe' || normalized === '.com') return 0
  if (normalized === '.cmd' || normalized === '.bat') return 1
  return 2
}
