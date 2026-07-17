---
name: ns-audit-dependencies
description: >-
  Audits a local Node.js project dependency tree with NCM vulnerability data. Use when the user asks for an npm audit-style security review, package CVEs, direct/transitive vulnerability report, dependency risk assessment, or remediation plan before upgrading. For vulnerabilities actually loaded in running N|Solid processes, use ns-analyze-vulnerabilities instead.
---

## Run the audit

If the prompt already contains host-provided audit data, use only that data. Treat it as complete only when it contains renderer-produced Markdown or an equivalent integrity-checked artifact.

Otherwise, run the bundled helper from the project root using the absolute directory containing this `SKILL.md`:

```bash
node "<skill-dir>/audit-dependencies.cjs" --dir "$PWD" --format summary --save-report
```

The helper requires HTTPS access to `api.ncm.nodesource.com` and writes the complete report under `<project>/.nsolid/assets/`. Request escalation scoped to this command when the sandbox blocks either operation. It reports progress and recovery on stderr, saves the complete integrity-checked report itself, and emits a deterministic executive summary with the absolute report link on stdout. Poll the same session until it exits; do not start another audit or use model-driven per-package calls after the helper succeeds.

If the helper reports `AUDIT_REPORT_RETRY_REQUIRED`, it deliberately saved no report because every package was unchecked solely by retryable transport failures. Request scoped network approval and rerun the exact command once. If the retry returns the same code, report the audit as incomplete and do not retry again.

If the helper reports `AUDIT_REPORT_AUTHENTICATION_REQUIRED`, it deliberately saved no report. Direct the user to run `nsolid-plugin setup --harness <harness>` and do not rerun until credentials are configured. For other incomplete results, present the saved report and never describe unchecked packages as safe.

## Present the report

Treat successful summary stdout as the complete final chat response. Return it verbatim, preserving its wording, heading order, line breaks, lists, tables, counts, and report link; only the final trailing newline may be omitted. Do not add a preface, conclusion, interpretation, save question, or follow-up offer. Keep progress-only stderr outside the response because its aggregates are already rendered. Treat the linked file—not the chat summary—as the authoritative complete report.

The deterministic summary always uses this section order:

1. `## Executive Summary`
2. `## Critical Findings`
3. `## Verified Upgrade Actions`
4. `## Findings Requiring Follow-up`
5. `## Withdrawn-Only Findings`
6. `## Coverage Gaps`
7. `## Complete Report`

Do not recreate this structure from the saved report or use a model-authored summary template. If successful stdout does not follow this contract, report an output-integrity failure instead of repairing it.

If the helper reports `AUDIT_REPORT_INTEGRITY_ERROR` or fails to save a publishable report, state that the audit report is incomplete. Do not reconstruct a report from partial output and do not save model-rewritten report text.

When the user asks for details, read the exact linked report and answer from it without rerunning the audit. Rerun only when the user explicitly requests a fresh audit. Never overwrite or replace the saved report.

## Guardrails

- This is a static dependency audit. Use `ns-analyze-vulnerabilities` separately only when the user asks which findings are loaded in running N|Solid processes.
- Never invent CVE IDs, severities, fixed versions, or package ownership.
- `ncm-verified` means free of active NCM advisories at audit time, not absolutely safe.
- Never convert a concrete `latest-fallback` result into `@latest`.
- JSON remains available for programmatic callers by omitting `--format` or using `--format json`; the complete report remains available on stdout with `--format markdown`.
