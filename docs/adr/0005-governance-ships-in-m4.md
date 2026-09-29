# ADR-0005: Governance (reviewers, risk checklists) ships in M4, not M6

- Status: accepted (supersedes the "deferred to M6" note in the plan)
- Date: 2026-09-29
- Milestone: M4

## Context

The original plan put CODEOWNERS-aware reviewer resolution and risk checklists in M6, on the
reasoning that governance is a refinement of a working ship pipeline and should not be built
before one exists.

That reasoning is sound in general and wrong here, for a specific reason.

`ship` is the seam where everything meets: git, the provider, PR templates, CODEOWNERS and
verification. A PR body is assembled once, at that seam. Governance is not a filter applied
to a finished PR — it is *content in the PR body*, and the body is written exactly once.

If review routing and risk checklists arrive in M6, the assembly step gets rewritten, with
its tests, after the pipeline is working. And the thing most likely to break in that rewrite
is the interaction between the two, which only shows up on a real risky PR.

There is a second cost, and it is the one that decided it. CODEOWNERS resolution has a
correct answer and a plausible wrong one. Git's rule is **last match wins**. The natural
implementation — stop at the first match — sends every review to the `*` catch-all, which is
the exact opposite of what CODEOWNERS is for, and produces output that looks entirely
reasonable. That bug is only findable by writing the rule down and testing the override
direction, which is exactly what an ADR is for.

## Decision

**Governance ships in M4, with the ship pipeline.**

Risk is computed **from the diff**, not from the ticket. A PR touching a migration or a CI
workflow gets a checklist naming the files that triggered it, in the PR body *and* in the
ticket comment. A checklist that always says the same thing gets ignored, so it is narrowed
to what actually changed.

Reviewers come from CODEOWNERS, with every rule checked and each match replacing the
previous one, plus a test for the override direction.

A ticket-update failure is reported but does **not** discard the PR. The PR exists, and
silently diverging the two systems is worse than a partial result; the stage is marked
failed and `anvil issue sync` closes the gap.

## Consequences

- M4 was larger than planned, which is why the plan budgeted 1.5–2x for it.
- The PR body is assembled once, with governance in it, and 49 tests in `packages/pr` cover
  the whole sequence offline.
- The last-match-wins rule is documented in the code, not only in this ADR, because that is
  where a future reader will look.
- If governance later turns out to belong behind a flag, it can be added without restructuring
  the pipeline. What could not have been undone is the M6 rewrite.

## Alternatives rejected

- **Governance in M6, as planned**: a rewrite of the one-time PR body assembly after the
  pipeline works, with the riskiest interaction being the part most likely to be wrong.
- **Governance as a post-hoc step that edits a created PR**: a second API round trip, a
  second failure mode, and a window where the PR is visible with no guidance on it.
- **Ticket-driven risk**: convenient, and wrong. Risk belongs to the diff being reviewed.
  A ticket tagged "migration" that touches no migration should produce no checklist.
