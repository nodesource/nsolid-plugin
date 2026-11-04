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
- **Prefer an expiring override** for anything diagnostic: `expiresInMinutes` makes it stop applying, and the processes go back to what they had. Tracing or continuous profiling "for the next hour" is an override of 60 minutes.
- `priority`: higher wins where configs disagree.
- Names use letters, digits, `.`, `_` and `-`: `checkout-tracing-1h`.

#### New Names and Replacing a Config
- Saving under a name that exists replaces that config. A name missing from a bounded or partial `list_desired_configs` result does not authorize replacing anything: before saving a config as new, verify the exact tenant and name in a successful, complete, uncut `list_desired_configs` JSON result (no JSON `outputCut`, no cut notice, too-large notice or error in any content block, nothing omitted) or an authorized `GET /v1/tenants/{tenant}/configs` (the full REST list; there is no route for one config by name). The Console doesn't list every arbitrarily named config, so it is not proof that a name is absent. If neither source is available, don't save it: hand the user the drafted spec to check and save themselves.
- The name appearing in any list, partial or not, means saving replaces that config. Show what it holds now; if the user authorized only creating a config, get their go-ahead to replace it. The user's existing go-ahead to replace that config with the same change still counts; ask nothing more.
- `preview_desired_config` shows which processes would change; it does not prove a name is unused and does not keep the old config's settings.
- To edit an existing config, start from its current, intact record and keep everything the user didn't ask to change: target, settings, priority, state (enabled or not) and expiry (`expiresAt`). `set_desired_config` only takes the fields its schema lists, and expiry only as a whole `expiresInMinutes` (1 to 10080) counted from the save; it cannot carry an absolute `expiresAt`, a state or any other field as it is. When the record isn't intact, or any of these can't be written exactly with the fields `set_desired_config` offers, don't save it through MCP.
  - An intact record is the exact tenant and name's own entry, from a successful `list_desired_configs` result or an authorized `GET /v1/tenants/{tenant}/configs`, with every writable field present and nothing cut in it: no cut notice, `outputCut` or omission touching that record, its target (`where`/`whereText` or selector), its `config`, its priority, its state or its expiry. Such a record can be used even when the list is partial and other, unrelated records were omitted: the name appearing already proves the config exists. A cut that only touches known read-only metadata (such as who saved it or when) leaves the writable values usable. A complete, uncut list is needed only to conclude a name is absent, as above, not to edit a record that is present and intact.
  - The Console's Process Settings can't edit arbitrary config names or keep a config's state or absolute expiry: don't send the user there for such an edit.
  - With the user's authorization for the REST API, `PUT /v1/tenants/{tenant}/configs/{name}` with the exact requested tenant and name accepts `config`, the target (`where` or a selector, never both), `priority`, `enabled`, and either `expiresAt` (an absolute time in the future; omit it for a permanent config) or `durationMs`, never both. Carry over every unchanged writable value from the record and change only what the user asked. When the target is unchanged, send the record's `where` expression (tree or its exact `whereText`) as is: don't rebuild it as a legacy selector, simplify or widen it. Build the body from those fields; don't pass the read record through, since its metadata isn't input.
  - Before the `PUT`, send that exact body to `POST /v1/tenants/{tenant}/configs/{name}/preview` (it takes the same body as the `PUT`), show the user the result, and get their agreement, or reuse their existing go-ahead for the same action on the same tenant, name and target. Don't substitute `preview_desired_config`: it can't carry `enabled` or an absolute `expiresAt`.
  - If the kept `expiresAt` is no longer in the future or can't be written exactly, or the REST write or preview isn't authorized, leave the config unchanged and hand the user the drafted change; don't renew, extend or drop the expiry to make it fit.
  - When neither writer can make the edit faithfully, leave the config unchanged and hand the user the drafted change with its intact current record, naming the fields that must be preserved (target, priority, state, absolute expiry, and any field the MCP schema doesn't list).
- Never round, renew, extend or drop an expiry, drop a field the schema doesn't list, or re-enable a config as a side effect; change any of them only when the user asks, and say so.

### 3. Preview
- `preview_desired_config` with the same inputs: how many connected processes match and which would change, without saving. Show it to the user. A REST replacement is previewed with its own exact body through `POST /v1/tenants/{tenant}/configs/{name}/preview`, as in New Names and Replacing a Config. It says nothing about whether the name is in use: check that as in New Names and Replacing a Config.
- Call out what the change costs or stops: tracing and continuous profiling add overhead; turning off metrics, tracing or assets stops that data; `redactSnapshots: false` makes later heap snapshots carry the application's strings, which can include secrets and personal data.

### 4. Apply
- With the user's agreement, `set_desired_config`. Connected processes are reconfigured now, new ones when they connect.
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
