---
name: ns-audit-dependencies
description: >-
  Audits a local Node.js project dependency tree with NCM vulnerability data. Use when the user asks for an npm audit-style security review, package CVEs, direct/transitive vulnerability report, dependency risk assessment, or remediation plan before upgrading. For vulnerabilities actually loaded in running N|Solid processes, use ns-analyze-vulnerabilities instead.
---

### 1. Collect and Query

**If grounded audit data is already provided in the prompt** (a `## Audit Results` block injected by the host), use it exclusively. Skip the bundled helper and live enrichment; the injected data is the complete source of truth.

**Otherwise (agent mode):**
- Run the bundled audit helper from the project root (use the absolute path of the directory where you read this SKILL.md):
  ```
  node "<skill-dir>/audit-dependencies.cjs" --dir "$PWD"
  ```
- The helper requires outbound HTTPS access to `api.ncm.nodesource.com`. If the current command sandbox is known to block network access, request scoped escalation for this exact helper command before starting it. Let the harness ask the user for approval; never request broad or full-access sandbox permissions.
- The helper parses the lockfile, queries NCM in batches, retries transient failures, splits an exhausted batch once, retries omitted responses once, discards clean-package responses, and prints one compact JSON summary. For active findings it also verifies range-boundary candidates with NCM, then tests `latest` only as a fallback candidate and emits the concrete returned version when clean. Treat the summary as authoritative.
- Large audits and internal recovery can remain active while the helper reports compact progress, retries, and recovery on stderr. Poll the same execution session until it exits and returns the final JSON on stdout.
- Do not launch `wait.cjs`, start a second audit, or restart an audit automatically. If the original execution session is lost or terminated before it returns JSON, report the audit as incomplete.
- Do not call `getPackageVersions` or `getPackageQuality` after the helper succeeds. Raw dependency lists and clean NCM responses must stay outside model context.
- Inspect `batchFailures` before reporting results. If a completed attempt checked zero packages, left every package unchecked, and has only terminal `network` failures, request scoped network approval and rerun the exact helper command once; do not retry without approval. For `authentication`, direct the user to run `nsolid-plugin setup --harness <harness>`. For other failures, report the affected packages as unchecked; never describe them as safe.
- If the helper fails before returning a summary, report the error. Do not fall back to model-driven per-package MCP calls unless the user explicitly requests that slower fallback.

Do not add N|Solid live enrichment to this static audit. If the user explicitly asks which findings are loaded in running processes, run `ns-analyze-vulnerabilities` as a separate workflow.

### 2. Present an Audit Report
Emit the audit directly in chat as markdown with these sections:

**Summary** — total packages checked, total vulnerabilities found (by severity), count of packages that could not be checked, aggregate terminal batch-failure reasons, and recovery counts from `batchRecovery` when any retries, splits, or omitted-response recovery occurred. Summarize `remediation` separately: verified targets, unresolved findings, verification failures, withdrawn-only findings requiring no action, and candidate-recovery/failure counts. A remediation failure does not make the installed package unchecked when its primary vulnerability scan succeeded.

**Prioritized Findings** — sorted critical → high → medium → low. Render one separate finding block for every returned package version; never combine packages or versions into a single bullet. Include direct/transitive status and list every returned vulnerability with its severity, title, ID, URL, `vulnerable` ranges, and `patched` ranges when present. Mark advisories with `withdrawn: true` as withdrawn without silently removing them. Include the package's license, module risks, and code-quality issues from the finding. Render its remediation status exactly: `ncm-verified` with version/source/change type, `unresolved`, `verification-failed`, or `not-required` for withdrawn-only findings. Describe `ncm-verified` as free of active NCM advisories at audit time, not absolutely safe. If `truncatedFindings` is greater than zero, state exactly how many package findings were omitted.

**Remediation Plan** — give package-specific commands for each direct critical/high finding only when `remediation.status` is `ncm-verified`, using its exact `remediation.version` and the detected package manager (npm / yarn / pnpm). Never emit the literal `@latest`. For `unresolved`, report the ranges as upgrade-selection evidence and require candidate verification before pinning. For `verification-failed`, say verification could not complete without weakening the vulnerability finding. For transitive findings, provide the appropriate `why` command and instruct the user to upgrade the introducing parent; use overrides/resolutions only temporarily with an `ncm-verified` version.

**Breaking Change Notes** — use `remediation.changeType` to flag major-version bumps required to fix vulnerabilities; remind the user to review official changelogs.

**Rollback Guidance** — N|Solid backs up `package.json` and the lockfile to `.nsolid/backup/` before each upgrade. If an upgrade causes issues, the user can click "Rollback" in the post-upgrade notification or restore manually from that directory.

### 3. Write the Report to Disk
- Ask the user if they want to save the report to disk.
- If the user confirms, write the final audit report as a markdown file (`.md`) under `.nsolid/assets/` — for example `.nsolid/assets/dependency-audit-<projectName>.md`.

## Guardrails
- Never hallucinate CVE IDs, vulnerability titles, or severity levels. Use only what NCM returns. If a package cannot be checked, report it as unchecked rather than safe.
- Never turn `latest-fallback` into `@latest`; use only the concrete NCM-returned `remediation.version`. Never infer a fixed version from a vulnerable range when remediation is unresolved.
- When host-provided audit data is in the prompt, analyze only that data — do not re-fetch.
- Present every finding returned by the helper even when the report is long. The helper enforces the 50-package detail limit; do not compress its returned findings further.
- Rollback reminder is mandatory in every audit response.
