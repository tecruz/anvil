# Implementation plan: verified AI-assisted work

Status: **proposed for later implementation**, 2026-11-26.

## Goal

Anvil should tell an agent how to verify a task and give the reviewer evidence that the
check passed against the exact patch under review. Once that workflow is reliable, measure
whether it helps agents deliver reviewable, verified patches on real repositories.

This plan builds on the [reliability and distribution plan](IMPROVEMENT_PLAN.md) and the
[AI enablement plan](AI_ENABLEMENT_PLAN.md). The verified-patch study groundwork lives on
the `pr/nested-verification-pilot` branch and is described in Phase 2 below.
Keep the product CLI model-free, keep repository profiling non-executing, and keep run
evidence local or scoped to controlled benchmark artifacts. No hosted telemetry or new agent
integration is required.

## Starting point

- On 2026-11-26, `main` was `07a859e`, with green cross-platform CI and a green scheduled
  benchmark. [PR #103](https://github.com/tecruz/anvil/pull/103) restores the dashboard Task
  Brief and had all eight checks green. [PR #104](https://github.com/tecruz/anvil/pull/104)
  carries the launch evidence and study groundwork but had merge conflicts. Recheck the
  current heads and statuses before starting.
- `main` can record revision-bound results through `anvil crew verify --record`. The
  dashboard matches evidence by commit ID, so it cannot distinguish two dirty versions of
  that commit. `anvil ship` can push without having run local verification.
- The launch evidence on the evaluation branch has two exact command matches, one partial
  match (documented check found, CI check missed), and one blocked result without the actual
  blocker. Its five-pair and ten-pair pilots both fell short of their predeclared threshold.
  No effectiveness claim follows from them. The exact records are in that branch's
  `docs/evidence/` directory.
- GitHub source install is supported. The existing `v0.1.0` Git tag predates current
  functionality; first scoped npm publication remains [on hold in #38](https://github.com/tecruz/anvil/issues/38).

## Delivery order

| Phase | Deliverable | Depends on |
| --- | --- | --- |
| 0 | Integrate the existing PRs and re-establish a green baseline | — |
| 1 | Exact-revision verification in the shipping workflow | 0 |
| 2 | A bounded, independently graded study runner | 0 |
| 3 | Task-scoped guidance backed by a shared verification plan | 1 |
| 4 | A predeclared real-task comparison | 1 and 2; freeze whichever Phase 3 changes are included |
| Release | An approved, tested release candidate | 0 and the chosen release scope; independent of Phase 4 |

Keep phases independently reviewable. Phases 1 and 2 can proceed in parallel once Phase 0
lands. No real-model run, release tag, publication, or repository settings change is
authorized by this document.

## Phase 0 — Stabilize `main`

1. Review #103 at its current head and confirm the Task Brief and 2D task map work from the
   installed CLI. Reconcile #104 with the resulting `main`, preserving the current dashboard,
   profile detection, instruction mirrors, and verification recording. Keep historical pilot
   records tied to their original commits and digests.
2. Align the README and launch evidence with the exact/partial/blocked breakdown. Keep
   deterministic checks, scheduled model smoke runs, and effectiveness results distinct.
3. Regenerate hermetic evidence if the implementation or harness inputs changed. Require the
   eight CI checks on the final integration head and record the commit and run links.

**Done when:** the Task Brief works through the normal installed entry point, both changes
are integrated, the full check passes on the final head, and public claims match the evidence.

## Phase 1 — Bind verification to what gets shipped

**Implementation seams:** `packages/cli/src/commands/crew.ts`,
`packages/worktrees/src/crew.ts`, `packages/cli/src/commands/ship.ts`,
`packages/worktrees/src/ship.ts`, and `packages/dashboard/src/snapshot.ts` on `main`.

1. Extend the existing verification record with a versioned identity: repository and claim,
   verified commit or immutable patch, command arguments and repo-relative working directory,
   effective check-plan digest, and observed outcome and time. Read existing records as
   history; they cannot satisfy the stronger policy just because the commit ID matches.
2. For shipping, start with a clean commit in an isolated checkout of that commit. Ordinary
   dirty-worktree checks stay useful for feedback, but qualify as current evidence only if
   run against an immutable snapshot with a matching identity. Distinguish `passed`, `failed`,
   `stale`, and `not run`; keep unavailable evidence and infrastructure errors explicit.
3. Let owners opt into requiring fresh evidence for high-risk changes. Read that policy
   and the required check definitions from the trusted base or owner-controlled configuration.
   For required checks, accept a result from a trusted runner and store or from CI bound to the
   same commit. Existing paths that explicitly skip verification must not satisfy this policy.
   Preserve current behavior for repositories that have not opted in.
4. Reuse the same status in the CLI, dashboard and PR body. At the push boundary, pin the
   verified commit as the source and ensure the diff and risk result describe that commit.
   Keep writes to the remote behind the existing shipping boundary.

Start with one reviewable slice: record a local check run against a clean commit and
show its status in the dashboard. Add the opt-in ship policy once that record and its
compatibility behavior are proven. CI-issued evidence can follow when there is a caller
for it.

**Done when:** tests cover a clean pass, a wrong command or directory, an edit during or after
the check, an unobserved exit, an old record, a changed check plan, and a moved branch. Stale
or missing evidence blocks a policy-required push before contacting the write transport.

## Phase 2 — Make the study runner trustworthy

**Implementation seams:** `scripts/verified-patch-run.ts`, `scripts/verified-patch.ts`,
`scripts/eval-check-broker.ts`, and `eval/verified-patch-tasks.json`. Reuse the existing eval
harness's process, provenance, checkpoint and redaction code where it fits.

1. Grade a complete patch against the pinned base, enforcing the allowed changes and
   protected files. Run the broker check against a frozen snapshot and hash those inputs
   before execution; match a successful attestation to the final patch. Run hidden acceptance
   separately against that same final patch, outside the agent's writable environment.
2. Fix the fixture task: allow edits to the named visible test and state the trimming
   behavior expected by hidden acceptance. Confirm the base fails for the expected reason,
   the reference fix passes, and reasonable alternative fixes pass. Test stale checks and
   valid re-verification after an edit.
3. Use a fresh, isolated worker per arm with a minimal environment, scoped provider access,
   and no tracker or push credentials. Enforce the timeout for the whole process tree and
   the approved spend ceiling through the provider or gateway. Refuse a real run if those
   limits cannot be enforced. Treat a worktree as branch isolation; keep grader inputs and
   credentials outside the agent's access.
4. Bind approval to the actual clean source commit, CLI and grader bytes, pinned task and
   sandbox inputs, agent and model versions, execution order, limits, and scoring rule.
   Checkpoint each arm and retain bounded, redacted failure reasons, exit status, accepted
   check and patch identity, timing, and observed cost. Distinguish failure, timeout, run error,
   and an arm that never started. Use `null` for unmeasured data.

**Done when:** the normal runner can complete both arms with a fake agent. Offline controls
show that an edit during a check cannot earn a fresh pass, hidden acceptance catches a
visible-check false positive, timeout and interruption retain completed results, and a
changed run spec or unavailable limit refuses execution.

## Phase 3 — Give agents the right check for the task

1. Reuse the effective verification plan across `brief`, `ready`, `init`, the ticket bundle,
   and the verification runner. Surface the supported local command, directory, provenance,
   and known prerequisites. Show conflicts and unknowns explicitly. Keep CI-only steps as
   source references unless the project separately declares a runnable local equivalent.
2. Keep root `AGENTS.md` to common repo rules and the checks most tasks need. Use nested
   instructions where modules differ, on-demand [Agent Skills](https://agentskills.io/specification)
   for specialized procedures, and the thin client mirrors already available on `main`.

**Done when:** nested and multi-stack fixtures get the same runnable check and directory in
the guidance and in the verifier. A declared missing prerequisite is identified as such;
incomplete detection and conflicting instructions remain visible.

## Phase 4 — Measure verified patches on real tasks

1. Define the comparison before enrollment: the primary comparison is the real Anvil
   claim-to-verification workflow versus plain OpenCode with the same task, repository,
   model, underlying tool access and resource limits. Give both arms the same opportunity
   to earn verification evidence: the grader must be able to observe the repository check
   when plain OpenCode runs it directly. If the assisted arm only stages `anvil init`
   artifacts, describe that as a separate context-only study.
2. Publish selection and exclusion rules before running either arm. Pin tasks across
   multiple repositories and stacks, covering straightforward changes, nested checks and
   harder-to-verify work. Keep a separate development set for tuning the runner. Preflight
   the held-out tasks offline: hidden acceptance fails on the base, passes on a reference
   fix, and leaves room for alternative correct patches. Have a reviewer check that the
   task text and tests agree without requiring unstated behavior.
3. Predeclare the sample size, minimum useful effect, paired analysis with uncertainty,
   seeded and balanced order, treatment of timeouts and infrastructure errors, and the
   exact approval and spend limits. Primary metric: paired rate of in-scope patches that
   pass hidden acceptance and have current verification evidence. Secondary metrics:
   time through review and rework, and cost per verified patch where measured. Use a
   blinded review sample with the same rubric for both arms.
4. Run only after approval of the frozen specification. Report denominators, paired
   outcomes, failures and missing data even if the result is inconclusive. Keep this run
   separate from hermetic CI and prior pilots. Apply the predeclared stop and claim rules.

**Done when:** the approved study produces a reproducible, independently reviewable result.
Any effectiveness claim is limited to the workflows, tasks, model and conditions evaluated.

## Release track

Use Phase 4 of the existing [reliability and distribution plan](IMPROVEMENT_PLAN.md)
and #38. Choose an unused version for the candidate instead of moving the existing Git
tag. Build once from a green source commit, install the exact tarball with scripts disabled,
and smoke-test `anvil doctor` output, the dashboard Task Brief, and the MCP handshake.
Retain the tarball, checksum, source SHA, and CI links. Continue testing GitHub installation.
Publication requires separate approval for that version, source, and artifact; verify the
registry bytes and provenance against the tested candidate after publishing.

## Verification for implementation PRs

Use `npm run test:changed` while iterating and `npm run check` before review. When eval inputs
change, regenerate fake-agent evidence and run `npm run eval:check`. Require the existing
eight CI checks on the final head, including Windows, Linux and macOS on both Node lanes.
Flag workflow edits as high-risk under [AGENTS.md](../AGENTS.md).

References: [Anthropic on agent evals](https://www.anthropic.com/engineering/demystifying-evals-for-ai-agents)
and [OpenAI on coding benchmark validity](https://openai.com/index/separating-signal-from-noise-coding-evaluations/).
