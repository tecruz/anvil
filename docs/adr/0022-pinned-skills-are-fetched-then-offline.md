# ADR-0022: A pinned skill is fetched once, then planned offline

- Status: accepted
- Date: 2026-11-16
- Milestone: post-M6
- Extends: [ADR-0021](0021-setup-adapters-are-a-registry.md)

## Context

ADR-0021 made setup adapters a closed registry and stated the rule a remote adapter has to
follow: **adapters do not write and do not open network connections**. Issue #41 asks for a
second integration path beyond `local-skill/v1`, and the most requested one installs a skill
from another repository. The tempting implementation lets `setup plan` reach GitHub, but that
breaks the property the earlier ADRs bought: `plan`, `validate`, `approve` and `apply` are
offline, deterministic and reviewable, and the bytes a reviewer saw are the bytes a grant
binds.

Three smaller questions had to be answered before writing code:

- A branch or tag is mutable, so an approved plan that names one does not pin anything.
- `gh` is resolved through `PATH`, and a repository can contain an executable named `gh`. A
  fetch inside that checkout would authenticate with the repository's own binary.
- The protected store was built for grants. Caching remote bytes puts attacker-influenced
  content in the same store, so the read path must be at least as strict.

## Decision

**Fetching is a separate, explicit command, and everything after it reads frozen bytes.**

- `anvil setup fetch --adapter pinned-skill --repo <owner/name> --ref <ref> --path <file>
  --name <skill>` resolves the ref to a full 40-hex commit and downloads that one file at that
  commit. `--commit <40-hex>` skips resolution. Passing both is allowed only when they name the
  same commit.
- `anvil setup plan --adapter pinned-skill --repo <owner/name> --commit <40-hex> --path <file>
  --name <skill>` takes **only** a commit, never a ref. Planning reads the protected cache,
  never the network. `--ref` is a usage error with a hint to run `setup fetch` first.
- Fetching is not a side effect of profiling, `plan`, `validate`, `approve`, `apply`, `brief`,
  `ready`, `doctor` or `discover`. Those commands remain byte-for-byte offline for this
  adapter.
- **The cache separates content from origin.** Bytes are content-addressed at
  `fetched/blobs/<sha256>`; an immutable origin record at `fetched/origins/<id>.json` names the
  host, repository, commit, path, blob hash, byte count, fetch time and the ref the user asked
  for. Origin identity is a digest of host/repo/commit/path; content is not part of it.
- **A commit cannot change content.** Both records are written no-replace. A second fetch of
  the same origin that yields different bytes is a conflict, not a replacement, and the
  conflict names the protected store rather than overwriting it. Re-fetching identical bytes
  is an idempotent `cached` result and does not move the recorded fetch time, so an approved
  plan's identity is stable.
- **The read path is fail-closed.** A missing origin or blob is `unknown`; a malformed record,
  a size mismatch or bytes that do not hash to their address is `invalid`. Neither becomes a
  plan. Reading re-hashes the bytes on every plan, because the content address is the only
  reason to trust cached content. It also checks every directory between the store root and
  the record, not only the record file: `lstat` follows parent components, so a link or a
  foreign directory above a record can redirect a read while the file itself still looks
  regular. Either makes the read `unknown`.
- **`gh` must be outside the checkout, and the host is pinned on the wire.** The default runner
  resolves `gh` to an absolute path and refuses a binary whose real path is inside the
  repository the fetch is for. The `SetupFetchGhRun` seam stays a test seam, not a security
  boundary. The host is explicit (`--host`, default `github.com`), never taken from the
  repository's remotes, and a host other than GitHub is `UNSUPPORTED_HOST` in v1. Every
  `gh api` call passes `--hostname` with that value, so an inherited `GH_HOST` cannot send the
  request elsewhere while the origin record still names `github.com`.
- **Bounds and grammar are the existing ones.** Repository is `owner/name`, the path uses
  `isSafeSetupExecutionPath`, the ref is bounded and cannot start with `-`, and the file is
  capped at `MAX_SOURCE_BYTES` (128 KiB) on both the reported and the decoded size. A ref that
  does not resolve to a full SHA is refused rather than treated as a moving target.
- **`verify-change` is reserved.** `anvil init` owns the generated verify skill path, so a
  pinned skill cannot take that name. The reservation is shared with `local-skill`, not a
  pinned-skill special case.
- **Adapters that need new authority get the v2 records.** `pinned-skill/v1` writes a v2 grant
  whose `bindings` duplicate the origin, content identity and destination, and a v2 journal
  whose `subject` is the artifact being installed. The framework persists `attempting` before
  each mutating syscall, so an exception after a primitive started is `partial`, and `failed`
  is reserved for a known no-mutation outcome. `local-skill` keeps its v1 records and its
  shipped classification.
- **Application stays create-only.** `.agents/skills/<name>` must be absent; existing files are
  never replaced, merged or edited. v1 has no replacement path and therefore no preimages to
  restore.

## Consequences

- A reviewer can inspect one document that contains the exact bytes, the commit that produced
  them and the destination, without a network connection at review time.
- Fetch is auditable as its own step: it either wrote a new blob and origin, or reported the
  existing records. A fetch cannot silently change what an approved plan refers to.
- The protected store now holds two kinds of record. Both use the same private-directory and
  no-link read rules, checked on the record and on every directory between it and the store
  root, and the fetch code refuses a store inside the repository before creating anything.
- A commit pins bytes, not authorship, review, licensing, safety or intent. It also does not
  prove an agent will load the skill or follow it. The plan warnings say so, and the docs say
  so.
- An offline machine cannot plan a pinned skill it has never fetched. That is the cost of the
  guarantee, and the remedy is one explicit command.
- Deferred work is explicit: replacing an existing file, restoring a previous version, and
  therefore storing preimages are out of v1. #41's replacement and preimage cases remain open
  for the follow-up; this ADR must not be read as shipping them.
- An `mcp-config/v1` adapter, if added, follows the same shape: an explicit fetch or none at
  all, no network in planning, a v2 grant and journal, and create-only effects over absent
  targets only.

## Alternatives rejected

- **Let `setup plan` fetch on demand.** Planning would have side effects, the reviewed bytes
  would come from a different network call than the installed bytes, and a plan digest could
  name content nobody ever saw.
- **Plan from a tag or branch.** The plan would name a moving target; the same document would
  resolve to different bytes tomorrow and a grant would bind nothing durable.
- **Store only the URL and re-download at apply time.** Apply would need the network, could
  install bytes different from the reviewed ones, and could never report a deterministic
  outcome offline.
- **Overwrite an origin record when a refetch disagrees.** A commit is immutable. Overwriting
  would launder a changed or compromised response into an approved plan's identity.
- **Use the repository's `gh` or the default `PATH` runner without containment.** A committed
  `gh` shim would run with the user's token against the repository it came from.
- **Reuse the v1 grant and journal for pinned skills.** v1 records are local-skill-shaped: no
  origin, no content identity and a single `mutated` flag. Retrofitting them would either
  change shipped bytes or leave the new adapter unable to name what it approved.
- **Support replacement in v1.** Replacement needs preimages, a restore path and a diff
  policy. Adding it now would ship an overwrite primitive before its recovery story exists.
