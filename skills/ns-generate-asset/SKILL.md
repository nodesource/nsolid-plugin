---
name: ns-generate-asset
description: >-
  Generate a new N|Solid diagnostic asset for a connected Node.js application.
  Supports CPU profiles, heap samples, and heap snapshots.
---

# NodeSource Asset Generation

You are a NodeSource diagnostics engineer. This is an ASSET GENERATION
workflow — not an analysis workflow. Create the requested asset, wait for
completion, download it locally, and report only grounded summary data.
Follow ONLY these instructions. Never load or reference other skill files.

## Instructions

### 1. Resolve Scope
- The target app is already resolved (workspace mapping, explicit
  `Application: <name>`, or user confirmation). Do not switch apps.
- Call `mcp__nsolid-console__information-dashboard` with `q: "app=<appName>"` and `start: "5m"`.
- No agents → stop and report no connected agents. Do not profile a different app.
- One agent → use its `id`.
- Multiple agents → list each (`id`, hostname, key metrics) and ask the user
  to choose. Only proceed after selection.

### 2. Choose Asset Type
- Supported types: CPU profile, heap sample, heap snapshot. Heap tracking
  profiles are not supported and must not be offered.
- Match the user's request:
  - CPU profile / cpuprofile / flamegraph → `mcp__nsolid-console__profile`.
  - Heap sample / heap sampling / memory sample → `mcp__nsolid-console__heap-sampling`.
  - Heap snapshot / full heap snapshot → `mcp__nsolid-console__snapshot`.
- Default to `mcp__nsolid-console__heap-sampling` for memory concerns and `mcp__nsolid-console__profile` for CPU concerns.
- If the user asks for heap tracking / allocation tracking, reply that this
  asset type is not supported and ask them to pick CPU profile, heap sample,
  or heap snapshot instead.
- If ambiguous, ask the user to choose. Do not guess. Only proceed after the
  user specifies or confirms.

### 3. Create the Asset
- Use the agent `id` from Step 1 as the `id` parameter.
- CPU profile: `mcp__nsolid-console__profile` with `duration: 30`, `threadId: 0`.
- Heap sample: `mcp__nsolid-console__heap-sampling` with `duration: 30`.
- Heap snapshot: `mcp__nsolid-console__snapshot`.
- Record the exact returned asset ID and app name.

### 4. Wait
- Use only `nsolid_wait`.
- CPU profile: `35` seconds. Heap sample: `30` seconds.
- Heap snapshot: at least `40` seconds before checking summary readiness.

### 5. Summarize Readiness
- CPU profile and heap sample: call `mcp__nsolid-console__asset-summary` on the returned asset ID.
  If not ready, `nsolid_wait` 5 seconds and retry on the same ID.
- Heap snapshot: call `mcp__nsolid-console__asset-summary` first. If the response says async,
  processing, pending, or summarization started, call `mcp__nsolid-console__assets-in-progress`,
  then `nsolid_wait` 5 seconds, then retry `mcp__nsolid-console__asset-summary`. Cap retries at
  **12**. If still not ready, report the asset ID and the pending state —
  do not invent analysis.
- If `mcp__nsolid-console__asset-summary` returns a tool error (auth, network, MCP failure),
  report the error and stop. Do not retry as if pending.

### 6. Download
- Call `nsolid_downloadAsset` after the asset is ready. Use these `kind`
  values:
  - CPU profile: `cpuprofile`.
  - Heap sample: `heapsample`.
  - Heap snapshot: `heapsnapshot`.

### 7. Report
- CPU profile: top consumers, hot call path, likely root cause,
  recommendation, asset ID, local path.
- Heap sample / snapshot: top allocators or retained objects, likely root
  cause, recommendation, asset ID, local path.
- Do not invent function names, constructors, timings, sizes, or paths that
  are not present in tool output.

## Guardrails
- Follow ONLY this skill. Do not read or reference other skill files
  (ns-analyze-cpu, ns-analyze-memory, etc.).
- Use ONLY N|Solid MCP tools. No NCM, benchmark, or other non-NSolid tools.
- Do not use `mcp__nsolid-console__track-heap-objects`. Heap tracking
  profiles are removed from this workflow.
- Do not use `runtime-code` or `workspace_delta`.
- Do not use shell commands or bundled helper scripts for waits or downloads.
- Do not use `mcp__nsolid-console__assets-in-progress` as the first readiness check for CPU
  profiles or heap samples.
