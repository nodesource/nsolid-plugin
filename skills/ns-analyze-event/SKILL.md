---
name: ns-analyze-event
description: >-
  Investigates an existing N|Solid event or N|Solid alert and correlates the relevant evidence from N|Solid. Use when the user provides or references an event or alert such as a blocked event loop, a process exit or crash, an uncaught exception, a new vulnerability, a new package behavior, a stack trace, or span data. Routes follow-up to CPU, memory, vulnerability, or tracing workflows when needed.
---

This skill reads N|Solid data through the N|Solid MCP server (`nsolid`). The N|Solid tools take a `tenant`: when the token can use one tenant it is the default; otherwise call `list_tenants` once and use the tenant the event or user names.

### 1. Parse the Event
- Recognize the payload's shape before anything else:
  - **An N|Solid alert notification** (a webhook body, or a Slack, Teams or PagerDuty message made from one): `event` (`firing`, `resolved`), `alert.rule`, `alert.severity`, `alert.summary`, `alert.group` (the `agentId` or `app`), `alert.value`, `alert.since`, `alert.fingerprint`, `alert.evidence`.
  - **An N|Solid agent event** (from `list_events`): `type` (`loop_blocked`, `loop_unblocked`, `exit`, `lost`, `connect`, `disconnect`, `reconfigure`, `packages_changed`), `agentId`, `app`, `ts`, `blockedForMs`, `exitCode`, `exitSignal`, `error`, `frames`. A `lost` event marks a process that went away without an exit (SIGKILL, the out-of-memory killer, its host lost), placed when it was last heard from, 15 minutes before it was declared lost.
  - **An N|Solid console event**: `event`, `type`, `severity`, `app`, `agent`, `time`, and `args`. If `args` is a JSON string, parse it before doing anything else.
- If the payload already includes a stack trace, span data, trace identifiers, or other direct evidence, analyze that payload before reaching for more tools.
- For an alert, `get_alert` with its `fingerprint` gives the event that fired it, the diagnostic the rule took (a CPU profile, heap sampling or snapshot, with its `assetId`), the continuous profiles kept around it (`kept`), and its history.
- Identify whether the event is best treated as performance, security, lifecycle, or error oriented.

### 2. Branch by Event Type
- **Performance** (a blocked event loop, event loop lag, high CPU; console `process-blocked`):
  - Call `event_stacks` with the `agentId` or `app` and `from`/`to` around the event: where the loop blocked, grouped by frame, with how often and how long.
  - Call `query_metric` for `cpu_percent`, `loop_estimated_lag` and `used_heap_size` with `agentIds: ["<agentId>"]` (a list) or `app`, and `from`/`to` around the event time.
  - Call `list_assets` with the `agentId` for nearby profiles, the alert's diagnostic and continuous profiles included. If one covers the event, read it with `profile_hotspots` (CPU) or `heap_summary` (heap).
- **Security** (a finding alert; console `new-vulnerability-found`):
  - Call `list_vulnerabilities` for the affected app.
  - Call `get_vulnerability` with the advisory: the installed copies, whether each was loaded, and the dependency chain that brought it in.
- **New behavior** (a behavior alert: a package that newly runs programs, compiles code, uses the network, starts threads or touches files; a release regression; dependency drift):
  - Call `list_behaviors` for the app. A regression's release comparison is in `compare_releases`; a new capability or drift in a dependency may be a supply-chain problem, so hand it to `ns-analyze-vulnerabilities`.
- **Lifecycle** (an exit, a disconnect, repeated restarts; console `agent-exit`):
  - Call `list_events` with the same `app` or `agentId`, `types: ["exit", "lost", "disconnect"]` and `from`/`to` around the event.
  - Call `list_ended_processes` with the `app`: how each process ended (an exit code and signal, an abort, or lost without a word), how long it lived, and its peaks. `get_agent` gives one process's exit error and stack.
  - For "how often", `event_histogram` with the `app` and `types: ["exit", "lost"]` counts them per bucket over a day or a month: one restart, or a crash loop.
  - A lost process left no exit: look at its last minutes instead (`query_metric` for `rss` and `used_heap_size` with `agentIds: ["<agentId>"]`, up to its last report). Memory climbing to the end suggests the out-of-memory killer.
  - Call `query_metric` with explicit metrics (`used_heap_size`, `rss`, `cpu_percent`) and `agentIds: ["<agentId>"]` before the event to spot resource spikes. Running out of memory shows as an abort (`SIGABRT`) with the heap at its limit.
- **Errors** (an uncaught exception, an exit with a stack):
  - Parse the stack (`error` and `frames`, or console `args.stack`).
  - `event_stacks` with `type: "exit"` and the `app` groups exits by stack: whether the same error keeps killing processes.
  - Read the stack's **user-owned** frames in the workspace first, with the bundled helper (use the absolute path of the directory where you read this SKILL.md):
    ```
    node "<skill-dir>/workspace-delta.cjs" <json-file-or-stdin>
    ```
    with `{"targetAppName": "<app>", "runtimePath": "<the frame's script>", "lineHint": <its line>, "contextLines": 40}`. It checks the workspace is that app and maps container paths such as `/app/server.js` to workspace files. `event_stacks` gives the latest process's main module (`latest.main`), which shows where the app was deployed.
  - Only when the workspace isn't the app and the process still runs, call `get_source_code` with the `agentId`, `path` and `line`; a plain stack trace alone is not enough to fetch code. It is offered only with N|Solid's source-code permission, an admin one, on a tenant where the source viewer is on, and never over a browser sign-in to the MCP server (a sign-in carries read and operate permissions at most). When the tool is missing or refuses, say which (a sign-in, no permission, or the feature is off for the tenant) and ask for the file or read it from the checkout instead.

### 3. Recommend the Right Next Step
- If the issue needs deeper work, point to the most relevant follow-up skill: `ns-cpu-spike-analysis`, `ns-memory-spike-analysis`, `ns-analyze-vulnerabilities`, or `ns-analyze-tracing`.

### 4. Present the Result
- Structure the final answer around:
  1. Summary of what happened.
  2. Evidence inspected from the event payload and any tool calls.
  3. Root cause hypothesis.
  4. Most pragmatic next step.

### 5. Write the Report to Disk
- Ask the user if they want to save the report to disk.
- If the user confirms, write the final report as a markdown file (`.md`) under `.nsolid/assets/` — for example `.nsolid/assets/event-analysis-<appName>-<classification>.md`.

## Guardrails
- Do not give a generic answer before checking the event type and the relevant evidence.
- Do not ask for a new capture until you have checked whether assets already exist, the alert's diagnostic included.
- Do not ignore stack, trace, or span data that is already present in the event payload.
- Never fetch or present dependency or Node.js-internal source as the code to fix; read user-owned frames, from the workspace first.
- If the event lacks enough data, say exactly what is missing.
