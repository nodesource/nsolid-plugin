---
name: ns-configure-agents
description: >-
  Changes how N|Solid agents run, safely: tracing on or off, continuous CPU profiling, the metrics interval, the blocked-loop threshold, trace sampling, snapshot redaction, tags. Use when the user wants tracing turned on for an app, continuous profiling for a while, a different metrics interval, or asks why a process has a setting. Previews every change, prefers changes that expire, and explains where each running value came from.
---

This skill works through the N|Solid MCP server (`nsolid`). The N|Solid tools take a `tenant`: when the token can use one tenant it is the default; otherwise call `list_tenants` once and use the tenant the user names. Changing configuration needs the `nsolid:dynamic-configuration` permission; without it the change tools are missing, and the skill can still explain and preview.

N|Solid keeps agents at **desired configs**: each targets processes by an expression (or an app, tags or one agent), has a priority, and can expire. Processes started later get them too, and N|Solid confirms each change from the agent's own report. That beats changing one process once, which a restart forgets.

### 1. Understand What Runs Now
- `list_desired_configs`: the configs the tenant keeps, with their targets, settings and priority; ones with `expiresAt` are temporary overrides.
- `agent_config` with an `agentId`: what that process reports, what it should have and which config set each key, what is still to apply, and whether it has converged. Use it to answer "why does this process have that setting?"

### 2. Shape the Change
- Settings: `tracingEnabled`, `traceSampleRate` (0 to 1), `contCpuProfile` (continuous CPU profiling), `interval` (metrics, ms), `blockedLoopThreshold` (ms), `pauseMetrics`, `promiseTracking`, `redactSnapshots`, `assetsEnabled`, `tags`.
- Target: `app`, `tags`, one `agentId`, or `where`, an expression over what a process is (`app == "checkout" && hostname.endsWith(".prod")`, `nodeVersion >= "22"`; `expression_help` with context `selector` lists the fields). Every process of the tenant needs `allAgents: true` and the user's explicit agreement.
- **Prefer an expiring override** for anything diagnostic: `expiresInMinutes` makes it stop applying, and the processes go back to what they had. Tracing or continuous profiling "for the next hour" is an override of 60 minutes.
- `priority`: higher wins where configs disagree.
- Names use letters, digits, `.`, `_` and `-`: `checkout-tracing-1h`.

### 3. Preview
- `preview_desired_config` with the same inputs: how many connected processes match and which would change, without saving. Show it to the user.
- Call out what the change costs or stops: tracing and continuous profiling add overhead; turning off metrics, tracing or assets stops that data; `redactSnapshots: false` makes later heap snapshots carry the application's strings, which can include secrets and personal data.

### 4. Apply
- With the user's agreement, `set_desired_config`. Connected processes are reconfigured now, new ones when they connect.
- Check it took effect: `agent_config` on one of the processes shows whether it converged.
- `reconfigure_agent` changes one running process once; N|Solid sets back any key a desired config manages, and a restart forgets it. Use it only when the user wants exactly that.

### 5. Undo
- An override ends by itself. To end a config sooner, or remove a permanent one, `delete_desired_config` with its name, with the user's agreement: processes go back to what their own startup settings and the remaining configs give them.

### 6. Present the Result
- What changed, on which processes (count and app), until when, and how to undo it; or, for a question, which config set the value and why.

## Guardrails
- Never save, change or delete a config without showing the preview and getting the user's agreement.
- Never target every process (`allAgents: true`) unless the user asked for exactly that.
- Never turn off `redactSnapshots`, metrics or assets without spelling out the consequence first.
- Prefer expiring overrides for diagnostics, so nothing stays switched on by accident.
