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
pnpm lint
pnpm test
pnpm test:marketplace
```

Expected: every command exits `0`.

## 2. Real HOME CLI QA setup

This QA flow uses your real HOME and modifies real harness configs.

Local build (default — QA the code in this checkout):

```bash
export REPO_ROOT="$(pwd)"
export REAL_HOME="$(node -e 'console.log(require("node:os").homedir())')"
export HOME="$REAL_HOME"
export CLI="node $REPO_ROOT/packages/core/dist/src/cli.js"
echo "Using real HOME: $HOME"
```

Published package (once `nsolid-plugin` is on npm — QA the shipped artifact instead):

```bash
export REAL_HOME="$(node -e 'console.log(require("node:os").homedir())')"
export HOME="$REAL_HOME"
# stable release:
export CLI="npx -y nsolid-plugin"
# prerelease (published under the next dist-tag):
export CLI="npx -y nsolid-plugin@next"
echo "Using real HOME: $HOME"
```

Confirm CLI help:

```bash
$CLI --help
```

Expected: help lists `setup`, `install`, `uninstall`, `logout`, `doctor`, and `restore`.

## 3. CLI auth/setup flow

Use a real NodeSource account.

Production accounts:

```bash
$CLI logout
$CLI setup --harness claude --yes
```

Staging accounts (use this one for the initial QA):

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

Staging accounts (use this one for the initial QA):

```bash
test -f "$HOME/.agents/.nodesource-auth.json"
$CLI setup --harness codex --yes --staging
$CLI setup --harness antigravity --yes --staging
```

Expected: no second browser if credentials are still valid; output says credentials are ready.

## 4. CLI doctor / uninstall / logout

Install the opencode mcp and skills first

```bash
$CLI install --harness opencode
```


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

## 5. Published CLI package QA

Once `nsolid-plugin` is published to npm, QA the shipped package itself — not the local build — to confirm the `bin` works, the right files ship, and skills/bundle are included.

```bash
# prerelease:
npx -y nsolid-plugin@next --help
# stable release:
npx -y nsolid-plugin --help

# Inspect what the package actually ships (files included in the tarball):
npm pack nsolid-plugin@next --dry-run 2>&1 | sed -n '/Tarball Contents/,/Tarball Details/p'
```

Expected:
- `--help` runs without a local build; the `nsolid-plugin` bin is executable.
- Tarball contents include `dist/src/`, `skills/`, `bundle.json`, and `scripts/`.
- The `bin` entry resolves to `./dist/src/cli.js` and that file is executable.
- No `test/`, no source `*.ts`, no `tsconfig` shipped.

## 6. Claude Code native install QA

Claude installs from the GitHub plugin root. The local path can be the repo checkout itself, or a clone for closer-to-release coverage.
Set `PLUGIN_REF` to the branch or tag under test (e.g., `export PLUGIN_REF=cesar/github-install-test`).

Production accounts:

```bash
claude plugin marketplace add NodeSource/nsolid-plugin@$PLUGIN_REF
claude plugin install nsolid-plugin@nodesource
$CLI setup --harness claude --yes
claude plugin list
claude plugin details nsolid-plugin@nodesource
```

Staging accounts (use this one for the initial QA):

```bash
claude plugin marketplace add NodeSource/nsolid-plugin@$PLUGIN_REF
claude plugin install nsolid-plugin@nodesource
$CLI setup --harness claude --yes --staging
claude plugin list
claude plugin details nsolid-plugin@nodesource
```

Expected:
- Marketplace add/plugin install does not open browser.
- `setup` is the only step that may open browser.
- Plugin appears in Claude plugin list as `nsolid-plugin@nodesource`.
- `claude plugin details` shows the N|Solid component inventory.
- mcps are listed and connected, check with `/mcp`
- skills are listed, check with `/skills`

Cleanup:

```bash
claude plugin uninstall nsolid-plugin || true
claude plugin marketplace remove nodesource || true
$CLI uninstall --harness claude --keep-credentials || true
```

## 7. Codex native install QA

Codex installs from the GitHub plugin root. The marketplace name is `nodesource`.
Set `PLUGIN_REF` to the branch or tag under test.

Production accounts:

```bash
codex plugin marketplace add NodeSource/nsolid-plugin@$PLUGIN_REF
codex plugin add nsolid-plugin@nodesource
$CLI setup --harness codex --yes
codex /plugins
```

Staging accounts (use this one for the initial QA):

```bash
codex plugin marketplace add NodeSource/nsolid-plugin@$PLUGIN_REF
codex plugin add nsolid-plugin@nodesource
$CLI setup --harness codex --yes --staging
codex /plugins
```

Expected:
- Marketplace/plugin install does not open browser.
- `setup` is the only step that may open browser.
- Plugin appears in Codex plugins UI/list.
- Local pre-release reruns clear only the N|Solid Codex plugin cache so recopied assets are recopied.
- mcps are listed and connected, check with `/mcp`
- skills are listed, check with `/skills`

Cleanup:

```bash
codex plugin remove nsolid-plugin@nodesource
$CLI uninstall --harness codex --keep-credentials || true
```

If `codex plugin remove nsolid-plugin@nodesource` is unavailable, remove it through `codex /plugins`.

## 8. Antigravity native install QA

Antigravity installs directly from the GitHub plugin root (a git URL).
Set `PLUGIN_REF` to the branch or tag under test.

Production accounts:

```bash
agy plugin install https://github.com/nodesource/nsolid-plugin/tree/$PLUGIN_REF
agy plugin list
$CLI setup --harness antigravity --yes
```

Staging accounts (use this one for the initial QA):

```bash

agy plugin install https://github.com/nodesource/nsolid-plugin/tree/$PLUGIN_REF
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

## 9. Pi package install QA

Local pre-release package QA with production accounts:

```bash
pnpm plugin:materialize
pi install ./packages/pi-plugin --no-approve
$CLI setup --harness pi --yes
pi install npm:pi-mcp-adapter
$CLI doctor --harness pi || true
```

Local pre-release package QA with staging accounts (use this one for the initial qa):

```bash
pnpm plugin:materialize
pi install ./packages/pi-plugin --no-approve
$CLI setup --harness pi --yes --staging
pi install npm:pi-mcp-adapter
$CLI doctor --harness pi || true
```

Production package QA uses the published Pi package instead of the local package directory:

```bash
$CLI uninstall --harness pi --keep-credentials || true
# stable release:
pi install npm:nsolid-pi-plugin
# prerelease (published under the next dist-tag) — pin the exact version, e.g.:
# pi install npm:nsolid-pi-plugin@1.0.0-next.0
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

## 10. OpenCode CLI-only install QA

OpenCode is CLI-only. `setup --harness opencode` is the primary onboarding command because it authenticates and then performs the direct install; `install --harness opencode` is a no-browser fallback/repair path.

Production accounts:

```bash
$CLI setup --harness opencode --yes
$CLI doctor --harness opencode || true
opencode --version
```

Staging accounts (use this one for the initial qa):

```bash
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

## 11. Final cleanup

```bash
$CLI logout || true
pnpm plugin:clean
pnpm plugin:check
```

Expected: cleanup completes and `pnpm plugin:check` exits `0`.
