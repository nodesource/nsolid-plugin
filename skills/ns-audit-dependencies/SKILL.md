---
name: ns-audit-dependencies
description: >-
  Audits a local Node.js project dependency tree with NCM vulnerability and quality data. Use when the user asks for an npm audit-style security review, package CVEs, direct/transitive vulnerability report, dependency risk assessment, or remediation plan before upgrading. For vulnerabilities actually loaded in running N|Solid processes, use ns-analyze-vulnerabilities instead.
---

### 1. Collect Dependencies

**If grounded audit data is already provided in the prompt** (a `## Audit Results` block injected by the host), stop at that data: use it exclusively and skip steps 2 (NCM queries) and 3 (N|Solid live enrichment). Do not re-fetch packages that are already covered, and do not continue into any live enrichment or re-fetch logic — the injected data is the complete source of truth.

**Otherwise (MCP-only / agent mode):**
- Run the bundled helper to extract all packages (use the absolute path of the directory where you read this SKILL.md):
  ```
  node "<skill-dir>/collect-dependencies.cjs"
  ```
  The script walks `package.json` and the lockfile (`package-lock.json`, `yarn.lock`, or `pnpm-lock.yaml`) and prints a JSON object:
  ```json
  {
    "packageManager": "npm|yarn|pnpm",
    "direct": 12,
    "transitive": 84,
    "batches": [[{"name":"express","version":"4.18.2","isDirect":true}, ...], ...]
  }
  ```
- Detect the package manager from the `packageManager` field (used later for exact remediation commands).

### 2. Query NCM for Vulnerabilities
- For each batch in `batches`, call `getPackageVersions` with that batch array.
- Collect all packages that have at least one vulnerability reported.
- For critical or high severity findings where you need more detail, call `getPackageQuality` on that specific package.
- Cap batch size at ≤ 100 packages per `getPackageVersions` call.

### 3. Optional: Enrich with N|Solid Live Data
This is enrichment only; the NCM audit path above remains the source of truth. Check `information-dashboard` first.
- No connected agents → skip live enrichment.
- `vulnerabilities` — high-level security overview across connected processes.
- `application-packages` — use the exact `app` name from `information-dashboard`.
- `sbom` — use the exact `app` name; do not guess.

### 4. Present an Audit Report
Emit the audit directly in chat as markdown with these sections:

**Summary** — total packages checked, total vulnerabilities found (by severity), and count of packages that could not be checked.

**Prioritized Findings** — sorted critical → high → medium → low. For each vulnerable package include package name/version, severity/title from NCM, latest safe version if known, and whether it is direct or transitive.

**Remediation Plan** — exact commands for the detected package manager (npm / yarn / pnpm), starting with critical/high issues. Note SemVer breaking changes and use overrides/resolutions for transitive deps the user cannot directly control.

**Breaking Change Notes** — flag major-version bumps required to fix vulnerabilities; remind the user to review official changelogs.

**Rollback Guidance** — N|Solid backs up `package.json` and the lockfile to `.nsolid/backup/` before each upgrade. If an upgrade causes issues, the user can click "Rollback" in the post-upgrade notification or restore manually from that directory.

### 5. Write the Report to Disk
- Ask the user if they want to save the report to disk.
- If the user confirms, write the final audit report as a markdown file (`.md`) under `.nsolid/assets/` — for example `.nsolid/assets/dependency-audit-<projectName>.md`.

## Guardrails
- Never hallucinate CVE IDs, vulnerability titles, or severity levels. Use only what NCM returns. If a package cannot be checked, report it as unchecked rather than safe.
- When host-provided audit data is in the prompt, analyze only that data — do not re-fetch.
- Cap each `getPackageVersions` call at ≤ 100 packages to avoid context overflow.
- If the total vulnerability count exceeds 50 packages, truncate the detailed findings list and note the total count so the user knows the scope.
- Rollback reminder is mandatory in every audit response.
