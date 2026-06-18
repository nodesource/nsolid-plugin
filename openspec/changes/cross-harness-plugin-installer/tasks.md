# Tasks

## Phase 1: Project Setup and Core Infrastructure

### Task 1: Initialize monorepo structure ✓
- [x] **Description**: Set up npm workspace monorepo with packages directory structure. Create root package.json with workspace configuration, tsconfig.json for TypeScript, and basic project files (README, .gitignore, .npmrc).
- **Depends on**: None
- **Files**:
  - `package.json` (root workspace config)
  - `tsconfig.json` (base TypeScript config)
  - `.gitignore`
  - `.npmrc`
  - `README.md`
- **Testing**: Run `npm install` to verify workspace setup. Check that `packages/` directory structure is recognized.

### Task 2: Create core package scaffold ✓
- [x] **Description**: Initialize `packages/core` with package.json, tsconfig.json, and directory structure for auth, skills, mcp, and harnesses modules. Set up build script to compile TypeScript to dist/.
- **Depends on**: Task 1
- **Files**:
  - `packages/core/package.json`
  - `packages/core/tsconfig.json`
  - `packages/core/src/index.ts` (empty export)
  - `packages/core/src/auth/` (directory)
  - `packages/core/src/skills/` (directory)
  - `packages/core/src/mcp/` (directory)
  - `packages/core/src/harnesses/` (directory)
  - `packages/core/src/utils/` (directory)
- **Testing**: Run `npm run build` in packages/core. Verify dist/ is created with compiled JavaScript.

### Task 3: Define bundle descriptor schema and types ✓
- [x] **Description**: Create TypeScript interfaces for BundleDescriptor, SkillRef, McpServerRef, and Credentials. Create JSON Schema for bundle.json validation. Create bundle.json with all 15 skills and 3 MCP servers.
- **Depends on**: Task 2
- **Files**:
  - `packages/core/src/types.ts` (interfaces)
  - `packages/core/src/schemas/bundle.schema.json` (JSON Schema)
  - `packages/core/src/validate.ts` (validation logic)
  - `bundle.json` (canonical bundle descriptor, at workspace root — see design.md architecture diagram)
- **Testing**: Write unit test to validate bundle.json against schema. Test validation with invalid bundle (missing required fields).
- **Spec reference**: Bundle Descriptor in design.md

### Task 4: Implement utility functions ✓
- [x] **Description**: Create shared utilities for file operations (atomic write, ensure directory), path resolution (expand ~, resolve relative paths), and JSON/TOML parsing/writing. Path resolution must use `os.homedir()` + `path.join()` for `~` expansion — never string concatenation with `/`. All stored paths must be normalized with `path.resolve()`. Atomic write must handle Windows: write temp file to same volume, `fs.unlink()` target if it exists (Windows `fs.rename()` fails with `EPERM` when destination exists), then `fs.rename()`. Follow the existing "Platform Path Resolution" section in design.md for the platform path mapping table and path normalization requirements — implementers should use that section's Windows-equivalent paths and rules directly.
- **Depends on**: Task 2
- **Files**:
  - `packages/core/src/utils/fs.ts` (file operations including cross-platform atomic write)
  - `packages/core/src/utils/path.ts` (path resolution using `os.homedir()` + `path.join()`)
  - `packages/core/src/utils/config.ts` (JSON/TOML parsing)
- **Testing**: Unit tests for each utility function. Test edge cases (missing files, permission errors, invalid JSON). Test path resolution on both Unix-style and Windows-style paths. Test atomic write behavior when target file exists.

## Phase 2: Authentication Module

### Task 5: Implement token storage module ✓
- [x] **Description**: Create token-storage.ts to read/write credentials to `~/.agents/.nodesource-auth.json`. Implement secure file permissions (0600). Note: on Windows, `chmod 0600` has minimal effect (only toggles read-only flag); credential protection relies on directory ACLs. Handle missing file, invalid JSON, and expired tokens.
- **Depends on**: Task 4
- **Files**:
  - `packages/core/src/auth/token-storage.ts`
- **Testing**: Unit tests for save/load credentials. Test file permissions (verify `0600` on Unix, document Windows behavior). Test handling of corrupted file.
- **Spec reference**: Credentials Storage in design.md

### Task 6: Implement token validator module ✓
- [x] **Description**: Create token-validator.ts to validate service tokens with Accounts API at `/accounts/org/access-token`. Handle network errors, 401/403 responses, and timeouts. Return validation result with permissions list.
- **Depends on**: Task 5
- **Files**:
  - `packages/core/src/auth/token-validator.ts`
- **Testing**: Unit tests with mocked HTTP responses. Test success, 401, 500, and timeout scenarios.
- **Spec reference**: Token validation failure scenario in specs/installation-and-auth.md

### Task 7: Implement OAuth callback server ✓
- [x] **Description**: Create oauth-server.ts to start local HTTP server on port 8765 (with fallback to 8766-8770). Listen for OAuth callback with token, consoleId (sent as consoleId by accounts service, not orgId), NSOLID_SAAS, url, and success flag. Implement 5-minute timeout. Validate state for CSRF protection. Return received credentials.
- **Depends on**: Task 4
- **Files**:
  - `packages/core/src/auth/oauth-server.ts`
- **Testing**: Unit tests for server startup, callback handling, timeout, and port conflicts. Use mock HTTP client to simulate callback.
- **Spec reference**: OAuth timeout and port conflict scenarios in specs/installation-and-auth.md

### Task 8: Implement auth manager orchestrator ✓
- [x] **Description**: Create auth-manager.ts with `ensureAuthenticated()` function. Check for existing valid credentials first. If missing/expired, initiate OAuth flow (open browser, start callback server). Parse callback parameters: token, consoleId, NSOLID_SAAS, url. Derive MCP URL from consoleId. Validate token with Accounts API. Store credentials including saasToken, consoleUrl, and mcpUrl. Return Credentials object.
- **Note**: Credentials now include `saasToken`, `consoleUrl`, and `mcpUrl` in addition to `serviceToken`, `organizationId`, and `expiresAt` per real accounts service behavior observed in nsentinel-vscode-extension.
- **Depends on**: Tasks 5, 6, 7
- **Files**:
  - `packages/core/src/auth/auth-manager.ts`
  - `packages/core/src/auth/index.ts` (export public API)
- **Testing**: Integration test with mocked dependencies. Test happy path (new auth), existing valid creds, expired creds, OAuth timeout.
- **Spec reference**: Successful OAuth authentication scenario in specs/installation-and-auth.md

## Phase 3: Skills Module

### Task 9: Implement skill copier module ✓
- [x] **Description**: Create skill-copier.ts to copy skills from source directory to `~/.agents/skills/`. Read skill list from bundle descriptor. Copy SKILL.md and any supporting files. Track installed skills with paths.
- **Depends on**: Task 4
- **Files**:
  - `packages/core/src/skills/skill-copier.ts`
- **Testing**: Unit tests with mock file system. Test copying multiple skills, handling missing source files, permission errors.
- **Spec reference**: Installation failure during skill copy scenario in specs/installation-and-auth.md

### Task 10: Implement skill linker module ✓
- [x] **Description**: Create skill-linker.ts to create harness-specific skill links with idempotent handling. Platform-aware linking strategy:
  - **Unix (macOS/Linux)**: Use `fs.symlink()` for all harnesses (Claude/Codex/OpenCode), copy for Pi
  - **Windows**: Use `fs.symlink(target, path, 'junction')` for directory links (junctions work without Developer Mode or admin privileges). Fall back to file copy if junction creation fails. Always copy for Pi.

  Idempotent strategy per target path:
  - **Symlink/junction pointing to correct source**: skip (no-op), return status `skipped`
  - **Symlink/junction that is broken or points elsewhere**: remove and recreate, return status `replaced`
  - **Regular file or directory**: rename with `.bak.<timestamp>` suffix, then create symlink/junction/copy, return status `backed-up`
  - **Target does not exist**: create symlink/junction/copy, return status `created`
- **Depends on**: Task 9
- **Files**:
  - `packages/core/src/skills/skill-linker.ts`
- **Testing**: Unit tests for each idempotent case (skip/replace/backup/create), different harness types, broken symlinks. Add Windows-specific test cases: junction creation, junction fallback to copy, junction detection in idempotent checks.
- **Spec reference**: Per-harness configuration mapping and Idempotent installation scenario in specs/installation-and-auth.md

### Task 11: Implement skill tracker module ✓
- [x] **Description**: Create skill-tracker.ts to record installed skills in tracking file. Store skill name, path, installation timestamp, and **harness association** (array of harness IDs that installed this skill). All paths must be normalized with `path.resolve()` before storing — never hardcode `/` in path strings. Support add/remove harness entries per skill for multi-harness installs. Support reading tracking file for uninstall with harness-aware semantics (targeted uninstall removes only the specified harness's entries, full uninstall removes all). Handle missing/corrupted tracking file gracefully.
- **Depends on**: Task 9
- **Files**:
  - `packages/core/src/skills/skill-tracker.ts`
  - `packages/core/src/skills/index.ts` (export public API including harness-aware methods)
- **Testing**: Unit tests for tracking file read/write, multi-harness install/uninstall, targeted uninstall by harness, missing/corrupted tracking file handling. Test that stored paths use platform-native separators and are normalized.
- **Spec reference**: Tracking File in design.md

## Phase 4: MCP Configuration Module

### Task 12: Implement MCP config merger ✓
- [x] **Description**: Create mcp-config-merger.ts to merge NodeSource MCP servers into existing harness config without overwriting user's existing servers. Deep merge mcpServers object. Preserve all non-NodeSource entries.
- **Depends on**: Task 4
- **Files**:
  - `packages/core/src/mcp/mcp-config-merger.ts`
- **Testing**: Unit tests for merge logic. Test with empty config, existing NodeSource entries (update), existing user entries (preserve), mixed scenario.
- **Spec reference**: Installation with existing user configurations scenario in specs/installation-and-auth.md

### Task 13: Implement MCP config writer ✓
- [x] **Description**: Create mcp-config-writer.ts to write MCP configurations to harness-specific paths. Use harness adapter to get config path and format (JSON/TOML). Read existing config, merge, write back atomically.
- **Depends on**: Tasks 12, 4
- **Files**:
  - `packages/core/src/mcp/mcp-config-writer.ts`
- **Testing**: Unit tests with mocked file system. Test JSON (Claude/OpenCode) and TOML (Codex) formats. Test handling of invalid existing config.
- **Spec reference**: Per-harness configuration mapping in specs/installation-and-auth.md

### Task 14: Implement MCP tracker module ✓
- [x] **Description**: Create mcp-tracker.ts to record configured MCP servers in tracking file. Store server name, config path, configuration timestamp, and **harness** (string identifying which harness the MCP was configured for). All read/write functions (`addTrackedMcp`, `removeTrackedMcp`, `readMcpTrackingFile`, `listTrackedMcps`) persist and return harness alongside other fields. Handle missing/corrupted harness values (default to `"unknown"` or error). Support lookup by harness for targeted uninstalls. Handle missing/corrupted tracking file gracefully.
- **Depends on**: Task 13
- **Files**:
  - `packages/core/src/mcp/mcp-tracker.ts`
  - `packages/core/src/mcp/index.ts` (export public API including harness-aware methods)
- **Testing**: Unit tests for write/read with harness, lookup by harness, targeted uninstall by harness, missing/corrupted tracking file handling.

## Phase 5: Harness Adapters

### Task 15: Implement base harness adapter interface ✓
- [x] **Description**: Create harness-adapter.ts with abstract base class or interface. Define methods: getMcpConfigPath(), getSkillsPath(), readMcpConfig(), writeMcpConfig(), supportsMcp(). Create adapter factory function.
- **Depends on**: Task 4
- **Files**:
  - `packages/core/src/harnesses/harness-adapter.ts`
  - `packages/core/src/harnesses/index.ts` (export factory and types)
- **Testing**: Type checking to ensure all adapters implement interface.

### Task 16: Implement Claude Code adapter ✓
- [x] **Description**: Create claude-adapter.ts for Claude Code harness. Config path: `~/.claude.json` (user-scoped MCP config — note: this is outside the `~/.claude/` directory). Skills path: `~/.claude/skills/`. JSON format. Supports MCP: true.
- **Depends on**: Task 15
- **Files**:
  - `packages/core/src/harnesses/claude-adapter.ts`
- **Testing**: Unit tests for path resolution, config read/write with JSON format.
- **Spec reference**: Claude Code configuration scenario in specs/installation-and-auth.md

### Task 17: Implement Codex CLI adapter ✓
- [x] **Description**: Create codex-adapter.ts for Codex CLI harness. Config path: `~/.codex/config.toml`. Skills path: `~/.codex/skills/`. TOML format. Supports MCP: true.
- **Depends on**: Task 15
- **Files**:
  - `packages/core/src/harnesses/codex-adapter.ts`
- **Testing**: Unit tests for path resolution, config read/write with TOML format.
- **Spec reference**: Codex CLI configuration scenario in specs/installation-and-auth.md

### Task 18: Implement OpenCode adapter ✓
- [x] **Description**: Create opencode-adapter.ts for OpenCode harness. Config path: `~/.config/opencode/opencode.jsonc`. Skills path: `~/.config/opencode/skills/`. JSONC format (JSON with comments). Supports MCP: true.
- **Depends on**: Task 15
- **Files**:
  - `packages/core/src/harnesses/opencode-adapter.ts`
- **Testing**: Unit tests for path resolution, config read/write with JSONC format (preserve comments).

### Task 19: Implement Pi Agent adapter ✓
- [x] **Description**: Create pi-adapter.ts for Pi Agent harness. No MCP config path (returns null). Skills path: `~/.pi/agent/skills/`. Note: Pi also reads from `~/.agents/skills/` natively. Supports MCP: false. Skip MCP configuration in install flow.
- **Depends on**: Task 15
- **Files**:
  - `packages/core/src/harnesses/pi-adapter.ts`
- **Testing**: Unit tests for path resolution, verify supportsMcp() returns false.
- **Spec reference**: Pi Agent configuration scenario in specs/installation-and-auth.md

### Task 19b: Implement Antigravity adapter ✓
- [x] **Description**: Create antigravity-adapter.ts for Antigravity CLI fallback/direct install. Config path: `~/.gemini/antigravity-cli/mcp_config.json`. Skills path: `~/.gemini/antigravity-cli/skills/`. JSON format with Antigravity `serverUrl` write format. Supports MCP: true. Export from `packages/core/src/harnesses/index.ts`.
- **Depends on**: Task 15
- **Files**:
  - `packages/core/src/harnesses/antigravity-adapter.ts`
  - `packages/core/src/harnesses/index.ts` (add export)
- **Testing**: Unit tests for path resolution, config read/write with JSON format. Verify MCP config written to `~/.gemini/antigravity-cli/mcp_config.json`.

## Phase 6: Core Installer Orchestration

### Task 20: Implement main installer orchestrator ✓
- [x] **Description**: Create index.ts with `install()` function. Orchestrate flow: load bundle → ensure auth → install skills → configure MCP → write tracking file. Accept InstallOptions, return InstallResult. Handle errors and partial failures.
- **Depends on**: Tasks 8, 11, 14, 15
- **Files**:
  - `packages/core/src/index.ts` (main orchestrator)
- **Testing**: Integration test with mocked modules. Test happy path, auth failure, skill copy failure, MCP config failure.
- **Spec reference**: Installation Flow in specs/installation-and-auth.md

### Task 21: Implement uninstall function ✓
- [x] **Description**: Add `uninstall()` function to index.ts. Read tracking file → remove MCP configs → remove skills → delete tracking file. Preserve credentials. Handle missing tracking file gracefully.
- **Depends on**: Task 20
- **Files**:
  - `packages/core/src/index.ts` (add uninstall function)
- **Testing**: Integration test with mocked tracking file. Test clean uninstall, missing tracking file, partial artifacts.
- **Spec reference**: Uninstall Flow in specs/installation-and-auth.md

### Task 22: Implement doctor function ✓
- [x] **Description**: Add `doctor()` function to index.ts. Check: credentials exist and valid → skills exist in harness path → MCP configs present → MCP servers reachable. Return DoctorReport with status and actionable messages.
- **Depends on**: Task 20
- **Files**:
  - `packages/core/src/index.ts` (add doctor function)
- **Testing**: Integration test with various failure scenarios. Test all green, missing creds, missing skills, unreachable MCP.
- **Spec reference**: Doctor/Health Check in specs/installation-and-auth.md

## Phase 7: Native Distribution Surfaces

> **Correction (delta vs original Phase 7 design):** The original tasks assumed each plugin is an npm package whose `postinstall.js`/`preuninstall.js` scripts invoke the core installer. That assumption is incorrect. The final refactor keeps Pi as the only real plugin package, generates Claude/Codex/Antigravity native artifacts under `dist/`, and keeps OpenCode as fallback CLI-only for now. npm `postinstall` is not used as a universal trigger, and no install path may launch auth/browser.

### Task 22b: Publish bundle.json from core and add MCP_ROOT resolution ✓
- [x] **Description**: `bundle.json` is now copied into `packages/core/` and listed in `packages/core/package.json` `"files"`. `getMcpRootDir()` was added to `packages/core/src/utils/path.ts` and `install()` passes `MCP_ROOT` so `${MCP_ROOT}` in `bundle.json` is expanded. A sync check script keeps the copy in sync.
- **Depends on**: Task 22
- **Files**:
  - `packages/core/bundle.json`
  - `packages/core/src/utils/path.ts`
  - `packages/core/src/index.ts`
  - `packages/core/scripts/check-bundle-sync.mjs`
  - `packages/core/package.json`
- **Testing**: Run `pnpm --filter @nodesource/plugin-core bundle:check`. In a throwaway HOME, run `NSOLID_HARNESS=claude node packages/core/scripts/setup.mjs` and confirm MCP config has resolved absolute paths.
- **Spec reference**: Variable Expansion in design.md

### Task 22c: Create shared setup script ✓
- [x] **Description**: `packages/core/scripts/setup.mjs` exists. It resolves `bundle.json` and `skillsSource` from the core package directory, reads `NSOLID_HARNESS` from the environment, and calls explicit setup or uninstall behavior. It is no longer treated as an implicit native-install auth hook.
- **Depends on**: Task 22b
- **Files**:
  - `packages/core/scripts/setup.mjs`
- **Testing**: Run setup against a throwaway HOME with mocked auth. Verify credentials/config are prepared only when setup is explicitly invoked. Run twice to confirm idempotency.

### Task 23: Create Claude Code generated artifact path ✓
- [x] **Description**: Claude is generated from `plugins/templates/claude/` into `dist/plugins/claude/nsolid-plugin/`. The generated plugin root contains `.claude-plugin/plugin.json`, plugin-local MCP wrapper/config, and materialized `skills/`. The old `packages/claude-plugin/` prototype was deleted in the Phase 9b refactor.
- **Depends on**: Task 22c; Task 36b
- **Files**:
  - `plugins/templates/claude/`
  - `scripts/plugin-generators.mjs`
  - `scripts/build-plugin-artifacts.mjs`
  - `dist/plugins/claude/nsolid-plugin/` (generated, ignored)
- **Testing**: Generated artifact tests validate manifest/config shape, all skills, and no install-time auth/browser behavior.
- **Spec reference**: Per-harness configuration mapping (Claude Code) in specs/installation-and-auth.md

### Task 24: Create Codex CLI generated artifact path ✓
- [x] **Description**: Codex is generated from `plugins/templates/codex/` into `dist/plugins/codex/nsolid-plugin/`. The generated plugin root contains `.codex-plugin/plugin.json` with `skills: "./skills/"`, local marketplace metadata, plugin-local MCP wrapper/config, non-interactive hook/setup guidance, and materialized `skills/`. The old `packages/codex-plugin/` prototype was deleted in the Phase 9b refactor.
- **Depends on**: Task 22c; Task 36b
- **Files**:
  - `plugins/templates/codex/`
  - `scripts/plugin-generators.mjs`
  - `scripts/build-plugin-artifacts.mjs`
  - `dist/plugins/codex/nsolid-plugin/` (generated, ignored)
- **Testing**: Generated artifact tests validate manifest/config shape, all skills, local marketplace metadata, and no install-time auth/browser behavior.
- **Spec reference**: Per-harness configuration mapping (Codex CLI) in specs/installation-and-auth.md

### Task 25: Keep OpenCode as fallback/direct install only ✓
- [x] **Description**: Do not create a real OpenCode workspace package yet. OpenCode remains supported through `nsolid-plugin install --harness opencode`, which directly installs user-level skills and MCP config. This avoids inventing a generated artifact before OpenCode's plugin distribution model is confirmed.
- **Depends on**: Task 22c
- **Files**:
  - `packages/core/src/harnesses/opencode-adapter.ts`
  - `packages/core/src/index.ts`
  - `scripts/test-marketplace-install.js`
- **Testing**: Fallback install/uninstall tests verify OpenCode skills and MCP config are written and cleaned without auth/browser launch.
- **Spec reference**: Per-harness configuration mapping (OpenCode) in specs/installation-and-auth.md

### Task 26: Create Antigravity generated artifact path ✓
- [x] **Description**: Antigravity is generated from `plugins/templates/antigravity/` into `dist/plugins/antigravity/nsolid-plugin/`. The generated plugin root contains `plugin.json`, `mcp_config.json`, `scripts/install.js`, `scripts/mcp-wrapper.js`, and materialized `skills/`. Native install stages artifact-local assets and prints explicit setup guidance; it does not call auth or copy skills from `@nodesource/plugin-core` at install time. The old `packages/antigravity-plugin/` prototype was deleted in the Phase 9b refactor.
- **Depends on**: Task 38 (done — see `docs/antigravity-research.md`); Task 22c; Task 36b
- **Files**:
  - `plugins/templates/antigravity/`
  - `plugins/templates/antigravity/scripts/install.js`
  - `scripts/plugin-generators.mjs`
  - `scripts/build-plugin-artifacts.mjs`
  - `dist/plugins/antigravity/nsolid-plugin/` (generated, ignored)
- **Testing**: Generated artifact tests validate Antigravity manifest/config/install script shape, all skills, and no install-time auth/browser behavior.
- **Spec reference**: Per-harness configuration mapping (Antigravity) in specs/installation-and-auth.md

### Task 27: Create Pi Agent plugin package ✓
- [x] **Description**: Keep `packages/pi-plugin` as the only real per-harness package. Pi package activation must not launch auth. Pi package artifacts receive materialized `skills/` during `prepack`, and source-mode cleanup removes `packages/pi-plugin/skills/` afterward. Users run `nsolid-plugin setup --harness pi` explicitly for auth/MCP config.
- **Depends on**: Task 22c; Task 36d
- **Files**:
  - `packages/pi-plugin/package.json`
  - `packages/pi-plugin/index.js`
  - `packages/pi-plugin/README.md`
  - `packages/pi-plugin/test/manifest.test.ts`
- **Generated/cleaned files**:
  - `packages/pi-plugin/skills/` (generated during materialization/pack, ignored in source mode)
- **Testing**: Pi package manifest tests pass; `pnpm plugin:materialize` creates Pi skills; `pnpm plugin:clean` removes them; setup tests verify auth is explicit.
- **Spec reference**: Per-harness configuration mapping (Pi Agent) in specs/installation-and-auth.md

## Phase 8: Testing and Verification ✓

### Task 28: Write integration tests for core installer ✓
- [x] **Description**: Create comprehensive integration tests in `packages/core/test/integration.test.ts`. Test full install/uninstall cycle with real file system (use temp directory). Test all harness types. Test error scenarios.
- **Depends on**: Task 22
- **Files**:
  - `packages/core/test/integration.test.ts`
- **Testing**: Run `npm test` in packages/core. All tests pass.

### Task 29: Create manual test script ✓
- [x] **Description**: Create `scripts/test-marketplace-install.js` (Node.js for cross-platform compatibility) to manually test marketplace installation. Script installs each plugin package in isolated temp directory, verifies skills and MCP configs, then uninstalls. Alternatively, provide both `scripts/test-marketplace-install.sh` (bash) and `scripts/test-marketplace-install.ps1` (PowerShell) versions.
- **Depends on**: Tasks 23-27
- **Files**:
  - `scripts/test-marketplace-install.js` (preferred: cross-platform Node.js script)
  - OR `scripts/test-marketplace-install.sh` + `scripts/test-marketplace-install.ps1`
- **Testing**: Run script manually on macOS, Linux, and Windows. Verify all 5 plugins install/uninstall cleanly.

### Task 30: Implement doctor CLI command ✓
- [x] **Description**: Create `packages/core/src/cli.ts` with CLI interface using commander or similar. Add `doctor` command that calls doctor() function and displays results with colored output (green/yellow/red).
- **Depends on**: Task 22
- **Files**:
  - `packages/core/src/cli.ts`
  - `packages/core/package.json` (add bin entry)
- **Testing**: Run `npx @nodesource/plugin-core doctor --harness claude`. Verify output format and colors.

### Task 31: Write README documentation ✓
- [x] **Description**: Create comprehensive README.md with installation instructions for each marketplace, authentication flow explanation, troubleshooting guide, and development setup.
- **Depends on**: Tasks 23-27
- **Files**:
  - `README.md` (update root README)
  - `packages/core/README.md`
- **Testing**: Review for clarity and completeness. Test all commands mentioned in README.

### Task 32: Set up CI/CD pipeline ✓
- [x] **Description**: Create GitHub Actions workflow for automated testing. Run unit tests, integration tests, and lint on PR. Build and publish packages on release tag.
- **Depends on**: Task 28
- **Files**:
  - `.github/workflows/test.yml`
  - `.github/workflows/publish.yml`
- **Testing**: Push to branch, verify CI runs. Create test release, verify publish workflow.

## Phase 9: Polish and Edge Cases ✓

### Task 33: Implement idempotent installation ✓
- [x] **Description**: Review and enhance install() to ensure idempotency. Re-running install should not create duplicate entries, should update existing configs, should handle already-installed state gracefully. Implemented in `19a6a0e`: skill-copy rollback on partial failure (`skill-copier.ts`), harness-aware tracking de-dup (`skill-tracker.ts`, `mcp-tracker.ts`), and idempotency coverage in `test/integration/idempotency.test.ts`.
- **Depends on**: Task 28
- **Files**:
  - `packages/core/src/index.ts` (review and enhance)
- **Testing**: Run install twice in integration test. Verify no duplicates, no errors.
- **Spec reference**: Idempotent installation scenario in specs/installation-and-auth.md

### Task 34: Add comprehensive error messages ✓
- [x] **Description**: Review all error paths in core installer. Add actionable, platform-aware error messages with specific guidance. Detect OS via `process.platform` and suggest appropriate remediation: Implemented in `19a6a0e`: shared `PluginError` with stable codes (`packages/core/src/errors.ts`), `permissionGuidance()`, `toPluginError()`, `formatPluginError()`, platform-aware permission hints, and CLI top-level error rendering. Covered by `test/unit/errors.test.ts`.
  - Unix: `"Permission denied writing to ~/.claude.json. Try: sudo chown -R $USER ~/.claude.json"`
  - Windows: `"Permission denied writing to C:\Users\<user>\.claude.json. Try running as Administrator, or: icacls C:\Users\<user>\.claude.json /grant %USERNAME%:F"`
  Use error codes for programmatic handling.
- **Depends on**: Task 28
- **Files**:
  - `packages/core/src/errors.ts` (error classes with platform-aware messages)
  - Update all modules to use structured errors
- **Testing**: Trigger each error scenario, verify message clarity and actionability on all platforms.

### Task 35: Implement config backup and restore ✓
- [x] **Description**: Before modifying harness configs, create backup at `~/.agents/.config-backup/<harness>/<timestamp>-<uuid>.<ext>` where `<ext>` matches the original config file's extension (`.json`, `.toml`, `.jsonc`, etc.). Add restore command to CLI for manual recovery. Document backup location in README. Implemented in `19a6a0e`: `utils/backup.ts` (create/list/restore), `getConfigBackupDir()` in `utils/path.ts`, backups wired into `mcp-config-writer.ts` before mutation, `nsolid-plugin restore` CLI command (latest/specific/`--list`), README docs, and `test/integration/backup-restore.test.ts` + `test/unit/utils/backup.test.ts`.
- **Depends on**: Task 20
- **Files**:
  - `packages/core/src/utils/backup.ts`
  - `packages/core/src/cli.ts` (add restore command)
- **Testing**: Install plugin, verify backup created. Manually corrupt config, run restore, verify recovery.

### Task 36: Add verbose logging mode ✓
- [x] **Description**: Add `--verbose` flag to CLI and environment variable support (NSOLID_PLUGIN_VERBOSE). Log all file operations, API calls, and decisions. Use structured logging with timestamps. Implemented in `19a6a0e`: `utils/logger.ts` (`createLogger`, `isVerboseEnabled`, `--verbose` flag + `NSOLID_PLUGIN_VERBOSE` env), logger threaded through install/uninstall/doctor/auth/mcp/skills, token/header redaction, and `test/unit/utils/logger.test.ts`.
- **Depends on**: Task 30
- **Files**:
  - `packages/core/src/utils/logger.ts`
  - Update all modules to use logger
- **Testing**: Run install with --verbose, verify detailed output. Run without flag, verify clean output.

## Phase 9b: Generated Plugin Artifact Refactor ✓

This phase supersedes the earlier source-package interpretation of Phase 7 for Claude, Codex, and Antigravity. Those harnesses now use generated native plugin artifacts; Pi remains a real package; OpenCode remains fallback/direct-install only.

### Task 36a: Split setup/auth from install paths ✓
- [x] **Description**: Make `nsolid-plugin setup` / `nsolid-plugin login` the only OAuth/browser entry points. Native plugin install, generated setup hooks, generated install scripts, Pi package activation, and fallback `install --harness` must not open a browser. Runtime unauthenticated failures should tell users to run `nsolid-plugin setup --harness <harness>`.
- **Depends on**: Task 36
- **Files**:
  - `packages/core/src/index.ts`
  - `packages/core/src/cli.ts`
  - `scripts/plugin-generators.mjs`
  - `plugins/templates/antigravity/scripts/install.js`
  - `packages/pi-plugin/index.js`
- **Testing**: Integration tests assert generated install/setup paths do not invoke auth/browser. CLI help documents setup vs fallback install.
- **Spec reference**: Installation Flow Specification; Authentication Flow Specification.

### Task 36b: Introduce generated artifact builder ✓
- [x] **Description**: Add an artifact build pipeline that renders Claude, Codex, and Antigravity plugin directories under `dist/plugins/` and archives under `dist/artifacts/`. Generated artifacts are self-contained and include manifests, MCP wrapper/config, any non-interactive hooks/install scripts, and materialized `skills/` copied from `packages/core/skills/`.
- **Depends on**: Task 36a
- **Files**:
  - `scripts/build-plugin-artifacts.mjs`
  - `scripts/plugin-generators.mjs`
  - `plugins/templates/claude/`
  - `plugins/templates/codex/`
  - `plugins/templates/antigravity/`
  - `package.json` (`plugin:artifacts`, `plugin:artifacts:check`)
- **Testing**: `pnpm plugin:artifacts` generates artifacts; `pnpm plugin:artifacts:check` validates generated output is current.
- **Spec reference**: Generated native artifacts are built; Per-Harness Configuration Mapping Specification.

### Task 36c: Remove generated-only harness packages from source ✓
- [x] **Description**: Delete Claude, Codex, and Antigravity source package directories from `packages/` and move reusable hand-authored pieces into `plugins/templates/`. Keep `packages/core` and `packages/pi-plugin` as the only real workspace packages.
- **Depends on**: Task 36b
- **Files removed**:
  - `packages/claude-plugin/`
  - `packages/codex-plugin/`
  - `packages/antigravity-plugin/`
- **Files kept**:
  - `packages/core/`
  - `packages/pi-plugin/`
  - `plugins/templates/`
- **Testing**: `pnpm install --lockfile-only`; `pnpm -r lint` scopes only real packages; no generated-only package remains under `packages/`.

### Task 36d: Enforce single canonical N|Solid skill source ✓
- [x] **Description**: Keep `packages/core/skills/` as the only committed N|Solid skill source. `scripts/sync-plugin-assets.mjs` now checks source hygiene and Pi materialization/cleanup only; generated artifact skill copies live under ignored `dist/`.
- **Depends on**: Task 36c
- **Files**:
  - `scripts/sync-plugin-assets.mjs`
  - `.gitignore`
  - `packages/core/skills/`
  - `packages/pi-plugin/package.json` (`prepack`/`postpack` behavior)
- **Testing**: `pnpm plugin:check` fails if package-local N|Solid skill directories appear in source mode.

### Task 36e: Convert source-package tests to generated-artifact tests ✓
- [x] **Description**: Replace tests that inspected deleted package directories with tests that build/inspect generated artifacts and validate non-interactive install/setup behavior.
- **Depends on**: Task 36d
- **Files**:
  - `packages/core/test/integration/plugin-assets.test.ts`
  - `packages/core/test/integration/cli-help.test.ts`
  - `scripts/test-marketplace-install.js`
- **Testing**: Generated artifact tests verify Claude/Codex/Antigravity artifacts are self-contained, include all skills, and do not contain install-time auth/browser behavior.

### Task 36f: Update docs and release workflow for generated artifacts ✓
- [x] **Description**: Document the corrected distribution model: generated artifacts for Claude/Codex/Antigravity, real package for Pi, fallback direct install for OpenCode and as an escape hatch for other harnesses, explicit setup/login for auth.
- **Depends on**: Task 36e
- **Files**:
  - `README.md`
  - `packages/core/README.md`
  - `docs/generated-plugin-artifact-refactor-plan.md`
  - `docs/skill-distribution-simplification-plan.md`
  - `docs/plugin-marketplace-research.md`
  - `openspec/changes/cross-harness-plugin-installer/design.md`
  - `openspec/changes/cross-harness-plugin-installer/proposal.md`
  - `openspec/changes/cross-harness-plugin-installer/specs/installation-and-auth.md`
  - `openspec/changes/cross-harness-plugin-installer/tasks.md`
- **Testing**: Release validation sequence:
  - `pnpm plugin:check`
  - `pnpm plugin:artifacts`
  - `pnpm plugin:artifacts:check`
  - `pnpm lint`
  - `pnpm test`
  - `pnpm build`
  - `pnpm test:marketplace`

## Phase 10: Documentation and Handoff

### Task 37: Create developer onboarding guide
- **Description**: Write CONTRIBUTING.md with development setup, architecture overview, how to add new skills/MCP servers, how to add new harness adapters, testing strategy, and release process.
- **Depends on**: Task 31
- **Files**:
  - `CONTRIBUTING.md`
- **Testing**: Have team member follow guide to set up dev environment and make small change.

### Task 38: Document Antigravity CLI requirements ✓
- [x] **Description**: Research doc written at `docs/antigravity-research.md`, with broader marketplace/artifact research in `docs/plugin-marketplace-research.md`. Current decision: generate an Antigravity-native plugin artifact containing `plugin.json`, `mcp_config.json`, `scripts/install.js`, `scripts/mcp-wrapper.js`, and `skills/`; native install stages artifact-local assets and does not launch auth. Fallback adapter paths use `~/.gemini/antigravity-cli/mcp_config.json` and `~/.gemini/antigravity-cli/skills/`.
- **Depends on**: None
- **Files**:
  - `docs/antigravity-research.md`
  - `docs/plugin-marketplace-research.md`
- **Testing**: Reviewed against official docs and real-world corroboration.

### Task 39: Create demo video script
- **Description**: Write script for 2-minute demo video showing installation from each marketplace, authentication flow, skill usage, and uninstall. Include talking points and screen recording steps.
- **Depends on**: Task 31
- **Files**:
  - `docs/demo-script.md`
- **Testing**: Dry run script, verify timing and clarity.

### Task 40: Final integration testing and bug fixes
- **Description**: Perform end-to-end testing of generated native artifacts, the Pi package, and fallback direct install paths on clean systems (macOS, Linux, and Windows). Document and fix any issues found. Verify all acceptance criteria from proposal.md are met. Pay special attention to platform-specific behavior: path separators, symlink/junction behavior, file permissions, and atomic writes on Windows.
- **Depends on**: Tasks 23-32 and Phase 9b
- **Files**:
  - Update any files with bug fixes
  - `docs/testing-report.md` (test results including per-platform notes)
- **Testing**: All acceptance criteria verified on all three platforms. No critical bugs remaining.
