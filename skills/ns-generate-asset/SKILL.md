---
name: ns-generate-asset
description: >-
  Captures a new N|Solid diagnostic asset for a connected Node.js app through N|Solid. Use when the user explicitly asks to collect, capture, or generate a CPU profile, flamegraph, heap sample, heap snapshot, or heap tracking asset and wants it saved or handed off for analysis. For existing assets, use ns-analyze-asset instead.
---

This skill captures assets through the N|Solid MCP server (`nsolid`) and saves them with a bundled script. The script needs the server's settings: `NSOLID_API_URL` and `NSOLID_API_TOKEN` in the environment, or `~/.agents/.nsolid-auth.json` with `apiUrl` and `token` (plus `tenant` when the token can use several tenants).

### 1. Pick the Tenant
- The N|Solid tools take a `tenant`. When the token can use one tenant it is the default; otherwise call `list_tenants` once and use the tenant the user names (production and staging are usually separate tenants). Pass the same tenant to every call, and set `NSOLID_TENANT` for the script.

### 2. Resolve Scope
- The target app is already resolved (workspace mapping, explicit `Application: <name>`, or user confirmation). Do not switch apps.
- Call `fleet_snapshot` with `where: 'app == "<appName>"'`.
- No agents → stop and report no connected agents. Do not capture from a different app.
- One agent → use its `agentId`.
- Multiple agents → list each (`agentId`, `hostname`, `cpu_percent`, `used_heap_size`) and ask the user to choose. Only proceed after selection.
- For a worker thread, `list_threads` with the `agentId` gives each thread's `threadId` and name. The main thread is `0`.

### 3. Choose Asset Type
- Supported types: CPU profile, heap sample, heap snapshot, heap tracking.
- Match the user's request:
  - CPU profile / cpuprofile / flamegraph → `take_cpu_profile`.
  - Heap sample / heap sampling / memory sample → `take_heap_sampling`.
  - Heap snapshot / full heap snapshot → `take_heap_snapshot`.
  - Heap tracking / allocation tracking / object tracking → `take_heap_profile`.
- Default to heap sampling for memory concerns and a CPU profile for CPU concerns.
- If ambiguous, ask the user to choose. Do not guess. Only proceed after the user specifies or confirms.

### 4. Create the Asset
- Each tool waits until the asset is stored and returns its `assetId`; there is nothing to poll.
- CPU profile: `take_cpu_profile` with the `agentId`, `durationMs: 30000` and `threadId: 0`. It also returns the hottest functions.
- Heap sample: `take_heap_sampling` with the `agentId`, `durationMs: 30000` and `threadId: 0`. Add `sampleInterval` (bytes) or `stackDepth` only when the user asks for them.
- Heap snapshot: `take_heap_snapshot` with the `agentId` and `threadId: 0`. The application pauses while the snapshot is written: say so before capturing.
- Heap tracking: `take_heap_profile` with the `agentId`, `durationMs: 30000` and `threadId: 0`. Add `trackAllocations: true` when the user asks for allocation stacks. It ends with a snapshot, so the application pauses too.
- If a tool answers that the agent is already profiling (continuous CPU profiling is on), `list_assets` with the `agentId` and `kind: "cpu_profile"` lists its continuous profiles: offer the newest instead.
- If a tool is refused because the tenant used its monthly allowance (`quota_exceeded`), report that and when it resets, and stop.
- Record the exact `assetId`, app name and `agentId` for downloading and reporting.

### 5. Download
- Download the asset with the bundled script (use the absolute path of the directory where you read this SKILL.md):
  ```
  node "<skill-dir>/fetch-nsolid-asset.cjs" <assetId> <appName>
  ```
- It writes `.nsolid/assets/<type>-<appName>-<assetIdPrefix>.<ext>` (`.cpuprofile`, `.heapprofile`, `.heapsnapshot` or `.heaptimeline`) and registers it in `.nsolid/assets/index.json`. A file already downloaded is reused.
- Downloading a heap snapshot or a heap tracking file needs a token allowed to take them. If the script is refused, report the `assetId` and that this token can't download it.

### 6. Report or Hand Off for Analysis
- For capture-only requests, report asset type, `assetId`, app name, `agentId`, duration/thread ID, and local path.
- If the user asked to analyze, summarize, interpret, or explain the asset, read and follow `../ns-analyze-asset/SKILL.md` after the capture. Do not duplicate its analysis rules here.
- Pass this handoff payload: `assetId`, the asset kind (`cpu_profile`, `heap_sampling`, `heap_snapshot` or `heap_profile`), `appName`, `agentId`, `threadId`, `durationMs`, and local path if downloaded.

## Guardrails
- Do not use `get_source_code` or the workspace comparison helper.
- Downloads use the bundled `fetch-nsolid-asset.cjs` only. Do not use direct HTTP calls, `curl`, or ad hoc shell commands.
- Never read a downloaded asset into context.
- Prefer heap sampling to snapshots and heap tracking: both of those pause the application.
