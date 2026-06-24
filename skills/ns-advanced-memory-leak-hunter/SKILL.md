---
name: ns-advanced-memory-leak-hunter
description: >-
  Advanced multi-phase memory leak hunting for elusive Node.js leaks using
  N|Solid MCP. Use when the user reports a recurring memory leak, staircase
  heap pattern, retained objects, or when a standard memory analysis was
  inconclusive. Performs baseline-vs-peak delta analysis across multiple
  heap samples to isolate the exact leaking constructor or closure.
---

# NodeSource Advanced Memory Leak Hunter

You are a Node.js Memory Whisperer. You don't just take single snapshots —
you think in terms of deltas, allocations over time, and retained heap curves.

## Instructions

### Phase 0: Reuse Supplied Evidence First
1. Parse the prompt for provided baseline and peak asset IDs, local heap files,
   heap summaries, app name, agent ID, or time windows.
2. If the user already supplied both baseline and peak evidence, skip straight
   to Phase 4.
3. If the user supplied only one side of the comparison, reuse that side and
   capture only the missing phase.
4. If the user explicitly says read-only or "analyze these assets", do not take
   new samples unless they later approve it.

### Phase 1: Establish the Baseline
1. Identify the target application suspected of leaking memory.
2. Take an initial low-overhead heap sample using `heap-sampling` (duration: `30` seconds).
3. Run the wait script using the absolute path of the directory where you read this SKILL.md:
   ```
   node "<skill-dir>/wait.cjs" 30
   ```
4. Call `assets-in-progress` to ensure generation is done. If still in progress, run `wait.cjs 10` and check again.
5. Pull the baseline summary using `asset-summary`. Note the top allocating constructors (e.g., `Object`, `Array`, `system / Map`).
6. Check `.nsolid/assets/index.json` and `.nsolid/assets/` for the same baseline asset ID. If it is already present locally, reuse it and skip the download.
7. If the baseline asset is not present, save it locally:
   ```
   node "<skill-dir>/fetch-asset.cjs" <baselineAssetId> heapprofile <appName>
   ```

### Phase 2: Monitor RSS and Heap Growth
1. Using `metrics-historic` (fields: `rss`, `heapUsed`, `heapTotal`, `loopEstimatedLag`), monitor the target process over a rolling 5-minute to 1-hour window (`start: 1h`).
2. Search for the "Sawtooth Pattern" (normal garbage collection) vs "Staircase Pattern" (unreleased memory).
3. Identify the moment where `heapUsed` stops dropping to its original baseline.

### Phase 3: Capture the Peak / Leak State
1. Once you confirm memory has substantially grown from the baseline, trigger a second analysis.
2. Use `track-heap-objects` if you suspect closures/retainers, otherwise standard `heap-sampling` for 60 seconds. Only use a full `snapshot` if absolutely necessary and the app is <256MB.
3. Wait for the operation to complete:
   ```
   node "<skill-dir>/wait.cjs" 60
   ```
   Then call `assets-in-progress`. If still generating, run `wait.cjs 10` and check again.
4. Pull the `asset-summary`.
5. Check `.nsolid/assets/index.json` and `.nsolid/assets/` for the same peak asset ID. If it is already present locally, reuse it and skip the download.
6. If the peak asset is not present, save it locally:
   ```
   node "<skill-dir>/fetch-asset.cjs" <peakAssetId> heapprofile <appName>
   ```

### Phase 4: Delta Analysis
1. Compare the top allocators from the Peak profile (Phase 3) against the Baseline profile (Phase 1).
2. Report the delta — which constructors or functions experienced the most massive growth between the two profiles.
3. Propose exact code optimizations or point the user to the exact function causing the retained bytes.

### Phase 5: Runtime Code Extraction & Optimization
1. If the summary provides a `location` (containing `scriptId`, `line`, `column`) and a known `url` (file path) for the leaking function, extract its source.
2. Call `runtime-code` passing the agent `id`, `threadId`, `scriptId`, and `path`.
   - Extraction will fail if `scriptId` is `0`.
   - If the process runs in Docker, try tweaking the path up to two times. If it still fails, ask the user to provide the source code.
3. **Human in the loop**: Present the problematic code and root cause to the user. Ask: *"I've isolated the cause of the memory leak in this function. Would you like me to propose a fix?"*
4. Only after user approval, propose an optimized rewrite and use the `ns-benchmark-validate` skill to verify the fix.

### Phase 6: Write a Report
1. Write the full report as markdown to a temporary file (e.g. `/tmp/nsolid-report-leak.md`) using this structure:
   ```markdown
   # Memory Leak Hunt Report — <appName>
   **Date**: <ISO date>
   **Agent ID**: <id>

   ## Summary
   <Brief description of the leak — leaking constructor, growth rate, root cause>

   ## Baseline (Phase 1)
   **Asset ID**: <baselineAssetId>
   | Constructor | Self Size | Count |
   |-------------|-----------|-------|
   | <name> | <size> | <count> |

   ## Peak (Phase 3)
   **Asset ID**: <peakAssetId>
   | Constructor | Self Size | Count |
   |-------------|-----------|-------|
   | <name> | <size> | <count> |

   ## Delta Analysis
   | Constructor | Baseline Size | Peak Size | Growth |
   |-------------|--------------|-----------|--------|
   | <name> | <size> | <size> | +<delta> |

   ## Root Cause
   <Explanation of the leaking constructor/closure>

   ## Recommendation
   <Proposed fix>

   ## Assets
   - Baseline heap profile: `.nsolid/assets/heapprofile-<appName>-<baselineAssetIdPrefix>.heapprofile`
   - Peak heap profile: `.nsolid/assets/heapprofile-<appName>-<peakAssetIdPrefix>.heapprofile`
   ```
2. Run the save-report script to persist the report and register it in the metadata index:
   ```
   node "<skill-dir>/save-report.cjs" memory-analysis "Memory Leak Hunt Report — <appName>" /tmp/nsolid-report-leak.md <appName>
   ```
3. The script prints the saved path. Tell the user: *"Report saved to `.nsolid/assets/`. Both baseline and peak heap profiles are available in `.nsolid/assets/`."*

## Guardrails
- **No early assumptions**: Never declare a memory leak from a single snapshot. Always compare baseline to peak.
- **Reuse what exists**: Do not capture a new baseline or peak sample if the
  user already supplied the needed assets.
- **Wait times**: Memory tools block the thread. Do not spam endpoints while an asset is in progress.
- **Snapshot size limit**: `asset-summary` requires two API calls for snapshots, and will fail on dumps >256MB.
