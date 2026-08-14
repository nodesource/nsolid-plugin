---
name: ns-analyze-tracing
description: >-
  Analyzes N|Solid/OpenTelemetry tracing evidence for request latency, HTTP errors, and service dependencies. Use when the user asks about slow endpoints, API timeouts, distributed traces/spans, N+1 queries, await chains, microservice latency, cascading failures, or trace IDs. Query N|Solid only when no trace data was provided. Do not assume full waterfall details unless supplied.
---

### 1. Use Provided Trace Data First
- Treat the prompt as primary evidence. Parse any provided trace ID, span list, app name, endpoint name, status code, duration, or error stack before calling tools.
- If the user supplied a trace tree/export or any other host-provided trace data, treat it as authoritative: map that hierarchy directly and **do not fall through to live enrichment** (`information-dashboard`, `tracing`). The connected-services discovery (step 2) and live `tracing` queries (steps 3–4) are only for when no sufficient host data is present.
- If the user supplied only a trace ID (not a full tree), call `tracing` with `span_traceId` for list-level rows only; the MCP tool does not expose full waterfall details.

### 2. Discover Connected Services Only When Needed
- **Skip this step entirely if sufficient host-provided trace data is present** (step 1 already authoritatively covered it).
- Call `information-dashboard` (no parameters) to list all connected agents and their `app` names and `id` values.
- If the user mentions a specific service or app name, use that directly and skip this step.
- Use `serverless-functions` instead if the user is asking about a serverless function.
- Skip this step when the supplied trace data already identifies the relevant service.

### 3. Find Slow Requests Only If No Trace Was Supplied
- Call `tracing`. Use pipe duration syntax (e.g., `durations="1000|5000"` for 1–5s spans); do not use dash-range syntax.
- Use `functionName` only when the exact server-side function name is known.
- Treat the response as a paginated, trace-ID-collapsed sample. The default page contains 25 traces, and the summary represents only the returned page; do not treat an absent app group as proof that the app has no tracing.

### 4. Find Failing Endpoints Only If No Trace Was Supplied
- Call `tracing` with `span_attributes_http_status_code` (e.g., `500`) to filter for HTTP errors.

### 5. Reconcile App Coverage Before Claiming Absence
- **Skip this step entirely if sufficient host-provided trace data is present** (step 1 already authoritatively covered it); reconciliation only applies to live `tracing` evidence.
- Build the expected app set from `information-dashboard` when it was called. Otherwise, use the authoritative app or service named by the user or identified by supplied trace data.
- Compare the expected app names with the app groups in the `tracing` summary or the `app` values in raw tracing rows. Ignore tracing metadata when building the represented-app set.
- Treat `⚠️ Partial tracing summary` as incomplete evidence. If any expected app is absent from the current global page, do not conclude that it lacks tracing.
- Re-query `tracing` once for each absent expected app, using the exact app name and preserving the original time range and filters (`durations`, status code, endpoint, and other applicable filters). Use the app-specific result to determine whether that app has matching traces.
- Only report that an expected app has no tracing after its app-specific query returns no matching traces. If that query is also partial, or reports matching traces through `metadata.total`, report the tracing evidence and its incomplete coverage instead of claiming absence.
- Do not auto-page every global tracing result. These bounded app-specific checks are the fallback for reconciling the known app inventory.

### 6. Triage the Trace
- Use `tracing` results as collapsed trace-list evidence: slow/failing service, endpoint, status, duration, and `span_traceId`.
- Do not claim parent/child waterfall analysis from `tracing` alone; `tracing-detail` is not exposed as MCP.
- If the user supplied the full trace tree/export, analyze `span_parentId` vs child hierarchy directly.

### 7. Propose Architectural Fixes
- Once you identify a bottleneck trace row or supplied trace tree, explain the strongest supported cause.
- Only discuss parent-child span relationships when the trace tree was supplied.
- Propose topological changes like adding Redis caching, parallelizing independent `Promise.all` requests, or using message queues.

### 8. Present a Report
- Emit the analysis directly in chat as markdown:
  - `# Tracing Analysis — <service/app/endpoint>`
  - `## Summary`
  - `## Evidence`
  - `## Findings`
  - `## Recommendations`
  - `## Validation Plan` when a fix is proposed
- Ground every claim in supplied trace data or MCP `tracing` output. State when only collapsed trace-list evidence is available.

### 9. Write the Report to Disk
- Ask the user if they want to save the report to disk.
- If the user confirms, write the final report as a markdown file (`.md`) under `.nsolid/assets/` — for example `.nsolid/assets/tracing-analysis-<appName-or-endpoint>.md`.

### 10. Validate (only if the user deployed a fix)
- If the user deployed one of the proposed fixes, re-run `tracing` with the same `durations` filter used in step 3 on the affected endpoint.
- Compare the post-deployment span duration against the pre-fix baseline you recorded. State the delta explicitly (e.g. "p95 dropped from 1200ms to 80ms").
- Do not run this step unless the user reports a deployment — it is not a background check.

## Guardrails
- NEVER call `global-filter` for service discovery — it returns ~18,000 tokens and fills the context window. Use `information-dashboard` only.
- Do not search randomly; always filter using `durations` or status codes first to narrow down the dataset.
- A slow top-level span may be caused by a slow child span, but only assert that when full trace hierarchy is available.
- Filter out expected long-polling or WebSocket connections when hunting for latency regressions.
