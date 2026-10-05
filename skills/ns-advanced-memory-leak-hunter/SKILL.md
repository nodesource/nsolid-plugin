---
name: ns-advanced-memory-leak-hunter
description: >-
  Performs an advanced N|Solid memory leak hunt through N|Solid, comparing baseline vs peak heap evidence to isolate retained allocators, closures, and growing classes. Use when the user reports recurring/staircase memory growth, elusive leaks, retained objects, closures holding references, or a standard heap sample/snapshot analysis was inconclusive. Prefer supplied baseline/peak assets; capture new samples only when needed.
---

This skill reads N|Solid data through the N|Solid MCP server (`nsolid`) and bundled scripts. The scripts need the server's settings: `NSOLID_API_URL` and `NSOLID_API_TOKEN` in the environment, or `~/.agents/.nsolid-auth.json` with `apiUrl` and `token` (plus `tenant` when the token can use several tenants).

### Phase 0: Reuse Evidence and Resolve Target
1. If the user already supplied both baseline and peak evidence (asset IDs or local files), skip straight to Phase 4.
2. The N|Solid tools take a `tenant`. When the token can use one tenant it is the default; otherwise call `list_tenants` once and use the tenant the user names. Pass it to every call, and set `NSOLID_TENANT` for the scripts.
3. If no `agentId` is supplied, call `fleet_snapshot` with `where: 'app == "<appName>"'` and `sort: "used_heap_size"` to find the process; keep the exact `appName` for downloads. Stop if no matching process is connected.
4. A leak can sit in a worker thread while the main thread looks fine: `list_threads` with the `agentId` shows each thread's heap. Capture the thread that grows (`threadId`).

### Phase 1: Establish the Baseline
1. Take an initial low-overhead heap sample: `take_heap_sampling` with the `agentId`, `durationMs: 30000` and the `threadId`. It waits for the sampling and returns its `assetId`.
2. Call `heap_summary` on the baseline `assetId`. If it says the asset is not analyzed yet, run the wait script (use the absolute path of the directory where you read this SKILL.md) and ask again, up to **12** times; if still not ready, report the baseline asset ID and its state instead of continuing:
   ```
   node "<skill-dir>/wait.cjs" 10
   ```
3. From the baseline summary, note the top allocating functions and packages (`selfBytes`, `totalBytes`).
4. Check `.nsolid/assets/index.json` for the baseline asset ID. If it is already there, skip the download; otherwise save it locally:
   ```
   node "<skill-dir>/fetch-nsolid-asset.cjs" <baselineAssetId> <appName>
   ```

### Phase 2: Monitor RSS and Heap Growth
1. Call `query_metric` with `agentIds: [<agentId>]` and `from: "-1h"` for each of `rss`, `used_heap_size`, `total_heap_size` and `loop_estimated_lag` (for a worker, add `thread`).
2. Search for the "Sawtooth Pattern" (normal garbage collection) vs the "Staircase Pattern" (unreleased memory).
3. Identify the moment where `used_heap_size` stops dropping back to its original baseline.

### Phase 3: Capture the Peak / Leak State
1. Once you confirm memory has substantially grown from the baseline, capture the peak with `take_heap_sampling` for 60 seconds (`durationMs: 60000`) on the same `agentId` and `threadId`.
2. Call `heap_summary` on the peak `assetId`, waiting and asking again as in Phase 1 if it is not analyzed yet.
3. Check `.nsolid/assets/index.json` for the peak asset ID; if it is not there, save it:
   ```
   node "<skill-dir>/fetch-nsolid-asset.cjs" <peakAssetId> <appName>
   ```
4. **Snapshots, when the user accepts the pause.** Two heap snapshots of the process some minutes apart show which classes grew: `take_heap_snapshot` twice, then `heap_diff` with the later as `assetId` and the earlier as `baseId`. Classes that keep growing are what leaks look like. Each snapshot pauses the application while it is written, so ask first.

### Phase 4: Delta Analysis
1. Compare the top allocators from the Peak sample (Phase 3) against the Baseline (Phase 1), function by function and package by package.
2. Report the delta — which functions or packages grew the most in live bytes between the two samples (and which classes grew, when Phase 3 took snapshots).
3. Point the user to the exact function causing the retained bytes, and propose code optimizations.

### Phase 5: Read the Leaking Code & Optimize
1. Use the leaking function's location (`at`: its script and line) from `heap_summary`. Only read **user-owned** code (`(app)`); for a dependency, explain how the app's code feeds or holds what it allocates.
2. **The workspace first.** When this workspace is the app's source, run the bundled helper:
   ```
   node "<skill-dir>/workspace-delta.cjs" <json-file-or-stdin>
   ```
   with `{"targetAppName": "<appName>", "runtimePath": "<the location without :line>", "lineHint": <its line>, "contextLines": 40}`. It checks the workspace is that app, maps the runtime path to a workspace file (stripping `/app` and other deploy prefixes), and returns `workspaceCode`, `resolvedWorkspacePath` and `lineRange`.
3. **Then the running process.** Only when the helper says the workspace isn't the app, or the file isn't in it, call `get_source_code` with the `agentId`, `path`, `line`, `context: 80` and the `threadId`. It reads code out of a production process, and every read is in the tenant's audit log. It is offered only to people holding N|Solid's source-code permission (tenant admins by default) on a tenant where the source viewer is on. When the tool is missing or refuses, say which (no permission, or the feature is off for the tenant) and ask for the file or read it from the checkout instead. If the process runs in a container, try tweaking the path up to two times (strip `/app` or `/usr/src/app`, or a leading segment). If it still fails, ask the user to provide the source code.
4. **Human in the loop**: Present the problematic code and root cause to the user. Ask: *"I've isolated the cause of the memory leak in this function. Would you like me to propose a fix?"*
5. Only after user approval, propose an optimized rewrite and use the `ns-validate-optimization` skill to verify the fix.

### Phase 6: Write a Report
1. Compose the full report as markdown using this structure:
   ```markdown
   # Memory Leak Hunt Report — <appName>
   **Date**: <ISO date>
   **Agent ID**: <agentId>

   ## Summary
   <Brief description of the leak — leaking function or class, growth rate, root cause>

   ## Baseline (Phase 1)
   **Asset ID**: <baselineAssetId>
   | Function | Package | Live bytes |
   |----------|---------|------------|
   | <name> | <package> | <bytes> |

   ## Peak (Phase 3)
   **Asset ID**: <peakAssetId>
   | Function | Package | Live bytes |
   |----------|---------|------------|
   | <name> | <package> | <bytes> |

   ## Delta Analysis
   | Function | Baseline | Peak | Growth |
   |----------|----------|------|--------|
   | <name> | <bytes> | <bytes> | +<delta> |

   ## Root Cause
   <Explanation of the leaking function, closure or class>

   ## Recommendation
   <Proposed fix>

   ## Assets
   - Baseline heap profile: `.nsolid/assets/heapprofile-<appName>-<baselineAssetIdPrefix>.heapprofile`
   - Peak heap profile: `.nsolid/assets/heapprofile-<appName>-<peakAssetIdPrefix>.heapprofile`
   ```
   When Phase 3 compared snapshots, add a `## Class Growth` table from `heap_diff` (class, count delta, size delta).

### 7. Write the Report to Disk
- Ask the user if they want to save the report to disk.
- If the user confirms, write the final report as a markdown file (`.md`) under `.nsolid/assets/` — for example `.nsolid/assets/memory-analysis-<appName>.md`.

## Guardrails
- **No early assumptions**: Never declare a memory leak from a single sample or snapshot. Always compare baseline to peak.
- **Reuse what exists**: Do not capture a new baseline or peak if the user already supplied the needed assets.
- **One capture at a time**: the take tools wait for their capture; do not start another on the same process meanwhile.
- **Snapshots pause the application**: take them only with the user's approval.
- Download assets only with the bundled `fetch-nsolid-asset.cjs`, and never read them into context.
- Read code from the workspace whenever it has the file; `get_source_code` is the fallback.
