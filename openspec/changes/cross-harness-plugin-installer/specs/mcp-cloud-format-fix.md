# MCP Cloud Format Fix

## Status

Delta spec for `cross-harness-plugin-installer`. Applies changes to the main `installation-and-auth` capability spec. The MCP servers are cloud endpoints accessed via Streamable HTTP, not local stdio processes.

---

## MODIFIED Requirements

### Requirement: Per-Harness Configuration Mapping

Installation SHALL produce harness-specific MCP configurations using URL-based (Streamable HTTP) transport with auth tokens in HTTP headers. The three MCP servers are cloud endpoints:

| Server | URL | Auth headers |
|---|---|---|
| `nsolid-console` | `${MCP_URL}` (derived from `consoleUrl`) | `X-Nsolid-Service-Token` |
| `ns-benchmark` | `https://benchmark.mcp.saas.nodesource.io/mcp` | `X-Nsolid-Org-Id`, `X-Nsolid-Service-Token` |
| `ncm` | `https://mcp.ncm.nodesource.com` | `X-Nsolid-Service-Token` |

The `${MCP_URL}` variable is derived from the stored `consoleUrl` credential using the pattern: `consoleUrl.replace('.saas.', '.mcp.saas.')`. For example, `https://0708a5c9-7147-4791-88f8-091ac2f48af8.saas.nodesource.io` becomes `https://0708a5c9-7147-4791-88f8-091ac2f48af8.mcp.saas.nodesource.io`.

Server names are `nsolid-console` (not `nsolid-mcp`) and `ncm` (not `ncm-mcp`).

#### Scenario: Claude Code configuration

**Given** the user installs the Claude Code plugin
**When** MCP configurations are written
**Then** entries are added to `~/.claude.json`:
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
**And** skills are symlinked (Unix) or junction-linked/copied (Windows) to `~/.claude/skills/`

#### Scenario: Codex CLI configuration

**Given** the user installs the Codex plugin
**When** MCP configurations are written
**Then** entries are added to `~/.codex/config.toml`:
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
**And** skills are symlinked (Unix) or junction-linked/copied (Windows) to `~/.codex/skills/`

#### Scenario: OpenCode configuration

**Given** the user installs the OpenCode plugin
**When** MCP configurations are written
**Then** entries are added to `~/.config/opencode/opencode.jsonc`:
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
**And** skills are symlinked (Unix) or junction-linked/copied (Windows) to `~/.config/opencode/skills/`

#### Scenario: Antigravity CLI configuration

**Given** the user runs the Antigravity install script
**When** `core.install()` writes the MCP configuration
**Then** entries are added to `~/.gemini/config/mcp_config.json`:
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
**And** Antigravity uses `serverUrl` (not `url`) as the URL field name per its config schema
**And** skills are linked/copied to `~/.gemini/config/skills/`

#### Scenario: Pi Agent configuration

**Given** the user installs the Pi package via `pi install npm:@nodesource/pi-plugin`
**When** the package loads
**Then** no MCP configuration is written because Pi does not support MCP in the current version

### Requirement: MCP URL Derivation

The plugin SHALL derive the MCP server URL for the `nsolid-console` server from the stored `consoleUrl` credential.

#### Scenario: MCP URL construction

**Given** a `consoleUrl` value stored in `~/.agents/.nodesource-auth.json`
**When** MCP configurations are written
**Then** `mcpUrl` is derived as `consoleUrl.replace('.saas.', '.mcp.saas.')`
**And** the derived URL is used as the `url` (or `serverUrl` for Antigravity) of the `nsolid-console` MCP server entry
**And** this URL is stored in credentials as `mcpUrl` for reuse

### Requirement: Uninstall Flow (MCP entry names)

The uninstaller SHALL remove MCP entries named `nsolid-console`, `ns-benchmark`, and `ncm` from harness config files.

#### Scenario: Best-effort cleanup MCP entry names

**Given** the uninstaller performs best-effort cleanup without a tracking file
**When** scanning harness config files for NodeSource MCP entries
**Then** it removes entries named `nsolid-console`, `ns-benchmark`, and `ncm`
**And** it does NOT search for the old names `nsolid-mcp` or `ncm-mcp`

---

## ADDED Requirements

_None._

## REMOVED Requirements

_None._

## RENAMED Requirements

_None._
