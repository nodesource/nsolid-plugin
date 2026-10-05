---
name: ns-memory-spike-analysis
description: >-
  Diagnoses memory growth, heap spikes, RSS increases, OOMs, and suspected leaks in Node.js apps using supplied heap evidence or N|Solid heap sampling/snapshots from N|Solid. Use when the user reports memory leak, heap growing, high RSS, out-of-memory, heap snapshot/profile analysis, or wants memory root-cause triage.
---

This skill reads N|Solid data through the N|Solid MCP server (`nsolid`) and bundled scripts. The scripts need the server's settings: `NSOLID_API_URL` and `NSOLID_API_TOKEN` in the environment, or `~/.agents/.nsolid-auth.json` with `apiUrl` and `token` (plus `tenant` when the token can use several tenants).

### 1. Use Provided Evidence First
- Parse the prompt for app name, agent ID, asset ID, local heap file path, heap summary, constructor table, retained-size output, or OOM context before calling tools.
- If the user already provided an asset ID, local file path, or structured heap summary, analyze that evidence first instead of starting with `query_metric`.
- If the prompt is a telemetry alert for a specific app, use that as the starting signal for live analysis of that same app.
- If the user explicitly says read-only, offline, or "analyze this file", do not capture a new heap asset unless they later approve it.

### 2. Pick the Tenant
- The N|Solid tools take a `tenant`. When the token can use one tenant it is the default; otherwise call `list_tenants` once and use the tenant the user or alert names. Pass the same tenant to every call, and set `NSOLID_TENANT` for the scripts.

### 3. Find the Bottleneck Only If You Still Need a Target
- If no agent is known, call `fleet_snapshot` with `where: 'app == "<appName>"'` and `sort: "used_heap_size"`, and keep the exact app name.
- Call `query_metric` with `metric: "used_heap_size"`, `app: "<appName>"` and `from: "-15m"`; then `total_heap_size` and `rss` the same way. Each series is one process.
- Identify the `agentId` consistently growing in memory.
- A process can be fine on its main thread while a worker leaks: `list_threads` with the `agentId` shows each thread's heap.
- If processes of the app are dying instead (out of memory), `list_ended_processes` with `app` shows how each ended (an abort, `SIGABRT`, with the fatal error) and its peak heap; `get_agent` gives one's exit stack.
- Skip this step when the provided evidence already names the exact asset, process, or local file to inspect.

### 4. Reuse Existing Assets Before Capturing
- If the prompt includes an asset ID, call `heap_summary` first.
- If the prompt includes a local `.heapprofile`, `.heapsnapshot` or `.heaptimeline` path, resolve its asset ID from `.nsolid/assets/index.json` and call `heap_summary`. **Never read the raw heap file into context** — it is large and token-wasteful.
- `list_assets` with the `agentId` and `kind` (`heap_sampling` or `heap_snapshot`) shows assets already taken of the process.
- If the current evidence is already enough to identify the culprit, explain it and stop there. Do not capture a second asset unless the user asks.

### 5. Capture Memory Data Only With Missing Evidence or User Approval
- **Preferred (Low Overhead)**: `take_heap_sampling` with the `agentId`, `durationMs: 30000` and `threadId: 0` (a worker's id for a worker). Add `sampleInterval` or `stackDepth` only when asked. It waits for the sampling and returns its `assetId`.
- **Alternative (Full Freeze)**: `take_heap_snapshot` with the `agentId` and `threadId: 0`. The application pauses while it is written. Only use it if explicitly requested.
- Capture only when no reusable evidence was provided and the user approves, unless the prompt is an explicit live alert/investigation.
- If the tool is refused because the tenant used its monthly allowance (`quota_exceeded`), say so and continue with the evidence you have.

### 6. Summarize the Asset
- Call `heap_summary` with the `assetId`.
- If it says the asset is not analyzed yet, run the bundled wait script (use the absolute path of the directory where you read this SKILL.md) and ask again, up to **12** times:
  ```
  node "<skill-dir>/wait.cjs" 5
  ```
- Once `heap_summary` returns the summary, analyze it directly. Do not answer that telemetry alone is insufficient after a successful heap summary.

### 7. Save the Full Asset
- Use the app name recorded from the prompt or discovery; the summary does not include it.
- Download the asset with the bundled script:
  ```
  node "<skill-dir>/fetch-nsolid-asset.cjs" <assetId> <appName>
  ```
- It writes `.nsolid/assets/heapprofile-<appName>-<assetIdPrefix>.heapprofile` for a heap sampling (`.heapsnapshot` for a snapshot) and registers it in `.nsolid/assets/index.json`. It is idempotent and reuses an existing download.

### 8. Identify the Culprit
- Heap sampling: the functions and packages holding the most live bytes (`selfBytes`, `totalBytes`, by `package`). The app's own code is `(app)`.
- Heap snapshot: the classes with the most bytes and objects. With an earlier snapshot of the same process, `heap_diff` (the later as `assetId`, the earlier as `baseId`) shows which classes grew.
- Explain your findings to the user.
- If the current evidence is insufficient to isolate the allocator, say exactly what specific allocator, class, retaining path, or retained-size detail is still missing from the summary.

### 9. Present the Result
- Structure the final answer around:
  1. Summary of the memory issue.
  2. Top allocators (functions and packages) or classes from the summary.
  3. Root cause hypothesis.
  4. Recommendation.
  5. Full asset reference if downloaded.

### 10. Write the Report to Disk
- Ask the user if they want to save the report to disk.
- If the user confirms, write the final report as a markdown file (`.md`) under `.nsolid/assets/` — for example `.nsolid/assets/memory-analysis-<appName or date>.md`.

### 11. For Elusive or Recurring Leaks
- If the leak shows a staircase pattern, retainers, or closures, consider using the `ns-advanced-memory-leak-hunter` skill for multi-phase baseline-vs-peak delta analysis.

## Guardrails
- Capturing takes as long as `durationMs`; the tools wait for it. Do not start a second capture on the same process while one runs.
- Do not turn a user-supplied asset review into a fresh capture workflow unless the user asked for that or approved it.
- Prioritize `take_heap_sampling` over `take_heap_snapshot` to minimize production impact.
- After a successful `heap_summary`, analyze that summary instead of falling back to a generic telemetry-only conclusion.
- Download assets only with the bundled `fetch-nsolid-asset.cjs`; never read them into context.
