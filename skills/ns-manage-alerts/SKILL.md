---
name: ns-manage-alerts
description: >-
  Defines, reviews, tunes and triages N|Solid alert rules and alerts. Use when the user wants to be alerted or paged on something (CPU, memory, event loop lag, latency, crashes or a crash loop, a process killed or lost, an app that stops reporting, blocked loops, new or known exploited vulnerabilities, a dependency's new behavior or a release regression), asks what alerts exist, which are firing or whether a rule is working, wants to acknowledge or silence an alert, switch a rule off, or wants a noisy rule fixed. Writes rules in N|Solid's expression language and checks what each would have caught before saving it.
---

This skill works through the N|Solid MCP server (`nsolid`). The N|Solid tools take a `tenant`: when the token can use one tenant it is the default; otherwise call `list_tenants` once and use the tenant the user names. Saving rules and acknowledging or silencing alerts need the `nsolid:manage-alerts` permission; without it those tools are missing, and the skill can still review and draft.

## Start a Newly Connected Service's Baseline

When setting up alerts for a newly connected service, call `list_alert_starters`.
It returns the same starters the web editor offers, each with an id, title,
reason (`why`) and a `spec` in `set_alert_rule`'s terms. Read the current list;
do not keep copies of starter definitions or reconstruct their thresholds.

- Call `list_alert_rules` first. Check both names and coverage: a tenant-wide
  rule may already cover the service. Offer the useful missing starters and
  explain their reasons; do not install the whole list automatically.
- Review each chosen `spec` with the user. Starters are enabled, cover every
  process or app, have no notification channels, and take no diagnostics.
  Agree on the intended coverage and whether to record alerts only or use
  existing channels from `list_alert_channels`.
- For one service, add an app expression in `scope` for metric/event rules.
  For finding/behavior rules, combine the original `where` with the app
  expression using parentheses. Use the expression language's escaped string
  syntax for the app name. Choose an unused rule name for service-specific
  rules; a name already in use replaces the whole rule.
- Preview what it would have caught using step 3 below, and show the final
  spec. Once the user authorizes saving, pass that spec with the selected
  `tenant` to `set_alert_rule`; do not pass the starter's id, title or why.
  Keep each metric's letters, windows, conditions and hold times unless the
  user asks to tune them. Report any warnings from the save.
- Without `set_alert_rule`, review and draft only. The web editor can open a
  selected starter at `/t/{tenant}/alerts/rules/new?starter={id}`. If
  `list_alert_starters` is unavailable on an older server, explain that the
  baseline catalog needs a server update; do not invent replacement starters.

## Defining a Rule

### 1. Turn the Request into a Rule Kind
- **Metric rule**: a measurement crossing a line for a while ("CPU over 80% for 5 minutes", "p99 latency over 500 ms", "heap over 1.5 GB"). `metric.name` (`cpu_percent`, `used_heap_size`, `rss`, `loop_estimated_lag`, `loop_utilization`, `http_server` with `field: "p99"`, …; `list_metrics` lists what the tenant reports, an app's own OpenTelemetry metrics included under their stored names: `orders.created` is `orders_created`), `agg` (default `max`; `rate` for a counter's increase per second; `change` for how much it moved over the window), `condition` over `value` in the metric's unit (`value > 80`, `value > 500ms`, `value > 1.5GiB`), `forMinutes` (how long it must hold), `keepFiringForMinutes`, `groupBy` `agent` (each process) or `app`.
  - **A window:** `windowMinutes` (1 to 1440, default 1) judges a longer stretch. "RSS climbing for an hour" is `rss` with `agg: "change"`, `windowMinutes: 60`, `value > 200MiB`.
  - **A ratio:** `per` names a second metric, and `value` becomes the ratio: `used_heap_size` per `heap_size_limit` with `value > 0.9` is "heap at 90% of its limit".
  - **Silence:** `noData: "fire"` makes a group that reported in the last hour and has gone quiet hold, instead of resolving. "Tell me when checkout stops reporting" is `cpu_percent`, `value < 0` (never true on a value), `noData: "fire"`, `forMinutes: 5`, `groupBy: "app"`, scoped to the app. A process that exited, or was lost, is gone rather than quiet: use an event rule for those.
  - Agents report every 5 s by default. For agents set to report less often than once a minute, make the window at least that long.
- **Event rule**: something that happens ("a process crashes", "the loop blocks over a second"). `event.where` over agent events: `type == "exit" && exitCode != 0`, `exitSignal == "SIGABRT"`, `type == "loop_blocked" && blockedFor > 1s`, `type == "lost"` (a process gone 15 minutes without an exit: SIGKILL, the out-of-memory killer, its host lost; the alert comes 15 minutes after it was last heard from). `resolveAfterMinutes` closes it after a quiet spell. `count` with `withinMinutes` fires only once that many matching events of a group came within the window ("3 exits in 10 minutes": `count: 3`, `withinMinutes: 10`); until then it is pending.
- **Finding rule**: new vulnerability findings. `finding.where`, e.g. `severity >= "high" && evidence >= "loaded"`, `knownExploited` (CISA lists its CVE as exploited in the wild), `kind == "malicious"`, `kind == "end-of-life"`, `"express" in via`. Only findings that open after the rule is saved alert.
- **Behavior rule**: a dependency doing something new, a release regression, or dependency drift. `behavior.where`, e.g. `kind == "capability" && severity >= "high"`, `kind == "regression" && severity >= "medium"`, `kind == "drift" && severity >= "high"`, `versionChange`.
- `expression_help` (contexts `agent`, `event`, `finding`, `behavior`) lists every field when the request needs one this skill doesn't name.

### 2. Scope It
- `scope` limits metric and event rules to some processes, as an agent expression: `app == "checkout"`, `"canary" in tags`, `hostname.endsWith(".prod")`. Finding and behavior rules take no scope: put `app == "…"` in their `where`.
- Check the scope matches what the user means: `find_agents` with the same expression as `where` lists the processes it covers.

### 3. Check What It Would Have Caught
Before saving, show the user what the rule would have done:
- **Metric rule:** `query_metric` with the same metric, `agg`, `field`, the scope's app or `where`, and `from: "-24h"` (or `-7d`). Say how often and for how long the series crossed the line, and whether `forMinutes` would have held it back. A rule that would have fired all day is noise; one that never would have may be too loose. For `per`, query both metrics and compare them; for `change`, compare each window's start and end.
- **Event rule:** `list_events` with the same `where` (and the scope's app) over the last day or week: how many events would have fired it, from how many processes. With `count`, `event_histogram` with the same filters and `step` set to the window (`"10m"`) shows whether that many ever came within one.
- **Finding rule:** `list_vulnerabilities` with the same `where`: what is open now. These would not alert (only new ones do), but they show the rule matches what the user expects.
- **Behavior rule:** `list_behaviors` with the same `where`.
- Adjust the threshold, hold time or scope with the user until the picture is right.

### 4. Pick Channels and Diagnostics
- `list_alert_channels` names the channels (Slack, Teams, PagerDuty, webhooks). Use the names the user wants; if there is no fitting channel, say that someone who manages integrations adds one in the web UI. A rule with no channel still records alerts.
- Webhook channels: each delivery carries `x-nsolid-event`, `x-nsolid-idempotency-key` (deliveries are at least once: deduplicate on it), `x-nsolid-timestamp` and, with a signing secret, `x-nsolid-signature` (`v1=` and the hex HMAC-SHA256 of `<timestamp>.<body>`), with the user agent `nsolid-alerts/1`. Receivers verify against the raw body and refuse old timestamps.
- `severity`: `info`, `warning` (default) or `critical`.
- `diagnose` makes a firing process capture evidence: `profile` (CPU), `heap_sampling` or `snapshot` (pauses the process). Only rules grouped by `agent` take one: an app's alert is about no one process. A small hourly budget per app (`diagnosePerAppPerHour`, default 2) keeps an incident from profiling the whole fleet; `diagnoseDurationMs` (default 10000) sets how long a profile or sampling runs. Suggest `profile` for CPU and latency rules and `heap_sampling` for memory rules; `snapshot` only when the user asks. A process that profiles continuously isn't asked for a `profile`: the alert keeps its continuous profiles instead.

### 5. Save
- Show the rule as you'll save it (name, kind, condition, scope, channels, diagnostics), and save it with `set_alert_rule` once the user agrees. A name that exists is replaced whole: check `list_alert_rules` first, say so when the user is changing a rule rather than adding one, and pass back every field it shows (they are in `set_alert_rule`'s terms), changing only what the user asked. `enabled` left out keeps the rule's state; a new rule is on.
- Arguments are checked strictly: a misspelled or unknown key is refused with its name. Fix it rather than dropping it.
- A channel that doesn't exist is refused. The saved rule comes back with `warnings`, such as a metric no process reported in the last 7 days (a misspelled name, or an app that hasn't started) or a disabled channel: tell the user.
- Names use letters, digits, `.`, `_` and `-`: `checkout-p99-latency`.

## Reviewing and Tuning
- `list_alert_rules` lists every rule with its condition, scope, channels, diagnostics and `health`, which tells a quiet rule from a broken one:
  - `ok`, with what the last check saw: the groups with a value and how many held (`groups`, `holding`), or for an event rule when an event last came and last matched (`checkedAt`, `matchedAt`);
  - `no-data`: no process in scope reports the metric (a misspelled name, an empty scope);
  - `failing`: its last check failed, and `lastError` says why;
  - `stale`: rules haven't been checked for 3 minutes; `waiting`: just saved; `off`: switched off.
- A noisy rule: `list_alerts` with `rule` shows how often it fired; `query_metric` over the rule's window shows the pattern (a threshold under normal peaks, a hold time shorter than the spikes). Propose the change, preview it as in step 3, and save it with the same name.
- A rule that never fires when it should: check its `health` first, then compare its condition and scope with the metric or events at the time it should have fired.
- Did the notifications go out: `list_alert_deliveries` (`status: "dead"` for the ones that gave up) shows each delivery's attempts and last error.
- To stop a rule for a while, `set_alert_rule_enabled` with `enabled: false` switches it off and keeps it (its open alerts resolve). `delete_alert_rule` deletes it and its alerts, only when the user asks for that.

## Triage
- `list_alerts` (firing first; `state: "firing"` for only those) shows each alert's rule, what it is about, the value, and whether someone acknowledged or silenced it.
- `get_alert` with the `fingerprint`: the event or value that fired it, the diagnostic its rule took (an `assetId`: read it with `profile_hotspots` or `heap_summary`), the continuous profiles kept from around it, its history and its notifications.
- Hand the investigation to the skill that fits: `ns-cpu-spike-analysis`, `ns-memory-spike-analysis`, `ns-analyze-event`, `ns-analyze-vulnerabilities` or `ns-analyze-behaviors`.
- `ack_alert` marks it acknowledged until it fires again; `silence_alert` with `minutes` stops its notifications for a while (it still changes state). Do either only when the user asks.

## Present the Result
- For a new or changed rule: the rule as saved, what it would have caught (step 3), and where it notifies.
- For triage: what is firing, since when, what the evidence shows, and the next step.

## Guardrails
- Never save, change, switch off, delete, acknowledge or silence without the user's say-so; show the rule first.
- Never add `diagnose: "snapshot"` unasked: it pauses the application.
- Do not invent channels: use only names `list_alert_channels` returned.
- A rule on blocked loops shorter than the agents report makes N|Solid lower the `blockedLoopThreshold` of the processes in its scope to match (of every process, when the scope is on packages); mention it when saving one.
