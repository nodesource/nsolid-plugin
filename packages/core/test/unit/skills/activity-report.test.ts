import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { createRequire } from 'node:module'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const scriptPath = path.join(__dirname, '../../../../../skill-assets/render-activity-report.cjs')
const require = createRequire(import.meta.url)
const { parseArgs, buildSpec } = require(scriptPath) as {
  parseArgs: (argv: string[], now?: number) => { days: number, from: string, to: string, people: boolean, artifact: boolean }
  buildSpec: (input: Record<string, unknown>) => {
    title: string
    subtitle: string
    sections: Array<Record<string, any>>
  }
}

type Row = { key: string, label: string | null, people: number, requests: number, actions: number, errors: number, toolCalls: number, activeMinutes: number, days: number }
const row = (key: string, n: number, extra: Partial<Row> = {}): Row => ({
  key, label: null, people: 1, requests: n, actions: 0, errors: 0, toolCalls: 0, activeMinutes: 5 * n, days: 1, ...extra
})

const ROWS: Record<string, Row[]> = {
  client: [row('web', 40, { actions: 3, activeMinutes: 65 }), row('mcp', 6, { toolCalls: 4 })],
  area: [row('fleet', 30), row('newarea', 2)],
  person: [row('user:7f1c2d9e-0000-4000-8000-000000000001', 40, { label: 'ana@example.test' }), row('token:6a2b', 6, { label: 'ci' })],
  view: [row('/t/:tenant/processes', 12), row('', 3)],
  clientName: [row('claude-code', 6, { toolCalls: 4 })],
  tool: [row('find_agents', 3, { toolCalls: 2 }), row('list_apps', 3, { toolCalls: 2 })],
  day: [row('2026-10-01', 20), row('2026-10-03', 26, { people: 2 })]
}

test('parseArgs counts the days back from --to, and refuses what it cannot read', () => {
  const now = Date.parse('2026-10-06T12:00:00Z')
  assert.deepEqual(parseArgs([], now), { days: 30, to: '2026-10-06', people: true, artifact: false, from: '2026-09-07' })
  assert.deepEqual(
    parseArgs(['--days', '7', '--to', '2026-10-03', '--no-people', '--artifact'], now),
    { days: 7, to: '2026-10-03', people: false, artifact: true, from: '2026-09-27' }
  )
  assert.throws(() => parseArgs(['--days', '0'], now), /--days/)
  assert.throws(() => parseArgs(['--days', '401'], now), /--days/)
  assert.throws(() => parseArgs(['--to', '10/03/2026'], now), /--to/)
  assert.throws(() => parseArgs(['--tenant', 'x'], now), /unexpected argument/)
})

test('buildSpec draws what the Activity page shows, a day at a time', () => {
  const spec = buildSpec({
    tenant: { id: 'acme-prod', name: 'Acme production' },
    from: '2026-10-01',
    to: '2026-10-03',
    rows: { clients: ROWS.client, areas: ROWS.area, people: ROWS.person, pages: ROWS.view, assistants: ROWS.clientName, tools: ROWS.tool, days: ROWS.day },
    instance: 'nsolid.example.test',
    now: Date.parse('2026-10-03T12:00:00Z')
  })
  assert.equal(spec.title, 'Activity in Acme production')
  const stats = spec.sections[0]
  assert.deepEqual(stats.items.map((s: { label: string, value: string }) => [s.label, s.value]), [
    ['People and tokens', '2'],
    ['Actions', '3'],
    ['AI tool calls', '4'],
    ['Time in use', '1.6 h'],
    ['Days with use', '2 of 3']
  ])

  // A bar a day, the days without use at zero.
  const [people, requests] = spec.sections.filter((s) => s.kind === 'timeseries')
  assert.equal(people.days, true)
  assert.deepEqual(people.times, [Date.parse('2026-10-01T00:00:00Z'), Date.parse('2026-10-02T00:00:00Z'), Date.parse('2026-10-03T00:00:00Z')])
  assert.deepEqual(people.series[0].values, [1, 0, 2])
  assert.deepEqual(requests.series[0].values, [20, 0, 26])

  const tables = spec.sections.filter((s) => s.kind === 'table')
  assert.deepEqual(tables.map((t) => t.title), ['By client', 'Features', 'AI assistants', 'AI tools', 'Pages', 'People'])
  const features = tables[1]
  // Named as the web UI names them; an area it doesn't know shows as recorded.
  assert.deepEqual(features.rows.map((r: unknown[]) => r[0]), ['Apps, processes and events', 'newarea'])
  // Time in use as a duration; tool tables count calls.
  assert.deepEqual(features.units, [null, 'count', 'count', 'count', 'count', 'ms'])
  assert.equal(features.rows[0][5], 150 * 60_000)
  assert.equal(tables[2].columns[3], 'Tool calls')
  assert.deepEqual(tables[4].rows.map((r: unknown[]) => r[0]), ['Processes', 'Other'])
  assert.deepEqual(tables[5].rows.map((r: unknown[]) => r[0]), ['ana@example.test', 'ci'])
})

test('buildSpec without people names no one, and says what had no use', () => {
  const spec = buildSpec({
    tenant: { id: 'acme' },
    from: '2026-10-03',
    to: '2026-10-03',
    rows: { clients: ROWS.client, areas: ROWS.area, people: ROWS.person, pages: [], assistants: [], tools: [], days: [] },
    people: false
  })
  assert.equal(spec.title, 'Activity in acme')
  assert.doesNotMatch(JSON.stringify(spec), /ana@example\.test|"ci"/)
  assert.ok(!spec.sections.some((s) => s.title === 'People'))
  // One day: no chart of days.
  assert.ok(!spec.sections.some((s) => s.kind === 'timeseries'))
  const empty = spec.sections.filter((s) => s.kind === 'text' && s.title)
  assert.deepEqual(empty.map((s) => s.title), ['AI assistants', 'AI tools', 'Pages'])
})

async function serve (handler: (req: IncomingMessage, res: ServerResponse) => void) {
  const server = createServer(handler)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  return { server, url: `http://127.0.0.1:${(server.address() as AddressInfo).port}` }
}

function run (cwd: string, env: Record<string, string>, args: string[]) {
  return new Promise<{ code: number, stdout: string, stderr: string }>((resolve) => {
    const childEnv: Record<string, string | undefined> = { ...process.env, NSOLID_TENANT: '', ...env }
    // The test reads its settings from here alone, never a developer's own.
    childEnv.HOME = cwd
    childEnv.USERPROFILE = cwd
    execFile(process.execPath, [scriptPath, ...args], { cwd, env: childEnv }, (err, stdout, stderr) => {
      resolve({ code: err ? Number((err as { code?: number }).code ?? 1) : 0, stdout, stderr })
    })
  })
}

test('writes the report and its artifact copy from the API, and prints no names', async (t) => {
  const seen: string[] = []
  const { server, url } = await serve((req, res) => {
    const u = new URL(req.url ?? '/', 'http://x')
    assert.equal(req.headers.authorization, 'Bearer skt_test')
    assert.equal(req.headers['x-nsolid-client-name'], 'nsolid-plugin')
    res.setHeader('content-type', 'application/json')
    if (u.pathname === '/v1/me') {
      res.end(JSON.stringify({ tenants: [{ id: 'acme', name: 'Acme' }] }))
      return
    }
    assert.equal(u.pathname, '/v1/tenants/acme/activity')
    seen.push(`${u.searchParams.get('by')}:${u.searchParams.get('client') ?? ''}:${u.searchParams.get('from')}:${u.searchParams.get('to')}`)
    res.end(JSON.stringify({ from: u.searchParams.get('from'), to: u.searchParams.get('to'), by: u.searchParams.get('by'), rows: ROWS[u.searchParams.get('by') ?? ''] ?? [] }))
  })
  const dir = await mkdtemp(path.join(os.tmpdir(), 'activity-report-'))
  t.after(async () => {
    server.close()
    await rm(dir, { recursive: true, force: true })
  })

  const out = await run(dir, { NSOLID_API_URL: url, NSOLID_API_TOKEN: 'skt_test' }, ['--days', '3', '--to', '2026-10-03', '--artifact'])
  assert.equal(out.code, 0, out.stderr)
  assert.deepEqual(seen.sort(), [
    'area::2026-10-01:2026-10-03',
    'client::2026-10-01:2026-10-03',
    'clientName:mcp:2026-10-01:2026-10-03',
    'day::2026-10-01:2026-10-03',
    'person::2026-10-01:2026-10-03',
    'tool:mcp:2026-10-01:2026-10-03',
    'view:web:2026-10-01:2026-10-03'
  ])
  const summary = JSON.parse(out.stdout)
  assert.doesNotMatch(out.stdout, /ana@example\.test/)
  assert.deepEqual(
    { title: summary.title, people: summary.people, requests: summary.requests, aiToolCalls: summary.aiToolCalls, timeInUse: summary.timeInUse },
    { title: 'Activity in Acme', people: 2, requests: 46, aiToolCalls: 4, timeInUse: '1.6 h' }
  )
  assert.deepEqual(summary.assistants, [{ name: 'claude-code', toolCalls: 4 }])
  const reports = path.join(dir, '.nsolid', 'reports')
  assert.deepEqual((await readdir(reports)).sort(), [
    'activity-acme-2026-10-01-to-2026-10-03.artifact.html',
    'activity-acme-2026-10-01-to-2026-10-03.html'
  ])
  const page = await readFile(path.join(reports, 'activity-acme-2026-10-01-to-2026-10-03.html'), 'utf8')
  assert.match(page, /^<!doctype html>/)
  assert.match(page, /<title>Activity in Acme<\/title>/)
  assert.match(page, /ana@example\.test/)
  const fragment = await readFile(summary.artifactFile, 'utf8')
  assert.doesNotMatch(fragment, /<!doctype|<html|<body/i)

  const anonymous = await run(dir, { NSOLID_API_URL: url, NSOLID_API_TOKEN: 'skt_test' }, ['--days', '3', '--to', '2026-10-03', '--no-people'])
  assert.equal(anonymous.code, 0, anonymous.stderr)
  const unnamed = await readFile(JSON.parse(anonymous.stdout).file, 'utf8')
  assert.doesNotMatch(unnamed, /ana@example\.test/)
})

test('says which permission the report needs when the token lacks it', async (t) => {
  const { server, url } = await serve((req, res) => {
    res.setHeader('content-type', 'application/json')
    if (req.url === '/v1/me') {
      res.end(JSON.stringify({ tenants: [{ id: 'acme', name: 'Acme' }] }))
      return
    }
    res.statusCode = 403
    res.end(JSON.stringify({ error: { code: 'forbidden', message: 'this token lacks "nsolid:audit-log" on tenant "acme"' } }))
  })
  const dir = await mkdtemp(path.join(os.tmpdir(), 'activity-report-'))
  t.after(async () => {
    server.close()
    await rm(dir, { recursive: true, force: true })
  })
  const out = await run(dir, { NSOLID_API_URL: url, NSOLID_API_TOKEN: 'skt_test' }, [])
  assert.equal(out.code, 1)
  assert.match(out.stderr, /lacks "nsolid:audit-log".*needs the Audit log permission, which tenant admins hold/)
})
