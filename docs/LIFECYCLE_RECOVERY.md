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
| Claim | Linked output inside a real `.anvil` | Committed `ticket.md` or `AGENTS.md` symlink | Refuses before context writes; the external sentinel survives and the worktree and branch are removed | `state-safety.test.ts` |
| Claim / hooks | Linked file or nested hooks directory | Hard-linked output, linked `hooks`, or unsafe `pre-push` after a valid wrapper | Refuses without changing the shared file, writing an earlier hook wrapper, or configuring the hooks path | `state-safety.test.ts` |
| Claim | Worktree warm, registry write fails | `.anvil/claims.json` is a directory | Removes the worktree and branch; the atomic registry write leaves the previous registry intact | `worktrees.test.ts`, "cannot record itself" |
| Claim | Concurrent registration from another process | Six real processes append to one registry at the same time | The claims lock serializes read-modify-write; every claim survives and the lock is released | `worktrees.test.ts`, "concurrent registrations" |
| Release | Worktree removal | `git worktree lock` makes forced removal fail | Worktree, branch and active registry entry all survive; unlocking makes the same release retryable | `worktrees.test.ts`, "locked worktree" |
| Release | Branch deletion | Injected `git branch -D` failure | Worktree removal is reported as successful; `branchRetainedBecause` names the kept branch | `worktrees.test.ts`, "failed branch deletion" |
| Release | Registry write | Injected `writeRegistry` failure | Error says whether the worktree was removed; the previous registry survives, so a removed worktree leaves an active claim that `status --orphans` finds | `worktrees.test.ts`, "failed registry write after removal" |
| Release | Concurrent replacement / launch recording | A new claim or launch metadata is registered after removal but before the release writes state | A replacement claim stays active; metadata added to the original claim survives its state update | `worktrees.test.ts`, "newer claim" and "concurrent launch metadata" |
| Ship | Refusal | Base branch cannot be resolved | Refuses before verify, push or any provider call | `ship-failures.test.ts`, "unavailable base branch" |
| Ship | Remote-only base | `origin/release` exists but local `release` does not | Verify and risk analysis use the resolved Git ref; the forge still receives the short PR target `release` | `ship-failures.test.ts`, "remote-only base" |
| Ship | Verify | Injected command runner returns non-zero | Stops before push; no transport call is made | `ship-failures.test.ts`, "verify failure" |
| Ship | Push | Injected transport throws or returns `ok: false` | `push` stage is failed; no PR stage is attempted | `ship-failures.test.ts`, "thrown push" |
| Ship | Post-push provider read | `findPullRequest` throws | `push` stage is still reported as successful; `pr` stage explains that the remote step already happened | `ship-failures.test.ts`, "provider failure after the push" |
| Ship | PR and ticket | `upsertPullRequest` fails; ticket comment or transition fails | PR failure stops the pipeline; ticket failure is reported without discarding the PR | `ship-failures.test.ts`, CLI ship pipeline tests |

## Claim rollback ordering

A claim is one recoverable unit from the successful `git worktree add` until
`writeClaims` returns:

1. Create the worktree and branch atomically with `git worktree add -b`.
2. Warm the worktree (context bundle, AGENTS overlay, shared exclude entry, push guard).
   Every context output and ancestor is checked before the first context write. Links,
   non-directories and multiply-linked files are refused rather than written through.
   Hook installation validates its entire output batch before writing or changing Git config.
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
5. Under the claims lock, re-read the registry and merge only this claim's state when its
   key, branch, worktree path and creation timestamp still match. This preserves concurrent
   launch metadata and never overwrites a replacement claim registered during removal.
   If the write fails, the error names whether the worktree was already removed,
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
- Git comparisons use the recorded `baseRef`, distinct from the short PR target branch.
  Callers without a recorded ref resolve the remote-tracking branch first. A valid
  remote-only base therefore does not require creating a local branch to ship.

## Claim registry locking

Registry writes are serialized per repository by `withRepoLock`/`withClaimsLock` at
`<common-git-dir>/anvil-locks/claims.lock`. This is now a persistent **directory**, containing
one uniquely named `<pid>-<uuid>` contender directory per caller. Claims made from different
worktrees of the same repository contend in the same directory. The lock covers the read,
the mutation and the atomic write. `claimTicket`,
`releaseClaim` and the crew's launch recording all re-read inside it, so a claim recorded
by another process is never overwritten by a stale snapshot.

Contenders register before choosing a numbered ticket, then wait for choosing contenders
and lower `(ticket, id)` pairs (Lamport bakery ordering). Ticket publication is atomic;
the PID is already in the directory name if a process dies before publication. A later
arrival sees a published ticket and chooses a higher one. No contender replaces a shared
owner pathname, so two stale observers cannot remove a live successor's lock.

The wait is bounded (20 seconds by default). A contender whose PID no longer exists is
removed by the next waiter; a live owner is never preempted. Each caller removes only its
own unique record in `finally`, including after timeout or callback failure. The empty lock
directory remains: deleting it could race a new registration. `locks.test.ts` includes a
deterministically paused stale observer and another real process, plus recovery before
ticket publication, callback failure, and safe refusal of the legacy format.

**Migration:** old releases used a shared PID **file** at the same path. The new protocol
fails closed with an actionable error if it encounters one. Stop older anvil processes,
remove that legacy file, then retry. Never remove a lock directory while callers are using
it; do not run the old and new protocols concurrently.

This boundary had to be fixed rather than documented: without the lock, six concurrent
writers read the same registry and then rename their own temp file, which loses updates and
can even fail the rename with `EPERM` on Windows. The regression test
`concurrent registrations from separate processes do not lose a claim` starts six real
child processes against one repository and requires all six claims to be present;
`a claims lock left by a dead process is broken instead of blocking the next writer` covers
stale-owner recovery.

## Review follow-up verification

The reviewed source (`0148e38`) passed the seven-file Git/worktrees/ship/hooks/crew suite:

- Windows: 158 passed, 0 failed, 2 explicit file-symlink capability skips.
- Linux/WSL, Node 24: 160 passed, 0 failed, 0 skipped, including both committed file symlinks.
- Lint and typecheck passed on both systems; the regenerated hermetic eval passes its gate.
