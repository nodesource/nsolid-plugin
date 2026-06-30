---
name: ns-advanced-memory-leak-hunter
description: >-
  Performs an advanced N|Solid memory leak hunt comparing baseline vs peak heap evidence to isolate retained constructors, closures, and retainer paths. Use when the user reports recurring/staircase memory growth, elusive leaks, retained objects, closures holding references, or a standard heap sample/snapshot analysis was inconclusive. Prefer supplied baseline/peak assets; capture new samples only when needed.
---

### Phase 0: Reuse Evidence and Resolve Target
1. If the user already supplied both baseline and peak evidence, skip straight to Phase 4.
2. If no agent `id` is supplied, call `information-dashboard` (`q: "app=<appName>"`, `start: "5m"` when app is known) to resolve the required agent `id`; preserve the exact `appName` for downloads. Stop if no matching agent is connected.

### Phase 1: Establish the Baseline
1. Take an initial low-overhead heap sample using `heap-sampling` (`id: <agentId>`, `duration: 30`).
2. Run the wait script using the absolute path of the directory where you read this SKILL.md:
   ```
   node "<skill-dir>/wait.cjs" 30
   ```
3. Call `asset-summary` on the returned baseline asset ID. If not ready, run `node "<skill-dir>/wait.cjs" 10` and retry; use `assets-in-progress` only as a secondary queue clue. Cap retries at **12**; if still not ready, report the baseline asset ID and its pending state instead of continuing indefinitely.
4. From the baseline summary, note the top allocating constructors (e.g., `Object`, `Array`, `system / Map`).
5. Check `.nsolid/assets/index.json` and `.nsolid/assets/` for the same baseline asset ID. If it is already present locally, skip the download.
6. If the baseline asset is not present, save it locally:
   ```
   node "<skill-dir>/fetch-asset.cjs" <baselineAssetId> heapprofile <appName>
   ```

### Phase 2: Monitor RSS and Heap Growth
1. Call `metrics-historic` with `field: ["rss", "heapUsed", "heapTotal", "loopEstimatedLag"]`, `q: "app=<appName>"` or `q: "id=<id>"`, and `start: "1h"`.
2. Search for the "Sawtooth Pattern" (normal garbage collection) vs "Staircase Pattern" (unreleased memory).
3. Identify the moment where `heapUsed` stops dropping to its original baseline.

### Phase 3: Capture the Peak / Leak State
1. Once you confirm memory has substantially grown from the baseline, trigger a second analysis.
2. Use advanced `track-heap-objects` only for closure/retainer suspicion; otherwise use `heap-sampling` for 60 seconds. Both require the resolved agent `id`.
3. Wait for the operation to complete:
   ```
   node "<skill-dir>/wait.cjs" 60
   ```
   Then call `asset-summary` on the peak asset ID. If not ready, run `node "<skill-dir>/wait.cjs" 10` and retry; use `assets-in-progress` only as a secondary queue clue. Cap retries at **12**; if still not ready, report the peak asset ID and its pending state instead of continuing indefinitely.
4. Analyze the `asset-summary`.
5. Check `.nsolid/assets/index.json` and `.nsolid/assets/` for the same peak asset ID. If it is already present locally, skip the download.
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
4. Only after user approval, propose an optimized rewrite and use the `ns-validate-optimization` skill to verify the fix.

### Phase 6: Write a Report
1. Compose the full report as markdown using this structure:
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

### 7. Write the Report to Disk
- Ask the user if they want to save the report to disk.
- If the user confirms, write the final report as a markdown file (`.md`) under `.nsolid/assets/` — for example `.nsolid/assets/memory-analysis-<appName>.md`.

## Guardrails
- **No early assumptions**: Never declare a memory leak from a single snapshot. Always compare baseline to peak.
- **Reuse what exists**: Do not capture a new baseline or peak sample if the user already supplied the needed assets.
- **Wait times**: Memory tools block the thread. Do not spam endpoints while an asset is in progress.