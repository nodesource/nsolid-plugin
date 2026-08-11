---
name: ns-switch-org
description: >-
  Switches which NodeSource organization nsolid-plugin is authenticated
  against. Use when the user is a member of multiple NodeSource orgs and
  wants to switch orgs, sign in to a different org, or asks why MCP data is
  showing the wrong organization.
---

### 1. Warn before switching

`nsolid-plugin` stores one set of NodeSource credentials, shared by every
installed harness (Claude Code, Codex CLI, OpenCode, Antigravity, Pi) and all
three MCP servers (`nsolid-console`, `ns-benchmark`, `ncm`). There is no way
to keep two orgs active at once. Before running anything, tell the user:

> Switching organizations changes the single shared NodeSource login used by
> **every** harness you have installed nsolid-plugin into, not just this one.

### 2. Determine the current harness

The `--harness` flag is required by the CLI. This skill file is distributed
identically to every harness, so it has no built-in way to know which one is
currently running it. If it isn't already obvious from context, ask the user
which harness they're using: `claude`, `codex`, `opencode`, `antigravity`, or
`pi`.

### 3. Run the switch

Tell the user a browser window is about to open so they can sign in and pick
an organization (NodeSource's sign-in flow shows an org picker automatically
when the account belongs to more than one). Then run, using an extended
command timeout of **at least 300000ms** (the CLI's own OAuth wait window is
5 minutes):

```
npx -y nsolid-plugin switch-org --harness <harness>
```

No `--yes` or other interactive flags are needed — the CLI detects it is not
running in an interactive terminal and skips its confirmation prompt
automatically in that case.

### 4. Relay the result

The command itself prints the newly active org id and harness-specific
follow-up guidance (e.g. reconnecting an MCP session, or re-running
`nsolid-plugin install --harness <harness>` for a fallback-installed
harness). Report that output back to the user rather than re-deriving your
own summary — it already reflects exactly what changed and what to do next.

If the command fails, surface its error output directly; do not attempt to
work around a failed OAuth flow (e.g. by editing
`~/.agents/.nodesource-auth.json` by hand).
