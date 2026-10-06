---
name: ns-cpu-spike-analysis
description: >-
  Diagnoses high CPU or slow execution in a Node.js app using supplied evidence or N|Solid CPU metrics and profiles from N|Solid. Use when the user reports CPU spike, high CPU percent, slow endpoint/function, event loop blocking, flamegraph/profile analysis, hot loop, or asks why an app is slow. Prefer existing asset IDs, summaries, trace data, or local profiles before capturing a new profile. Writes a self-contained HTML report with an interactive flame graph.
---

This skill reads N|Solid data through the N|Solid MCP server (`nsolid`)
and two bundled scripts. Both need the server's settings: `NSOLID_MCP_URL`,
`NSOLID_API_URL` and `NSOLID_API_TOKEN` in the environment, or
`~/.agents/.nsolid-auth.json` with `mcpUrl`, `apiUrl` and `token` (plus `tenant`
when the token can use several tenants).

### 1. Use Provided Evidence First
- Treat the prompt content as primary evidence. Parse any provided app name, agent ID, hostname, time window, asset ID, local file path, CPU summary, flamegraph excerpt, hot function list, or stack trace before calling tools.
- If the prompt already includes an asset ID, local `.cpuprofile` path, or structured CPU summary, analyze that evidence first instead of starting with `fleet_snapshot` or `query_metric`.
- If the prompt is a telemetry alert such as "CPU spike 121.1% in app X", use that app name as authoritative scope and immediately run the live workflow: identify the hottest connected agent inside that app, capture a 30-second CPU profile, summarize it, write the report, download the profile, and read the hot function's code (from the workspace when it has it).
- In telemetry-alert mode, do not stop after rediscovering the same spike and do not ask for capture approval unless the prompt explicitly says read-only, offline, or no-capture.
- If the user explicitly says read-only, offline, or "analyze this data", never capture a new profile unless they later approve it.

### 2. Pick the Tenant
- The N|Solid tools take a `tenant`. When the token can use one tenant it is the default; otherwise call `list_tenants` once and use the tenant the user or alert names (production and staging are usually separate tenants). Pass the same tenant to every call, and set `NSOLID_TENANT` for the scripts.

### 3. Discover Connected Agents Only When Needed
- Call `fleet_snapshot` with `sort: "cpu_percent"` to list connected processes, hottest first, with their live metrics. When the user named an app, add `where: 'app == "<appName>"'`.
- Note each agent's `agentId`, `app`, `hostname` and `cpu_percent`.
- Skip this step when the provided evidence already names the exact agent or already includes a CPU profile asset or local file.
- If the user already named a specific app, treat that app name as authoritative. When an alert, warning, or telemetry card names an app, do NOT switch to a different app just because it has higher CPU elsewhere.
- If the prompt names a worker, hostname, or process hint, prefer the matching agent inside that same app.
- If a telemetry warning included a recent spike value or timeframe, `query_metric` with `metric: "cpu_percent"`, `app`, and `from`/`to` around it confirms which process spiked.
- If no agent for the named app is connected, stop and say that clearly instead of profiling a different app.
- When several agents are connected for the same app, choose the agent with the highest recent CPU inside that app. Record its `agentId`, `hostname`, and the CPU evidence that justified the choice.

### 4. Reuse Existing Assets Before Capturing
- If the prompt includes an asset ID, call `profile_hotspots` with it first.
- With continuous profiling on, profiles of the spike may already exist: `list_assets` with the `agentId` and `kind: "cpu_profile"`; one whose time covers the spike can be read with `profile_hotspots` instead of capturing.
- If the prompt includes a local `.cpuprofile` path, find its asset ID in `.nsolid/assets/index.json` and use `profile_hotspots`. **Never read the raw `.cpuprofile` into context**: it is large and token-wasteful.
- If you can identify the bottleneck from the supplied evidence, stop there and explain it. Do not capture a second profile unless the user asks.

### 5. Capture a 30-Second Profile
- Call `take_cpu_profile` with the `agentId`, `durationMs: 30000` and `threadId: 0`. It waits for the profile, and returns its `assetId` with the hottest functions and the CPU share by package.
- Only skip this capture when the prompt already supplied a reusable CPU profile, asset summary, or local `.cpuprofile`, or when the user explicitly requested read-only/offline analysis.
- If it answers that the agent is already profiling (continuous profiling is on), use its newest continuous profile from `list_assets` instead.
- If it answers that the profile is stored but not analyzed yet, call `profile_hotspots` with that `assetId` a few seconds later.
- For telemetry-alert mode, this 30-second profile capture is the default path.

### 6. Write the HTML Report
- Run the bundled report script (use the absolute path of the directory where you read this SKILL.md):
  ```
  node "<skill-dir>/render-cpu-report.cjs" <assetId> --app <appName> --artifact
  ```
- It reads the profile's flame graph and the process's CPU and heap around it from N|Solid, and writes `.nsolid/reports/cpu-<appName>-<date>-<assetIdPrefix>.html`: one file with an interactive flame graph (zoom, search), time by package, and the heaviest functions, which opens in any browser without network. With `--artifact` it also writes `<same name>.artifact.html`, the same page for hosts that add the document around a page.
- It prints a short JSON summary: `file`, `artifactFile`, `title`, `description`, busy and idle time, and the top functions. **Never read the HTML files into context**: the summary is all you need.
- If an Artifact tool is available, offer to publish `artifactFile` with it (with the printed `title` and `description`). Ask first, since publishing uploads the profile's data; an artifact starts private to the user.
- If the script reports that N|Solid is not configured, continue without the report and say how to configure it (the settings at the top of this skill).

### 7. Save the Full Profile
- Download the profile with the bundled script:
  ```
  node "<skill-dir>/fetch-nsolid-asset.cjs" <assetId> <appName>
  ```
- The script is idempotent: if the asset is already in `.nsolid/assets/`, it reuses the file without downloading it again. It writes `.nsolid/assets/cpuprofile-<appName>-<assetIdPrefix>.cpuprofile` and registers it in `.nsolid/assets/index.json`.
- Do NOT use direct HTTP calls or `curl`. The bundled scripts are the only supported download paths inside this skill.

### 8. Identify the Culprit
- Use the functions from `take_cpu_profile` or `profile_hotspots` (`function`, `package`, `location`, `selfPct`, `totalPct`). Ask `profile_hotspots` for `sort: "total"` to see the hot path's callers.
- Packages tell whose code it is: `(app)` is the application's own code, `(node)` Node.js internals, `(v8)` the engine (`(garbage collector)` is GC pressure), anything else an npm package and its version.
- Focus the diagnosis on the hottest relevant **user-owned** frame (`(app)`).
- If the top cost is in Node internals or a dependency, report that clearly as evidence, but walk down or up the hot path to the nearest meaningful user-owned caller so the user gets an actionable explanation.
- If a dependency is causing the cost, explain how the user's code is invoking it, feeding it, or calling it too often. Do not treat dependency source as the optimization target.
- If the current evidence is insufficient to isolate a function, say exactly what is missing instead of pretending you have a bottleneck.

### 9. Read the Hot Frame's Code
- Start from the hottest relevant **user-owned** frame (`(app)`). If the top frame is V8 or Node internals, walk down to the hottest frame that points to the user app.
- NEVER fetch or present code for Node internals or dependencies. If the hottest frame is under `node_modules`, `node:`, or internal runtime paths, explain the dependency/internal cost and move to the nearest relevant user-owned caller instead.
- **The workspace first.** When this workspace is the app's source, read the frame here. Run the bundled helper without runtime code:
  ```
  node "<skill-dir>/workspace-delta.cjs" <json-file-or-stdin>
  ```
  with `{"targetAppName": "<appName>", "runtimePath": "<the frame's location without :line>", "lineHint": <its line>, "contextLines": 40}`. It checks that the workspace is that app, maps the runtime path to a workspace file (stripping `/app` and other deploy prefixes), and returns the lines around the frame: `workspaceCode`, `resolvedWorkspacePath` and `lineRange`.
  - If the path doesn't map, the process's main module shows where the app was deployed: `get_agent` gives it as `info.main` (`/app/server.js` is `server.js` here). Pass the workspace-relative path as `workspaceRelativePath`.
  - Without shell access, do the same by hand: confirm the workspace is the app (`package.json` `name` or `nsolid.app`, or `NSOLID_APP` in its compose or env files), find the file, and read the lines around the frame.
  - The workspace may not be exactly what runs (another commit or build). Say so in the report when the running version isn't known to match.
- **Then the running process.** Only when the helper says the workspace isn't the app, or the file isn't in it, call `get_source_code` with the `agentId`, `path` (the frame's location without its `:line` suffix), `line` (its line) and `context: 80`. It reads the code out of the production process, and every read is in the tenant's audit log. It is offered only to people holding N|Solid's source-code permission (tenant admins by default) on a tenant where the source viewer is on. When the tool is missing or refuses, say which (no permission, or the feature is off for the tenant) and ask for the file or read it from the checkout instead. If it fails on the path, retry up to 2 times with path tweaks:
  - Try stripping a leading `file://`, `/app` or `/usr/src/app` prefix.
  - Try removing a leading path segment one level at a time.
  - If still failing after 2 tweaks, continue without the code and say it was unavailable.
- Before presenting it in the report, keep only the most relevant parts needed to explain the CPU problem and to ground the optimization proposal: the hot function and any nearby helpers, branches, loops, constants, or call sites that materially affect the bottleneck.

### 10. Compare Runtime Code to Workspace Source
- Only when step 9 read the code from the running process, so there is a runtime copy to compare. When it came from the workspace, skip this step.
- When shell execution is allowed, use the bundled same-directory helper. Pass the profiled app name, runtime path, runtime code, and the best line range or line hint you have for the hot function:
  ```
  node "<skill-dir>/workspace-delta.cjs" <json-file-or-stdin>
  ```
  It accepts JSON via stdin or a file path and prints the comparison result as JSON.
- If it reports that the workspace does not match the profiled app, skip comparison and state that clearly in the report.
- If the helper can't run, perform a conservative manual fallback: verify that the current workspace corresponds to the target app before comparing any local code, and skip comparison if identity is uncertain.
- Only attempt this step for user-owned application code. If the hot frame is a dependency or Node internal path, skip comparison and say that the performance issue originates outside user-owned source.
- If the file maps cleanly to the workspace, compare the local copy to the runtime version. Note real differences such as added logic, removed guards, changed thresholds, or refactors.
- Include a "Workspace Delta" section in the final report with the actual diff content when a comparison was possible.

### 11. Present the Full Report
- Structure the final report with these sections:
  1. **Executive Summary** — one paragraph stating the CPU problem and root cause.
  2. **Top CPU Consumers** — table with: `function`, `package`, `file:line`, `selfPct`, `totalPct`.
  3. **Hot Call Path** — the function call chain leading to the bottleneck.
  4. **Code** — the most relevant code from step 9 (or a note if unavailable), not the whole file, saying where it came from: the workspace (its path) or the running process. This section must contain only user-owned application code. If the hottest cost is in a dependency or Node internals, replace this section with a short note that user-owned code could not be shown for that hotspot and explain the nearest relevant user-owned caller instead. Wrap the code block with these exact HTML comment markers so the host extension can locate it:
     ```
     <!-- nsolid-ide-runtime-code-start -->
     ```language
     <relevant source here>
     ```
     <!-- nsolid-ide-runtime-code-end -->
     ```
  5. **Workspace Delta** (if applicable from step 10) — local vs. runtime diff and analysis.
  6. **Root Cause** — the specific reason this code is expensive (algorithmic, I/O, serialization, etc.).
  7. **Recommendation** — concrete fix advice with code-level specifics when possible. When a dependency is the main cost source, recommend changes in the user's call pattern, batching, caching, input size, or library choice. Do not recommend rewriting dependency source.
  8. **Flame Graph Report** — the HTML report's path from step 6, and the artifact link if one was published.
  9. **Profile Reference** — the saved `.cpuprofile` path from step 7, and the N|Solid asset ID.
- End the report with a structured metadata comment on its own line so the host extension can drive the followup flow. Use workspace-relative forward-slash paths and 1-indexed inclusive line numbers:
  ```
  <!-- nsolid-ide-hotfn: {"file":"src/foo.ts","startLine":42,"endLine":80,"name":"parseToken"} -->
  ```
  When step 9 read the code from the workspace, its `resolvedWorkspacePath` and `lineRange` give the file and lines. If the hot function could not be mapped to a workspace file (Workspace Delta reported "file exists in runtime but not in workspace"), omit the marker entirely rather than emit a placeholder.

### 12. Write the Report to Disk
- Ask the user if they want to save the written report to disk.
- If the user confirms, write the final report as a markdown file (`.md`) under `.nsolid/reports/`, for example `.nsolid/reports/cpu-analysis-<appName>-<YYYY-MM-DD>.md`, beside the HTML report.

### 13. Validate the Fix
- The host extension presents followup buttons after the report. When the user clicks "Continue with optimization & benchmark", the extension invokes the `ns-validate-optimization` skill with this report in scope. Those followups are for actionable user-owned code only. Do not ask a human-in-the-loop question in this response — the buttons replace it.

## Guardrails
- NEVER drift to a different app when the user or alert already identified the affected app.
- NEVER ask for capture approval on a telemetry alert unless the user explicitly requested read-only/offline behavior.
- NEVER call discovery tools only to restate the same app and spike value the user already provided; continue to the target-agent selection and profile.
- NEVER read `.cpuprofile` files or the HTML reports into context. The bundled scripts write them; their printed summaries are what you use.
- Download assets and write reports only with the bundled `fetch-nsolid-asset.cjs` and `render-cpu-report.cjs` (no direct HTTP calls or curl). The only other shell helper allowed by this skill is the bundled same-directory `workspace-delta.cjs`.
- NEVER publish a report as an artifact without asking: it uploads the profile's data.
- Read code from the workspace whenever it has the frame's file. `get_source_code` reads code out of a production process: use it only as the fallback in step 9.
- NEVER paste a whole file or the entire `get_source_code` response when only part of it is relevant. Keep the report focused on the code that explains the problem and proposed fix.
- NEVER fetch or present dependency or Node-internal source as the code to optimize. Treat those frames as evidence, then explain the nearest relevant user-owned caller instead.
- A fix is not a fix until it is proven by benchmarking.
