# ADR-0008: Live discovery enriches the plan; the registry stays curated

- Status: accepted
- Date: 2026-10-19
- Milestone: post-M6
- Extends: [ADR-0002](0002-gh-cli-as-first-transport.md) — the same reasoning puts `gh`
  first for discovery, with the REST API as a fallback rather than the default.

## Context

The playbook registry is curated, and curation has a blind spot with a concrete example:
Google publishes an official `android` CLI and an `android/skills` repository, and
`registry/playbooks/android.yaml` listed neither — not because the entry had been considered
and rejected, but because there was nowhere in the format to record *"these orgs speak for
this technology; go and find what they published."*

Two tempting answers are both wrong. **Adding the entries by hand** is what the registry
already does, and it rots at the speed of GitHub while claiming to be reviewed. **Writing
discovery results back into the YAML** turns a hand-maintained file into a cache with a git
history: the first bad fetch becomes permanent, reviewed-looking content, and a maintainer
can no longer tell an entry a human approved from one a search returned.

The question that forced the decision was whether a tool that cannot know what a technology
published last month should say nothing, or ask. It should ask — but the answer must not be
mistaken for the curated record.

## Decision

**Seeds are curated; answers are fetched.** A playbook gains a `discover:` section naming
`officialOrgs` (the GitHub logins that authoritatively represent the technology), `keywords`
to search, and `mcp` terms for the MCP registry. That list is a stable, reviewable fact, so
it belongs in YAML. What those orgs published is a network answer and belongs in a cache.

**Live results are cached and merged, never written to `registry/playbooks/`.** Fetching goes
to `~/.anvil/cache/discovery/<id>.json` with a seven-day TTL, and `plan`/`brief` merge the
cache at read time. A missing or corrupt cache is empty and quiet; `plan` must work on a
machine that has never run discovery. A run that found nothing never overwrites a good cache,
so a rate limit cannot become seven days of "anvil found nothing." While the cache is fresh,
`discover` reuses it rather than spending a rate limit to rediscover the same answer —
`--refresh` is the explicit request for a new one — and `--local-only` merges its partial view
into the cache instead of replacing it, keeping the original fetch time so the network half
still reports as old.

**Curated always wins a contested URL**, and live confidence is capped below curated:
official live entries at 0.65 against curated official 0.7–0.75, community live at the star
ladder minus 0.05 with a 0.3 floor. A fetched entry nobody reviewed must not read as settled
advice, and printing the same link twice makes the plan look like it found two concerns.

**`--propose` is the only thing that resembles curated data, and it prints.** It emits YAML
with the source and fetch time as comments for a maintainer to read and merge. Proposals for
entries with no URL are dropped, because a playbook resource without a URL fails `check` —
handing a maintainer a patch that fails their own gate. Local skills have no URL, so they
appear in the plan but are never proposed.

**Transport order is `gh`, then REST, then anonymous with a warning.** `gh api` already
carries the auth and Enterprise-host handling ADR-0002 chose; the REST fallback uses
`GITHUB_TOKEN`/`GH_TOKEN`; anonymous search is capped at ten requests per minute and says so
rather than returning a silently smaller list. **Repos and orgs only** in v1: per-repository
contributor calls would spend the rate limit on a question nobody asked.

**The machine itself is a source.** Installed agent skills under `.agents/`, `.claude/` and
the opencode config are scanned locally, so `--local-only` is a real answer on a locked-down
machine rather than a degraded one. The scan reports what is installed — evidence of the
local setup, not of who maintains it — and one skill installed in three directories is
reported once, with the copies counted, because three copies that can drift is itself worth
knowing.

**The org check applies wherever a login exists.** A registry server whose URL is a GitHub
repository is classified by that repository's owner, exactly as a search result is, so a
first-party MCP server is not filed beside every third party's. A server published as a
running endpoint has no owner to check and stays community — there is no evidence either
way, and the absence of evidence is not evidence of ownership. The seeds themselves are
validated: an `officialOrgs` entry that is not a GitHub login fails the playbook check,
because a typo there searches for nothing and reports, truthfully and uselessly, that the
ecosystem has published nothing.

## Consequences

- New package `@anvil/discovery`, new command `anvil playbook discover [id|--all]
  [--local-only] [--refresh] [--propose]`, and `plan`/`brief` gained `--offline` and
  `--refresh`.
- `Playbook` gained `discover`; `Suggestion` gained `provenance` and `fetchedAt`; all fifteen
  registry playbooks declare seeds. `generated.ts` is still the compiled registry and the
  parity test still enforces it.
- Discovery is keyed by playbook id and read after matching, so a cached `android` entry
  never appears in a plan for a repository that matched only `node`.
- The unit suite covers classification, cache freshness, local scanning, proposals
  (round-tripped through this project's own YAML parser and validator), and the merge rules.
  The live suite (`packages/discovery/test/live.test.ts`) checks the argv against the real
  `gh` and the transports against the real API, and stays behind `ANVIL_LIVE=1`, as the
  transport ADR requires. CI runs its argv tier on every push, because the flag shape is
  the part a mocked runner cannot see; the search tier runs wherever `gh` is authenticated
  and skips itself otherwise, since an anonymous search is rate-limited to ten a minute and
  would fail for reasons that are not the code's.
- Running against a real machine found two defects the fixtures could not: the frontmatter
  parser truncated plain multi-line YAML scalars, and local dedupe keyed on the install path
  reported one skill once per directory. Both are pinned by tests now.

## Alternatives rejected

- **Write discovery results into `registry/playbooks/` automatically.** The shortcut that
  makes the feature feel finished and destroys the property the registry exists for: a file
  a human reviewed. A proposal is printed for exactly this reason.
- **Keep the registry static and document how to look things up by hand.** Honest, but it is
  the state that produced the motivating gap, and it answers "what changed?" with "check
  GitHub yourself."
- **REST-first with a token, like an ordinary API client.** That is ADR-0002's rejected
  option with a search endpoint: it reinvents auth refresh and Enterprise handling to answer
  a question `gh` already answers on the machines this tool is built for.
- **Bundle a generated snapshot of the ecosystem instead of fetching.** It is the same rot
  with a bigger diff, and it would still be stale the day it ships.
- **Include contributor lookups in v1.** One request per repository, on top of search, to
  identify people rather than tooling — a rate-limit cost with no matching benefit.
