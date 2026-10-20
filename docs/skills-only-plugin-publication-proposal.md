# Proposal: a phased N|Solid skills-only publication experiment

**Status:** proposed; research completed, implementation and submission pending.

**Evidence checked:** September 10, 2026.

**Decision requested:** approve a minimal Claude Community submission first; evaluate optional CLI/MCP integration separately.

## 1. Executive summary — discussion points

1. **The distribution pattern already exists.** Approved Community plugins deliver skills while users install or configure external MCP servers and authenticated CLIs separately. jambonz is the clearest separate-MCP-registration example; You.com, Preset, CodeRabbit, and Endor Labs provide complementary authentication/CLI evidence.
2. **Test the smallest useful package, not a repository migration.** Produce one self-contained Claude skills artifact in this repository. A separate CLI repository, OAuth changes, and other harnesses are not prerequisites.
3. **Separate two questions.** Can a useful N|Solid skills-only artifact be listed? Can that listing also support optional authenticated MCP access through a separately installed CLI? The first can be tested before implementing the second.
4. **The boundary is explicit installation, not hidden dependencies.** The plugin must not register or start MCP servers automatically. Skills may openly describe external servers, URLs, authentication, and setup instructions. This is not an exemption from security review.
5. **Publish evidence, not promises.** Validate the exact artifact, test a clean installation, submit through the documented form, and capture the response. Approval is not guaranteed, and the original rejection reason still needs to be attached verbatim.

**Recommended meeting decision:** approve Phases 0–2 below, appoint an implementation owner and a submission owner, and agree that a useful non-authenticated first release is acceptable. Phase 3 is a separately estimated extension, not a blocker for the first submission.

## 2. Objective, hypotheses, and limits

The objective is inclusion in Anthropic's [Claude Community catalog](https://github.com/anthropics/claude-plugins-community), not merely publishing a company marketplace or submitting a remote connector to a different directory.

| Question | Experiment | What a positive result establishes |
| --- | --- | --- |
| **H1: listing feasibility** | Submit a useful N|Solid skills-only artifact with no bundled authenticated runtime. | This particular skills artifact can be listed. |
| **H2: optional live integration** | Add transparent instructions for a separately installed CLI that authenticates and registers external MCP wrappers; test and submit that update. | This particular external-CLI/MCP arrangement can be distributed with the skills. |

H1 acceptance does **not** prove H2, explain the previous rejection, or establish that OAuth is unnecessary for every future integration. The original submission, artifact SHA, date, validation results, and exact reviewer feedback should be collected before drawing causal conclusions. Missing historical feedback need not block a clean H1 experiment, but the uncertainty must remain explicit.

The Community repository serves **Claude Cowork and Claude Code**. Initial functional validation targets **local Claude Code**. Neither catalog presence nor a local CLI setup proves that credentials, executables, or MCP access work in Cowork or cloud-hosted sessions. Do not advertise untested runtime support.

## 3. Evidence supporting the experiment

The examples below were checked at the **commits pinned in the official Community catalog**, not merely their current default branches. Presence in that catalog is evidence of approved distribution; it does not reveal the private review rationale.

| Approved example | Verified pattern | Relevance and limit |
| --- | --- | --- |
| **[jambonz-skills](https://github.com/jambonz/skills/blob/82ee0b69c88854ab7980b9042d78a3086e6b9176/skills/jambonz-setup-mcp/SKILL.md)** | Skills and documentation, no bundled MCP registration. Setup skill explicitly uses `claude mcp add jambonz -- npx -y @jambonz/mcp-schema-server`. | Closest packaging precedent: install skills and MCP separately. Does not demonstrate N|Solid-style authenticated wrappers. |
| **[You.com](https://github.com/youdotcom-oss/agent-skills/blob/2ed83558991da7d09e5880fe2d119002bbcf060b/skills/you-web/SKILL.md)** | No Claude plugin MCP registration; skill requires an externally connected MCP, describes API-key/OAuth options, and requires approval before configuration changes. | Supports transparent authenticated MCP prerequisites. Not a vendor-CLI/stdio registration example. |
| **[Preset CLI Skills](https://github.com/preset-io/agent-skills/blob/8387ac0f0538271c79a2e227c7ddec084e8a5da3/plugins/preset-cli-skills/skills/preset-cli/references/install-and-auth.md)** | Separate `superset-sup` installation and interactive `sup config auth`; optional local credential storage. Plugin is a catalog-listed monorepo subdirectory. | Supports external authenticated CLI workflows and avoiding an immediate repository split. Does not install MCP. |
| **[CodeRabbit](https://github.com/coderabbitai/skills/blob/bbb4ab25a7f1d426062d83fe8fdf406beeecd0cb/skills/code-review/SKILL.md)** | Metadata-only Claude manifest; skill checks CLI/auth readiness and uses `coderabbit review --agent`. | Supports separately authenticated CLI dependencies. Not an MCP installer. |
| **[Endor Labs](https://github.com/endorlabs/ai-plugins/blob/975f0ce422b1f2677681ffd085aef34ea1826b70/README.md)** | Metadata-only Claude manifest; setup uses `endorctl` with browser OAuth or API key and secret. | Supports authenticated external tooling, not acceptance of N|Solid's exact service-token model. |
| **[Pencil community skill](https://github.com/Nisus74/pencil-skill/blob/28ec61cefe3000a59bdac6b98b83168dbacca9c8/skills/pencil-design/references/pencil-cli.md)** | No plugin MCP registration or startup hooks; reference describes external CLI installation, login, and an interactive MCP runtime. | Close conceptual analogy, but CLI behavior was verified as published instructions, not executed or independently certified against the vendor binary. |

AccelByte remains a packaging comparison, **not** the principal skills-only Claude precedent: its [approved Claude manifest](https://github.com/AccelByte/ai-plugins/blob/81c40c3edff1c292c60a100a7a15badb65eaf731/.claude-plugin/plugin.json) includes inline HTTP MCP registration.

### What official documentation establishes

- [Plugin documentation](https://code.claude.com/docs/en/plugins) documents community submission, local validation, automated safety screening, and approved commit pins.
- [Marketplace documentation](https://code.claude.com/docs/en/plugin-marketplaces) supports self-contained plugin subdirectories and `git-subdir` sources. A separate source repository is not a technical prerequisite; confirm the intended artifact path in the submission form.
- [MCP documentation](https://code.claude.com/docs/en/mcp) supports non-OAuth authentication through `headersHelper`. That is a client capability, **not a marketplace policy waiver**.
- No inspected official page establishes a blanket OAuth requirement for every community plugin, or a blanket review exemption for skills using external authenticated tools. The internal screening rubric was not available in full.

**Appendix A** records the supporting evidence in detail: how the examples were verified, their pinned commits, exact setup commands, and the candidates that were screened and excluded.

## 4. Minimum viable submission

### Recommended first artifact

Ship **one useful, read-only Node.js upgrade-readiness skill**, working name `ns-node-upgrade-readiness`, plus its references, Claude manifest, and concise installation/support documentation.

This is a **new reduced-scope workflow to implement**, not a claim that an existing skill already works unchanged without dependencies. Reuse relevant guidance from `ns-node-upgrade`, but do not copy its complete workflow: the current skill runs a release-data helper and requests NCM dependency information.

The first skill should inspect user-provided/local project files and produce:

- declared Node.js versions from `package.json`, `.nvmrc`, and `.node-version`, including conflicts;
- package-manager and lockfile evidence;
- an inventory of declared direct dependencies and an upgrade-readiness checklist;
- a clear list of facts not verified, including current release lifecycle and target-version dependency compatibility.

It must not claim the latest supported Node version or dependency compatibility without evidence. It should not run installation, application code, tests, or migrations; modify files; access Accounts; read credentials; or call NCM/MCP. A useful result is a concrete readiness report, not only “install our CLI.”

**If the team considers this scope insufficiently valuable, choose another bounded workflow before implementation.** Do not ship an empty setup-only placeholder just to obtain a listing. This usefulness requirement is our product choice, not a proven universal marketplace rule.

### Artifact boundary

| Included in H1 | Excluded from H1 |
| --- | --- |
| One canonical skill and required static references | Plugin MCP registrations, wrappers, or remote connection helpers |
| Claude metadata, README, license, supported-runtime statement | Startup hooks, automatic dependency installation, credential reads |
| Honest explanation that live N|Solid access is not provided in this version | Accounts login, tokens, API calls, or unimplemented setup commands presented as available |

The README may describe the planned optional integration, explicitly labeled as future work. Do not omit material dependencies from reviewer-facing documentation. For H2, endpoint and setup references are allowed; actual credentials and automatic plugin-owned registration are not.

### Keep the repository intact

Proposed layout, to be created during implementation:

```text
skills/ns-node-upgrade-readiness/          canonical new skill
plugins/nsolid-skills/                    generated, self-contained Claude artifact
  .claude-plugin/plugin.json
  skills/ns-node-upgrade-readiness/
  README.md
  LICENSE
packages/core/                           existing CLI remains here
```

Use the existing generation approach where practical; maintain one canonical source, not two hand-edited skill copies. The artifact must work from the plugin cache without reaching outside its own directory. Leave the current root integration and secondary-harness manifests unchanged. Confirm the final catalog/plugin name and selected source path before submission, including how it relates to the existing submission.

## 5. Phased plan — fastest useful evidence first

Timeboxes below are **planning limits for focused work, not delivery promises**. Marketplace review time is external. If a phase exceeds its budget, reduce scope or return with a blocker; do not silently expand the experiment.

| Phase | Work and deliverable | Exit gate | Initial timebox |
| --- | --- | --- | --- |
| **0 — Confirm the experiment** | Collect prior feedback if available; agree H1 scope, plugin identity, source path, owners, and submission access. | H1/H2 distinction and unresolved rejection cause recorded; one workflow selected. | 30–60 minutes |
| **1 — Build and test H1** | Implement the reduced skill, isolated artifact, representative project fixtures, and an artifact inventory. | Local validation and clean-install checks below pass; no live-service dependency. | One focused engineering day, reassess if exceeded |
| **2 — Submit H1** | Submit exact candidate; capture submission ID, SHA, validator version/output, supported runtime, and reviewer-facing description. | Submission acknowledged; follow-up owner assigned. | Same-day submission once Phase 1 passes; review duration unknown |
| **3 — Optional live-data experiment** | Estimate and implement the minimum external-CLI setup path, then test and submit the H2 update transparently. | Live integration matrix passes and change is explicitly submitted for review. | Estimate after a bounded CLI/package inspection; not included in Phase 1 |
| **4 — Expand only with evidence** | Additional skills, cross-harness parity, release automation, or repository separation if justified. | Separate scope/ownership decision using screening and usage feedback. | Outside this experiment |

Do not overwrite the submitted H1 candidate with H2 changes while waiting for feedback. Preserve an identifiable H1 artifact and SHA. Phase 3 discovery may run in parallel with review, but shipping it requires its own gate.

### Phase 1: minimal validation matrix

1. **Package validation:** run `claude plugin validate <artifact> --strict`; record Claude version and output. Inspect the complete installable tree for MCP files, hooks, executables, package lifecycle scripts, secrets, and accidental dependencies. A clean manifest alone is insufficient.
2. **Distribution test:** install from the intended marketplace/source path into an isolated Claude profile and trusted fixture workspace, not only through a development `--plugin-dir` load. Verify all references resolve from the installed cache.
3. **Useful result:** test a project with consistent Node declarations, one with conflicting declarations, and one without a declared version. Check the report against the fixture facts, not just whether the skill loads.
4. **No integration side effects:** with no N|Solid CLI, credentials, or MCP configuration, verify the workflow completes without requesting Accounts access or registering servers. Compare relevant configuration and workspace files before/after; do not mistake ordinary Claude client network activity for a plugin API call.
5. **Honest limitations and cleanup:** verify unconfirmed release/compatibility facts are labeled, no live access is promised, and removing the candidate leaves existing integrations untouched.

These are planned checks; none is claimed to have passed yet. A documentation-only proposal update does not constitute a validated plugin.

## 6. Phase 3: external CLI/MCP integration, without backend authentication changes

### Proposed user flow

```text
skills installed -> useful non-authenticated workflow available
user explicitly requests live N|Solid data
  -> check required MCP tools
  -> if unavailable, explain external CLI dependency and request consent
  -> user installs the documented CLI release and runs setup
  -> reuse valid Accounts credentials or authenticate explicitly
  -> select registration scope and confirm configuration changes
  -> register CLI-owned stdio wrappers; verify tools after reload
```

Preserve `nsolid-plugin setup --harness claude` as the intended entry point, but **do not document it as completing this flow until a released version actually does so**. Pin a minimum supported CLI version. Wrappers must be owned by the separately installed CLI package, not referenced from an uninstallable plugin cache.

### Findings that must be addressed before reusing existing code

| Current repository fact | Required H2 work |
| --- | --- |
| [`setup()`](../packages/core/src/index.ts) currently stops after authentication for Claude/Codex/Antigravity. | Add explicit registration behavior for the new Claude path without regressing existing integrations. |
| [`bundle.json`](../bundle.json) defines remote URLs and token headers; `install()` expands credentials and passes them to the [config writer](../packages/core/src/mcp/mcp-config-writer.ts). | Do not simply call the existing installer. Define stdio descriptors containing only stable executable commands/arguments; prove no token serialization. |
| [`ns-audit-dependencies`](../skills/ns-audit-dependencies/audit-dependencies.cjs) reads shared credentials and calls the NCM API. | Exclude it from H1. Before later inclusion, move authenticated execution behind the CLI or explicitly disclose and review that behavior. Audit other retained helpers too. |
| Existing wrappers read shared Accounts credentials. | Preserve that authentication contract where appropriate; validate credential permissions, redacted errors, reuse/expiry, and organization selection. |

### Scope and safety contract

Claude distinguishes [three scopes](https://code.claude.com/docs/en/mcp#mcp-installation-scopes):

- **`local`:** current project, private to the user, stored in the per-project structure of `~/.claude.json`. Recommended first supported scope.
- **`project`:** shareable repository `.mcp.json`; require explicit consent before writing.
- **`user`:** all the user's projects through `~/.claude.json`; explicitly opt-in.

To keep H2 small, implement and test `local` first if practical; other scopes can follow. If only another scope is feasible initially, record that decision and require explicit user consent. Never silently substitute a broader scope. CLI flags are proposed, not existing functionality.

H2 must preserve unrelated configuration, refuse conflicting user-owned registrations unless migration is explicitly approved, be idempotent, and offer targeted removal. Plugin uninstall must not unexpectedly delete separately installed CLI registrations or shared credentials; explain the separate removal step.

**H2 gate:** test fresh/reused/expired authentication; selected scope; repeat setup; no secrets in generated config/logs/new backups; old plugin coexistence or explicit migration; changed MCP tool names; stable wrapper paths; targeted removal; and one real tool invocation for each of the three promised servers. Run affected CLI/configuration tests. Do not claim all-server support until all three pass. Existing backups containing secrets require careful handling, not automatic copying or deletion.

## 7. Submission, measurements, and response handling

Use one of the [documented submission forms](https://code.claude.com/docs/en/plugins):

- [claude.ai form](https://claude.ai/admin-settings/directory/submissions/plugins/new): documented as requiring Team/Enterprise directory-management access.
- [Console form](https://platform.claude.com/plugins/submit): documented alternative for individual authors.

The Community repository is a read-only mirror; direct PRs are not the submission route. Provide an accurate description of shipped behavior, dependencies, data access, and tested runtimes. Confirm that the form selects the intended plugin subdirectory rather than accidentally submitting the existing MCP-bearing root plugin.

Record in a release issue: owner, candidate SHA/path, plugin identity, validator version/output, clean-install evidence, submission ID/date, exact feedback, approved catalog SHA, and installation result. The public catalog syncs nightly; absence immediately after approval is not itself rejection. Approved pins can update through CI, so keep subsequent changes controlled.

| Outcome | Next action |
| --- | --- |
| H1 accepted and installable | Record listing feasibility; decide whether to proceed with H2. Do not claim the full integration is approved. |
| Feedback identifies packaging, quality, metadata, or security issues | Address the specific finding and resubmit within an agreed scope. |
| Feedback explicitly requires an authentication change for the proposed live path | Reassess H2 with the actual requirement; scope OAuth separately if necessary. |
| Submission remains pending | Follow up through the submission channel; avoid speculative architecture changes. |

**Execution success:** a validated candidate, an acknowledged submission, and captured feedback.

**H1 success:** the submitted skills artifact is approved and installable.

**H2 success:** the tested optional CLI/MCP arrangement is accepted as part of the updated listing.

## 8. Non-goals, rollback, and decisions needed

### Non-goals for the first submission

No repository split; no public CLI release dependency; no OAuth/DCR/PKCE project; no Accounts/server protocol changes; no VS Code or Console authentication changes; no new backend deployment; no Codex/Antigravity/OpenCode/Pi parity work; no claim of Cowork/cloud live-data support. Existing integrations remain untouched.

### Rollback

For H1, withdraw the candidate or revert its isolated artifact to the recorded baseline. If there is no prior approved skills release, withdraw rather than inventing a “last known-good” listing. No user MCP or credential cleanup should be needed.

For H2, provide scoped removal of only CLI-owned registrations, preserving unrelated entries and shared authentication unless the user explicitly logs out. Restore backups only when doing so cannot overwrite intervening user changes. Repository separation, if later chosen, is a separate migration with its own rollback plan.

### Decisions for this meeting

1. **Approve the useful one-skill H1 release**, or require live MCP access in the first submission? Requiring live access moves Phase 3 ahead of submission and needs a larger estimate.
2. Who owns implementation, validation, submission access, and reviewer follow-up?
3. Which plugin name/source path should be submitted, and is it an update to the prior submission or a new candidate?
4. Can the previous rejection text and submitted SHA be recovered? If not, explicitly retain the uncertainty.
5. Should a bounded H2 discovery task run while H1 is under review? Repository separation and full scope parity remain deferred.

**Recommendation:** approve the smallest useful H1 artifact now, obtain real screening feedback quickly, and treat optional authenticated CLI/MCP support as a second, evidence-backed experiment.

## Appendix A — detailed precedent evidence

### Method and evidence boundary

The examples in section 3 were verified by reading the [official Community catalog](https://github.com/anthropics/claude-plugins-community/blob/main/.claude-plugin/marketplace.json), then inspecting each finalist at the commit the catalog pins, rather than at a changing default branch. Two targeted candidate groups were screened; this was focused discovery, not an exhaustive census. Complete, non-truncated Git trees were checked for the four main examples, including their plugin subdirectory where applicable, because a metadata-only manifest does not rule out convention-based MCP configuration or hooks.

No example was installed, authenticated, or executed during this research. Catalog presence and pinned source contents were verified. Runtime correctness, private approval rationale, and acceptance of N|Solid's exact three-wrapper/service-token architecture were **not**.

“Skills-only” throughout means **no Claude-bundled MCP registration or startup hook**. It does not mean the artifact contains no prose about MCP, no URLs, or no network behavior. The repository README states that listed plugins passed automated security scanning and were approved for distribution; it does not identify which design aspect caused approval.

### jambonz-skills — direct match for separate CLI registration of an npm MCP

**Catalog name:** `jambonz-skills`. **Pinned SHA:** `82ee0b69c88854ab7980b9042d78a3086e6b9176`.

The [manifest](https://github.com/jambonz/skills/blob/82ee0b69c88854ab7980b9042d78a3086e6b9176/.claude-plugin/plugin.json) contains name, description, version, and author only. The complete 15-file tree contains skills, references, metadata, and a release workflow: no `.mcp.json`, hook registration, or MCP server implementation.

The [jambonz-setup-mcp skill](https://github.com/jambonz/skills/blob/82ee0b69c88854ab7980b9042d78a3086e6b9176/skills/jambonz-setup-mcp/SKILL.md) documents remote HTTP and local stdio, with this exact Claude registration command:

```bash
claude mcp add jambonz -- npx -y @jambonz/mcp-schema-server
```

It directs verification with `claude mcp list`, and states:

> The MCP server and the `jambonz-skills` plugin complement each other — install both.

> You can use them separately — skills alone for planning/offline work, MCP alone for one-off schema lookups [...].

**Limit:** the server exposes schemas and examples. The inspected setup does not demonstrate service-token authentication, an Accounts-style login, or a vendor CLI that owns registration of multiple wrappers; it uses the host's `claude mcp add` command. One pinned line about Codex HTTP support is outdated, so treat it as precedent evidence rather than a current setup manual.

### You.com — external authenticated MCP prerequisite without a plugin registration

**Catalog name:** `youdotcom-agent-skills`; manifest name `you`. **Pinned SHA:** `2ed83558991da7d09e5880fe2d119002bbcf060b`.

The [Claude manifest](https://github.com/youdotcom-oss/agent-skills/blob/2ed83558991da7d09e5880fe2d119002bbcf060b/.claude-plugin/plugin.json) carries metadata and no `mcpServers`. No root `.mcp.json` or Claude startup hooks were found. The repository also ships other harness-specific packages, so it should not be described as exclusively static Markdown.

The [you-web skill](https://github.com/youdotcom-oss/agent-skills/blob/2ed83558991da7d09e5880fe2d119002bbcf060b/skills/you-web/SKILL.md) states that the server “must be installed and connected before using this skill,” identifies `https://api.you.com/mcp`, and offers bearer `YDC_API_KEY`, OAuth, or an x402-aware client. It instructs the agent to name the missing capability, provide endpoints and auth options, and “request approval before installing, connecting, or changing MCP configuration.”

**Limit:** a remote MCP prerequisite, not verified vendor-CLI registration of local stdio wrappers. Its frontmatter carries descriptive `metadata.mcp_servers` and endpoint/auth details; that is not a plugin `mcpServers` registration, but it does mean the plugin openly references MCP URLs.

### Preset CLI Skills — separate CLI installation and interactive authentication

**Catalog name:** `preset-cli-skills`; **plugin subdirectory** `plugins/preset-cli-skills`; **pinned SHA:** `8387ac0f0538271c79a2e227c7ddec084e8a5da3`. The catalog entry uses a `git-subdir` source.

The plugin manifest has no MCP declaration, and the inspected plugin subtree has no MCP registration or hooks. The [installation and authentication reference](https://github.com/preset-io/agent-skills/blob/8387ac0f0538271c79a2e227c7ddec084e8a5da3/plugins/preset-cli-skills/skills/preset-cli/references/install-and-auth.md) prescribes:

```bash
pip install superset-sup
sup --version
sup config auth
```

It describes interactive token/secret prompts, credential testing, optional storage in `~/.sup/config.yml` or environment variables, and explicitly forbids passing secrets inline on the command line.

**Limit:** this is a CLI workflow, not installation of an MCP. The same repository contains a separate MCP-skills package, but this finding does not claim that sibling package is independently listed in the Community catalog.

### Pencil — skills plus external MCP, with a documented authenticated CLI path

**Catalog name:** `pencil-dev-skill`. **Pinned SHA:** `28ec61cefe3000a59bdac6b98b83168dbacca9c8`. The publishing repository is `Nisus74/pencil-skill`, not established here as an official Pencil-owned repository.

The manifest has no MCP registration and the complete Git tree has no MCP JSON registration or hooks directory. The [CLI reference](https://github.com/Nisus74/pencil-skill/blob/28ec61cefe3000a59bdac6b98b83168dbacca9c8/skills/pencil-design/references/pencil-cli.md) instructs `npm install -g @pencil.dev/cli`, `pencil status`, `pencil login`, and `pencil interactive`; it describes browser login, a separate credential file at `~/.pencil/session-cli.json`, and states that inside the interactive shell “the same MCP server runs that the desktop app launches.”

**Limit:** verified as published instructions, not tested against the vendor binary. It does not demonstrate a `setup` command that writes Claude registrations.

### Screened candidates and exclusions

- **analytics-skills** (`clamp-sh/analytics-skills`, pinned `b9e06c5131a6060114e68893bc34fc77b65a9552`): no manifest/root MCP registration or hook files in the inspected tree. Its README describes platform-neutral skills with provider-specific MCP tool maps. Supporting evidence for skills that reference existing tools, not a demonstrated CLI installation flow.
- **mcpa** is catalog-listed and explicitly wraps `claude mcp add`, but its pinned subtree contains `commands/add.md` and `hooks/hooks.json`. **Not** a strict skills-only example.
- **Unreal Engine Skills for Claude Code** is catalog-listed and uses an externally running editor MCP, but includes a SessionStart hook. **Not** a strict skills-only example.
- **Appwrite, Prisma, PlanetScale, MongoDB, Supabase, and Neon** had MCP registration in the manifest and/or a root MCP file in the screened source. They are not evidence for the no-bundled-MCP boundary.
- **AccelByte** is a packaging comparison only: its approved Claude manifest includes `userConfig` and inline HTTP `mcpServers`.
- **Numeric's** catalog-pinned README redirects to a relocated repository, so it was not used as a main precedent to avoid conflating the approved artifact with a new repository.
