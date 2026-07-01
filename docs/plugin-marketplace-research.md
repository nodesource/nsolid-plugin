# Plugin Marketplace and Artifact Research

	Date: 2026-06-19

> **Amendment (2026-06-24):** The generated-artifact direction described below
> was **superseded**. Claude, Codex, and Antigravity no longer produce
> `dist/plugins/...` roots or `.tgz` archives via `pnpm plugin:artifacts`
> (that script and `plugins/templates/` were removed). Instead, the **repository
> root is itself the installable plugin** — mirroring `addyosmani/agent-skills` —
> with `.claude-plugin/{plugin,marketplace}.json`,
> `.agents/plugins/marketplace.json` + `.codex-plugin/plugin.json`, and an
> Antigravity `plugin.json` all pointing at the shared root `skills/` and
> `scripts/mcp-wrapper.js`. Harnesses install directly:
> `claude plugin marketplace add NodeSource/nsolid-plugin`,
> `codex plugin marketplace add NodeSource/nsolid-plugin`,
> `agy plugin install https://github.com/NodeSource/nsolid-plugin.git`.
> Root manifests are refreshed by `pnpm plugin:root`
> (`scripts/materialize-github-marketplace.mjs`). Pi and OpenCode conclusions
> below remain accurate. Treat the rest of this doc as historical context for
> why the original refactor was attempted, not as the current distribution model.

## Purpose

Document the examples and marketplace/plugin docs used to justify the generated-artifact refactor for N|Solid plugin distribution.

The refactor target is:

- Keep N|Solid skills canonical in `packages/core/skills/`.
- Generate Claude, Codex, and Antigravity plugin artifacts under `dist/`.
- Keep Pi as a real package.
- Keep OpenCode as CLI/fallback-only until its native distribution story is clearer.
- Keep auth/browser behavior out of install paths; require explicit `nsolid-plugin setup` / `login`.

## Sources reviewed

| Source | Location | Why it matters |
|---|---|---|
| Agent Harness Skills reference repo | `https://github.com/yfge/agent-harness-skills.git` | Concrete multi-harness example with one `skills/` tree and small harness manifests/plugins around it. |
| Claude Code plugin docs | https://code.claude.com/docs/en/plugins | Defines Claude plugin root layout and `.claude-plugin/plugin.json`. |
| Claude Code marketplace docs | https://code.claude.com/docs/en/plugin-marketplaces | Defines marketplace catalogs and confirms marketplace acceptance/distribution is separate from local plugin structure. |
| Codex plugin build docs | https://developers.openai.com/codex/plugins/build | Defines `.codex-plugin/plugin.json`, `skills/`, hooks, `.mcp.json`, and `codex plugin marketplace add`. |
| Codex plugin docs | https://developers.openai.com/codex/plugins | Documents plugin browser/marketplace install model. |
| Codex hooks docs | https://developers.openai.com/codex/hooks | Documents plugin hook discovery and hook environments. |
| OpenCode plugin docs | https://opencode.ai/docs/plugins/ | Defines OpenCode plugins as JS/TS modules loaded from config/plugin directories or npm. |
| OpenCode config docs | https://opencode.ai/docs/config/ | Defines config precedence, `.opencode` directories, agents/commands/skills directories, and the `plugin` config key. |
| OpenCode skills docs | https://opencode.ai/docs/skills/ | Defines native skill discovery locations such as `.opencode/skills/` and `~/.config/opencode/skills/`. |
| OpenCode MCP docs | https://opencode.ai/docs/mcp-servers/ | Defines MCP servers as config under the `mcp` key in `opencode.json`, not as a plugin artifact manifest field. |
| Antigravity plugin docs | https://antigravity.google/docs/cli-plugins | Defines `agy plugin install` and Antigravity plugin layout. |
| `agent-skills` Antigravity example | https://github.com/addyosmani/agent-skills/blob/main/docs/antigravity-setup.md | Real-world `agy plugin install` example and validation guidance. |

## Reference repo: `agent-harness-skills`

Relevant files:

```text
/home/agent-harness-skills/
├── .claude-plugin/plugin.json
├── .codex-plugin/plugin.json
├── .cursor-plugin/plugin.json
├── .opencode/plugins/agent-harness-skills.js
├── gemini-extension.json
├── GEMINI.md
├── INDEX.md
├── package.json
└── skills/
```

Observed model:

- One repository-level `skills/` directory is the canonical skill source.
- Harness metadata is thin:
  - Claude has `.claude-plugin/plugin.json` with package identity fields.
  - Codex has `.codex-plugin/plugin.json` with `skills: "./skills/"` plus UI metadata.
  - OpenCode has a JS plugin entrypoint that registers the repository `skills/` path and injects lightweight bootstrap context.
  - Gemini uses `gemini-extension.json` and `GEMINI.md` as routing/bootstrap metadata.
- Validation scripts check metadata consistency instead of maintaining separate copies per harness.

Implications for N|Solid:

- The useful pattern is **one skill source + harness-specific manifests**, not duplicated source package directories.
- N|Solid differs because Claude/Codex/Antigravity artifacts should be self-contained for marketplace/local install. Therefore N|Solid should generate artifact-local `skills/` copies under `dist/`, not commit them under `packages/*`.
- OpenCode can stay fallback-only until its plugin runtime path is worth first-class artifact support.

## Claude Code docs

Key findings:

- A Claude plugin is a self-contained plugin root.
- The manifest lives at `.claude-plugin/plugin.json`.
- Component directories such as `skills/`, `agents/`, `hooks/`, commands, and settings belong at plugin root, not inside `.claude-plugin/`.
- Skills in a plugin use the plugin namespace when invoked.
- Marketplaces are separate catalogs. A marketplace uses `.claude-plugin/marketplace.json`; users add marketplaces with `/plugin marketplace add` or `claude plugin marketplace add` and install individual plugins from there.
- `claude plugin install <path>` is not the local artifact flow; `install` resolves plugin names from configured marketplaces. A downloaded local artifact should either be loaded for one session with `claude --plugin-dir <path>` or permanently installed by adding a local marketplace path and then installing `plugin@marketplace`.
- Official/community marketplace inclusion is curated and external to this repo.

Design impact:

- Generate `dist/plugins/claude/nsolid-plugin/` as a plugin root and local marketplace root containing `.claude-plugin/plugin.json`, `.claude-plugin/marketplace.json`, `skills/`, and plugin-local MCP wrapper/config.
- Do not treat `packages/claude-plugin` as a publishable npm package.
- Do not assume marketplace curation will happen automatically; generated artifacts/local marketplace install remain the fallback (`claude plugin marketplace add <artifact-root>` then `claude plugin install nsolid-plugin@nodesource-local`).
- Do not run auth from plugin install or startup hooks. Do not ship startup guidance hooks because Claude/Codex UI visibility is inconsistent; runtime MCP wrappers already fail with actionable setup guidance.

## Codex docs

Key findings:

- A Codex plugin has a required `.codex-plugin/plugin.json` manifest.
- `skills/`, `hooks/`, `.mcp.json`, `.app.json`, and assets live at plugin root.
- Manifest paths such as `skills`, `hooks`, and `mcpServers` should be relative paths beginning with `./` and staying inside the plugin root.
- Codex can add marketplace sources with `codex plugin marketplace add`, including local marketplace roots and Git repositories.
- `hooks/hooks.json` is the default plugin hook file. If a hook path is declared in the manifest, Codex resolves it relative to the plugin root.
- Plugin hook commands receive `PLUGIN_ROOT` and `PLUGIN_DATA` environment variables.
- Codex plugin MCP config currently should not rely on `${PLUGIN_ROOT}` interpolation inside `.mcp.json` command args; local artifact MCP launch uses a Node bootstrap that resolves the installed plugin cache path.

Design impact:

- Generate `dist/plugins/codex/nsolid-plugin/` with `.codex-plugin/plugin.json`, `skills: "./skills/"`, `mcpServers: "./.mcp.json"`, plugin-local `.mcp.json`, and optional local marketplace metadata.
- Do not ship generated startup hooks/setup scripts; visibility is inconsistent and auth remains explicit through `nsolid-plugin setup --harness codex`.
- Keep Codex marketplace metadata generated so local/Git marketplace flows can be tested without a committed `packages/codex-plugin` tree.

## Antigravity docs and examples

Key findings:

- Antigravity CLI installs plugins with `agy plugin install /path/to/local/plugin` or remote equivalents.
- Installed plugins are staged under `~/.gemini/config/plugins/<plugin_name>/` (the legacy `~/.gemini/antigravity-cli/plugins/` path is not read at runtime).
- A compliant plugin contains `plugin.json` plus optional `mcp_config.json`, `hooks.json`, `skills/`, `agents/`, and `rules/`.
- Antigravity hooks use a top-level named-hook map in `hooks.json`, but N|Solid does not ship startup guidance hooks because auth guidance is handled by explicit setup commands and runtime MCP errors.
- CLI management commands include `agy plugin list`, `agy plugin install`, `agy plugin disable`, `agy plugin enable`, and `agy plugin uninstall`.
- The `agent-skills` example validates local plugin structure with `agy plugin validate /path/to/agent-skills` and relies on Antigravity discovering `skills/` inside the installed plugin.

Design impact:

- Generate `dist/plugins/antigravity/nsolid-plugin/` with `plugin.json`, `mcp_config.json`, `scripts/install.js`, `scripts/mcp-wrapper.js`, and `skills/`.
- Native Antigravity install should stage artifact-local assets, not resolve skills from `@nodesource/plugin-core` at install time.
- Native install should not write global skill directories or start auth. It may print `nsolid-plugin setup --harness antigravity` as the next step.
- Fallback direct install can still write `~/.gemini/config/mcp_config.json` and `~/.gemini/config/skills/` when users cannot use `agy plugin install`.

## OpenCode docs and fallback decision

Key findings:

- OpenCode plugins are JavaScript/TypeScript modules loaded from `.opencode/plugins/`, `~/.config/opencode/plugins/`, or npm packages listed in the `plugin` config key.
- OpenCode plugin installation is runtime/module based. npm plugins are installed by Bun at startup and cached under `~/.cache/opencode/node_modules/`; local plugins are loaded directly from plugin directories.
- Official plugin docs describe plugins as hooks, custom tools, event subscribers, and integrations. They do not define a native plugin artifact manifest equivalent to `.claude-plugin/plugin.json`, `.codex-plugin/plugin.json`, or Antigravity `plugin.json` that can bundle MCP servers.
- OpenCode config docs treat `.opencode` directories as a separate config source for `agents`, `commands`, `modes`, `plugins`, `skills`, `tools`, and `themes`.
- OpenCode agents can be defined in config JSON or Markdown files under `~/.config/opencode/agents/` or `.opencode/agents/`.
- OpenCode skills are discovered natively from directory layouts such as `.opencode/skills/<skill>/SKILL.md`, `~/.config/opencode/skills/<skill>/SKILL.md`, `.claude/skills/`, `~/.claude/skills/`, `.agents/skills/`, and `~/.agents/skills/`.
- OpenCode MCP servers are documented separately as configuration under the `mcp` key in `opencode.json`, with local and remote server entries. The MCP docs say to define MCP servers in OpenCode config under `mcp`; they do not describe MCP servers being installed by plugin packages.
- There are community/manual examples experimenting with mutating config from plugin hooks to register MCPs, but that is not the stable official distribution contract this repo should depend on.

Design impact:

- Do **not** generate an OpenCode plugin artifact yet. The official docs do not show a native package/artifact format that bundles skills/agents/MCP in one installable unit like Claude, Codex, or Antigravity.
- Keep OpenCode as fallback/direct install:
  - copy N|Solid skills to `~/.config/opencode/skills/`;
  - merge N|Solid MCP servers into `~/.config/opencode/opencode.jsonc` under `mcp`/OpenCode MCP config shape;
  - leave agents/commands/plugin-module support for a future OpenCode-specific enhancement.
- This avoids relying on unofficial config-mutation behavior for MCP registration while still supporting the documented OpenCode mechanisms: skill directories and MCP config.

## Pi package model

Pi is different from Claude/Codex/Antigravity:

- Pi installs packages directly and reads package metadata from `package.json`.
- Keeping `packages/pi-plugin` as a real package is simpler and closer to Pi's install model.
- Pi should receive materialized skills during package `prepack`, then clean them after packing so source mode still has one canonical skill source.
- Pi package activation must not trigger auth. Users run `nsolid-plugin setup --harness pi` explicitly.

## Refactor conclusions

1. **Generated artifacts are the right model for Claude/Codex/Antigravity.** Their native plugin formats want a plugin root with manifests and local component directories, but maintaining those roots as source packages duplicates skills and config.
2. **Marketplace docs do not guarantee npm package installability.** Claude/Codex marketplace catalogs and Antigravity local/remote plugin install expect plugin directories/repos/artifacts, not necessarily npm workspace packages.
3. **Auth must be explicit.** Plugin install and native install scripts can run in contexts where a browser OAuth flow is surprising or unsafe. Startup hooks are not used for auth or guidance because CLI UI visibility is inconsistent.
4. **Artifact-local skills are correct for distribution.** The source tree should not have repeated `skills/` folders, but generated plugin roots should be self-contained.
5. **OpenCode remains fallback-only by design.** OpenCode officially documents plugins as JS/TS hooks/tools/integrations and MCP servers as `opencode.json` config under `mcp`; until OpenCode has a stable plugin artifact contract for MCP bundling, the CLI fallback should write skills and MCP config directly.
6. **Fallback install remains useful.** `nsolid-plugin install --harness <harness>` gives users an escape hatch when a native marketplace/local artifact path is unavailable.

## Current N|Solid implementation targets

```text
packages/core/skills/                       # only committed N|Solid skill source
packages/pi-plugin/                         # real Pi package
plugins/templates/{claude,codex,antigravity}/ # source templates
dist/plugins/{claude,codex,antigravity}/nsolid-plugin/ # generated plugin roots
dist/artifacts/nsolid-<harness>-plugin.tgz  # generated artifacts
```

Validation commands:

```bash
pnpm plugin:check
pnpm plugin:artifacts
pnpm plugin:artifacts:check
pnpm lint
pnpm test
pnpm build
pnpm test:marketplace
```

## Open questions

- Whether Claude and Codex should receive `.zip` artifacts in addition to `.tgz` for marketplace submission convenience.
- Whether OpenCode will later expose a stable plugin artifact/manifest contract for bundling MCP server config. Until then, keep OpenCode fallback-only.
- Which marketplace submission path NodeSource will pursue for Claude/Codex curated/community marketplaces.
