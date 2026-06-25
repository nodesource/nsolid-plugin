---
name: ns-analyze-event
description: >-
  Investigates an existing N|Solid event payload and correlates relevant MCP evidence. Use when the user provides or references an event such as process-blocked, new-vulnerability-found, agent-exit, uncaught exception, stack trace, span data. Routes follow-up to CPU, memory, vulnerability, or tracing workflows when needed.
---

### 1. Parse the Event
- Extract these fields first: `event`, `type`, `severity`, `app`, `agent`, `time`, and `args`.
- If `args` is a JSON string, parse it before doing anything else.
- If `args` already include a stack trace, span data, trace identifiers, or other direct evidence, analyze that payload before reaching for more MCP tools.
- Identify whether the event is best treated as performance, security, lifecycle, or error oriented.

### 2. Branch by Event Type
- Performance events such as `process-blocked`, event loop lag, and high CPU:
  - Call `metrics-historic` with `field: ["cpuUserPercent", "heapUsed", "loopEstimatedLag"]`, `q: "app=<app>"` or `q: "id=<agent>"`, and `start`/`end` around the event time.
  - Call `assets` to look for nearby profiles or snapshots.
  - If relevant assets exist, prefer `asset-summary`.
- Security events such as `new-vulnerability-found`:
  - Call `vulnerabilities` for the affected application.
  - Call `application-packages` to identify the loaded package versions.
- Lifecycle events such as `agent-exit` or repeated restarts:
  - Call `events-historic` with the same `app` or agent `id`, plus `start`/`end` around the event time.
  - Call `metrics-historic` with explicit `field` and `q` before the event to spot resource spikes.
- Error events such as uncaught exceptions:
  - Parse `args.stack`.
  - If the agent is still connected and you have `id`, `threadId`, `scriptId`, and `path`, call `runtime-code`; a plain stack trace alone is not enough.

### 3. Recommend the Right Next Step
- If the issue needs deeper work, point to the most relevant follow-up skill: `ns-cpu-spike-analysis`, `ns-memory-spike-analysis`, `ns-analyze-vulnerabilities`, or `ns-analyze-tracing`.

### 4. Present the Result
- Structure the final answer around:
  1. Summary of what happened.
  2. Evidence inspected from the event payload and any MCP calls.
  3. Root cause hypothesis.
  4. Most pragmatic next step.

### 5. Write the Report to Disk
- Ask the user if they want to save the report to disk.
- If the user confirms, write the final report as a markdown file (`.md`) under `.nsolid/assets/` — for example `.nsolid/assets/event-analysis-<appName>-<classification>.md`.

## Guardrails
- Do not give a generic answer before checking the event type and the relevant MCP evidence.
- Do not ask for a new capture until you have checked whether assets already exist.
- Do not ignore stack, trace, or span data that is already present in the event payload.
- If the event lacks enough data, say exactly what is missing.
