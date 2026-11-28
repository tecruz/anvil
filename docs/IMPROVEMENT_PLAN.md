# Implementation plan: reliability, evidence, and distribution

Status: **Phases 0, 1, 2A/B and 3 implemented, with acceptance evidence reconciled
2026-11-14.** The bounded Phase 2 real-agent pilot is complete, with an exploratory tie,
unknown cost, and skill-access evidence that was diagnosed from local, uncommitted session
observations rather than rerun. Phase 4's installed-CLI matrix passes on all six CI legs,
and `@anvil-workflows/cli` `0.2.0` and `0.2.1` were published on 2026-11-26. The Phase 0
merge-gate demonstration was recorded on 2026-11-14, and the Phase 1 artifact-retention
demonstration was recorded on 2026-11-17. No Phase 4 criterion remains open.
Prepared: 2026-10-27, after the corrective hardening in PR #4.

This is the next implementation cycle, not a rewrite of the completed
[M0–M6 plan](../IMPLEMENTATION_PLAN.md). The goal is to demonstrate that anvil helps
agents finish real work, retain trustworthy evidence, and make failures and installation
predictable. Adding more commands, trackers, or agent integrations is out of scope.

## Constraints

- The product CLI remains deterministic and model-free, and detection runs offline. `plan`
  and `brief` enrich from a cache-bounded network fetch that `--offline` disables; real-model
  calls belong only to the explicitly enabled benchmark harness.
- No telemetry or hosted service. Benchmark artifacts concern controlled fixtures, not
  a user's repositories or usage history. See [ADR-0010](adr/0010-cost-is-read-from-the-hosts-ledger.md).
- Keep existing JSON contracts readable, or introduce explicit schema versions and migration
  tests. Unknown measurements remain `null`, not zero or an inferred estimate.
- The maintainer is working alone: required CI must not depend on a second reviewer.
- Repository settings, paid runs, npm names, and publishing each need explicit maintainer
  approval. This plan does not apply settings, spend tokens, or publish anything.
- Changes to `.github/workflows/**` are high-risk under [AGENTS.md](../AGENTS.md).
  Flag them in their PRs; retain pinned actions, least-privilege permissions, and blocking checks.

## Delivery order

| Phase | Deliverable | Depends on | Relative effort |
| --- | --- | --- | --- |
| 0 | Enforced merge checks | Maintainer/settings access | Small |
| 1 | Recoverable, retained benchmark evidence | Phase 0 preferred | Medium |
| 2 | Repeated paired comparisons and a useful scenario corpus | Phase 1 | Large |
| 3 | Lifecycle failure and recovery tests | Independent of benchmark work | Medium |
| 4 | Versioned prebuilt distribution | Phases 0 and 3; release decisions | Medium |

Use small, independently reviewable PRs. Phase 3 can be scheduled before Phase 2 if
failure-injection tests expose a correctness issue. Do not delay a confirmed safety fix
until benchmark or release work is finished.

## Phase 0 — Enforce the merge policy

**Outcome:** a green result for an earlier commit cannot authorize merging a newer one.
**Status:** complete. The repository was made public (API PATCH `repos/tecruz/anvil` with
`private=false`), and branch protection was configured via the GitHub API
(`PUT branches/main/protection`), with force pushes and deletions blocked, administrator
bypass disabled (`enforce_admins: true`), and pull requests required with zero approving
reviewers (solo maintainer). The merge checklist in
[CONTRIBUTING.md](../CONTRIBUTING.md) describes an enforced gate.

Re-verified 2026-11-14, after the Node-version matrix in PR #30 added three `(Node LTS)`
legs. Both the branch protection rules and the `main` ruleset now require **eight**
contexts -- the six matrix legs plus `playbook registry (rot check)` and
`gh contract (live)` -- with `strict: true`, and the ruleset has no bypass actors. The
earlier text in this section said five; it was written before that change.

### Work

1. Inspect the current `main` rules and the repository's GitHub plan/permissions. Record
   the existing configuration before changing it; do not assume a private repository
   supports every ruleset feature.
2. Configure a ruleset or branch protection requiring a PR and these existing CI contexts:
   - `windows-latest`
   - `ubuntu-latest`
   - `macos-latest`
   - `playbook registry (rot check)`
   - `gh contract (live)`
3. Require an up-to-date branch or an equivalent tested merge result. Keep routine bypasses
   disabled, prevent force pushes/deletion of `main`, and require zero approving reviewers.
4. Document the maintainer's merge checklist and any emergency bypass procedure in
   [CONTRIBUTING.md](../CONTRIBUTING.md). A bypass must be explicit and recorded, not the normal path.

**Affected surface:** GitHub repository settings and contributor documentation. No workflow
change should be necessary unless inspection reveals a missing check.

### Acceptance

- [x] Verify in a disposable draft PR/test repository that pending, failed, missing, and
  earlier-head checks block merging; the final successful head permits it. Demonstrated
  2026-11-14 in disposable draft PR #44 against the real `main` protection, with no settings
  or workflow change and nothing merged: missing (`31a54d7`, `[skip ci]`), pending and failed
  (`43fffd8`, run 43639842492) and an untested head on top of a green one (`bb8c60c` after
  `261968a`) each reported `mergeStateStatus: BLOCKED`; the green heads `261968a`
  (run 43640518600, attempt 2) and `715145a` (run 43642319922) reported `CLEAN`. See the
  [merge-gate evidence](evidence/2026-11-14-merge-gate.md).
- [x] A single maintainer can still merge after checks pass without finding another reviewer.
  PRs #30 (`43c8637`) and #31 (`c72f164`) were merged by the maintainer with
  `required_approving_review_count: 0` and zero submitted reviews.
- [x] Record the actual settings and verification evidence. The eight required contexts,
  the strict mode and the disabled bypass are recorded in the status above and in
  [CONTRIBUTING.md](../CONTRIBUTING.md#merging-to-main), and were re-read from the GitHub
  API on 2026-11-14.

## Phase 1 — Preserve evidence and survive interrupted runs

**Status:** complete. PR #7 merged into `main` (merge commit `dd380fa`). Checkpoint recovery,
evidence validation, and transcript privacy are implemented, version-2 evidence is regenerated,
and `npm run check` passes: lint, typecheck, 1021 tests, docs check, and eval gate.

**Outcome:** completed benchmark work survives cancellation without an incomplete run
being mistaken for a passing baseline.

### Work

1. Define a benchmark run record separately from the checked-in hermetic summary:
   run ID, schema version, commit SHA, implementation/scenario/fixture hashes, model IDs,
   OpenCode/Node versions, requested run keys, timestamps, execution order, and completion state.
2. Generate or validate build inputs, rebuild the evaluated CLI, and capture its source
   fingerprint and bundle digest before the first scenario. Compare fingerprints at completion;
   refuse to certify results if the implementation or scenario inputs changed mid-run.
3. Checkpoint each completed scenario/variant result immediately. Use same-directory atomic
   replacement where supported; a failed replacement must not delete the last valid checkpoint.
   Distinguish completed, failed, timed-out, and not-started work.
4. Preserve completed checkpoints on termination. Promote an official complete summary only
   when every declared run key is accounted for. Partial scenario selections remain explicitly
   partial; they must not overwrite valid complete evidence with a success-looking report.
5. Add explicit resume support only after checkpointing is reliable. Resume must match the
   implementation, fixtures, models, harness configuration, and requested run keys exactly.
   Do not silently rerun failures until they pass or combine incompatible attempts.
6. Extend the scheduled workflow to upload bounded, allowlisted benchmark artifacts even
   after failure. Use a SHA-pinned upload action, unique artifact names, read-only repository
   permissions, and an initial retention limit of 30 days. Keep the existing job summary.
7. Default published artifacts to structured metadata and verdicts. Transcript publication
   must be opt-in for controlled fixtures, redacted and size-limited before persistence/upload;
   never include credentials, complete environments, provider ledgers, or unreviewed user data.
   Document this benchmark-only policy without changing normal CLI privacy guarantees.

**Primary files:** `scripts/eval.ts`, `scripts/test/`,
`packages/cli/src/eval-gate.ts`, `packages/cli/test/eval-gate.test.ts`,
`.github/workflows/eval.yml`, and [ARCHITECTURE.md](ARCHITECTURE.md).
New checkpoint/report modules can be extracted from the script if that keeps tests focused.

### Acceptance

- [x] Hermetic tests interrupt a run after a known result and verify it remains readable.
  `an interrupted fake-agent run keeps its checkpoint and resume reuses it` in
  `scripts/test/eval-resume.test.ts` starts the real fake-agent harness in an isolated copy,
  waits for the `ANVIL_EVAL_FAKE_HALT_AFTER_CHECKPOINTS` marker line, and SIGKILLs the child
  after two checkpoints. It asserts the second checkpoint parses, `readCheckpointDirectory`
  accepts both checkpoints with zero rejections, `run.json` is still in-progress without the
  halted key, and no `.tmp-*` file remains. `--resume` then reports
  `Recovered completed checkpoints`, reports six of eight keys remaining, and reuses the
  checkpointed attempt's timestamps rather than rerunning the key; the run completes and
  `--check` passes against the baseline. This is a deterministic SIGKILL at a marker, not a
  power-loss or filesystem-durability test.
- [x] Partial, duplicate, corrupt, incompatible, and missing run records cannot pass the gate.
  `packages/cli/test/eval-gate.test.ts` covers each: no record, incomplete run, a subset
  offered as complete evidence, checkpoint hashes that no longer match, unknown schema
  versions, and (added 2026-11-14) duplicate run keys, duplicate execution order and
  duplicate results.
- [x] Resume skips only compatible completed work and records each attempt explicitly.
  The same resume test refuses a checkpoint whose verifier evidence disagrees with the
  matrix, and the gate tests assert attempts accumulate rather than being overwritten.
- [x] Simulated checkpoint-write failure leaves the previous checkpoint intact.
  `atomicWriteJson` in `scripts/eval.ts` takes an injectable rename operation. In
  `scripts/test/eval-run.test.ts`, `a failed rename leaves the previous checkpoint intact
  with no temp file` and `a failed rename on a fresh path leaves no target and no temp file`
  inject a throwing rename and assert the error is rethrown, the target's bytes are unchanged
  and still parse, and no `.tmp-*` file remains (or, for a fresh path, neither a target nor a
  temp file). This covers a failed rename, not a failed write or fsync.
- [x] Implementation changes during a run invalidate the evidence instead of relabeling it.
  `fails when the implementation changed under the run` and
  `fails when the implementation changed` in the gate tests, plus the harness-digest check.
- [x] Synthetic secret markers do not appear in published artifacts or summary output.
  `scripts/test/eval-transcript.test.ts` covers OpenAI, OpenRouter and both GitHub token
  shapes, and `sanitizes errors, verifier output, and transcripts before persistence`.
- [x] A maintainer-approved synthetic CI run demonstrates artifact retention after failure.
  [Run 44056529412](https://github.com/tecruz/anvil/actions/runs/44056529412) dispatched
  `rehearse_failure: true` at `5968521e960d62c3ba59890e389d922e6cbc8e18`. The separate
  hermetic job used `--fake-agent`, confirmed the healthy gate passed, tampered with one
  visible result, asserted the gate rejected it, validated every required file, then failed
  on purpose. The real-model job was skipped, so no provider keys were used and no model was
  called. The `if: always()` upload retained `failure-rehearsal.json`,
  `gate-rejection.log`, `run.json`, the run archive and eight checkpoints as
  `eval-failure-rehearsal-44056529412-attempt1` (9,117 bytes, expires 2026-12-17). The
  downloaded copy was re-validated with the merged checker:
  `Validated 3 files, the run archive and 8 checkpoints.` Details and hashes are in
  [the retention evidence record](evidence/2026-11-17-artifact-retention.md). The rehearsal
  checks live in `scripts/eval-rehearsal.ts` and are covered by
  `scripts/test/eval-rehearsal.test.ts`, so a regression is caught by the normal suite rather
  than only by a dispatch.

## Phase 2 — Measure whether derived context actually helps

**Status:** harness and corpus implemented (Phase 2A in PR #8, Phase 2B in PR #14). The
bounded, approved real-agent pilot completed on 2026-11-14: both variants passed in all
three pairs, with no run errors. Cost remains unknown, and the unknown skill-access verdicts
were diagnosed from local, uncommitted session observations (see the pilot report) rather
than rerun: repetitions 0 and 2 loaded the skill natively by id, while repetition 1 read a
path matching the installed `SKILL.md` and its cause is unresolved. The pilot does not
establish a product benefit. The [pilot report](evidence/2026-11-14-skill-guidance.md)
retains its separate real-agent record; the promoted hermetic summary still uses
`fake-agent` and was not replaced.

**Outcome:** paired measurements show the benefit, cost, or absence of benefit without
conflating harness correctness with agent effectiveness.

### Phase 2A — Repeated comparisons and reporting

**Status:** implemented (MERGED from Phase 2). Core evidence contract v3 includes:
- repetitions/count (CLI `--repetitions`)
- order/seed (CLI `--seed`, `--order`)
- counterbalanced bare/anvil ordering
- per-result repetition field in key tracking
- enriched gate validation of repetition-variant pairing
- lint + typecheck clean
- 97 gate tests pass

**Next decision after the pilot:** keep the scheduled smoke workload unchanged. The
unknown skill-access verdicts were investigated from local, uncommitted OpenCode session
observations without further model calls: repetitions 0 and 2 loaded the skill by id
natively, which is unattributable by design, while repetition 1 made a read whose path
matched the installed `SKILL.md`, was recorded `unknown`, and its cause is unresolved — the
retained run record cannot say why. The harness now records `skillAccessReason` beside the
verdict so a later `unknown` can be told apart without the transcript. Paid models and a
larger experiment require new approval; the six-invocation authorization is used.

### Phase 2B — Extended scenario corpus (planned)

Start with six small, self-contained scenarios targeting these capabilities:

| Capability | What the scenario must demonstrate |
| --- | --- |
| Nested project | Verification runs from the detected subdirectory, not the repo root. |
| Workspace dependency | A change crosses package boundaries and respects the dependency graph. |
| Cross-file regression | A plausible local fix fails a hidden integration test unless related code is updated. |
| Misleading documentation | Stale instructions do not override commands supported by repository evidence. |
| Failing verification | Correctly running and reporting an existing failed check counts as task success. |
| Risk-sensitive change | The task preserves unrelated files and satisfies concrete safety assertions. |

Each scenario needs a known-good solution, a known-bad/no-op control, deterministic
visible/hidden checks, a bounded runtime, and a reason derived context could help.

Verify-only grading is anchored to execution evidence, which is what the original note
asked for and what now exists: the harness records the tool call that ran the check, bound
to the source it executed, so a report cannot pass on a green fixture the agent never ran.
Task success stays separate from whether the repository's checks passed, so a deliberately
broken fixture is not required to become green, and a no-op or incorrect-success report
fails grading. `failing-verification requires a completed agent tool call and an unchanged
check script` (`scripts/test/eval-execution-evidence.test.ts`) and the check-broker tests
pin the behaviour.

1. Preserve the current four-scenario matrix as a cheap smoke suite. The current
   `validateScenarioMatrix()` requires exactly one scenario in each size/kind cell;
   do not append scenarios without deliberately evolving suite validation.
2. Introduce explicit suite/repetition/ordering configuration, with CLI options designed
   and documented during implementation. Assign each result a unique
   `(scenario, model, repetition, variant)` key and version the affected report contracts.
3. Pair bare/anvil runs using identical fixture snapshots, task text, model settings,
   tool permissions, and timeouts. Use independent workdirs and isolated agent configuration;
   neither variant may inherit another run's instructions, conversation, or modifications.
4. Counterbalance variant order across repetitions and persist the order/seed. A seed
   controls experiment ordering, not a promise that the model itself is deterministic.
5. Retain duration, visible/hidden verdicts, agent errors, and available session-ledger
   token/cost measurements in the benchmark report. Prove session attribution first;
   distinguish missing session, missing ledger, and missing price. Do not price tokens by hand.
6. Report paired task-success differences, sample counts, uncertainty, and success-conditioned
   time/cost comparisons. Include failures/timeouts separately so cheap failures cannot look
   like efficiency gains. Do not claim significance from three repetitions.
7. Keep deterministic hermetic correctness in ordinary CI. Treat stochastic real-model
   outcomes as benchmark evidence, not a new flaky required merge check.

### 2B. A useful extended corpus

Start with six small, self-contained scenarios targeting these capabilities:

| Capability | What the scenario must demonstrate |
| --- | --- |
| Nested project | Verification runs from the detected subdirectory, not the repo root. |
| Workspace dependency | A change crosses package boundaries and respects the dependency graph. |
| Cross-file regression | A plausible local fix fails a hidden integration test unless related code is updated. |
| Misleading documentation | Stale instructions do not override commands supported by repository evidence. |
| Failing verification | Correctly running and reporting an existing failed check counts as task success. |
| Risk-sensitive change | The task preserves unrelated files and satisfies concrete safety assertions. |

Each scenario needs a known-good solution, a known-bad/no-op control, deterministic
visible/hidden checks, a bounded runtime, and a reason derived context could help.
Preserve coverage of both repository sizes and both task kinds without requiring exactly
four scenarios in the extended suite. Avoid external service dependencies in fixtures.

Verify-only grading is anchored to execution evidence, which is what the original note
asked for and what now exists: the harness records the tool call that ran the check, bound
to the source it executed, so a report cannot pass on a green fixture the agent never ran.
Task success stays separate from whether the repository's checks passed, so a deliberately
broken fixture is not required to become green, and a no-op or incorrect-success report
fails grading. `failing-verification requires a completed agent tool call and an unchanged
check script` (`scripts/test/eval-execution-evidence.test.ts`) and the check-broker tests
pin the behaviour.

### Installed-skill comparison

`skill-guidance` asks whether an installed, approved skill changes the work. Both variants
receive the same `anvil init` artifacts and the same starting commit
(`baselineContext: "anvil"`); only the anvil variant also receives the skill, installed
through `anvil setup apply`. The harness approves the exact plan itself because the run is
unattended; consumption, the repository lock, the no-replace publish, the journal and the
independent verifier still run for real. The source is staged, committed, installed, then
removed and the artifact committed, so the variant without the skill cannot read the skill
text from the worktree or its reachable history.

The required behaviour lives in the repository both variants can read; the skill carries the
operating procedure. A comparison where only the treatment had the requirements would
measure missing information, not skill-guided work.

Each result keeps three facts apart:

- `skillInstall` — whether installation reported `verified`. A skill scenario's anvil result
  must record it; the bare result must record `not-installed`, and the gate refuses a
  summary or run record that disagrees with that.
- `skillAccess` — `observed` only when a completed read names *this run's* installed
  `SKILL.md`, compared lexically against the artifact's paths; a path from another checkout or
  a copy inside the repository is not the artifact, and a reported path is never resolved
  again after the agent runs, because an alias could have been pointed at the artifact after
  the read. Before the agent runs the harness captures the artifact's written and canonical
  paths, a SHA-256 of its bytes, its size, and its inode identity and timestamps. After the run
  it re-reads only a regular file — never a final symlink or a FIFO, and never more than 1 MiB
  — and requires every captured value to match. A file that was removed, redirected, replaced,
  or even rewritten with identical bytes makes the verdict `unknown`: the write moves the
  change time, which on POSIX an agent cannot set back, so a modify → read → restore sequence
  cannot be attributed. Windows file times can be written back, so there the same sequence can
  still compare equal; treat the verdict as strong evidence, not proof. A native `skill` load
  of the installed id stays `unknown`, because another configured source can define the same
  id and take precedence. A shell command that merely names the path is not evidence,
  `not-observed` is not proof of non-use, and a run with no tool events is `unknown`. A
  scenario without a skill must not record an access verdict.
- `skillAccessReason` — *why* the verdict was reached: `no-tool-events`,
  `artifact-not-attributable`, `native-load-unattributable`, `read-of-installed-artifact`,
  `no-read-of-installed-artifact` or `not-installed`. `artifact-not-attributable` covers a
  failed pre-run identity capture, an artifact that cannot be re-captured after the run
  (deleted, replaced by a non-regular file, redirected so capture failed, larger than
  `MAX_SKILL_BYTES` at 1 MiB, or changed size during the read), and a re-captured identity
  that differs from the captured one. The gate refuses a reason that argues against its
  verdict, and the field is persisted in checkpoints, the run record and the summary so a
  later `unknown` can be investigated after the worktree is gone.
- `verified` / `hiddenVerified` — whether the task's own acceptance checks passed.

The scenario is in the extended suite: it is opt-in and does not expand the weekly smoke
cost. A positive, negative or absent difference is a measurement, and three repetitions are
exploratory rather than proof.

The first pilot should measure the skill alone, because that is the newest and least-proven
part of the loop. Preview it with:

```bash
npm run eval -- --dry-run --suite extended --scenario skill-guidance --repetitions 3
```

Then run the same selection with `ANVIL_EVAL=1` and a model role once the spend is approved.
A `--scenario` selection is a subset run: it keeps its run record and checkpoints but
deliberately never replaces the promoted `latest.json` evidence.

Both the preview and the real run print a preflight with the number of agent invocations, the
worst case if every run hits its own timeout, and an explicit reminder that cost stays unknown
until the host ledger reports it. The console report pairs each repetition's bare and anvil
results: task success is reported separately from run errors (agent timeouts or exits, and
harness setup failures such as a failed skill installation), duration and ledger cost are
averaged only over pairs where both variants succeeded, and any scenario/model comparison with
fewer than five pairs is labelled exploratory rather than presented as a significance result.

### Budget and pilot

- Keep the weekly default at the existing smoke workload until a pilot justifies changing it.
- Initial extended pilot: six scenarios × two variants × three repetitions = **36 agent
  invocations per model**, versus eight for the current smoke run.
- Print invocation counts and estimated runtime before execution. Real runs remain explicitly
  enabled, with model-role selection and maintainer-approved spending limits.
- The current 60-minute workflow cannot accommodate the worst case of that extended pilot.
  Design bounded batches/shards and retain partial evidence; do not simply raise the timeout.
  Runtime limits are not hard dollar limits—use provider-side caps where available.
- Publish all pilot outcomes, including ties and regressions. Decide whether to improve
  generation, revise fixtures, or collect more samples before asserting product benefit.

**Primary files:** `eval/scenarios.json`, `eval/repos/`, `eval/hidden/`,
`eval/solutions/`, `eval/models.json`, `scripts/eval.ts`,
`packages/cli/src/eval-gate.ts`, its tests, and the opt-in eval workflow.

### Acceptance

- [x] Hermetic tests reject missing/duplicate repetitions and validate suite coverage.
- [x] Known-good solutions pass; no-op and known-bad controls fail for the right reasons.
- [x] Verify-only controls distinguish actual correct execution from a post-run green fixture.
- [x] Repetitions are isolated and order/configuration can be reconstructed from the report.
- [x] Missing cost data never becomes a zero-dollar result or a fabricated improvement.
  `a successful pair without a ledger price keeps cost unknown` in
  `scripts/test/eval-paired-report.test.ts` asserts both successful-cost aggregates stay
  `null`, the pair is counted as unpriced, and the printed report says `unknown` when
  either variant lacks a ledger price. The committed `latest.json` omits cost fields;
  it is not evidence of a measured or zero-dollar cost.
- [x] A spend-approved pilot produces paired results with honest limitations and a documented
  next decision. The [bounded $0-only pilot](evidence/2026-11-14-skill-guidance.md) completed
  six real-agent invocations with no retries or errors: 3/3 pairs tied on task success,
  mean duration 52.10s bare / 61.76s skill, cost unknown, skill access unknown. The report
  explicitly makes no benefit or significance claim and records the next decision.

## Phase 2A/B — implemented, bounded pilot complete

"Complete" here means the harness, the schema and the corpus. It does not mean Phase 2 is
finished in the sense of proving effectiveness. The bounded pilot provides exploratory
real-agent evidence with limitations; the larger extended-corpus experiment remains
unapproved and has not run.

Phase 2A (evidence schema v3 with repetitions/seed/order) was merged into PR #8 with
schema v3, CLI flags `--repetitions`, `--seed`, `--order`, and 97 gate tests passing.

Phase 2B (extended scenario corpus) is now complete:
  - 7 new scenarios added to `eval/scenarios.json`: nested-project, workspace-dependency,
    cross-file-regression, misleading-docs, failing-verification, risk-sensitive-change,
    and skill-guidance (the installed-skill comparison)
  - `validateScenarioMatrix()` evolved to allow extra scenarios beyond the required 4 cells
  - Solution fixtures created for all 7 scenarios
  - Hidden verify test fixtures added for all 7 scenarios
  - Each scenario includes `notes` documenting how derived context could help
  - All lint/typecheck clean; 1021 test suite pass, 0 fail

## Phase 3 — Test lifecycle failures and recovery

**Outcome:** safety invariants are exercised across whole operations, not only successful
calls or isolated path helpers.

**Status:** complete. Claim creation and release boundary recovery, ship provider-failure
reporting, cross-process claim-registry locking, fetch-lock stale-owner recovery, and the
state-directory containment guard are implemented. The boundary-by-boundary outcomes are
recorded in [LIFECYCLE_RECOVERY.md](LIFECYCLE_RECOVERY.md); verification evidence is in the
Phase 3 PR. Review follow-ups cover linked leaf outputs and hooks, successor-safe lock
recovery, same-ticket replacement during release, and remote-only shipping bases. The
reviewed source is `0148e38`; its hermetic eval summary was regenerated rather than reused.

### Work

1. Define each operation's allowed side effects before adding failure injection:

   | Operation | Required invariant |
   | --- | --- |
   | Stage/replace/clear | No read/write/delete outside approved roots; refusal preserves existing data. |
   | Apply | Validate the entire bundle before the first write; define and test recovery from later I/O failure. |
   | Claim | Failure does not silently strand a worktree, lock, hook, or inconsistent registry entry. |
   | Release | Uncommitted or unpushed work is retained unless the user explicitly forces removal. |
   | Ship | Verification precedes push; later provider failures report which external steps already succeeded. |

2. Add narrow injectable seams for filesystem, Git, process, clock, and provider operations
   where needed. Tests must not depend on real provider calls, machine-wide permission
   changes, or elevated privileges to simulate a failure.
3. Cover missing/dangling/internal/external links, Windows junctions, aliases, non-directories,
   malformed/traversing paths, read-only/write failures, missing executables, timeouts,
   corrupt state, unavailable base/upstream refs, held locks, and concurrent attempts.
4. Test failures at each mutation boundary, including the second file in an apply batch.
   Fix failures in separate, focused commits: preflight what can be checked before writing,
   and implement recoverable transactions or an explicit partial-state result for failures
   that cannot be predicted. Never promise cross-file atomicity without implementing it.
5. Retry must not overwrite new human edits or duplicate a completed external action.
   Preserve recovery evidence; do not automatically delete pushed branches or undo remote PRs
   as a supposed rollback of an irreversible step.

**Primary files:** `packages/derive/src/staging.ts`, `packages/worktrees/src/index.ts`,
`packages/worktrees/src/crew.ts`, `packages/worktrees/src/ship.ts`, their tests,
and relevant process/Git helpers in `packages/core` and `packages/git`.

### Acceptance

- [x] Sentinel files prove the absence of unintended filesystem mutations after rejection.
- [x] Faults at each declared boundary have a documented, tested recovery outcome.
- [x] Lock cleanup, registry consistency, and safe retries are asserted, not just exit codes.
- [x] Symlink/junction cases run on suitable Windows, Ubuntu, and macOS CI runners;
  capability skips are explicit, and injected failure tests run without elevation.
- [x] Existing PWD, staging, cache-serialization, and unpushed-commit regressions remain covered.

## Phase 4 — Ship a versioned prebuilt distribution

**Outcome:** users install a tested artifact without fetching the source build toolchain.

**Status:** complete. Expanded installed-CLI smoke coverage passes on all three OSes and
both Node lanes, and `@anvil-workflows/cli` has been published: `0.2.0` at
`2026-11-26T17:08:45.888Z` and `0.2.1` at `2026-11-26T18:13:24.599Z` (npm `time`, UTC). The
registry name changed from `@anvil/cli` to `@anvil-workflows/cli` on 2026-11-17 after the
`@anvil` scope was found to already contain an unrelated package
([ADR-0023](adr/0023-npm-package-name-is-anvil-workflows.md)). The maintainer created the
`anvil-workflows` org and is its owner, so name control is confirmed.

Implemented: the release workflow (`.github/workflows/release.yml`), the tarball allowlist,
the identity check that the tag, the workspace manifest and the packed tarball agree, an
install of the staged artifact with `--ignore-scripts`, the MCP handshake, and a packaging
suite that packs the same `@anvil-workflows/cli` target from a temporary copy. That suite runs in
`npm run check` on every CI leg. Existing CI evidence covers tarball contents, installation
without scripts, version/JSON and MCP on all three OSes and both Node lanes. The expanded
registry test now also exercises help, doctor, staged generation/apply and preservation
of existing consumer files through the installed binary. That expanded test passed on all
six `check` legs (3 OS x floor/LTS) in run 43625583728 at `93c6f12`, so matrix acceptance
is recorded below.

The release workflow writes `SHA256SUMS` and draft release notes containing the
source SHA, verifies the checksum after smoke testing, and retains those sidecars with
the tested tarball for 90 days. Upload failure blocks publication. Actionlint passes,
and a local rehearsal of the exact provenance/checksum commands accepts unchanged bytes
and rejects tampering. The GitHub artifact upload can also be exercised by the no-publish
`workflow_dispatch` rehearsal described below. The publish path has since run: the `v0.2.1`
release run [45873069026](https://github.com/tecruz/anvil/actions/runs/45873069026)
completed both the `Release v0.2.1` and `Publish v0.2.1` jobs successfully.

Published `0.2.1` details: npm shasum
`243ee594f23f331e129cb724e0db5fc8adb81463`, integrity
`sha512-p1OHNBevkeT5IHZ/Vu7SBa7uBSr51cF9X0jbhSd4R6Kgf+OFSKqwHquzSoXWgE4UDKLHTX3KE7eH+vrLVcM+Tw==`,
and tarball SHA-256 `9dbdb1c2a16f39fbada7d528beac2faab7fc4609e23c8051d8b5e2b5ff4162e9`. The
source is `33e24ee36256b429ce72ea919cd2ba0cb7730c11`, tagged `v0.2.1`; the peeled tag commit
equals the SLSA source SHA. The [SLSA provenance
attestation](https://registry.npmjs.org/-/npm/v1/attestations/@anvil-workflows%2fcli@0.2.1)
has predicate type `https://slsa.dev/provenance/v1`, build type
`https://slsa-framework.github.io/github-actions-buildtypes/workflow/v1`, and workflow path
`.github/workflows/release.yml`; it was produced by [run
45873069026](https://github.com/tecruz/anvil/actions/runs/45873069026/attempts/1). The
registry tarball was downloaded independently (302191 bytes); its SHA-1 and SHA-512 match the
registry metadata and its SHA-256 matches the tested artifact. `npm audit signatures` reported
a verified registry signature and a verified attestation.

Approval: the [publication evidence
note](evidence/2026-11-26-release-publication.md) records the maintainer's approval in the
2026-11-26 session after the `NPM_TOKEN` secret was added. That is a maintainer-authored
evidence note, not an independently posted issue or PR comment; issue #38 has no comments and
no issue or PR comment records the approval. The publish job had no GitHub environment, so no
environment approval review is available. `0.2.0` was the first publication; its shasum was
`df4404b9853ce65b7b2a394ccf1ca87e91654812` and integrity
`sha512-O0APtqE/kbF3DuV7YDt3t9IQZSCmBUn6dpGjuiEcQS459jihToGJzdnDtHDtyGY3ZCPAT5mrNswx+vUQHhaPmw==`.
No GitHub Release object exists for `v0.2.0` or `v0.2.1`.

The no-publish `workflow_dispatch` rehearsal runs the same build, allowlist, smoke test,
checksum guard and artifact upload but stops before `npm publish`; it is documented in
[CONTRIBUTING.md](../CONTRIBUTING.md#rehearsing-a-release-without-publishing). A later
rehearsal on 2026-11-27 ([preparation note](evidence/2026-11-27-release-preparation.md)) built
from a different, later source and produced tarball SHA-256
`ee884d3f6630ab135e33ede3c4c977cbc881a2bb742ea5531862becb10b4cf20`; those are not the
published `0.2.1` bytes (SHA-256 `9dbdb1c2…4162e9`) and must not be republished as `0.2.1`.

### Decisions before implementation

- Confirm that public distribution of the bundled code is intended, even if the source
  repository remains private.
- Verify ownership/availability of a scoped npm name; do not use the unrelated unscoped
  `anvil` registry name. The executable can remain `anvil`. `@anvil` was already in use,
  and maintainer control was not established; the agreed scope is `@anvil-workflows`
  ([ADR-0023](adr/0023-npm-package-name-is-anvil-workflows.md)).
- Decide whether to publish a generated distribution package or change the root manifest.
  Write an ADR extending [ADR-0007](adr/0007-distribution-git-install.md); preserve the
  GitHub source-install path unless its retirement is explicitly approved.
- Confirm registry access and trusted-publishing support before adding release permissions.
  Keep publishing the OpenCode plugin a separate decision.

### Work

1. Produce one allowlisted tarball containing the built CLI, license, required documentation,
   and an accurate manifest. Exclude sources, fixtures, transcripts, credentials, tests, and
   build-tool dependencies. Do not commit generated bundles to the source tree.
2. Extend the existing packaging tests rather than creating a second competing test path.
   Install that tarball into an isolated environment with install scripts disabled and without
   checkout workspace links or devDependencies. Run the installed executable, not source.
3. Smoke-test version/help/JSON, doctor on a fixture, staged generation/apply in a disposable
   repository, and the MCP handshake/read-only surface on all supported OSes. Exercise the
   documented minimum Node version and supported LTS versions deliberately.
4. Build once, test that exact tarball, record its checksum/source SHA/version, and publish
   those same bytes. Rebuilding after testing invalidates the evidence.
5. Add a separate, SHA-pinned, least-privilege release workflow using protected version tags
   and maintainer approval. Scope any OIDC publishing permission to the release job; do not
   grant write/publish credentials to ordinary pull-request CI.
6. Document install/upgrade/pinning and recovery: deprecated bad releases and installation
   of the previous known-good version. Do not silently move a released tag or replace a version.

**Primary files:** root and distribution manifests as decided in the ADR,
`scripts/build.mjs`, `packages/cli/test/package.test.ts`, release workflow,
[README.md](../README.md), and [USAGE.md](USAGE.md).

### Acceptance

- [x] The agreed package name is controlled by the maintainer, with no naming collision.
  The original `@anvil` scope already contained `@anvil/common-asc`; the public checks did
  not establish maintainer control. For the agreed replacement, `@anvil-workflows/cli`,
  `npm whoami` returned `tecruz` and `npm org ls anvil-workflows --json` returned
  `{"tecruz":"owner"}` on 2026-11-17. The package lookup returned 404 on that date, before
  publication; `@anvil-workflows/cli` `0.2.1` was published on 2026-11-26. See
  [the scope evidence](evidence/2026-11-17-npm-scope.md).
- [x] A clean tarball install works without a source build or runtime dependencies.
  `the staged artifact installs without scripts and exercises the installed CLI` in
  `packages/cli/test/package.test.ts`: `npm pack` of the staged workspace, then
  `npm install --ignore-scripts` into a consumer with no workspace links.
- [x] Installed CLI smoke tests pass on all three OSes and the supported Node matrix.
  Run 43625583728 (`93c6f12`) passed `npm run check` on Windows, Ubuntu and macOS, on both
  the Node floor and current LTS. The expanded registry test covers version/JSON, help,
  doctor, staged generation/apply, preservation of existing files and MCP. The six `check`
  legs (3 OS x floor/LTS) have existed since PR #30.
- [x] Published bytes match the tested checksum; version and provenance identify the source.
  The registry tarball for `0.2.1` was downloaded independently (302191 bytes); its SHA-1
  `243ee594…c81463` matches the npm shasum, its SHA-512 matches the published integrity, and
  its SHA-256 `9dbdb1c2…4162e9` matches the tested artifact recorded in
  [the publication evidence](evidence/2026-11-26-release-publication.md). The SLSA
  provenance subject digest matches the npm integrity, and its source is
  `33e24ee36256b429ce72ea919cd2ba0cb7730c11` at `refs/tags/v0.2.1`.
- [x] First publication is explicitly approved; GitHub installation remains tested if supported.
  The [publication evidence](evidence/2026-11-26-release-publication.md) records the
  maintainer's approval in the 2026-11-26 session after the `NPM_TOKEN` secret was added.
  That is a maintainer-authored note; issue #38 has no comments, no issue or PR comment
  records the approval, and the publish job had no GitHub environment, so no environment
  approval review exists. The git channel remains tested (`npm pack -> npm install -> the
  installed binary does real work`).

## Acceptance evidence (2026-11-14)

Initially reconciled on 2026-11-14; dated additions through 2026-11-26 are included below.

"Complete" in this document means a command was run and its output was read, not that code
for it exists. These are the commands behind the reconciled checklists.

| Claim | Evidence |
| --- | --- |
| Eight required contexts, strict mode, no bypass | `gh api repos/tecruz/anvil/branches/main/protection` returned 8 contexts with `strict: true` and `enforce_admins: true`; `rulesets/25986193` returned `bypass_actors: []` |
| Pending, failed, missing and earlier-head checks block merging; a green head does not | [Merge-gate demonstration](evidence/2026-11-14-merge-gate.md): draft PR #44, `BLOCKED` at `31a54d7`, `43fffd8` (pending and failed) and `bb8c60c`; `CLEAN` at `261968a` and `715145a`; closed unmerged; protection snapshots before and after identical |
| A maintainer merges without a reviewer | PRs #30 and #31 report `mergedBy: tecruz`, `reviews: 0`, with `required_approving_review_count: 0` |
| Duplicate run records are refused | `node --test --test-name-pattern="duplicate" packages/cli/test/eval-gate.test.ts`: 4 pass, 0 fail |
| Interrupted runs keep a readable checkpoint and resume reuses it | `node --test --test-name-pattern="an interrupted fake-agent run" scripts/test/eval-resume.test.ts`: 1 pass, 0 fail on each of five consecutive runs and three concurrent runs. |
| A failed checkpoint rename leaves the previous file intact | `node --test --test-name-pattern="failed rename" scripts/test/eval-run.test.ts`: 2 pass, 0 fail on each of five consecutive runs. |
| Full validation before the registry-smoke expansion | `npm run check` completed: 1810 tests, 1797 passed, 13 skipped, 0 failed; build, docs check and eval gate passed. |
| Expanded installed-registry smoke coverage | `node --test --test-name-pattern="registry tarball" packages/cli/test/package.test.ts`: 2 passed locally. CI run 43625583728 (`93c6f12`) passed `npm run check` on Windows, Ubuntu and macOS at both the Node floor and LTS. |
| Approved real-agent pilot | [Report and retained run record](evidence/2026-11-14-skill-guidance.md): 6 unique completed keys, 3 counterbalanced pairs, all visible/hidden checks passed; source, fixture and bundle hashes verified; retained record byte-identical to generated evidence. |
| Artifact retention after an intentional failure | [Retained artifact record](evidence/2026-11-17-artifact-retention.md): run 44056529412 failed on purpose; artifact `eval-failure-rehearsal-44056529412-attempt1` retained 12 allowlisted files and expires 2026-12-17; the downloaded copy re-validated as `Validated 3 files, the run archive and 8 checkpoints.` |
| Name control (2026-11-17) | [Scope check](evidence/2026-11-17-npm-scope.md): `@anvil` already contained `@anvil/common-asc`, and maintainer control was not established. After the maintainer created `anvil-workflows`, `npm whoami` returned `tecruz` and `npm org ls anvil-workflows --json` returned `{"tecruz":"owner"}`. The `@anvil-workflows/cli` lookup returned 404 on that date, before publication; `0.2.1` was published on 2026-11-26 (see the publication row below). |
| Release workflow syntax and checksum commands | Actionlint 1.7.12 passes all three workflows. A local rehearsal of the exact provenance step preserves artifact bytes and writes matching notes/checksum; the checksum guard passes unchanged bytes and fails tampered bytes. The workflow later published `0.2.1`; see the publication row below. |
| Publication of `@anvil-workflows/cli` (2026-11-26) | [Publication evidence](evidence/2026-11-26-release-publication.md): `0.2.0` at `2026-11-26T17:08:45.888Z` and `0.2.1` at `2026-11-26T18:13:24.599Z` (npm `time`, UTC). `0.2.1` shasum `243ee594f23f331e129cb724e0db5fc8adb81463`, integrity `sha512-p1OHNBevkeT5IHZ/Vu7SBa7uBSr51cF9X0jbhSd4R6Kgf+OFSKqwHquzSoXWgE4UDKLHTX3KE7eH+vrLVcM+Tw==`, SHA-256 `9dbdb1c2a16f39fbada7d528beac2faab7fc4609e23c8051d8b5e2b5ff4162e9`; source `33e24ee36256b429ce72ea919cd2ba0cb7730c11` at tag `v0.2.1` (peeled tag commit equals the SLSA source SHA). SLSA provenance from run 45873069026 (predicate `https://slsa.dev/provenance/v1`, build type `https://slsa-framework.github.io/github-actions-buildtypes/workflow/v1`, workflow `.github/workflows/release.yml`). No GitHub Release was created. |
| Historical lookup of the superseded package name (2026-11-14) | `GET https://registry.npmjs.org/@anvil%2fcli/latest` returned 404. This records no publicly accessible `latest` release at that endpoint then, not publication history or ownership. The agreed name's check is recorded in the scope evidence above. |

The Phase 1 artifact-retention criterion is closed by the rehearsal record above; the Phase 4
items are closed by the publication record.
The bounded pilot is recorded as complete, not as proof of product effectiveness.
Publication occurred on 2026-11-26. Approval and successful execution are separate facts; the
publication evidence note records the session approval, not an issue/PR comment or environment
review.

### Maintainer authorizations (2026-11-14)

- **Real-agent pilot:** approved for **$0 model spend only**, with no paid-model fallback:
  `skill-guidance`, the configured `opencode/deepseek-v4.1-flash-free` small model, six
  invocations total in three two-run batches. The OpenCode model catalog reports zero
  input, output and cache prices for that exact model. Missing usage-ledger measurements
  must still remain unknown in the results; catalog pricing is not a measured run cost.
- **Publication:** explicitly **on hold**. Do not publish or push a release tag. Local
  `npm whoami` returned `ENEEDAUTH`; no `NPM_TOKEN` repository secret was listed.
  Scope ownership and final artifact verification remain prerequisites, not implicit
  publication permission.

**2026-11-17 follow-up:** the authorization and environment details above record the state
on 2026-11-14. Name control was subsequently confirmed: authenticated `npm whoami` returned
`tecruz`, and `npm org ls anvil-workflows --json` returned `{"tecruz":"owner"}`. See
[the scope evidence](evidence/2026-11-17-npm-scope.md). The publication hold is unchanged;
name control does not authorize a release, and final artifact verification is still required.

**2026-11-26 follow-up:** the hold above records the state on 2026-11-14 and 2026-11-17.
`@anvil-workflows/cli` `0.2.0` and `0.2.1` were subsequently published (see
[the publication evidence](evidence/2026-11-26-release-publication.md) and the Phase 4
record). The evidence note records a session approval on 2026-11-26 after the `NPM_TOKEN`
secret was added; no issue/PR comment or environment approval review was found.

## PR breakdown and release gates

1. **Merge-policy setup + documentation:** Phase 0, with recorded settings verification.
2. **Checkpoint/report contract:** Phase 1 local persistence, completeness, and failure tests.
3. **Benchmark artifact retention:** Phase 1 workflow/privacy policy; flag workflow risk.
4. **Repeated paired runner + report:** Phase 2A, with schema migration and hermetic tests.
5. **Extended scenarios + pilot findings:** Phase 2B; real-model runs need separate approval.
6. **Lifecycle fault tests and focused fixes:** Phase 3; split by operation if the diff grows.
7. **Distribution ADR + tarball smoke tests:** Phase 4 without publication credentials.
8. **Approved release automation + first release:** Phase 4, only after artifact tests pass.

For every code PR, run the existing validation commands:

```bash
npm run build
npm run eval -- --fake-agent
npm run check
```

If evaluated implementation inputs change, regenerate the hermetic summary after the final
source edits and ensure it passes the gate; do not reuse an older implementation hash.
Run checks again after conflict resolution or rebasing changes the tested tree. Require
successful final-head CI on Windows, Ubuntu, and macOS before merging. These commands do
not authorize a real-model run; the fake agent validates the harness, not product efficacy.

Completion evidence must reference the exact commit/artifact tested. Document remaining
limitations and failed experiments. A successful workflow is not, by itself, proof that
the product helps agents or that every failure path is safe.
