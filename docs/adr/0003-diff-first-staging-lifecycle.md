# ADR-0003: Diff-first writes with a staging and apply lifecycle

- Status: accepted
- Date: 2026-09-29
- Milestone: M2b

## Context

`anvil init` writes files that people edit by hand: `AGENTS.md`, agent definitions,
commands, skills. A tool that writes them directly is immediately in conflict with its user.

Once someone has edited `AGENTS.md`, a later `anvil init` has three options, and all three
are bad. Skip the file, and the repository drifts from what the tooling believes. Overwrite
it, and work is lost. Merge it, and you have built a three-way merger for a file whose
format is prose.

The related problem is that these files are invisible when they are wrong. A malformed agent
definition fails when an agent loads it, possibly much later, in a different directory.

## Decision

**`init` writes nothing into a checked-out repository.** It stages a bundle under
`.anvil/staging/`, renders a diff, and stops. `--apply` is the only operation that writes,
and the bundle records a hash of its inputs.

Two rules make this work:

- **The staging directory is git-excluded, not git-ignored.** `.anvil/` goes in
  `info/exclude`, so a repository that is anvil's own source tree does not need an
  `.anvil/` entry in its `.gitignore` to keep its own state clean. Adding a line to a
  user's `.gitignore` is a write anvil does not get to make.
- **`--apply` refuses when the inputs have changed.** A bundle derived from a different
  repository state would silently overwrite newer work, so a hash mismatch is a hard stop
  with a message naming what moved, rather than a merge.

A validator runs over the bundle before apply, so a malformed artefact fails at a point
where the error names the file, instead of later inside an agent.

## Consequences

- Two steps to apply changes, which is slower and is the point. The intermediate state is a
  reviewable diff.
- `.anvil/` is untracked but present, which is visible in `git status` as nothing and is
  easy to forget exists. `anvil status` treats it as state rather than output.
- The staging hash is conservative: it will refuse when the repository is merely newer, not
  only when it is incompatible. False refusals are the acceptable direction, because the
  alternative is silent loss.
- Templates are idempotent. Running `init` twice from the same state produces the same
  bundle, so re-running is safe.

## Alternatives rejected

- **Write directly, with a `--force` flag**: no review point, and the force flag becomes
  routine, at which point it is not a safeguard.
- **Merge with the existing file**: a three-way merge on prose, with a whole class of
  conflict-handling decisions that belong nowhere near a scaffolding tool.
- **Track `.anvil/` in git**: pollutes the user's repository with tool state, and creates a
  commit for something that is machine-local by nature.
