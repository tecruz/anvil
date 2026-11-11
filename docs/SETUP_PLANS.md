# Setup plan contracts

`anvil setup plan` and `anvil setup validate --plan <file>` implement the **inspect** part of
the integration lifecycle; `anvil setup approve`, `approval` and `revoke` manage approval
grants; and `anvil setup apply --plan <file> --grant <id>` performs one create-only
application of the plan a grant authorizes. Generating, saving or validating a plan never
authorizes execution, and approving never writes to the repository.

Two plan formats exist today. The original `SetupPlan` describes owner-declared install
commands and stays inspect-only. The `SetupExecutionPlan` describes one create-only
`local-skill/v1` adapter, can be approved, and can be applied once through its grant.

## Supported inputs

This first slice supports two existing owner declarations from the effective layered
configuration:

- `project.commands[]` entries with `kind: "install"`;
- non-empty `project.tools[].install` commands.

Detected or inferred install commands and discovered resources are not promoted into setup
actions. A project with no declarations gets an empty proposal, not a guessed install line.
This command does not check whether any tool is missing or whether setup is needed; use
`anvil ready --check` separately for environment observations.

Command text is copied **verbatim**, never parsed, expanded or executed. Environment values
are not consulted. Owners must not put literal credentials into command declarations: a
declared command is intended to be displayed. Refer to environment variable names instead.

## Version 1 payload

The normal CLI envelope carries a `SetupPlan` in its `data` field:

| Field | Meaning |
| --- | --- |
| `schemaVersion`, `kind` | `1`, `"setup-plan"` |
| `status` | Always `"proposed"`, never verified or completed |
| `executed`, `executionSupported` | Both `false` |
| `approval` | Always `"not-granted"` |
| `repository` | Physical root, HEAD commit or `null`, and Git worktree state |
| `inputsDigest` | SHA-256 of effective project declarations and default working directory |
| `actions` | Ordered owner-declared install proposals |
| `warnings` | Explicit limits and missing knowledge |
| `digest` | SHA-256 of the canonical payload excluding `digest` itself |

Each action records a stable declaration-index id, its configuration field in `source`,
kind, tool id if applicable, exact command, repository-relative `cwd`, whether the action is
required, and its declared version requirement. A command's explicit `dir` wins over the
detected project directory; tool-install commands use the project directory. Absolute
directories and parent traversal are refused. Directory links are **not** execution-vetted.
As in readiness, only the first declared install command is primary (`required: true`);
additional install declarations are optional alternatives, not an instruction to run all of them.

Every action also carries `requiresApproval: true`, `verification: "not-run"`, and three
deliberately unknown fields:

- `immutableRef: null`: a declared version requirement is not an immutable resource pin;
- `permissions: null`: opaque command text cannot prove required privileges or network access;
- `fileChanges: null`: unknown effects, **not** an assertion that the command changes no files.

There is no setup-specific configuration or secret-value field. Provenance points to the
effective declaration field, which may come from the global or repository configuration;
these declarations are not independently trusted or approved.

## Determinism and validation

Canonicalization sorts object keys recursively and preserves array order. Plans have no
timestamp, random id, environment value, remote URL or document content. Identical inputs
produce identical digests. Editing the payload without recomputing its digest is invalid;
recomputing a digest does not help a different plan match the current inputs.

Save the envelope's **data object**, not the envelope. Keep it outside the worktree or in an
ignored file so saving it does not itself dirty the repository. For example, with `jq`:

```bash
anvil setup plan --json | jq '.data' > ../setup-plan.json
anvil setup validate --plan ../setup-plan.json --json
```

Both commands are read-only: no staging bundle, installation, file patch, environment
probe, service connection or online discovery. They use Git metadata commands, with
repository-configured fsmonitor disabled and optional index writes disabled. The selected
plan file must be regular JSON no larger than 1 MiB.

Implicit object fetching is disabled. `GIT_NO_LAZY_FETCH=1` is set for metadata reads, and
when a promisor remote or partial-clone filter is configured, `--no-lazy-fetch` is also
passed explicitly. That flag exists only in Git 2.45 and later, so an older Git fails the
read closed instead of letting it fetch; a repository without a promisor remote is
unaffected. A partial clone whose local objects are unavailable is reported as `unknown`
rather than triggering a network fetch. A warning on Git's stderr is also treated as an
incomplete observation, even when the command exits 0; a warning during the promisor probe
keeps the repository state `unknown` rather than only enabling the fetch guard.

Configured clean/process filters are also disabled: Git status can otherwise execute them
while comparing files. A filtered working copy may therefore conservatively appear dirty.
Repositories with submodules are reported as unknown without recursively checking them,
because submodule-local configuration can name additional helpers. An index that hides
working-tree state is likewise `unknown`: `assume-unchanged` and `skip-worktree` entries
suppress modified files, and a split index is not read at all because merely reading it
refreshes its `sharedindex.*` metadata. The split-index check looks in the index's own
directory as `GIT_INDEX_FILE` was given (resolving `..` with filesystem semantics and
keeping filename whitespace) and in the resolved Git directory, and matches the name
without regard to case, so a relocated, linked or differently-cased shared index cannot
hide one. These cases are refused before index-reading commands run.

Validation compares the saved payload with a newly generated plan, not just its claimed
digest. It refuses changed commands, added fields, forged approval fields, changed effective
declarations, another repository root, or a different HEAD. Dirty, missing-HEAD, nested
profile or incomplete repository state cannot validate as current.

The validation payload reports `current`, `stale`, `invalid` or `unknown` and always retains
`approval: "not-granted"` and `executed: false`. A refusal emits `ok: false` with the payload
and exits **5**. Unreadable or malformed plan JSON exits **3**; invalid flags exit **2**.

Git state here means HEAD and tracked/untracked status. It does **not** attest to ignored
files, credentials, system configuration, installed binaries, network resources or another
machine's environment. An unchanged plan is not an approval record, proof of safety,
successful setup, or an operating-system sandbox.

## Execution-plan contract: `local-skill/v1`

The first bounded execution adapter plans the installation of one agent skill already in the
repository:

```bash
anvil setup plan --adapter local-skill --source docs/skills/release-notes.md --name release-notes
anvil setup plan --adapter local-skill --source docs/skills/release-notes.md --name release-notes --json
```

The source must be a repository-relative, regular UTF-8 file of at most 128 KiB. The
destination is always `.agents/skills/<name>/SKILL.md`, and `<name>` must match
`^[a-z0-9]+(-[a-z0-9]+)*$` and the name in the skill's frontmatter, and be at most 255
characters so it fits one filesystem path component. The destination skill
directory must be absent. Existing `.agents`, `.agents/skills` and unrelated skills may
remain; they are never overwritten, merged or deleted.

The adapter performs no downloads, package-manager calls, scripts, subprocesses, service
starts or global installation. It refuses absolute paths, parent traversal, backslashes,
control characters, `.git` paths, symbolic links, junctions and non-regular sources.
Containment is decided before the source is read, and an unreadable or unresolvable path is
`unknown`, never an assumed absence.

The normal CLI envelope carries a `SetupExecutionPlan` in its `data` field:

| Field | Meaning |
| --- | --- |
| `schemaVersion`, `kind` | `1`, `"setup-execution-plan"` |
| `status` | Always `"proposed"` |
| `executed`, `executionSupported` | `executed` is false and `executionSupported` is true: the adapter can be applied, but this plan is not authority. Application requires a separate grant and `anvil setup apply`. |
| `approval` | Always `"not-granted"` |
| `adapter`, `adapterFingerprint` | `"local-skill/v1"` and a hash of its behaviour descriptor |
| `repository` | Physical root, HEAD commit or `null`, and Git worktree state |
| `inputsDigest` | SHA-256 of the adapter, fingerprint, name and source path |
| `skill` | Validated skill name and exact destination path |
| `source` | Repository-relative path, exact SHA-256, byte length and decoded content |
| `operations` | Ordered directory and file operations, each with its precondition |
| `effects` | Filesystem-only writes; no processes, network, credentials, deletion or overwrite |
| `verification` | The narrow check a later verifier may run and what it cannot prove |
| `warnings` | Explicit limits and missing knowledge |
| `digest` | SHA-256 of the canonical payload excluding `digest` itself |

The file operation records `overwrite: false` and `publish: "temp-file-no-replace"`. The
directory operations distinguish an existing real directory (`absent-or-real-directory`)
from the skill directory that must be absent. A plan includes the source content so the
reviewer sees the bytes that would be installed, not a summary of them. The human preview
escapes terminal control characters (screen erasure, cursor moves, bell) so the file cannot
drive the reviewer's terminal; the JSON payload keeps the exact bytes and hash. The source
hash pins those bytes; it does not establish authorship, trustworthiness, quality or
effectiveness.

Validation treats the saved plan as untrusted JSON. It extracts only the adapter name, skill
name and source path, validates them, rebuilds the plan from current files and repository
state, and compares the entire payload. A changed source, a newly existing destination, a
different repository root or HEAD, or a changed adapter fingerprint is `stale`. A malformed,
tampered or forged payload is `invalid`. Unreadable or unresolvable current inputs are
`unknown`. Dirty, missing-HEAD and incomplete repository state cannot validate as `current`.
The result always retains `approval: "not-granted"` and `executed: false`.

## Approval grants (`local-skill/v1`)

Approval is separate authority, not a property of a plan. A grant authorizes **one
application attempt of one exact plan**, and it lives outside the repository because a
repository anvil does not own must not be able to mint its own authority.

```bash
anvil setup approve --plan ../execution-plan.json
anvil setup approval --grant <id>
anvil setup revoke --grant <id>
```

`anvil setup approve` rebuilds the plan from the saved adapter inputs, requires the result to
be `current`, and refuses anything but a `local-skill` execution plan. It then **shows the
plan** (on stderr in `--json` mode, so stdout stays one document) and reads the **full plan
digest typed on an interactive terminal**; a digest passed as a flag is not consent, and piped
or otherwise non-interactive input is refused. The plan is revalidated after the confirmation,
so a repository that moved while the reviewer read is caught, and again before the record is
read back, so a repository that moved during publication cannot be reported as approved. A
non-interactive confirmation is a usage error (**2**), as is an empty one; a digest that does
not match the current plan, or a plan that moved, is a refusal (**5**).

The grant records the plan digest, adapter fingerprint, physical repository root and clean
HEAD, source path/hash/size, destination, an operations digest, the issue and expiry times,
and `maxAttempts: 1`. It contains no timestamp of its own beyond those, no environment value
and no remote URL.

| Field | Meaning |
| --- | --- |
| `schemaVersion`, `kind` | `1`, `"setup-approval-grant"` |
| `id` | The grant id, a UUID |
| `permission` | Always `"apply-local-skill-once"` |
| `planDigest`, `adapter`, `adapterFingerprint` | The exact plan and adapter behaviour approved |
| `repository` | Physical root and the clean HEAD the grant was approved against |
| `source` | Repository-relative path, exact SHA-256 and byte length |
| `skill` | The approved name and destination |
| `operationsDigest` | SHA-256 of the ordered operations, including their preconditions |
| `issuedAt`, `expiresAt` | A short lifetime (ten minutes by default) |
| `maxAttempts` | Always `1` |

Grants are stored under a dedicated user-owned directory
(`~/.anvil/approvals/setup/v1/<id>/grant.json`) and **not** under the configuration home:
`ANVIL_CONFIG_HOME` may point inside a repository, and a repository must not be able to
choose where its own authority lives. `ANVIL_APPROVAL_HOME` is an explicit, process-level
override; a config file cannot set it.

The store is authority, so it is checked on every read and write. It must be a real directory
(not a symlink or junction) that lies outside the repository the grant approves and that is
private to the current user: on POSIX the store, the grant directory and every record file
must be owned by the current user with no group or other write bit (the store is created `0700`
and records `0600`, regardless of umask); on Windows the same three levels must be owned by the
current user and grant access to the current user only, and a foreign owner, a foreign access
control entry, or an ACL that cannot be read is refused. The path must not pass through a link
or junction either, except for the known macOS root aliases `/var`, `/tmp` and `/etc`. A refusal
leaves nothing created: a store reached through a link is rejected before anything is created
or touched, and a store anvil creates is removed again if initialization then fails. A store
anvil creates is made private; a store that already exists must already be private and is
refused rather than repaired, because changing the permissions of a directory anvil did not
create is not authority. The grant record is written with
no-replace semantics and read without following links or multiply-linked files. These checks
are fail-closed: an uninspectable store is `unknown`, and a record with an unknown field, a
future issue time, or a duplicated binding that disagrees with the plan is `invalid` or
`stale`, never `active`. A terminal record stays inspectable, and revocable, after the checkout
it names is removed.

`anvil setup approval --grant <id>` reports one status:

| Status | Meaning |
| --- | --- |
| `active` | Valid, current, unexpired, unused and not revoked |
| `expired` | The expiry has passed |
| `revoked` | Explicitly withdrawn |
| `consumed` | An application attempt has already been reserved |
| `stale` | Current inputs differ from the approved ones |
| `invalid` | Malformed or inconsistent record |
| `unknown` | The record, store, or current repository state cannot be inspected reliably |

`anvil setup revoke --grant <id>` is terminal and idempotent; revoking a revoked grant
reports `revoked`, but a `consumed` grant already started its attempt and cannot be revoked.
`approval` succeeds (**0**) only when the status is `active`; every other status exits **5**
with the record on an `ok: false` envelope.

`consumeSetupApproval` reserves the single attempt and returns whether this call won it
(`reserved: true`) or the attempt was already gone. Revocation and reservation share one
no-replace state record, so they cannot both win and the terminal outcome is deterministic.
There is no automatic retry.

## Application (`local-skill/v1`)

`anvil setup apply --plan <file> --grant <id>` applies the one current plan a grant
authorizes:

```bash
anvil setup apply --plan ../execution-plan.json --grant <id>
anvil setup apply --plan ../execution-plan.json --grant <id> --json
```

The command reads the saved plan's adapter inputs, rebuilds the plan, and requires the result
to be `current`. It reads the grant and requires it to match that plan. It then acquires an
`setup-apply` repository lock, re-reads the repository state, rebuilds and compares the plan
again, and only then calls `consumeSetupApproval`. The attempt is reserved **before** the
first directory or file is created, so a crash or a failed write burns the attempt. A
refusal before reservation leaves the grant active and writes nothing.

A recorded outcome is reported only when the saved plan is the exact plan the grant names
(its canonical digest matches) and the command runs in the same physical repository. A
different plan or checkout is refused rather than told that the installation succeeded
there. A `started` journal is re-read under the repository lock: a live attempt is waited
for and then settled from its terminal record, while a `started` journal still present once
the reader holds the lock belongs to a dead writer and is reported as `interrupted`. A
consumed reservation with no journal yet is handled the same way: the reader waits for the
lock, re-reads the grant and the journal, and reports `interrupted` only if no journal
appeared. A reservation record that is unreadable only because it is caught in its own
hard-link publication window is also waited out; if it is still unreadable once the reader
holds the lock, it is corrupt and the command refuses. Authority is always re-read while the
lock is held, never reused from before the wait. A saved plan that reads as stale only
because a concurrent writer already created the destination is settled the same way: the
journal and reservation are re-read, and an existing attempt is reported instead of a
misleading "destination already exists" refusal.

Application is create-only:

- `.agents` and `.agents/skills` must be real directories or absent; they are created only
  when absent.
- `.agents/skills/<name>` must be absent.
- The file is written to a temporary file and linked into place without replacing anything,
  with an exclusive create as the fallback on a filesystem without hard links.
- An existing destination is never overwritten, merged, updated or deleted.

### The journal

Every reserved attempt writes `application.json` beside the grant, in the protected store,
before the first mutation. It records the grant id, plan digest, adapter fingerprint,
repository root and HEAD, source hash and size, the ordered operations with their observed
status, the verification result and one of these states:

| Journal state | Meaning |
| --- | --- |
| `started` | The attempt is in progress. It is reported as `interrupted` only when it is still `started` after the reader holds the repository lock. |
| `succeeded` | The reviewed bytes were installed and independently verified. |
| `failed` | Nothing was mutated; the attempt is over. |
| `partial` | Something was mutated, or verification failed; the outcome is not a completed integration. |

The journal is written with private permissions and read without following links or
multiply-linked files. It belongs to one grant and one plan; a journal that disagrees with
them is rejected as `interrupted`, never trusted as success.

### Statuses and exit codes

`setup apply` reports one status on its payload:

| Status | Meaning |
| --- | --- |
| `applied` | The reviewed bytes are installed and the independent verifier passed |
| `failed` | The attempt was reserved but no repository write completed |
| `partial` | Something was written, or the installed bytes could not be verified |
| `interrupted` | An earlier attempt was reserved and no live writer holds its lock, but it has no usable terminal outcome |
| `refused` | The plan, grant or repository check prevented any attempt |

Only `applied` exits **0**. A recorded `succeeded` journal that still verifies is reported as
`applied` with `executed: false` and `alreadyApplied: true`, so repeating the command is safe
and writes nothing. `failed`, `partial`, `interrupted` and `refused` exit **5** with the
record on an `ok: false` envelope. Unreadable plan JSON exits **3**; invalid flags exit **2**,
and so does a lock that cannot be acquired within the bounded wait.

### Verification

After publishing, a separate verifier reads the destination back from disk. It checks that
the destination is inside the physical repository, that it is a regular file rather than a
link, that its bytes and length match the approved source hash, and that the skill metadata
is still valid. Only then is the outcome `applied`.

That is the whole claim. It does **not** prove that an agent loaded, followed, trusted or
successfully used the skill, and it does not prove authorship, quality or safety. A
verification failure leaves the written bytes in place for inspection; it deletes nothing and
reports `partial`.

## Boundary and limits

The journal is the record of what a reserved attempt did. It is not a transaction log: there
is no rollback, no automatic retry, and no cleanup that deletes existing content. A failed or
partial application requires inspection and, for another attempt, a fresh approval.

The digest alone is never authority. Opaque owner-declared install commands remain
proposal-only and cannot be approved or applied. A successful application does not make the
filesystem safe: the repository lock serializes anvil processes, not arbitrary writers, and
the path and no-replace checks reduce accidental overwrites without preventing another
same-user process from changing paths concurrently. Approval is not an operating-system
sandbox.
