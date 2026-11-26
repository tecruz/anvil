# 2026-11-26 — isolated verification for the opt-in ship policy

Status: **merged to `main` with all eight CI checks green.**

| Field | Value |
| --- | --- |
| Final PR head | `3cc1a1e7ccc7b98af439f8c93ae7fc9055f17120` |
| CI run | [45902163502](https://github.com/tecruz/anvil/actions/runs/45902163502) — all eight jobs SUCCESS |
| Merge commit | `fb140a0fa2cafad0b546029d9688ba5b1360af56` |
| PR | [#106](https://github.com/tecruz/anvil/pull/106) |

An earlier run (`45898942967`) failed on Windows because the new tests compared LF fixtures to
CRLF checkouts; the assertions now normalize newlines. A second run (`45900639798`) failed the
eval gate because a source comment changed the implementation hash after the hermetic evidence
was generated; regenerating the evidence fixed it. Both failures were in test/harness wiring,
not in the verification behavior, and are covered by the passing final run.

## Problem

`crew verify --record` sampled the mutable checkout before and after each command. A check could
therefore pass against uncommitted files that are not in the commit `ship` pins. `ship` now pins
the evidence commit, but the evidence itself still described a tree anyone could edit.

A second gap: the version 2 record carried one top-level `cwd` and refused a plan whose commands
ran in different directories, even though the shared verification plan gives every command its
own directory.

## Change

- `packages/cli/src/verification-snapshot.ts` prepares a throwaway `git clone --shared` checked
  out at the worktree's clean HEAD. A dirty worktree, an unsampleable HEAD, or a failed clone
  returns `null` and the runner fails closed. The clone is deleted in a `finally` block after
  `crew verify` finishes.
- `createEvidenceRunner()` in `packages/cli/src/commands/crew.ts` is the single seam. With the
  policy on, commands run in the snapshot and the outcome records the logical repo-relative
  directory; HEAD is re-sampled from the real worktree afterwards, so a moved branch makes the
  record stale. Without the policy, the old mutable-checkout sampling is unchanged.
- `EvidenceCommand` gained an optional `dir`, and `planDigestForEntries()` hashes each command
  with its directory. `currentRecordFor()` no longer forces one directory on every command.
- `ship` accepts both the original single-directory digest and the new per-directory digest, so
  evidence written before this change stays readable, and requires every recorded directory to
  match the plan when per-command directories are present.

## Evidence

Offline controls in `packages/cli/test/verification-snapshot.test.ts` use real temporary git
repositories and prove:

- a clean worktree yields a snapshot of its exact commit; writes in the snapshot do not change
  the worktree; disposal removes it; a **linked claim worktree** can be snapshotted too;
- a dirty worktree never falls back to the mutable checkout (`exitObserved: false`, zero runs);
- the policy runner executes in the snapshot, records `logicalCwd`, and samples the same commit;
- a commit created while the policy check runs makes `revisionAfter` differ from `revision`,
  which `currentRecordFor` turns into no current record;
- without the policy, the runner still uses the mutable checkout.

`packages/cli/test/crew-evidence.test.ts` and `verification-evidence.test.ts` cover mixed
directories, changed directories as a changed plan, stale commits, and backward compatibility
with single-directory records.

No model was called, no study was rerun, and no effectiveness claim was added.
