# 2026-11-25 — predeclared powered pilot plan (awaiting decision)

Status: **executed; predeclared threshold not met**. This document fixed the design, seed,
threshold and stop rules *before* any model call. The maintainer approved this exact run on
2026-11-25; no design parameter changed between predeclaration and execution. See
[the results](2026-11-25-powered-pilot-results.md).

## Why a new run

The authorized 5-pair nested-stale-verification pilot
([results](2026-11-25-nested-verification-pilot.md)) produced 5 usable pairs with anvil only
2, bare only 0, both 2, neither 1. The predeclared rule needs at least 3 one-sided wins, so
the verdict was insufficient evidence. Where both variants succeeded, anvil was slower
(100s vs 83s). No direction may be claimed from that run.

This plan is a **new experiment with a new seed and a larger, fixed sample**, not a retry of
failed keys and not an addition of pairs to an existing run. It is written before execution
so the threshold cannot be chosen after seeing results.

## Predeclared design

| Field | Value |
| --- | --- |
| Scenario | `nested-stale-verification` (unchanged) |
| Seed | `nested-stale-verification-v2` (new; v1 is never resumed or pooled) |
| Repetitions | **10** pairs, 20 agent invocations, `--order alternate` |
| Model | `opencode/hy4-flash-free` (small), `$0` only, no paid fallback |
| Config | isolated free-only `opencode-config.json`; no subagents, no external-directory tools, no other providers |
| Per-invocation timeout | 5 minutes (scenario default) |
| Agent-time bound | 100 minutes if every invocation hits its timeout |
| Wall-clock stop | 120 minutes local; if reached, retain and report the partial result |
| Decision rule | **unchanged**: ≥5 usable pairs, ≥3 one-sided wins for the winning variant, margin ≥2 |
| Promotion | none; subset run stays under `eval-results/pilots/<runId>/` |

The dry-run for exactly this command reports: 1 scenario, 1 model, 10 repetitions, 20 of 20
agent runs, 100-minute agent-time bound. It warns that this exceeds the *scheduled
workflow's* 60-minute ceiling. This run is local, not scheduled, so the local 120-minute
wall-clock stop applies instead; the warning is recorded rather than ignored.

## Stop rules, fixed in advance

- Do not rerun failed or timed-out keys.
- Do not add pairs after the run starts, or after seeing results.
- Do not pool this run with `a93dbde0-4a08-4bcc-af1d-540851352dc2`, the first-contribution
  pilot, or any other scenario or model.
- Do not promote any record into `eval-results/latest.json`.
- Report paired counts, run errors, durations only where both variants succeeded, and cost
  as `null` unless the host ledger reports it.
- Claim a direction **only** if the predeclared threshold is met. If it is not, say
  insufficient evidence and stop; do not design a third run from the observed numbers.

## Preconditions already verified

- `npm run eval:check` → gate passed after hermetic evidence regeneration.
- Offline broker controls: `node --test scripts/test/eval-nested-verification.test.ts` →
  4 tests, 4 passed, 0 failed.
- `--dry-run` for the exact command staged 20 invocations with `opencode/hy4-flash-free`.
- Availability probe with `opencode/hy4-flash-free` returned `cost: 0` under the isolated
  config.

## Exact command

```bash
ANVIL_EVAL=1 npm run eval -- --suite extended --scenario nested-stale-verification \
  --repetitions 10 --models small --seed nested-stale-verification-v2 --order alternate
```
