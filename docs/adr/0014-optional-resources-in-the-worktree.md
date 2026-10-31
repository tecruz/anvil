# 0014 — A worktree gets a shortlist of optional resources, with publisher evidence

**Status:** accepted

## Context

The plan is a catalogue. `anvil plan` ranks every fix and every playbook resource for a
repository, and on a real Android project that is ~150 suggestions across docs, skills,
agents, MCP servers and community repositories. That is the right shape for "what should I
improve here?" and the wrong shape for "I am working on this ticket right now".

`anvil claim` already writes a warm context bundle (`.anvil/ticket.md`) with the task, the
acceptance criteria, the repository's own verify commands and its high-risk paths. It said
nothing about the ecosystem resources the plan had just found, so an agent that would have
benefited from an installed `testing-setup` skill never learned it was there — and a human
reviewing the claim could not see which resources anvil considered relevant.

Two more defects surfaced while looking at why: the discovery cache was treated as the only
source of live guidance, so installed skills disappeared whenever the cached *network* half
went stale, and every locally installed skill was labelled `official`. The first makes anvil
less useful the longer it runs unattended; the second asserts a publisher the evidence does
not support.

## Decision

1. **Installed skills are re-scanned on every `plan`, `brief`, `claim` and `refresh`.** The
   local scan reads files; it cannot be stale and it needs no network. A cached `local-scan`
   entry is never reused, so an uninstalled skill does not come back from the cache and a
   newly installed one appears immediately. Remote entries still come from the cache and are
   still dropped when the cache is stale.
2. **Publisher evidence is a field, not an inference from the tier.** Discovery entries and
   plan suggestions carry `trust`: `official-publisher`, `local-install` or `third-party`.
   A local skill stays useful (tier `official`, ranked normally) and is labelled
   `installed locally` rather than presented as first-party.
3. **`shortlistSuggestions` ranks resources for one piece of work.** It matches a focus
   string — the ticket's title, body, acceptance criteria and labels — against resource
   titles and details, and returns at most five, excluding derived repository fixes. Scoring
   is deterministic and offline.
4. **`claim`, `crew up` and `issue refresh` put the shortlist in the bundle** as
   `## Recommended resources (optional)`, labelled as aids that were not installed or run
   and that never replace the verify commands. The bundle stays a bundle: values are
   collapsed to one line and clamped.
5. **Nothing is installed or executed.** A recommendation is a line of text. anvil does not
   `npx` a skill, clone a repository or run a resource's own instructions.

## Consequences

- A stale cache now costs the remote half of discovery only; the machine's own skills keep
  working. The warning says exactly that.
- The plan JSON and terminal output gain a `trust` value per suggestion and a
  `[installed locally]` / `[official publisher]` marker on live rows.
- The context bundle has one more short section, bounded at five entries. It is the only
  part of the bundle that comes from outside the repository.
- Ranking is a keyword match, not a model. It is cheap, explainable and reproducible, and it
  can be wrong; that is why the list is capped, labelled optional, and never a command.

## Alternatives rejected

- **Put the whole plan in the bundle.** A worktree would carry a catalogue whose items it
  cannot act on, and the verify commands would stop being the thing an agent reads first.
- **Let the plan itself filter to the ticket.** `plan` does not take a ticket and must not
  start; it answers a question about a repository.
- **Install the recommended skills.** Convenient once, a supply-chain change made by a tool
  nobody reviewed. Installing a skill is the user's decision.
- **Keep labelling local skills `official`.** It reads as first-party, which the evidence —
  a file in a directory — does not establish.
- **Drop a stale cache's local entries along with its remote ones.** They did not go stale;
  the search did. Re-scanning is cheaper than reconciling ages.
