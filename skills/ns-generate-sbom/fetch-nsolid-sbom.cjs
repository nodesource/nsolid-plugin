#!/usr/bin/env node

// fetch-nsolid-sbom.cjs — Saves an app's runtime SBOM from N|Solid (or one
// process's) to .nsolid/sbom/: the CycloneDX 1.6 document N|Solid builds from what
// the processes installed and loaded, and with --html a page to read it in.
//
// Usage:
//   node fetch-nsolid-sbom.cjs <appName> [--agent <agentId>] [--html]
//
// Needs the N|Solid API URL and a token (see nsolid-api.cjs). Prints a short JSON
// summary; the document itself goes to the file, never to the agent's context.

'use strict'

const fs = require('fs')
const path = require('path')
const { createClient, slug } = require('./nsolid-api.cjs')

const SEVERITIES = ['critical', 'high', 'medium', 'low', 'info', 'unrated']

function parseArgs (argv) {
  const args = { app: undefined, agent: undefined, html: false }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--html') args.html = true
    else if (a === '--agent') args.agent = argv[++i]
    else if (!a.startsWith('--') && !args.app) args.app = a
    else throw new Error(`unknown argument: ${a}`)
  }
  if (!args.app) throw new Error('usage: node fetch-nsolid-sbom.cjs <appName> [--agent <agentId>] [--html]')
  if (args.agent !== undefined && !/^[0-9a-f]{8,64}$/i.test(args.agent)) {
    throw new Error(`not an agent id: ${args.agent}`)
  }
  return args
}

function property (component, name) {
  return component.properties?.find((p) => p.name === name)?.value
}

function packageName (component) {
  return component.group ? `${component.group}/${component.name}` : component.name
}

function severityOf (vuln) {
  const s = vuln.ratings?.[0]?.severity
  return SEVERITIES.includes(s) ? s : 'unrated'
}

// "qs@6.11.0|/app/node_modules/qs" names the installed copy; its first part is enough here.
function affected (vuln) {
  return [...new Set((vuln.affects ?? []).map((a) => String(a.ref).split('|')[0]))]
}

function summarize (bom) {
  const components = bom.components ?? []
  const versions = new Map()
  for (const c of components) {
    const name = packageName(c)
    if (!versions.has(name)) versions.set(name, new Set())
    versions.get(name).add(c.version)
  }
  const bySeverity = {}
  for (const v of bom.vulnerabilities ?? []) {
    const s = severityOf(v)
    bySeverity[s] = (bySeverity[s] ?? 0) + 1
  }
  return {
    subject: property(bom.metadata ?? {}, 'nsolid:subject') ?? bom.metadata?.component?.name,
    components: components.length,
    loaded: components.filter((c) => property(c, 'nsolid:loaded') === 'true').length,
    packagesAtSeveralVersions: [...versions.values()].filter((v) => v.size > 1).length,
    vulnerabilities: (bom.vulnerabilities ?? []).length,
    bySeverity
  }
}

function escape (value) {
  return String(value ?? '').replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch])
}

function renderHtml (bom, app, summary) {
  const vulns = [...(bom.vulnerabilities ?? [])].sort((a, b) => SEVERITIES.indexOf(severityOf(a)) - SEVERITIES.indexOf(severityOf(b)))
  const components = [...(bom.components ?? [])].sort((a, b) => packageName(a).localeCompare(packageName(b)) || String(a.version).localeCompare(String(b.version)))
  const counts = SEVERITIES.filter((s) => summary.bySeverity[s]).map((s) => `${summary.bySeverity[s]} ${s}`).join(', ')
  const vulnRows = vulns.map((v) => `<tr><td><a href="${escape(v.source?.url)}">${escape(v.id)}</a></td><td class="sev ${severityOf(v)}">${severityOf(v)}</td><td>${affected(v).map(escape).join('<br>')}</td><td>${escape(v.description)}${v.recommendation ? `<div class="fix">${escape(v.recommendation)}</div>` : ''}</td></tr>`).join('\n')
  const componentRows = components.map((c) => `<tr><td>${escape(packageName(c))}</td><td>${escape(c.version)}</td><td>${property(c, 'nsolid:loaded') === 'true' ? 'yes' : 'no'}</td><td class="path">${escape(property(c, 'nsolid:path'))}</td></tr>`).join('\n')
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Runtime SBOM: ${escape(app)}</title>
<style>
  :root { color-scheme: light dark; --fg: #1d2421; --muted: #5d6964; --line: #d5dcd9; --bg: #ffffff; }
  @media (prefers-color-scheme: dark) { :root { --fg: #e2e8e5; --muted: #9aa7a1; --line: #303a36; --bg: #141a18; } }
  body { margin: 0; padding: 32px 24px; background: var(--bg); color: var(--fg); font: 15px/1.5 system-ui, sans-serif; }
  main { max-width: 1200px; margin: 0 auto; }
  h1 { margin: 0 0 6px; font-size: 26px; }
  h2 { margin: 32px 0 10px; font-size: 19px; }
  .meta { margin: 0; color: var(--muted); }
  .stats { display: flex; flex-wrap: wrap; gap: 8px 24px; margin: 16px 0 0; padding: 0; list-style: none; }
  .stats b { font-size: 20px; margin-right: 4px; }
  .wrap { overflow-x: auto; border: 1px solid var(--line); border-radius: 6px; }
  table { border-collapse: collapse; width: 100%; font-size: 14px; }
  th, td { text-align: left; vertical-align: top; padding: 7px 10px; border-bottom: 1px solid var(--line); }
  th { color: var(--muted); font-weight: 600; font-size: 12px; text-transform: uppercase; letter-spacing: 0.04em; }
  .path { font-family: ui-monospace, Menlo, Consolas, monospace; font-size: 12px; color: var(--muted); }
  .fix { margin-top: 4px; color: var(--muted); }
  .sev { font-weight: 600; white-space: nowrap; }
  .sev.critical, .sev.high { color: #c0392b; }
  .sev.medium { color: #b7791f; }
  a { color: inherit; }
</style>
</head>
<body>
<main>
<h1>Runtime SBOM: ${escape(app)}</h1>
<p class="meta">${escape(summary.subject ?? app)} · built by the N|Solid Console ${escape(bom.metadata?.timestamp)} · CycloneDX ${escape(bom.specVersion)} · what the processes installed and loaded, not the project's lockfile</p>
<ul class="stats">
  <li><b>${summary.components}</b>packages installed</li>
  <li><b>${summary.loaded}</b>loaded</li>
  <li><b>${summary.packagesAtSeveralVersions}</b>at several versions</li>
  <li><b>${summary.vulnerabilities}</b>advisories${counts ? ` (${escape(counts)})` : ''}</li>
</ul>
<h2>Advisories</h2>
${vulns.length ? `<div class="wrap"><table><thead><tr><th>Advisory</th><th>Severity</th><th>Affects</th><th>What and how to fix</th></tr></thead><tbody>\n${vulnRows}\n</tbody></table></div>` : '<p class="meta">None matched.</p>'}
<h2>Packages</h2>
<div class="wrap"><table><thead><tr><th>Package</th><th>Version</th><th>Loaded</th><th>Installed at</th></tr></thead><tbody>
${componentRows}
</tbody></table></div>
</main>
</body>
</html>
`
}

async function main () {
  const args = parseArgs(process.argv.slice(2))
  const api = createClient()
  const tenant = encodeURIComponent(await api.tenant())
  const pathname = args.agent
    ? `/v1/tenants/${tenant}/agents/${args.agent}/sbom`
    : `/v1/tenants/${tenant}/apps/${encodeURIComponent(args.app)}/sbom`
  const bom = await api.get(pathname)
  const dir = path.join(process.cwd(), '.nsolid', 'sbom')
  fs.mkdirSync(dir, { recursive: true })
  const base = args.agent ? `${slug(args.app)}-${args.agent.slice(0, 8)}_sbom` : `${slug(args.app)}_sbom`
  const file = path.join(dir, `${base}.cdx.json`)
  fs.writeFileSync(file, `${JSON.stringify(bom, null, 2)}\n`, 'utf8')
  const summary = summarize(bom)
  let htmlFile
  if (args.html) {
    htmlFile = path.join(dir, `${base}.html`)
    fs.writeFileSync(htmlFile, renderHtml(bom, args.app, summary), 'utf8')
  }
  console.log(JSON.stringify({ file, htmlFile, ...summary }, null, 2))
}

if (require.main === module) {
  main().catch((err) => {
    console.error(`Error: ${err.message}`)
    process.exit(1)
  })
}

module.exports = { summarize, renderHtml, parseArgs }
