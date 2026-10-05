---
name: ns-analyze-tracing
description: >-
  Analyzes N|Solid/OpenTelemetry tracing evidence from N|Solid for request latency, HTTP errors, and service dependencies. Use when the user asks about slow endpoints, API timeouts, distributed traces/spans, N+1 queries, await chains, microservice latency, cascading failures, or trace IDs. Query N|Solid only when no trace data was provided.
---

This skill reads traces through the N|Solid MCP server (`nsolid`). The N|Solid tools take a `tenant`: when the token can use one tenant it is the default; otherwise call `list_tenants` once and use the tenant the user names.

### 1. Use Provided Trace Data First
- Treat the prompt as primary evidence. Parse any provided trace ID, span list, app name, endpoint name, status code, duration, or error stack before calling tools.
- If the user supplied a trace tree/export or any other host-provided trace data, treat it as authoritative: map that hierarchy directly and **do not fall through to live enrichment** (steps 2–5 are only for when no sufficient host data is present).
- If the user supplied only a trace ID, call `get_trace` with it: the services and who called whom (with counts, times from the caller's side, failures, and the databases, outside hosts and DNS they called), then every span as a tree with durations, services and errors.

### 2. Discover Services Only When Needed
- **Skip this step if sufficient host-provided trace data is present**, or when the user names the service or app.
- Call `list_apps` for the app names. A span's `service` is its app's name.
- The N|Solid server doesn't collect AWS Lambda functions; if the user asks about a serverless function, say so.

### 3. Find Slow Requests Only If No Trace Was Supplied
- Call `search_spans` with `rootOnly: true` (one span per request), `order: "slowest"`, the `service`, and `from`/`to` (default the last hour).
- Narrow by duration with `minDurationMs`, or a range with `where`, e.g. `duration > 1s && duration < 5s`. Narrow by endpoint with `where: 'name.startsWith("GET /api")'` or `name` (exact).
- `query_metric` with `metric: "http_server"` (the p99 by default) and `groupBy: "app"` shows how latency moved over time.

### 4. Find Failing Endpoints Only If No Trace Was Supplied
- Call `search_spans` with `where: 'attr["http.status_code"].startsWith("5")'` for HTTP server errors, or `status: "error"` for spans that recorded an error, with the `service` and time range.

### 5. Check Coverage Before Claiming Absence
- **Skip this step if sufficient host-provided trace data is present.**
- Spans exist only while an app's agents trace (`tracingEnabled`, in each agent's configuration from `get_agent`). Turning tracing on is a configuration change: suggest it, don't make it unasked.
- Zero spans under a filter don't prove an app has no tracing (an app whose requests take 200 ms returns nothing under `duration > 1s`). Before saying an app has no traces, query it alone (`service`) with the same time range and no other filters. Only an empty unfiltered result justifies "no tracing in this range"; if it returns spans, report that tracing exists but none matched the filters.

### 6. Triage the Trace
- Call `get_trace` with the slowest or failing request's `traceId`.
- The calls between services show where the time went from each caller's side, and which calls failed. The span tree shows parent and child spans: a slow parent with one slow child, sequential awaits that could run in parallel, the same query repeated (N+1), or a slow outside host.
- `search_logs` with the `traceId` gives the logs written during that request.

### 7. Propose Architectural Fixes
- Once you identify a bottleneck, explain the strongest supported cause.
- Propose topological changes like adding Redis caching, parallelizing independent `Promise.all` requests, batching repeated queries, or using message queues.

### 8. Present a Report
- Emit the analysis directly in chat as markdown:
  - `# Tracing Analysis — <service/app/endpoint>`
  - `## Summary`
  - `## Evidence`
  - `## Findings`
  - `## Recommendations`
  - `## Validation Plan` when a fix is proposed
- Ground every claim in supplied trace data or N|Solid's spans and traces.

### 9. Write the Report to Disk
- Ask the user if they want to save the report to disk.
- If the user confirms, write the final report as a markdown file (`.md`) under `.nsolid/assets/` — for example `.nsolid/assets/tracing-analysis-<appName-or-endpoint>.md`.

### 10. Validate (only if the user deployed a fix)
- If the user deployed one of the proposed fixes, re-run `search_spans` with the same filters used in step 3 on the affected endpoint, over a time range after the deployment.
- Compare the post-deployment durations against the pre-fix baseline you recorded. State the delta explicitly (e.g. "the slowest requests dropped from 1200 ms to 80 ms").
- Do not run this step unless the user reports a deployment — it is not a background check.

## Guardrails
- Do not search randomly; narrow with duration, status or the endpoint first.
- A slow top-level span may be caused by a slow child span: confirm it in the trace tree before asserting it.
- Filter out expected long-polling or WebSocket connections when hunting for latency regressions.
