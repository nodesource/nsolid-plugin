# Tasks

## Phase 1: Project Setup and Core Infrastructure

### Task 1: Initialize monorepo structure
- **Description**: Set up npm workspace monorepo with packages directory structure. Create root package.json with workspace configuration, tsconfig.json for TypeScript, and basic project files (README, .gitignore, .npmrc).
- **Depends on**: None
- **Files**: 
  - `package.json` (root workspace config)
  - `tsconfig.json` (base TypeScript config)
  - `.gitignore`
  - `.npmrc`
  - `README.md`
- **Testing**: Run `npm install` to verify workspace setup. Check that `packages/` directory structure is recognized.

### Task 2: Create core package scaffold
- **Description**: Initialize `packages/core` with package.json, tsconfig.json, and directory structure for auth, skills, mcp, and harnesses modules. Set up build script to compile TypeScript to dist/.
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

### Task 3: Define bundle descriptor schema and types
- **Description**: Create TypeScript interfaces for BundleDescriptor, SkillRef, McpServerRef, and Credentials. Create JSON Schema for bundle.json validation. Create bundle.json with all 14 skills and 3 MCP servers.
- **Depends on**: Task 2
- **Files**:
  - `packages/core/src/types.ts` (interfaces)
  - `packages/core/src/schemas/bundle.schema.json` (JSON Schema)
  - `packages/core/src/validate.ts` (validation logic)
  - `bundle.json` (canonical bundle descriptor)
- **Testing**: Write unit test to validate bundle.json against schema. Test validation with invalid bundle (missing required fields).
- **Spec reference**: Bundle Descriptor in design.md

### Task 4: Implement utility functions
- **Description**: Create shared utilities for file operations (atomic write, ensure directory), path resolution (expand ~, resolve relative paths), and JSON/TOML parsing/writing.
- **Depends on**: Task 2
- **Files**:
  - `packages/core/src/utils/fs.ts` (file operations)
  - `packages/core/src/utils/path.ts` (path resolution)
  - `packages/core/src/utils/config.ts` (JSON/TOML parsing)
- **Testing**: Unit tests for each utility function. Test edge cases (missing files, permission errors, invalid JSON).

## Phase 2: Authentication Module

### Task 5: Implement token storage module
- **Description**: Create token-storage.ts to read/write credentials to `~/.agents/.nodesource-auth.json`. Implement secure file permissions (0600). Handle missing file, invalid JSON, and expired tokens.
- **Depends on**: Task 4
- **Files**:
  - `packages/core/src/auth/token-storage.ts`
- **Testing**: Unit tests for save/load credentials. Test file permissions. Test handling of corrupted file.
- **Spec reference**: Credentials Storage in design.md

### Task 6: Implement token validator module
- **Description**: Create token-validator.ts to validate service tokens with Accounts API at `/accounts/org/access-token`. Handle network errors, 401/403 responses, and timeouts. Return validation result with permissions list.
- **Depends on**: Task 5
- **Files**:
  - `packages/core/src/auth/token-validator.ts`
- **Testing**: Unit tests with mocked HTTP responses. Test success, 401, 500, and timeout scenarios.
- **Spec reference**: Token validation failure scenario in specs/installation-and-auth.md

### Task 7: Implement OAuth callback server
- **Description**: Create oauth-server.ts to start local HTTP server on port 8765 (with fallback to 8766-8770). Listen for OAuth callback with token and orgId. Implement 5-minute timeout. Return received credentials.
- **Depends on**: Task 4
- **Files**:
  - `packages/core/src/auth/oauth-server.ts`
- **Testing**: Unit tests for server startup, callback handling, timeout, and port conflicts. Use mock HTTP client to simulate callback.
- **Spec reference**: OAuth timeout and port conflict scenarios in specs/installation-and-auth.md

### Task 8: Implement auth manager orchestrator
- **Description**: Create auth-manager.ts with `ensureAuthenticated()` function. Check for existing valid credentials first. If missing/expired, initiate OAuth flow (open browser, start callback server). Validate token with Accounts API. Store credentials. Return Credentials object.
- **Depends on**: Tasks 5, 6, 7
- **Files**:
  - `packages/core/src/auth/auth-manager.ts`
  - `packages/core/src/auth/index.ts` (export public API)
- **Testing**: Integration test with mocked dependencies. Test happy path (new auth), existing valid creds, expired creds, OAuth timeout.
- **Spec reference**: Successful OAuth authentication scenario in specs/installation-and-auth.md

## Phase 3: Skills Module

### Task 9: Implement skill copier module
- **Description**: Create skill-copier.ts to copy skills from source directory to `~/.agents/skills/`. Read skill list from bundle descriptor. Copy SKILL.md and any supporting files. Track installed skills with paths.
- **Depends on**: Task 4
- **Files**:
  - `packages/core/src/skills/skill-copier.ts`
- **Testing**: Unit tests with mock file system. Test copying multiple skills, handling missing source files, permission errors.
- **Spec reference**: Installation failure during skill copy scenario in specs/installation-and-auth.md

### Task 10: Implement skill linker module
- **Description**: Create skill-linker.ts to create harness-specific skill links. For Claude/Codex/OpenCode, create symlinks from harness skill path to `~/.agents/skills/`. For Pi, copy skills to `~/.pi/skills/`. Handle existing symlinks/files.
- **Depends on**: Task 9
- **Files**:
  - `packages/core/src/skills/skill-linker.ts`
- **Testing**: Unit tests for symlink creation, handling existing links, different harness types.
- **Spec reference**: Per-harness configuration mapping in specs/installation-and-auth.md

### Task 11: Implement skill tracker module
- **Description**: Create skill-tracker.ts to record installed skills in tracking file. Store skill name, path, and installation timestamp. Support reading tracking file for uninstall.
- **Depends on**: Task 9
- **Files**:
  - `packages/core/src/skills/skill-tracker.ts`
  - `packages/core/src/skills/index.ts` (export public API)
- **Testing**: Unit tests for tracking file read/write. Test handling of missing/corrupted tracking file.
- **Spec reference**: Tracking File in design.md

## Phase 4: MCP Configuration Module

### Task 12: Implement MCP config merger
- **Description**: Create mcp-config-merger.ts to merge NodeSource MCP servers into existing harness config without overwriting user's existing servers. Deep merge mcpServers object. Preserve all non-NodeSource entries.
- **Depends on**: Task 4
- **Files**:
  - `packages/core/src/mcp/mcp-config-merger.ts`
- **Testing**: Unit tests for merge logic. Test with empty config, existing NodeSource entries (update), existing user entries (preserve), mixed scenario.
- **Spec reference**: Installation with existing user configurations scenario in specs/installation-and-auth.md

### Task 13: Implement MCP config writer
- **Description**: Create mcp-config-writer.ts to write MCP configurations to harness-specific paths. Use harness adapter to get config path and format (JSON/TOML). Read existing config, merge, write back atomically.
- **Depends on**: Tasks 12, 4
- **Files**:
  - `packages/core/src/mcp/mcp-config-writer.ts`
- **Testing**: Unit tests with mocked file system. Test JSON (Claude/OpenCode) and TOML (Codex) formats. Test handling of invalid existing config.
- **Spec reference**: Per-harness configuration mapping in specs/installation-and-auth.md

### Task 14: Implement MCP tracker module
- **Description**: Create mcp-tracker.ts to record configured MCP servers in tracking file. Store server name, config path, and configuration timestamp. Support reading for uninstall.
- **Depends on**: Task 13
- **Files**:
  - `packages/core/src/mcp/mcp-tracker.ts`
  - `packages/core/src/mcp/index.ts` (export public API)
- **Testing**: Unit tests for tracking file read/write. Test handling of missing/corrupted tracking file.

## Phase 5: Harness Adapters

### Task 15: Implement base harness adapter interface
- **Description**: Create harness-adapter.ts with abstract base class or interface. Define methods: getMcpConfigPath(), getSkillsPath(), readMcpConfig(), writeMcpConfig(), supportsMcp(). Create adapter factory function.
- **Depends on**: Task 4
- **Files**:
  - `packages/core/src/harnesses/harness-adapter.ts`
  - `packages/core/src/harnesses/index.ts` (export factory and types)
- **Testing**: Type checking to ensure all adapters implement interface.

### Task 16: Implement Claude Code adapter
- **Description**: Create claude-adapter.ts for Claude Code harness. Config path: `~/.claude/.mcp.json`. Skills path: `~/.claude/skills/`. JSON format. Supports MCP: true.
- **Depends on**: Task 15
- **Files**:
  - `packages/core/src/harnesses/claude-adapter.ts`
- **Testing**: Unit tests for path resolution, config read/write with JSON format.
- **Spec reference**: Claude Code configuration scenario in specs/installation-and-auth.md

### Task 17: Implement Codex CLI adapter
- **Description**: Create codex-adapter.ts for Codex CLI harness. Config path: `~/.codex/config.toml`. Skills path: `~/.codex/skills/`. TOML format. Supports MCP: true.
- **Depends on**: Task 15
- **Files**:
  - `packages/core/src/harnesses/codex-adapter.ts`
- **Testing**: Unit tests for path resolution, config read/write with TOML format.
- **Spec reference**: Codex CLI configuration scenario in specs/installation-and-auth.md

### Task 18: Implement OpenCode adapter
- **Description**: Create opencode-adapter.ts for OpenCode harness. Config path: `~/.config/opencode/opencode.jsonc`. Skills path: `~/.config/opencode/skills/`. JSONC format (JSON with comments). Supports MCP: true.
- **Depends on**: Task 15
- **Files**:
  - `packages/core/src/harnesses/opencode-adapter.ts`
- **Testing**: Unit tests for path resolution, config read/write with JSONC format (preserve comments).

### Task 19: Implement Pi Agent adapter
- **Description**: Create pi-adapter.ts for Pi Agent harness. No MCP config path (returns null). Skills path: `~/.pi/skills/`. Supports MCP: false. Skip MCP configuration in install flow.
- **Depends on**: Task 15
- **Files**:
  - `packages/core/src/harnesses/pi-adapter.ts`
- **Testing**: Unit tests for path resolution, verify supportsMcp() returns false.
- **Spec reference**: Pi Agent configuration scenario in specs/installation-and-auth.md

## Phase 6: Core Installer Orchestration

### Task 20: Implement main installer orchestrator
- **Description**: Create index.ts with `install()` function. Orchestrate flow: load bundle → ensure auth → install skills → configure MCP → write tracking file. Accept InstallOptions, return InstallResult. Handle errors and partial failures.
- **Depends on**: Tasks 8, 11, 14, 15
- **Files**:
  - `packages/core/src/index.ts` (main orchestrator)
- **Testing**: Integration test with mocked modules. Test happy path, auth failure, skill copy failure, MCP config failure.
- **Spec reference**: Installation Flow in specs/installation-and-auth.md

### Task 21: Implement uninstall function
- **Description**: Add `uninstall()` function to index.ts. Read tracking file → remove MCP configs → remove skills → delete tracking file. Preserve credentials. Handle missing tracking file gracefully.
- **Depends on**: Task 20
- **Files**:
  - `packages/core/src/index.ts` (add uninstall function)
- **Testing**: Integration test with mocked tracking file. Test clean uninstall, missing tracking file, partial artifacts.
- **Spec reference**: Uninstall Flow in specs/installation-and-auth.md

### Task 22: Implement doctor function
- **Description**: Add `doctor()` function to index.ts. Check: credentials exist and valid → skills exist in harness path → MCP configs present → MCP servers reachable. Return DoctorReport with status and actionable messages.
- **Depends on**: Task 20
- **Files**:
  - `packages/core/src/index.ts` (add doctor function)
- **Testing**: Integration test with various failure scenarios. Test all green, missing creds, missing skills, unreachable MCP.
- **Spec reference**: Doctor/Health Check in specs/installation-and-auth.md

## Phase 7: Marketplace Packages

### Task 23: Create Claude Code plugin package
- **Description**: Create `packages/claude-plugin` with package.json, postinstall.js, and .claude-plugin/plugin.json manifest. postinstall.js invokes core installer with harness='claude'. Include preuninstall.js for uninstall hook.
- **Depends on**: Task 20
- **Files**:
  - `packages/claude-plugin/package.json`
  - `packages/claude-plugin/postinstall.js`
  - `packages/claude-plugin/preuninstall.js`
  - `packages/claude-plugin/.claude-plugin/plugin.json`
- **Testing**: Manual test: `npm install` in packages/claude-plugin, verify postinstall runs. Check plugin.json schema compliance.

### Task 24: Create Codex CLI plugin package
- **Description**: Create `packages/codex-plugin` with package.json, postinstall.js, and .codex-plugin/plugin.json manifest. postinstall.js invokes core installer with harness='codex'. Include preuninstall.js.
- **Depends on**: Task 20
- **Files**:
  - `packages/codex-plugin/package.json`
  - `packages/codex-plugin/postinstall.js`
  - `packages/codex-plugin/preuninstall.js`
  - `packages/codex-plugin/.codex-plugin/plugin.json`
- **Testing**: Manual test: `npm install` in packages/codex-plugin, verify postinstall runs. Check plugin.json schema compliance.

### Task 25: Create OpenCode plugin package
- **Description**: Create `packages/opencode-plugin` with package.json, postinstall.js, and opencode.jsonc config template. postinstall.js invokes core installer with harness='opencode'. Include preuninstall.js.
- **Depends on**: Task 20
- **Files**:
  - `packages/opencode-plugin/package.json`
  - `packages/opencode-plugin/postinstall.js`
  - `packages/opencode-plugin/preuninstall.js`
  - `packages/opencode-plugin/opencode.jsonc`
- **Testing**: Manual test: `npm install` in packages/opencode-plugin, verify postinstall runs.

### Task 26: Create Antigravity plugin package (placeholder)
- **Description**: Create `packages/antigravity-plugin` scaffold with package.json and postinstall.js. Mark as TODO pending Antigravity documentation review. postinstall.js invokes core installer with harness='antigravity'.
- **Depends on**: Task 20
- **Files**:
  - `packages/antigravity-plugin/package.json`
  - `packages/antigravity-plugin/postinstall.js`
  - `packages/antigravity-plugin/README.md` (TODO notes)
- **Testing**: Verify package structure. Skip functional test until Antigravity docs reviewed.

### Task 27: Create Pi Agent plugin package
- **Description**: Create `packages/pi-plugin` with package.json and postinstall.js. postinstall.js invokes core installer with harness='pi'. Note: Pi does not support MCP, only skills installed.
- **Depends on**: Task 20
- **Files**:
  - `packages/pi-plugin/package.json`
  - `packages/pi-plugin/postinstall.js`
  - `packages/pi-plugin/preuninstall.js`
- **Testing**: Manual test: `npm install` in packages/pi-plugin, verify only skills installed (no MCP config).

## Phase 8: Testing and Verification

### Task 28: Write integration tests for core installer
- **Description**: Create comprehensive integration tests in `packages/core/test/integration.test.ts`. Test full install/uninstall cycle with real file system (use temp directory). Test all harness types. Test error scenarios.
- **Depends on**: Task 22
- **Files**:
  - `packages/core/test/integration.test.ts`
- **Testing**: Run `npm test` in packages/core. All tests pass.

### Task 29: Create manual test script
- **Description**: Create `scripts/test-marketplace-install.sh` to manually test marketplace installation. Script installs each plugin package in isolated temp directory, verifies skills and MCP configs, then uninstalls.
- **Depends on**: Tasks 23-27
- **Files**:
  - `scripts/test-marketplace-install.sh`
- **Testing**: Run script manually, verify all 5 plugins install/uninstall cleanly.

### Task 30: Implement doctor CLI command
- **Description**: Create `packages/core/src/cli.ts` with CLI interface using commander or similar. Add `doctor` command that calls doctor() function and displays results with colored output (green/yellow/red).
- **Depends on**: Task 22
- **Files**:
  - `packages/core/src/cli.ts`
  - `packages/core/package.json` (add bin entry)
- **Testing**: Run `npx @nodesource/plugin-core doctor --harness claude`. Verify output format and colors.

### Task 31: Write README documentation
- **Description**: Create comprehensive README.md with installation instructions for each marketplace, authentication flow explanation, troubleshooting guide, and development setup.
- **Depends on**: Tasks 23-27
- **Files**:
  - `README.md` (update root README)
  - `packages/core/README.md`
- **Testing**: Review for clarity and completeness. Test all commands mentioned in README.

### Task 32: Set up CI/CD pipeline
- **Description**: Create GitHub Actions workflow for automated testing. Run unit tests, integration tests, and lint on PR. Build and publish packages on release tag.
- **Depends on**: Task 28
- **Files**:
  - `.github/workflows/test.yml`
  - `.github/workflows/publish.yml`
- **Testing**: Push to branch, verify CI runs. Create test release, verify publish workflow.

## Phase 9: Polish and Edge Cases

### Task 33: Implement idempotent installation
- **Description**: Review and enhance install() to ensure idempotency. Re-running install should not create duplicate entries, should update existing configs, should handle already-installed state gracefully.
- **Depends on**: Task 28
- **Files**:
  - `packages/core/src/index.ts` (review and enhance)
- **Testing**: Run install twice in integration test. Verify no duplicates, no errors.
- **Spec reference**: Idempotent installation scenario in specs/installation-and-auth.md

### Task 34: Add comprehensive error messages
- **Description**: Review all error paths in core installer. Add actionable error messages with specific guidance (e.g., "Permission denied writing to ~/.claude/.mcp.json. Try: sudo chown -R $USER ~/.claude"). Use error codes for programmatic handling.
- **Depends on**: Task 28
- **Files**:
  - `packages/core/src/errors.ts` (error classes)
  - Update all modules to use structured errors
- **Testing**: Trigger each error scenario, verify message clarity and actionability.

### Task 35: Implement config backup and restore
- **Description**: Before modifying harness configs, create backup at `~/.agents/.config-backup/<harness>/<timestamp>.json`. Add restore command to CLI for manual recovery. Document backup location in README.
- **Depends on**: Task 20
- **Files**:
  - `packages/core/src/utils/backup.ts`
  - `packages/core/src/cli.ts` (add restore command)
- **Testing**: Install plugin, verify backup created. Manually corrupt config, run restore, verify recovery.

### Task 36: Add verbose logging mode
- **Description**: Add `--verbose` flag to CLI and environment variable support (NSOLID_PLUGIN_VERBOSE). Log all file operations, API calls, and decisions. Use structured logging with timestamps.
- **Depends on**: Task 30
- **Files**:
  - `packages/core/src/utils/logger.ts`
  - Update all modules to use logger
- **Testing**: Run install with --verbose, verify detailed output. Run without flag, verify clean output.

## Phase 10: Documentation and Handoff

### Task 37: Create developer onboarding guide
- **Description**: Write CONTRIBUTING.md with development setup, architecture overview, how to add new skills/MCP servers, how to add new harness adapters, testing strategy, and release process.
- **Depends on**: Task 31
- **Files**:
  - `CONTRIBUTING.md`
- **Testing**: Have team member follow guide to set up dev environment and make small change.

### Task 38: Document Antigravity CLI requirements
- **Description**: Research Antigravity CLI 2.0 plugin format and marketplace. Create `docs/antigravity-research.md` with findings, required manifest format, and implementation plan for completing Task 26.
- **Depends on**: None (can be done in parallel)
- **Files**:
  - `docs/antigravity-research.md`
- **Testing**: Review with team for completeness and accuracy.

### Task 39: Create demo video script
- **Description**: Write script for 2-minute demo video showing installation from each marketplace, authentication flow, skill usage, and uninstall. Include talking points and screen recording steps.
- **Depends on**: Task 31
- **Files**:
  - `docs/demo-script.md`
- **Testing**: Dry run script, verify timing and clarity.

### Task 40: Final integration testing and bug fixes
- **Description**: Perform end-to-end testing of all marketplace packages on clean systems (macOS, Linux). Document and fix any issues found. Verify all acceptance criteria from proposal.md are met.
- **Depends on**: Tasks 23-32
- **Files**:
  - Update any files with bug fixes
  - `docs/testing-report.md` (test results)
- **Testing**: All acceptance criteria verified. No critical bugs remaining.
