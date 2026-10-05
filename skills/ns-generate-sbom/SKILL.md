---
name: ns-generate-sbom
description: >-
  Generates a runtime Software Bill of Materials (SBOM) from N|Solid for a running N|Solid Node.js app or process: what its processes actually installed and loaded, as CycloneDX. Use when the user asks for SBOM, software bill of materials, compliance evidence, SOC2/vendor review, dependency inventory, or transitive package report for a running application.
---

This skill reads SBOMs through the N|Solid MCP server (`nsolid`) and a bundled script. The script needs the server's settings: `NSOLID_API_URL` and `NSOLID_API_TOKEN` in the environment, or `~/.agents/.nsolid-auth.json` with `apiUrl` and `token` (plus `tenant` when the token can use several tenants).

## Instructions

### 1. Pick the Tenant
- The N|Solid tools take a `tenant`. When the token can use one tenant it is the default; otherwise call `list_tenants` once and use the tenant the user names. Set `NSOLID_TENANT` for the script.

### 2. Identify Target Application
- Determine the specific `app` name you need the SBOM for.
- If the app name is unknown, call `list_apps` for the apps and their process counts.
- An app's SBOM covers its connected processes together. For one process instead, find its `agentId` with `find_agents` (`app`).

### 3. Know What It Contains
- N|Solid builds the SBOM from each process's own package inventory: CycloneDX 1.6, with every installed copy (`nsolid:path`), whether it was loaded (`nsolid:loaded`), the dependency graph, and the advisories each copy matches.
- It has no license fields. If the user needs licenses, say so; `ns-audit-dependencies` covers the project's declared dependencies.

### 4. Summarize
- Call `get_sbom` with the `app` (or `agentId`): how many packages and how many were loaded, the app's own dependencies, packages installed at several versions, and the advisories they match (malicious first, then by severity) with the fix.
- For one package, `get_sbom` with `package` gives each installed copy, whether it was loaded, and why it is there.

### 5. Save It
- If the user asked to download or save the SBOM, run the bundled script (use the absolute path of the directory where you read this SKILL.md):
  ```
  node "<skill-dir>/fetch-nsolid-sbom.cjs" <appName> --html
  ```
  Add `--agent <agentId>` for one process.
- It writes `.nsolid/sbom/<appName>_sbom.cdx.json` (the CycloneDX document) and, with `--html`, `.nsolid/sbom/<appName>_sbom.html`, a page that lists the advisories and every package. It prints a JSON summary with both paths: package, loaded and advisory counts, and advisories by severity.
- Default to `--html` (a human-readable compliance report alongside the document). Leave it out when the user only wants the machine-readable file.
- **Never read the saved files into context**: the printed summary is all you need.

### 6. Provide Output
- Give the user a high-level summary (total packages, how many were loaded, notable dependencies, advisories by severity) and the saved paths.

## Guardrails
- DO NOT hallucinate dependencies. Only report what is in N|Solid's SBOM or summary.
- DO NOT stage the output in a temporary file or `/tmp`: the script writes straight to `.nsolid/sbom/`.
- Save SBOMs only with the bundled `fetch-nsolid-sbom.cjs`, never by copying `get_sbom` output into a file.
