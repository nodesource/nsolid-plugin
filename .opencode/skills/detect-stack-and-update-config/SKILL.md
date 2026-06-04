---
name: detect-stack-and-update-config
description: "Trigger: detect stack, detect project, update config. Inspects project files to detect tech stack, test runner, linter, type checker, build system and testing capabilities. Updates openspec/config.yaml context and rules with the detected information. Run after init or when project tooling changes."
---

## Activation Contract

Run when the user asks to detect the project stack, update config, or after `ns-opencode init`. Do the detection yourself and update openspec/config.yaml with the findings.

## Execution Steps

### 1. Inspect project files

Scan for these files and parse accordingly:

| File | Stack | Detectable fields |
|------|-------|-------------------|
| `package.json` | Node.js | test script, lint script, typecheck script, format script, framework (react/vue/angular/next) |
| `go.mod` | Go | module name |
| `Cargo.toml` | Rust | — |
| `pyproject.toml` | Python | test/lint config |
| `CMakeLists.txt` | C/C++ | — |
| `tsconfig.json` | TypeScript | strict mode |
| `.github/workflows/*.yml` | CI | test/lint commands |

### 2. Detect testing capabilities

| Capability | Detection |
|-----------|-----------|
| Test runner | `package.json` scripts → vitest, jest, mocha, ava, tap, node --test. Or `pytest.ini`, `go.mod`, `Cargo.toml`, etc. |
| Test layers | Check for `@testing-library`, `playwright`, `cypress`, `httptest`, `pytest-cov` |
| Coverage | `vitest --coverage`, `jest --coverage`, `nyc`, `c8`, `pytest-cov`, `go test -cover` |
| Linter | `eslint`, `rome`, `biome`, `ruff`, `flake8`, `clippy`, `golangci-lint`, `rubocop` |
| Type checker | `typescript`, `mypy`, `pyright` |
| Formatter | `prettier`, `black`, `rustfmt`, `gofmt`, `dart format` |

### 3. Read existing openspec/config.yaml

Read the project's `openspec/config.yaml`. If it doesn't exist, abort with a message.

### 4. Generate update

Build a context block with the detected info. Structure:

```
Tech stack: {stack} ({details})
Testing: {test_runner} ({coverage_command})
Linting: {linter}
Type checking: {type_checker}
Build system: {build_system}
Package manager: {package_manager}
```

Update the `context:` section in the YAML. Also update/add relevant rules sections (`testing:`, `quality:`) with detected commands.

### 5. Write updated config

Write the modified YAML back to `openspec/config.yaml`.

### 6. Return summary

Return what was detected and what changed in the config.

## Output Contract

Return `status`, `detected_stack`, `testing_capabilities` (table), `quality_tools` (table), `config_updated` (which sections changed), and `risks` (anything that couldn't be detected).

## Hard Rules

- Never guess — if you can't detect something, note it as "not detected"
- Preserve all existing YAML structure and rules when updating
- Only update `context:`, `testing:`, and `quality:` sections — leave everything else intact
- If `openspec/config.yaml` uses a custom schema (e.g. `schema: ns-workflow`), respect it
- Parse YAML correctly — do not corrupt existing content
- Validate the output is valid YAML before writing