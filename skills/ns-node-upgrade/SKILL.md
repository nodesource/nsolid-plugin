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
If the `nsolid` MCP server is available, call `list_runtimes` (it takes a `tenant` when the token can use several: `list_tenants`). For each Node.js version the tenant's processes run, it gives the apps and process counts, whether its line is at or within 90 days of end of life (and which line to move to), the Node.js security team's core advisories that affect it, and the lowest release of its line that fixes them all (`upgradeTo`).
- Each row is one Node.js version, tenant-wide over the last day, naming at most 20 apps (`appsOmitted` or `outputCut` mean more). The project's app (its `package.json` `name` or `NSOLID_APPNAME`) named under a version is last-day evidence it ran that version; an omitted app isn't proof of absence. For what runs now, use `find_agents` with the exact `app` (or a valid, escaped `where`) and `status: "connected"`; a `More agents match` notice, cut or error leaves it partial, and every version seen stands. It shows no platform. If production differs from the workspace pin, say so and plan from what runs.
- Advisories and `upgradeTo` are tenant-and-version context. A platform-independent advisory applies to the app named with that version; a platform-restricted one needs that app's platform evidence first. `get_agent` on relevant confirmed agents gives platform and `runtime.fixed` for that actual version and platform: reuse detail already read, keep reads bounded (not one per replica), and mark unchecked or unknown scope incomplete, never all-clear.
- An already authorized `GET /v1/tenants/{tenant}/runtimes?app=<app>` is optional positive last-day evidence for that app, not current-only; keep its advisories and `fixed` (MCP's `upgradeTo`) labeled by that scope, since different tenant, app or platform scopes can give different values. If it refuses the app filter, don't drop or truncate it.
- Recommend the same-line patch first, whatever the line move, when verified applicable evidence supports it; an aggregate-only fix is a scoped candidate with its limits, neither a proven app target nor proof no patch is needed. Missing, null, errored or stale data is incomplete. Before claiming complete coverage, check `vulnerability_data` (it takes no `tenant`) for each Node.js runtime source's `checkedAt`, errors and freshness.
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
