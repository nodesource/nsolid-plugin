---
name: ns-analyze-release
description: >-
  Explains what a release of a Node.js app changed in production, from N|Solid's CPU profiles and package inventories: CPU by package and function against the release before (with confidence), calls between packages that are new or gone, packages added, removed or upgraded, regressions and dependency drift. Use when the user asks whether a deploy made things slower, what changed in version X, why the app behaves differently since a release, or wants releases marked or sourcemaps uploaded from CI.
---

This skill works through the N|Solid MCP server (`nsolid`). The N|Solid tools take a `tenant`: when the token can use one tenant it is the default; otherwise call `list_tenants` once and use the tenant the user names (production and staging are usually separate tenants).

A release is a version of the app as its processes report it (`package.json`'s `version`). N|Solid records a release when its processes first report it, and CI can mark a deploy with its commit and a link.

### 1. Find the Releases
- `list_releases` with the `app`: its versions, newest first, when each was first seen or deployed, its commit and link, and how many connected processes run it.
- Use the versions the user names. Otherwise compare the newest with the one before (the tools' default).
- With only one release there is nothing to compare against (the comparison tools answer that no release before it was found): say so, and offer step 6 so the next deploys are marked.

### 2. What the Release Changed in CPU
- `compare_releases` with the `app` (and `version`, `base` when the user named them): the packages whose share of the busy CPU grew or shrank, the largest first, each with its confidence and its package versions on both sides.
- `by: "function"` names the functions; `measure: "time"` shows a function that got costlier even when something else grew more.
- Read `enough` and `reason`: without enough profiles of both releases there is no verdict. Say so, and that profiles accumulate with continuous profiling or as profiles are taken.
- A Node.js upgrade between the releases moves `(node)` and `(v8)` on its own: say when the releases ran different Node.js versions.
- The web UI's app page shows the same comparison, with a differential flame graph of where the time moved.

### 3. What It Changed in Behavior
- `compare_release_calls` with the same releases: calls between packages (and into Node.js built-ins) that are new, gone, or grew or shrank, and the packages added, removed and upgraded.
- A dependency that newly calls into a built-in that runs programs, compiles code, starts threads or uses the network comes first, flagged: that is how a compromised package shows at run time. Treat it seriously and hand it to `ns-analyze-behaviors`.
- `package_calls` with the `app` and `callee` (e.g. `node:child_process`) shows which packages make such calls at all.

### 4. What the Watch Already Found
- `list_behaviors` with the `app`: `kind: "regression"` lists packages the watch judged slower in a release (with both shares and the confidence); `kind: "drift"` lists dependency versions that changed with no new release (a rebuilt image of the same version, or a change on disk under a running process).

### 5. Read the Code Behind a Regression
- For a regressed function in the app's own code (`(app)`), read it in the workspace. When the workspace is the app at the regressed release, `git log` and `git diff` between the releases' commits (from `list_releases`) show what changed in that function. Never present dependency source as the code to fix; for a dependency, name the version change instead.

### 6. Mark Releases and Upload Sourcemaps from CI
When the user wants deploys recorded, or profiles of a bundled or minified app to name the original functions:
- **Token:** an API token holding only `nsolid:releases` and `nsolid:sourcemap-upload`, made by someone who administers the tenant (the web UI, or the API's `POST /tokens` with `permissions`). It can mark deploys and upload maps, and read nothing.
- **Marking a deploy** (one request, as the deploy runs):
  ```sh
  curl --fail-with-body -X POST \
    -H "authorization: Bearer $NSOLID_TOKEN" -H 'content-type: application/json' \
    -d "{\"version\":\"$VERSION\",\"commit\":\"$GIT_SHA\",\"url\":\"$BUILD_URL\"}" \
    "$NSOLID_API_URL/v1/tenants/<tenant>/apps/<app>/releases"
  ```
  `mark_release` does the same from here, when the user wants one marked by hand.
- **Uploading sourcemaps** (after the build): the build must write external maps (esbuild `--sourcemap=external`, webpack `devtool: 'source-map'`, Vite or Rollup `sourcemap: true`, tsc `--sourceMap`).
  ```sh
  find dist -name '*.map' | tar -czf sourcemaps.tar.gz -T -
  curl --fail-with-body \
    -H "authorization: Bearer $NSOLID_TOKEN" -H 'content-type: application/gzip' \
    --data-binary @sourcemaps.tar.gz \
    "$NSOLID_API_URL/v1/tenants/<tenant>/sourcemaps?app=<app>&version=$VERSION"
  ```
- `app` and `version` must be what the processes report: the app name (`NSOLID_APPNAME`, else `package.json`'s `name`) and `package.json`'s `version`.
- Add the steps to the workspace's CI configuration (GitHub Actions, GitLab CI, or the user's script) with the token as a secret and the API URL as a variable. Show the change and make it only with the user's approval.
- Afterwards, `list_sourcemaps` with the `app` shows the uploaded sets, and `list_releases` the marked deploys.

### 7. Present the Report
- `# Release Analysis — <app> <base> → <version>`
- `## Summary`: whether the release changed CPU or behavior, and how sure that is.
- `## CPU`: the largest changes with their confidence.
- `## Behavior`: new or gone calls, and package changes; flagged calls first.
- `## Findings from the watch`: regressions and drift.
- `## Recommendation`: what to look at or roll back, and how to confirm it (a new release's comparison, or `ns-validate-optimization` for a function).
- Ground every number in the tools' output; say plainly when there were not enough profiles.

### 8. Write the Report to Disk
- Ask the user if they want to save the report to disk.
- If the user confirms, write it as markdown under `.nsolid/reports/`, for example `.nsolid/reports/release-<app>-<version>.md`.

## Guardrails
- Do not claim a regression the comparison didn't find with confidence; report low-confidence changes as such.
- Never put a token in a file: CI reads it from a secret.
- Do not mark releases or edit CI configuration unasked.
