# Lifecycle failure and recovery

Status: **Phase 3 complete.** This document records the mutation boundaries each
operation exposes, how a failure is injected without special privileges, and what the user
is left with. It is the reference for the Phase 3 acceptance criterion "faults at each
declared boundary have a documented, tested recovery outcome".

Injection is deliberately boring: a committed file where a directory belongs, a directory
where a file belongs, a directory link (a junction on Windows) where a real directory
belongs, a git worktree lock, a stub provider, or an injected git operation. Link tests skip
wherever the machine cannot create a link without elevation; no test changes machine-wide
permissions or runs elevated.

## Summary

| Operation | Boundary | Injected failure | Recovery outcome | Test |
| --- | --- | --- | --- | --- |
| Stage / replace / clear | Link, non-directory and traversal checks before any mutation | `.anvil` or `staging` replaced by a link or file; manifest path traversal | Refuses; existing paths are left byte-for-byte untouched | `derive.test.ts`, staging containment cases |
| Apply | Read every staged file and resolve every target before the first write | Missing staged file; unsafe or dangling link | Refuses before writing anything | `derive.test.ts`, `staging-apply-failures.test.ts` |
| Apply | Write batch | Second target is a directory; writer fails or partially writes | Restores every attempted target from its pre-apply content; a retry is safe | `staging-apply-failures.test.ts` |
| Apply | Alias collision | Two manifest paths reach one file through a hard link or directory alias | The pre-apply content is restored once, for the shared file | `staging-apply-failures.test.ts` |
| Claim | Preflight and branch collision | Occupied target; invalid branch; branch exists | Refuses before creating a worktree, branch or registry entry | `worktrees.test.ts` |
| Claim | Worktree created, warm-up fails | A committed `.anvil` file makes the context write fail | Removes the worktree and branch it created; registers nothing; no orphan survives | `worktrees.test.ts`, "fails while warming" |
| Claim | `.anvil` is a link | A directory link replaces the state directory | Refuses before writing; the link target receives nothing, and the worktree and branch are removed | `worktrees.test.ts`, "would write through a linked .anvil" |
| Claim | Worktree warm, registry write fails | `.anvil/claims.json` is a directory | Removes the worktree and branch; the atomic registry write leaves the previous registry intact | `worktrees.test.ts`, "cannot record itself" |
| Claim | Concurrent registration from another process | Six real processes append to one registry at the same time | The claims lock serializes read-modify-write; every claim survives and the lock is released | `worktrees.test.ts`, "concurrent registrations" |
| Release | Worktree removal | `git worktree lock` makes forced removal fail | Worktree, branch and active registry entry all survive; unlocking makes the same release retryable | `worktrees.test.ts`, "locked worktree" |
| Release | Branch deletion | Injected `git branch -D` failure | Worktree removal is reported as successful; `branchRetainedBecause` names the kept branch | `worktrees.test.ts`, "failed branch deletion" |
| Release | Registry write | Injected `writeRegistry` failure | Error says whether the worktree was removed; the previous registry survives, so a removed worktree leaves an active claim that `status --orphans` finds | `worktrees.test.ts`, "failed registry write after removal" |
| Ship | Refusal | Base branch cannot be resolved | Refuses before verify, push or any provider call | `ship-failures.test.ts`, "unavailable base branch" |
| Ship | Verify | Injected command runner returns non-zero | Stops before push; no transport call is made | `ship-failures.test.ts`, "verify failure" |
| Ship | Push | Injected transport throws or returns `ok: false` | `push` stage is failed; no PR stage is attempted | `ship-failures.test.ts`, "thrown push" |
| Ship | Post-push provider read | `findPullRequest` throws | `push` stage is still reported as successful; `pr` stage explains that the remote step already happened | `ship-failures.test.ts`, "provider failure after the push" |
| Ship | PR and ticket | `upsertPullRequest` fails; ticket comment or transition fails | PR failure stops the pipeline; ticket failure is reported without discarding the PR | `ship-failures.test.ts`, CLI ship pipeline tests |

## Claim rollback ordering

A claim is one recoverable unit from the successful `git worktree add` until
`writeClaims` returns:

1. Create the worktree and branch atomically with `git worktree add -b`.
2. Warm the worktree (context bundle, AGENTS overlay, shared exclude entry, push guard).
   `.anvil` is validated as a real directory inside the worktree first; a link or a file is
   refused rather than written through.
3. Read the runner version, environment notes and upstream state. None of these mutate.
4. Under the repository claims lock, read, merge and atomically write the claim registry.
   This is the last fallible step. The lock covers the whole read-modify-write cycle, so a
   claim recorded by another process is never overwritten by a stale snapshot.

If step 2, 3 or 4 fails, the new worktree is force-removed, then the new branch is deleted.
Only then is the original error rethrown, with `details.cleanedUp` set to `true`. If either
cleanup command fails, the error says cleanup was incomplete and names the worktree and
branch to inspect; it never claims the claim was rolled back when it was not.

The shared `.git/info/exclude` entry is intentionally not rolled back. It is idempotent,
contains only `.anvil/`, and removing it could delete an entry another claim depends on or
that the user added.

## Release ordering

1. Read the registry and the live worktree status.
2. Refuse when uncommitted or uncountable unpushed work exists, unless `force` is set.
3. Remove the worktree. A forced removal can still fail for a locked worktree; nothing else
   has changed at that point, so the claim stays active and the operation is retryable.
4. Delete the branch only after the worktree is gone. A branch-deletion failure is a
   reported partial result, not a reason to pretend the worktree is still there.
5. Under the claims lock, re-read the registry, replace this claim's entry and write it
   atomically. Re-reading inside the lock keeps a claim another process made during the
   release. If the write fails, the error names whether the worktree was already removed,
   because that determines whether the user has an orphan to clean up.

## Ship ordering

The irreversible ordering is unchanged: refuse, verify, push, PR, ticket. The additions are
about what a failure *reports*:

- A thrown provider call is converted into a failed stage, so the caller still receives the
  stages that succeeded.
- An unreadable existing PR is reported after the push, because the branch is already on the
  remote and the user needs to know that.
- An unresolved base ref refuses before any provider call, rather than deriving an empty
  diff and an empty risk analysis from a failed command.

## Claim registry locking

Registry writes are serialized per repository by `withRepoLock`/`withClaimsLock`: a
pid-stamped lock at `<common-git-dir>/anvil-locks/claims.lock`. Because it lives beside the
common git dir, claims made from different worktrees of the same repository contend on the
same file. The lock covers the read, the mutation and the atomic write. `claimTicket`,
`releaseClaim` and the crew's launch recording all re-read inside it, so a claim recorded
by another process is never overwritten by a stale snapshot.

The wait is bounded (20 seconds by default). A lock whose recorded pid no longer exists is
removed by the next waiter; a live owner is never preempted. The file is released in
`finally`, including when the mutation or the write throws.

This boundary had to be fixed rather than documented: without the lock, six concurrent
writers read the same registry and then rename their own temp file, which loses updates and
can even fail the rename with `EPERM` on Windows. The regression test
`concurrent registrations from separate processes do not lose a claim` starts six real
child processes against one repository and requires all six claims to be present;
`a claims lock left by a dead process is broken instead of blocking the next writer` covers
stale-owner recovery.
