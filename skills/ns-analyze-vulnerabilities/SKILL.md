---
name: ns-analyze-vulnerabilities
description: >-
  Analyzes live runtime vulnerabilities in the packages connected N|Solid Node.js processes run, from N|Solid. Use when the user wants to know which CVEs are actually present in running apps, active exploitable/live vulnerabilities, malicious packages, zero-day exposure, supply-chain risk in production, Node.js runtime advisories, or production package risk. For static npm-audit-style project dependency scans, use ns-audit-dependencies instead.
---

This skill reads vulnerability findings through the N|Solid MCP server (`nsolid`). The N|Solid tools take a `tenant`: when the token can use one tenant it is the default; otherwise call `list_tenants` once and use the tenant the user names (production and staging are usually separate tenants).

### 1. High-Level Overview
- Call `list_vulnerabilities`: open findings, most severe first. Each names its advisory (GHSA, a malicious-package report MAL, or a Node.js core advisory NODE-CORE), the app, severity, the vulnerable packages with the version that fixes them, the app's own dependencies that bring each in (`via`), and the runtime evidence: `installed`, `loaded` (required by the app) or `running` (seen in CPU profiles). A finding whose CVE CISA lists as exploited in the wild carries `knownExploited`: the CVE, when CISA listed it, its remediation due date, and whether ransomware campaigns use it.
- Narrow large fleets with `app`, `severity` (at least), or `where`, e.g. `severity >= "high" && evidence >= "loaded"`, or `knownExploited` (`expression_help` with context `finding` lists the fields).
- Summarize which app has the most critical issues. Lead with malicious packages (MAL-…) when there are any, then known exploited findings in loaded or running code: attackers use those now, whatever their severity.
- Before saying an app has nothing to fix, `vulnerability_data` shows whether the advisory data is current: when the OSV mirror and CISA's catalog were last checked, and any sync error. Say so when it is stale.
- For the Node.js runtime itself, `list_runtimes` gives each Node.js version in use: its core advisories, the release that fixes them, and whether its line is at or near end of life.

### 2. Detail Per App
- For one advisory, call `get_vulnerability`: its details and references, every app it was found in, and each installed copy — where it is installed, whether it was loaded, the processes that have it, and the shortest chain from the app's own dependency down to it. The first package in a chain is the one to upgrade or replace.
- For one package, `get_sbom` with the `app` and `package` gives every installed copy and why it is there; `find_package` shows which processes and apps run which versions of it.

### 3. When It Was First Seen
- Each finding's `openedAt` is when N|Solid first matched it in that app. A finding resolves when the vulnerable version goes, and reopens if it comes back.

### 4. Propose and Implement
- Locate the target `package.json` in the user's workspace.
- Propose an update to a patched version: of the vulnerable package when the app depends on it directly, otherwise of the dependency at the top of its chain.
- Wait for user approval if the update represents a major breaking change. Otherwise, implement the fix.

### 5. Verify
- Re-run `list_vulnerabilities` (or `get_vulnerability`) to confirm the vulnerability is resolved.
- N|Solid reads each process's packages when it connects and every 6 hours, so a fix shows once the new version is deployed and running. If results do not change, say that verification needs the redeploy; `refresh_agent` with `what: "packages"` asks a running process for its packages now, when the token may act.

### 6. Present a Report
- Emit the analysis directly in chat as markdown:
  - `# Runtime Vulnerability Analysis — <appName-or-fleet>`
  - `## Summary`
  - `## Evidence`
  - `## Findings`
  - `## Remediation Plan`
  - `## Verification`
- Ground every CVE, package, version, and severity in `list_vulnerabilities`, `get_vulnerability`, `get_sbom`, or provided evidence.

### 7. Write the Report to Disk
- Ask the user if they want to save the report to disk.
- If the user confirms, write the final report as a markdown file (`.md`) under `.nsolid/assets/` — for example `.nsolid/assets/runtime-vulnerability-analysis-<appName>.md`.

## Guardrails
- NEVER suggest bumping a major version without explicitly warning the user about potential breaking changes.
- ALWAYS base your analysis on the actual output from the N|Solid tools.
- A malicious package is critical whatever else is true: say so first, and recommend removing it, not upgrading it.
- A known exploited vulnerability in loaded code comes before a higher-severity one that no one is known to exploit.
- Only analyze the application requested, or the one with the most severe findings if none is specified.
