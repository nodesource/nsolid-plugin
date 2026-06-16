# Design

## Architecture

The cross-harness plugin installer follows a **shared core + marketplace wrappers** architecture. A single monorepo contains the shared installation logic, while each marketplace gets its own package with native manifest format. Each package uses the harness's native trigger to invoke the shared core installer; npm `postinstall` is NOT used as the universal trigger.

```
nsolid-plugin/
├── packages/
│   ├── core/                    # Shared installation logic
│   │   ├── src/
│   │   │   ├── index.ts         # Main installer orchestrator
│   │   │   ├── auth/            # OAuth flow module
│   │   │   ├── skills/          # Skill copier module
│   │   │   ├── mcp/             # MCP config writer module
│   │   │   ├── harnesses/       # Per-harness config adapters
│   │   │   └── utils/           # Shared utilities
│   │   ├── scripts/
│   │   │   └── setup.mjs        # Shared setup script invoked by per-package wrappers
│   │   └── package.json
│   ├── claude-plugin/           # Claude Code marketplace package
│   │   ├── .claude-plugin/
│   │   │   └── plugin.json
│   │   ├── hooks/
│   │   │   └── hooks.json       # SessionStart → scripts/setup.js
│   │   ├── scripts/setup.js     # Invokes packages/core/scripts/setup.mjs
│   │   └── package.json
│   ├── codex-plugin/            # Codex CLI marketplace package
│   │   ├── .codex-plugin/
│   │   │   └── plugin.json
│   │   ├── hooks/
│   │   │   └── hooks.json       # SessionStart → scripts/setup.js
│   │   ├── scripts/setup.js     # Invokes packages/core/scripts/setup.mjs
│   │   └── package.json
│   ├── opencode-plugin/         # OpenCode marketplace package
│   │   ├── index.js             # Plugin module loaded by OpenCode → invokes setup script
│   │   └── package.json
│   ├── antigravity-plugin/      # Antigravity CLI marketplace package
│   │   ├── plugin.json          # Native discovery manifest
│   │   ├── scripts/
│   │   │   └── install.js       # Manual one-time install → copies dir + invokes core.install()
│   │   └── package.json
│   └── pi-plugin/               # Pi Agent marketplace package
│       ├── package.json         # pi.extensions → index.js
│       ├── index.js             # Extension entrypoint → invokes core.install()
│       └── README.md
├── bundle.json                  # Canonical bundle descriptor
└── package.json                 # Workspace root
```

### Key Architectural Decisions

1. **Shared core as npm package**: All marketplace packages depend on `@nodesource/plugin-core`, ensuring consistent behavior across harnesses.

2. **Harness-native triggers**: Each marketplace package uses the harness's native trigger to invoke the shared core installer:
   - Claude Code and Codex CLI: `SessionStart` hook in `hooks/hooks.json`.
   - OpenCode: plugin module loaded by OpenCode on startup.
   - Antigravity CLI: manual one-time `scripts/install.js` (no install-time hook exists).
   - Pi Agent: `pi.extensions` entrypoint loaded when the Pi package loads.
   npm `postinstall` is NOT used as a universal trigger because Claude, Codex, OpenCode, and Antigravity do not run npm lifecycle scripts reliably (OpenCode uses Bun which is default-secure; Antigravity has no such hook at all).

3. **Bundle descriptor pattern**: A single `bundle.json` file defines all skills and MCP servers. The core installer reads this and adapts it per-harness.

4. **Auth flow adapted from nsentinel**: The OAuth flow is extracted and simplified for CLI context (no VSCode dependency). Uses browser redirect + local HTTP callback server.

5. **Skills as universal path**: All harnesses support `~/.agents/skills/` or similar. The core installer copies skills to a canonical location, then each harness adapter creates symlinks (Unix) or copies/junctions (Windows) to harness-specific paths.

6. **Cross-platform support**: The installer supports macOS, Linux, and Windows as first-class platforms. All path resolution uses `os.homedir()` + `path.join()` (never string concatenation with `/`). Platform-specific behavior (symlinks, permissions, atomic writes) is abstracted in shared utilities.

### Platform Path Resolution

All paths in this design use `~` as shorthand. At runtime, the path utility (`packages/core/src/utils/path.ts`) resolves these using `os.homedir()` + `path.join()`:

| Logical Path | macOS/Linux | Windows |
|---|---|---|
| `~/.agents/skills/` | `/home/user/.agents/skills/` | `C:\Users\user\.agents\skills\` |
| `~/.agents/.nodesource-auth.json` | `/home/user/.agents/.nodesource-auth.json` | `C:\Users\user\.agents\.nodesource-auth.json` |
| `~/.agents/.nodesource-installed.json` | `/home/user/.agents/.nodesource-installed.json` | `C:\Users\user\.agents\.nodesource-installed.json` |
| `~/.claude.json` | `/home/user/.claude.json` | `C:\Users\user\.claude.json` |
| `~/.claude/skills/` | `/home/user/.claude/skills/` | `C:\Users\user\.claude\skills\` |
| `~/.codex/config.toml` | `/home/user/.codex/config.toml` | `C:\Users\user\.codex\config.toml` |
| `~/.codex/skills/` | `/home/user/.codex/skills/` | `C:\Users\user\.codex\skills\` |
| `~/.config/opencode/opencode.jsonc` | `/home/user/.config/opencode/opencode.jsonc` | `C:\Users\user\.config\opencode\opencode.jsonc` |
| `~/.config/opencode/skills/` | `/home/user/.config/opencode/skills/` | `C:\Users\user\.config\opencode\skills\` |
| `~/.gemini/config/mcp_config.json` | `/home/user/.gemini/config/mcp_config.json` | `C:\Users\user\.gemini\config\mcp_config.json` |
| `~/.gemini/config/plugins/nodesource-nsolid/` | `/home/user/.gemini/config/plugins/nodesource-nsolid/` | `C:\Users\user\.gemini\config\plugins\nodesource-nsolid\` |
| `~/.gemini/skills/` | `/home/user/.gemini/skills/` | `C:\Users\user\.gemini\skills\` |
| `~/.pi/agent/skills/` | `/home/user/.pi/agent/skills/` | `C:\Users\user\.pi\agent\skills\` |

**Rules:**
- All path construction uses `path.join(os.homedir(), ...segments)` — never string concatenation with `/`
- All stored paths are normalized with `path.resolve()` before writing to tracking files
- Harness adapters return platform-appropriate paths from `getMcpConfigPath()` and `getSkillsPath()`
- **Note**: All verified harnesses use `%USERPROFILE%` (i.e., `os.homedir()`) on Windows — none use `%APPDATA%`. Claude Code config dir can be overridden via `CLAUDE_CONFIG_DIR`; Codex CLI via `CODEX_HOME`; Pi Agent via `PI_CODING_AGENT_DIR`.

### Platform Filesystem Abstractions

**Symlinks:**
- Unix (macOS/Linux): Use `fs.symlink()` (standard symbolic links)
- Windows: Use `fs.symlink(target, path, 'junction')` for directory links (junctions work without Developer Mode or admin privileges). Fall back to file copy if junction creation fails.

**File permissions (`0600`):**
- Unix: `fs.chmod(path, 0o600)` restricts to owner read/write
- Windows: `fs.chmod()` has minimal effect (only toggles read-only flag). Credential protection relies on `%USERPROFILE%` directory ACLs. Consider Windows Credential Manager or DPAPI as a future enhancement.

**Atomic writes:**
- Unix: Write to temp file, `fs.rename()` overwrites target atomically
- Windows: On Node.js < 14, `fs.rename()` fails with `EPERM` if the destination exists. On Node.js 14+, `fs.rename()` uses `MoveFileEx` with `MOVEFILE_REPLACE_EXISTING` and works. Recommended approach: use the `write-file-atomic` package as the primary strategy (handles all platform differences, avoids the unlink-then-rename data-loss window where the target file briefly doesn't exist).

**Error messages:**
- Unix: Suggest `sudo`, `chown`, `chmod` as appropriate
- Windows: Suggest "Run as Administrator", `icacls`, `takeown` as appropriate. Detect OS via `process.platform` and provide platform-specific remediation.

## Module Boundaries

### Core Installer (`packages/core/src/index.ts`)

**Responsibilities:**
- Orchestrate the installation flow (auth → skills → MCP → tracking)
- Load and validate `bundle.json`
- Delegate to specialized modules (auth, skills, mcp)
- Handle errors and rollback

**Public Interface:**
```typescript
export interface InstallOptions {
  harness: 'claude' | 'codex' | 'opencode' | 'antigravity' | 'pi';
  bundlePath: string;
  skillsSource: string;
  dryRun?: boolean;
}

export interface InstallResult {
  success: boolean;
  skillsInstalled: number;
  mcpServersConfigured: string[];
  authRequired: boolean;
  errors: string[];
}

export async function install(options: InstallOptions): Promise<InstallResult>;
export async function uninstall(harness: HarnessType): Promise<void>;
export async function doctor(harness: HarnessType): Promise<DoctorReport>;
```

### Auth Module (`packages/core/src/auth/`)

**Responsibilities:**
- Check for existing valid credentials
- Initiate OAuth flow (browser + callback server)
- Validate tokens with Accounts API
- Store credentials securely

**Files:**
- `auth-manager.ts` - Main auth orchestrator
- `oauth-server.ts` - Local HTTP callback server
- `token-storage.ts` - Read/write credentials to disk
- `token-validator.ts` - Validate with Accounts API

**Public Interface:**
```typescript
export interface Credentials {
  serviceToken: string;
  organizationId: string;
  saasToken: string;
  consoleUrl: string;
  mcpUrl: string;
  expiresAt: string;
  permissions?: string[];
}

export async function ensureAuthenticated(): Promise<Credentials>;
export async function loadCredentials(): Promise<Credentials | null>;
export async function clearCredentials(): Promise<void>;
```

### Skills Module (`packages/core/src/skills/`)

**Responsibilities:**
- Copy skills from source to `~/.agents/skills/`
- Create harness-specific symlinks (Unix) or copies/junctions (Windows)
- Track installed skills for uninstall

**Files:**
- `skill-copier.ts` - Copy skills to canonical location
- `skill-linker.ts` - Create harness-specific links
- `skill-tracker.ts` - Track installed skills

**Public Interface:**
```typescript
export interface SkillRef {
  name: string;
  path: string;
  description: string;
}

export async function installSkills(skills: SkillRef[], source: string): Promise<void>;
export async function uninstallSkills(skills: SkillRef[]): Promise<void>;
export async function linkSkillsToHarness(harness: HarnessType, skills: SkillRef[]): Promise<void>;
```

### MCP Module (`packages/core/src/mcp/`)

**Responsibilities:**
- Generate MCP configurations per-harness
- Merge with existing configs (no overwrites)
- Track configured MCP servers for uninstall

**Files:**
- `mcp-config-writer.ts` - Write harness-specific configs
- `mcp-config-merger.ts` - Merge without overwriting
- `mcp-tracker.ts` - Track configured servers

**Public Interface:**
```typescript
export interface McpServerRef {
  name: string;
  url: string;
  headers: Record<string, string>;
}

export async function configureMcpServers(harness: HarnessType, servers: McpServerRef[]): Promise<void>;
export async function removeMcpServers(harness: HarnessType, serverNames: string[]): Promise<void>;
```

### Harness Adapters (`packages/core/src/harnesses/`)

**Responsibilities:**
- Abstract harness-specific config locations and formats
- Provide unified interface for all harnesses

**Files:**
- `harness-adapter.ts` - Base interface
- `claude-adapter.ts` - Claude Code specifics
- `codex-adapter.ts` - Codex CLI specifics
- `opencode-adapter.ts` - OpenCode specifics
- `antigravity-adapter.ts` - Antigravity specifics
- `pi-adapter.ts` - Pi Agent specifics

**Public Interface:**
```typescript
export interface HarnessAdapter {
  name: HarnessType;
  getMcpConfigPath(): string;
  getSkillsPath(): string;
  readMcpConfig(): Promise<McpConfig>;
  writeMcpConfig(config: McpConfig): Promise<void>;
  supportsMcp(): boolean;
}

export function getAdapter(harness: HarnessType): HarnessAdapter;
```

## Interfaces and Contracts

### Bundle Descriptor (`bundle.json`)

```json
{
  "name": "nodesource-ai-skills",
  "version": "1.0.0",
  "description": "NodeSource AI skills for N|Solid performance and security",
  "skills": [
    {
      "name": "ns-analyze-vulnerabilities",
      "path": "skills/ns-analyze-vulnerabilities",
      "description": "Scan running production memory for actively-exploitable CVEs",
      "requiresMcp": ["nsolid-console"]
    }
  ],
  "mcpServers": [
    {
      "name": "nsolid-console",
      "url": "${MCP_URL}",
      "headers": {
        "X-Nsolid-Service-Token": "${AUTH_TOKEN}"
      }
    },
    {
      "name": "ns-benchmark",
      "url": "https://benchmark.mcp.saas.nodesource.io/mcp",
      "headers": {
        "X-Nsolid-Org-Id": "${AUTH_ORG_ID}",
        "X-Nsolid-Service-Token": "${AUTH_TOKEN}"
      }
    },
    {
      "name": "ncm",
      "url": "https://mcp.ncm.nodesource.com",
      "headers": {
        "X-Nsolid-Service-Token": "${AUTH_TOKEN}"
      }
    }
  ],
  "auth": {
    "type": "oauth",
    "provider": "nodesource",
    "accountsUrl": "https://accounts.nodesource.com",
    "callbackPort": 8765,
    "requiredPermissions": ["nsolid:benchmark:run"]
  }
}
```

**JSON Schema:** Defined in `packages/core/schemas/bundle.schema.json`

#### Variable Expansion

Placeholders in `mcpServers[].url` and `mcpServers[].headers` are expanded at **install time** (not runtime):

- `${MCP_URL}` — derived from `consoleUrl` credential using the pattern `consoleUrl.replace('.saas.', '.mcp.saas.')` (e.g. `https://abc123.saas.nodesource.io` → `https://abc123.mcp.saas.nodesource.io`)
- `${AUTH_TOKEN}` — resolved from credentials at `~/.agents/.nodesource-auth.json` (`serviceToken` field)
- `${AUTH_ORG_ID}` — resolved from credentials at `~/.agents/.nodesource-auth.json` (`organizationId` field)

**Source precedence** (highest to lowest): environment variables → credential store (`~/.agents/.nodesource-auth.json`) → agent config.

**Failure behavior**: If a required variable cannot be resolved, the installer logs a warning and writes the placeholder as-is. MCP servers will fail at runtime with a clear error if credentials are missing.

#### MCP Dependency Validation (`requiresMcp`)

Skills may declare MCP dependencies via `requiresMcp: string[]`. During install:

1. Check the list of MCP servers being installed (from `bundle.json#mcpServers`)
2. If a required MCP server name is not in the install list, log a warning but continue (the MCP may be provided externally)
3. If MCP config writing fails for a required server, the dependent skill remains installed but a warning is logged
4. Automatic MCP installation from external registries is **not** allowed — only bundled MCP servers are installed

**Valid MCP server names:** `nsolid-console`, `ns-benchmark`, `ncm` (cloud endpoints, Streamable HTTP transport).

### Credentials Storage (`~/.agents/.nodesource-auth.json`)

```json
{
  "serviceToken": "nst_abc123...",
  "organizationId": "org_xyz789",
  "expiresAt": "2026-12-31T23:59:59Z",
  "permissions": ["nsolid:benchmark:run"]
}
```

**File permissions:** `0600` (owner read/write only). On Windows, `chmod 0600` has minimal effect (only toggles read-only flag); credential protection relies on directory ACLs. See Platform Filesystem Abstractions above.

### Tracking File (`~/.agents/.nodesource-installed.json`)

```json
{
  "version": "1.0.0",
  "installedAt": "2026-06-04T12:00:00Z",
  "harness": "claude",
  "skills": [
    {
      "name": "ns-analyze-vulnerabilities",
      "path": "<resolved absolute path, e.g. /home/user/.agents/skills/ns-analyze-vulnerabilities or C:\\Users\\user\\.agents\\skills\\ns-analyze-vulnerabilities>"
    }
  ],
  "mcpServers": [
    {
      "name": "ns-benchmark",
      "configPath": "<resolved absolute path, e.g. /home/user/.claude.json or C:\\Users\\user\\.claude.json>"
    }
  ]
}
```

**File permissions:** `0600` (owner read/write only; limited effect on Windows — see Platform Filesystem Abstractions). Written atomically via temp-file rename: on Unix, `fs.rename()` overwrites atomically; on Windows, `fs.unlink()` the target first if it exists (since `fs.rename()` fails with `EPERM` when destination exists), then `fs.rename()`. Temp file must be on the same volume as the target.

> **Note**: Each skill entry includes a `harnesses: string[]` field to support multi-harness installations. The top-level `harness` field records the primary installing harness for backward compatibility.

### Harness Config Formats

All MCP servers are cloud endpoints accessed via Streamable HTTP. Auth tokens are passed as HTTP headers.

**Claude Code (`~/.claude.json`):**
> **Note**: User-scoped MCP servers are stored in `~/.claude.json` (outside the `~/.claude/` directory). Project-scoped servers use `.mcp.json` in the project root. We write to the user-scoped file.
```json
{
  "mcpServers": {
    "nsolid-console": {
      "url": "https://<id>.mcp.saas.nodesource.io",
      "headers": { "X-Nsolid-Service-Token": "<token>" }
    },
    "ns-benchmark": {
      "url": "https://benchmark.mcp.saas.nodesource.io/mcp",
      "headers": { "X-Nsolid-Org-Id": "<orgId>", "X-Nsolid-Service-Token": "<token>" }
    },
    "ncm": {
      "url": "https://mcp.ncm.nodesource.com",
      "headers": { "X-Nsolid-Service-Token": "<token>" }
    }
  }
}
```

**Codex CLI (`~/.codex/config.toml`):**
```toml
[mcp_servers.nsolid-console]
url = "https://<id>.mcp.saas.nodesource.io"

[mcp_servers.nsolid-console.headers]
X-Nsolid-Service-Token = "<token>"

[mcp_servers.ns-benchmark]
url = "https://benchmark.mcp.saas.nodesource.io/mcp"

[mcp_servers.ns-benchmark.headers]
X-Nsolid-Org-Id = "<orgId>"
X-Nsolid-Service-Token = "<token>"

[mcp_servers.ncm]
url = "https://mcp.ncm.nodesource.com"

[mcp_servers.ncm.headers]
X-Nsolid-Service-Token = "<token>"
```

**OpenCode (`~/.config/opencode/opencode.jsonc`):**
```jsonc
{
  "mcpServers": {
    "nsolid-console": {
      "url": "https://<id>.mcp.saas.nodesource.io",
      "headers": { "X-Nsolid-Service-Token": "<token>" }
    },
    "ns-benchmark": {
      "url": "https://benchmark.mcp.saas.nodesource.io/mcp",
      "headers": { "X-Nsolid-Org-Id": "<orgId>", "X-Nsolid-Service-Token": "<token>" }
    },
    "ncm": {
      "url": "https://mcp.ncm.nodesource.com",
      "headers": { "X-Nsolid-Service-Token": "<token>" }
    }
  }
}
```

**Antigravity CLI (`~/.gemini/config/mcp_config.json`):**
> **Note**: Antigravity uses `serverUrl` (not `url`) as the URL field name. Shared MCP configs across all Antigravity tools go in `~/.gemini/config/mcp_config.json`.
```json
{
  "mcpServers": {
    "nsolid-console": {
      "serverUrl": "https://<id>.mcp.saas.nodesource.io",
      "headers": { "X-Nsolid-Service-Token": "<token>" }
    },
    "ns-benchmark": {
      "serverUrl": "https://benchmark.mcp.saas.nodesource.io/mcp",
      "headers": { "X-Nsolid-Org-Id": "<orgId>", "X-Nsolid-Service-Token": "<token>" }
    },
    "ncm": {
      "serverUrl": "https://mcp.ncm.nodesource.com",
      "headers": { "X-Nsolid-Service-Token": "<token>" }
    }
  }
}
```

## Data Flow

### Installation Sequence

```
┌─────────────┐
│  User runs  │
│  marketplace│
│  install    │
└──────┬──────┘
       │
       ▼
┌─────────────────┐
│ postinstall.js  │
│ (marketplace    │
│  package)       │
└──────┬──────────┘
       │
       ▼
┌─────────────────┐
│ Core Installer  │
│ install()       │
└──────┬──────────┘
       │
       ├──────────────────┐
       │                  │
       ▼                  ▼
┌──────────────┐   ┌──────────────┐
│ Auth Module  │   │ Load bundle  │
│ ensureAuth() │   │ descriptor   │
└──────┬───────┘   └──────┬───────┘
       │                  │
       │                  │
       ▼                  ▼
┌──────────────┐   ┌──────────────┐
│ OAuth flow   │   │ Skills       │
│ (if needed)  │   │ Module       │
└──────┬───────┘   │ installSkills│
       │           └──────┬───────┘
       │                  │
       │                  ▼
       │           ┌──────────────┐
       │           │ MCP Module   │
       │           │ configureMcp │
       │           └──────┬───────┘
       │                  │
       │                  ▼
       │           ┌──────────────┐
       │           │ Harness      │
       │           │ Adapter      │
       │           │ writeConfig  │
       │           └──────┬───────┘
       │                  │
       ▼                  ▼
┌─────────────────────────────┐
│ Write tracking file         │
│ ~/.agents/.nodesource-      │
│ installed.json              │
└─────────────────────────────┘
```

### Auth Flow Sequence

```
┌──────────┐
│ Installer│
└────┬─────┘
     │
     ▼
┌─────────────────┐
│ Check existing  │
│ credentials     │
└────┬────────────┘
     │
     ├─ Valid? ──Yes──┐
     │                │
     No               │
     │                │
     ▼                │
┌─────────────────┐   │
│ Start local     │   │
│ callback server │   │
│ (port 8765)     │   │
└────┬────────────┘   │
     │                │
     ▼                │
┌─────────────────┐   │
│ Open browser    │   │
│ accounts.ns.com │   │
└────┬────────────┘   │
     │                │
     ▼                │
┌─────────────────┐   │
│ User completes  │   │
│ OAuth in browser│   │
└────┬────────────┘   │
     │                │
     ▼                │
┌─────────────────┐   │
│ Callback server │   │
│ receives token  │   │
└────┬────────────┘   │
     │                │
     ▼                │
┌─────────────────┐   │
│ Validate token  │   │
│ with Accounts   │   │
│ API             │   │
└────┬────────────┘   │
     │                │
     ▼                │
┌─────────────────┐   │
│ Store creds at   │   │
│ ~/.agents/.node │   │
│ source-auth.json│   │
└────┬────────────┘   │
     │                │
     └────────┬───────┘
              │
              ▼
         ┌────────┐
         │ Return │
         │ creds  │
         └────────┘
```

### Uninstall Sequence

```
┌─────────────┐
│  User runs  │
│  marketplace│
│  uninstall  │
└──────┬──────┘
       │
       ▼
┌─────────────────┐
│ preuninstall.js │
│ (marketplace    │
│  package)       │
└──────┬──────────┘
       │
       ▼
┌─────────────────┐
│ Core Installer  │
│ uninstall()     │
└──────┬──────────┘
       │
       ▼
┌─────────────────┐
│ Read tracking   │
│ file            │
└──────┬──────────┘
       │
       ├──────────────────┐
       │                  │
       ▼                  ▼
┌──────────────┐   ┌──────────────┐
│ Remove MCP   │   │ Remove skills│
│ configs      │   │ from harness │
│ from harness │   │ paths        │
└──────┬───────┘   └──────┬───────┘
       │                  │
       │                  ▼
       │           ┌──────────────┐
       │           │ Remove skills│
       │           │ from         │
       │           │ ~/.agents/   │
       │           │ skills/      │
       │           └──────┬───────┘
       │                  │
       ▼                  ▼
┌─────────────────────────────┐
│ Delete tracking file        │
└─────────────────────────────┘
```

## Error Handling

### Auth Errors

1. **OAuth timeout**: After 5 minutes, shut down callback server, return error with retry guidance
2. **Token validation failure**: Store credentials optimistically, warn user, let MCP servers validate on first use
3. **Accounts API unavailable**: Same as validation failure - optimistic storage with warning
4. **Port conflict**: Try alternative ports (8766-8770), fail with actionable message if all occupied

### Installation Errors

1. **Skill copy failure**: Rollback partially copied skills, report error with disk/permission guidance
2. **MCP config write failure**: Keep skills installed, report MCP-specific error, allow re-run
3. **Config corruption**: Detect invalid JSON/TOML, warn user, offer to backup and recreate
4. **Permission denied**: Report specific file/path, suggest platform-appropriate fix (Unix: `sudo chown -R $USER <path>` or `chmod`; Windows: "Run as Administrator" or `icacls <path> /grant %USERNAME%:F`)

### Uninstall Errors

1. **Missing tracking file**: Best-effort cleanup of known NodeSource artifacts, warn user
2. **Partial uninstall**: Report which artifacts remain, provide manual cleanup instructions
3. **Permission denied**: Report specific files, suggest platform-appropriate manual deletion (Unix: `sudo rm -rf <path>`; Windows: "Run as Administrator" or `takeown /f <path> && rd /s <path>`)

## Design Decisions

### Why shared core + marketplace wrappers?

**Alternatives considered:**
1. **Single installer CLI** (`npx @nodesource/ai-skills install`): Rejected because user wants marketplace presence
2. **Five separate codebases**: Rejected due to maintenance burden and drift risk
3. **Shared core + wrappers**: Chosen for single source of truth + marketplace discoverability

**Tradeoffs:**
- More complex build/release process (5 packages vs 1)
- Requires npm workspace setup
- But: users get native marketplace UX, single source of truth for logic

### Why adapt nsentinel auth flow?

**Alternatives considered:**
1. **API key only**: Rejected - poor UX, requires manual key generation
2. **Device code flow**: Rejected - more complex than browser redirect
3. **Nsentinel OAuth**: Chosen - proven flow, user already requested it

**Adaptation:**
- Remove VSCode dependency (use `open` package for browser)
- Simplify state management (no VSCode state API)
- Keep same Accounts API endpoints

### Why `~/.agents/skills/` as canonical path?

**Rationale:**
- Universal path supported by Claude, Codex, OpenCode
- Pi Agent uses `~/.pi/agent/skills/` but can symlink (Unix) or copy (Windows) from `~/.agents/`
- Pi Agent also reads from `~/.agents/skills/` natively, so skills placed there are auto-discovered
- Single source of truth for skill content
- Harness adapters create symlinks on Unix, directory junctions or copies on Windows

### Why JSON for credentials and tracking?

**Alternatives considered:**
1. **YAML**: Rejected - requires parser dependency
2. **TOML**: Rejected - not universally supported in Node.js
3. **JSON**: Chosen - native support, simple, sufficient for this use case

### Why harness-native triggers instead of npm `postinstall`?

**Rationale:**
- Claude Code and Codex CLI copy plugin directories and do not run npm lifecycle scripts.
- OpenCode installs npm plugins with Bun, which is default-secure and skips `postinstall` unless the package is in the user's `trustedDependencies` allowlist.
- Antigravity CLI has no install-time or session-start hook at all (only tool/invocation hooks).
- Pi Agent packages are loaded via the `pi` manifest and have no install-time hook, but `pi.extensions` runs on package load.
- Therefore each harness's native trigger is used:
  - Claude/Codex: `SessionStart` hook → `scripts/setup.js` → `packages/core/scripts/setup.mjs`.
  - OpenCode: plugin module load → `index.js` → shared setup script.
  - Antigravity: manual one-time `scripts/install.js` → `core.install()`.
  - Pi: `pi.extensions` entrypoint → `core.install()`.

**Tradeoff:** Antigravity requires a manual install step because no hook exists. This is the least-bad option and keeps auth/MCP/skills consistent with the other harnesses.

## Migration Strategy

This is a **new project** - no migration needed. However, the design supports:

1. **Adding new skills**: Update `bundle.json`, re-run installer, new skills added
2. **Adding new MCP servers**: Update `bundle.json`, re-run installer, new servers configured
3. **Adding new harnesses**: Create new harness adapter + marketplace package
4. **Updating existing installations**: Re-run installer, idempotent merge behavior

## Deployment Order

1. **Phase 1**: Core package (`packages/core`)
   - Auth module
   - Skills module
   - MCP module
   - Harness adapters (Claude, Codex, OpenCode first)

2. **Phase 2**: Marketplace packages
   - Claude plugin
   - Codex plugin
   - OpenCode plugin

3. **Phase 3**: Additional harnesses
   - Antigravity plugin (after Antigravity docs reviewed)
   - Pi plugin (skills only)

4. **Phase 4**: Testing and verification
   - Manual marketplace install tests
   - Automated integration tests
   - Doctor command verification
