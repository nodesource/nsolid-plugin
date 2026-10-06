#!/usr/bin/env node

// render-activity-report.cjs — Writes a tenant's Activity report from N|Solid:
// who used it and from which clients, which features and pages, and which AI
// assistants and MCP tools, day by day, in one HTML file that opens anywhere
// and needs no network.
//
// Usage:
//   node render-activity-report.cjs [--days <n>] [--to <YYYY-MM-DD>] [--no-people] [--artifact]
//
//   --days       how many days, ending with --to (default 30, at most 400)
//   --to         the last day, UTC (default today)
//   --no-people  leave out who: no People table, so the page names no one
//   --artifact   also write <name>.artifact.html: the same page without the
//                document around it, for hosts that add their own (Claude
//                artifacts).
//
// Reading activity needs the Audit log permission (nsolid:audit-log), which
// tenant admins hold. Writes .nsolid/reports/activity-<tenant>-<from>-to-<to>.html
// and prints a short JSON summary (file paths, title, totals, the busiest
// features, assistants and tools). Names go to the file, never to the agent's
// context.

'use strict'

const fs = require('fs')
const path = require('path')
const { createClient, slug } = require('./nsolid-api.cjs')
const { renderReport } = require('./nsolid-report.cjs')

const DAY = 86_400_000
const MINUTE = 60_000
const MAX_DAYS = 400

// As the N|Solid web UI names them; anything newer shows as it is recorded.
const CLIENTS = { web: 'Web UI', mcp: 'AI assistants (MCP)', api: 'API and scripts' }
const AREAS = {
  fleet: 'Apps, processes and events',
  telemetry: 'Metrics, traces and logs',
  assets: 'Profiles and snapshots',
  actions: 'Commands and settings',
  alerts: 'Alerts',
  vulnerabilities: 'Security',
  access: 'Access and agents',
  live: 'Live updates',
  meta: 'Reference'
}
const PAGES = {
  '/t/:tenant': 'Applications',
  '/t/:tenant/processes': 'Processes',
  '/t/:tenant/processes/:agentId': 'A process',
  '/t/:tenant/apps/:app': "An app's CPU",
  '/t/:tenant/metrics': 'Metrics',
  '/t/:tenant/traces': 'Traces',
  '/t/:tenant/traces/:traceId': 'A trace',
  '/t/:tenant/events': 'Events',
  '/t/:tenant/alerts': 'Alerts',
  '/t/:tenant/alerts/:fingerprint': 'An alert',
  '/t/:tenant/alerts/rules': 'Alert rules',
  '/t/:tenant/alerts/rules/:name': 'An alert rule',
  '/t/:tenant/alerts/channels': 'Alert channels',
  '/t/:tenant/alerts/deliveries': 'Deliveries',
  '/t/:tenant/security': 'Security',
  '/t/:tenant/security/:advisory': 'A vulnerability',
  '/t/:tenant/assets': 'Profiles and snapshots',
  '/t/:tenant/assets/:assetId': 'A profile or snapshot',
  '/t/:tenant/connect': 'Connect agents',
  '/t/:tenant/activity': 'Activity',
  '/t/:tenant/source': 'Source code',
  '/t/:tenant/support': 'NodeSource access'
}

/** What each part of the report asks GET /activity for. */
const QUERIES = {
  clients: { by: 'client' },
  areas: { by: 'area' },
  people: { by: 'person', limit: '1000' },
  pages: { by: 'view', client: 'web' },
  assistants: { by: 'clientName', client: 'mcp' },
  tools: { by: 'tool', client: 'mcp' },
  days: { by: 'day', limit: '1000' }
}

/** The tables, in the web UI's order. */
const TABLES = [
  { key: 'clients', title: 'By client', subject: 'Client', name: (r) => CLIENTS[r.key] ?? r.key, empty: 'Nothing used N|Solid in these days.' },
  { key: 'areas', title: 'Features', subject: 'Feature', name: (r) => AREAS[r.key] ?? (r.key || 'Other'), empty: 'No feature was used in these days.' },
  { key: 'assistants', title: 'AI assistants', subject: 'Assistant', tools: true, name: (r) => r.key || 'Unnamed MCP client', empty: 'No AI assistant used N|Solid over MCP in these days.' },
  { key: 'tools', title: 'AI tools', subject: 'MCP tool', tools: true, name: (r) => r.key || 'Between tool calls', empty: 'No MCP tool was called in these days.' },
  { key: 'pages', title: 'Pages', subject: 'Page', name: (r) => PAGES[r.key] ?? (r.key || 'Other'), empty: 'No page of the web UI was opened in these days.' },
  { key: 'people', title: 'People', subject: 'Person or token', people: true, name: (r) => r.label ?? `${r.key.split(':')[0]} ${(r.key.split(':')[1] ?? '').slice(0, 8)}`, empty: 'No one used N|Solid in these days.' }
]

const DAY_PARAM = /^\d{4}-\d{2}-\d{2}$/
const isoDay = (ms) => new Date(ms).toISOString().slice(0, 10)

function parseArgs (argv, now = Date.now()) {
  const args = { days: 30, to: isoDay(now), people: true, artifact: false }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--artifact') args.artifact = true
    else if (a === '--no-people') args.people = false
    else if (a === '--days') args.days = Number(argv[++i])
    else if (a === '--to') args.to = argv[++i] ?? ''
    else throw new Error(`unexpected argument: ${a}`)
  }
  if (!Number.isInteger(args.days) || args.days < 1 || args.days > MAX_DAYS) {
    throw new Error(`--days is a whole number from 1 to ${MAX_DAYS}`)
  }
  if (!DAY_PARAM.test(args.to) || Number.isNaN(Date.parse(`${args.to}T00:00:00Z`))) {
    throw new Error('--to is a day, YYYY-MM-DD')
  }
  args.from = isoDay(Date.parse(`${args.to}T00:00:00Z`) - (args.days - 1) * DAY)
  return args
}

/** 45 min, 1.2 h: as the web UI shows time in use. */
const hours = (minutes) => (minutes < 60 ? `${minutes} min` : `${Math.round(minutes / 6) / 10} h`)
const sum = (rows, f) => rows.reduce((n, r) => n + f(r), 0)

/** Each day from `from` to `to`, at midnight UTC, with that day's row (or none). */
function eachDay (from, to, rows) {
  const byDay = new Map(rows.map((r) => [r.key, r]))
  const days = []
  for (let t = Date.parse(`${from}T00:00:00Z`); t <= Date.parse(`${to}T00:00:00Z`); t += DAY) {
    days.push({ t, row: byDay.get(isoDay(t)) })
  }
  return days
}

/**
 * The report's spec: what the web UI's Activity page shows for the same days,
 * plus the days themselves. `rows` holds GET /activity's rows per QUERIES key.
 */
function buildSpec ({ tenant, from, to, rows, people = true, instance, now = Date.now() }) {
  const clients = rows.clients ?? []
  const everyone = new Set((rows.people ?? []).map((r) => r.key)).size
  const mcp = clients.find((r) => r.key === 'mcp')
  const assistants = rows.assistants ?? []
  const name = tenant.name || tenant.id
  const days = eachDay(from, to, rows.days ?? [])
  const used = days.filter((d) => d.row).length

  const sections = [
    {
      kind: 'stats',
      items: [
        { label: 'People and tokens', value: String(everyone) },
        { label: 'Actions', value: String(sum(clients, (r) => r.actions)) },
        {
          label: 'AI tool calls',
          value: String(mcp?.toolCalls ?? 0),
          ...(assistants.length ? { hint: `from ${assistants.length} AI assistant${assistants.length === 1 ? '' : 's'}` } : {})
        },
        { label: 'Time in use', value: hours(sum(clients, (r) => r.activeMinutes)) },
        { label: 'Days with use', value: `${used} of ${days.length}` }
      ]
    }
  ]
  if (days.length > 1) {
    sections.push(
      {
        kind: 'timeseries',
        title: 'People a day',
        times: days.map((d) => d.t),
        days: true,
        series: [{ label: 'People and tokens', values: days.map((d) => d.row?.people ?? 0), bars: true }]
      },
      {
        kind: 'timeseries',
        title: 'Requests a day',
        times: days.map((d) => d.t),
        days: true,
        series: [{ label: 'Requests', values: days.map((d) => d.row?.requests ?? 0), bars: true }],
        note: 'Days in UTC. An AI tool call can make several requests; the AI tables count calls.'
      }
    )
  }
  for (const t of TABLES) {
    if (t.people && !people) continue
    const list = rows[t.key] ?? []
    if (!list.length) {
      sections.push({ kind: 'text', title: t.title, paragraphs: [t.empty] })
      continue
    }
    sections.push({
      kind: 'table',
      title: t.title,
      columns: [t.subject, 'People', 'Days', t.tools ? 'Tool calls' : 'Actions', 'Requests', 'Time in use'],
      units: [null, 'count', 'count', 'count', 'count', 'ms'],
      rows: list.map((r) => [t.name(r), r.people, r.days, t.tools ? r.toolCalls : r.actions, r.requests, r.activeMinutes * MINUTE])
    })
  }
  sections.push({
    kind: 'text',
    paragraphs: [
      'Time in use counts the five-minute periods with a request, per person. Actions are requests that changed something or acted on a process; reads are not actions.',
      "NodeSource support's requests are not counted here: the tenant's NodeSource access page lists them."
    ]
  })

  return {
    title: `Activity in ${name}`,
    subtitle: `How ${name} used N|Solid from ${from} to ${to}: features, pages, ${people ? 'people, ' : ''}and AI assistants over MCP.`,
    generatedAt: now,
    source: [
      { label: 'Tenant', value: tenant.name && tenant.name !== tenant.id ? `${tenant.name} (${tenant.id})` : tenant.id },
      { label: 'Days', value: `${from} to ${to}, UTC` },
      ...(instance ? [{ label: 'N|Solid', value: instance }] : [])
    ],
    sections
  }
}

/** The busiest rows by a measure, named: for the summary the agent reads. */
function top (list, table, measure, n = 3) {
  return [...list]
    .sort((a, b) => b[measure] - a[measure])
    .slice(0, n)
    .map((r) => ({ name: table.name(r), [measure]: r[measure] }))
}

async function main () {
  const args = parseArgs(process.argv.slice(2))
  const api = createClient()
  const me = await api.get('/v1/me')
  const tenantId = await api.tenant()
  const tenant = (me.tenants ?? []).find((t) => t.id === tenantId) ?? { id: tenantId }
  const t = encodeURIComponent(tenantId)
  const rows = {}
  // Every request settles before any failure is reported: exiting with some
  // still in flight can crash Node on Windows.
  const settled = await Promise.allSettled(Object.entries(QUERIES).map(async ([key, q]) => {
    const query = new URLSearchParams({ from: args.from, to: args.to, ...q })
    rows[key] = (await api.get(`/v1/tenants/${t}/activity?${query}`)).rows ?? []
  }))
  const failed = settled.find((r) => r.status === 'rejected')?.reason
  if (failed?.message?.includes('"nsolid:audit-log"')) {
    throw new Error(`${failed.message}: the Activity report needs the Audit log permission, which tenant admins hold`)
  }
  if (failed) throw failed

  const spec = buildSpec({
    tenant,
    from: args.from,
    to: args.to,
    rows,
    people: args.people,
    instance: new URL(api.config.apiUrl).host
  })
  const dir = path.join(process.cwd(), '.nsolid', 'reports')
  fs.mkdirSync(dir, { recursive: true })
  const base = `activity-${slug(tenantId)}-${args.from}-to-${args.to}${args.people ? '' : '-anonymous'}`
  const file = path.join(dir, `${base}.html`)
  fs.writeFileSync(file, renderReport(spec), 'utf8')
  let artifactFile
  if (args.artifact) {
    artifactFile = path.join(dir, `${base}.artifact.html`)
    fs.writeFileSync(artifactFile, renderReport(spec, { fragment: true }), 'utf8')
  }
  const clients = rows.clients
  const table = (key) => TABLES.find((x) => x.key === key)
  console.log(JSON.stringify({
    file,
    ...(artifactFile ? { artifactFile } : {}),
    title: spec.title,
    description: spec.subtitle,
    tenant: tenantId,
    from: args.from,
    to: args.to,
    namesPeople: args.people,
    people: new Set(rows.people.map((r) => r.key)).size,
    requests: sum(clients, (r) => r.requests),
    actions: sum(clients, (r) => r.actions),
    aiToolCalls: clients.find((r) => r.key === 'mcp')?.toolCalls ?? 0,
    timeInUse: hours(sum(clients, (r) => r.activeMinutes)),
    clients: top(clients, table('clients'), 'requests'),
    features: top(rows.areas, table('areas'), 'requests'),
    assistants: top(rows.assistants, table('assistants'), 'toolCalls'),
    tools: top(rows.tools, table('tools'), 'toolCalls')
  }, null, 2))
}

if (require.main === module) {
  main().catch((err) => {
    console.error(`Error: ${err.message}`)
    process.exitCode = 1
  })
}

module.exports = { parseArgs, buildSpec, eachDay, hours }
