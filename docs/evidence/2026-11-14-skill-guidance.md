# Skill-guidance pilot — 2026-11-14

## Scope and authorization

The maintainer approved six real-agent invocations, with **$0 model spend only** and no
paid-model fallback. This was the first, bounded installed-skill pilot, not the larger
extended-corpus experiment. Publication was separately put on hold; no release tag or
package publication is authorized by this pilot.

The run used `opencode/deepseek-v4.1-flash-free`, whose catalog input, output and cache
prices were zero. OpenCode 2.1.4 was installed in a temporary directory, without changing
the user's global CLI. The pilot used separate OpenCode data/config/cache/state paths,
no provider API keys, and a provider policy permitting only `opencode`. Other selectable
models were disabled. The startup guard reported:

```text
Free-only guard passed: opencode/deepseek-v4.1-flash-free; no other selectable models.
```

These are normal OpenCode configuration controls, not an operating-system sandbox.
Only controlled benchmark fixtures were submitted; transcripts were not published.

## Reproduction and retained evidence

- Source commit: `b7db931e27a32aa0c35b462a2d0846ae6728abfd`.
- Run ID: `2074b7a8-5753-4904-ad32-1dfaa72d4b62`.
- Runtime: Windows x64, Node `v24.13.0`, OpenCode `2.1.4`.
- Seed: `20261114-skill-guidance-free`; order: `alternate`.
- [Original structured run record](../../eval-results/pilots/2074b7a8-5753-4904-ad32-1dfaa72d4b62/run.json),
  including implementation, harness, fixture and CLI-bundle digests.
- Run-record SHA-256: `a4c5fedc3da2353ff80a1197743b53c9154ed55ef2be885fcc0aae4575df4660`.
  The retained record was verified byte-identical to the harness output.
- [Free-only OpenCode configuration](../../eval-results/pilots/2074b7a8-5753-4904-ad32-1dfaa72d4b62/opencode-config.json),
  used only in the pilot's separate configuration directory.

The existing harness ran in a disposable clone with `ANVIL_EVAL=1`:

```bash
node scripts/eval.ts --suite extended --scenario skill-guidance --repetitions 3 --models small --seed 20261114-skill-guidance-free --order alternate
```

Each repetition was a two-invocation paired batch, with the existing ten-minute timeout
on each agent invocation. Both variants received the same derived Anvil context; only the
treatment variant had the approved skill installed. No failed invocation was retried and
no paid model was substituted.

The record is intentionally `subset: true`, `completionState: "partial"`: all six selected
keys completed, but this is not a full smoke-matrix run. It did not promote or replace the
hermetic `eval-results/latest.json` or `baseline.json`.

It lives in `eval-results/pilots/<runId>/` rather than `eval-results/runs/` because that
archive holds records superseded by a promoted summary; this pilot never promoted, and the
bundle keeps the run record beside the exact OpenCode configuration that produced it.

## Results

Every run passed both the visible and hidden verifiers, with zero run errors and one
attempt per selected key.

| Repetition | Execution order | Bare duration | Skill duration | Bare visible/hidden | Skill visible/hidden |
| --- | --- | --- | --- | --- | --- |
| 0 | bare, skill | 39.358s | 35.741s | pass/pass | pass/pass |
| 1 | skill, bare | 42.866s | 48.097s | pass/pass | pass/pass |
| 2 | bare, skill | 74.074s | 101.436s | pass/pass | pass/pass |

- Paired task success: both succeeded in **3/3 pairs**; neither variant had a unique success.
- Mean successful duration: **52.10s bare**, **61.76s skill**. These are end-to-end scenario
  durations, including preparation, skill installation where applicable, and verification;
  they are not isolated model-inference timings.
- Skill installation: independently verified in **3/3 treatment runs**.
- Skill access: **unknown in all three treatment runs**. Successful installation and task
  completion do not prove the agent read or followed the skill. The retained sessions show
  why; see [the diagnosis](#diagnosis-of-the-unknown-access-verdicts).
- Cost and token measurements: **unknown** (`null` in every result). Zero catalog prices
  and a zero-spend authorization must not be presented as a measured zero-dollar ledger result.

## Diagnosis of the unknown access verdicts

The scenario worktrees were discarded, but the pilot ran with separate OpenCode data,
config, cache and state paths, and its data directory survived under
`%TEMP%/opencode/anvil-skill-pilot-<hash>/data/opencode.db`. That database retains all six
sessions and their tool parts, so what each agent did is still inspectable without another
model call:

| Repetition | Treatment agent's tool use | Recorded verdict |
| --- | --- | --- |
| 0 | `skill` load of `release-notes`; no read of the installed file | `unknown` |
| 1 | completed `read` of this worktree's `.agents/skills/release-notes/SKILL.md` | `unknown` |
| 2 | `skill` load of `release-notes`; no read of the installed file | `unknown` |

Repetitions 0 and 2 are the documented rule working as intended: a native `skill` load
reports only an id, another configured source can define the same id, and a load alone is
therefore not attributable.

Repetition 1 is the anomaly. The agent opened the exact installed artifact, and a hermetic
reproduction of the same install → read → verdict path returns `observed`. The run record did
not retain *why* its verdict was `unknown`, so that run cannot be reclassified after the
fact: `unknown` conflated "no tool events were parsed", "the artifact no longer matched its
captured identity" and "the id was loaded natively", which are different findings.

The harness now records `skillAccessReason` beside `skillAccess` — `no-tool-events`,
`artifact-not-attributable`, `native-load-unattributable`, `read-of-installed-artifact`,
`no-read-of-installed-artifact` or `not-installed` — in checkpoints, the run record and the
summary, and the gate refuses a reason that argues against its verdict. No new model calls
were made. The original verdicts, cost and the no-benefit conclusion are unchanged.

## Interpretation and next decision

This is an exploratory three-pair measurement on one tiny JavaScript scenario and one
free model. It establishes that the installed-skill evaluation loop can execute real-agent
comparisons; it does **not** establish improved task success, lower cost, or a statistically
meaningful performance difference. The treatment was slower on average in this sample.
Unknown access evidence prevents attributing any observed behavior to reading the skill.

Keep the scheduled smoke workload unchanged. The retained-metadata investigation above is
complete: two runs loaded the skill by id and the third read the installed file, but the
harness recorded none of the three as an attributable read. That does not justify rerunning
the pilot. Do not spend on a broader experiment or change the scenario to obtain a favorable
result on the strength of this sample.
