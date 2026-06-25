---
name: ns-generate-sbom
description: >-
  Generates a Software Bill of Materials (SBOM) for a connected or registered N|Solid Node.js app. Use when the user asks for SBOM, software bill of materials, compliance evidence, SOC2/vendor review, license inventory, dependency inventory, or transitive package report for a running application.
---

## Instructions

### 1. Identify Target Application
- Determine the specific `app` name you need the SBOM for.
- If the app name is unknown, call `information-dashboard` (no parameters) to list all connected agents and their `app` names.
- Do NOT use `global-filter` — it returns ~18,000 tokens and is wasteful for a simple app name lookup.

### 2. Determine Format Requirement
- The `sbom` tool's `format` parameter accepts only `"json"` or `"html"`. It does **not** support XML.
- If the user does not specify a format, default to `"html"` (human-readable compliance report).
- Use `"json"` only when the user explicitly wants programmatic/machine analysis (e.g. feeding it to another tool).

### 3. Generate SBOM
- Call the `sbom` tool with the `app` parameter and `format` set to `"html"` (default) or `"json"`.

### 4. Handle Execution Edge Cases
- **Timeout warning**: Generating an SBOM traverses the entire transitive dependency tree of a live process. The N|Solid server extends the timeout to 180 seconds.
- If your MCP client drops the connection at 60s, inform the user the server is still processing, or suggest adjusting their MCP client timeout. Do not retry immediately.

### 5. Provide Output
- If the user asked to download the SBOM, write it directly to the `.nsolid/sbom/` folder (create the folder if it does not exist):
  - HTML: `.nsolid/sbom/<appName>_sbom.html`
  - JSON: `.nsolid/sbom/<appName>_sbom.json`
- Do not stage the output in a temporary file or `/tmp` — write straight to `.nsolid/sbom/`.
- Give the user a high-level summary (total packages, top licenses, notable dependencies) and the saved path.

## Guardrails
- DO NOT pass `format: "xml"` — XML is not supported. Only `"json"` or `"html"`; default to `"html"`.
- DO NOT poll or aggressively retry the SBOM endpoint if it times out — it is computationally expensive.
- DO NOT hallucinate dependencies. Only report what is strictly inside the returned SBOM.
