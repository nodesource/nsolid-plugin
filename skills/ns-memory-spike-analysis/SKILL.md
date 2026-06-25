---
name: ns-memory-spike-analysis
description: >-
  Diagnoses memory growth, heap spikes, RSS increases, OOMs, and suspected leaks in Node.js apps using supplied heap evidence or N|Solid heap sampling/snapshots. Use when the user reports memory leak, heap growing, high RSS, out-of-memory, heap snapshot/profile analysis, or wants memory root-cause triage.
---

### 1. Use Provided Evidence First
- Parse the prompt for app name, agent ID, asset ID, local heap file path, heap summary, constructor table, retained-size output, or OOM context before calling tools.
- If the user already provided an asset ID, local file path, or structured heap summary, analyze that evidence first instead of starting with `metrics-historic`.
- If the prompt is a telemetry alert for a specific app, use that as the starting signal for live analysis of that same app.
- If the user explicitly says read-only, offline, or "analyze this file", do not capture a new heap asset unless they later approve it.

### 2. Find the Bottleneck Only If You Still Need a Target
- If no agent `id` is known, call `information-dashboard` (`q: "app=<appName>"`, `start: "5m"` when app is known) and preserve the exact app name.
- Call `metrics-historic` with `field: ["heapUsed", "heapTotal", "rss"]`, `q: "app=<appName>"` or `q: "id=<id>"`, and `start: "5m"`.
- Identify the agent `id` consistently growing in memory.
- Skip this step when the provided evidence already names the exact asset, process, or local file to inspect.

### 3. Reuse Existing Assets Before Capturing
- If the prompt includes an asset ID, call `asset-summary` first.
- If the prompt includes a local `.heapprofile` or `.heapsnapshot` path, resolve it to its asset ID (via `assets` or the download index) and analyze via `asset-summary`. **Never read the raw heap file into context** — it is large and token-wasteful.
- If the current evidence is already enough to identify the culprit, explain it and stop there. Do not capture a second asset unless the user asks.

### 4. Capture Memory Data Only With Missing Evidence or User Approval
- **Preferred (Low Overhead)**: Call `heap-sampling` on the `id` (`duration: 30`; optional `sampleInterval`/`stackDepth`; `threadId: 0` for main thread).
- **Alternative (Full Freeze)**: Call `snapshot` on the `id` (`threadId: 0` for main thread). Only use if explicitly requested.
- Capture only when no reusable evidence was provided and the user approves, unless the prompt is an explicit live alert/investigation.

### 5. Wait (Critical)
Run the bundled wait script (use the absolute path of the directory where you read this SKILL.md). Memory operations are blocking — wait the exact duration you passed, never estimate.
- For `heap-sampling`:
  ```
  node "<skill-dir>/wait.cjs" 30
  ```
- For `snapshot`, wait at least 40 seconds before checking summarization:
  ```
  node "<skill-dir>/wait.cjs" 40
  ```

### 6. Monitor Asset Generation
- For `heap-sampling`, call `asset-summary` on the exact Asset ID after waiting.
- For `snapshot`, call `asset-summary` on the exact Asset ID first.
- If a snapshot summary is still being generated, use `assets-in-progress`, run `node "<skill-dir>/wait.cjs" 5` in short intervals, then retry `asset-summary`.
- Do not use `assets-in-progress` as the first check for heap-sampling assets.

### 7. Summarize the Profile
- Call `asset-summary` with your Asset ID.
- **Critical for full snapshots**: For `heap-sampling`, the summary usually returns immediately after the wait. For `snapshot` assets, the first `asset-summary` call may only trigger asynchronous summarization (HTTP 202). In that case, monitor readiness briefly and retry `asset-summary`.
- Once `asset-summary` succeeds, analyze that summary directly. Do not answer that telemetry alone is insufficient after a successful heap summary.

### 8. Save the Full Asset
- Use the app name recorded from the prompt or discovery; `asset-summary` does not include app metadata.
- Download the asset with the bundled script (use the absolute path of the directory where you read this SKILL.md):
  ```
  node "<skill-dir>/fetch-asset.cjs" <assetId> <assetType> <appName>
  ```
- Use `<assetType>` `heapprofile` for `heap-sampling` assets.
- Use `<assetType>` `heapsnapshot` for `snapshot` assets.
- The script is idempotent and will reuse an existing local download when possible.

### 9. Identify the Culprit
- Look for the constructor or function allocating the largest chunks of memory in the `asset-summary` output. Explain your findings to the user.
- If the current evidence is insufficient to isolate the allocator, say exactly what specific constructor, retaining path, or retained-size detail is still missing from the summary.

### 10. Present the Result
- Structure the final answer around:
  1. Summary of the memory issue.
  2. Top allocators / constructors from the summary.
  3. Root cause hypothesis.
  4. Recommendation.
  5. Full asset reference if downloaded.

### 11. Write the Report to Disk
- Ask the user if they want to save the report to disk.
- If the user confirms, write the final report as a markdown file (`.md`) under `.nsolid/assets/` — for example `.nsolid/assets/memory-analysis-<appName or date>.md`.

### 12. For Elusive or Recurring Leaks
- If the leak shows a staircase pattern, retainers, or closures, consider using the `ns-advanced-memory-leak-hunter` skill for multi-phase baseline-vs-peak delta analysis.

## Guardrails
- Respect strict wait times. Memory operations are blocking and slow.
- Do not turn a user-supplied asset review into a fresh capture workflow unless the user asked for that or approved it.
- Prioritize `heap-sampling` over `snapshot` to minimize production impact.
- After a successful `asset-summary`, analyze that summary instead of falling back to a generic telemetry-only conclusion.
