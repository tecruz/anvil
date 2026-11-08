# ADR-0018: Approved local skill installation starts with one create-only adapter

- Status: accepted
- Date: 2026-11-08
- Milestone: post-M6

## Context

Inspect-only setup proposals (`SetupPlan` v1) describe owner-declared install commands but
cannot describe their permissions, file effects or immutable resource identity. Arbitrary
command text is not a safe thing to execute merely because a user once looked at it. The
integration lifecycle still needs a first bounded case that can be reviewed, approved and
verified without pretending an opaque installer is contained.

The useful narrow case is an agent skill that already exists inside the repository. Copying
one text file is an effect we can name exactly, bound with a hash, and verify after the
fact. It also exercises the important lifecycle questions -- approval, stale inputs,
no-overwrite publishing, partial failure and independent verification -- without turning
Anvil into a package manager or a shell runner.

## Decision

**The first execution adapter is `local-skill/v1`, and it is create-only.** One plan installs
exactly one standalone `SKILL.md` from a repository-local, bounded, regular UTF-8 file to
`.agents/skills/<name>/SKILL.md`. It performs no downloads, package-manager calls, scripts,
subprocesses, service starts or global installation. It never overwrites, merges, updates
or deletes existing content. The destination skill directory must be absent.

**The plan is a separate, strict contract.** `setup plan --adapter local-skill` emits a
`SetupExecutionPlan` (`kind: "setup-execution-plan"`) containing the physical repository
identity and clean HEAD, the adapter's behaviour fingerprint, an input digest, the exact
source path/hash/size/content, the destination, ordered operations with preconditions,
explicit filesystem-only effects, and the narrow verification scope. A deterministic
canonical digest binds the whole reviewed payload. Plans contain no timestamps, random ids,
environment values or remote URLs.

**The existing proposal contract does not become executable.** `SetupPlan` v1 remains
inspect-only. Opaque owner-declared install commands never gain approval or execution by
being present beside a local-skill plan.

**Approval is separate authority, and a digest is not approval.** A later change will store
grants outside the repository, bind them to the full plan digest, repository identity, source
hash, destination preconditions and adapter fingerprint, give them a short expiry and one
application attempt, and require an interactive confirmation. A managed grant id is not
interchangeable with repository-supplied approval JSON. Application will revalidate
everything before writing, hold a repository-scoped lock, write through a temporary file and
publish with no-replace semantics. A crash or a partial result is reported as such; there is
no automatic retry and no cleanup that deletes existing content.

**Verification has a deliberately narrow claim.** A separate verifier may prove that the
reviewed bytes are present at the destination as a regular file, match the recorded hash and
length, and still carry valid skill metadata. It cannot prove that an agent loaded the skill,
followed it, trusted it or completed a workflow successfully.

**This change is inspection-only.** It adds the contract, planning, content preview and
validation. It adds no `approve` or `apply` command, no grant store, no writer, no journal
and no executor. Every plan and validation result remains `approval: "not-granted"` and
`executed: false`.

## Consequences

- A user can review the exact skill bytes and every proposed write before any approval
  mechanism exists. Validation rebuilds the plan from the saved adapter inputs and refuses a
  changed source, changed repository state, existing destination or tampered payload.
- The source hash pins bytes, not authorship. Installing a skill is not a trust decision
  about its author, and the plan says so.
- Filesystem checks and create-only publishing reduce accidental overwrites, but they are
  not an OS sandbox against another process changing paths concurrently. Application will
  need its own revalidation and locking; this slice documents the boundary rather than
  claiming protection.
- Because the destination directory must be absent and the adapter never updates an
  installed skill, changing a skill requires a new name or a later, separately reviewed
  update design.
- A plan file carries the source content (bounded to 128 KiB) so it can be reviewed and
  saved under the existing 1 MiB plan-file limit. Larger instruction files are refused
  rather than truncated.
- Tests cover deterministic digests, tampering and recomputed digests, stale sources and
  repository state, invalid skill metadata, traversal and absolute paths, `.git` sources,
  symbolic links and junctions, existing destinations, non-regular and invalid UTF-8
  sources, whitespace-bearing filenames, and no writes during planning or validation.

## Alternatives rejected

- **Execute owner-declared install commands after confirmation.** Their effects and
  permissions are unknown, so neither the plan nor the verifier can say what happened. A
  confirmation prompt would launder that ignorance into apparent approval.
- **Use a generic shell-command adapter first.** It would make the approval boundary depend
  on arbitrary command text and require containment and credential handling that do not
  exist yet. One concrete file effect is a better first proof of the lifecycle.
- **Allow overwriting an existing skill.** Overwrite turns a reviewed create into a
  destructive update. Preserving existing content is more useful than a convenient retry.
- **Install directly from a URL or package manager.** That adds network trust, version
  resolution and remote code execution to the first adapter. A local file keeps the source
  reviewable and offline.
- **Treat the plan digest as the approval token.** A digest proves only that a payload did
  not change. It does not record who approved it, for which repository, or for how long.
- **Verify that the agent used the skill.** Installation and agent behaviour are different
  claims. A verifier that cannot observe the agent must not report success on its behalf.
