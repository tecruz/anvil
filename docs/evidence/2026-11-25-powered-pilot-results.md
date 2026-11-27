# 2026-11-25 — powered nested-verification pilot results

Status: **executed; predeclared threshold not met**. No direction is claimed, no result was
promoted into `eval-results/latest.json`, and nothing was published.

## Provenance

Executed under the [predeclared plan](2026-11-25-powered-pilot-plan.md), with no design
parameter changed between predeclaration and execution.

| Field | Value |
| --- | --- |
| Run id | `4bc66155-390f-4b93-a4e9-4c05adb6d6e5` |
| Seed / order | `nested-stale-verification-v2` / `alternate` |
| Repetitions | 10 pairs, 20 invocations |
| Model | `opencode/hy4-flash-free` (small), `$0` |
| Source commit | `459130d9d0b1ca3ef68fa833008cde481d8ea908` |
| Implementation digest | `6c7b4b7c413c9e7de0dec0723ef226cd99874db047956a20f15c002caef9a1b1` |
| Harness digest | `1a167b4ef67b269dd3cd45217eb5faa039b0813c254b0aa4a6fec59325e76edd` |
| Bundle digest | `e0933dd464e3a542f3d52631221aa1bd3c5632931575ca1cb2980ac46e24f40d` |
| Scenario hash | `94d0ce2e080f8f3b7539d8b0e106cb7325f1428a296d569c50e8aa7f39c72b46` |
| Source hash | `272d720daee732958fef0768e107eb57daf77b6d2eb4b15ec7dbf69b08933a6d` |
| Node | `v24.13.0` |
| Completion | `partial` (subset by design) |
| Run record SHA-256 | `6f8e6712857a9621958b1a9170bd30b163479be64c0db4de139730de64e464c0` |

The run record, sanitized free-only config and checksum are retained under
`eval-results/pilots/4bc66155-390f-4b93-a4e9-4c05adb6d6e5/`. The previous partial run
`a93dbde0-4a08-4bcc-af1d-540851352dc2` was archived, not overwritten.

## Results

| Pair | bare | anvil |
| ---: | --- | --- |
| 0 | fail | fail |
| 1 | pass | pass |
| 2 | fail | pass |
| 3 | pass | fail |
| 4 | pass | pass |
| 5 | pass | fail |
| 6 | fail | pass |
| 7 | fail | fail |
| 8 | pass | pass |
| 9 | pass | pass |

- Complete pairs: 10. Run errors: 0. Incomplete pairs: 0.
- Task success: both 4, anvil only 2, bare only 2, neither 2.
- Every successful run has a broker attestation of `node verify.js` from `packages/sub` with
  exit code 0. Failed runs have `not-observed` attestations.
- Successful-pair time: bare 79s, anvil 68s (n=4). This is descriptive; time does not change
  the verdict.
- Cost and tokens: `null`. No ledger price was reported, so no cost claim is made.

**Verdict: insufficient evidence.** Two pairs went each way; the pairs do not separate the
variants. The predeclared rule requires at least three one-sided wins for one variant and a
margin of two. Neither variant qualifies.

## Interpretation

Doubling the sample did not produce a direction. The first run had anvil only 2 / bare only 0
on five pairs; this run has 2 / 2 on ten. Under the predeclared rules these runs are **not
pooled**, and neither supports an effectiveness claim. The sum of both is not a result.

The anvil-only and bare-only wins both occurred under the same scenario, model, seed family
and configuration. The retained records do not contain agent reports or bounded failure
reasons, so why a given arm failed cannot be attributed from this evidence alone.

## Instrumentation added after this run

The harness now retains `verificationAttempts` beside the execution attestation for
execution-capture scenarios: each records the runner and script operand of an invocation that
matched or nearly matched the declared check, its exit status, and the effective directory
relative to the worktree. Extra arguments and shell chains are classified rather than copied,
so a secret or a host path cannot enter a committed record. A command that matched the check is
marked, but it is still an observation — the harness-controlled broker execution remains the
only evidence that grades the result. This answers a question the attestation alone left open:
was the check never attempted, or attempted in the wrong directory or under a mistyped name?

This record predates that instrumentation and has not been rerun. It is not a third run, not a
reinterpretation of the ten pairs, and not permission to design one from these numbers — the
stop rule below still applies.

## Stop

The predeclared plan fixes the outcome rule: *"Claim a direction only if the predeclared
threshold is met. If it is not, say insufficient evidence and stop; do not design a third run
from the observed numbers."* The threshold was not met, so no third run was designed or
launched.

## Consequence for launch

The capability and conformance claim in
[2026-11-25-launch-claim.md](2026-11-25-launch-claim.md) stands: anvil derives verified,
evidence-linked context without a model, and named the correct verify command on three of
four predeclared ground-truth cards. No controlled run has established that an agent using
anvil completes these tasks faster or more reliably. Any effectiveness claim would need a
new predeclared decision with a different design, not a selection among these results.
