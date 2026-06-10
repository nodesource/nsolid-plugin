#!/usr/bin/env node
'use strict'

/**
 * fetch-node-releases.cjs
 *
 * Fetches the live Node.js release schedule from endoflife.date and prints
 * a markdown table of active (non-EOL) release lines, sorted descending by
 * major version. Falls back to an embedded snapshot on network failure.
 *
 * Usage:
 *   node fetch-node-releases.cjs
 *
 * Output (stdout): markdown table, e.g.
 *   | Major | Status | Latest | Active Support End | EOL |
 *   |-------|--------|--------|--------------------|-----|
 *   | 22    | LTS (Jod) | 22.14.0 | 2025-10-21    | 2027-04-30 |
 *   ...
 *
 * Exit code 0 always (table is always emitted, even on network failure).
 */

// Embedded snapshot — update when a new major LTS ships.
const FALLBACK = [
  { cycle: '24', lts: false,        eol: '2027-04-30', support: '2025-10-28', latest: '24.0.0' },
  { cycle: '22', lts: 'Jod',        eol: '2027-04-30', support: '2025-10-21', latest: '22.14.0' },
  { cycle: '20', lts: 'Iron',       eol: '2026-04-30', support: '2024-10-22', latest: '20.18.3' },
  { cycle: '18', lts: 'Hydrogen',   eol: '2025-04-30', support: '2023-10-18', latest: '18.20.7' }
]

function formatTable (releases) {
  const rows = releases.map(r => {
    const status = r.lts ? `LTS (${r.lts})` : 'Current'
    return `| ${r.cycle} | ${status} | ${r.latest} | ${r.support} | ${r.eol} |`
  })
  return [
    '| Major | Status | Latest | Active Support End | EOL |',
    '|-------|--------|--------|--------------------|-----|',
    ...rows
  ].join('\n')
}

async function fetchReleases () {
  // Node 18+ has built-in fetch; for older runtimes fall back to https module.
  if (typeof fetch === 'function') {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 5000)
    try {
      const res = await fetch('https://endoflife.date/api/nodejs.json', {
        signal: controller.signal
      })
      clearTimeout(timer)
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      return await res.json()
    } catch {
      clearTimeout(timer)
      return null
    }
  }

  // Fallback: use https module (Node <18)
  return new Promise((resolve) => {
    const https = require('https')
    const req = https.get('https://endoflife.date/api/nodejs.json', (res) => {
      let body = ''
      res.on('data', chunk => { body += chunk })
      res.on('end', () => {
        try { resolve(JSON.parse(body)) } catch { resolve(null) }
      })
    })
    req.setTimeout(5000, () => { req.destroy(); resolve(null) })
    req.on('error', () => resolve(null))
  })
}

;(async function main () {
  let releases = null
  try {
    const raw = await fetchReleases()
    if (Array.isArray(raw)) {
      const now = new Date()
      releases = raw
        .filter(r => new Date(r.eol) > now)
        .sort((a, b) => Number(b.cycle) - Number(a.cycle))
    }
  } catch { /* use fallback */ }

  if (!releases || releases.length === 0) {
    process.stderr.write('Warning: could not fetch live release schedule, using embedded fallback.\n')
    releases = FALLBACK
  }

  process.stdout.write(formatTable(releases) + '\n')
})()
