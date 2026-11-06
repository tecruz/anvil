# Setup proposal contract

`anvil setup plan` and `anvil setup validate --plan <file>` implement only the **inspect**
part of the integration lifecycle. There is no approve, install, apply or execute command.
Generating, saving or validating a proposal never authorizes execution.

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
incomplete observation, even when the command exits 0.

Configured clean/process filters are also disabled: Git status can otherwise execute them
while comparing files. A filtered working copy may therefore conservatively appear dirty.
Repositories with submodules are reported as unknown without recursively checking them,
because submodule-local configuration can name additional helpers. An index that hides
working-tree state is likewise `unknown`: `assume-unchanged` and `skip-worktree` entries
suppress modified files, and a split index is not read at all because merely reading it
refreshes its `sharedindex.*` metadata. The split-index check looks in the index's own
directory as `GIT_INDEX_FILE` was given, and in the resolved Git directory, and matches the
name without regard to case, so a relocated or linked index cannot hide a shared index.
These cases are refused before index-reading commands run.

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

## Boundary for a later execution adapter

Before execution exists, a separately reviewed design must define explicit approval tied to
this exact proposal and relevant current state, immutable resource resolution, known
permissions, reviewable file changes and overwrite preconditions, bounded execution,
credential handling and independent verification. It must revalidate at execution time.
The digest alone is never authority, and a failed or partial integration must not be
reported as completed. Unknown effects in this first slice are not permission to execute.
