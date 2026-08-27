# Proposal: publish N|Solid as a skills-only community plugin

## Decision requested

Approve a short, reversible experiment: publish the N|Solid **skills** as the community plugin and move the CLI source into a separate public repository. The CLI continues to perform its existing interactive setup: it authenticates with Accounts when necessary and registers the three existing MCP wrappers in the selected harness. The marketplace plugin does not declare or start an MCP server.

This is deliberately not an OAuth-MCP migration. It is a way to remove the remote-MCP authentication path from the package submitted for marketplace review while preserving local, token-based MCP use after a user explicitly runs setup.

The primary target is the Claude Community Marketplace. Codex and Antigravity compatibility are secondary: the same CLI-managed setup remains available for them, but neither MCP configuration is part of the submitted skills package.

The success metric for this experiment is concrete: prepare and submit a skills-only artifact, then determine whether it is approved into Anthropic's mirrored [`claude-plugins-community`](https://github.com/anthropics/claude-plugins-community) listing. Codex, Antigravity, OpenCode and Pi compatibility must not delay that submission.

## What is known

### Community plugin versus connector

These are different distribution and review paths:

* A Claude Code plugin is a directory that may contain skills and *optionally* an `.mcp.json` file. When present, plugin MCP servers start automatically when the plugin is enabled. [Claude plugin structure](https://code.claude.com/docs/en/plugins) and [plugin MCP behaviour](https://code.claude.com/docs/en/mcp) document that optional relationship.
* A remote MCP connector is an authenticated server integration. Claude Code can complete an OAuth flow for a remote server, but it also documents `headersHelper` specifically for non-OAuth schemes such as short-lived tokens or internal SSO. [Claude MCP authentication](https://code.claude.com/docs/en/mcp)

Therefore, removing `mcpServers` from the published plugin is a material scope change: it avoids claiming that the N|Solid plugin itself provides a remote connector. It does **not** make a claim about whether an external marketplace will accept the listing; that remains a screening hypothesis to test.

### The AccelByte precedent

AccelByte's public [`ai-plugins`](https://github.com/AccelByte/ai-plugins) repository is the primary structural precedent selected for this proposal. It contains separate per-harness artifacts and is the example under review by this team.

Facts directly observable in that repository:

* Its [Codex marketplace manifest](https://github.com/AccelByte/ai-plugins/blob/main/.agents/plugins/marketplace.json) points the Codex source to `./.codex-temp`. That artifact's [`.codex-plugin/plugin.json`](https://github.com/AccelByte/ai-plugins/blob/main/.codex-temp/.codex-plugin/plugin.json) declares `skills` but no `mcpServers` field.
* The adjacent [`codex.mcp.json`](https://github.com/AccelByte/ai-plugins/blob/main/.codex-temp/codex.mcp.json) is explicitly empty: `{ "mcpServers": {} }`.
* Its README says skills can configure MCP servers on a **per-project** basis when the user is ready, rather than requiring a live environment at plugin installation time. The concrete [AGS install-MCP skill](https://github.com/AccelByte/ai-plugins/blob/main/.codex-temp/skills/ags/subskills/install-mcp.md) guides an agent to preserve unrelated configuration and edit the relevant client configuration; for Codex it identifies `.codex/config.toml` and `mcp_servers.*`.
* The same repository does choose a different Claude-specific design: [`.claude-plugin/plugin.json`](https://github.com/AccelByte/ai-plugins/blob/main/.claude-plugin/plugin.json) declares `userConfig`, and [`mcp.json`](https://github.com/AccelByte/ai-plugins/blob/main/mcp.json) uses the configured URL values to declare remote MCP servers.

Inference: AccelByte demonstrates that a single public skills repository can emit a clean Codex skills-only artifact while preserving a richer, harness-specific integration elsewhere. For N|Solid, the lowest-risk first attempt is more conservative than AccelByte's Claude configuration: **do not declare MCPs in the Claude plugin either**. That keeps the community-plugin submission unambiguously skills-only and avoids making `userConfig`, templates, `headersHelper`, or remote-MCP authentication part of the screening surface.

### Additional verified Claude Community Marketplace precedents

The [Claude Community Marketplace repository](https://github.com/anthropics/claude-plugins-community) states that listed plugins pass automated security scanning and approval. Its current mirror includes AccelByte, CodeRabbit, and Endor Labs; these examples are relevant because the target here is that screening path, not a generic GitHub plugin directory.

* [CodeRabbit](https://github.com/coderabbitai/skills) has a [Claude manifest](https://github.com/coderabbitai/skills/blob/main/.claude-plugin/plugin.json) with metadata only, not an MCP declaration. Its skill checks that the `coderabbit` CLI exists and is authenticated, directs `coderabbit auth login` when needed, then uses `coderabbit review --agent`. This is the closest listed precedent for *skills plugin + separately authenticated CLI*.
* [Endor Labs](https://github.com/endorlabs/ai-plugins) likewise ships a metadata-only [Claude manifest](https://github.com/endorlabs/ai-plugins/blob/main/.claude-plugin/plugin.json). Its setup workflow uses `endorctl` and authentication configuration, while MCP use remains opt-in at workflow level. This is a second listed precedent for deferring live-service access to a tool-specific setup path.

Neither example proves that N|Solid's particular service-token scheme will be accepted. They demonstrate that a Community Marketplace plugin can deliver skills while leaving authenticated external capability to an independently installed CLI.

### Current N|Solid constraints

Facts from this repository:

* The current Codex and Claude manifests both declare MCP configuration files, respectively [`.codex-plugin/plugin.json`](../.codex-plugin/plugin.json) and [`.claude-plugin/plugin.json`](../.claude-plugin/plugin.json).
* The shared `nsolid-plugin setup --harness <harness>` flow already authenticates through Accounts and stores one shared credential record at `~/.agents/.nodesource-auth.json`; its documented lifecycle includes missing/expired credential recovery and organization switching. [Core CLI README](../packages/core/README.md).
* Current runtime wrappers use that credential record to resolve the Console URL and inject N|Solid service-token and organization headers before connecting to `nsolid-console`, `ns-benchmark`, or `ncm`. [`scripts/mcp-wrapper.js`](../scripts/mcp-wrapper.js).
* The core package already owns harness adapters, config writing, backups and removal. `setup()` authenticates; for the existing plugin-owned harnesses (Claude, Codex, Antigravity) it currently completes as an auth-only operation. `install()` already has a `packageOwnedSkills` mode that skips copying skills while writing MCP configuration. [Core CLI README](../packages/core/README.md).

These facts make this a packaging/refactoring change, not a required protocol change to `nsolid-console-ng`, `ns-benchmark`, `ncm-mcp`, or Accounts.

## Proposed two-repository architecture

```text
github.com/NodeSource/nsolid-plugin              github.com/NodeSource/nsolid-plugin-cli
public marketplace source                         public npm package source
────────────────────────────────────              ───────────────────────────────────
skills/       canonical skill source              Accounts login and credential storage
Claude/Codex/Antigravity manifests                current MCP wrapper/proxy behaviour
generated marketplace bundles                     harness adapters and config writers
docs and marketplace metadata                     setup, status, doctor, uninstall
no mcpServers declarations                         package published to npm
```

The skills repository is the single source of truth for skills, references, assets and marketplace metadata. It does not vendor the CLI package or a second copy of skills. The CLI repository is the source of the publicly published executable. A release compatibility contract links them:

* skills state a minimum CLI version only where an online operation needs setup;
* the CLI exposes a stable `setup --harness …` contract and tests each supported harness;
* the plugin never contains credentials, wrappers, MCP registration, or a remote MCP URL.

The current monorepo may be used as the migration starting point, but the end state has no bidirectional skill copying. If a convenience command installs a plugin, it should install a released plugin artifact or direct the user to the marketplace; it must not embed another skill fork inside the CLI.

## User flow and setup state machine

The public plugin installs skills only. A skill may explain that live N|Solid data requires the separately installed CLI, but it must not silently modify configuration.

```text
plugin installed (skills only)
          |
          v
user requests live N|Solid data
          |
          +-- CLI absent --------> show install command and stop
          |
          v
user runs: nsolid-plugin setup --harness <name>
          |
          +-- valid shared auth --> retain org and credentials
          |
          +-- absent/expired ----> Accounts login --> write shared credentials
          |
          v
ask registration scope: this project | global
          |
          v
merge only N|Solid MCP registrations into target harness configuration
          |
          v
validate / report restart-or-reload instruction
```

### Scope prompt

The existing `setup --harness` command remains the only user-facing setup entry point. Add an interactive scope question after authentication (or after confirming reusable credentials):

```text
Where should N|Solid MCPs be available?
  1. This project (recommended): only the current trusted workspace
  2. Global: all projects for this user
```

Non-interactive equivalents should be explicit, for example `--scope project` and `--scope global`; no default should silently write global configuration. If the harness has no safe project scope, setup must say so and request confirmation before global installation.

The registration uses the current three stdio wrappers. Each wrapper continues to read `~/.agents/.nodesource-auth.json` at connection time, so a previously completed login for any harness can be reused for another harness without placing tokens in a project file. The selected scope stores only the command/arguments that launch the wrapper.

Today the config writer uses user/global locations (for example `~/.claude.json`, `~/.codex/config.toml`, and `~/.gemini/config/mcp_config.json`). Project scope is therefore new work, not a claim about current behavior. Expected final destinations, to be finalized against each adapter's existing tests:

| Harness | Project scope | Global scope | Notes |
| --- | --- | --- | --- |
| Claude Code | project MCP config (`.mcp.json`) | user MCP configuration | Claude documents local/project/user configuration scopes for `claude mcp add`. [Claude MCP scopes](https://code.claude.com/docs/en/mcp) |
| Codex | `.codex/config.toml` | `~/.codex/config.toml` | Codex documents both locations and only loads project configuration in trusted projects. [Codex configuration reference](https://learn.chatgpt.com/docs/config-file/config-reference) |
| Antigravity | `.agents/mcp_config.json` | `~/.gemini/config/mcp_config.json` | Antigravity documents both workspace and global MCP configuration. [Antigravity MCP configuration](https://antigravity.google/docs/mcp) |
| OpenCode / Pi | existing adapter-defined target | existing adapter-defined target | Preserve current adapter behavior; this proposal does not broaden their support contract. |

## Minimal implementation plan (one to two engineering days)

### Day 1 — package boundary and skills-only artifacts

1. Create the standalone public CLI repository by moving the existing core/setup/wrapper package without changing Accounts protocol, token schema, or the three server wrappers.
2. In the public `nsolid-plugin` repository, retain canonical `skills/` and marketplace manifests, then remove `mcpServers` from the Claude and Codex plugin manifests. Do not ship plugin-owned `.claude-mcp.json`, `.mcp.json`, or Antigravity `mcp_config.json` with server entries. An empty Codex MCP file is acceptable but omission is simpler.
3. Generate and validate harness-specific skills artifacts from the single canonical source. Update descriptions to say “N|Solid skills,” not “skills and MCP servers.”
4. Make skills use an actionable, provider-neutral setup instruction when live data is unavailable: install the CLI, run `setup --harness <detected harness>`, then reload/restart as required.

### Day 2 — reuse setup and prove the Claude path

1. Extend the current interactive `setup --harness claude` flow with project/global scope selection and explicit non-interactive flags. Follow successful authentication with the existing MCP-only registration machinery instead of stopping auth-only.
2. Reuse the existing config writer/backups/idempotent merge logic. Register only `nsolid-console`, `ns-benchmark`, and `ncm`; never overwrite non-N|Solid entries.
3. Test fresh login, valid reused credentials, expired credentials, Claude project setup, Claude global setup, repeated setup, removal, and one secondary-harness setup using the same credential record.
4. Run marketplace/package validation and submit the skills-only artifact. Record exact screening feedback before undertaking any OAuth work.

The two-day timebox does not require project/global parity for every secondary harness. Existing global setup behaviour may remain for Codex, Antigravity, OpenCode and Pi as long as it does not regress. Scope parity becomes follow-up work after the Claude submission unless it is already covered by the shared writer with minimal additional changes.

## Explicit non-goals

* No OAuth 2.1 / DCR / PKCE / refresh-token implementation in Accounts or any MCP server.
* No changes to token authentication in the VS Code extension or the Console Copilot agent.
* No OAuth gateway, proxy service, or new backend deployment.
* No migration of the three current MCP servers from their existing service-token headers.
* No auto-installation of MCPs as a side effect of enabling a marketplace plugin.
* No promise that a skills-only listing grants cloud access to live N|Solid data. Local CLI setup is separate from any cloud-hosted runtime.

## Screening hypothesis and limitations

**Hypothesis:** a marketplace submission whose installable plugin contains only skills, references and static metadata will avoid the remote-MCP authentication/OAuth review condition that applied to the prior MCP-bearing submission. This is plausible because the package no longer advertises a remote MCP; it is not a guarantee of acceptance.

Why this is a bounded experiment:

* The user-facing value of offline/repository skills remains available immediately.
* Live data remains opt-in and is initiated by a normal CLI login/setup outside the plugin artifact.
* The existing token model stays operational for VS Code and local harnesses.
* If screening still rejects the listing for unrelated policy, metadata, security or content reasons, we get a precise failure reason without having changed server authentication.

Limitations:

* The marketplace plugin alone cannot access live N|Solid systems.
* Cloud-hosted harness environments generally cannot rely on a locally installed CLI or local credential file.
* Some skills will need clear graceful-degradation text when MCP tools are not present.
* A separate public repository introduces release coordination. Versioned CLI compatibility and integration tests are required.
* Claude can support a token-header helper for non-OAuth remote MCPs, and Antigravity supports custom headers, but intentionally using those plugin fields now would put MCP authentication back into the submission surface. [Claude custom authentication](https://code.claude.com/docs/en/mcp); [Antigravity custom headers](https://antigravity.google/docs/mcp/).

## Acceptance criteria

1. The submitted Claude community-plugin artifact contains at least one skill and contains no `mcpServers`, MCP URL, token, `headersHelper`, wrapper, or executable MCP registration.
2. Enabling the plugin does not contact Accounts and does not write user or project MCP configuration.
3. `nsolid-plugin setup --harness claude` reuses valid credentials or completes the existing Accounts login, then asks for project/global scope before writing MCP registrations. Secondary harnesses retain at least their current setup behaviour.
4. Setup writes only N|Solid server registrations, preserves unrelated user configuration, is idempotent, and has a targeted remove/uninstall path.
5. A fresh user can install the plugin, install the public CLI, run setup, restart/reload the harness, and invoke all three local MCP wrappers without copying a token into project configuration.
6. Existing VS Code token-authentication behavior and current MCP-server APIs pass their unchanged tests.
7. The submission is attempted with the skills-only artifact and the resulting marketplace screening feedback is captured verbatim in the release issue.

## Rollback

The rollback is configuration-level and does not require server changes:

1. Withdraw or revert the new marketplace artifact to the last known-good skills release.
2. Publish a CLI patch that removes only the three N|Solid registrations from the selected scope and restores backed-up config if a write failed.
3. Keep the existing Accounts credential file untouched unless the user explicitly runs logout.
4. Retain the old MCP-bearing source in a tagged release while the migration is evaluated; do not delete it until the new artifact has passed screening and the CLI flow is verified.

## Questions for team review

The initial submission target is confirmed: Claude Community Marketplace. Codex and Antigravity are compatibility channels and must not block this screening attempt.

1. Which current CLI package name and npm ownership should become the stable public contract after the repository split?
2. For Claude, should the CLI register project scope in the repository `.mcp.json` (shareable) or a user-local project configuration by default? The proposal prefers the least-surprising non-secret option and requires explicit consent for shareable files.
3. Does the CLI already have a safe project-root discovery contract for every harness, or should the first release support global setup for a harness only after an explicit warning?
4. Who owns release compatibility testing across the skills repository and CLI repository?
5. If marketplace screening rejects skills-only packaging, do we first address the specific rejection, or revisit MCP OAuth as a separately scoped project?
