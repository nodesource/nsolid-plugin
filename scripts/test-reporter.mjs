// Custom node:test reporter: compact live progress + a failures summary at the
// end, so CI output shows WHAT failed without dumping the full TAP stream.
//
// - During the run: "." per pass, "✗" per real leaf failure.
// - At the end:      a grouped FAILURES block (test name + file + trimmed
//                    error message) and authoritative pass/fail counts.
// - Also writes the full, untrimmed failure detail to test-results.log for
//   deep debugging (upload it as a CI artifact).
//
// Counts come from node:test's `test:diagnostic` events (`tests N`, `pass N`,
// `fail N`, `suites N`), which are the leaf-test aggregates node emits — NOT
// from counting pass/fail events ourselves, because passing `describe` suites
// also emit `test:pass` and would inflate the number (324 leaves + 67 suites).
// Suite-aggregate failures (failureType `subtestsFailed`) are excluded from the
// failure list so a single broken test isn't listed twice.
//
// Used via:  node --test --test-reporter=<abs path to this file> ...files

import { writeFileSync, mkdirSync } from 'node:fs'
import { join, basename } from 'node:path'

const MAX_ERR_LINES = 15 // cap per-failure error lines in the stdout summary
const LOG_PATH = join(process.cwd(), 'test-results.log')

const useColor = !process.env.NO_COLOR && (process.stdout.isTTY || process.env.FORCE_COLOR)
const c = (code, s) => (useColor ? `\x1b[${code}m${s}\x1b[0m` : s)
const green = (s) => c('32', s)
const red = (s) => c('31', s)
const dim = (s) => c('2', s)
const bold = (s) => c('1', s)

let dots = 0
const failures = [] // leaf failures only
const logLines = []
// Per-file leaf-test counts (for the success breakdown). Keyed by a
// packages-relative path (e.g. `core/test/unit/.../fetch-asset.test.ts`), NOT
// basename, because multiple packages ship identically-named files (every
// plugin has `test/manifest.test.ts`) and basename-keying would merge them.
// We can only group by file: node:test events carry no parent reference, so
// reliable per-*suite* attribution isn't possible. Most files hold one suite,
// so this is effectively per-suite for them and maps directly to debuggable files.
const perFile = new Map()
const diag = {} // { tests, suites, pass, fail } from diagnostics (authoritative)

// Reduce an absolute test path to a packages-relative key, e.g.
// /repo/packages/core/test/unit/x.test.ts -> core/test/unit/x.test.ts
function fileKey (file) {
  if (!file) return '<unknown>'
  const normalized = file.replace(/\\/g, '/')
  const marker = '/packages/'
  const i = normalized.lastIndexOf(marker)
  if (i >= 0) return normalized.slice(i + marker.length)
  return normalized.startsWith('packages/') ? normalized.slice('packages/'.length) : basename(normalized)
}

function pkgOf (key) { return key.split('/')[0] }

function bumpFile (file, ok) {
  const key = fileKey(file)
  const e = perFile.get(key) || { pass: 0, fail: 0 }
  if (ok) e.pass++; else e.fail++
  perFile.set(key, e)
}

export default async function * summaryReporter (source) {
  for await (const event of source) {
    const data = event.data || {}
    const isLeaf = data.details?.type === 'test'
    switch (event.type) {
      case 'test:pass':
        // Only leaf tests count toward dots/totals; passing suites also emit
        // test:pass and would otherwise inflate the dot row (324 -> 391).
        if (!isLeaf) break
        bumpFile(data.file, true)
        yield '.'
        if (++dots >= 60) { dots = 0; yield '\n' }
        break

      case 'test:fail': {
        const err = data.details?.error
        // Skip suite-level aggregates ("N subtests failed"); they're not the
        // real failure, just a parent reporting a child failed.
        if (err?.failureType === 'subtestsFailed') break

        bumpFile(data.file, false)
        // Package-relative key (e.g. core/test/unit/x.test.ts), NOT bare
        // basename — every plugin ships identically-named files (manifest.test.ts)
        // and basename would collapse failures from different packages into one
        // ambiguous `byFile` group, hiding which package actually failed.
        const file = data.file ? fileKey(data.file) : '<unknown file>'
        const name = data.name || '<unnamed>'
        const message = extractMessage(err)
        const stack = typeof err?.stack === 'string' ? err.stack : ''
        const loc = data.line ? `${file}:${data.line}` : file

        failures.push({ name, loc, message })
        logLines.push(renderFailureLog(name, loc, message, stack))
        yield red('✗')
        if (++dots >= 60) { dots = 0; yield '\n' }
        break
      }

      case 'test:stdout':
        if (data?.message) yield data.message
        break
      case 'test:stderr':
        if (data?.message) yield dim(data.message)
        break

      case 'test:diagnostic': {
        // Authoritative aggregates: "tests 324", "pass 262", "fail 62", ...
        const m = /^(tests|suites|pass|fail|cancelled|skipped|todo)\s+(\d+)$/.exec(String(data.message || '').trim())
        if (m) diag[m[1]] = Number(m[2])
        break
      }

      default:
        break
    }
  }

  yield '\n'
  yield renderSummary(diag, failures, perFile)

  const fullLog = renderFullFailureLog(diag, logLines)
  if (failures.length) {
    yield '\n'
    yield fullLog
  }

  // Best-effort full-log dump for local debugging. CI prints the same detail
  // inline on failures, so no artifact or Markdown summary is needed.
  try {
    mkdirSync(process.cwd(), { recursive: true })
    writeFileSync(LOG_PATH, fullLog)
  } catch { /* ignore */ }
}

function extractMessage (err) {
  if (!err) return ''
  if (typeof err === 'string') return err
  if (typeof err.message === 'string' && err.message.trim()) return err.message
  return String(err)
}

function renderSummary (diag, failures, perFile) {
  const total = diag.tests
  const passN = diag.pass
  const failN = diag.fail ?? failures.length
  const suites = diag.suites
  const skipped = diag.skipped ?? 0
  const notes = []
  if (suites != null) notes.push(`${suites} suites`)
  if (skipped > 0) notes.push(`${skipped} skipped`)
  const suiteNote = notes.length ? dim(` (${notes.join(', ')})`) : ''
  const totalNote = total != null ? dim(` of ${total}`) : ''
  const bar = '─'.repeat(60)

  if (failN === 0) {
    const label = passN != null ? `${passN} tests passed` : 'all tests passed'
    return `\n${bar}\n${green('✓ ' + label)}${suiteNote}\n${renderBreakdown(perFile)}${bar}\n`
  }

  if (failures.length === 0) {
    return `\n${bar}\n` +
      bold(red(`FAILURES (${failN})`)) + dim(`  —  details unavailable in reporter events${totalNote}`) + `${suiteNote}\n\n` +
      red(`${failN} failed`) + dim(`, ${passN ?? '?'} passed${totalNote}`) + '\n' +
      dim(`full detail → ${basename(LOG_PATH)}`) + '\n' +
      bar + '\n'
  }

  // Group failures by file for scannability.
  const byFile = new Map()
  for (const f of failures) {
    if (!byFile.has(f.loc)) byFile.set(f.loc, [])
    byFile.get(f.loc).push(f)
  }

  let out = `\n${bar}\n`
  out += bold(red(`FAILURES (${failN})`)) + dim(`  —  ${passN != null ? passN + ' passed' : 'some passed'}${totalNote}`) + `${suiteNote}\n\n`
  let i = 1
  for (const [loc, items] of byFile) {
    out += dim(loc) + '\n'
    for (const f of items) {
      out += `  ${red(`${i}.`)} ${f.name}\n`
      const trimmed = trimError(f.message)
      if (trimmed) out += `     ${dim(trimmed)}\n`
      i++
    }
    out += '\n'
  }
  out += red(`${failN} failed`) + dim(`, ${passN ?? '?'} passed${totalNote}`) + '\n'
  out += dim(`full detail → ${basename(LOG_PATH)}`) + '\n'
  out += bar + '\n'
  return out
}

// Per-file breakdown of leaf test counts. Display name is the basename unless
// that basename collides across packages (e.g. every plugin's manifest.test.ts),
// in which case we prefix with the package name so each row is unambiguous.
// Sorted by display name. Only shown on success; failures get the grouped
// FAILURES block instead.
function renderBreakdown (perFile) {
  const rows = breakdownRows(perFile)
  if (rows.length === 0) return ''
  const maxName = Math.max(...rows.map((r) => r.display.length), 0)
  const width = Math.min(Math.max(maxName, 20), 44) // align + cap very long names
  let out = ''
  for (const { display, pass, fail } of rows) {
    const dots = '.'.repeat(Math.max(2, width - display.length + 2))
    const count = fail > 0 ? `${pass} ${red(`(${fail} failed)`)}` : `${pass}`
    out += `  ${display} ${dim(dots)} ${count}\n`
  }
  return out
}

function breakdownRows (perFile) {
  if (!perFile || perFile.size === 0) return []
  const keys = [...perFile.keys()]
  const baseCount = new Map()
  for (const k of keys) {
    const b = basename(k)
    baseCount.set(b, (baseCount.get(b) || 0) + 1)
  }
  return keys
    .map((k) => {
      const b = basename(k)
      const display = baseCount.get(b) > 1 ? `${pkgOf(k)}/${b}` : b
      return { display, ...perFile.get(k) }
    })
    .sort((a, b) => a.display.localeCompare(b.display))
}

function renderFullFailureLog (diag, logLines) {
  return `node:test full failure log\n` +
    `tests=${diag.tests ?? '?'} suites=${diag.suites ?? '?'} pass=${diag.pass ?? '?'} fail=${diag.fail ?? '?'} skipped=${diag.skipped ?? 0}\n\n` +
    (logLines.length ? logLines.join('\n\n') : '(no failures)') + '\n'
}

function trimError (msg) {
  if (!msg) return ''
  const lines = msg.replace(/\r/g, '').split('\n')
  if (lines.length <= MAX_ERR_LINES) return lines.join('\n     ').trimEnd()
  return lines.slice(0, MAX_ERR_LINES).join('\n     ') + dim(`\n     … (+${lines.length - MAX_ERR_LINES} more lines, see log)`)
}

function renderFailureLog (name, loc, message, stack) {
  let s = `FAIL: ${name}\n  at ${loc}\n`
  if (message) s += `  error: ${indent(message, '  ')}\n`
  if (stack) s += `  stack:\n${indent(stack, '    ')}\n`
  return s.trimEnd()
}

function indent (str, pad) {
  return str.split('\n').map((l) => pad + l).join('\n')
}
