---
name: ns-fleet-health
description: >-
  Gives a health check of the Node.js processes N|Solid watches: what is hot or growing, what is crashing or blocking its event loop, what is alerting, and new vulnerabilities, risky Node.js versions and suspicious dependency behavior. Use when the user asks how production (or an app) is doing, what needs attention, for a daily or weekly briefing, or to find processes matching a condition such as "high memory on Node 20".
---

This skill reads N|Solid through its MCP server (`nsolid`). The N|Solid tools take a `tenant`: when the token can use one tenant it is the default; otherwise call `list_tenants` once and check each tenant the user cares about (production and staging are usually separate tenants).

### 1. Scope
- The whole tenant by default, or the app the user names. `list_apps` lists the apps with their processes by status and the app, N|Solid and Node.js versions in use.

### 2. Gather the Picture
Run what fits the question; for a full briefing, all of it:
- **Hot processes:** `fleet_snapshot` with `sort: "cpu_percent"`, then `sort: "used_heap_size"` and `sort: "loop_estimated_lag"` (limit 5 each; add `where: 'app == "<app>"'` for one app). Note anything far from its peers.
- **Growing memory:** `query_metric` with `metric: "used_heap_size"`, `groupBy: "app"` and `from: "-24h"`: a series that only climbs needs a look (`ns-memory-spike-analysis`).
- **Latency:** `query_metric` with `metric: "http_server"` (the p99) and `groupBy: "app"`.
- **Crashes and restarts:** `list_ended_processes` with `byApp: true` and `from: "-24h"`: how many processes of each app ended and how the latest did. `event_stacks` with `type: "exit"` groups exits by error.
- **Blocked event loops:** `event_stacks` (default `loop_blocked`) over the last day: where loops blocked, how often and how long.
- **Alerts:** `list_alerts` with `state: "firing"`.
- **Vulnerabilities:** `list_vulnerabilities` with `severity: "high"` (and `where: 'evidence >= "loaded"'` for the ones whose code is in use); malicious packages first.
- **Node.js runtimes:** `list_runtimes`: versions at or near end of life, and core advisories with the release that fixes them.
- **New behaviors:** `list_behaviors`: dependencies doing something new, release regressions and drift.
- **Agent credentials** (admins, on request): the web UI's Connect agents page, or `GET /v1/tenants/<tenant>/ingest-tokens`, shows ingest tokens due for rotation (`rotationDueAt`) and rotated ones still in use; rotation is covered in `ns-configure-agents`.
- **How the team uses N|Solid** (admins, on request): the web UI's Activity page, or `GET /v1/tenants/<tenant>/activity?by=area|tool|clientName|person`, shows which features, pages and AI assistants and tools people use. It is off where N|Solid hasn't enabled it for the tenant.
- **Custom conditions:** `fleet_snapshot` takes an expression mixing metrics and what a process is, e.g. `rss > 1GiB && nodeVersion < "22"`, `cpu_percent > 80 && "canary" in tags`. `expression_help` with context `fleet` lists the fields. `save_view` keeps a useful expression under a name for people and tools (with the user's agreement).

### 3. Prioritize
- Order by impact: crashes and firing critical alerts, then malicious or loaded high-severity vulnerabilities and end-of-life runtimes, then resource and latency outliers, then the rest.
- Say plainly when everything looks fine.

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
- Read only: this skill changes nothing. Captures, acknowledgements and configuration changes belong to the follow-up skills, with the user's agreement.
- Keep tool calls bounded: small limits, the last day by default.
