# Release Versioning Specification

## ADDED Requirements

### Requirement: Atomic release version preparation

Release tooling SHALL accept `patch`, `minor`, `major`, or an explicit increasing semantic version and propagate it across source packages and generated version-bearing manifests without publishing or Git mutation.

#### Scenario: Prepare a patch release

**Given** every controlled version is synchronized at a valid stable semantic version
**And** the working tree contains the intended release changes
**When** the maintainer runs the release preparation command with `patch`
**Then** the command computes the next patch version
**And** writes it to `bundle.json`, `packages/core/package.json`, and `packages/pi-plugin/package.json`
**And** synchronizes `packages/core/bundle.json`
**And** regenerates `.claude-plugin/marketplace.json`, `.claude-plugin/plugin.json`, and `.codex-plugin/plugin.json`
**And** leaves manifests without an explicit version field schema-valid
**And** prints the resulting version and changed files

#### Scenario: Prepare a minor or major release

**Given** every controlled version is synchronized at a valid stable semantic version
**When** the maintainer runs the release preparation command with `minor` or `major`
**Then** the command increments the requested semantic-version component
**And** resets lower-order components to zero
**And** propagates the resulting version to every controlled version-bearing file
**And** refreshes generated manifests through existing generators

#### Scenario: Prepare an explicit semantic version

**Given** the maintainer supplies a version greater than the current stable version
**When** release preparation runs
**Then** the exact supplied version is propagated to every controlled version-bearing file
**And** generated manifests are refreshed through existing generators
**And** no unrelated source file is modified

#### Scenario: Release preparation has no external side effects

**Given** release preparation succeeds
**When** the command completes
**Then** it has not committed, tagged, pushed, packed, published, authenticated, or contacted a package registry
**And** package-local materialized skill directories are absent
**And** the maintainer can review the Git diff before external release actions

#### Scenario: Reject invalid or non-incrementing versions

**Given** the requested version is invalid, equal to the current version, or lower
**When** release preparation validates the request
**Then** it fails before writing any file
**And** identifies the invalid current/requested relationship
**And** leaves the working tree unchanged

#### Scenario: Atomic release preparation failure

**Given** the requested version is valid
**When** writing or generation fails after preparation starts
**Then** every controlled file is restored to its pre-command content
**And** the command exits non-zero
**And** reports the failing stage
**And** no partially synchronized release remains

### Requirement: Release version drift detection

Release checking SHALL compare every controlled version and generated artifact with canonical `bundle.json.version` without repairing in check mode.

#### Scenario: Check synchronized release versions

**Given** the repository contains source and generated release metadata
**When** the maintainer runs the release version check
**Then** it compares package and generated versions with `bundle.json.version`
**And** validates root manifests against existing generators
**And** validates `packages/core/bundle.json` against the root bundle
**And** succeeds only when every controlled value and artifact is synchronized

#### Scenario: Release version drift is detected

**Given** one or more controlled files contain a different version or stale content
**When** the release version check runs
**Then** it exits non-zero
**And** lists every drifted file with expected and actual versions when available
**And** recommends preparation or synchronization
**And** does not repair files

### Requirement: Plugin payload changes require an update-visible version

Release checking SHALL reject payload changes whose explicit bundle version still matches the most recent release tag.

Release mode SHALL be activated only by `pnpm release:check --release`. For this comparison, “plugin payload files” is the following explicit allowlist:

- `skills/**`
- `bundle.json`
- `.claude-plugin/marketplace.json`
- `.claude-plugin/plugin.json`
- `.agents/plugins/marketplace.json`
- `.codex-plugin/plugin.json`
- `.claude-mcp.json`
- `.mcp.json`
- `plugin.json`
- `mcp_config.json`
- `scripts/mcp-wrapper.js`

#### Scenario: Skill changes retain the previous release version

**Given** committed plugin payload files differ from the most recent release tag
**And** `bundle.json.version` still equals the version represented by that tag
**When** the maintainer runs `pnpm release:check --release`
**Then** it fails with guidance to prepare a new semantic version
**And** prevents a release that version-keyed harness caches would treat as unchanged

### Requirement: Manual publication remains ordered and external

Release preparation SHALL leave publication to the maintainer while defining the required package and Git ordering.

#### Scenario: Manual publication order

**Given** preparation and quality checks succeeded
**When** the maintainer performs the external release
**Then** `nsolid-plugin@<version>` is published before `nsolid-pi-plugin@<version>`
**And** Pi resolves its `workspace:*` dependency to the same core version
**And** the commit and tag containing generated root manifests are pushed
**And** publication remains outside the preparation command

#### Scenario: Interrupted package materialization is cleaned

**Given** pack or publish materialized package-local skills
**When** publication is interrupted or only one package completes
**Then** the existing cleanup command removes `packages/core/skills/` and `packages/pi-plugin/skills/`
**And** canonical root `skills/` remains unchanged

### Requirement: Preserve canonical release boundaries

Release tooling SHALL keep root skills/bundle canonical and exclude non-release metadata from version synchronization.

#### Scenario: Preserve canonical and private package state

**Given** release preparation or checking runs
**When** it evaluates controlled files
**Then** root `skills/` and `bundle.json` remain canonical
**And** existing generators remain the writers of generated manifests
**And** Antigravity metadata remains schema-valid while staged `bundle.json` carries its version
**And** the private workspace root package remains `0.0.0`
**And** existing plugin and bundle synchronization commands remain available
