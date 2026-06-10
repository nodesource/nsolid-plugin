---
name: ns-analyze-asset
description: >-
  Analyze an already-existing N|Solid asset from either an asset ID or a local
  downloaded file path. Prefer MCP asset-summary for token-efficient analysis,
  but fall back to the local file when MCP is unavailable. Supports CPU
  profiles, heap profiles, heap samples, and heap snapshots.
---

# NodeSource Asset Analysis

You are a NodeSource diagnostics engineer analyzing an asset the user already
has. Do not capture a new profile unless the user explicitly asks for that.

## Instructions

### 1. Identify the Asset
- The user should provide an asset ID, a local file path, or both.
- If only a local file path is provided (no asset ID), proceed directly to
  step 2 using the local file.
- If the user only gives an app name or asset type, call `assets` with filters
  and ask the user which asset to inspect.
- Record the asset ID (or `unavailable`), local file path (or `unavailable`),
  app name, and likely asset type.

### 2. Get the Best Available Summary

#### CPU profiles and heap sampling assets
- Prefer `asset-summary` first when you have an asset ID. These asset types
  return immediately.
- If MCP is unavailable or `asset-summary` fails, read the local file and use
  that content as analysis input.

#### Heap snapshots (async summarization)
Heap snapshot summarization is asynchronous and may not be ready on the first
call. Use this retry loop:

1. Call `asset-summary` with the asset ID.
2. If the response body contains `"processing"`, `"summarization started"`,
   or a reference to `"assets-in-progress"`, the snapshot is still being
   summarized — do NOT analyze it yet.
3. Call `assets-in-progress` to check the queue position.
4. If `nsolid_wait` is available, call it with `{ "seconds": 5 }`. Otherwise
   run:
   ```
   node "<skill-dir>/wait.cjs" 5
   ```
   before retrying.
5. Call `asset-summary` again on the same asset ID.
6. Repeat steps 3–5 up to **12 times** before giving up.
7. If still not ready after 12 retries, report that clearly instead of
   analyzing a stale or empty summary.

**Never analyze a heap snapshot summary that is still marked as processing.**

#### Local file only (no asset ID)
- Read the local file directly and use it as the grounded input.
- Accept `.cpuprofile`, `.heapprofile`, `.heapsampling`, `.heapsnapshot`,
  and raw `.json` files.
- If the file is unreadable and MCP is unavailable, state that clearly and stop.

### 3. Analyze by Asset Type

#### CPU Profile
- Find the functions with the highest `totalTime` and `selfTime`.
- Explain the hot path and the most expensive bottleneck.
- Focus on user-owned code. If the top cost is in Node internals or
  `node_modules`, explain the nearest relevant user-owned caller instead.

#### Heap Profile or Heap Sample
- Identify top allocating constructors by self size and retained size.
- Call out suspicious allocation patterns (e.g. unusually large arrays,
  many short-lived objects of the same type).

#### Heap Snapshot
Inspect the summary for these signals:

**Top retained-size objects** — list the largest objects by retained size.
Explain what type they are and why they are still reachable.

**Dominator chains** — identify the shortest path from GC roots to the
largest retained objects. Explain what is holding references.

**Retainer paths** — for the top retained objects, trace back to the closest
named user-owned code (module, function, or variable name).

**Common leak patterns to flag:**
- Closures holding references to large outer scopes that outlive their use.
- `EventEmitter` listeners added but never removed (`removeListener` /
  `off` missing).
- Unbounded `Map`, `Set`, or plain object caches that grow without eviction.
- Promise chains retaining intermediate values after resolution.
- `setInterval` or `setTimeout` callbacks capturing large context.
- Detached DOM-like structures in server-side rendering code.
- Large `Buffer` or `TypedArray` allocations held by long-lived objects.
- Interned string tables or template literal accumulation.

**Confirm leak vs one-off spike:**
- Call `metrics-historic` for `heapUsed`, `heapTotal`, and `rss` around
  the snapshot time to see whether heap was trending upward before the
  snapshot was taken.
- Check `events-historic` for near-OOM alerts or process-blocked events
  that coincide with the snapshot time.

**Follow-up recommendation:**
- If the snapshot provides insufficient allocation stack traces, recommend
  `track-heap-objects` to capture allocation origins with low overhead.
- For deeper leak hunting workflows, reference the
  `ns-advanced-memory-leak-hunter` skill.

### 4. Correlate with Runtime Context
- If MCP is available, call `information-dashboard` to confirm the app, agent,
  hostname, and whether the originating process still exists.
- Call `metrics-historic` around the asset time to correlate CPU, heap, or
  event-loop behavior with the findings.

### 5. Extract Runtime Code for CPU Bottlenecks
- Only do this for CPU profiles and only if MCP is available.
- After identifying the hottest user-owned frame (function name, `scriptId`,
  `url`), offer to call `runtime-code`.
- Do not call `runtime-code` when `scriptId` is `0`.
- Retry up to 2 times with path adjustments if the first call fails
  (strip leading `/app` or Docker prefix, or remove a path segment).

### 6. Keep the User in the Loop
- Present the key findings first.
- Ask whether the user wants an optimized solution before proposing code
  changes (CPU profiles only).

### 7. Write a Report
Emit the analysis directly in chat using this exact structure so the host
extension can locate and persist it:

```markdown
# Asset Analysis — <asset label>

**Date**: <ISO date>
**Asset ID**: <asset id or unavailable>
**Local File**: <path or unavailable>
**Source**: <MCP asset-summary | local file>

## Analysis
<findings, observations, and next steps — start here directly without
 repeating the title, asset ID, local file path, or source label>
```

Rules:
- Start the `## Analysis` section directly with findings — no preamble.
- Do not repeat the title, asset ID, local file, or source label inside the body.
- Do not wrap the final answer in triple backticks or any fenced code block.
- Do not invent sample counts, timings, function names, object names, or
  conclusions that are not present in the grounded input.
- If the grounded input is insufficient for a claim, say that plainly.
- In participant or host-managed flows, render this markdown inline and let the
  host persist it automatically.
- In generic-agent flows, write the final markdown report to a temporary file
  and run:
  ```
  node "<skill-dir>/save-report.cjs" asset-analysis "Asset Analysis — <asset label>" /tmp/nsolid-asset-analysis.md
  ```

### 8. Validate When Optimization Is Proposed
- If you end up optimizing CPU-bound code, use the `ns-benchmark-validate` skill to
  prove the change.

## Tools
- `assets`
- `asset-summary`
- `assets-in-progress`
- `information-dashboard`
- `metrics-historic`
- `events-historic`
- `runtime-code`
- `track-heap-objects`

## Guardrails
- Do not download raw assets when `asset-summary` already gives enough signal.
- Never analyze a heap snapshot that is still marked as processing or pending.
  Poll and wait until `asset-summary` returns the actual summarized content.
- Do not assume the local file is CPU-only; all heap asset types are supported.
- Do not invent findings. If the asset summary lacks detail, say so explicitly.
