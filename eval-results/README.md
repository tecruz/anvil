# Eval evidence

This directory holds two different kinds of evidence, and they must not be mixed.

## Hermetic harness checks

- `latest.json` is the promoted summary produced by `npm run eval -- --fake-agent`. Every
  result names `fake-agent`, a canned answer; **no model was called and no tokens were
  spent**. It checks the evaluation machinery, not AI effectiveness.
- `baseline.json` is the scenario/fixture baseline that `npm run eval:check` compares
  `latest.json` against. It contains no model result.
- `run.json` and `runs/<runId>.json` are the provenance of the promoted run: the
  implementation, harness, fixture and bundle digests, attempts and completion state.
- `checkpoints/` and `raw/` are regenerated scratch output and are ignored by Git.

`npm run eval:check` only reads the hermetic files above. It never compares a real-agent
record with `latest.json`.

## Real-agent records

- `pilots/<runId>/` holds an explicitly approved real-agent run: its run record and the
  exact model configuration used. A pilot is `subset: true` and never promotes to
  `latest.json`.
- A real-agent record is evidence only for the scenarios, model, repetitions and conditions
  it names. Its cost, duration or skill-access fields stay `unknown`/`null` when the run did
  not measure them.

The console report prints an `Evidence source` line and a per-group `verdict`. A verdict
counts observed pairs and needs at least five complete pairs before it calls a direction;
it is not a significance test. The hermetic summary in this directory therefore reports
`insufficient evidence`, not an effectiveness claim.
