# Pi Agent MCP Support

## Status

Delta spec for `cross-harness-plugin-installer`. Adds MCP configuration support for Pi Agent by writing a Pi-owned MCP config file consumed by a third-party Pi MCP adapter extension. Pi does not natively support MCP, so an adapter extension is required for the configuration to become usable.

## MODIFIED Requirements

### Requirement: Per-Harness Configuration Mapping

#### Scenario: Pi Agent configuration

**Given** the user installs the Pi package via `pi install npm:@nodesource/pi-plugin`
**When** the package loads
**Then** the `pi.extensions` entrypoint (`index.js`) runs `core.install()` with `NSOLID_HARNESS=pi`
**And** the OAuth flow runs if no valid credentials exist
**And** skills are copied to `~/.agents/skills/` and linked to `~/.pi/agent/skills/`
**And** MCP configuration is written to `~/.pi/agent/mcp.json` using the standard `mcpServers` format with `url` and `headers`
**And** the MCP configuration uses the same three server entries as the other harnesses: `nsolid-console`, `ns-benchmark`, and `ncm`
**And** a tracking file entry is created for Pi
**And** the user is informed that Pi requires an additional MCP adapter extension (such as `pi-mcp-adapter` or `@0xkobold/pi-mcp`) to use the configured MCP servers

### Requirement: Uninstall Flow

#### Scenario: Clean uninstall via marketplace UI

No changes to the existing scenario, but the list of harness config files from which NodeSource MCP entries are removed SHALL include `~/.pi/agent/mcp.json`.

#### Scenario: Best-effort cleanup with missing tracking file

No changes to the existing scenario, but the list of harness config files scanned for MCP entries named `nsolid-console`, `ns-benchmark`, or `ncm` SHALL include `~/.pi/agent/mcp.json`.

## ADDED Requirements

### Requirement: Pi MCP Adapter Dependency Documentation

The project SHALL document that Pi Agent does not natively support MCP and that users must install a separate MCP adapter extension to consume the NodeSource MCP configuration.

#### Scenario: README documents the adapter requirement

**Given** a Pi user reads the project README or the Pi plugin README
**When** they follow the Pi installation instructions
**Then** they see a clear note that `@nodesource/pi-plugin` writes `~/.pi/agent/mcp.json`
**And** they see instructions to install one of the supported MCP adapter extensions, such as `pi-mcp-adapter` or `@0xkobold/pi-mcp`
**And** they understand that without the adapter the MCP-backed skills will not have working tools

#### Scenario: Supported adapter configurations

**Given** the `pi-mcp-adapter` extension is installed
**When** it reads its configuration sources
**Then** it discovers the NodeSource MCP servers in `~/.pi/agent/mcp.json`
**And** the servers use standard `url` and `headers` fields
**And** no additional user configuration is required beyond installing `pi-mcp-adapter`

#### Scenario: Alternative adapter requires separate configuration

**Given** the `@0xkobold/pi-mcp` extension is installed instead of `pi-mcp-adapter`
**When** it reads its configuration sources
**Then** it reads `~/.0xkobold/mcp.json` in a `servers[]` format rather than `~/.pi/agent/mcp.json`
**And** the NodeSource MCP servers are not discovered automatically
**And** the user must configure `~/.0xkobold/mcp.json` manually if they choose this adapter

## REMOVED Requirements

_None._

## RENAMED Requirements

_None._
