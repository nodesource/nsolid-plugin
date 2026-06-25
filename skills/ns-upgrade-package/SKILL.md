---
name: ns-upgrade-package
description: >-
  Plans an upgrade for a specific npm package already used by a Node.js project. Use when the user wants to bump/update one dependency, assess semver or breaking changes, resolve peer dependency risk, move to a target version, or get exact package-manager commands. Use ns-replace-package when switching to a different library.
---

### 1. Identify the Package and Current Version
- Extract the package name from the user's request.
- If no version context is provided, read `package.json` and the lockfile to find the installed version (`package-lock` `packages["node_modules/<pkg>"]`, `pnpm-lock` package snapshots, or matching `yarn.lock` entry). Use the package.json range only when no lockfile version exists.
- Note whether the package is a direct dependency, a dev dependency, or not yet installed.

### 2. Fetch NCM Data
- Call `getPackageQuality` with the package name and current version (or `latest` if not installed) to retrieve vulnerability severity, known issues, license, and quality scores.
- The tool returns the latest available version as well — record it.
- If the user specified a target version explicitly, use that instead of latest.

### 3. Assess Workspace Usage
- Search workspace source files (`**/*.{ts,tsx,js,jsx,mjs,cjs}`) for `import ... from '<pkg>'` or `require('<pkg>')` patterns to understand how widely the package is used.
- Check the lockfile for how many other packages in the project depend on this one (transitive impact).

### 4. Classify the Version Change
Apply SemVer heuristics to assess risk:
- **major** (X.0.0 → Y.0.0): potentially breaking — high risk, review API changes carefully.
- **minor** (X.Y.0 → X.Z.0): new features, backward-compatible — medium risk.
- **patch** (X.Y.Z → X.Y.W): bug fixes only — low risk.
- Cross-reference with the number of workspace files using the package and transitive dependents to scale the risk assessment.

### 5. Provide the Upgrade Plan
Return a response with these sections:

1. **Current State** — detected version, source (package.json / lockfile / not found), and workspace usage count.
2. **Latest Version** — the version NCM reports as latest.
3. **NCM Security & Quality** — any vulnerabilities (severity + title), license, module risks flagged by NCM. If NCM data is unavailable, say so explicitly.
4. **SemVer Risk Assessment** — change type (major / minor / patch), risk level, and reasoning based on workspace usage and dependents.
5. **Breaking Changes** — use SemVer heuristics and any NCM-flagged issues. Do NOT fabricate specific changelog entries. Direct the user to the package's official CHANGELOG.md or release notes for the authoritative list.
6. **Step-by-step Upgrade Instructions** — exact commands for the user's package manager (npm / yarn / pnpm), plus any configuration file changes needed.
7. **Post-Upgrade Checklist** — run tests, check deprecation warnings, and verify peer dependencies (`npm ls`, `yarn explain peer-requirements`/`yarn why`, or `pnpm why`).
8. **Rollback Procedure** — N|Solid automatically backs up `package.json` and the lockfile to `.nsolid/backup/` before each upgrade. If something goes wrong, the user can click "Rollback" in the post-upgrade notification, or manually restore from that directory.

### 6. Validate Proposed Alternative (optional)
- If the user asks about switching to a different package instead of upgrading, call `getPackageQuality` for the alternative and compare both results before recommending.

## Tools
- `getPackageQuality` — query NCM for vulnerability severity, known issues, license, and quality scores for a single package.

## Guardrails
- Never fabricate changelog details, breaking changes, or migration guides. NCM data does not include changelogs. Use SemVer heuristics and workspace usage data to assess risk instead, and point the user to official release notes.
- If NCM data is unavailable, state that clearly and base advice only on SemVer classification.
- Do not recommend downgrading to a version with known critical vulnerabilities.
- If peer-dependency conflicts appear, stop and propose compatible version ranges rather than forcing the install.
- Rollback reminder is mandatory in every upgrade response.
