# Design

## Architecture

The cross-harness plugin installer now follows a **shared core + generated native artifacts + Pi package** architecture. The source tree keeps one canonical skill bundle and one shared installer/runtime package. Claude, Codex, and Antigravity plugin directories are generated into `dist/` from committed templates; they are no longer workspace packages under `packages/`. Pi remains a real package because Pi installs packages directly.

```
nsolid-plugin/
├── packages/
│   ├── core/                    # Shared CLI, setup, fallback install, auth, MCP, skills
│   │   ├── src/
│   │   │   ├── index.ts         # setup(), fallback install(), uninstall(), doctor()
│   │   │   ├── auth/            # OAuth flow module used only by setup/login
│   │   │   ├── skills/          # Fallback/direct installer skill copy/link modules
│   │   │   ├── mcp/             # MCP config writer module
│   │   │   ├── harnesses/       # Per-harness config adapters
│   │   │   └── utils/           # Shared utilities
│   │   ├── skills/              # Canonical committed N|Solid skills
│   │   ├── scripts/setup.mjs    # Shared package entrypoint for explicit setup
│   │   └── package.json
│   └── pi-plugin/               # Real Pi package; skills materialized only for pack
│       ├── package.json         # pi.skills plus side-effect-free extension metadata
│       ├── index.js             # Extension entrypoint; does not launch auth or write MCP config
│       └── README.md
├── plugins/templates/
│   ├── claude/                  # Source-only template for generated Claude artifact
│   ├── codex/                   # Source-only template for generated Codex artifact
│   └── antigravity/             # Source-only template for generated Antigravity artifact
├── scripts/
│   ├── plugin-generators.mjs    # Manifest/wrapper/config generation helpers
│   ├── build-plugin-artifacts.mjs # Generates dist/plugins + dist/artifacts
│   └── sync-plugin-assets.mjs   # Source hygiene + Pi materialization checks
├── dist/plugins/                # Generated plugin dirs; ignored, not committed
├── dist/artifacts/              # Generated .tgz release/local-install artifacts; ignored
├── bundle.json                  # Canonical bundle descriptor
└── package.json                 # Workspace root
```

### Key Architectural Decisions

1. **Shared core stays the behavioral source of truth**: `@nodesource/plugin-core` owns auth, fallback/direct install, MCP config writing, uninstall, doctor, and canonical skill metadata validation.

2. **Claude/Codex/Antigravity are generated artifacts, not source packages**: Marketplace/local plugin bundles are rendered from `plugins/templates/<harness>/` into `dist/plugins/<harness>/nsolid-plugin/` and archived under `dist/artifacts/`. This keeps source clean and makes release artifacts reproducible.

3. **Pi remains a package**: `packages/pi-plugin` stays in the workspace and materializes `packages/pi-plugin/skills/` during `prepack`, then cleans it in `postpack`/source mode.

4. **One canonical skill source**: `packages/core/skills/` is the only committed N|Solid skill source. Generated artifacts and Pi pack output receive materialized copies; source-mode package-local `skills/` directories are forbidden by `pnpm plugin:check`.

5. **Auth/setup is separate from install**: Only explicit `nsolid-plugin setup` / `nsolid-plugin login` may open a browser. Native plugin installation, generated install scripts, Pi package activation, and fallback `install --harness` must not launch auth.

6. **Native install vs fallback install**:
   - Native install places a generated harness plugin artifact where the harness can load it.
   - Fallback install (`nsolid-plugin install --harness <harness>`) directly copies/links skills and writes MCP config for users without a viable native plugin path; Pi is the exception because its package owns skills, so CLI fallback/setup writes MCP config only.
   - Setup/auth (`nsolid-plugin setup --harness <harness>`) prepares credentials and any harness config that truly needs explicit setup.

7. **Bundle descriptor pattern**: A single `bundle.json` file defines all skills and MCP servers. Builders and fallback installers validate generated artifacts against this descriptor.

8. **Cross-platform support**: The installer supports macOS, Linux, and Windows as first-class platforms. All path resolution uses `os.homedir()` + `path.join()` (never string concatenation with `/`). Platform-specific behavior (symlinks, permissions, atomic writes) is abstracted in shared utilities.

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
| `~/.gemini/antigravity-cli/mcp_config.json` | `/home/user/.gemini/antigravity-cli/mcp_config.json` | `C:\Users\user\.gemini\antigravity-cli\mcp_config.json` |
| `~/.gemini/antigravity-cli/plugins/nsolid-plugin/` | `/home/user/.gemini/antigravity-cli/plugins/nsolid-plugin/` | `C:\Users\user\.gemini\antigravity-cli\plugins\nsolid-plugin\` |
| `~/.gemini/antigravity-cli/skills/` | `/home/user/.gemini/antigravity-cli/skills/` | `C:\Users\user\.gemini\antigravity-cli\skills\` |
| `~/.pi/agent/mcp.json` | `/home/user/.pi/agent/mcp.json` | `C:\Users\user\.pi\agent\mcp.json` |
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
- Orchestrate explicit setup/login (auth → credential storage → any harness setup that is intentionally coupled to setup)
- Orchestrate fallback/direct install (bundle validation → skills → MCP → tracking) without opening a browser
- Load and validate `bundle.json`
- Delegate to specialized modules (auth, skills, mcp)
- Handle errors and rollback

**Public Interface:**
```typescript
export interface InstallOptions {
  harness: 'claude' | 'codex' | 'opencode' | 'antigravity' | 'pi';
  bundlePath: string;
  skillsSource: string;
  packageOwnedSkills?: boolean;     // Pi: skip user-level skill copy/link
  harnessSpecificSkills?: boolean;  // OpenCode: copy skills directly to harness path
}

export interface InstallResult {
  success: boolean;
  skillsInstalled: number;
  mcpServersConfigured: string[];
  hadToAuthenticate: boolean;
  errors: string[];
}

export async function setup(options: SetupOptions): Promise<SetupResult>;
export async function install(options: InstallOptions): Promise<InstallResult>;
export async function uninstall(harness: HarnessType, options?: UninstallOptions): Promise<UninstallResult>;
export async function doctor(harness: HarnessType, bundlePath: string): Promise<DoctorReport>;
```

### Auth Module (`packages/core/src/auth/`)

**Responsibilities:**
- Check for existing valid credentials
- Initiate OAuth flow (browser + callback server) only for explicit setup/login
- Validate tokens with Accounts API
- Store credentials securely
- Never run implicitly from native plugin install, package activation, generated install scripts, or fallback `install --harness`

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
- Copy skills for fallback/direct installs from source to `~/.agents/skills/` or harness-specific paths
- Create harness-specific symlinks (Unix) or copies/junctions (Windows) for fallback installs
- Track fallback-installed skills for uninstall
- Leave generated native artifacts self-contained; artifact materialization is owned by `scripts/build-plugin-artifacts.mjs`

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

**Schema validation:** Defined in `packages/core/src/validate.ts`.

#### Variable Expansion

Placeholders in `mcpServers[].url` and `mcpServers[].headers` are expanded when the CLI writes fallback/setup MCP config. Generated native MCP wrappers resolve credentials at runtime from `~/.agents/.nodesource-auth.json` instead of embedding secrets in artifacts.

- `${MCP_URL}` — derived from `consoleUrl` credential using the pattern `consoleUrl.replace('.saas.', '.mcp.saas.')` (e.g. `https://abc123.saas.nodesource.io` → `https://abc123.mcp.saas.nodesource.io`)
- `${AUTH_TOKEN}` — resolved from credentials at `~/.agents/.nodesource-auth.json` (`serviceToken` field)
- `${AUTH_ORG_ID}` — resolved from credentials at `~/.agents/.nodesource-auth.json` (`organizationId` field)

**Failure behavior**: If credentials are missing, fallback install does not open a browser; it may write placeholders and prints guidance to run `nsolid-plugin setup --harness <harness>`. Native wrappers fail at runtime with the same setup guidance.

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
  "saasToken": "nst_abc123...",
  "consoleUrl": "https://<console-id>.saas.nodesource.io",
  "mcpUrl": "https://<console-id>.mcp.saas.nodesource.io/",
  "expiresAt": "2026-12-31T23:59:59Z",
  "permissions": ["nsolid:benchmark:run"],
  "accountsUrl": "https://accounts.nodesource.com"
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
      "path": "<resolved absolute path, e.g. /home/user/.agents/skills/ns-analyze-vulnerabilities or C:\\Users\\user\\.agents\\skills\\ns-analyze-vulnerabilities>",
      "installedAt": "2026-06-04T12:00:00Z",
      "harnesses": ["claude"]
    }
  ],
  "mcpServers": [
    {
      "name": "ns-benchmark",
      "configPath": "<resolved absolute path, e.g. /home/user/.claude.json or C:\\Users\\user\\.claude.json>",
      "harness": "claude",
      "configuredAt": "2026-06-04T12:00:00Z"
    }
  ]
}
```

**File permissions:** `0600` (owner read/write only; limited effect on Windows — see Platform Filesystem Abstractions). Written atomically with `write-file-atomic`.

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
  "mcp": {
    "nsolid-console": {
      "type": "remote",
      "enabled": true,
      "url": "https://<id>.mcp.saas.nodesource.io",
      "headers": { "X-Nsolid-Service-Token": "<token>" }
    },
    "ns-benchmark": {
      "type": "remote",
      "enabled": true,
      "url": "https://benchmark.mcp.saas.nodesource.io/mcp",
      "headers": { "X-Nsolid-Org-Id": "<orgId>", "X-Nsolid-Service-Token": "<token>" }
    },
    "ncm": {
      "type": "remote",
      "enabled": true,
      "url": "https://mcp.ncm.nodesource.com",
      "headers": { "X-Nsolid-Service-Token": "<token>" }
    }
  }
}
```

**Antigravity CLI (`~/.gemini/antigravity-cli/mcp_config.json` fallback, or plugin-local `mcp_config.json` in native artifacts):**
> **Note**: Antigravity uses `serverUrl` (not `url`) as the URL field name. Generated native artifacts include plugin-local `mcp_config.json`; fallback direct install writes `~/.gemini/antigravity-cli/mcp_config.json`.
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

**Pi Agent (`~/.pi/agent/mcp.json`):**
> **Note**: Pi package-owned skills come from `@nodesource/pi-plugin`. `nsolid-plugin setup --harness pi` writes MCP config for `pi-mcp-adapter` and disables adapter OAuth auto-detection with `"auth": false` so NodeSource service-token headers are used.
```json
{
  "mcpServers": {
    "nsolid-console": {
      "url": "https://<id>.mcp.saas.nodesource.io",
      "auth": false,
      "headers": { "X-Nsolid-Service-Token": "<token>" }
    },
    "ns-benchmark": {
      "url": "https://benchmark.mcp.saas.nodesource.io/mcp",
      "auth": false,
      "headers": { "X-Nsolid-Org-Id": "<orgId>", "X-Nsolid-Service-Token": "<token>" }
    },
    "ncm": {
      "url": "https://mcp.ncm.nodesource.com",
      "auth": false,
      "headers": { "X-Nsolid-Service-Token": "<token>" }
    }
  }
}
```

## Data Flow

### Artifact Build Sequence

```
┌─────────────────────────────┐
│ pnpm plugin:artifacts       │
└──────────────┬──────────────┘
               │
               ▼
┌─────────────────────────────┐
│ scripts/build-plugin-       │
│ artifacts.mjs               │
└──────────────┬──────────────┘
               │
               ├───────────────┬────────────────┐
               ▼               ▼                ▼
┌─────────────────┐ ┌─────────────────┐ ┌─────────────────┐
│ Render Claude   │ │ Render Codex    │ │ Render          │
│ template        │ │ template        │ │ Antigravity     │
└────────┬────────┘ └────────┬────────┘ └────────┬────────┘
         │                   │                   │
         ▼                   ▼                   ▼
┌──────────────────────────────────────────────────────────┐
│ Copy artifact-local skills from packages/core/skills/    │
│ Generate manifests, MCP wrappers/config, install scripts │
│ Validate against bundle.json                             │
└───────────────────────────┬──────────────────────────────┘
                            ▼
┌──────────────────────────────────────────────────────────┐
│ dist/plugins/<harness>/nsolid-plugin/                    │
│ dist/artifacts/nsolid-<harness>-plugin.tgz               │
└──────────────────────────────────────────────────────────┘
```

### Native Plugin Install Sequence

```
┌─────────────────────────────┐
│ User installs generated     │
│ native artifact             │
└──────────────┬──────────────┘
               │
               ▼
┌─────────────────────────────┐
│ Harness stages plugin files │
│ from artifact-local bundle  │
└──────────────┬──────────────┘
               │
               ▼
┌─────────────────────────────┐
│ Docs/CLI/runtime wrapper    │
│ provide explicit setup      │
│ guidance when credentials   │
│ are missing                 │
└──────────────┬──────────────┘
               │
               ▼
┌─────────────────────────────┐
│ No browser/auth is launched │
│ by native install           │
└─────────────────────────────┘
```

### Fallback Direct Install Sequence

```
┌─────────────────────────────┐
│ nsolid-plugin install       │
│ --harness <harness>         │
└──────────────┬──────────────┘
               │
               ▼
┌─────────────────────────────┐
│ Load bundle descriptor      │
│ and source skills           │
└──────────────┬──────────────┘
               │
               ▼
┌─────────────────────────────┐
│ Copy/link fallback skills   │
│ where applicable; skip Pi   │
│ package-owned skills        │
└──────────────┬──────────────┘
               │
               ▼
┌─────────────────────────────┐
│ Merge MCP config; use creds │
│ when present, otherwise     │
│ print setup guidance        │
└──────────────┬──────────────┘
               │
               ▼
┌─────────────────────────────┐
│ Write tracking file         │
│ ~/.agents/.nodesource-      │
│ installed.json              │
└─────────────────────────────┘
```

### Setup/Auth Flow Sequence

```
┌──────────┐
│ setup/   │
│ login    │
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
│ accounts URL    │   │
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
│  native or  │
│  CLI cleanup│
└──────┬──────┘
       │
       ▼
┌─────────────────┐
│ Harness removes │
│ generated native│
│ artifact, or CLI│
│ calls uninstall │
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
2. **Token validation failure**: Treat invalid credentials as fatal and do not store them
3. **Accounts API unavailable**: Store credentials optimistically with a warning; MCP servers validate on first use
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

### Why shared core + generated native artifacts?

**Alternatives considered:**
1. **Single installer CLI only**: Rejected because native harness plugin UX is still valuable where supported.
2. **Five separate hand-maintained plugin packages**: Rejected due to duplicated skills, duplicated manifests, workspace noise, and high drift risk.
3. **Shared core + generated artifacts + Pi package**: Chosen for one source of truth, reproducible native bundles, and package-native Pi support.

**Tradeoffs:**
- Release now has an explicit artifact build step (`pnpm plugin:artifacts`).
- Generated outputs are not visible in source until built locally or in CI.
- But: source remains canonical, skills are not duplicated across package folders, and marketplaces/local install flows receive self-contained plugin bundles.

### Why adapt nsentinel auth flow?

**Alternatives considered:**
1. **API key only**: Rejected - poor UX, requires manual key generation
2. **Device code flow**: Rejected - more complex than browser redirect
3. **Nsentinel OAuth**: Chosen - proven flow, user already requested it

**Adaptation:**
- Remove VSCode dependency (use `open` package for browser)
- Simplify state management (no VSCode state API)
- Keep same Accounts API endpoints

### Why `packages/core/skills/` as canonical source?

**Rationale:**
- The repository needs exactly one committed N|Solid skill source to avoid divergent copies.
- Generated Claude/Codex/Antigravity artifacts include artifact-local `skills/` directories because their plugin formats expect self-contained bundles.
- Pi package artifacts receive `skills/` only during pack/materialization.
- Fallback direct installs can still copy/link skills into `~/.agents/skills/` or harness paths when native plugin install is unavailable.
- `pnpm plugin:check` enforces this source/artifact boundary.

### Why JSON for credentials and tracking?

**Alternatives considered:**
1. **YAML**: Rejected - requires parser dependency
2. **TOML**: Rejected - not universally supported in Node.js
3. **JSON**: Chosen - native support, simple, sufficient for this use case

### Why no install-time auth or startup hooks?

**Rationale:**
- Native plugin install should be predictable and non-interactive; it should not unexpectedly open a browser.
- Claude/Codex/Antigravity startup/setup hooks are not shipped because CLI/UI visibility is inconsistent and startup contexts are a poor place for OAuth prompts.
- Antigravity native install stages plugin assets; setup/auth is a separate user action.
- Pi package activation should not surprise users with auth or MCP config mutations.
- Therefore only `nsolid-plugin setup` / `nsolid-plugin login` may run OAuth.

**Tradeoff:** Users have one explicit post-install step. This is acceptable because missing credentials produce actionable runtime/setup guidance instead of hidden interactive behavior.

## Migration Strategy

The project migrated from hand-maintained per-harness package directories to generated artifacts:

1. **Canonical source cleanup**: Keep N|Solid skills only in `packages/core/skills/`; remove generated/package-local skill copies from source.
2. **Artifact templates**: Move Claude/Codex/Antigravity source-only pieces into `plugins/templates/<harness>/`.
3. **Generated outputs**: Render self-contained plugin directories under `dist/plugins/` and archives under `dist/artifacts/`.
4. **Pi exception**: Keep `packages/pi-plugin` as a real package with `prepack` skill materialization and post-pack/source cleanup.
5. **Auth split**: Remove browser/auth behavior from install paths; make `setup`/`login` the only OAuth entry points.

Future changes use this model:

1. **Adding new skills**: Update `packages/core/skills/` and `bundle.json`; run `pnpm plugin:check` and `pnpm plugin:artifacts`.
2. **Adding new MCP servers**: Update `bundle.json` and generator/runtime config helpers; validate generated `.mcp.json`/`mcp_config.json` outputs.
3. **Adding new generated harnesses**: Add a harness adapter if fallback install is needed, a template under `plugins/templates/`, and generator coverage in `scripts/plugin-generators.mjs`.
4. **Updating existing installations**: Re-run native artifact install or fallback install; both paths are idempotent and non-authenticating.

## Deployment Order

1. **Core and Pi packages**
   - Publish/build `@nodesource/plugin-core`.
   - Pack/publish `@nodesource/pi-plugin` with materialized skills.

2. **Generated native artifacts**
   - Run `pnpm plugin:artifacts`.
   - Upload `dist/artifacts/nsolid-<harness>-plugin.tgz` to releases or use `dist/plugins/<harness>/nsolid-plugin/` for local install/marketplace staging.

3. **Marketplace submission where available**
   - Submit/generated Claude and Codex plugin directories to curated/community marketplace paths when accepted.
   - Use generated artifacts/local install paths while curation is pending.
   - Use generated Antigravity local/remote plugin install until a curated marketplace path exists.

4. **Validation**
   - Run `pnpm plugin:check`, `pnpm plugin:artifacts:check`, `pnpm lint`, `pnpm test`, and `pnpm test:marketplace` before release.
