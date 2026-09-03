#!/usr/bin/env node
// Portable cross-platform test runner for `pnpm test`.
//
// Why this exists: the original `node --test 'packages/*/test/**/*.test.ts'`
// matches ZERO files on Windows. Node's internal glob matcher compares the
// forward-slash pattern against Windows backslash paths, so nothing matches —
// and worse, the process exits 0 ("0 tests, success"), making CI look green
// while validating nothing. (See nodejs/node#50757 and related.)
// Shell glob expansion isn't a fix either: bash expands globs, PowerShell/cmd
// don't, so the result would still depend on the runner's shell.
//
// Fix: discover the test files here with node:fs (which always produces
// platform-correct paths), then hand `node --test` real, explicit file paths —
// which it never glob-matches. As a safety net, if no test files are found we
// exit 1 so a "silent zero" is impossible.

import { spawnSync } from 'node:child_process'
import { existsSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { parseTestConcurrency } from './test-concurrency.mjs'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const LOG_PATH = join(ROOT, 'test-results.log')

function findTestFiles (dir, acc) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) {
      findTestFiles(full, acc)
    } else if (entry.isFile() && entry.name.endsWith('.test.ts')) {
      acc.push(full)
    }
  }
  return acc
}

// Collect every *.test.ts under packages/<pkg>/test/ (recursive).
// Optional argv[2] scopes to a single package (e.g. `run-tests.mjs core`),
// so per-package scripts can reuse this runner and stay cross-platform too.
// Always discover the real package list and validate `onlyPackage` against it:
// an unvalidated argv lets `run-tests.mjs ../etc` (or any path) escape the
// `packages/` scope via `join(packagesDir, name, 'test')`, which `node --test`
// would then execute. Reject unknown packages up front instead.
const onlyPackage = process.argv[2]
const packagesDir = join(ROOT, 'packages')
const discoveredPackages = readdirSync(packagesDir, { withFileTypes: true })
  .filter((e) => e.isDirectory())
  .map((e) => e.name)
  .sort()

if (onlyPackage) {
  if (!discoveredPackages.includes(onlyPackage)) {
    console.error(
      `Unknown package: "${onlyPackage}"\n` +
      `Known packages: ${discoveredPackages.join(', ')}`
    )
    process.exit(1)
  }
  // Guard against path-traversal-style input even if it happens to be a
  // substring match; package names are plain identifiers, never paths.
  if (/[\/\\]/.test(onlyPackage)) {
    console.error(`Invalid package name: "${onlyPackage}" (must be a plain package name, not a path)`)
    process.exit(1)
  }
}

const packageNames = onlyPackage ? [onlyPackage] : discoveredPackages

const files = []
for (const name of packageNames) {
  const testDir = join(packagesDir, name, 'test')
  try {
    if (!statSync(testDir).isDirectory()) continue
  } catch {
    continue // package has no test/ dir
  }
  findTestFiles(testDir, files)
}

files.sort() // deterministic order for reproducible output

if (files.length === 0) {
  console.error(
    `No test files found under packages/${onlyPackage ? onlyPackage : '*'}/test/**/*.test.ts`
  )
  process.exit(1)
}

const REPORTER = pathToFileURL(join(ROOT, 'scripts', 'test-reporter.mjs')).href

// node --test has no concurrency cap by default, so it happily spawns one
// worker per test file at once. That's fine on a quiet CI runner, but on a
// dev machine already running other node processes (editor extensions, MCP
// server subprocesses, etc.) it can starve the CPU badly enough that tests
// appear to hang indefinitely rather than just run slowly — this bit the
// husky pre-commit hook (`pnpm test`) in practice. Cap it, with an escape
// hatch for anyone who wants to override it (e.g. a beefier CI runner).
const DEFAULT_CONCURRENCY = Math.max(1, Math.floor(os.availableParallelism() / 2))
let concurrency
try {
  // Validate the override before spawning anything: an invalid value (0,
  // negative, non-numeric, or non-integer) is a broken environment that should
  // fail immediately with a clear message rather than spawning a runner with
  // a garbage --test-concurrency value.
  concurrency = parseTestConcurrency(process.env.NSOLID_TEST_CONCURRENCY, DEFAULT_CONCURRENCY)
} catch (err) {
  console.error(err instanceof Error ? err.message : String(err))
  process.exit(1)
}

const args = [
  '--experimental-test-module-mocks',
  '--import', 'tsx/esm',
  '--test',
  `--test-concurrency=${concurrency}`,
  '--test-reporter', REPORTER,
  ...files,
]
// Several integration tests spawn packages/core/dist/src/cli.js. A stale or
// missing dist fails them with an unrelated ERR_MODULE_NOT_FOUND instead of
// "run pnpm build", which bit the husky pre-commit hook in practice. Build
// first unless the caller proves it already did (CI sets the variable).
let builtHere = false
if (process.env.NSOLID_TEST_CORE_ALREADY_BUILT !== '1') {
  const build = spawnSync('pnpm', ['-s', 'build'], { stdio: 'inherit', cwd: ROOT, shell: process.platform === 'win32' })
  if (build.status !== 0) {
    console.error('pnpm build failed; tests were not run')
    process.exit(build.status ?? 1)
  }
  builtHere = true
}
// When this runner performed the build, tell the test child that dist is
// fresh. Otherwise installer.test.ts rebuilds core concurrently with the
// suites that spawn dist/src/cli.js, and the rm -rf dist window races them
// into an intermittent MODULE_NOT_FOUND (confirmed QA flake). CI exports the
// variable itself, so it never hits the race.
const testEnv = { ...process.env }
if (builtHere) testEnv.NSOLID_TEST_CORE_ALREADY_BUILT = '1'
const result = spawnSync(process.execPath, args, { stdio: 'inherit', cwd: ROOT, env: testEnv })
const status = result.status ?? 1

// If Node fails before the reporter initializes (for example, bad reporter
// loading), the reporter cannot create test-results.log. Create a small local
// fallback; CI still shows the original stack trace in the pnpm test step log.
if (status !== 0 && !existsSync(LOG_PATH)) {
  const msg = result.error
    ? `Test runner failed to start: ${result.error.message}`
    : `Test runner exited with status ${status} before producing reporter output. See the CI step log for the original stack trace.`
  try {
    writeFileSync(LOG_PATH, `node:test runner failure\n\n${msg}\n`)
  } catch { /* ignore */ }
}

process.exit(status)
