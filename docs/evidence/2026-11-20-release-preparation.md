> Historical record of the 2026-11-20 rehearsal of `@anvil-workflows/cli@0.1.0` from
> `9d2fce8087d396ae2cb8abc6ea147fd76eee1531`. It is not the current candidate. The
> refreshed no-publish rehearsal against `main` `32d1074` is
> [2026-11-27-release-preparation.md](./2026-11-27-release-preparation.md).

# 2026-11-20 — first publication preparation (no publish)

Status: **prepared only**. The maintainer approved preparation of the first
`@anvil-workflows/cli` release on 2026-11-20 and explicitly did **not** approve
publication. No `npm publish`, tag or release workflow dispatch was run.

## Candidate

| Field | Value |
| --- | --- |
| Package | `@anvil-workflows/cli` |
| Version | `0.1.0` (from `packages/cli/package.json`; branch rehearsal, no `v*` tag) |
| Source commit | `9d2fce8087d396ae2cb8abc6ea147fd76eee1531` |
| Tarball | `anvil-workflows-cli-0.1.0.tgz` |
| SHA-256 | `73a61665db9e665c020f0b88f469d21471977191501d0847784647977f462516` |
| Tarball size | 268,488 bytes |

The tarball was built **once** with `npm run build` followed by
`npm pack --workspace @anvil-workflows/cli --pack-destination dist`. Rebuilding
after this point would invalidate the evidence; publish this exact tarball or
rehearse again from scratch.

## Checks performed

- `node scripts/resolve-release-ref.mjs` with `GITHUB_REF=refs/heads/feat/release-prep`
  reported `version=0.1.0` and `rehearsal=1`.
- `scripts/verify-release-artifact.mjs` verified the tarball name, version,
  source commit and SHA-256 sidecar against the same bytes. Output:
  `verified @anvil-workflows/cli@0.1.0 (73a61665db9e) in dist\anvil-workflows-cli-0.1.0.tgz`.
- The tarball was installed into a fresh consumer project with
  `npm install --no-save --ignore-scripts <tarball>`.
- The installed binary ran `doctor --json` successfully
  (`ok=true`, `command=doctor`). No install scripts were needed.
- `SHA256SUMS` and `RELEASE_NOTES.md` were written outside the tarball so the
  tested bytes were not changed.

## What remains for publication

- Explicit, separate approval for **this** version and source commit.
- A `v0.1.0` tag (or an explicitly approved alternative) and a release run that
  publishes the same tarball bytes.
- Re-check `@anvil-workflows` scope control immediately before publishing;
  scope ownership is a snapshot, not a permanent fact.
- Record the published checksum and source SHA in the release notes.

No publication, tagging, workflow dispatch or `.github/workflows` change was
made in this preparation.
