---
name: ns-download-asset
description: >-
  Downloads a raw N|Solid diagnostic asset (heap snapshot, CPU profile, heap profile, or heap tracking file) from N|Solid to local disk by asset ID. Use when the user asks to download, save, export, or pull an asset file locally, or needs the raw file for external tools such as snapshot-parser, Chrome DevTools, or diffing. Do not use for analyzing assets — ns-analyze-asset covers that.
---

This skill downloads N|Solid assets with a bundled script, finding them through the N|Solid MCP server (`nsolid`). The script needs the server's settings: `NSOLID_API_URL` and `NSOLID_API_TOKEN` in the environment, or `~/.agents/.nsolid-auth.json` with `apiUrl` and `token` (plus `tenant` when the token can use several tenants).

## Instructions

### 1. Pick the Tenant

- The N|Solid tools take a `tenant`. When the token can use one tenant it is the default; otherwise call `list_tenants` once and use the tenant the user names. Set `NSOLID_TENANT` for the script.

### 2. Identify the Asset

- The asset ID comes from the user or from `list_assets` (filter with `agentId`, `kind`: `cpu_profile`, `heap_sampling`, `heap_snapshot` or `heap_profile`).
- If the user gives only an app name + asset type, find the app's processes with `find_agents` (`app`), call `list_assets`, and confirm which asset to download before proceeding.
- An asset whose status is `expired` has no file any more: say so. Files are kept for the tenant's retention (`expiresInDays` in `list_assets`; `asset_usage` shows the tier).

### 3. Resolve the App Name

- Resolve `appName` from the user or the asset's process (`find_agents` or `get_agent`). Without it, the script looks the app up itself.

### 4. Download

Run the bundled script (use the absolute path of the directory where you read this SKILL.md):

```sh
node "<skill-dir>/fetch-nsolid-asset.cjs" <assetId> <appName>
```

It names the file by the asset's kind: `.cpuprofile`, `.heapprofile` (heap sampling), `.heapsnapshot` or `.heaptimeline` (heap tracking, which Chrome DevTools' Memory panel opens). Downloading a heap snapshot or a heap tracking file needs a token allowed to take them; if the script is refused, report that.

### 5. Report

- Output the file path under `.nsolid/assets/`, the size printed by the script, and that the asset is registered in `.nsolid/assets/index.json`.
- Never open or read the raw file into context.
- If the user wants the file kept on N|Solid past its retention, `pin_asset` keeps it until unpinned, within the tenant's pinned budget. Offer it; don't pin unasked.

## Guardrails

- Never download assets via direct HTTP calls, `curl`, or ad hoc shell — only the bundled `fetch-nsolid-asset.cjs`.
- Never read raw asset contents into the AI context — the file is for external tools and the user.
- The script dedupes by asset ID (existing files are reused); do not re-download unnecessarily.
- Do not fabricate analysis from the downloaded file — analyzing assets is `ns-analyze-asset`'s job.
