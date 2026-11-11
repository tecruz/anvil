# ADR-0020: Application is a journaled, create-only transition after consumption

- Status: accepted
- Date: 2026-11-09
- Milestone: post-M6
- Extends: [ADR-0018](0018-approved-local-skill-installation.md), [ADR-0019](0019-approval-authority-is-a-user-owned-store.md)

## Context

ADR-0018 defined one create-only `local-skill/v1` plan. ADR-0019 made approval a separate,
single-use grant in a protected user-owned store, and named the contract application would
have to satisfy: hold a repository-scoped lock, revalidate completely, consume the single
attempt before the first write, publish without replacing anything, journal an honest
outcome, and verify the installed bytes independently.

That contract now has an implementation: `anvil setup apply --plan <file> --grant <id>`.
The open questions are what happens between reserving the attempt and reporting success, and
what a crash, a concurrent writer or a failed verification is allowed to claim.

The tempting answers are to write first and consume afterwards (so a transient failure does
not burn the grant), to roll back a partial write (so a retry can be clean), or to report
success as soon as the file is on disk. Each hides the actual outcome: the grant would be
reusable after a write, a rollback would delete content anvil did not create, and a write is
not evidence that the reviewed bytes are what landed.

## Decision

**Application is one create-only transition from an active grant to a journaled outcome.**

- **The repository lock comes before revalidation.** `setup apply` acquires an
  `setup-apply` repository lock (the same advisory lock every worktree of the repository
  contends on), then re-reads the repository state, rebuilds the plan from the saved adapter
  inputs and compares the whole payload again. A repository that moved while the command
  waited is refused. The initial, lock-free validation exists only to refuse clearly without
  waiting; it never mutates.
- **The attempt is consumed before the first mutation.** `consumeSetupApproval` is called
  inside the lock. Only `reserved: true` proceeds; any other status is reported and nothing
  is written. A crash or a failed write therefore burns the attempt, and a retry requires a
  fresh approval. This is deliberate: the alternative lets a writer retry after a partial
  write.
- **The journal is written before the first mutation and updated as operations complete.**
  It lives beside the grant as `application.json`, in the same protected store, rather than
  in the repository: the repository must not be able to edit or delete its own record of
  what happened. It records the grant, plan digest, adapter fingerprint, repository HEAD,
  source hash and size, the ordered operations with their observed status, the verification
  result and honest `started`, `succeeded`, `failed` and `partial` states. A `started`
  journal is re-read under the repository lock: a live writer is waited for, and only a
  journal still `started` once the reader holds the lock is reported as `interrupted`, never
  as success. A journal belongs to one grant and one plan; a journal that disagrees is
  untrusted.
- **Publishing is create-only.** Directories are checked as real directories and created
  only when absent; the skill directory is created only when absent; the file is written to
  a temporary file and linked into place, with an exclusive create as the fallback on a
  filesystem without hard links. An existing destination is refused and never overwritten.
  A destination that appears between the checks and the write is caught by the same
  no-replace operation.
- **Verification reads the artifact back and is independent of the writer.** It resolves the
  destination inside the physical repository, refuses links, requires a regular file,
  re-reads the bounded bytes and compares their SHA-256 and length with the approved source,
  and revalidates the skill metadata. Only a passing verification is `applied`. A written
  destination that fails verification is `partial`: it stays on disk for inspection and is
  not deleted. A failed write is `failed` when nothing was mutated and `partial` once
  anything was.
- **A recorded outcome is final.** A second `setup apply` for the same grant reads the
  journal instead of writing again. The saved plan must be the exact plan the grant names,
  and the command must run in the same physical repository; a different plan or checkout is
  refused rather than shown the prior success. A `succeeded` journal is re-verified: if the
  installed bytes still match, the command reports `applied` with `executed: false` and
  `alreadyApplied: true`; if they have since changed, it reports `partial`. A `failed` or
  `partial` journal is reported as such. A reservation with no journal yet is re-checked
  under the repository lock before it is called `interrupted`, and the grant and store are
  re-read under that lock rather than reused from before the wait. The same applies when a
  concurrent writer has already created the destination: a plan that reads as stale for that
  reason is settled under the lock instead of being refused as "already exists". There is no
  automatic retry, no rollback and no deletion of existing content.

**The claim stays narrow.** `applied` means the reviewed bytes are present at the destination
as a regular file with valid skill metadata. It does not mean an agent loaded, followed or
benefited from the skill. It also does not mean the filesystem was sandboxed: the lock
serializes anvil processes, not arbitrary writers, and the checks reduce accidental overwrites
without preventing another same-user process from changing paths concurrently.

## Consequences

- A failed application is visible as a failed or partial journal and a consumed grant. The
  user must inspect the destination and issue a fresh approval; there is no silent retry.
- A successful application is idempotent to re-run: it re-verifies and reports the recorded
  success without writing, so scripts can be safe to repeat.
- The journal adds another record to the approval store, with the same ownership, ACL, link
  and containment checks as the grant. A removed checkout still leaves the outcome readable.
- The verifier can detect drift after installation, but it cannot repair it. An overwritten
  or deleted skill is reported as partial, not restored.
- The repository lock is created one component at a time from the common git dir, and a
  pre-existing link or junction is refused rather than followed. Without that check, a
  `.git/anvil-locks` junction would place lock records, and their cleanup, outside the
  repository before any revalidation ran.
- The adapter fingerprint still pins what a plan writes. Application implements exactly the
  operations the plan described; it does not change them.
- Filesystem effects are still only those the plan names. Owner-declared install commands
  remain proposal-only and cannot be applied.

## Alternatives rejected

- **Consume after a successful write.** A write that fails after consuming nothing could be
  retried, but then a crash mid-write leaves a file anvil did not consume and cannot account
  for. Consuming first makes the attempt the unit of authority.
- **Roll back a partial application.** Removing directories or files can delete content that
  existed before or that another process created concurrently. A journaled partial outcome
  is more honest than a destructive cleanup.
- **Report success after the write.** The writer's return value is not evidence about the
  bytes on disk. Reading the artifact back is the only claim the command can make.
- **Keep the journal in the repository.** The repository being modified would be able to
  edit or erase the record of what happened, and a committed journal would dirty the tree
  the plan pins as clean.
- **Apply without a repository lock.** Two processes could both consume nothing and write
  different bytes, or race the destination checks. The lock makes the transition serial.
- **Upgrade a failed verification to success on a later read.** An attempt that failed its
  own verification is not retroactively successful because the bytes happen to match now.
