# Changelog

All notable changes to this project will be documented in this file.

## [Unreleased]

### Added
- **MCP control surface**: `anvil mcp` serves `doctor`, `plan` and `crew status` to MCP clients over stdio, using newline-delimited JSON-RPC 2.0. Each tool call runs the same CLI command with `--json` and returns its payload, so a tool result and a terminal result are built from the same report. See [ADR-0011](docs/adr/0011-mcp-for-the-control-surface.md).
- **Agent-config rot rule**: `anvil doctor` now reports stale references in `.opencode/commands`, agent skills and `opencode.json` instructions — deleted npm scripts, moved Markdown links, and instruction globs that match nothing.
- **Browser test runners**: Playwright and Cypress configs are detected as real test runners, and `anvil doctor` / `anvil profile` now label every detected runner as `primary` or `candidate` instead of hiding the runners a repository did not choose.
- **Eval matrix and gate**: `npm run eval` now covers `tiny`/`medium` repositories across `code-change`/`verify-only` tasks, supports a small/frontier model pair, `--list`, `--fake-agent`, `--write-baseline` and `npm run eval:check`. Results record the model, opencode version, scenario and fixture hashes, and verify exit codes.
- **Push guard**: `anvil claim` installs a per-worktree `pre-push` hook that refuses every push unless `ANVIL_SHIP=1`; only `anvil ship` sets that marker. The guard chains the repository's existing hooks and is scoped with `extensions.worktreeConfig`, so it never blocks the main worktree.
- **Untrusted ticket framing**: context bundles fence the task, acceptance criteria, links and discussion as untrusted data, and quote instruction-like ticket lines as evidence. `claim` and `issue pull` report the findings in text and JSON without removing the text from the task.
- **Provider test seam**: `GhOptions.runGit` lets a test assert the ship marker and push argv without a remote.
- **Claim provenance**: a claim now records the `opencode` version that will run it, alongside the runner path, so a result can be reproduced later.
- **Worktree resource shortlist**: `anvil claim`, `anvil crew up` and `anvil issue refresh` rank up to five optional resources for the ticket and write them into `.anvil/ticket.md`, each labelled by who publishes it (`installed locally`, `official publisher`, `third party`). Nothing is installed or run. See [ADR-0014](docs/adr/0014-optional-resources-in-the-worktree.md).

### Changed
- Generated `AGENTS.md` command rows now cite the line they occupy in the regenerated file, so self-citations cannot drift when the layout above them changes.
- The agent prompt now names the hook instead of only asking the agent not to push.
- `plan` and `brief` no longer merge a discovery cache older than seven days. A stale cache is reported with the command that refreshes it, while the cache and `discover` keep the old entries. See [ADR-0013](docs/adr/0013-stale-discovery-is-reported-not-merged.md).
- Installed agent skills are re-scanned on every `plan` and `brief`, including `--offline`, because they are files on this machine rather than a fetch. A stale discovery cache now costs only its cached remote entries.
- Locally installed skills are labelled `installed locally` rather than presented as first-party guidance; the plan JSON carries a per-suggestion `trust` value.

## [0.1.0] - 2026-04-14

### Added
- **Profile Diagnostics & Completeness**: `ProjectProfile` now includes `diagnostics` (`truncated`, `fileLimit`, `failedDetectors`) to track scan completeness.
- **CLI Profile Controls**: Added `--max-files <n>` to `anvil profile` and `anvil doctor`.
- **Strict Profile Checks**: `anvil doctor --strict` now fails (exit code 6) when the profile is incomplete due to truncation or detector errors.
- **Playbook Tri-State Audit**: The `PLAYBOOK` audit rule distinguishes unrun matching (`na`), matched guidance (`pass`), and consulted empty registry (`warn`).
- **Control Character Protection**: `packages/playbooks/src/yaml.ts` rejects C0/C1 control characters and DEL via `assertPrintable`.
- **Registry Cleanup**: Removed BEL (`U+0007`) control characters from 14 built-in playbook YAMLs.
- **Generator Check Mode**: `scripts/gen-playbooks.ts` supports `--check` to validate generated playbooks without writing, powering `npm run check:generated`.

### Changed
- Broadened test discovery pattern in `package.json` to `packages/*/test/**/*.test.ts`.
- Improved `.circleci` and `.vscode/mcp.json` reachability in file walk.
