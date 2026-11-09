# ADR-0019: Approval authority is a user-owned store, not a plan digest

- Status: accepted
- Date: 2026-11-09
- Milestone: post-M6
- Extends: [ADR-0018](0018-approved-local-skill-installation.md)

## Context

ADR-0018 added an inspect-only `local-skill/v1` execution plan and named approval as separate
authority: a digest is a change detector, not permission, and a later change would store grants
outside the repository. That later change now exists, and it has to decide where approval
lives, what it binds, how long it lasts and how many times it may be used.

The tempting simplification is to treat the plan digest as the token: hand the user a file,
and let any holder apply it. That fails for the same reason a checksum is not a signature. It
records nothing about who approved, for which repository, or for how long, and a digest can be
recomputed by anyone. It also lets a repository anvil does not own carry its own authority.

## Decision

**Approval is a grant held in a protected, user-owned store, and the digest is only what it
binds.**

- `anvil setup approve --plan <file>` writes a `setup-approval-grant` (`kind:
  "setup-approval-grant"`, `permission: "apply-local-skill-once"`) under
  `~/.anvil/approvals/setup/v1/<id>/grant.json`.
- The store is deliberately **not** the config home. `ANVIL_CONFIG_HOME` may point inside a
  repository, so a repository could otherwise choose where its own authority lives.
  `ANVIL_APPROVAL_HOME` is an explicit, process-level override; a config file cannot set it.
  The store is checked on every read and write: a real directory outside the repository the
  grant approves, private to the current user. On POSIX that means the current user owns the
  store, the grant directory and every record file, with no group or other write bit (the
  store is created `0700`, records `0600`). On Windows it means the same three levels are owned
  by the current user and name no other principal in their access control lists; Node cannot
  read a Windows ACL, so a system PowerShell reports the owner and the entry SIDs (never the
  localized display names), and an ACL that cannot be read is refused. A store reached through
  a link is rejected before any access control list is touched, so a refusal never modifies
  anything.
- A grant binds the plan digest, adapter fingerprint, physical repository root and clean HEAD,
  source path/hash/size, destination, and a digest of the ordered operations including their
  preconditions. It names no approval identity: terminal confirmation is not identity.
- **The confirmation is typed at an interactive terminal, not a flag or a pipe.** `approve`
  shows the plan (on stderr in `--json` mode, so stdout stays one document) and reads the full
  plan digest from a terminal; a digest passed as a command-line argument is not consent, a
  bare `--yes` would launder a glance into approval, and piped input is refused because it is
  not a review. The plan is revalidated after the confirmation, and again before the record is
  read back, so a repository that moved while the reviewer read, or during publication, is
  caught. A missing or empty confirmation is a usage error; a mismatched one is a refusal.
- **Grants are short-lived and single-use.** The default lifetime is ten minutes, and
  `maxAttempts` is one. `consumeSetupApproval` reserves the attempt and reports whether this
  call won it, and application must call it after full revalidation and before its first
  repository mutation, so a crash or partial failure burns the attempt. There is no automatic
  retry. Revocation and reservation share one no-replace state record, so they cannot both win.
- Inspection reports `active`, `expired`, `revoked`, `consumed`, `stale`, `invalid` or
  `unknown`. Terminal states win: a revoked or consumed grant is never active. Revocation is
  terminal and idempotent, and a consumed grant cannot be revoked. With no current repository
  state to check, a non-terminal grant is `unknown`, never `active`. Every record stays
  `executed: false` and `executionSupported: false`.

**This change still applies nothing.** It adds grants, inspection, revocation and reservation.
It adds no `apply` command, writer, journal or verifier, and approving never writes to the
repository.

## Consequences

- A file dropped into a repository cannot authorize anything: authority comes from a store the
  repository cannot control. This does not defend against another process running with the same
  user's privileges.
- A grant goes stale the moment the source, HEAD, adapter behaviour or operations change, and
  a forged or recomputed grant is `stale` or `invalid`, never `active`.
- Short expiry and one attempt keep the window between review and mutation small; a failed or
  crashed application requires fresh approval rather than a silent retry.
- The grant is reusable contract surface for future adapters, but only `local-skill` can be
  approved today, and opaque owner-declared install commands still cannot be approved at all.
- The store adds another `~/.anvil/` directory to reason about, with its own link,
  ownership/ACL and containment checks rather than reusing the repository state helpers.
- A terminal record is self-describing: it stays inspectable, and revocable, after the checkout
  it names is removed, because containment is resolved without requiring the repository to
  still exist.

## Alternatives rejected

- **Treat the plan digest as the approval token.** A digest proves a payload did not change; it
  records neither approver, repository nor expiry, and anyone can recompute one. Authority must
  live somewhere a repository cannot write.
- **Store grants inside the repository.** Convenient and self-contained, but it lets the
  repository that is being modified also mint the permission to modify it, and it dirties the
  worktree the plan pins as clean.
- **Reuse the config home.** `ANVIL_CONFIG_HOME` already redirects anvil's files, and it can
  point inside a repository. Overloading it would let a repository choose its own authority
  location.
- **A `--yes` confirmation.** A boolean is a keystroke, not a review. Requiring the full digest
  makes the approval name the exact plan it authorizes.
- **A long-lived or reusable grant.** A grant is not a standing permission. A short expiry and
  one attempt bound the time and the number of times a reviewed plan can act.
- **Trust symlinks in the store for flexibility.** The store is authority; a link is a
  redirect. Refusing links keeps a compromised or surprising filesystem layout from moving
  where approval lands.
