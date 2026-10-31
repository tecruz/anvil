# ADR-0013: A stale discovery cache is reported, not merged

- Status: accepted
- Date: 2026-10-31
- Milestone: post-M6
- Extends: [ADR-0008](0008-live-discovery-keeps-registry-curated.md)

## Context

ADR-0008 gave the discovery cache a seven-day TTL and said that a stale cache is "still
usable, with a message that names the fix". That was true of the cache as a record: the
entries are still there, and `anvil playbook discover` can still show them. It stopped
being true of `plan` and `brief`, which merged every cache entry regardless of age and
added the staleness warning at the bottom of the output.

Running `anvil plan` on a real repository exposed the difference. A twelve-day-old cache
contributed a screen of community repositories that no longer matched the question, and
the warning that explained why was below the list it was explaining. The reader saw the
entries first, which is the part that shapes what they do next. "Stale live guidance" is
not a weaker version of fresh guidance: a search result from a fast-moving ecosystem is a
guess, and the community tier is where the guess ages worst.

## Decision

**`plan` and `brief` merge only a fresh cache. A stale cache is reported and left out.**
The warning names the age and the command that fetches a new answer. `--offline` still
means no cache and no network, and `--refresh` still fetches now; an explicit refresh that
cannot reach a source keeps the entries it already had, under a warning, because a failed
source is not evidence that the ecosystem published less.

The cache itself is unchanged. It keeps its entries and its age, `discover` can still
report them, and the expiry still happens at read time rather than by deleting a file. The
change is that a plan does not treat an expired answer as live advice.

There is no `--include-stale`. `anvil playbook discover` already shows what the cache
holds, and adding a flag whose purpose is to put known-old entries back into the ranked
list would make the default noisier for everyone in exchange for a path the discovery
command already provides.

## Consequences

- A plan built from a stale cache is shorter and does not contain the stale live entries;
  it says why, and names `--refresh` as the fix.
- The brief gains a `warnings` field so the same condition is visible in both its text and
  JSON output instead of the guidance silently disappearing.
- `--refresh` remains the only path that spends a network call, and the per-source merge
  rules from ADR-0008 are untouched.
- Tests cover a fresh cache, a stale cache, and the default `plan`/`brief` cache path, so
  the three-way distinction cannot regress into "merge everything and warn".

## Alternatives rejected

- **Keep merging stale entries with a warning.** This is the behaviour that motivated the
  decision. A warning below the list is read after the list, and the list is the part a
  reader acts on.
- **Delete the cache when it expires.** It would remove the evidence `discover` reports and
  break the rule that a refresh which cannot reach a source keeps its last answer.
- **Filter individual entries by their own timestamp while keeping fresh ones from a
  merged cache.** A cache's age is defined by its oldest entry (ADR-0008), so a cache with
  one stale source is stale as a whole. A partial refresh should be completed, not quietly
  half-trusted.
- **Add `--include-stale`.** It restores the problem behind an opt-in, and `discover`
  already exposes the cached entries for anyone who needs to inspect them.
