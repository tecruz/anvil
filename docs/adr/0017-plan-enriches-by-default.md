# ADR-0017: `plan` and `brief` enrich by default; the cache bounds the cost

- Status: accepted
- Date: 2026-11-02
- Milestone: post-M6
- Extends: [ADR-0008](0008-live-discovery-keeps-registry-curated.md)
- Supersedes: [ADR-0013](0013-stale-discovery-is-reported-not-merged.md) for `plan`/`brief`

## Context

Live discovery was built behind explicit flags. `plan` and `brief` merged a fresh cache
and nothing else; a missing or stale cache produced a shorter plan and a warning that
named `--refresh`. ADR-0008 chose that, and ADR-0013 sharpened it, for a good reason: a
plan that spends no network call on every question is cheap enough to run constantly, and
a week-old search result presented as live guidance is a guess dressed as advice.

Running it for real showed the cost of that default. On a machine that had never run
`anvil playbook discover`, `plan` was silently poorer than it could be. The guidance the
feature exists to surface was one flag away, and the output did not say so in a way a
reader acts on. The person who most needs the enrichment -- someone evaluating the tool on
a new repository -- is exactly the person with no cache, who does not yet know the flag.

ADR-0013's rule still protects something worth protecting: a search result from a
fast-moving ecosystem ages badly, and the ranked list must not present last week's guess as
this week's advice. The question this ADR answers is only *who pays* for a fresh answer,
and how often.

## Decision

**The default fetches what it cannot reuse.** `plan` and `brief` scan installed skills,
read the remote half of a fresh cache, and fetch from GitHub search and the MCP registry
for any matched playbook whose cache is absent, stale or unreadable. The fetch writes the
cache, so the run after it reads what this one fetched: the network cost is once per
playbook per seven-day TTL, not once per run.

**"Answered, nothing matched" is cached; a partial run is marked as such.** A fetch that
reaches a source and finds nothing is still an answer, and it is written with a fresh
timestamp. Without that, a matched playbook whose ecosystem has nothing to find would be
fetched on every `plan`, spending a rate limit per run to relearn the same nothing. But a
run in which a source that *was asked* did not answer, answered only some of its queries, or
answered HTTP 200 with a body that is not the source's own response -- a proxy page, an error
record, records that are not servers, or such records beside real ones -- is partial, and its cache
is marked incomplete: the default `plan` fetches again rather than presenting the half-answer
as the whole truth. A cache written by `discover --local-only` with no remote half is marked
the same way so it does not suppress online enrichment for a week; one that merges into an
intact, complete remote cache keeps that cache's marker and age, because the scan did not
change what the network had said. That holds even when the complete answer was empty: "asked,
nothing matched" is still an answer, and a local skill found since then must not turn it into
a question that needs asking again. Only a run where no remote source answered at all leaves
the cache exactly as it was, and a failed fetch that happens to have a local skill to show
must not write that skill as if it were a fresh network answer.

**A query the source cannot answer is not a query.** The MCP registry rejects a search term
shorter than three characters with HTTP 422, so a seed below that minimum can never complete:
asking it would count as a failed query on every run and keep the cache partial forever. Such
a seed is rejected when the playbook is parsed, before a playbook can be returned. The fetch
layer skips one rather than asking it, so a list that also holds searchable terms stays
complete. A list with no searchable term at all is not an answer either: no request was made,
so the cached servers survive instead of being erased by a run that asked nothing. The same
reasoning bounds what counts as agent tooling:
a repository is judged on its name and the head of its description, so a catch-all blurb that
mentions `agent` tens of thousands of characters in is not read as agent tooling.

**A source that is down is a warning, not a failure.** A machine without `gh` -- the
locked-down machine the README supports -- falls back to the REST API rather than aborting
the run, an MCP registry that cannot be reached warns beside GitHub's own warning, an HTTP
200 that is a proxy page or an error object -- or a list of records that are not servers -- is
a failed query rather than an empty registry,
and a cache the process cannot write costs the next run a repeat fetch rather than costing
this run the guidance it already has.

**The flags keep their meanings, narrowed.** `--offline` is the only mode that promises no
network: installed skills only, no cache, no fetch. `--refresh` fetches even a fresh cache,
for a caller who knows the answer changed. They still contradict, and are still refused
together.

**Only seeded, matched playbooks are fetched.** Discovery is keyed by playbook id and read
after matching, so one `plan` fetches for the technologies the repository actually uses,
never the whole registry.

**A fetch that reaches nothing keeps what it had.** The per-source merge from ADR-0008 is
extended rather than abandoned: a source that answered *every* query replaces its own
entries, and a source that could not be reached -- or answered only some of its queries --
keeps its last answer, under a warning. A partial source also keeps its fresh entries,
because the cache cannot tell which old entry came from the query that failed; the incomplete
marker is what makes the next run settle the question. An implicit fetch that fails therefore
cannot erase the cache. It can, as `--refresh` always could, keep a stale source's entries
alive when that source specifically did not answer; the warning names the failure, and the
entries are the last thing the source actually said.

**The claim shortlist stays cache-only.** `anvil claim` builds its recommended resources
with the cache-only reader, which still follows ADR-0013: a fresh cache or nothing. A claim
is on the critical path of starting work and must not wait on a fetch, so the two callers
deliberately differ.

## Consequences

- `anvil plan` and `anvil brief` make a network request the first time they run for a
  technology, and are answered from the cache for the following week. `--offline` restores
  the old zero-network guarantee.
- A missing or stale cache is no longer reported as a problem to fix; it is a request the
  run completes itself. The stale/reported path remains in the cache-only reader the claim
  shortlist uses.
- A partial or local-only cache is refetched rather than reused, so a source that was down
  is retried and its failure is warned about instead of being presented as a complete answer.
  A local-only scan that merges into an intact remote cache preserves that cache's
  completeness, so the scan does not force an unnecessary fetch, including when the remote
  answer was empty: an answered "nothing matched" stays fresh until its original TTL. A cache
  written before the completeness marker existed is treated as complete, so an upgrade does
  not trigger a one-time refetch of every playbook.
- A machine without `gh`, an HTTP 200 that is not a registry response, and a cache the
  process cannot write all degrade to a warning: the REST fallback answers the first, the
  bad payload is a failed query rather than an empty registry, and the current run keeps its
  entries for the third.
- Tests cover the default fetching a missing, stale, partial and local-only cache; reusing a
  complete fresh cache without a fetch; fetching only the playbook that needs it; a missing
  `gh` falling back to the API; a partially answered GitHub or MCP source being marked
  incomplete; an invalid registry body or a list of non-server records keeping the cached
  entries, and a list that mixes real servers with records that are not servers keeping both
  the fresh and the cached entries; an MCP seed below the registry minimum being rejected at
  parse time, and a list of only such terms asking nothing and keeping cached servers; a
  repository whose tooling keyword is buried in a huge description being
  rejected, with a bounded description stored as evidence; a local-only scan preserving a complete remote cache,
  including a complete empty answer and its age; an unwritable cache still returning its
  entries; the
  MCP warning; and a fetch that reaches no source keeping installed skills and its warning.
- The transport timeout bounds a machine with no network: a failed fetch costs the
  per-request timeout once, contributes nothing, and warns, while the local profile, audit
  and installed skills still resolve.

## Alternatives rejected

- **Keep the explicit flag and document it better.** The state that motivated this decision
  was the documented default; a reader who never ran discovery does not read a warning about
  a cache they do not have.
- **Fetch on every run regardless of cache.** It spends a rate limit to rediscover what was
  fetched an hour ago, and makes `plan`'s result depend on the network on every invocation.
  The cache exists precisely to avoid that.
- **Fetch a stale cache but keep ADR-0013's drop for a missing one.** It splits one question
  -- "can the cache answer?" -- into two behaviours a reader cannot predict, for no gain.
- **Make the claim shortlist fetch too.** It puts a network round trip on the path that
  starts a worktree, for guidance that is optional by construction.
