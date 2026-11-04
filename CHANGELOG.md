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
- **Broad ecosystem coverage**: nineteen new playbooks — Angular, ASP.NET Core, Astro, C/C++, Flutter, iOS, Jupyter, Kotlin Multiplatform, .NET MAUI, NestJS, Next.js, PowerShell, PyTorch, React, React Native / Expo, Shell, Spring Boot, Svelte and Vue — each matched from its own evidence rather than a shared build system or language. See [ADR-0015](docs/adr/0015-framework-evidence-is-the-framework.md) and [ADR-0016](docs/adr/0016-mobile-platforms-are-their-own-stacks.md).

### Changed
- Generated `AGENTS.md` command rows now cite the line they occupy in the regenerated file, so self-citations cannot drift when the layout above them changes.
- The agent prompt now names the hook instead of only asking the agent not to push.
- `plan` and `brief` now enrich automatically: they read a fresh discovery cache and fetch for any matched playbook whose cache is missing or expired, instead of requiring `--refresh` first. `--offline` is the no-network mode, and a claim's recommended resources still read a fresh cache only. See [ADR-0017](docs/adr/0017-plan-enriches-by-default.md).
- Installed agent skills are re-scanned on every `plan` and `brief`, including `--offline`, because they are files on this machine rather than a fetch.
- Locally installed skills are labelled `installed locally` rather than presented as first-party guidance; the plan JSON carries a per-suggestion `trust` value.
- A curated community resource published by one of a playbook's official orgs (for example `android/nowinandroid`) is labelled `official publisher`, not `third party`. The same evidence rule applies inside the official list — a GitHub owner in the seeds, or a declared `officialDomains` host or `host/path` namespace — so a resource owned by someone else, on an unrecognised host, or a third-party package on a shared host such as `hexdocs.pm` or `registry.terraform.io`, is `third party` there too. The worktree shortlist offers only external resources, so repository changes such as "add a lint command" no longer appear as optional reading.
- A claim's optional resources are ranked against the worktree it created rather than the checkout the command ran in, so a claim that forks from a different stack gets that stack's guidance. A malformed `install` value in a discovery cache is ignored rather than breaking `brief`.
- `brief` labels a live resource from an older discovery cache the same way `plan` does, falling back to the entry's source and tier when the cache predates the `trust` field, instead of printing an unattributed row.
- The worktree shortlist matches a focus string against a resource's title and only the head of its detail. A live entry's detail is an unbounded GitHub description, and a keyword buried deep inside one no longer lets an unrelated repository displace a resource that is actually about the task.
- Shortlist relevance matches whole words in resource labels and details, not display prefixes or substrings: `unit` no longer matches `community:` and `line` no longer matches `pipeline`. Hyphens, underscores and other punctuation separate words, so skill names such as `testing-setup` still match their topic.
- A tailored shortlist now offers only a resource that answers the focus — a focus word in its own label, or two distinct focus words in its text — so a coverage ticket is no longer handed a CI triage agent, nor a Compose performance ticket a generic "high-performance workspace", for sharing one common word. The list can be shorter than five; precision beats padding.

### Fixed
- Automatic discovery enrichment no longer aborts when `gh` is missing (it falls back to the REST API), when the discovery cache cannot be written (it warns and still returns the fetched entries), or when a discovered source is unreachable (the MCP registry now warns beside GitHub).
- A discovery cache written by `discover --local-only`, by a run in which an asked source did not answer, or by a run in which a source answered only some of its queries is no longer reused as a complete answer. It is marked partial and the next `plan` or `brief` fetches the missing half, so a rate-limited source is retried rather than silently absent for a week.
- An HTTP 200 from the MCP registry that is not a registry response — a proxy login page, an error object, or a list of records that are not servers — is a failed query, not an answered empty registry. It no longer erases cached MCP entries or marks the cache complete. A body that mixes real servers with records that are not servers is a partial answer: the real servers are added, the cached entries survive, and the cache is refetched rather than trusted.
- A `discover --local-only` scan that merges into an intact, complete remote cache preserves that cache's completeness and age, including when the remote answer was empty. It no longer forces the next `plan` to refetch a remote half the scan did not touch, or dates an answered "nothing matched" from the local skill it just scanned.
- An MCP discovery seed shorter than the three characters the registry will search is now rejected when the playbook is parsed, and skipped by the fetch layer rather than asked. `ci` in the CI playbook and `go` in the Go playbook shipped this way, and every plan spent the request and then marked that playbook's cache incomplete, so it refetched on every run instead of once per week. A list with no searchable term at all reports that nothing was asked rather than an answered empty registry, so it cannot erase cached MCP entries.
- Live discovery reads only a repository's name and a bounded head of its description when deciding whether it is agent tooling, and stores a bounded description as evidence. A catch-all description that mentioned `agent` tens of thousands of characters in no longer admits an unrelated repository or floods the plan with its text.
- A GitHub search that GitHub itself marked `incomplete_results` is a partial answer: the results it did return are kept, but the source is marked incomplete and retried rather than freezing a truncated list into the cache as a finished one.
- The preferred `gh` transport is bounded by the same timeout as the HTTP fallback, for both the version probe and the search call. A hung `gh` now falls through to REST, or reports a partial result, instead of holding automatic enrichment open indefinitely.
- The C/C++ playbook no longer hard-codes CMake verification commands, so a Meson project is not told to run `cmake --build build` and `ctest`. Build and test advice comes from the repository's own detected commands — `meson compile`/`meson test`, `msbuild`, or `cmake --build`/`ctest` — and each matched playbook keeps its own technology's guidance rather than inheriting every detected command.

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
