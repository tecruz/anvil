# Phase 0 merge-gate demonstration — 2026-11-14

## Scope and authorization

This closes the open acceptance item under "Phase 0 — Enforce the merge policy" in
[IMPROVEMENT_PLAN.md](../IMPROVEMENT_PLAN.md) (issue #34):
show in a disposable draft PR that pending, failed, missing and earlier-head checks block
merging, and that the final successful head is permitted to merge.

The maintainer approved a disposable draft PR in this repository, so the demonstration ran
against the real `main` protection rather than a copy in a test repository. No repository
setting, branch protection rule, ruleset or workflow was changed, nothing was merged, and no
merge was attempted: the merge gate is read from GitHub's own `mergeStateStatus`, not tested
by trying to merge. `gh pr merge` was never run, because it only re-reads `mergeStateStatus`
on the client before deciding whether to call the API, so it adds no independent evidence and
would really merge at a green state.

- Demo PR: [#44](https://github.com/tecruz/anvil/pull/44), "DO NOT MERGE: Phase 0 merge-gate
  demo (#34)", branch `demo/merge-gate-2026-11-14`, opened as a draft.
- Base for every capture: `main` at `f0c28c9b929c0ffacb1384fbe8056df9d2c11a09`. `main` was
  re-read before each capture and never moved.
- CI: the existing `.github/workflows/ci.yml`, unchanged.
- Outcome: PR #44 was closed unmerged (GraphQL `mergedAt: null`, `mergeCommit: null`) and
  its branch deleted. The REST `merge_commit_sha` on a PR is GitHub's test-merge ref, not
  evidence of a merge, so it is not used here. The workflow runs are kept, because the run
  IDs below point at them.

## Protection under test

Read from the GitHub API at 2026-11-14T20:51:45Z, before the first push, and again at
2026-11-14T21:30:03Z, after cleanup. The two snapshots are identical, including the `main` SHA.

- Branch protection on `main`: eight required contexts, each bound to GitHub Actions
  (`app_id: 15368`) -- `windows-latest`, `ubuntu-latest`, `macos-latest`,
  `windows-latest (Node LTS)`, `ubuntu-latest (Node LTS)`, `macos-latest (Node LTS)`,
  `playbook registry (rot check)`, `gh contract (live)` -- with `strict: true`,
  `enforce_admins: true`, pull requests required with zero approving reviews, and force
  pushes off.
- Ruleset `25986193` (`main`, active on the default branch): `deletion`, `non_fast_forward`
  and `required_status_checks` with the same eight contexts (`integration_id: 15368`),
  `strict_required_status_checks_policy: true`, `bypass_actors: []`,
  `current_user_can_bypass: "never"`.
- Repository: public; auto-merge off.

## Method

Each state is one commit pushed fast-forward to the demo branch, except pending and failed,
which are two captures of the same commit, `43fffd8`, before and after its run finished. A
draft PR always reports `mergeStateStatus: DRAFT`, which hides the check-based gate, so the
PR was marked ready for review immediately before each capture and returned to draft
immediately after.
`ready_for_review` does not trigger `ci.yml`.

Each capture recorded three read-only views of the PR head:

1. GraphQL `pullRequest { headRefOid baseRefOid mergeStateStatus mergeable
   commits(last: 1) { commit { statusCheckRollup { state contexts { ... on CheckRun { name
   status conclusion isRequired(pullRequestNumber: 44) checkSuite { app { databaseId }
   workflowRun { databaseId } } } } } } } }`.
2. REST `GET repos/tecruz/anvil/commits/<head>/check-runs`.
3. `gh pr view 44 --json headRefOid,mergeStateStatus,mergeable,statusCheckRollup`.

The GraphQL and `gh pr view` readings agreed at every capture. The REST check-runs for the
missing state were re-read after the PR had returned to draft (the first read hit a bug in
the capture script's `jq` filter); check runs belong to the commit, not the PR, so draft
status does not affect them. `mergeable` reports only merge conflicts, so it is
`MERGEABLE` throughout; `mergeStateStatus` is the field that carries the required-check gate.

"Missing" uses `[skip ci]` in the head commit message. GitHub then starts no `pull_request`
workflow for that head, so no required check ever reports on it. This makes every required
check missing at once; a partial absence would need a workflow edit and was not attempted.

## Results

| State | Head commit | Captured (UTC) | Workflow run | Required checks on the head | `mergeStateStatus` | Merge allowed |
| --- | --- | --- | --- | --- | --- | --- |
| Missing | `31a54d74c268c8fa78d9dd563b3af7bb28fa00c4` (`[skip ci]`, empty) | 20:52:35 | none | 0 check runs; rollup `null` | `BLOCKED` | no |
| Pending | `43fffd8b0e5e79736bff1e954d429788096ee54a` (adds a deliberately failing test) | 20:53:16 | 43639842492 | 8/8 required: 7 `IN_PROGRESS`, 1 `QUEUED`; rollup `PENDING` | `BLOCKED` | no |
| Failed | `43fffd8b0e5e79736bff1e954d429788096ee54a` | 21:00:44 | 43639842492 | 6 matrix legs `FAILURE` (the planted test), rot check and gh contract `SUCCESS`; rollup `FAILURE` | `BLOCKED` | no |
| Earlier head green | `261968a65c24922bf5d67e3ec90513a8f9d846b3` (reverts the failing test; tree identical to `main`) | 21:19:56 | 43640518600, attempt 2 | 8/8 `SUCCESS`; rollup `SUCCESS` | `CLEAN` | yes (not merged) |
| Current head untested | `bb8c60c0196dfb6c3ebdff147c55d6cd36290d04` (`[skip ci]`, empty, on top of the green head) | 21:20:31 | none | 0 check runs on this head, while the previous head still has 8/8 `SUCCESS`; rollup `null` | `BLOCKED` | no |
| Final head | `715145a93b3134be5410fb55a4c4b7be030a39fb` (empty, runs CI) | 21:29:42 | 43642319922 | 8/8 `SUCCESS`; rollup `SUCCESS` | `CLEAN` | yes (not merged) |

Every required context reported by GraphQL had `isRequired: true` and app `15368`.

The earlier-head row is the outcome Phase 0 names: a green result for `261968a` did not
authorize `bb8c60c`. Check results are bound to the commit they ran on, and the gate reads
only the current head. This demonstrates head-SHA binding only. Strict mode (`BEHIND`, a
branch that is no longer up to date with `main`) was not exercised, because `main` did not
move during the demonstration.

### The green head's first attempt

The first attempt at the green head did not pass. Run 43640518600 attempt 1 (started
21:01:00Z) failed one required check, `windows-latest` (job 132586862144): 1820 tests,
1813 passed, 1 failed, 6 skipped. The failure was
`packages/derive/test/setup-apply.test.ts:146`, "applies a current plan once, writes the
exact bytes and journals a verified success", which ran for 20 053 ms and failed with
`PREFLIGHT_FAILED`: "The approval directory access control list cannot be read". The
duration is consistent with the 20-second `timeout` on the Windows ACL tool
(`packages/derive/src/setup-approval.ts:514`) on a slow runner, but the log cannot prove the
timeout fired: `runWindowsTool` catches every error and returns `null`
(`setup-approval.ts:516-519`), so a timeout and any other tool failure look the same. It
was not a change in this branch: the tree was identical to `main`, whose own CI run
43637956443 passed. The demonstration stopped there and was not captured as green.

With approval, only the failed job was rerun. Attempt 2 (started 21:13:10Z) passed
`windows-latest` (job 132590277837), leaving all eight required checks `SUCCESS` on
`261968a`, and that is the green state captured above. The flaky test is followed up in
[issue #45](https://github.com/tecruz/anvil/issues/45); the bounded timeout and the
Windows CI evidence, including the most likely cause (the 20-second tool bound), are recorded in
[the 2026-11-15 follow-up](2026-11-15-windows-acl-timeout.md).

## Sanitized excerpts

Condensed from the captured responses: fields not shown were dropped, and nested
`checkSuite` objects are flattened to `app` and `workflowRun`. No tokens or account data
were captured.

GraphQL, missing (`31a54d7`):

```json
{"headRefOid":"31a54d74c268c8fa78d9dd563b3af7bb28fa00c4","baseRefOid":"f0c28c9b929c0ffacb1384fbe8056df9d2c11a09","isDraft":false,"mergeStateStatus":"BLOCKED","mergeable":"MERGEABLE","statusCheckRollup":null}
```

REST check-runs, missing (`31a54d7`) and current head untested (`bb8c60c`):

```json
{"total_count":0,"check_runs":[]}
```

GraphQL, pending (`43fffd8`), one context shown; the other seven are the same shape:

```json
{"mergeStateStatus":"BLOCKED","mergeable":"MERGEABLE","statusCheckRollup":{"state":"PENDING","contexts":[{"name":"windows-latest","status":"IN_PROGRESS","conclusion":null,"isRequired":true,"app":15368,"workflowRun":43639842492}]}}
```

GraphQL, failed (`43fffd8`):

```json
{"mergeStateStatus":"BLOCKED","statusCheckRollup":{"state":"FAILURE","contexts":[{"name":"windows-latest","conclusion":"FAILURE","isRequired":true},{"name":"playbook registry (rot check)","conclusion":"SUCCESS","isRequired":true}]}}
```

REST check-runs on the earlier head (`261968a`), read during the untested-head capture:

```json
{"sha":"261968a65c24922bf5d67e3ec90513a8f9d846b3","total_count":8,"conclusions":["success"],"app_id":15368}
```

`gh pr view`, final head (`715145a`):

```json
{"number":44,"isDraft":false,"headRefOid":"715145a93b3134be5410fb55a4c4b7be030a39fb","mergeStateStatus":"CLEAN","mergeable":"MERGEABLE"}
```

## Cleanup

PR #44 was returned to draft, closed unmerged and its branch deleted
(closed 2026-11-14T21:29:48Z). The protection, ruleset, repository settings and `main` SHA
were re-read after cleanup and compared with the snapshot taken before the first push:
no differences.
