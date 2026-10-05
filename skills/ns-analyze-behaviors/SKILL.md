---
name: ns-analyze-behaviors
description: >-
  Investigates what N|Solid's behavioral watch found: npm packages that newly run programs, compile code, use the network, start threads or touch the file system in production, packages that start running at all, release regressions and dependency drift. Use when the user asks about supply-chain attacks at run time, a compromised or suspicious dependency, what a package started doing, a behavior alert, or dependencies that changed without a release.
---

This skill works through the N|Solid MCP server (`nsolid`). The N|Solid tools take a `tenant`: when the token can use one tenant it is the default; otherwise call `list_tenants` once and use the tenant the user names.

The watch learns what each app's packages do from its CPU profiles, and reports a package doing something it never did before in that app, once the app has a history without it.

### 1. List What It Found
- `list_behaviors` (open ones, most severe first), with `app` when the user names one, `kind` (`capability`, `package`, `regression`, `drift`) or `where`, e.g. `severity >= "high"`, `capability == "network"`, `versionChange`.
- Each behavior names the app, the package and its versions, what it `does`, its severity, the modules and functions involved, when it was first and last seen, and how many profiles showed it against how many before did not.
- `versionChange` means it arrived with a new version of the package while earlier versions never did it. That is how a compromised release of a dependency shows at run time, and it weighs a step more.

### 2. Judge Each One
- **New capability** (`process`: runs programs; `code`: compiles code; `network`; `threads`; `fs`): is it expected of that package? A logging library that starts spawning processes, or a date library that starts using the network, is suspicious; a database driver using the network is not.
  - `package_calls` with the `app` and `callee` (e.g. `node:child_process`, `node:net`) shows which packages call that built-in, with which version and function, and since when.
  - `compare_release_calls` for the app's release that brought it shows the call against the release before, and the package upgrades that came with it.
  - `find_package` with the package name shows which apps and processes run which versions of it.
  - `list_vulnerabilities` with `where: '"<package>" in packages'` shows whether the version is a known malicious or vulnerable release (`MAL-…` reports are malicious packages).
- **New package** (running at all for the first time): which dependency brought it in (`get_sbom` with the `app` and `package` gives the chain) and whether that was expected.
- **Regression**: a package taking more of the CPU in a release; `compare_releases` shows the rest of that release. Hand it to `ns-analyze-release`.
- **Drift**: dependency versions that changed with no new release (a rebuilt image of the same version, or a change on disk under a running process). Ask whether the build pins its lockfile; an unexpected change under a running process deserves an incident.

### 3. Recommend
- Suspicious and unexplained: treat it as a possible compromise. Pin or roll back the package to the last version that didn't do it, check the lockfile, and look at the package's recent releases and maintainers. Say how urgent it is from its severity and what it does.
- Explained and expected: say why, and offer to accept it.
- **Accepting:** `accept_behavior` with the `behaviorId` takes it into the app's baseline: the watch won't raise it again for that app, and alerts on it resolve. Only with the user's explicit approval, one behavior at a time.

### 4. Alerting
- To be told about new ones, `ns-manage-alerts` sets a behavior rule, e.g. `kind == "capability" && severity >= "high"`.

### 5. Present the Report
- `# Behavior Analysis — <app-or-fleet>`
- `## Summary`, `## Findings` (each behavior: package and versions, what it does, since when, how sure), `## Assessment` (suspicious or expected, and why), `## Recommendation`.

### 6. Write the Report to Disk
- Ask the user if they want to save the report to disk.
- If the user confirms, write it as markdown under `.nsolid/reports/`, for example `.nsolid/reports/behaviors-<app>.md`.

## Guardrails
- Sampling only sees code that was on the CPU: a behavior seen in few profiles is weaker evidence. Say how many profiles showed it.
- Never accept a behavior without the user's explicit approval.
- Do not call a package compromised without evidence; say what is unexplained and what would settle it.
