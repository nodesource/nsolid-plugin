---
name: ns-audit-dependencies
description: >-
  Audits a local Node.js project dependency tree with NCM vulnerability data. Use when the user asks for an npm audit-style security review, package CVEs, direct/transitive vulnerability report, dependency risk assessment, or remediation plan before upgrading. For vulnerabilities actually loaded in running N|Solid processes, use ns-analyze-vulnerabilities instead.
---

## Run the audit

If the prompt already contains host-provided audit data, use only that data. Treat it as complete only when it contains renderer-produced Markdown or an equivalent integrity-checked artifact.

Otherwise, run the bundled helper from the project root using the absolute directory containing this `SKILL.md`:

```bash
node "<skill-dir>/audit-dependencies.cjs" --dir "$PWD" --format markdown
```

The helper requires HTTPS access to `api.ncm.nodesource.com`. Request escalation scoped to this command when the sandbox blocks that access. It reports progress and recovery on stderr and emits the final, integrity-checked report on stdout. Poll the same session until it exits; do not start another audit or use model-driven per-package calls after the helper succeeds.

If every package is unchecked solely because of terminal network failures, request scoped network approval and rerun the exact command once. For authentication failures, direct the user to run `nsolid-plugin setup --harness <harness>`. Otherwise report the audit as incomplete; never describe unchecked packages as safe.

## Present the report

Treat successful Markdown stdout as authoritative. Present it without rewriting, regrouping, reordering, or omitting findings. Keep progress-only stderr outside the report because its aggregates are already rendered.

If the helper reports `AUDIT_REPORT_INTEGRITY_ERROR`, state that the audit report is incomplete. Do not reconstruct a report from partial output.

After presenting the complete report, ask whether the user wants it saved as Markdown under `.nsolid/assets/`.

## Guardrails

- This is a static dependency audit. Use `ns-analyze-vulnerabilities` separately only when the user asks which findings are loaded in running N|Solid processes.
- Never invent CVE IDs, severities, fixed versions, or package ownership.
- `ncm-verified` means free of active NCM advisories at audit time, not absolutely safe.
- Never convert a concrete `latest-fallback` result into `@latest`.
- JSON remains available for programmatic callers by omitting `--format markdown` or using `--format json`.
