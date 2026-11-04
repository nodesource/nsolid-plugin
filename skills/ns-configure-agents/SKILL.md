---
name: ns-configure-agents
description: >-
  Changes how N|Solid agents run, safely: tracing on or off, continuous CPU profiling, the metrics interval, the blocked-loop threshold, trace sampling, snapshot redaction, tags. Use when the user wants tracing turned on for an app, continuous profiling for a while, a different metrics interval, asks why a process has a setting, or asks for a named config's history: who changed it and what it held before. Previews every change, prefers changes that expire, and explains where each running value came from.
---

This skill works through the N|Solid MCP server (`nsolid`). Most N|Solid tools take a `tenant`: when the token can use one tenant it is the default; otherwise call `list_tenants` (it takes no `tenant`) once and use the tenant the user names. Changing configuration needs the `nsolid:dynamic-configuration` permission; without it the change tools are missing, and the skill can still explain and preview.

N|Solid keeps agents at **desired configs**: each targets processes by an expression (or an app, tags or one agent), has a priority, and can expire. Processes started later get them too, and N|Solid confirms each change from the agent's own report. That beats changing one process once, which a restart forgets.

### 1. Understand What Runs Now
- `list_desired_configs`: the configs the tenant keeps, with their targets, settings (as `config`) and priority; ones with `expiresAt` are temporary overrides.
- `agent_config` with an `agentId`: what that process reports, what it should have and which config set each key, what is still to apply, and whether it has converged. Use it to answer "why does this process have that setting?"
- `desired_config_history` with a config's `name`: its 50 newest saves and deletes, each with the settings, target, priority, expiry, who made it and when. Deleted configs keep their history. Read it before changing or deleting a named config, to see who set it and what it held before. No tool restores an earlier version: to go back to one, make it a new change and preview and apply it as below.

### 2. Shape the Change
- `preview_desired_config` and `set_desired_config` accept exactly one of `settings` or its alias `config`, never both. `list_desired_configs` names those settings `config`; its `where` is an expression tree, while `whereText` is the expression string the input accepts. Do not pass the entire returned row as tool arguments. Selectors and configuration subtrees are kept whole, but their entire entry can be omitted by the byte cap: a missing name in a partial list is not proof it is absent.
- Settings: `tracingEnabled`, `traceSampleRate` (0 to 1), `contCpuProfile` (continuous CPU profiling), `interval` (metrics, ms), `blockedLoopThreshold` (ms), `pauseMetrics`, `promiseTracking`, `redactSnapshots`, `assetsEnabled`, `tags`. Turning `contCpuProfile` on needs the tenant's continuous-profiling feature: where N|Solid has it off, the save is refused, and processes stay off whatever a config says.
- Target: `app`, `tags`, one `agentId`, or `where`, an expression over what a process is (`app == "checkout" && hostname.endsWith(".prod")`, `nodeVersion >= "22"`; `expression_help` with context `selector` lists the fields; it takes no `tenant`). Every process of the tenant needs `allAgents: true` and the user's explicit agreement.
- MCP `where` takes a valid expression string; new supported expressions are fine within the same 4,000-character limit. To keep an existing selector, reuse its valid, uncut `whereText` (at most 4,000 characters), never the compacted JSON tree or a stringified one. The `app`, `tags`, `agentId` and `allAgents` shortcuts stay MCP inputs with their usual authorization.
- **Prefer an expiring override** for anything diagnostic: `expiresInMinutes` makes it stop applying, and the processes go back to what they had. Tracing or continuous profiling "for the next hour" is an override of 60 minutes.
- `priority`: higher wins where configs disagree.
- Names use letters, digits, `.`, `_` and `-`: `checkout-tracing-1h`.
- **New name or replacement:** saving under an existing name replaces it. This absence check applies only to saving as new: confirm the exact tenant and name are absent from a successful, complete JSON `list_desired_configs` result (no `outputCut`, no cut, too-large or error notice in any content block) or an already authorized REST read of `GET /v1/tenants/{tenant}/configs`; a preview proves nothing about absence. Otherwise hand the user the drafted spec and don't save it as new. Any exact match of the name is a replacement: say so. A go-ahead only to create never covers a replacement, whether or not the existing record was known; an existing go-ahead for that exact replacement and scope counts, with no fresh ask.
- **Editing:** an existing named record with its writable values intact can be edited; omitted unrelated rows don't matter. MCP drops null properties, so a missing `expiresAt` on an otherwise intact row means permanent. Keep the target, config, priority, state and expiry the user didn't ask to change; never round or restart a remaining duration, or revive an expired config, to make the save fit. If `set_desired_config` can't represent them faithfully (disabled state, absolute expiry, too-long `whereText`), hand over the draft and current record instead of dropping or renewing fields.

### 3. Preview
- `preview_desired_config` with the same inputs: how many connected processes match and which would change, without saving. Show it to the user.
- `matchingConnectedAgents` counts agents the proposed selector matches; `changing` counts agents with nonempty planned changes toward the full merged desired state, not this edit's own delta. The sample (at most 10 agents) may include drift-only keys they can't achieve; agents without an observed config aren't planned yet; `truncated` makes counts incomplete.
- Before a replacement, compare the old and proposed effective target and settings and show the effects, including what only the old one set and the replacement withdraws. Only an inactive, expired or fully ineffective old config withdraws nothing; a partially shadowed one may still set other keys, so don't treat the whole config as inert. Get agreement for any actual effect outside the authorized scope; a prior exact agreement holds when both the old and new actual effects stay within it, and moved counts alone need no new approval. Never widen scope from a partial preview, or infer what the change causes from `changing` or the sample alone.
- Call out what the change costs or stops: tracing and continuous profiling add overhead; turning off metrics, tracing or assets stops that data; `redactSnapshots: false` makes later heap snapshots carry the application's strings, which can include secrets and personal data.

### 4. Apply
- With the user's agreement, `set_desired_config`. Connected processes are reconfigured now, new ones when they connect.
- On a timeout, 5xx or lost response, claim neither success nor no write, and don't retry: re-read the exact tenant and name from complete authoritative evidence before any further write or report (a name missing from a cut list proves nothing), and if that can't settle it, report it as uncertain and hand off. Report a known refusal as a refusal; don't change other fields to get around it.
- Check it took effect: `agent_config` on one of the processes shows whether it converged.
- `reconfigure_agent` changes one running process once; N|Solid sets back any key a desired config manages, and a restart forgets it. Use it only when the user wants exactly that.

### 5. Undo
- An override ends by itself. To end a config sooner, or remove a permanent one, `delete_desired_config` with its name, with the user's agreement: processes go back to what their own startup settings and the remaining configs give them.

### 6. Present the Result
- What changed, on which processes (count and app), until when, and how to undo it; or, for a question, which config set the value and why.

### 7. Connecting Agents and Their Tokens
No MCP tool covers this: it is for the tenant's admins, in the web UI's **Connect agents** page or the API (an admin API token).
- **How agents connect:** `GET /v1/tenants/<tenant>/connection` lists the hostnames that reach the tenant, whether the gateways use TLS, and how many agents are connected. The page gives the environment for a shell, Docker, Compose or Kubernetes.
- **Ingest tokens** (`NSOLID_SAAS`): `GET /v1/tenants/<tenant>/ingest-tokens` lists them, each with `rotationDueAt` when it has a schedule, `agentsConnected`, and `replacedBy` once rotated.
- **Rotating safely:** `POST /v1/tenants/<tenant>/ingest-tokens/<id>/rotate` (optionally `{"graceDays": 7}`) issues a successor for the same deployment, shown once. Deploy it in place of the old one. The old token keeps working until no connected agent presents it, and stops at its grace deadline at the latest, so the switch has no gap. `PUT .../ingest-tokens/<id>/schedule` with `{"rotateEveryDays": 90}` sets a schedule.
- Never paste a token into chat or a file the user didn't ask for: it is a credential.

## Guardrails
- Never save, change or delete a config without showing the preview and getting the user's agreement.
- Never target every process (`allAgents: true`) unless the user asked for exactly that.
- Never turn off `redactSnapshots`, metrics or assets without spelling out the consequence first.
- Prefer expiring overrides for diagnostics, so nothing stays switched on by accident.
