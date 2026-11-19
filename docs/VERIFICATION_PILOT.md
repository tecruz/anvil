# Paired pilot: verifying a nested project with stale instructions

**Status: offline controls implemented; real-model pilot not authorized.** The fixture,
scenario and scoring are in place and covered by hermetic tests. No model has been called.
This document does not authorize model calls, spend, or a workflow dispatch. The
[installed-skill pilot](evidence/2026-11-14-skill-guidance.md) tied on task success in all
three pairs; this pilot asks a different question about the guidance Anvil generates.

## Question and comparison

Does generated Anvil context help an agent find and run a supported verification command
from the correct directory when the root README points to a retired command?

Use one dependency-free Node ESM fixture and one verify-only task. Start both variants
from the same fixture commit with identical prompts, agent settings, tool access, and time
limits, in fresh worktrees and sessions. Only the `anvil` variant gets the normal
`anvil init` artifacts; no skill installation, manually added hints, or live discovery.
Both variants can inspect the same checked-in evidence. Scope the conclusion to this
fixture, model, and configuration: the comparison measures the bundle of generated
context, not which artifact the agent read or which Anvil feature caused the result.

## Fixture and task

The opt-in extended scenario is `nested-stale-verification`. The existing cases and smoke
baseline are unchanged. The existing `nested-project` verifier runs in the detected
directory after the agent finishes; it does not prove the agent used that directory.
`misleading-docs` scores a named command in a report, not whether it ran. Running either
unchanged would answer a different question.

- The root README recommends the retired npm script `test:old` from the repository root.
  The real package lives in `packages/sub`; `test:old` does not exist. Declare one supported
  check in the fixture's `anvil.config.json`: `kind: test`, `cmd: node verify.js`,
  `dir: packages/sub`. The declaration and script are visible to both variants.
  Use a standalone ESM check with no dependencies or mutable imports so the existing
  Node execution broker can capture it.
- Give both variants the same task: “Find and run the project's supported verification
  check. Run it as a standalone command from its working directory using the supplied
  Node on PATH. Write `.anvil-eval-report.json` at the repository root with `command`,
  `cwd` (repo-relative), and `exitCode`. Do not change project or verification files.”
  Do not reveal the command, directory, or which documentation is stale.
- `scripts/test/eval-nested-verification.test.ts` confirms that `anvil init` puts both
  `node verify.js` and `cd packages/sub` into the staged `AGENTS.md` and verify skill,
  without hand-editing generated guidance. The same file drives the real broker with a
  local agent stub for the scoring cases below.

## Scoring and evidence

**Primary outcome:** the agent ran the supported command in `packages/sub`, reported
the observed exit code correctly, and left the project and verifier files unchanged
relative to that variant's pre-agent state. A later independent verifier may check
the report and fixture integrity; its own green exit is not proof of agent execution.
A wrong command followed by a correct one can still succeed: this measures successful
verification by the deadline, not first-attempt accuracy.

The [execution broker](../scripts/eval-check-broker.ts) now accepts an explicit
fixture-relative capture directory (`captureDir`); existing callers default to the root.
The attestation is bound to the pre-agent script hash and the broker's canonical
working directory. Require agreement with a completed shell event for the standalone
command and its real exit status. Record the broker's repository-relative directory,
never a claimed directory from the report or a directory inferred by profiling the
post-agent tree. Record the report verdict separately from execution evidence. This is a
provenance check for controlled fixtures, not a sandbox.

| Observation | Scoring |
| --- | --- |
| Attested command and directory, matching report, unchanged fixture | Task success |
| Retired command only, wrong directory, skipped execution with functioning capture, inaccurate report, or changed protected file | Task failure, not a harness error |
| Missing check declaration, provider failure, agent exit, or timeout | Run error with reason; no directional comparison for that pair |
| A variant never started | Incomplete pair; no invented outcome |

An instrumentation fault that merely causes no recorded execution is indistinguishable from
an agent that skipped the check, and is currently scored as a task failure. The harness
retains a bounded `executionAttestation` (status, command, cwd, exit code, source hash and
reason) in the summary and run record, so a reviewer can reclassify such a pair from the
saved evidence. The scratch `executions.jsonl` is not retained. This limitation is part of the
pilot's scope, not evidence that capture is sound in general. The task-failure reason and
attestation round-trip through the typed parsers and resume mapping.

The scoped classification applies to directory-bound scenarios. Older capture scenarios keep
their original run-error semantics. The offline test drives the real broker and event parser
through an agent stub for the correct path, the exactly generated `cd … && node verify.js`
command, the same command from the wrong directory, the retired command, a report without a
run, a modified check, a same-exit swap that bypasses the broker, and a modified protected
file. `--fake-agent` alone takes a shortcut around the broker, so it is not evidence for these
controls.

Protected fixture paths are fingerprinted before the agent starts and the digests are given
only to the hidden verifier. It compares exact bytes, so adding a substring to a rewritten
README does not count as leaving it unchanged.

Keep a bounded, structured record for each attempt: execution verdict and reason, expected
and observed command/cwd/exit where attributable, source hash, report agreement, and project
integrity. Do not keep raw tool streams or transcripts. Report paired counts (both, Anvil
only, bare only, neither), run errors and incomplete pairs. Report durations only across
pairs where both variants succeeded, and ledger cost only where both are priced. Missing
measurements remain unknown, and no result is evidence of general product effectiveness.

## Budget and decision

Propose **five pairs (ten invocations total)**, counterbalanced in one subset run with
`--order alternate` and seed `nested-stale-verification-v1`. Set a five-minute agent timeout
(50 minutes of agent time if all invocations reach the limit), plus a separate 60-minute
wall-clock stop including harness overhead. If either limit cuts the run short, retain and
report the partial result. Do not rerun failed or timed-out keys or add pairs to reach
a favorable result.

Propose **$0 model spend only**, using `opencode/deepseek-v4.1-flash-free`, the current
`small` model in [eval/models.json](../eval/models.json). Before seeking approval, pin
the clean source commit and runtime versions. Before execution, recheck availability and zero catalog
pricing in an isolated, free-only agent configuration with no paid fallback or provider
keys. If that cannot be established, stop. The free tier or a zero-spend approval is not
a ledger measurement.

Use the existing [paired direction rule](../eval-results/README.md#verdicts): at least
five usable pairs, at least three one-sided successes for one variant, and a margin of at
least two. This is a predeclared threshold, not a significance test. If Anvil trails,
inspect its generated command and directory guidance first. If both arms tie, report
insufficient evidence and distinguish a ceiling (both reliably succeeded) from a task or
instrumentation problem. Do not retune the same pilot after seeing results.

Preview the declared selection without calling a model:

```bash
npm run eval -- --dry-run --suite extended --scenario nested-stale-verification --repetitions 5 --models small --seed nested-stale-verification-v1 --order alternate
```

Go live only after the offline controls pass and the maintainer approves this exact run.
Run locally from a clean, disposable checkout, not the scheduled benchmark. Keep the
record, paired results, sanitized configuration, and run-record checksum under
`eval-results/pilots/<runId>/`. Record the exact source, harness, fixture and bundle hashes
and runtime versions. A `--scenario` run stays a subset: do not promote it into
`latest.json` or offer it to the full-matrix benchmark gate.
