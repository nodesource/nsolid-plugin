---
name: ns-replace-package
description: >-
  Finds and evaluates alternatives to an npm package. Use when the user wants to replace, drop, or swap a dependency, migrate away from a deprecated/abandoned/risky package, or asks "what can I use instead of X?" Compares candidates with NCM data and provides migration/API-diff guidance. Use ns-upgrade-package for staying on the same package.
---

### 1. Identify the Package to Replace
- Extract the package name from the user's request.
- Read `package.json` to confirm whether it is installed and note the current version and whether it is a direct or dev dependency.
- Detect package manager by lockfile (`pnpm-lock.yaml` → pnpm, `yarn.lock` → yarn, `package-lock.json` → npm; default npm).

### 2. Fetch NCM Data for the Target Package
- Call `getPackageQuality` for the package being replaced.
- Document: vulnerabilities (severity + title), license, module risks flagged by NCM (e.g. install scripts, obfuscation, author risk, malware), quality scores.
- Use these findings as the objective reasons why replacement is warranted.

### 3. Propose Alternatives
- Based on the package's domain and the user's context, identify 2–3 realistic alternative packages.
- For **each** proposed alternative, call `getPackageQuality` to retrieve its own vulnerability, license, and quality data before recommending it.
- Discard any alternative that has critical/high vulnerabilities or critical module risks unless the user explicitly asks to include it.
- Do not invent unpublished packages or packages you are not confident exist.

### 4. Compare and Recommend
Present a comparison table or ranked list with these columns:
- Package name
- NCM vulnerability status
- License
- NCM module risks
- Maintenance signal (latest version age, if available from NCM)
- Why it is or isn't recommended

Lead with the strongest recommendation and explain the tradeoff clearly.

### 5. Migration Plan
For the top recommended alternative, provide:
1. **Why replace** — reference the NCM-reported issues with the original package.
2. **Install command** — exact command for the detected package manager.
3. **Uninstall command** — exact command to remove the original package.
4. **API differences** — key differences between the two APIs with before/after code examples. Focus on the most commonly used features.
5. **Configuration changes** — any config files, environment variables, or build-tool settings that need updating.
6. **Test checklist** — what to verify after migration.

## Tools
- `getPackageQuality` — call once for the target package and once for each proposed alternative. Do not recommend an alternative without querying NCM for it first.

## Guardrails
- Do not invent unpublished or fictional alternatives. Only recommend packages that genuinely exist and are relevant to the use case.
- Ground the "why replace" section in NCM-reported data, not general opinion.
- Validate every proposed alternative via `getPackageQuality` before including it in the comparison.
- If NCM data is unavailable for the target, state that clearly and proceed with general guidance only, flagging the absence of grounded data.
