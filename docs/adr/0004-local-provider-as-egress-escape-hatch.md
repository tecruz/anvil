# ADR-0004: The `local` provider is the API-egress escape hatch, not a test double

- Status: accepted
- Date: 2026-09-29
- Milestone: M3

## Context

`anvil` talks to a ticket tracker. Almost all of its value — claims, crews of worktrees,
`ship` — sits above the tracker, not inside it. The tracker is a source of tickets and a
place to post status.

Some of the situations the tool is built for have no usable tracker:

- A company network blocks API egress, which is common and not negotiable.
- The tracker needs an account you do not have, or a VPN you are not connected to.
- You want to try the tool on a repository that has nothing to do with work.
- The provider you use is Jira, and Jira support is not in v1.

If a tracker is required for the core workflow, the tool is unusable in exactly those
situations, and the failure mode is total: nothing works, with no partial path.

There is a real risk in the opposite direction. A local provider built *as a test double*
is a fake, and a fake that behaves differently from the real thing is worse than no fake,
because the tests pass and the tool fails on a real repository.

## Decision

**`local` is a first-class provider, and the default.**

Tickets are one markdown file per ticket in `.anvil/tickets/`, with a small frontmatter
block. Bodies stay markdown, so there is no format conversion and no lossy mapping to get
wrong.

The design constraint that keeps it honest: `local` implements the same `TicketProvider`
interface as `github`, with the same semantics for states, comments and transitions. It is
exercised by the same tests. That is what stops it drifting into a fake — if `local` returned
something `github` could not, the shared tests would fail.

It is the default because of the constraint, not despite it. A tool that can do nothing
without an account is a tool that cannot be evaluated.

## Consequences

- `anvil` is fully usable with no network, no account and no `gh`. A crew of three worktrees
  against local tickets is a supported configuration, not a demo.
- A new provider is an implementation of one interface, and the test suite that `local`
  passes is the specification.
- Two things must stay in sync across providers: state normalisation (`in_progress`,
  `in_review`, `wontfix`, `unknown`) and comment semantics. Both are part of the interface
  for exactly this reason.
- Markdown files are not a tracker. No assignment, no watchers, no workflow automation. The
  interface is deliberately small enough that the difference does not show up as missing
  features, because for the v1 workflow it does not.
- A company that needs Jira gets `anvil playbook add` and a provider later, not a rewrite.

## Alternatives rejected

- **A test-only fake provider**: tests would pass against behaviour the real transport does
  not have, which is the failure mode this decision exists to prevent.
- **Require a tracker, always**: the tool is unusable behind a proxy, and a person
  evaluating it needs a company account to find that out.
- **A built-in SQLite store**: a database to migrate, and it still is not a tracker, so it
  buys nothing over files.
