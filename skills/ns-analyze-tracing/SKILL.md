---
name: ns-analyze-tracing
description: >-
  Analyzes N|Solid/OpenTelemetry tracing evidence for request latency, HTTP errors, and service dependencies. Use when the user asks about slow endpoints, API timeouts, distributed traces/spans, N+1 queries, await chains, microservice latency, cascading failures, or trace IDs. Query N|Solid only when no trace data was provided. Builds the span waterfall with `tracing-detail` when the console offers it.
---

### 1. Use Provided Trace Data First
- Treat the prompt as primary evidence. Parse any provided trace ID, span list, app name, endpoint name, status code, duration, or error stack before calling tools.
- If the user supplied a trace tree/export or any other host-provided trace data, treat it as authoritative: map that hierarchy directly and **do not fall through to live enrichment** (`information-dashboard`, `tracing`, `tracing-detail`), even when the export includes its trace ID. The connected-services discovery (step 2) and live `tracing` queries (steps 3–4) are only for when no sufficient host data is present.
- If the user supplied only a trace ID (not a full tree), call `tracing-detail` with `span_traceId` and `showLimit: 1000` to get the whole trace in one call. If the metadata's `totalSpans` is larger, call once more with `showLimit` at least `totalSpans` (at most 10000). Don't page with `page`: the spans come back in no fixed order, so pages can repeat or skip spans. Do not call `tracing` with `span_traceId`: it ignores that filter and returns the default page.
- If `tracing-detail` is not among the available tools (consoles before 6.5.2), returns an error (such as `elasticReader is not available`), or returns no spans (`totalSpans: 0`: the trace aged out or the ID is wrong), say the trace could not be read and ask the user for the trace data or a different trace ID.

### 2. Discover Connected Services Only When Needed
- **Skip this step entirely if sufficient host-provided trace data is present** (step 1 already authoritatively covered it).
- Call `information-dashboard` (no parameters) to list all connected agents and their `app` names and `id` values.
- If the user mentions a specific service or app name, use that directly and skip this step.
- Use `serverless-functions` instead if the user is asking about a serverless function.
- Skip this step when the supplied trace data already identifies the relevant service.

### 3. Find Slow Requests Only If No Trace Was Supplied
- Call `tracing`. Use pipe duration syntax (e.g., `durations="1000|5000"` for 1–5s spans); do not use dash-range syntax.
- Use `functionName` only when the exact server-side function name is known.
- `tracing` works in whole hours. It rounds `start` down to the hour, even an exact ISO time, and without `start` it covers the last 23–24 hours (from 23 hours ago, rounded down). Its MCP response is always summarized per app (minimum, maximum, median, latest), so it can't be narrowed to a shorter window afterwards, and `metadata.total` counts the traces of the whole rounded window. For recent behavior, pass `start` at the current hour. Report the window the evidence covers, from `metadata.start` and `metadata.end`, and don't present a day of data as current.
- Treat the response as a paginated, trace-ID-collapsed sample. The default page contains 25 traces, and the summary represents only the returned page; do not treat an absent app group as proof that the app has no tracing.

### 4. Find Failing Endpoints Only If No Trace Was Supplied
- Call `tracing` with `span_attributes_http_status_code` (e.g., `500`) to filter for HTTP errors.

### 5. Reconcile App Coverage Before Claiming Absence
- **Skip this step entirely if sufficient host-provided trace data is present** (step 1 already authoritatively covered it); reconciliation only applies to live `tracing` evidence.
- Build the expected app set from `information-dashboard` when it was called. Otherwise, use the authoritative app or service named by the user or identified by supplied trace data.
- Compare the expected app names with the app groups in the `tracing` summary or the `app` values in raw tracing rows. Ignore tracing metadata when building the represented-app set.
- Treat `⚠️ Partial tracing summary` as incomplete evidence. If any expected app is absent from the current global page, do not conclude that it lacks tracing.
- Re-query `tracing` once for each absent expected app, using the exact app name and preserving the original time range and filters (`durations`, status code, endpoint, and other applicable filters). Use the app-specific result to determine whether that app has matching traces.
- If the app-specific query returns no matching traces, report only that the app has **no traces matching the requested filters and time range** — zero filtered rows do not prove the app has no tracing (e.g. an app with only 200 ms spans returns nothing under `durations="1000|5000"`).
- To claim an app has no tracing at all, run one additional query with only the exact app name and the original time range (no `durations`, status code, or endpoint filters). Only a non-partial empty result from this unfiltered query justifies the "no tracing" claim; if it returns traces, report that tracing exists but none matched the filters.
- If either app-specific query is partial, or reports matching traces through `metadata.total`, report the tracing evidence and its incomplete coverage instead of claiming absence. `metadata.total` covers the whole rounded window from step 3: it shows the app had matching traces in that window, not in a shorter one the user asked about.
- Do not auto-page every global tracing result. These bounded app-specific checks are the fallback for reconciling the known app inventory.

### 6. Triage the Trace
- Use `tracing` results as collapsed trace-list evidence: slow/failing service, endpoint, status, duration, and `span_traceId`.
- If no trace tree was supplied, call `tracing-detail` for the slow or failing trace's `span_traceId`, as in step 1 (one call, `showLimit` covering the whole trace). Sort the spans by `span_start` first: they come back in no fixed order, and response order is not execution order. Then build the parent/child waterfall from `span_id` and `span_parentId`: which child spans take the time, which fail, and which run one after another (one starts after the previous ends) when they could run in parallel.
- If `tracing-detail` is not among the available tools (consoles before 6.5.2), returns an error, or returns no spans, stay with the collapsed trace-list evidence and say that the waterfall was not available.
- If the user supplied the full trace tree/export, analyze `span_parentId` vs child hierarchy directly.

### 7. Propose Architectural Fixes
- Once you identify a bottleneck trace row or supplied trace tree, explain the strongest supported cause.
- Only discuss parent-child span relationships when the hierarchy came from `tracing-detail` or a supplied trace tree.
- Propose topological changes like adding Redis caching, parallelizing independent `Promise.all` requests, or using message queues.

### 8. Present a Report
- Emit the analysis directly in chat as markdown:
  - `# Tracing Analysis — <service/app/endpoint>`
  - `## Summary`
  - `## Evidence`
  - `## Findings`
  - `## Recommendations`
  - `## Validation Plan` when a fix is proposed
- Ground every claim in supplied trace data or MCP `tracing` and `tracing-detail` output. State when only collapsed trace-list evidence is available.

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
- A slow top-level span may be caused by a slow child span, but only assert that when the full hierarchy is available, from `tracing-detail` or a supplied trace tree.
- Never pass `span_traceId` to `tracing` to look up one trace; it ignores the filter. Use `tracing-detail`.
- Read `tracing-detail` spans in `span_start` order; the order they arrive in means nothing.
- Filter out expected long-polling or WebSocket connections when hunting for latency regressions.
