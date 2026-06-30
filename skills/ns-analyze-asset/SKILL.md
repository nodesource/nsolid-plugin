---
name: ns-analyze-asset
description: >-
  Analyzes an existing N|Solid diagnostic asset by asset ID or local asset path using asset-summary. Use when the user asks to inspect, review, summarize, or interpret an already-captured CPU profile, heap profile, heap sample, or heap snapshot, including assets just produced by ns-generate-asset. Do not use to capture new profiles/snapshots.
---

## Instructions

### 1. Identify the Asset
- The user should provide an asset ID or an app name with asset type.
- Preserve the app name from the user, `assets`, or `information-dashboard`; `asset-summary` does not include it.
- If the user only gives an app name and asset type, call `assets` with filters and ask the user which asset to inspect.

### 2. Get the Best Available Summary

#### CPU profiles and heap sampling assets
- Prefer `asset-summary` first when you have an asset ID. These asset types return immediately.

#### Heap snapshots (async summarization)
Heap snapshot summarization is asynchronous and may not be ready on the first call. Use this retry loop:

1. Call `asset-summary` with the asset ID.
2. If the response body contains `"pending"`, `"processing"`, `"summarization started"`, `"async"`, or a reference to `"assets-in-progress"`, the snapshot is still being summarized — do NOT analyze it yet.
3. Call `assets-in-progress` to check the queue position.
4. Run the wait script (use the absolute path of the directory where you read this SKILL.md):
   ```
   node "<skill-dir>/wait.cjs" 5
   ```
   before retrying.
5. Call `asset-summary` again on the same asset ID.
6. Repeat steps 3–5 up to **12 times** before giving up.
7. If still not ready after 12 retries, report that clearly instead of analyzing a stale or empty summary.

**Never analyze a heap snapshot summary that is still marked as processing.**

#### No asset ID
- If the user gives a local `.cpuprofile`, `.heapprofile`, or `.heapsnapshot` path instead of an asset ID, prefer resolving the full asset ID from `.nsolid/assets/index.json`. The flat filename pattern `.nsolid/assets/<assetType>-<appName>-<assetIdPrefix>.<ext>` produced by `fetch-asset.cjs` carries only an 8-character asset ID **prefix** (not the full ID), so it is not sufficient on its own.
- **Never read the raw asset file into context** — it is large and token-wasteful. Always go through the token-optimized `asset-summary`.
- If `index.json` is missing and MCP is unavailable, tell the user the full asset ID cannot be recovered (only the filename prefix is known) and stop.

### 3. Analyze by Asset Type

#### CPU Profile
- Find the functions with the highest `totalTime` and `selfTime`.
- Explain the hot path and the most expensive bottleneck.
- Focus on user-owned code. If the top cost is in Node internals or `node_modules`, explain the nearest relevant user-owned caller instead.

#### Heap Profile or Heap Sample
- Identify top allocating constructors by self size and retained size.
- Call out suspicious allocation patterns (e.g. unusually large arrays, many short-lived objects of the same type).

#### Heap Snapshot
Inspect the summary for these signals:

**Top retained-size objects** — list the largest objects by retained size. Explain what type they are and why they are still reachable.

**Dominator chains** — identify the shortest path from GC roots to the largest retained objects. Explain what is holding references.

**Retainer paths** — for the top retained objects, trace back to the closest named user-owned code (module, function, or variable name).

**Common leak patterns to flag:**
- Closures holding references to large outer scopes that outlive their use.
- `EventEmitter` listeners added but never removed (`removeListener` / `off` missing).
- Unbounded `Map`, `Set`, or plain object caches that grow without eviction.
- Promise chains retaining intermediate values after resolution.
- `setInterval` or `setTimeout` callbacks capturing large context.
- Detached DOM-like structures in server-side rendering code.
- Large `Buffer` or `TypedArray` allocations held by long-lived objects.
- Interned string tables or template literal accumulation.

**Confirm leak vs one-off spike:**
- Call `metrics-historic` with `field: ["heapUsed", "heapTotal", "rss"]`, `q: "app=<appName>"` or `q: "id=<id>"`, and `start`/`end` around the snapshot time.
- Check `events-historic` with the same `app` or agent `id`, plus `start`/`end`, for near-OOM or process-blocked events at the snapshot time.

**Follow-up recommendation:**
- If allocation stack traces are insufficient, recommend advanced `track-heap-objects` via `ns-advanced-memory-leak-hunter`.
- For deeper leak hunting workflows, reference the `ns-advanced-memory-leak-hunter` skill.

### 4. Correlate with Runtime Context
- If MCP is available, call `information-dashboard` to confirm the app, agent, hostname, and whether the originating process still exists.
- Call `metrics-historic` around the asset time with explicit `field` values and `q: "app=<appName>"` or `q: "id=<id>"`.

### 5. Extract Runtime Code for CPU Bottlenecks
- Only do this for CPU profiles and only if MCP is available.
- After identifying the hottest user-owned frame, offer `runtime-code` only when you have agent `id`, `threadId`, `scriptId`, and `url`/`path`.
- Do not call `runtime-code` when `scriptId` is `0`.
- Retry up to 2 times with path adjustments if the first call fails (strip leading `/app` or Docker prefix, or remove a path segment).

### 6. Keep the User in the Loop
- Present the key findings first.
- Ask whether the user wants an optimized solution before proposing code changes (CPU profiles only).

### 7. Present a Report
Emit the analysis directly in chat using this exact structure and formatting:

```markdown
# Asset Analysis — <asset label>

**Date**: <ISO date>
**Asset ID**: <asset id>
**Source**: asset-summary

## Analysis
<findings, observations, and next steps — start here directly without
 repeating the title, asset ID, or source label>
```

Rules:
- Start the `## Analysis` section directly with findings — no preamble.
- Do not repeat the title, asset ID, or source label inside the body.
- Do not wrap the final answer in triple backticks or any fenced code block.
- Do not invent sample counts, timings, function names, object names, or conclusions that are not present in the grounded input.
- If the grounded input is insufficient for a claim, say that plainly.

### 8. Write the Report to Disk
- Ask the user if they want to save the report to disk.
- If the user confirms, write the final report as a markdown file (`.md`) under `.nsolid/assets/` — for example `.nsolid/assets/asset-analysis-<asset id>.md`.

### 9. Offer Next Steps
- For CPU profiles, offer to propose code changes for the hottest user-owned function.
- Ask the users if they want to download the asset, if they confirm download, save it locally:
   ```
   node "<skill-dir>/fetch-asset.cjs" <assetId> <assetType> <appName>
   ```
  AssetType is one of: `cpuprofile`, `heapprofile`, or `heapsnapshot`; heap sampling assets use `heapprofile`.

## Guardrails
- Never analyze a heap snapshot that is still marked as processing or pending. Poll and wait until `asset-summary` returns the actual summarized content.
- Do not lie about findings. If the asset summary lacks detail, say so explicitly.
