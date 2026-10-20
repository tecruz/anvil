# ADR-0010: Cost is read from the host's ledger, never recorded by anvil

- Status: accepted
- Date: 2026-10-20
- Milestone: post-M6
- Extends: [ADR-0004](0004-local-provider-as-egress-escape-hatch.md) — the same refusal to
  be the thing that talks to a service on the user's behalf.

## Context

The crew starts an agent in a worktree and walks away. When the agent finishes, the
question a person actually has is not "did it commit" but "did that work, and what did it
cost". The first half anvil already answers: the worktree, the commits, the verify commands
and the PR. The second half it did not answer at all.

Three obvious answers, and all three are wrong.

**Price the tokens in anvil.** Model prices change per model and per provider, and a
mistake here is a wrong number printed with the confidence of a measurement. anvil would
become the thing whose cost figure nobody trusts.

**Ship a hosted dashboard.** That is a server, a database, an account system and a
retention policy, in exchange for a picture of numbers the machine already has. It also
breaks the promise that is the project's most load-bearing property: no telemetry. A cost
feature that phones home is not a cost feature, it is a data-collection feature with a
useful chart.

**Read the agent's own storage directly.** The usage logs are on the machine, and the
machine's own tooling already reads them: `ccusage` prices Claude Code, Codex, opencode and
a dozen other agents from their local logs, and it has an opencode source that reads
opencode's own storage. Reimplementing that is the same mistake as pricing tokens by hand,
one layer down.

There was a second question, and it was the one that decided the design: **how does a claim
know which conversation was its agent?** The claim registry records a worktree, a branch and
a ticket. The session id belongs to a conversation, and opencode chooses it — anvil starts
the process and never sees it. The obvious answers were time windows (a session that
started after the launch and before now, probably) and reading opencode's session database
(a schema that belongs to another project and changes under it). Both produce a number
attributed to the wrong thing, and a cost report that is wrong in a way nobody can check is
worse than no cost report.

## Decision

**The cost comes from `ccusage`, and anvil records nothing.** `anvil crew status --cost`
runs `ccusage opencode session --json` — the per-source report first, the generic one as a
fallback for an older ccusage — and reports what it says for the sessions the crew cares
about. The report is read, never uploaded; ccusage reads local files and anvil runs it
locally. anvil keeps no usage data of its own, has no telemetry, and gains no dependency:
`ccusage` is optional, and a machine without it still gets a complete status report.

**A missing ledger is a note, not a failure.** When ccusage is not installed, the cost
column shows a dash and the command says why, in one line. The rest of the report is still
true, and a command that fails because a third-party tool is absent teaches the reader to
run commands without it.

**The session is recorded by the plugin, in the worktree, because that is where the two
facts meet.** The opencode plugin already runs inside the agent; its `chat.message` hook
receives the session id, and the directory it is running in is the worktree. The plugin
writes `.anvil/session.json` there, and the CLI reads it from the claim's worktree path. The
mapping is exact rather than inferred: session, worktree, claim, cost.

**The cost column says what it knows.** A session the ledger has no price for shows a dash
rather than `$0.00`, because zero is a claim about the price and a dash is a claim about the
report. The JSON carries the session id and the cost separately, so a consumer can tell
"no session" from "no price".

**A process id is a process id.** The claim registry recorded the agent's pid in a field
called `sessionId`, because the launcher had nowhere to put a session id and the name was
never checked. The field is now `pid`, and a registry written before the rename is still
read: the old field is accepted as the pid it always was.

## Consequences

- `anvil crew status` gained `--cost`. It is opt-in, because the lookup shells out and
  because a cost nobody asked for is noise.
- The opencode plugin records the session id. Without the plugin, no session is recorded and
  the cost column is a dash: the feature degrades to "not available", which is a fact
  about the machine rather than an error.
- The cost is the agent's cost, not the ticket's: one session can touch several files, and
  a claim that was never launched has no session. The report is per session, and the reader
  is expected to read it as such.
- The unit suite covers the parsing (a report that is not a report is null; a session with
  no price is null, not zero; unknown fields are ignored), the fallback to the generic
  command, and the missing-ledger path. The ledger itself is another project's output, and
  this project does not test other projects.
- The eval harness reads the same session file, so a run of the harness can be priced
  without a second integration.

## Alternatives rejected

- **Compute the cost from the agent's token counts.** Same objection as pricing tokens by
  hand, with one more place for the price table to go stale.
- **Read opencode's session storage directly.** It would remove the ccusage dependency, and
  it would couple anvil to another project's private storage layout and to a SQLite schema
  that changes with it. A tool that reads a database it does not own is a tool that breaks
  on someone else's release.
- **Attribute by time window.** A session that started after the launch is almost certainly
  the claim's session — and "almost certainly" is how a cost report ends up billing the
  wrong work. The plugin knows exactly which session it is in.
- **Have the launcher pass a session id to the agent.** The id is chosen by opencode, not
  by the caller; there is no supported way to choose it.
- **A hosted dashboard.** Rejected above: it is a server, and it breaks the no-telemetry
  promise that the rest of this project is built on.
- **Report cost per ticket rather than per session.** A ticket is what a person cares
  about, and a session is what the machine can prove. Deriving one from the other means
  apportioning a session across the files it touched, which is a guess wearing a decimal
  point.
