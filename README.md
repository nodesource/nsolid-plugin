# nsolid-plugin

Cross-harness plugin installer for NodeSource AI skills and MCP servers.

## Architecture

Shared core + marketplace wrappers. A single monorepo contains the shared installation logic, while each marketplace gets its own package with native manifest format.

### Structure

```text
nsolid-plugin/
├── packages/
│   ├── core/              # Shared installation logic
│   ├── claude-plugin/     # Claude Code marketplace package
│   ├── codex-plugin/      # Codex CLI marketplace package
│   ├── opencode-plugin/   # OpenCode marketplace package
│   ├── antigravity-plugin/# Antigravity CLI marketplace package
│   └── pi-plugin/         # Pi Agent marketplace package (skills only)
├── bundle.json            # Canonical bundle descriptor
└── package.json           # Workspace root
```

## Development

```bash
pnpm install
pnpm run build
pnpm test
```

## License

Apache-2.0