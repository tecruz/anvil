# 2026-11-26 — verified-workflow pilot results

Status: **executed; predeclared threshold not met in either task**. No effectiveness claim.

## Provenance

Executed under the [predeclared plan](2026-11-26-verified-patch-pilot-plan.md), with no design
parameter changed after the first real agent invocation.

| Field | Value |
| --- | --- |
| Run id | `49fe60ea-1898-46f3-ad0c-242a141c0acc` |
| Run spec hash | `8ca343116a909e7523fc2da2c88283148a0efc6e2ef812b64d7171cddfcbb615` |
| Source commit | `a591d22146522f24c0e903e1eb5e3e49ed8aa68d` |
| Model | `opencode/hy4-flash-free` (catalog cost 0) |
| Seed / order | `verified-patch-workflow-v1` / alternating |
| Repetitions | 5 per task, 20 invocations |
| Timeout | 5 minutes per arm, enforced including child processes |
| Completion | complete |
| Cost / tokens | `null`; the harness did not receive a ledger price |
| Record | `eval-results/pilots/49fe60ea-1898-46f3-ad0c-242a141c0acc/` |

## Results

### verified-patch

| Pair | plain | anvil |
| ---: | --- | --- |
| 0 | success | success |
| 1 | success | success |
| 2 | success | success |
| 3 | success | success |
| 4 | success | success |

Complete pairs 5, run errors 0, both success 5, anvil only 0, plain only 0, neither 0.

### node-tiny-slugify

| Pair | plain | anvil |
| ---: | --- | --- |
| 0 | task-failure | task-failure |
| 1 | task-failure | task-failure |
| 2 | task-failure | task-failure |
| 3 | task-failure | task-failure |
| 4 | task-failure | task-failure |

Complete pairs 5, run errors 0, both success 0, anvil only 0, plain only 0, neither 5.

Plain-arm failures name "the harness-controlled check failed"; assisted-arm failures name
"the check ran against a different patch". Those are grader reasons, not an attribution of
why the agent failed, and the retained record has no bounded transcript that could settle it.

## Verdict

**Insufficient evidence.** Each task has the required 5 usable pairs, but neither has a
one-sided win, let alone three with a margin of two. The predeclared rule therefore permits no
direction claim for either task. The tasks are not pooled into an overall verdict.

The first task was solved by both arms in every pair, so it is saturated for this comparison:
it cannot separate the workflows. The second task was solved by neither arm; its failures are
recorded but not attributed. No time advantage or cost advantage is claimed.

## Stop

The predeclared stop rule applies: no failed pair was rerun, no task was added, the model and
seed were not changed, and no follow-up design was derived from these numbers. Any further
effectiveness study needs a new predeclared decision.

## Consequence for the plan

Phase 4 is executed and honestly reported. It does **not** establish that the Anvil workflow
helps agents produce verified patches faster or more reliably. The capability and conformance
claim in the launch evidence is unchanged.
