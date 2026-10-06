---
name: ns-activity-report
description: >-
  Writes a report of how a team uses N|Solid: who used it and from which clients (the web UI, AI assistants over MCP, scripts), which features and pages, and which AI assistants and MCP tools, day by day, as a self-contained HTML page that can be published as an artifact. Use when an admin asks how N|Solid is used or adopted, who uses it, which AI assistants or MCP tools reach it, or for a usage or adoption report to share.
---

This skill reads what N|Solid's Activity page shows, with one bundled script.
It needs `NSOLID_API_URL` and `NSOLID_API_TOKEN` in the environment, or
`~/.agents/.nsolid-auth.json` with `apiUrl` and `token` (plus `tenant` when
the token can use several tenants). Reading activity needs the Audit log
permission (`nsolid:audit-log`), which tenant admins hold, and the Activity
feature on for the tenant.

### 1. Scope
- **Days:** the last 30 by default, or what the user asks for (`--days 7`, `--days 90`; at most 400), ending today or on `--to <YYYY-MM-DD>`. Days are UTC.
- **Tenant:** the token's, or `NSOLID_TENANT` (the config file's `tenant`) when it can use several. Production and staging are usually separate tenants: one report each.
- **Names:** like the Activity page, the report names people (by email) and API tokens (by name). When it will be shared beyond the tenant's admins, or the user asks for no names, pass `--no-people`: the page then names no one.

### 2. Write the Report
- Run the bundled script (use the absolute path of the directory where you read this SKILL.md):
  ```bash
  node "<skill-dir>/render-activity-report.cjs" --days 30 --artifact
  ```
- It writes `.nsolid/reports/activity-<tenant>-<from>-to-<to>.html`: the totals, people and requests a day, and a table each by client, feature, AI assistant, MCP tool, page and person, in one file that opens in any browser without network. With `--artifact` it also writes `<same name>.artifact.html`, the same page for hosts that add the document around a page.
- It prints a short JSON summary: `file`, `artifactFile`, `title`, `description`, the totals (`people`, `requests`, `actions`, `aiToolCalls`, `timeInUse`) and the busiest clients, features, AI assistants and MCP tools. It never prints people's names. **Never read the HTML files into context**: the summary is all you need.
- If it reports that N|Solid is not configured, or that the token lacks `"nsolid:audit-log"`, say what is needed (the settings above, a tenant admin's token) and stop.
- If an Artifact tool is available, offer to publish `artifactFile` with it (with the printed `title` and `description`). Ask first: publishing uploads the report, with people's names unless `--no-people`. An artifact starts private to the user.

### 3. Present It
- `# N|Solid Activity — <tenant> — <from> to <to>`
- The totals, then what stands out: the busiest features, how much use comes from AI assistants over MCP against the web UI and scripts, and the MCP tools they call most. Ground each claim in the summary's numbers.
- The report's path, and the artifact link if one was published.
- Asked who uses N|Solid most, point to the report's People table rather than reading the report.

## Guardrails
- Read only: this skill changes nothing.
- NEVER read the HTML report into context or copy people's names or emails into the chat; they stay in the report.
- NEVER publish the report without asking: it names people unless `--no-people`.
- Write the report only with the bundled `render-activity-report.cjs` (no direct HTTP calls or curl).
- NodeSource support's requests are never counted in a tenant's activity (the tenant's NodeSource access page lists them); don't report them as missing.
