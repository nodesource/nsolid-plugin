---
name: ns-node-upgrade
description: >-
  Plans a Node.js runtime upgrade for a project. Use when the user asks which Node version to use, upgrade/migrate Node.js, address LTS/EOL, update .nvmrc or engines, or move between Node versions. Produces version detection, LTS/EOL rationale, dependency compatibility checks, upgrade steps, and rollback guidance.
---

### 1. Get the Authoritative Release Schedule
**Before reasoning about LTS or EOL dates**, fetch live data (use the absolute path of the directory where you read this SKILL.md):
```
node "<skill-dir>/fetch-node-releases.cjs"
```
The script prints a markdown table fetched from `endoflife.date` (with an offline fallback):

```
| Major | Status | Latest | Active Support End | EOL |
|-------|--------|--------|--------------------|-----|
| 24    | Current | 24.x.x | ...               | ... |
| 22    | LTS (Jod) | 22.x.x | ...            | ... |
...
```

**If a release schedule table is already injected into the prompt by the host** (labelled `AUTHORITATIVE Node.js release schedule`), use it verbatim — do not run the script, do not substitute values from your training data.

In all cases: treat the table as the source of truth for LTS names, EOL dates, and latest patch versions. Do not override it with training-data values.

### 2. Detect the Current Node.js Version
If detection results are already provided in the prompt (labelled `Detected Node.js version information`), use those results and skip manual detection.

Otherwise, check in order:
1. `package.json` → `engines.node` field (project pin — authoritative for the project).
2. `.nvmrc` file in the workspace root.
3. `.node-version` file in the workspace root.
4. Run `node --version` as a fallback for the runtime on PATH.

**At the start of your response**, briefly tell the user which source was used to determine the current version (one sentence). If the project-pinned version and the runtime on PATH disagree, treat the project pin as authoritative and note the mismatch.

### 2b. Check What Production Runs (when N|Solid is available)
If the `nsolid` MCP server is available, call `list_runtimes` (it takes a `tenant` when the token can use several: `list_tenants`). For each Node.js version the tenant's processes run, it gives the apps and process counts, whether its line is at or within 90 days of end of life (and which line to move to), the Node.js security team's core advisories that affect it, and the lowest release of its line that fixes them all (`upgradeTo`). It is tenant-wide: each row is one Node.js version, combined across the apps and platforms that ran it in the last day. Unfiltered REST `GET /v1/tenants/{tenant}/runtimes` has that same scope; `?app=<app>` aggregates only that app's last-day platforms, so its `runtimes[].fixed` may differ. `upgradeTo` is the MCP name for the corresponding `fixed` field, not a promise of the same value across different scopes. Keep positive advisories and fixes as observations labeled with their actual scope and window: tenant-wide advisories stay tenant context and aren't attributed to the project's app without app and platform evidence, even when the app is named in the row. Neither aggregate proves the current app or platform patch target or an all-clear.
- Find the project's app among them (its `package.json` `name` or `NSOLID_APPNAME`). Each version names at most 20 apps; `appsOmitted` and an `outputCut` notice mean some are hidden, so an app missing from the list is not proof that it doesn't run. Confirm what a known app runs now with `find_agents` given the exact `app` and `status: "connected"` (or a `where` with the app name escaped in the expression language's string syntax, plus `status: "connected"`). Historical, disconnected or exited processes are not confirmation of what production runs now. The result is partial on a `More agents match` notice or on a cut, too-large notice or error in any content block; a result that fills the default 50 or the requested limit is not proof of completeness either. Every version it does show stands; don't claim it covers all of the app's processes. Production may run a different version than the workspace pins: say so, and plan from what runs.
- `find_agents` gives each process's version but not its platform; never infer a platform from it. Get each pair's platform before grouping, then one runtime verdict per version and platform pair, reusing any detail already read:
  - When an app-scoped `GET /v1/tenants/{tenant}/agents` is already authorized, page it with `status=connected` and the exact nonempty `app` for each process's `nodeVersion` and platform, then read `get_agent` once per observed pair rather than for every identical replica. If the REST `app` filter rejects a long name, use a supported `where` with the exact app expression, properly escaped, when it can be represented; don't invent fields or simplify the target; otherwise keep what was observed and mark that scope unavailable.
  - Paging an authorized REST connected-agent inventory successfully through its final page closes the `find_agents` sampling gap, but live pages aren't an atomic snapshot: state when the scan ran and what it observed, and keep and reconcile any version seen earlier that it contradicts rather than deleting it or claiming an instantaneous all-clear for the whole app. A cursor or page error leaves the inventory partial. Completeness comes from the inventory actually used, plus known version and platform and verdict and freshness coverage.
  - MCP-only, use `find_agents` and a bounded number of `get_agent` checks; any process or platform left unexamined keeps coverage explicitly incomplete rather than reading every agent. `get_agent` has no `list_*` cap, but still honor any actual client truncation, persistence, error or incomplete-response notice on its result.
  - When process detail is unavailable or denied, keep the last-day aggregate evidence from `list_runtimes` (tenant-wide) or an authorized `GET /v1/tenants/{tenant}/runtimes?app=<app>` (that app only) (positive advisories and `upgradeTo`/`runtimes[].fixed`), labeled with its scope, window and coverage limit: it doesn't prove which platforms run now and is neither a connected-only patch proof nor an all-clear. A missing or stale `checkedAt` or a reported `error` makes coverage incomplete without discarding known findings, and the `vulnerability_data` source check below applies to this fallback too.
- Prefer these verified per-platform connected-agent verdicts for the current same-line patch decision: each gives end of life, core advisories and the fixing release as `runtime.fixed`, for that agent's actual version and platform; it can differ from the aggregate `upgradeTo`.
  - A verdict covers only that agent's own version and platform: one process doesn't prove other platforms safe. An unknown platform or a missing or null `runtime` leaves that agent uncovered, never clean.
  - Each confirmed version and platform pair needs a verdict; a partial `find_agents` leaves the rest of the app's processes uncovered.
  - Before claiming complete advisory coverage, check `vulnerability_data` (it takes no `tenant`) for each Node.js runtime source's `checkedAt`, errors and freshness; an aggregate `checkedAt` alone doesn't prove every source fresh.
  - If a source is missing, stale or failed, or any pair or process is left without a verdict, say advisory coverage is incomplete, keep the advisories observed, and don't conclude that no same-line patch is needed.
- When a same-line fixing release is shown to apply to the verified target version and platform (per-agent `runtime.fixed`), recommend that patch upgrade first, whatever the line move: it is the smallest change that fixes them. An aggregate `upgradeTo`/`runtimes[].fixed` stays an observation for its own scope; don't prescribe a tenant-wide `upgradeTo` as the project app's patch.
- If the server isn't available, continue from the workspace alone.

### 3. Recommend a Target Version
Using the release schedule table from step 1 (and production's runtimes from step 2b, when known):
- Identify the current version's release line.
- If it is already EOL or approaching EOL (within 6 months), recommend upgrading to the newest Active LTS line.
- If it is on an Active LTS line, upgrading to the next LTS is optional but note the timeline.
- If it is on a Current (odd/even non-LTS) line, recommend moving to the nearest stable LTS.
- Never recommend a line that is already EOL.

### 4. Provide the Upgrade Guide
Return a response with these sections:

1. **Current Version** — detected version and how it was determined.
2. **Active Node.js Release Lines** — summary table from step 1.
3. **Recommended Target** — the specific version to upgrade to and why.
4. **Key Changes** — breaking changes and notable new features between the current and target versions. Use well-known facts; do not hallucinate specific API changes. Point the user to the official Node.js changelog for the authoritative list.
5. **Step-by-Step Upgrade Guide**:
   - Update `.nvmrc` / `.node-version` to the new version.
   - Update `engines.node` in `package.json` if present.
   - Run `nvm install <version> && nvm use <version>` (or equivalent for fnm/n).
   - Update CI/CD configuration (GitHub Actions `node-version`, Dockerfile `FROM node:X`, etc.).
   - Run tests with the new version and watch for deprecation warnings.
   - Check for incompatible native modules (`node-gyp` rebuild if needed).
6. **Dependency Compatibility** — read direct deps from `package.json` (`dependencies`, `devDependencies`, `optionalDependencies`) and call `getPackageVersions` with `{name, version}` entries to check target-Node incompatibilities if NCM reports them.
7. **Verification** — how to confirm the upgrade was successful (`node --version`, test suite, check for `DeprecationWarning`s in output).

### 5. Re-detect if Needed
If the user asks about a specific version mid-conversation, re-run the detection in step 2 (`package.json` engines, `.nvmrc`, `.node-version`, or `node --version`) to refresh the current version.

## Tools
- `getPackageVersions` — check direct dependencies for known incompatibilities with target Node version.
- `list_runtimes` (`nsolid` server, when available) — the Node.js versions production runs, their end of life, core advisories and the release that fixes them (`upgradeTo`, tenant-wide per version over the last day's apps and platforms).
- `find_agents` (`nsolid` server, when available) — the connected processes of one app (`app`, `status: "connected"`), with the Node.js version each runs.
- `get_agent` (`nsolid` server, when available) — one process's platform and runtime verdict for its own version and platform: end of life, core advisories and `runtime.fixed` (per agent; can differ from `list_runtimes`'s aggregate `upgradeTo`).
- `vulnerability_data` (`nsolid` server, when available; takes no `tenant`) — when the advisory sources, Node.js runtime ones included, were last checked, and any sync error.

## Guardrails
- The release schedule table from `fetch-node-releases.cjs` or the injected host table is authoritative. Do not override LTS names, EOL dates, or latest patch versions with training-data values.
- If the script fails and no table is injected, say live release data could not be verified; any fallback must be clearly labeled potentially stale.
- Project-pinned version (engines / .nvmrc / .node-version) is authoritative over the runtime on PATH.
- Do not ask the user to run `node --version` if detection already ran.
- Never recommend a Node.js release line that is already EOL.
