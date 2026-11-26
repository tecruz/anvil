# 2026-11-26 — final integration into `main`

Status: **integrated; eight checks green on the final head.**

| Field | Value |
| --- | --- |
| Final PR head | `6a55e9a46158561ae5cfb47f9285125f961434a0` |
| CI run | [45890772345](https://github.com/tecruz/anvil/actions/runs/45890772345) |
| Checks | windows-latest, windows-latest (Node LTS), ubuntu-latest, ubuntu-latest (Node LTS), macos-latest, macos-latest (Node LTS), playbook registry (rot check), gh contract (live) — **all SUCCESS** |
| Local check | `npm run check` passed: generated files, lint, typecheck, full test suite, build, docs (64 documents / 245 links), eval gate |
| Merge commit | `4ff4d6dd6682bfba2b59003db35283f130be15ce` on `main` |

## Sequence

1. [PR #103](https://github.com/tecruz/anvil/pull/103) (dashboard Task Brief) merged into
   `main` at `ccc4de5` with eight green checks.
2. `impl/integrated` was reconciled onto that head, resolving eval-artifact conflicts by
   regenerating the hermetic evidence, and adapting the restored dashboard tests to the v2
   verification-evidence schema.
3. [PR #105](https://github.com/tecruz/anvil/pull/105) carried the reconciliation plus the
   pinned-commit, guidance and grader fixes. All eight checks passed on `6a55e9a`; it merged
   at `4ff4d6d`. This also closed [PR #104](https://github.com/tecruz/anvil/pull/104), whose
   head was then an ancestor of `main`.

The built CLI was smoke-tested from `packages/cli/dist/cli.js`: `version` reported
`anvil 0.2.1 (schema v1, node 24.13.0)` and `brief --json --offline --profile .` returned a
valid brief envelope. No workflow files were changed.

`0.2.1` remains the published version. The integrated work is newer than that tag and has not
been published; publication needs its own approval for a new version and artifact.
