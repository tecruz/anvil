# Implementation plan: reliability, evidence, and distribution

Status: **proposed; no implementation authorized by this document**.
Prepared: 2026-10-27, after the corrective hardening in PR #4.

This is the next implementation cycle, not a rewrite of the completed
[M0–M6 plan](../IMPLEMENTATION_PLAN.md). The goal is to demonstrate that anvil helps
agents finish real work, retain trustworthy evidence, and make failures and installation
predictable. Adding more commands, trackers, or agent integrations is out of scope.

## Constraints

- The product CLI remains deterministic, offline by default, and model-free. Real-model
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
(`PUT branches/main/protection`) requiring all five CI checks in strict mode, with force
pushes and deletions blocked and no PR review required (solo maintainer). The merge
checklist in [CONTRIBUTING.md](../CONTRIBUTING.md) now describes an enforced gate.

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

- [ ] Verify in a disposable draft PR/test repository that pending, failed, missing, and
  earlier-head checks block merging; the final successful head permits it.
- [ ] A single maintainer can still merge after checks pass without finding another reviewer.
- [ ] Record the actual settings and verification evidence. If enforcement is unavailable,
  state the limitation rather than describing a checklist as enforced protection.

## Phase 1 — Preserve evidence and survive interrupted runs

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

- [ ] Hermetic tests interrupt a run after a known result and verify it remains readable.
- [ ] Partial, duplicate, corrupt, incompatible, and missing run records cannot pass the gate.
- [ ] Resume skips only compatible completed work and records each attempt explicitly.
- [ ] Simulated checkpoint-write failure leaves the previous checkpoint intact.
- [ ] Implementation changes during a run invalidate the evidence instead of relabeling it.
- [ ] Synthetic secret markers do not appear in published artifacts or summary output.
- [ ] A maintainer-approved synthetic CI run demonstrates artifact retention after failure.

## Phase 2 — Measure whether derived context actually helps

**Outcome:** paired measurements show the benefit, cost, or absence of benefit without
conflating harness correctness with agent effectiveness.

### 2A. Repeated comparisons and reporting

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

Verify-only grading needs special treatment: the current post-agent verifier can pass
even if the agent did nothing. Capture supported tool-execution evidence and assert that
the agent actually ran the required checks and reported their outcomes. Keep task success
separate from whether the repository's checks passed; do not require a deliberately broken
fixture to become green. A no-op or incorrect-success report must fail grading.

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

- [ ] Hermetic tests reject missing/duplicate repetitions and validate suite coverage.
- [ ] Known-good solutions pass; no-op and known-bad controls fail for the right reasons.
- [ ] Verify-only controls distinguish actual correct execution from a post-run green fixture.
- [ ] Repetitions are isolated and order/configuration can be reconstructed from the report.
- [ ] Missing cost data never becomes a zero-dollar result or a fabricated improvement.
- [ ] A spend-approved pilot produces paired results with honest limitations and a documented
  next decision. A positive result is not a condition for honestly completing the pilot.

## Phase 3 — Test lifecycle failures and recovery

**Outcome:** safety invariants are exercised across whole operations, not only successful
calls or isolated path helpers.

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

- [ ] Sentinel files prove the absence of unintended filesystem mutations after rejection.
- [ ] Faults at each declared boundary have a documented, tested recovery outcome.
- [ ] Lock cleanup, registry consistency, and safe retries are asserted, not just exit codes.
- [ ] Symlink/junction cases run on suitable Windows, Ubuntu, and macOS CI runners;
  capability skips are explicit, and injected failure tests run without elevation.
- [ ] Existing PWD, staging, cache-serialization, and unpushed-commit regressions remain covered.

## Phase 4 — Ship a versioned prebuilt distribution

**Outcome:** users install a tested artifact without fetching the source build toolchain.

### Decisions before implementation

- Confirm that public distribution of the bundled code is intended, even if the source
  repository remains private.
- Verify ownership/availability of a scoped npm name; do not use the unrelated unscoped
  `anvil` registry name. The executable can remain `anvil`.
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

- [ ] The agreed package name is controlled by the maintainer, with no naming collision.
- [ ] A clean tarball install works without a source build or runtime dependencies.
- [ ] Installed CLI smoke tests pass on all three OSes and the supported Node matrix.
- [ ] Published bytes match the tested checksum; version and provenance identify the source.
- [ ] First publication is explicitly approved; GitHub installation remains tested if supported.

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
