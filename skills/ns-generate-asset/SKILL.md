---
name: ns-generate-asset
description: >-
  Captures a new N|Solid diagnostic asset for a connected Node.js app. Use when the user explicitly asks to collect, capture, or generate a CPU profile, flamegraph, heap sample, heap snapshot, or heap tracking asset and wants it saved or handed off for analysis. For existing assets, use ns-analyze-asset instead.
---

### 1. Resolve Scope
- The target app is already resolved (workspace mapping, explicit `Application: <name>`, or user confirmation). Do not switch apps.
- Call `information-dashboard` with `q: "app=<appName>"` and `start: "5m"`.
- No agents → stop and report no connected agents. Do not profile a different app.
- One agent → use its `id`.
- Multiple agents → list each (`id`, hostname, key metrics) and ask the user to choose. Only proceed after selection.

### 2. Choose Asset Type
- Supported types: CPU profile, heap sample, heap snapshot, heap tracking.
- Match the user's request:
  - CPU profile / cpuprofile / flamegraph → `profile`.
  - Heap sample / heap sampling / memory sample → `heap-sampling`.
  - Heap snapshot / full heap snapshot → `snapshot`.
  - Heap tracking / allocation tracking / object relocation tracking → `track-heap-objects`.
- Default to `heap-sampling` for memory concerns and `profile` for CPU concerns.
- If ambiguous, ask the user to choose. Do not guess. Only proceed after the user specifies or confirms.

### 3. Create the Asset
- Use the agent `id` from Step 1 as the `id` parameter.
- CPU profile: `profile` with `duration: 30`, `threadId: 0`.
- Heap sample: `heap-sampling` with `duration: 30`; add `threadId: 0` when the main thread is intended.
- Heap snapshot: `snapshot`; add `threadId: 0` when the main thread is intended.
- Heap tracking: `track-heap-objects` with `duration: 30`; add `threadId: 0` when the main thread is intended. Include `trackAllocations: true` when the user asks for allocation stacks.
- Record the exact returned asset ID and app name for downloading and reporting.

### 4. Wait
Run the bundled wait script (use the absolute path of the directory where you read this SKILL.md):
- CPU profile: `node "<skill-dir>/wait.cjs" 35`.
- Heap sample: `node "<skill-dir>/wait.cjs" 30`.
- Heap snapshot: at least `40` seconds before checking summary readiness: `node "<skill-dir>/wait.cjs" 40`.
- Heap tracking: `node "<skill-dir>/wait.cjs" 35`.

### 5. Check Readiness
- CPU profile and heap sample: call `asset-summary` on the returned asset ID. If not ready, run `node "<skill-dir>/wait.cjs" 5` and retry on the same ID.
- Heap snapshot: call `asset-summary` first. If the response says async, processing, pending, or summarization started, call `assets-in-progress`, then run `node "<skill-dir>/wait.cjs" 5`, then retry `asset-summary`. Cap retries at **12**. If still not ready, report the asset ID and the pending state — do not invent analysis.
- Heap tracking: call `assets-in-progress`. If the returned asset ID is still in progress, run `node "<skill-dir>/wait.cjs" 5` and retry. Cap retries at **12**. Once it is no longer in progress, continue to download.
- If `asset-summary` returns a tool error (auth, network, MCP failure), report the error and stop. Do not retry as if pending.

### 6. Download
- After the asset is ready, download it with the bundled script (use the absolute path of the directory where you read this SKILL.md):
  ```
  node "<skill-dir>/fetch-asset.cjs" <assetId> <assetType> <appName>
  ```
- Use these `<assetType>` values:
  - CPU profile: `cpuprofile`.
  - Heap sample: `heapprofile`.
  - Heap snapshot: `heapsnapshot`.
  - Heap tracking: `heapprofile`.

### 7. Report or Hand Off for Analysis
- For capture-only requests, report asset type, asset ID, app name, agent ID, duration/thread ID, and local path.
- If the user asked to analyze, summarize, interpret, or explain the captured asset, read and follow `../ns-analyze-asset/SKILL.md` after the asset is ready. Do not duplicate its analysis rules here.
- Pass this handoff payload: `assetId`, `assetType` (`cpuprofile`, `heapprofile`, or `heapsnapshot`), `appName`, `agentId`, `threadId`, `duration`, and local path if downloaded.
- For heap tracking, report capture metadata and local path; only route to `ns-analyze-asset` if `asset-summary` supports the returned asset. Otherwise recommend `ns-advanced-memory-leak-hunter` for interpretation.

## Guardrails
- Do not use `runtime-code` or `workspace_delta`.
- Waits and downloads use the bundled `wait.cjs` and `fetch-asset.cjs` scripts in this skill's directory. Do not use direct HTTP calls, `curl`, or ad hoc shell commands.
- Do not use `assets-in-progress` as the first readiness check for CPU profiles or heap samples.
