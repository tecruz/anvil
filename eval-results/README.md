# Eval evidence

This directory holds two different kinds of evidence, and they must not be mixed.

## Hermetic harness checks

- `latest.json` is the promoted summary produced by `npm run eval -- --fake-agent`. Every
  result names `fake-agent`, a canned answer; **no model was called and no tokens were
  spent**. It checks the evaluation machinery, not AI effectiveness. This is enforced: the
  harness does not promote a completed run with any other model into `latest.json`, and
  `npm run eval:check` fails if `latest.json`, its run record or the record's declared models
  name anything but `fake-agent` (a result with no model recorded is refused too).
- `baseline.json` is the scenario/fixture baseline that `npm run eval:check` compares
  `latest.json` against. It contains no model result.
- `run.json` and `runs/<runId>.json` are the provenance of the promoted run: the
  implementation, harness, fixture and bundle digests, attempts and completion state.
- `checkpoints/` and `raw/` are regenerated scratch output and are ignored by Git.

`runs/a9bf3455-af1e-4306-9957-ce37492c08d8.json` is superseded historical evidence, kept as
history and not rewritten. Its `commitSha` (`44d342e`, the base of #77) is mis-attributed:
the evidence was produced from the then-uncommitted #77 changes, and its digests match
`d058848`, not `44d342e`. Do not read it as provenance for `44d342e`.

`npm run eval:check` only reads the hermetic files above. It never compares a real-agent
record with `latest.json`. A real-agent run still writes its run record to `run.json` and
`runs/` while it runs; move it under `pilots/` rather than committing it here.

## The two gates

The harness has one gate per evidence channel, and they are not interchangeable:

- **Hermetic gate:** `npm run eval:check` (`npm run eval -- --check`). It reads
  `latest.json` and the run record it names, refuses any model other than `fake-agent`, and
  compares the summary with `baseline.json`. CI runs this on every leg.
- **Benchmark gate:** `npm run eval -- --check-run <runId>`. It validates the real-agent
  run this invocation produced: the record must name that exact run id, come from the same
  commit, declare the requested matrix, and pass the same baseline, provenance and verifier
  checks. It refuses a fake-agent record and never reads or writes `latest.json`. On success
  it writes `benchmark-summary.json` beside the run record, labelled `evidence: "real-agent"`.
  The scheduled `Eval benchmark` workflow runs it instead of `eval:check`.

A benchmark summary is per-run output and is ignored by Git. It is not promoted evidence; to
retain a real-agent run, move its record and summary under `pilots/<runId>/` deliberately.

## Failure rehearsal

A dispatch of the `Eval benchmark` workflow with `rehearse_failure: true` skips the real-model
job and runs a separate hermetic rehearsal instead. It calls no model and receives no provider
keys. The rehearsal runs `--fake-agent`, confirms the committed gate passes, tampers with one
visible result, asserts that the gate rejects the tampered summary, then fails on purpose.
Required artifacts are validated before the deliberate failure, and the
`upload rehearsal artifacts` step is `if: always()` and retains only
`failure-rehearsal.json`, `gate-rejection.log`, `run.json`, the run archive and checkpoints for
30 days. The job summary reports the actual step outcomes and claims retention only after a
successful upload. The tampered summary exists only in the ephemeral runner checkout so the
gate has a modified file to reject; it is never committed or uploaded. None of this is
product effectiveness evidence. The approved dispatch on 2026-11-17 retained the artifact;
the run id, file hashes and verification results are recorded in
[the retention evidence record](../docs/evidence/2026-11-17-artifact-retention.md) and
[IMPROVEMENT_PLAN.md](../docs/IMPROVEMENT_PLAN.md#phase-1--preserve-evidence-and-survive-interrupted-runs).

## Real-agent records

- `pilots/<runId>/` holds an explicitly approved real-agent run: its run record and the
  exact model configuration used. The retained pilot is `subset: true`; any real-agent run is
  refused promotion into `latest.json`.
- A real-agent record is evidence only for the scenarios, model, repetitions and conditions
  it names. Its cost, token, duration or skill-access fields stay `unknown`/`null` when the
  run did not measure them.

## Verdicts

Verdicts appear only in the console report that `npm run eval` prints at the end of a run;
`latest.json` and the run records hold results, not verdicts. The report prints an
`Evidence source` line, then one `verdict` per scenario and model:

- A direction (`measured improvement` or `measured regression`) needs **five usable pairs**
  (both variants have a result and neither recorded a run error), **at least three pairs
  where only the winning variant succeeded**, and **a margin of two** such pairs over the
  other variant. 3-0 and 3-1 are called; 1-0, 2-0, 3-2 and ties are `insufficient evidence`.
- A pair with a run error on either side (agent timeout or exit, or a harness failure such
  as a failed skill installation) is excluded from the verdict and counted on its own line.
- The report's totals are descriptive. Groups are never pooled into an overall verdict.
- These are thresholds for a small sample, not a significance test.

A fake-agent run's console report shows `insufficient evidence` for every group (one pair
each, all tied), which is expected: it is a machinery check, not an effectiveness claim.
