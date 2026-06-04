# Design

## Architecture

The cross-harness plugin installer follows a **shared core + marketplace wrappers** architecture. A single monorepo contains the shared installation logic, while each marketplace gets its own package with native manifest format.

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
│   │   └── package.json
│   ├── claude-plugin/           # Claude Code marketplace package
│   │   ├── .claude-plugin/
│   │   │   └── plugin.json
│   │   ├── postinstall.js       # Invokes shared core
│   │   └── package.json
│   ├── codex-plugin/            # Codex CLI marketplace package
│   │   ├── .codex-plugin/
│   │   │   └── plugin.json
│   │   ├── postinstall.js
│   │   └── package.json
│   ├── opencode-plugin/         # OpenCode marketplace package
│   │   ├── opencode.jsonc
│   │   ├── postinstall.js
│   │   └── package.json
│   ├── antigravity-plugin/      # Antigravity CLI marketplace package
│   │   ├── manifest.json
│   │   ├── postinstall.js
│   │   └── package.json
│   └── pi-plugin/               # Pi Agent marketplace package (skills only)
│       ├── postinstall.js
│       └── package.json
├── bundle.json                  # Canonical bundle descriptor
├── skills/                      # Symlinked from skills-poc
└── package.json                 # Workspace root
```

### Key Architectural Decisions

1. **Shared core as npm package**: All marketplace packages depend on `@nodesource/plugin-core`, ensuring consistent behavior across harnesses.

2. **Post-install hooks**: Each marketplace package uses npm's `postinstall` lifecycle script to invoke the shared core installer. This works across all marketplaces that support npm packages.

3. **Bundle descriptor pattern**: A single `bundle.json` file defines all skills and MCP servers. The core installer reads this and adapts it per-harness.

4. **Auth flow adapted from nsentinel**: The OAuth flow is extracted and simplified for CLI context (no VSCode dependency). Uses browser redirect + local HTTP callback server.

5. **Skills as universal path**: All harnesses support `~/.agents/skills/` or similar. The core installer copies skills to a canonical location, then each harness adapter creates symlinks or copies to harness-specific paths.

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
  expiresAt: Date;
}

export async function ensureAuthenticated(): Promise<Credentials>;
export async function loadCredentials(): Promise<Credentials | null>;
export async function clearCredentials(): Promise<void>;
```

### Skills Module (`packages/core/src/skills/`)

**Responsibilities:**
- Copy skills from source to `~/.agents/skills/`
- Create harness-specific symlinks/copies
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
  command: string;
  args: string[];
  env: Record<string, string>;
}

export async function configureMcpServers(harness: HarnessType, servers: McpServerRef[]): Promise<void>;
export async function removeMcpServers(harness: HarnessType, servers: McpServerRef[]): Promise<void>;
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
      "requiresMcp": ["nsolid-mcp"]
    }
  ],
  "mcpServers": [
    {
      "name": "ns-benchmark",
      "command": "node",
      "args": ["${MCP_ROOT}/ns-benchmark/src/mcp-entrypoint.js"],
      "env": {
        "NSOLID_SERVICE_TOKEN": "${AUTH_TOKEN}",
        "NSOLID_ORG_ID": "${AUTH_ORG_ID}"
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

### Credentials Storage (`~/.agents/.nodesource-auth.json`)

```json
{
  "serviceToken": "nst_abc123...",
  "organizationId": "org_xyz789",
  "expiresAt": "2026-12-31T23:59:59Z",
  "permissions": ["nsolid:benchmark:run"]
}
```

**File permissions:** `0600` (owner read/write only)

### Tracking File (`~/.agents/.nodesource-installed.json`)

```json
{
  "version": "1.0.0",
  "installedAt": "2026-06-04T12:00:00Z",
  "harness": "claude",
  "skills": [
    {
      "name": "ns-analyze-vulnerabilities",
      "path": "/home/user/.agents/skills/ns-analyze-vulnerabilities"
    }
  ],
  "mcpServers": [
    {
      "name": "ns-benchmark",
      "configPath": "/home/user/.claude/.mcp.json"
    }
  ]
}
```

### Harness Config Formats

**Claude Code (`~/.claude/.mcp.json`):**
```json
{
  "mcpServers": {
    "ns-benchmark": {
      "command": "node",
      "args": ["/path/to/ns-benchmark/src/mcp-entrypoint.js"],
      "env": {
        "NSOLID_SERVICE_TOKEN": "<token>",
        "NSOLID_ORG_ID": "<orgId>"
      }
    }
  }
}
```

**Codex CLI (`~/.codex/config.toml`):**
```toml
[mcp_servers.ns-benchmark]
command = "node"
args = ["/path/to/ns-benchmark/src/mcp-entrypoint.js"]
env = { NSOLID_SERVICE_TOKEN = "<token>", NSOLID_ORG_ID = "<orgId>" }
```

**OpenCode (`~/.config/opencode/opencode.jsonc`):**
```jsonc
{
  "mcpServers": {
    "ns-benchmark": {
      "command": "node",
      "args": ["/path/to/ns-benchmark/src/mcp-entrypoint.js"],
      "env": {
        "NSOLID_SERVICE_TOKEN": "<token>",
        "NSOLID_ORG_ID": "<orgId>"
      }
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
4. **Permission denied**: Report specific file/path, suggest `sudo` or permission fix

### Uninstall Errors

1. **Missing tracking file**: Best-effort cleanup of known NodeSource artifacts, warn user
2. **Partial uninstall**: Report which artifacts remain, provide manual cleanup instructions
3. **Permission denied**: Report specific files, suggest manual deletion with `sudo`

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
- Pi Agent uses `~/.pi/skills/` but can symlink from `~/.agents/`
- Single source of truth for skill content
- Harness adapters create symlinks/copies as needed

### Why JSON for credentials and tracking?

**Alternatives considered:**
1. **YAML**: Rejected - requires parser dependency
2. **TOML**: Rejected - not universally supported in Node.js
3. **JSON**: Chosen - native support, simple, sufficient for this use case

### Why post-install hooks?

**Rationale:**
- All marketplaces support npm packages
- `postinstall` runs automatically after package download
- No user action required beyond marketplace install
- Works for both CLI and GUI marketplace interfaces

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
