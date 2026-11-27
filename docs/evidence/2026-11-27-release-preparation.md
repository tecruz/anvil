# 2026-11-27 — release preparation refresh (no publish)

Status: **prepared only**. This refreshes the no-publish rehearsal in
[2026-11-20-release-preparation.md](./2026-11-20-release-preparation.md) against current
`main`. No `npm publish`, tag or release workflow dispatch was run, and
`.github/workflows` was not changed.

## Candidate

| Field | Value |
| --- | --- |
| Package | `@anvil-workflows/cli` |
| Version | `0.2.1` (from `packages/cli/package.json`; branch rehearsal, no `v*` tag) |
| Source commit | `32d1074d5f353c256e4a83371fd7412a8e4d9954` (`main` after #108) |
| Tarball | `anvil-workflows-cli-0.2.1.tgz` |
| SHA-256 | `ee884d3f6630ab135e33ede3c4c977cbc881a2bb742ea5531862becb10b4cf20` |
| Tarball size | 321,281 bytes |
| npm shasum | `dfa93af68ee75fd60105b3f6c45e3dbbc4becd03` |

The tarball was built **once**: `npm run check` (which includes `npm run build`) on merge
commit `586eb35d72c01d38a9db15ebed048d4fb304f3aa`, then
`npm pack --workspace @anvil-workflows/cli --pack-destination dist`. That merge has
`32d1074` as a parent. The only tree differences from `32d1074` are this branch's
evidence documents and one unreferenced historical eval run; none of those files are in
the tarball. Rebuilding after this point would invalidate the evidence.

`0.2.1` was already published from `33e24ee36256b429ce72ea919cd2ba0cb7730c11` on
2026-11-26, with SHA-256 `9dbdb1c2a16f39fbada7d528beac2faab7fc4609e23c8051d8b5e2b5ff4162e9`
([2026-11-26-release-publication.md](./2026-11-26-release-publication.md)). These rehearsal
bytes are a different tarball from a later source and **must not** be published as
`0.2.1`. A later publication needs a new version, a new tag, and separate explicit approval.

## Checks performed

Local gates on the merge commit, before packing:

- `npm run check` passed: lint, typecheck, 2,597 tests (2,586 passed, 11 skipped, 0 failed),
  `npm run build`, docs check (67 documents, 248 links, 282 command mentions), and
  `npm run eval:check`. Hermetic eval-results were already current for this implementation
  and harness; they were not regenerated.

Packing and artifact gates (Europe/Lisbon, 27 November 2026):

- `node scripts/resolve-release-ref.mjs` with `GITHUB_REF=refs/heads/feat/release-prep`
  reported `version=0.2.1` and `rehearsal=1`.
- The tarball allowlist is exactly `package/LICENSE`, `package/README.md`,
  `package/package.json` and `package/dist/cli.js`.
- `scripts/verify-release-identity.mjs` reported
  `release identity: @anvil-workflows/cli@0.2.1 (rehearsal; no tag)`.
- `scripts/verify-release-artifact.mjs` verified the tarball name, version, source commit
  and SHA-256 sidecar against the same bytes. Output:
  `verified @anvil-workflows/cli@0.2.1 (ee884d3f6630) in dist/anvil-workflows-cli-0.2.1.tgz`.
- The tarball was installed into a fresh consumer project with
  `npm install --no-save --ignore-scripts <tarball>`.
- The installed binary ran `anvil version --json` (`version=0.2.1`, `schemaVersion=1`,
  `node=24.22.1`) and `anvil doctor --json` (`ok=true`, `command=doctor`).
- The installed binary completed the MCP handshake used by the release workflow
  (`scripts/check-mcp-handshake.ts`): protocol `2025-06-18`, 3 tools.
- After those smokes, `sha256sum --check` on `SHA256SUMS` still matched.

Installed-dashboard smoke from the same binary (`anvil dashboard --repo <checkout> --port 0`):

- The one-time session URL issued a cookie (HTTP 302) and served the page with all four
  tabs (Task brief, Repository, Context, Work) and the `#task-map` container.
- `/app.js` from that session still routes Claim, Verify crew and Ship (with verification)
  through `window.confirm` before `runAction`.
- `GET /api/snapshot` returned HTTP 200.
- Pasted-text `POST /api/brief` returned HTTP 200 with a task map.
- `POST /api/action` with an unknown action returned HTTP 400
  (`Unknown action or unsafe argument`).
- The three Work actions were not executed, so this rehearsal did not write a claim or
  run `anvil ship`.

`SHA256SUMS` and `RELEASE_NOTES.md` were written outside the tarball so the tested bytes
were not changed. The tarball was not committed.

## What remains for publication

- A new version number. Republishing these bytes as `0.2.1` would disagree with the
  already-published tarball.
- Explicit, separate approval for that new version and this source commit.
- A matching `v*` tag and a release run that publishes the same tarball bytes.
- Re-check `@anvil-workflows` scope control immediately before publishing;
  scope ownership is a snapshot, not a permanent fact.
- Record the published checksum and source SHA in the release notes.

No publication, tagging, workflow dispatch or `.github/workflows` change was made in this
preparation.
