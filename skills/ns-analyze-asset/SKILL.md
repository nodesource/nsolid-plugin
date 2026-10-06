---
name: ns-analyze-asset
description: >-
  Analyzes an existing N|Solid diagnostic asset in N|Solid by asset ID or local asset path. Use when the user asks to inspect, review, summarize, or interpret an already-captured CPU profile, heap profile, heap sample, heap tracking file, or heap snapshot, including assets just produced by ns-generate-asset. Do not use to capture new profiles/snapshots.
---

This skill reads assets through the N|Solid MCP server (`nsolid`) and bundled scripts. The scripts need the server's settings: `NSOLID_API_URL` and `NSOLID_API_TOKEN` in the environment, or `~/.agents/.nsolid-auth.json` with `apiUrl` and `token` (plus `tenant` when the token can use several tenants).

## Instructions

### 1. Pick the Tenant
- The N|Solid tools take a `tenant`. When the token can use one tenant it is the default; otherwise call `list_tenants` once and use the tenant the user names. Pass the same tenant to every call, and set `NSOLID_TENANT` for the scripts.

### 2. Identify the Asset
- The user should provide an asset ID or an app name with asset type.
- Keep the app name from the user, `list_assets` or `find_agents`; the summaries don't include it.
- If the user only gives an app name and asset type, find the app's processes with `find_agents` (`app`), then call `list_assets` with an `agentId` and `kind` (`cpu_profile`, `heap_sampling`, `heap_snapshot` or `heap_profile`), and ask the user which asset to inspect. Continuous profiles show origin `continuous`.
- If the user gives a local `.cpuprofile`, `.heapprofile`, `.heapsnapshot` or `.heaptimeline` path instead of an asset ID, resolve the full asset ID from `.nsolid/assets/index.json`. The file name `.nsolid/assets/<type>-<appName>-<assetIdPrefix>.<ext>` carries only an 8-character **prefix** of the ID, which is not enough on its own.
- **Never read the raw asset file into context**: it is large and token-wasteful. Always go through the summaries below.
- If `index.json` is missing and the MCP server is unavailable, tell the user the full asset ID cannot be recovered (only the filename prefix is known) and stop.

### 3. Get the Summary
- **CPU profile:** `profile_hotspots` with the `assetId` gives the hottest functions (`function`, `package`, `location`, `selfPct`, `totalPct`) and self time by package. Ask again with `sort: "total"` for the hot path's callers, or with `package` for one package's functions.
- **Heap sample:** `heap_summary` gives the live bytes each function allocated (`selfBytes`, `totalBytes`, `totalPercent`), by package and version.
- **Heap snapshot or heap tracking:** `heap_summary` gives the objects and bytes by class and by node type. String contents are never kept.
- If the answer says the asset is not analyzed yet, run the wait script (use the absolute path of the directory where you read this SKILL.md) and ask again, up to **12** times:
  ```
  node "<skill-dir>/wait.cjs" 5
  ```
- If `heap_summary` says a snapshot was skipped (too large for the server to summarize), say so: the file can still be downloaded (step 10) for Chrome DevTools or `snapshot-parser`.
- If the asset's status is `expired`, its file is gone, but `profile_hotspots` still answers for CPU profiles that were analyzed.

### 4. Analyze by Asset Type

#### CPU Profile
- Find the functions with the highest `totalPct` and `selfPct`.
- Packages tell whose code it is: `(app)` is the application's own code, `(node)` Node.js internals, `(v8)` the engine (`(garbage collector)` is GC pressure), `(idle)` waiting, anything else an npm package and its version.
- Explain the hot path and the most expensive bottleneck.
- Focus on user-owned code. If the top cost is in Node internals or a dependency, explain the nearest relevant user-owned caller instead.
- If frames were named from the build's sourcemaps (`namedFromSourcemaps`), say the names come from them.

#### Heap Sample
- Identify the functions and packages holding the most live bytes: `selfBytes` for what a function allocated itself, `totalBytes` with its callees.
- Call out suspicious allocation patterns (e.g. one function holding most of the bytes, a dependency allocating far more than the app's own code, many small allocations from one call site).

#### Heap Snapshot or Heap Tracking
The summary gives objects and bytes by class and type. It has no retained sizes, dominators or retainer paths.

**Top classes** — the classes with the most bytes (`selfSize`, `sizePercent`) and objects (`count`). Explain what they are.

**Growth** — one snapshot can't show a leak. When an earlier snapshot of the same process exists (`list_assets` with the `agentId` and `kind: "heap_snapshot"`), call `heap_diff` with the later one as `assetId` and the earlier as `baseId`: it lists the classes that grew, largest growth first. Classes that keep growing are what leaks look like.

**Retainer paths** — not in the summary. To trace what holds the largest objects, download the snapshot (step 10) and open it in Chrome DevTools or `snapshot-parser`; say so rather than guessing.

**Common leak patterns to flag:**
- Closures holding references to large outer scopes that outlive their use.
- `EventEmitter` listeners added but never removed (`removeListener` / `off` missing).
- Unbounded `Map`, `Set`, or plain object caches that grow without eviction.
- Promise chains retaining intermediate values after resolution.
- `setInterval` or `setTimeout` callbacks capturing large context.
- Large `Buffer` or `TypedArray` allocations held by long-lived objects.
- Interned string tables or template literal accumulation.

**Confirm leak vs one-off spike:**
- Call `query_metric` with `metric: "used_heap_size"` (then `total_heap_size` and `rss`), `agentIds: [<agentId>]` (or `app`), and `from`/`to` around the snapshot time.
- Call `list_events` with the same `agentId` or `app` and `from`/`to`, for blocked loops or an exit near that time. `get_agent` shows whether the process has ended and how: running out of memory shows as an abort (`SIGABRT`) with the fatal error.

**Follow-up recommendation:**
- For a deeper hunt (baseline vs peak heap sampling), reference the `ns-advanced-memory-leak-hunter` skill.

### 5. Correlate with Runtime Context
- `get_agent` with the asset's `agentId` confirms the app, the host, and whether the process still runs (or how it ended).
- `query_metric` around the asset's time with `agentIds: ["<agentId>"]`: `cpu_percent` for CPU profiles, `used_heap_size` and `rss` for heap assets.

### 6. Read the Code Behind a CPU Bottleneck
- Only for CPU profiles, for the hottest **user-owned** (`(app)`) frame. Never fetch code for Node internals or dependencies.
- **The workspace first.** When this workspace is the app's source, read the frame here. Run the bundled helper:
  ```
  node "<skill-dir>/workspace-delta.cjs" <json-file-or-stdin>
  ```
  with `{"targetAppName": "<appName>", "runtimePath": "<the frame's location without :line>", "lineHint": <its line>, "contextLines": 40}`. It checks that the workspace is that app, maps the runtime path to a workspace file (stripping `/app` and other deploy prefixes), and returns `workspaceCode`, `resolvedWorkspacePath` and `lineRange`. If the path doesn't map, `get_agent` gives the process's main module as `info.main` (`/app/server.js` is `server.js` here): pass the workspace-relative path as `workspaceRelativePath`.
- **Then the running process.** Only when the helper says the workspace isn't the app, or the file isn't in it, offer `get_source_code` with the `agentId`, `path` (the frame's location without its `:line` suffix), `line` and `context: 80`. It reads code out of a production process, and every read is in the tenant's audit log. It is offered only to people holding N|Solid's source-code permission (tenant admins by default) on a tenant where the source viewer is on. When the tool is missing or refuses, say which (no permission, or the feature is off for the tenant) and ask for the file or read it from the checkout instead. If it fails on the path, retry up to 2 times: strip a leading `file://`, `/app` or `/usr/src/app`, or remove a leading path segment.

### 7. Keep the User in the Loop
- Present the key findings first.
- Ask whether the user wants an optimized solution before proposing code changes (CPU profiles only).

### 8. Present a Report
Emit the analysis directly in chat using this exact structure and formatting:

```markdown
# Asset Analysis — <asset label>

**Date**: <ISO date>
**Asset ID**: <asset id>
**Source**: N|Solid <profile_hotspots | heap_summary | heap_diff>

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

### 9. Write the Report to Disk
- Ask the user if they want to save the report to disk.
- If the user confirms, write the final report as a markdown file (`.md`) under `.nsolid/assets/` — for example `.nsolid/assets/asset-analysis-<asset id>.md`.

### 10. Offer Next Steps
- For CPU profiles, offer to propose code changes for the hottest user-owned function, and offer the HTML flame graph report:
  ```
  node "<skill-dir>/render-cpu-report.cjs" <assetId> --app <appName> --artifact
  ```
  It writes `.nsolid/reports/cpu-<appName>-<date>-<assetIdPrefix>.html` (an interactive flame graph, time by package, the heaviest functions) and prints a JSON summary. **Never read the HTML into context.** If an Artifact tool is available, offer to publish the printed `artifactFile`; ask first, since publishing uploads the profile's data.
- Ask the user if they want to download the asset. If they confirm, save it locally:
  ```
  node "<skill-dir>/fetch-nsolid-asset.cjs" <assetId> <appName>
  ```

## Guardrails
- Never analyze an asset that is not analyzed yet. Wait and ask again until the summary has real content, or say it isn't ready.
- Do not lie about findings. If the summary lacks detail, say so explicitly.
- Never read raw asset files or the HTML reports into context; download and render them only with the bundled `fetch-nsolid-asset.cjs` and `render-cpu-report.cjs`.
- Read code from the workspace whenever it has the frame's file. `get_source_code` reads code out of a production process: use it only as the fallback in step 6.
