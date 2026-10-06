---
name: ns-analyze-logs
description: >-
  Searches and analyzes the logs N|Solid keeps from Node.js apps (nsolid.logger and OpenTelemetry logs): errors and warnings by app, process, text or severity, a request's logs (by its trace, for OpenTelemetry logs), and how they line up with exits, blocked loops and slow traces. Use when the user asks what an app logged, to find errors in production logs, what happened around an incident, or for the logs of a specific request or trace.
---

This skill reads logs through the N|Solid MCP server (`nsolid`). The N|Solid tools take a `tenant`: when the token can use one tenant it is the default; otherwise call `list_tenants` once and use the tenant the user names.

N|Solid keeps logs for 14 days by default. Apps send them through the N|Solid logger (`nsolid.logger`) or an OpenTelemetry SDK. Only OpenTelemetry logs carry trace and span ids: `nsolid.logger` lines have none yet, so they are found by process and time rather than by trace.

### 1. Search
- `search_logs` (newest first) with the time range (`from`, `to`; default the last hour) and what narrows it:
  - `query`: text in the message;
  - `severity`: the least severe to include (e.g. `warn`);
  - `agentId`: one process (`find_agents` finds them by app or host);
  - `traceId`: one request's logs (OpenTelemetry logs only);
  - `where`: an expression, e.g. `level >= "error" && service == "checkout"`, `body.contains("ECONNREFUSED")`, `attr["http.route"] == "/orders"` (`expression_help` with context `log` lists the fields).
- Start narrow (an app, errors, the incident's window) and widen only as needed.

### 2. Correlate
- **A request:** for a slow or failing request, find its trace with `search_spans` (`ns-analyze-tracing`), then `search_logs` with its `traceId` for OpenTelemetry logs; for `nsolid.logger` lines, search the span's process (`agentId`) over the span's start and duration. `get_trace` shows the calls around them.
- **A crash or restart:** `list_events` with `types: ["exit"]` and the process or app gives the exit's code, signal and error; the logs just before it in the same process tell what led up to it.
- **A blocked loop:** `event_stacks` shows where the loop blocked; logs from the same process at that time show what it was doing.
- **A spike:** `query_metric` (`cpu_percent`, `used_heap_size`, `http_server`) over the same window shows whether the logs line up with a resource change.

### 3. Analyze
- Group repeated messages and count them; name the first occurrence and whether it is still happening.
- Separate the cause from its echoes: the first error in a burst, not the hundred retries after it.
- For an error with a stack in the user's code, read the frame in the workspace (the deploy prefix such as `/app` is the app's root).

### 4. Present the Result
- `# Log Analysis — <app or incident>`
- `## Summary`, `## Evidence` (the key log lines, quoted briefly, with times and processes), `## Findings`, `## Next steps`.
- Quote only the lines that matter; never paste a long log dump.

### 5. Write the Report to Disk
- Ask the user if they want to save it.
- If the user confirms, write it as markdown under `.nsolid/reports/`, for example `.nsolid/reports/logs-<app>-<date>.md`.

## Guardrails
- Logs can hold personal data and secrets: quote the minimum, and never copy them into other systems.
- No logs for an app may only mean it doesn't send its logs to N|Solid: say so rather than concluding nothing happened.
