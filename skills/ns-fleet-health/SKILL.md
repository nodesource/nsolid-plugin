---
name: ns-fleet-health
description: >-
  Gives a health check of the Node.js processes N|Solid watches: what is hot or growing, what is crashing or blocking its event loop, what is alerting, and new vulnerabilities, risky Node.js versions and suspicious dependency behavior. Use when the user asks how production (or an app) is doing, what needs attention, for a daily or weekly briefing, or to find processes matching a condition such as "high memory on Node 20".
---

This skill reads N|Solid through its MCP server (`nsolid`). Most N|Solid tools take a `tenant`: when the token can use one tenant it is the default; otherwise call `list_tenants` (it takes no `tenant`) once and check each tenant the user cares about (production and staging are usually separate tenants).

### 1. Scope
- The whole tenant by default, or the app the user names. `list_apps` with `limit: 50` lists the apps with their processes by status and the app, N|Solid and Node.js versions in use.

### Bounded Lists
- Read `total`, `returned`, `truncated`, `more`, `totalAtLeast`, `appsOmitted`, any `outputCut` notice and any cut notice in each content block before drawing conclusions. `more: true` means the entries are a sample, not the whole set; `totalAtLeast` is a lower bound, not a count. List results stay within 20,000 serialized UTF-8 bytes, so fewer entries may fit than the requested limit. An omitted app or process is not proof that it is absent or healthy; say when the briefing covers only part of the tenant.
- Narrow with arguments the tool takes. `list_apps` has no app filter or cursor; for a named app, use the app-scoped calls below. Full lists that cannot be narrowed through MCP need the Console or REST API. Cursor-paginated lists refuse an oversized page whole: retry the same request and cursor with a lower `limit`; if limit 1 still fails, read that record through REST.

### 2. Gather the Picture
Run what fits the question; for a full briefing, all of it:
- **Hot processes:** `fleet_snapshot` with `sort: "cpu_percent"`, then `sort: "used_heap_size"` and `sort: "loop_estimated_lag"` (limit 5 each; add `where: 'app == "<app>"'` for one app). Note anything far from its peers.
- **Growing memory:** `query_metric` with `metric: "used_heap_size"`, `groupBy: "app"` and `from: "-24h"`: a series that only climbs needs a look (`ns-memory-spike-analysis`).
- **Latency:** `query_metric` with `metric: "http_server"` (the p99) and `groupBy: "app"`.
- **Crashes and restarts:** `list_ended_processes` with `byApp: true`, `limit: 25` and `from: "-24h"`: how many processes of each app ended and how the latest did, lost ones (gone without an exit: killed, or the host lost) included. For one app, pass `app` without `byApp`; tenant-wide `byApp` refuses `app`, `host` and `ending`, so don't add filters to it. One app's list of ended processes is a sample, not a total: for the app's event totals over the whole window, use `event_histogram` filtered to that app with the same absolute `from` and `to`. `event_stacks` with `type: "exit"` groups exits by error; `event_histogram` with `types: ["exit", "lost"]` shows when they came.
- **Blocked event loops:** `event_stacks` (default `loop_blocked`) over the last day: where loops blocked, how often and how long.
- **Alerts:** `list_alerts` with `state: "firing"`. `list_alert_rules` shows each rule's `health`: a rule that is `no-data`, `failing` or `stale` protects nothing, so name it under Needs attention.
- **Vulnerabilities:** `list_vulnerabilities` with `severity: "high"` (and `where: 'evidence >= "loaded"'` for the ones whose code is in use); malicious packages first, then findings marked `knownExploited` (CISA lists them as exploited in the wild), whatever their severity: `where: "knownExploited"`. A result that fills its `limit` or carries a cut notice is partial. An app is clear only on complete evidence scoped to that app (`app`), and a ranking of apps needs complete results for every app it compares; current advisory data alone doesn't make an app clear.
- **Node.js runtimes:** `list_runtimes`: versions at or near end of life, and core advisories with the release that fixes them. Each version names at most 20 apps; `appsOmitted` counts the rest, and an `outputCut` notice can hide more. For one app's version, use `find_agents` with `where: 'app == "<app>"'`.
- **New behaviors:** `list_behaviors`: dependencies doing something new, release regressions and drift.
- **Agent credentials** (admins, on request): the web UI's Connect agents page, or `GET /v1/tenants/<tenant>/ingest-tokens`, shows ingest tokens due for rotation (`rotationDueAt`) and rotated ones still in use; rotation is covered in `ns-configure-agents`.
- **How the team uses N|Solid** (admins, on request): the web UI's Activity page, or `GET /v1/tenants/<tenant>/activity?by=area|tool|clientName|person`, shows which features, pages and AI assistants and tools people use; `ns-activity-report` writes it as a page to share. It is off where N|Solid hasn't enabled it for the tenant.
- **Custom conditions:** `fleet_snapshot` takes an expression mixing metrics and what a process is, e.g. `rss > 1GiB && nodeVersion < "22"`, `cpu_percent > 80 && "canary" in tags`. `expression_help` with context `fleet` lists the fields (it takes no `tenant`). `save_view` keeps a useful expression under a name for people and tools (with the user's agreement).

### 3. Prioritize
- Order by impact: crashes and firing critical alerts, then malicious or loaded high-severity vulnerabilities and end-of-life runtimes, then resource and latency outliers, then the rest.
- Say plainly when everything looks fine, and name any check whose results were partial.

### 4. Present the Briefing
- `# Fleet Health — <tenant or app> — <date>`
- `## Needs attention`: each item with its evidence and the skill to follow up with (`ns-cpu-spike-analysis`, `ns-memory-spike-analysis`, `ns-analyze-event`, `ns-analyze-vulnerabilities`, `ns-analyze-behaviors`, `ns-analyze-release`, `ns-node-upgrade`, `ns-manage-alerts`).
- `## Watching`: smaller signals.
- `## Healthy`: what was checked and found fine, briefly.
- Ground every claim in a tool's output, with the numbers.

### 5. Write the Briefing to Disk
- Ask the user if they want to save it.
- If the user confirms, write it as markdown under `.nsolid/reports/`, for example `.nsolid/reports/fleet-health-<date>.md`.

## Guardrails
- Read only, but for one thing: saving a useful expression as a view (`save_view`), and only with the user's agreement. Captures, acknowledgements and configuration changes belong to the follow-up skills, with the user's agreement.
- Keep tool calls bounded: small limits, the last day by default.
