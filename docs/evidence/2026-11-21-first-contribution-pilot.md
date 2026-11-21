# 2026-11-21 — first-contribution pilot results

Status: **executed directional pilot**. All four approved real-agent runs completed locally. No result was promoted into `eval-results/latest.json`, and nothing was published.

## Scope and authorization

The maintainer approved the exact zero-cost run on 2026-11-21: four scenarios, three repetitions each, counterbalanced with `--order alternate`, seed `pilot-2026-11-21`, model `opencode/hy4-flash-free`, isolated config/data/cache/state paths, no paid fallback, and local retention under `eval-results/pilots/<runId>/`.

- Pilot branch commit: `3aec8a075194769c98f967a6133470c7250ae77b`
- Implementation digest: `6c7b4b7c413c9e7de0dec0723ef226cd99874db047956a20f15c002caef9a1b1`
- Harness digest: `30aa1032f21ee3e346b75f7890d979a6736fe1f4fb029b36e1657fe96bfbad64`
- Node: `v24.13.0`
- Model: `opencode/hy4-flash-free` (catalog cost 0/0)
- Cost and tokens: `null` for every run; the host ledger did not report a value.
- Ground truth: [pilot-ground-truth-2026-11-20.md](pilot-ground-truth-2026-11-20.md)
- 3D decision: [ADR-0027](../adr/0027-3d-comparison-postponed.md) — postponed; no prototype or participants, so insufficient evidence rather than a negative verdict.

Each run is a subset (`subset: true`, `completionState: partial`) and never enters the hermetic gate. The canonical free-only config is retained beside each run record as `opencode-config.json`; it allows only the `opencode` provider and denies subagents and external-directory tools.

An earlier attempt to launch the wrapper failed in PowerShell before any agent invocation: native stderr was treated as a terminating error by `$ErrorActionPreference = 'Stop'`. It produced no model calls and is not counted as a run. The wrapper now keeps stderr as data. Only the four retained run ids below are reported.

This pilot compares Anvil-generated CLI context with a bare checkout at the same commit. The task-centred 2D dashboard map is on the unmerged `feat/task-brief` branch, so this run did not exercise that UI. ADR-0027 records the separate 3D decision.

## Run records

The retained records keep the scenario and source hashes that existed at run time. Scenario verifiers were tightened after the run; the canned fake-agent answers and the four retained real run records were not rewritten, so the hashes below describe the executed definitions rather than today's file bytes.

| Scenario | Run id | Retained record SHA-256 |
| --- | --- | --- |
| `pilot-countrytracker` | `5bbb5164-70a9-4f19-8f0a-36e378819fdd` | `5359EF5E4BDD173B4D80C1EAD171A1AAC8BF05F20A67A6FFD38ECC4AB445A3C4` |
| `pilot-nbim` | `bf33172e-b209-43f9-b64e-f87d72969a84` | `CE36961C09DA9222F0A6CEDF7BD910F32DA1920D7A735E6D0F7B1F1374758835` |
| `pilot-conventional-wordcount` | `7862b05c-b704-4240-a34c-4c5d2866440d` | `299DF0864E36B5B20891031396589C7311522DB378F37A8B6888278DCBE7E4D2` |
| `pilot-books-blocked` | `f2bbd284-d3a0-47ae-a68d-787b1d23a758` | `D2470795E9A40D7AB118C608055C0ED521E309FBD66F50E2E722310BAFD3BA99` |

## Results

All four runs completed six invocations each (3 repetitions × bare/anvil) with zero run errors and zero incomplete pairs. The harness `verified` flag is the terminal-state proxy; it does not by itself prove that the task's ground-truth card was satisfied. The harness did not retain the agent-written report or a bounded failure reason, so card-match and terminal-state classification are not scored here. The three unsuccessful scenarios need that instrumentation before a product conclusion.

| Scenario | Complete pairs | Both succeeded | Anvil only | Bare only | Neither | Verdict |
| --- | ---: | ---: | ---: | ---: | ---: | --- |
| `pilot-countrytracker` | 3 | 0 | 0 | 0 | 3 | Insufficient evidence; all verifier exits were `1` |
| `pilot-nbim` | 3 | 3 | 0 | 0 | 0 | Insufficient evidence; 3 pairs is below the 5-pair threshold |
| `pilot-conventional-wordcount` | 3 | 0 | 0 | 0 | 3 | Insufficient evidence; all verifier exits were `1` |
| `pilot-books-blocked` | 3 | 0 | 0 | 0 | 3 | Insufficient evidence; all verifier exits were `1` |

For `pilot-nbim`, successful-pair mean durations were bare `124s` and anvil `88s` (n=3). This is descriptive only: the predeclared direction rule needs five usable pairs, so there is no adoption claim. No other scenario had a pair where both variants succeeded, so no time comparison is reported.

## Interpretation

- The harness and model setup were valid: every planned invocation ran, no run errors were recorded, and `latest.json` was unchanged.
- `pilot-nbim` reached the bounded report verifier in all six invocations. The direction favours Anvil in this small sample, but it is not a verdict.
- CountryTracker, the conventional fixture, and Books did not satisfy their report verifiers in any invocation. That may be a task/report-contract problem or a product problem; this pilot cannot distinguish them from the retained records alone. Do not claim that Anvil failed those repositories, and do not claim that the blocker handoff was confirmed.
- The blocked repository's required owner confirmation was not obtained. Its classification remains a ground-truth expectation, not a validated outcome.
- No cross-repository or cross-model pooling is made. Cost and tokens stay unknown.

## Follow-up required before an adoption decision

1. Inspect one retained report/verifier failure per unsuccessful scenario and correct the task or verifier contract if it was at fault; then predeclare and approve a new run rather than retrying for a favourable result.
2. Add at least two more repetitions per scenario if the direction rule is to be applied.
3. Obtain the blocked repository owner's confirmation before counting an accurate handoff as an outcome.
4. Treat the 3D question as separately blocked under ADR-0027.
