---
name: ns-analyze-tracing
description: >-
  Analyzes N|Solid/OpenTelemetry tracing evidence for request latency, HTTP errors, and service dependencies. Use when the user asks about slow endpoints, API timeouts, distributed traces/spans, N+1 queries, await chains, microservice latency, cascading failures, or trace IDs. Query N|Solid only when no trace data was provided. Do not assume full waterfall details unless supplied.
---

### 1. Use Provided Trace Data First
- Treat the prompt as primary evidence. Parse any provided trace ID, span list, app name, endpoint name, status code, duration, or error stack before calling tools.
- If the user supplied a trace tree/export, map that hierarchy directly.
- If the user supplied only a trace ID, call `tracing` with `span_traceId` for list-level rows only; the MCP tool does not expose full waterfall details.

### 2. Discover Connected Services Only When Needed
- Call `information-dashboard` (no parameters) to list all connected agents and their `app` names and `id` values.
- If the user mentions a specific service or app name, use that directly and skip this step.
- Use `serverless-functions` instead if the user is asking about a serverless function.
- Skip this step when the supplied trace data already identifies the relevant service.

### 3. Find Slow Requests Only If No Trace Was Supplied
- Call `tracing`. Use pipe duration syntax (e.g., `durations="1000|5000"` for 1–5s spans); do not use dash-range syntax.
- Use `functionName` only when the exact server-side function name is known.

### 4. Find Failing Endpoints Only If No Trace Was Supplied
- Call `tracing` with `span_attributes_http_status_code` (e.g., `500`) to filter for HTTP errors.

### 5. Triage the Trace
- Use `tracing` results as collapsed trace-list evidence: slow/failing service, endpoint, status, duration, and `span_traceId`.
- Do not claim parent/child waterfall analysis from `tracing` alone; `tracing-detail` is not exposed as MCP.
- If the user supplied the full trace tree/export, analyze `span_parentId` vs child hierarchy directly.

### 6. Propose Architectural Fixes
- Once you identify a bottleneck trace row or supplied trace tree, explain the strongest supported cause.
- Only discuss parent-child span relationships when the trace tree was supplied.
- Propose topological changes like adding Redis caching, parallelizing independent `Promise.all` requests, or using message queues.

### 7. Present a Report
- Emit the analysis directly in chat as markdown:
  - `# Tracing Analysis — <service/app/endpoint>`
  - `## Summary`
  - `## Evidence`
  - `## Findings`
  - `## Recommendations`
  - `## Validation Plan` when a fix is proposed
- Ground every claim in supplied trace data or MCP `tracing` output. State when only collapsed trace-list evidence is available.

### 8. Write the Report to Disk
- Ask the user if they want to save the report to disk.
- If the user confirms, write the final report as a markdown file (`.md`) under `.nsolid/assets/` — for example `.nsolid/assets/tracing-analysis-<appName-or-endpoint>.md`.

### 9. Validate (only if the user deployed a fix)
- If the user deployed one of the proposed fixes, re-run `tracing` with the same `durations` filter used in step 3 on the affected endpoint.
- Compare the post-deployment span duration against the pre-fix baseline you recorded. State the delta explicitly (e.g. "p95 dropped from 1200ms to 80ms").
- Do not run this step unless the user reports a deployment — it is not a background check.

## Guardrails
- NEVER call `global-filter` for service discovery — it returns ~18,000 tokens and fills the context window. Use `information-dashboard` only.
- Do not search randomly; always filter using `durations` or status codes first to narrow down the dataset.
- A slow top-level span may be caused by a slow child span, but only assert that when full trace hierarchy is available.
- Filter out expected long-polling or WebSocket connections when hunting for latency regressions.
