#!/usr/bin/env node

// render-cpu-report.cjs — Writes a CPU profile (or heap sampling) report from
// nsolid: a flame graph, time by package, the heaviest functions, and the
// process's CPU and heap around the profile, in one HTML file that opens
// anywhere and needs no network.
//
// Usage:
//   node render-cpu-report.cjs <assetId> [--app <name>] [--artifact]
//
//   --artifact  also write <name>.artifact.html: the same page without the
//               document around it, for hosts that add their own (Claude
//               artifacts).
//
// Writes .nsolid/reports/<kind>-<app>-<date>-<assetIdPrefix>.html and prints
// a short JSON summary (file paths, title, busy time, top functions). The
// profile's data goes to the file, never to the agent's context.

'use strict'

const fs = require('fs')
const path = require('path')
const { createClient, slug } = require('./nsolid-api.cjs')
const { renderReport } = require('./nsolid-report.cjs')

const MINUTE = 60_000

function parseArgs (argv) {
  const args = { assetId: '', app: '', artifact: false }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--artifact') args.artifact = true
    else if (a === '--app') args.app = argv[++i] ?? ''
    else if (!args.assetId) args.assetId = a
    else throw new Error(`unexpected argument: ${a}`)
  }
  if (!/^[0-9a-f-]{36}$/i.test(args.assetId)) {
    throw new Error('usage: node render-cpu-report.cjs <assetId> [--app <name>] [--artifact]')
  }
  return args
}

const ms = (v) => (v < 1000 ? `${Math.round(v)} ms` : `${(v / 1000).toFixed(v < 10_000 ? 2 : 1)} s`)
const pct = (share) => `${share < 0.1 ? (share * 100).toFixed(1) : Math.round(share * 100)}%`

/** Self value by frame, heaviest first. */
function heaviest (tree, limit) {
  const self = new Map()
  for (const level of tree.levels.slice(1)) {
    for (let i = 0; i < level.length; i += 4) {
      self.set(level[i + 3], (self.get(level[i + 3]) ?? 0) + level[i + 2])
    }
  }
  return [...self].sort((a, b) => b[1] - a[1]).slice(0, limit).map(([frame, value]) => {
    const f = tree.frames[frame]
    const file = f.url ? f.url.replace(/^file:\/\//, '').split('/').pop() : ''
    return {
      name: f.name,
      package: f.version ? `${f.package}@${f.version}` : f.package,
      location: file && f.line >= 0 ? `${file}:${f.line + 1}` : file,
      selfPercent: Math.round((value / Math.max(1, tree.total)) * 1000) / 10
    }
  })
}

async function series (api, tenant, metric, agentId, from, to) {
  try {
    const q = new URLSearchParams({ from, to, agent: agentId, maxPoints: '300' })
    const m = await api.get(`/v1/tenants/${tenant}/metrics/${metric}?${q}`)
    return m.series?.[0]?.points ?? []
  } catch {
    return []
  }
}

async function main () {
  const args = parseArgs(process.argv.slice(2))
  const api = createClient()
  const tenant = encodeURIComponent(await api.tenant())
  const asset = await api.get(`/v1/tenants/${tenant}/assets/${args.assetId}`)
  if (asset.kind !== 'cpu_profile' && asset.kind !== 'heap_sampling') {
    throw new Error(`a ${asset.kind} has no flame graph; this report is for CPU profiles and heap samplings`)
  }
  const [tree, agent] = await Promise.all([
    api.get(`/v1/tenants/${tenant}/assets/${args.assetId}/flame`),
    api.get(`/v1/tenants/${tenant}/agents/${asset.agentId}`).catch(() => null)
  ])
  const app = args.app || agent?.app || 'unknown'
  const cpu = asset.kind === 'cpu_profile'
  const start = Date.parse(asset.windowStart ?? asset.startedAt)
  const end = Date.parse(asset.windowEnd ?? asset.finishedAt)
  const from = new Date(start - 10 * MINUTE).toISOString()
  const to = new Date(end + 5 * MINUTE).toISOString()
  const [cpuPoints, heapPoints] = await Promise.all([
    series(api, tenant, 'cpu_percent', asset.agentId, from, to),
    series(api, tenant, 'used_heap_size', asset.agentId, from, to)
  ])

  const top = heaviest(tree, 5)
  const appTop = heaviest(tree, 50).find((f) => f.package === '(app)')
  const busyMs = tree.total * tree.sampleIntervalMs
  const idleShare = tree.idle / Math.max(1, tree.total + tree.idle)
  const title = `${app} ${cpu ? 'CPU profile' : 'heap sampling'}`
  const taken = new Date(end).toISOString().replace('T', ' ').slice(0, 16)
  const spec = {
    title,
    subtitle: cpu
      ? `${ms(busyMs)} busy over ${ms((tree.total + tree.idle) * tree.sampleIntervalMs)} of profiling, taken ${taken} UTC`
      : `Live memory by allocating function, sampled ${taken} UTC`,
    generatedAt: Date.now(),
    source: [
      { label: 'App', value: app },
      { label: 'Host', value: agent?.hostname ?? '–' },
      { label: 'Process', value: `${asset.agentId.slice(0, 12)}…` },
      { label: 'Asset', value: asset.id },
      { label: 'Runtime', value: agent ? `Node ${agent.nodeVersion ?? '?'}, N|Solid ${agent.nsolidVersion ?? '?'}` : '–' }
    ],
    sections: [
      {
        kind: 'stats',
        items: cpu
          ? [
              { label: 'Busy', value: ms(busyMs) },
              { label: 'Idle', value: pct(idleShare) },
              { label: 'Functions', value: String(tree.frames.length - 1) },
              ...(appTop
                ? [{ label: "The app's heaviest function", value: appTop.name, hint: `${appTop.location} · ${appTop.selfPercent}% self` }]
                : [])
            ]
          : [
              { label: 'Live memory sampled', value: `${(tree.total / 1048576).toFixed(1)} MB` },
              { label: 'Functions', value: String(tree.frames.length - 1) }
            ]
      },
      {
        kind: 'flame',
        title: cpu ? 'Where the time went' : 'Where the memory is',
        tree,
        note: 'Click a bar to zoom in and the top bar to zoom out; search by function, package or file. Colors are packages: green is the application, blue Node.js, grey V8.'
      },
      ...(cpuPoints.length
        ? [{
            kind: 'timeseries',
            title: 'CPU around the profile',
            times: cpuPoints.map((p) => p[0]),
            series: [{ label: 'CPU %', values: cpuPoints.map((p) => p[1]) }],
            unit: 'percent',
            note: `The profile ran from ${new Date(start).toISOString().slice(11, 19)} to ${new Date(end).toISOString().slice(11, 19)} UTC.`
          }]
        : []),
      ...(heapPoints.length
        ? [{
            kind: 'timeseries',
            title: 'Heap used',
            times: heapPoints.map((p) => p[0]),
            series: [{ label: 'Heap used', values: heapPoints.map((p) => p[1]) }],
            unit: 'bytes'
          }]
        : [])
    ]
  }

  const dir = path.join(process.cwd(), '.nsolid', 'reports')
  fs.mkdirSync(dir, { recursive: true })
  const base = `${cpu ? 'cpu' : 'heap'}-${slug(app)}-${new Date(end).toISOString().slice(0, 10)}-${asset.id.slice(0, 8)}`
  const file = path.join(dir, `${base}.html`)
  fs.writeFileSync(file, renderReport(spec), 'utf8')
  let artifactFile
  if (args.artifact) {
    artifactFile = path.join(dir, `${base}.artifact.html`)
    fs.writeFileSync(artifactFile, renderReport(spec, { fragment: true }), 'utf8')
  }
  console.log(JSON.stringify({
    file,
    ...(artifactFile ? { artifactFile } : {}),
    title,
    description: spec.subtitle,
    app,
    assetId: asset.id,
    agentId: asset.agentId,
    ...(cpu ? { busyMs: Math.round(busyMs), idlePercent: Math.round(idleShare * 100) } : { liveBytes: tree.total }),
    topFunctions: top
  }, null, 2))
}

if (require.main === module) {
  main().catch((err) => {
    console.error(`Error: ${err.message}`)
    process.exit(1)
  })
}
