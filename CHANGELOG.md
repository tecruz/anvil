# Changelog

All notable changes to this project will be documented in this file.

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
