# N|Solid Plugin QA Guide

Use from the repository root. Commands are macOS/Linux shell commands unless noted.

This guide is local/pre-release QA first. Production/release-artifact variants are included where useful, but the default path is to build and install from this checkout.

## 0. Prerequisites

```bash
node --version
pnpm --version
```

Verify Node is `>=22.3.0` and pnpm is installed.

Optional harness CLIs for manual install QA:

```bash
claude --version
codex --version
agy --version
pi --version
opencode --version
```

Install any missing harness before running that harness section.

## 1. Clean repo/build QA

```bash
pnpm install --frozen-lockfile
pnpm build
pnpm plugin:check
pnpm plugin:artifacts
pnpm plugin:artifacts:check
pnpm lint
pnpm test
pnpm test:marketplace
```

Expected: every command exits `0`.

## 2. Plugin artifact QA inputs

For local pre-release QA, generate the release-shaped plugin artifacts from this repo and install those generated directories:

```bash
pnpm plugin:artifacts
export CLAUDE_PLUGIN_ARTIFACT="$(pwd)/dist/plugins/claude/nsolid-plugin"
export CODEX_PLUGIN_ARTIFACT="$(pwd)/dist/plugins/codex/nsolid-plugin"
export ANTIGRAVITY_PLUGIN_ARTIFACT="$(pwd)/dist/plugins/antigravity/nsolid-plugin"
```

For production/release QA, use released plugin artifacts, not source package directories. A release should provide one archive per native plugin-owned harness:

```text
nsolid-claude-plugin.tgz       # plugin root contains .claude-plugin/{plugin,marketplace}.json, .mcp.json, scripts/, skills/
nsolid-codex-plugin.tgz        # plugin root contains .codex-plugin/plugin.json, .mcp.json, .agents/plugins/marketplace.json, skills/
nsolid-antigravity-plugin.tgz  # plugin root contains plugin.json, mcp_config.json, scripts/, skills/
```

Extract the downloaded archives into plugin-root directories and point QA at them:

```bash
export ARTIFACT_DIR="$(mktemp -d -t nsolid-plugin-artifacts-XXXXXX)"
mkdir -p "$ARTIFACT_DIR/claude" "$ARTIFACT_DIR/codex" "$ARTIFACT_DIR/antigravity"
tar -xzf /path/to/nsolid-claude-plugin.tgz -C "$ARTIFACT_DIR/claude" --strip-components=1
tar -xzf /path/to/nsolid-codex-plugin.tgz -C "$ARTIFACT_DIR/codex" --strip-components=1
tar -xzf /path/to/nsolid-antigravity-plugin.tgz -C "$ARTIFACT_DIR/antigravity" --strip-components=1
export CLAUDE_PLUGIN_ARTIFACT="$ARTIFACT_DIR/claude"
export CODEX_PLUGIN_ARTIFACT="$ARTIFACT_DIR/codex"
export ANTIGRAVITY_PLUGIN_ARTIFACT="$ARTIFACT_DIR/antigravity"
```

Validate the selected artifacts:

```bash
test -f "$CLAUDE_PLUGIN_ARTIFACT/.claude-plugin/plugin.json"
test -f "$CLAUDE_PLUGIN_ARTIFACT/.claude-plugin/marketplace.json"
test -f "$CLAUDE_PLUGIN_ARTIFACT/.mcp.json"
test -f "$CODEX_PLUGIN_ARTIFACT/.codex-plugin/plugin.json"
test -f "$CODEX_PLUGIN_ARTIFACT/.mcp.json"
test -f "$CODEX_PLUGIN_ARTIFACT/.agents/plugins/marketplace.json"
test -f "$ANTIGRAVITY_PLUGIN_ARTIFACT/plugin.json"
test -f "$ANTIGRAVITY_PLUGIN_ARTIFACT/mcp_config.json"
find "$CLAUDE_PLUGIN_ARTIFACT" "$CODEX_PLUGIN_ARTIFACT" "$ANTIGRAVITY_PLUGIN_ARTIFACT" -path '*/skills/*/SKILL.md' | sort | wc -l
```

Expected: all `test` commands exit `0`; skill count is non-zero and matches generated artifact expectations.

## 3. Real HOME CLI QA setup

This QA flow uses your real HOME and modifies real harness configs.

```bash
export REPO_ROOT="$(pwd)"
export REAL_HOME="$(node -e 'console.log(require("node:os").homedir())')"
export HOME="$REAL_HOME"
export CLI="node $REPO_ROOT/packages/core/dist/src/cli.js"
echo "Using real HOME: $HOME"
```

Confirm CLI help:

```bash
$CLI --help
```

Expected: help lists `setup`, `install`, `uninstall`, `logout`, `doctor`, and `restore`.

## 4. CLI auth/setup flow

Use a real NodeSource account.

Production accounts:

```bash
$CLI logout
$CLI setup --harness claude --yes
```

Staging accounts:

```bash
$CLI logout
$CLI setup --harness claude --yes --staging
```

Expected: browser opens, OAuth completes, credentials are stored.

Production accounts:

```bash
test -f "$HOME/.agents/.nodesource-auth.json"
$CLI setup --harness codex --yes
$CLI setup --harness antigravity --yes
```

Staging accounts:

```bash
test -f "$HOME/.agents/.nodesource-auth.json"
$CLI setup --harness codex --yes --staging
$CLI setup --harness antigravity --yes --staging
```

Expected: no second browser if credentials are still valid; output says credentials are ready.

## 5. CLI fallback install must not open browser

```bash
$CLI logout
for h in claude codex antigravity opencode pi; do
  $CLI install --harness "$h" --yes || true
done
```

Expected: no browser opens. Missing auth should print `nsolid-plugin setup --harness <harness>`, not start OAuth.

Required end-of-step cleanup before continuing. This removes fallback user-level MCP entries so native plugin QA does not show duplicate MCP servers:

```bash
for h in claude codex antigravity pi; do
  $CLI uninstall --harness "$h" --keep-credentials || true
done
```

Expected: fallback artifacts for Claude/Codex/Antigravity/Pi are removed; credentials are kept.

Now authenticate again for full fallback checks.

Production accounts:

```bash
$CLI setup --harness opencode --yes
```

Staging accounts:

```bash
$CLI setup --harness opencode --yes --staging
```

Expected: browser opens if logged out; OpenCode fallback skills/config are installed after auth.

## 6. CLI doctor / uninstall / logout

```bash
$CLI doctor --harness opencode || true
$CLI doctor --harness opencode --json || true
$CLI uninstall --harness opencode --keep-credentials
$CLI logout
```

Expected:
- `doctor` reports health or clear actionable failures.
- `uninstall` removes fallback OpenCode artifacts.
- `logout` removes credentials or says none were found.

## 7. Claude Code native install QA

Production accounts:

```bash
export HOME="$REAL_HOME"
claude plugin validate "$CLAUDE_PLUGIN_ARTIFACT"
claude plugin marketplace add "$CLAUDE_PLUGIN_ARTIFACT"
claude plugin install nsolid-plugin@nodesource-local
$CLI setup --harness claude --yes
claude plugin list
claude plugin details nsolid-plugin@nodesource-local
```

Staging accounts:

```bash
export HOME="$REAL_HOME"
claude plugin validate "$CLAUDE_PLUGIN_ARTIFACT"
claude plugin marketplace add "$CLAUDE_PLUGIN_ARTIFACT"
claude plugin install nsolid-plugin@nodesource-local
$CLI setup --harness claude --yes --staging
claude plugin list
claude plugin details nsolid-plugin@nodesource-local
```

Expected:
- Marketplace add/plugin install does not open browser.
- `setup` is the only step that may open browser.
- Plugin appears in Claude plugin list as `nsolid-plugin@nodesource-local`.
- `claude plugin details` shows the N|Solid component inventory.
- mcps are listed and connected, check with `/mcp`
- skills are listed, check with `/skills`

Cleanup:

```bash
claude plugin uninstall nsolid-plugin || true
claude plugin marketplace remove nodesource-local || true
$CLI uninstall --harness claude --keep-credentials || true
```

## 8. Codex native install QA

Production accounts:

```bash
export HOME="$REAL_HOME"
codex plugin remove nsolid-plugin@codex-plugin || true
rm -rf "$HOME/.codex/plugins/cache/codex-plugin/nsolid-plugin"
codex plugin marketplace add "$CODEX_PLUGIN_ARTIFACT"
codex plugin add nsolid-plugin@codex-plugin
$CLI setup --harness codex --yes
codex /plugins
```

Staging accounts:

```bash
export HOME="$REAL_HOME"
codex plugin remove nsolid-plugin@codex-plugin || true
rm -rf "$HOME/.codex/plugins/cache/codex-plugin/nsolid-plugin"
codex plugin marketplace add "$CODEX_PLUGIN_ARTIFACT"
codex plugin add nsolid-plugin@codex-plugin
$CLI setup --harness codex --yes --staging
codex /plugins
```

Expected:
- Marketplace/plugin install does not open browser.
- `setup` is the only step that may open browser.
- Plugin appears in Codex plugins UI/list.
- Local pre-release reruns clear only the N|Solid Codex plugin cache so regenerated artifacts are recopied.
- mcps are listed and connected, check with `/mcp`
- skills are listed, check with `/skills`

Cleanup:

```bash
codex plugin remove nsolid-plugin@codex-plugin || true
rm -rf "$HOME/.codex/plugins/cache/codex-plugin/nsolid-plugin"
$CLI uninstall --harness codex --keep-credentials || true
```

If `codex plugin remove nsolid-plugin@codex-plugin` is unavailable, remove it through `codex /plugins`.

## 9. Antigravity native install QA

Production accounts:

```bash
export HOME="$REAL_HOME"
agy plugin validate "$ANTIGRAVITY_PLUGIN_ARTIFACT"
agy plugin install "$ANTIGRAVITY_PLUGIN_ARTIFACT"
agy plugin list
$CLI setup --harness antigravity --yes
```

Staging accounts:

```bash
export HOME="$REAL_HOME"
agy plugin validate "$ANTIGRAVITY_PLUGIN_ARTIFACT"
agy plugin install "$ANTIGRAVITY_PLUGIN_ARTIFACT"
agy plugin list
$CLI setup --harness antigravity --yes --staging
```

Expected:
- Validate/install succeeds.
- Native install does not open browser.
- `setup` is the only step that may open browser.
- Plugin appears in `agy plugin list`.
- mcps are listed and connected, check with `/mcp`
- skills are listed, check with `/skills`

Cleanup:

```bash
agy plugin uninstall nsolid-plugin || true
$CLI uninstall --harness antigravity --keep-credentials || true
```

## 10. Pi package install QA

Local pre-release package QA with production accounts:

```bash
export HOME="$REAL_HOME"
$CLI uninstall --harness pi --keep-credentials || true
find "$HOME/.pi/agent/skills" "$HOME/.agents/skills" -maxdepth 1 -name 'ns-*' -exec rm -rf {} + 2>/dev/null || true
pnpm plugin:materialize
pi install ./packages/pi-plugin --no-approve
$CLI setup --harness pi --yes
pi install npm:pi-mcp-adapter
$CLI doctor --harness pi || true
```

Local pre-release package QA with staging accounts:

```bash
export HOME="$REAL_HOME"
$CLI uninstall --harness pi --keep-credentials || true
find "$HOME/.pi/agent/skills" "$HOME/.agents/skills" -maxdepth 1 -name 'ns-*' -exec rm -rf {} + 2>/dev/null || true
pnpm plugin:materialize
pi install ./packages/pi-plugin --no-approve
$CLI setup --harness pi --yes --staging
pi install npm:pi-mcp-adapter
$CLI doctor --harness pi || true
```

Production package QA uses the published Pi package instead of the local package directory:

```bash
export HOME="$REAL_HOME"
$CLI uninstall --harness pi --keep-credentials || true
find "$HOME/.pi/agent/skills" "$HOME/.agents/skills" -maxdepth 1 -name 'ns-*' -exec rm -rf {} + 2>/dev/null || true
pi install npm:@nodesource/pi-plugin
$CLI setup --harness pi --yes
pi install npm:pi-mcp-adapter
$CLI doctor --harness pi || true
```

Expected:
- Pi package installs from npm for production QA or from `./packages/pi-plugin` for local pre-release QA.
- Pi package activation is side-effect free: no browser, no user-level skill copy, no MCP config write.
- `setup` is the only step that may open browser.
- Pi `setup` writes/refreshes MCP config but skips user-level skill copies because the Pi package owns skills.
- `pi-mcp-adapter` is installed so Pi can read `~/.pi/agent/mcp.json` and expose MCP-backed package skills.
- `packages/pi-plugin/skills/` exists only after local materialization/pack steps.
- Pi should not report N|Solid skill conflicts from stale fallback copies in `~/.pi/agent/skills` or `~/.agents/skills`.
- `~/.pi/agent/mcp.json` NodeSource entries include `"auth": false` so `pi-mcp-adapter` does not attempt OAuth dynamic registration; authentication uses the NodeSource service-token headers written by setup.

Reload Pi if needed:

```text
/reload
```

Cleanup:

```bash
$CLI uninstall --harness pi --keep-credentials || true
pnpm plugin:clean
```

## 11. OpenCode CLI-only install QA

OpenCode is CLI-only. `setup --harness opencode` is the primary onboarding command because it authenticates and then performs the direct install; `install --harness opencode` is a no-browser fallback/repair path.

Production accounts:

```bash
export HOME="$REAL_HOME"
$CLI setup --harness opencode --yes
$CLI doctor --harness opencode || true
opencode --version
```

Staging accounts:

```bash
export HOME="$REAL_HOME"
$CLI setup --harness opencode --yes --staging
$CLI doctor --harness opencode || true
opencode --version
```

Expected:
- Skills are written under `$HOME/.config/opencode/skills/`.
- MCP config is merged into `$HOME/.config/opencode/opencode.jsonc`.
- mcps are listed and connected, check with `/mcp`
- skills are listed, check with `/skills`

Cleanup:

```bash
$CLI uninstall --harness opencode --keep-credentials || true
```

## 12. Final cleanup

```bash
$CLI logout || true
pnpm plugin:clean
pnpm plugin:check
```

Expected: cleanup completes and `pnpm plugin:check` exits `0`.
