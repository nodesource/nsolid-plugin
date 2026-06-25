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

### 3. Recommend a Target Version
Using the release schedule table from step 1:
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

## Guardrails
- The release schedule table from `fetch-node-releases.cjs` or the injected host table is authoritative. Do not override LTS names, EOL dates, or latest patch versions with training-data values.
- If the script fails and no table is injected, say live release data could not be verified; any fallback must be clearly labeled potentially stale.
- Project-pinned version (engines / .nvmrc / .node-version) is authoritative over the runtime on PATH.
- Do not ask the user to run `node --version` if detection already ran.
- Never recommend a Node.js release line that is already EOL.
