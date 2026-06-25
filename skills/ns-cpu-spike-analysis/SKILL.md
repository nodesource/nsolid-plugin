---
name: ns-cpu-spike-analysis
description: >-
  Diagnoses high CPU or slow execution in a Node.js app using supplied evidence or N|Solid CPU metrics/profiles. Use when the user reports CPU spike, high CPU percent, slow endpoint/function, event loop blocking, flamegraph/profile analysis, hot loop, or asks why an app is slow. Prefer existing asset IDs, summaries, trace data, or local profiles before capturing a new profile.
---

### 1. Use Provided Evidence First
- Treat the prompt content as primary evidence. Parse any provided app name, agent ID, hostname, time window, asset ID, local file path, CPU summary, flamegraph excerpt, hot function list, or stack trace before calling tools.
- If the prompt already includes an asset ID, local `.cpuprofile` path, or structured CPU summary, analyze that evidence first instead of starting with `information-dashboard` or `metrics-historic`.
- If the prompt is a telemetry alert such as "CPU spike 121.1% in app X", use that app name as authoritative scope and immediately run the live workflow: identify the hottest connected agent inside that app, capture a 30-second CPU profile, summarize it, download it, and fetch runtime code when possible.
- In telemetry-alert mode, do not stop after rediscovering the same spike and do not ask for capture approval unless the prompt explicitly says read-only, offline, or no-capture.
- If the user explicitly says read-only, offline, or "analyze this data", never capture a new profile unless they later approve it.

### 2. Discover Connected Agents Only When Needed
- Call `information-dashboard` (no parameters) to list all connected agents.
- Note each agent's `id`, `app` name, and `hostname`.
- Skip this step when the provided evidence already names the exact agent or already includes a CPU profile asset or local file.
- If the user already named a specific app, treat that app name as authoritative.
- When an alert, warning, or telemetry card names an app, do NOT switch to a different app just because it has higher CPU elsewhere.
- If the prompt names a worker, hostname, or process hint, prefer the matching agent inside that same app.

### 3. Find the Bottleneck Only If You Still Need a Target
- If the user named a specific app, call `metrics-historic` with `field: ["cpuUserPercent", "cpuSystemPercent"]`, `q: "app=<appName>"`, and `start: "5m"`; choose the hottest connected agent inside that app only.
- If no app was named, call `metrics-historic` with those fields and `start: "5m"` to identify the highest-CPU agent `id`.
- If a telemetry warning included a recent spike value or timeframe, bias the query window around that warning instead of doing a generic search.
- If no agent for the named app is connected, stop and say that clearly instead of profiling a different app.
- If the user already supplied a usable profile, asset summary, or local file, skip this step.
- When several agents are connected for the same app, choose the agent with the highest recent CPU inside that app. Record its `id`, `hostname`, and the CPU evidence that justified the choice.

### 4. Reuse Existing Assets Before Capturing
- If the prompt includes an asset ID, call `asset-summary` first.
- If the prompt includes a local `.cpuprofile` path, resolve it to its asset ID (via `assets` or the download index) and analyze via `asset-summary`. **Never read the raw `.cpuprofile` into context** — it is large and token-wasteful.
- If you can identify the bottleneck from the supplied evidence, stop there and explain it. Do not capture a second profile unless the user asks.

### 5. Capture a 30-Second Profile
- Call `profile` on that `id` with `duration: 30` and `threadId: 0`.
- Note the returned `id` (Asset ID).
- Only skip this capture when the prompt already supplied a reusable CPU profile, asset summary, or local `.cpuprofile`, or when the user explicitly requested read-only/offline analysis.
- For telemetry-alert mode, this 30-second profile capture is the default path.

### 6. Wait (Critical)
- After starting the standard 30-second CPU profile, run the bundled wait script so the capture has time to finish and upload:
  ```
  node "<skill-dir>/wait.cjs" 35
  ```
  (use the absolute path of the directory where you read this SKILL.md).
- If you used a different profile duration, wait that duration plus 5 seconds.
- Do NOT use `setTimeout`, `sleep`, or estimate the wait yourself — always run `wait.cjs`.

### 7. Check Readiness Using the Exact Asset ID
- Call `asset-summary` using the exact Asset ID returned by `profile`.
- If `asset-summary` says the asset is not ready yet, run `node "<skill-dir>/wait.cjs" 5` and retry `asset-summary` on that same Asset ID.
- Retry at most 2 short waits after the initial 35-second wait. If the asset is still not ready, explain that clearly rather than looping indefinitely.
- Do NOT use `assets-in-progress` as the normal readiness check for CPU profiles. It is a global queue and may report unrelated assets.

### 8. Summarize the Profile
- Once `asset-summary` succeeds, use its token-optimized JSON view as the grounded source for the rest of the workflow.
- Do not stop after `asset-summary`; continue the workflow with full profile download and runtime code extraction.

### 9. Save the Full Profile
- Use the app name recorded from the prompt or discovery; `asset-summary` does not include app metadata.
- Download the profile with the bundled script (use the absolute path of the directory where you read this SKILL.md):
  ```
  node "<skill-dir>/fetch-asset.cjs" <assetId> cpuprofile <appName>
  ```
- The script is idempotent: if the asset is already present in `.nsolid/assets/index.json`, it reuses the existing file without re-downloading.
- Do NOT use direct HTTP calls or `curl`. The bundled `fetch-asset.cjs` is the only supported download path inside this skill.
- The script writes to `.nsolid/assets/cpuprofile-<appName>-<assetIdPrefix>.cpuprofile` and updates the index automatically.

### 10. Identify the Culprit
- Analyze the summary JSON or local profile data. Identify the function (`functionName`), `scriptId`, and file path (`url`) consuming the highest `totalTime` or `selfTime`. Explain this to the user.
- Focus the diagnosis on the hottest relevant **user-owned** frame.
- If the top cost is in Node internals or a dependency, report that clearly as evidence, but walk down or up the hot path to the nearest meaningful user-owned caller so the user gets an actionable explanation.
- If a dependency is causing the cost, explain how the user's code is invoking it, feeding it, or calling it too often. Do not treat dependency source as the optimization target.
- If the current evidence is insufficient to isolate a function, say exactly what is missing instead of pretending you have a bottleneck.

### 11. Extract Runtime Code
- After identifying the hottest relevant **user-owned** frame, call `runtime-code` only when you have agent `id`, `threadId`, `scriptId`, and `url`/`path`.
- Prefer the hottest non-internal application frame. If the top frame is V8 or Node internals, walk down to the hottest frame that points to the user app.
- NEVER fetch or present runtime code for Node internals or dependency code. If the hottest frame is under `node_modules`, `node:`, or internal runtime paths, explain the dependency/internal cost and move to the nearest relevant user-owned caller instead of extracting dependency source.
- The `runtime-code` response is raw source material. Before presenting it in the report, keep only the most relevant parts needed to explain the CPU problem in the app and to ground the optimization proposal.
- Include the hot function and any nearby helpers, branches, loops, constants, or call sites that materially affect the bottleneck.
- Exclude unrelated module setup, imports, exports, sibling functions, or large sections of the file that do not help explain the issue.
- Do not force an artificially tiny excerpt. Keep enough surrounding context to make the diagnosis and recommendation understandable.
- Retry up to 2 times with path tweaks if the first call fails:
  - Try stripping a leading `/app` or `/usr/src/app` Docker prefix.
  - Try removing a leading path segment one level at a time.
  - If still failing after 2 tweaks, skip and proceed to step 12 with a note that runtime code was unavailable.
- **Edge cases**:
  - If `scriptId` is `0`, skip this step entirely — extraction will fail.
  - If the process is Dockerized, the `path` may be misaligned; apply the path tweaks above before giving up.

### 12. Compare Runtime Code to Workspace Source
- Prefer the `workspace_delta` tool when it is available. Pass the profiled app name, runtime path, runtime code, and the best line range or line hint you have for the hot function.
- If `workspace_delta` reports that the workspace does not match the profiled app, skip comparison and state that clearly in the report.
- If `workspace_delta` is unavailable but shell execution is allowed, use the bundled same-directory helper:
  ```
  node "<skill-dir>/workspace-delta.cjs" <json-file-or-stdin>
  ```
  It accepts JSON via stdin or a file path and prints the comparison result as JSON.
- If neither the tool nor the bundled helper is available, perform a conservative manual fallback: verify that the current workspace corresponds to the target app before comparing any local code, and skip comparison if identity is uncertain.
- Only attempt this step for user-owned application code. If the hot frame is a dependency or Node internal path, skip comparison and say that the performance issue originates outside user-owned source.
- If the file maps cleanly to the workspace, compare the local copy to the runtime version. Note real differences such as added logic, removed guards, changed thresholds, or refactors.
- Include a "Workspace Delta" section in the final report with the actual diff content when a comparison was possible.
- If the file does not map to a local workspace file, or app identity could not be proven safely, say so explicitly instead of guessing.

### 13. Present the Full Report
- Structure the final report with these sections:
  1. **Executive Summary** — one paragraph stating the CPU problem and root cause.
  2. **Top CPU Consumers** — table with: `functionName`, `file:line`, `selfTime`, `totalTime`.
  3. **Hot Call Path** — the function call chain leading to the bottleneck.
  4. **Runtime Code** — the most relevant extracted source from step 11 (or a note if unavailable), not the whole fetched file or module. This section must contain only user-owned application code. If the hottest cost is in a dependency or Node internals, replace this section with a short note that user-owned runtime code could not be extracted for that hotspot and explain the nearest relevant user-owned caller instead. Wrap the code block with these exact HTML comment markers so the host extension can locate it:
     ```
     <!-- nsolid-ide-runtime-code-start -->
     ```language
     <relevant source here>
     ```
     <!-- nsolid-ide-runtime-code-end -->
     ```
  5. **Workspace Delta** (if applicable from step 12) — local vs. runtime diff and analysis.
  6. **Root Cause** — the specific reason this code is expensive (algorithmic, I/O, serialization, etc.).
  7. **Recommendation** — concrete fix advice with code-level specifics when possible. When a dependency is the main cost source, recommend changes in the user's call pattern, batching, caching, input size, or library choice. Do not recommend rewriting dependency source.
  8. **Profile Reference** — the saved `.cpuprofile` path from step 9.
- End the report with a structured metadata comment on its own line so the host extension can drive the followup flow. Use workspace-relative forward-slash paths and 1-indexed inclusive line numbers:
  ```
  <!-- nsolid-ide-hotfn: {"file":"src/foo.ts","startLine":42,"endLine":80,"name":"parseToken"} -->
  ```
  If the hot function could not be mapped to a workspace file (Workspace Delta reported "file exists in runtime but not in workspace"), omit the marker entirely rather than emit a placeholder.

### 14. Write the Report to Disk
- Ask the user if they want to save the report to disk.
- If the user confirms, write the final report as a markdown file (`.md`) under `.nsolid/assets/` — for example `.nsolid/assets/cpu-analysis-<appName>-<YYYY-MM-DD>.md`.

### 15. Validate the Fix
- The host extension presents followup buttons after the report. When the user clicks "Continue with optimization & benchmark", the extension invokes the `ns-validate-optimization` skill with this report in scope. Those followups are for actionable user-owned code only. Do not ask a human-in-the-loop question in this response — the buttons replace it.

## Guardrails
- NEVER call `global-filter` as a discovery step — it returns ~18,000 tokens and fills the context window.
- NEVER drift to a different app when the user or alert already identified the affected app.
- NEVER ask for capture approval on a telemetry alert unless the user explicitly requested read-only/offline behavior.
- NEVER call discovery tools only to restate the same app and spike value the user already provided; continue to the target-agent selection and profile.
- ALWAYS wait via the bundled `wait.cjs` script, never `setTimeout`/`sleep` or an estimate. Download assets via the bundled `fetch-asset.cjs` (do not use direct HTTP calls or curl). The only other shell helper allowed by this skill is the bundled same-directory `workspace-delta.cjs`.
- NEVER paste the entire `runtime-code` response when only part of it is relevant. Keep the report focused on the code that explains the problem and proposed fix.
- NEVER fetch or present dependency or Node-internal source as the code to optimize. Treat those frames as evidence, then explain the nearest relevant user-owned caller instead.
- If you do not wait long enough with `wait.cjs`, `asset-summary` may still report that the profile asset is not ready.
- A fix is not a fix until it is proven by benchmarking.
