---
name: ns-analyze-vulnerabilities
description: >-
  Analyzes live runtime vulnerabilities loaded by connected N|Solid Node.js processes. Use when the user wants to know which CVEs are actually present in running apps, active exploitable/live vulnerabilities, zero-day exposure, supply-chain risk in production, or production package risk. For static npm-audit-style project dependency scans, use ns-audit-dependencies instead.
---

### 1. High-Level Overview
- Call the `vulnerabilities` tool with `showLimit`/`page` when scanning large fleets.
- Summarize the output to identify which application (`app`) has the most critical issues.

### 2. Detail Per App
- For a specific vulnerable app, call `application-packages` (parameters: exact `app` name, `mode='flat'`).
- **Timeout note**: The MCP server allows 180s for this streaming endpoint, but the MCP client may drop after 60s. If it times out, proceed using data already collected from the `vulnerabilities` tool.

### 3. Discover First Detection Time
- Call `events-historic` (parameters: `type='new-vulnerability-found'`, plus `app`, `start`, and `end` when known).
- **CRITICAL**: The MCP tool description may incorrectly say `vulnerability-detected`. Do not use that. Valid Security Events: `new-vulnerability-found`, `package-vulnerabilities-updated`, `vulnerabilities-database-updated`, `active-vulns-updated`.
- If this endpoint returns `null`, it means there are no matched historical events. Proceed without failing the audit.

### 4. Propose and Implement
- Locate the target `package.json` in the user's workspace.
- Propose an update to a patched version.
- Wait for user approval if the update represents a major breaking change. Otherwise, implement the fix.

### 5. Verify
- Re-run the `vulnerabilities` tool to confirm the vulnerability is resolved.
- If results do not change, note that verification may require app restart/redeploy or package refresh before live data updates.

### 6. Present a Report
- Emit the analysis directly in chat as markdown:
  - `# Runtime Vulnerability Analysis — <appName-or-fleet>`
  - `## Summary`
  - `## Evidence`
  - `## Findings`
  - `## Remediation Plan`
  - `## Verification`
- Ground every CVE, package, version, and severity in `vulnerabilities`, `application-packages`, or provided evidence.

### 7. Write the Report to Disk
- Ask the user if they want to save the report to disk.
- If the user confirms, write the final report as a markdown file (`.md`) under `.nsolid/assets/` — for example `.nsolid/assets/runtime-vulnerability-analysis-<appName>.md`.

## Guardrails
- NEVER suggest bumping a major version without explicitly warning the user about potential breaking changes.
- ALWAYS base your analysis on the actual output from the `vulnerabilities` and `application-packages` tools.
- Only analyze the application requested, or the one with the highest vulnerabilities if none is specified.
