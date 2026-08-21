---
name: ns-download-asset
description: >-
  Downloads a raw N|Solid diagnostic asset (heap snapshot, CPU profile, or heap profile) to local disk by asset ID. Use when the user asks to download, save, export, or pull an asset file locally, or needs the raw file for external tools such as snapshot-parser, Chrome DevTools, or diffing. Do not use for analyzing assets — ns-analyze-asset covers that.
---

## Instructions

### 1. Identify the Asset

- The asset ID comes from the user or from the `assets` MCP tool (filter with `type`, `app`, etc.).
- If the user gives only an app name + asset type, call `assets` and confirm which asset to download before proceeding.
- If the asset was just generated, make sure it is no longer listed in `assets-in-progress` before downloading.

### 2. Resolve the Asset Type

- Map the asset to the script's `assetType`: `cpuprofile` | `heapprofile` | `heapsnapshot`.
- Heap sampling assets use `heapprofile`.

### 3. Resolve the App Name

- Resolve `appName` from the `assets` metadata or the user.
- Fall back to `unknown` only when the app name is genuinely unknown.

### 4. Download

Run the bundled script (use the absolute path of the directory where you read this SKILL.md):

```sh
node "<skill-dir>/fetch-asset.cjs" <assetId> <assetType> <appName>
```

### 5. Report

- Output the file path under `.nsolid/assets/`, the size printed by the script, and that the asset is registered in `.nsolid/assets/index.json`.
- Never open or read the raw file into context.

## Guardrails

- Never download assets via direct HTTP calls, `curl`, or ad hoc shell — only the bundled `fetch-asset.cjs`.
- Never use the MCP `asset` tool even if it appears in the tool list (older console versions still expose it). It is deprecated: it inlines raw data into the response and kills the MCP session with "session expired" on large assets. Always `fetch-asset.cjs`.
- Never read raw asset contents into the AI context — the file is for external tools and the user.
- The script dedupes by asset ID (existing files are reused); do not re-download unnecessarily.
- Do not fabricate analysis from the downloaded file — analyzing assets is `ns-analyze-asset`'s job via `asset-summary`.
