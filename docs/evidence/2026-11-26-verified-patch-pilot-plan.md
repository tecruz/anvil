# 2026-11-26 — predeclared verified-workflow pilot

Status: **predeclared before any task was run**. No result is claimed by this document.

This is the first run of the [verified-workflow plan](../VERIFIED_WORKFLOW_PLAN.md#phase-4--measure-verified-patches-on-real-tasks).
It compares an Anvil-assisted workflow bundle against plain OpenCode on the same pinned tasks.

## Frozen specification

| Field | Value |
| --- | --- |
| Source commit | `a591d22146522f24c0e903e1eb5e3e49ed8aa68d` |
| CLI and grader | Built from that commit; bytes bound by the run spec hash |
| Tasks | `verified-patch` and `node-tiny-slugify`, from `eval/verified-patch-tasks.json` |
| Model | `opencode/hy4-flash-free` (free tier, catalog cost 0) |
| Repetitions | 5 per task, counterbalanced arm order |
| Agent timeout | 5 minutes per arm, enforced including child processes |
| Seed | `verified-patch-workflow-v1` |
| Order | alternating, plain first on even (task index + repetition) |
| Spend cap | $0; only a catalog-free model is eligible. A non-zero cost or free-limit response stops the run |
| Opt-in | `ANVIL_EVAL=1` plus an approval file matching the exact run spec hash |

## Arms

- **Plain:** the pinned fixture as checked in, plus the task card on disk.
- **Anvil-assisted:** the same fixture, plus `anvil init --apply` artifacts and a generated
  `.anvil/ticket.md` (task text fenced as untrusted, verification guidance pointing at
  `AGENTS.md`). The agent is asked to read that ticket first. No push, tracker or network step
  is performed. This is a workflow-bundled comparison, not a claim about any single artifact.

Both arms get the same model, tool access, task text and time limit. Both can invoke the
repository check; the harness captures only a check run through its broker.

## Grading

A task succeeds only when all three facts agree:

1. an in-scope patch differs from the pinned base and protected files are unchanged;
2. a hidden acceptance test, copied in after the arm finished, passes on the final tree;
3. a harness-controlled check ran from the declared directory, exited 0, and its
   before/after patch fingerprints match the final patch.

A broker fault, timeout or arm that never started is a run error, never a task failure. Cost and
tokens stay `null` when the host ledger does not report them.

## Decision rule

Per task: count complete pairs with no run error. Claim a direction for a task only with at
least 5 usable pairs, at least 3 one-sided successes for that variant, and a margin of 2.
Tasks are reported separately and are never pooled into an overall verdict. Time through the
task is descriptive and does not change a verdict.

## Stop rule

Run once with these parameters. Do not rerun failures, add tasks, change the model or seed,
or design a follow-up from observed numbers. If the threshold is not met, report insufficient
evidence and stop; a new decision would be required for another run.

## Pre-data harness correction

A first launch attempt failed before any agent ran: on Windows the runner spawned `opencode`
directly, which cannot resolve the npm `.cmd` shim. The runner now uses the project's
shim-aware `spawnArgv`. This changed the runner bytes and therefore the run spec hash; the
approval was regenerated for the corrected source above. No task result, checkpoint or
measurement existed before this correction, so no outcome influenced the change.

## Authorization

The maintainer approved model spending for this plan on 2026-11-26. The run is still bounded
by the free-model eligibility rule and the hash-matched approval file; this document alone
does not modify the harness, fixtures or scoring.
