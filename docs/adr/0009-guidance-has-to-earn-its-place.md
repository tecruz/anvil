# ADR-0009: Guidance has to earn its place

- Status: accepted
- Date: 2026-10-20
- Milestone: post-M6
- Extends: [ADR-0008](0008-live-discovery-keeps-registry-curated.md) — discovery added
  entries to the plan; this decides when an entry belongs in it at all.

## Context

Two things anvil hands an agent were, on the evidence, not worth what they cost.

**The instruction file.** A study of AGENTS.md files in real repositories (arXiv:2602.11988,
2026) found that adding one did not generally raise an agent's task success and raised
inference cost by more than 20%. The guidance that paid for itself was the part a model
could not infer from the repository: the project's own commands and its non-standard
tooling. "Agent instruction bloat" (Thoughtworks, April 2026) describes the same failure
from the other side: instruction files accumulate, hand-written sections survive, generated
ones pile up until nobody reads them.

anvil had a size check, and it was the wrong one. `derive` warned when a generated AGENTS.md
passed 40 kB, and the audit only noticed a file that was *nearly empty*. There was no budget
for a repository that ships its own forty-kilobyte AGENTS.md, and no check that the commands
an agent needs are near the top of it. The budget was where the cost was, and nothing
measured it.

**The external guidance.** The plan offered a repository the official style guide, the
framework documentation and the community tools whether or not the repository already had
that style guide configured. The guidance was not wrong. It was redundant, and redundancy is
what teaches a reader to skip a list: the first few suggestions are things the reader
already does, so the list stops being read, and the suggestion that would have mattered is
in it too.

Both are the same mistake, and it is the mistake this project has been careful about
elsewhere: **offering something without asking whether the reader needs it.** The plan
already did this correctly in two places — verify commands are suggested only when the
repository has none, and a risk glob is suggested only when the repository has a file
matching it. The resources were the remaining case.

## Decision

**Instructions have a byte budget, and the commands have to be at the top.** The audit gains
an `INSTRUCTION_BUDGET` rule: it measures the largest instruction source the repository
ships (a file, or a rules directory counted as one source), because sources for different
tools are never loaded together, warns past 16 kB and fails past 40 kB, and the fix says
what to do — keep the commands, the
module map and the risk paths, move the rest into a skill that is read only when it is
needed. Once a file is over the threshold the rule also checks that a runnable command
appears in its first eighty lines, because a command buried under prose is the part of the
file that does not pay for itself. The thresholds are in bytes rather than tokens, because
bytes are measured the same way on every machine and a rule that reports a different verdict
on two machines is a rule nobody trusts; the token count in the message is an estimate for
the reader, never the verdict. The rule is `na` on a repository with no instructions, because
`AGENTS_FILE` already reports that.

**A resource can declare what satisfies it, and a satisfied resource is left out.** A
playbook resource may carry `satisfiedBy`: a list of repo-relative globs whose presence
means the repository already follows that guidance. A resource whose globs match a file in
the repository is not printed, and the count of what was left out is printed with it, so the
omission is visible rather than silent. `anvil plan --include-satisfied` keeps them, and
then the evidence names the file that satisfied them. The narrowing is deliberate and
recorded: v1 is file presence only, because a file's existence is the one signal that can be
checked without reading it, and content signals ("the pyproject declares ruff") would need a
content matcher the registry does not have.

**A `satisfiedBy` that can never fire is a registry defect.** If every glob a resource
lists is also a file the playbook matches on, the resource is satisfied exactly when the
playbook matches, so the suggestion is dropped every time and never shown. `playbook check`
reports it, because the author meant to say something else.

**Satisfaction is a property of the repository, not of the request.** The count is reported
whether or not the caller filtered the plan, and it survives `--tier` and `--limit`: the
filtering decides what is shown, and the satisfaction is a fact about the repository.

## Consequences

- `Plan.schemaVersion` is 2. The plan gained `satisfied`, and the default behaviour of the
  official and community tiers changed. Consumers that read the plan JSON read a field
  they did not have before and a list that may be shorter.
- The registry grew eleven `satisfiedBy` annotations across seven playbooks, and only where
  a config file honestly implies the guidance: `ruff.toml` means the repository uses Ruff,
  `.rubocop.yml` means it uses RuboCop, `.editorconfig` means it declares its own style.
  Most resources have no such signal and are still offered, which is the correct answer:
  a repository that uses Ruff still needs to know what Ruff's rules mean.
- One QA playbook became five: a cross-cutting `qa` playbook and one per tool. A repository
  that runs Playwright has no use for the Cypress documentation, and the plan that offers
  it is the plan that teaches the reader to skip the plan.
- The instruction budget changes every doctor's score, because a rule's weight is part of
  the denominator. The corpus was re-run for the calibration: nine of twenty-two real
  repositories ship instructions, one is over the warning line and none over the failure
  line. The run corrected the measure from the sum of every instruction file to the largest
  source, because a repository that ships separate files for separate tools does not make
  one agent read them all. The numbers are recorded in the implementation plan.
- `derive`'s AGENTS.md check now uses the audit's threshold, so a file that `anvil doctor`
  rejects cannot be written by `anvil init --apply` without the writer being told why.

## Alternatives rejected

- **Warn about instruction size only in `derive`.** That checks the file anvil wrote, not
  the file the repository ships, and the repository's own AGENTS.md is the one the agent
  reads.
- **Measure the budget in tokens.** More honest about what the model pays, and less
  reproducible: the number depends on the tokenizer, so two machines disagree and one of
  them is wrong.
- **Delete the AGENTS.md instead of trimming it.** The study says the *file* did not help
  on average, not that the commands in it do not help. The commands are the part a model
  cannot infer.
- **Keep the resource list and mark the satisfied ones "you already have this".** Visible,
  but it keeps the noise in the list it was supposed to shorten, and the count plus
  `--include-satisfied` is visible without being noisy.
- **Content signals for satisfaction** (a pyproject that declares a tool, a lockfile that
  pins it). Stronger than file presence, and a second mechanism to keep correct. Not
  because the idea is wrong, but because the file-presence mechanism is enough to test the
  idea with, and a mechanism that is wrong in a new way is worse than no mechanism.
- **Score the guidance by how much it helps.** The evaluation that would settle it needs
  outcome evals, which the eval harness now exists to run — but a score nobody can reproduce
  locally is not a score a registry can be built on.
