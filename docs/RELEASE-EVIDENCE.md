# Exact-candidate release evidence

This is a local checklist for a **separately approved** release review. It is not authorization to
push, tag, dispatch a workflow, or publish. Anvil issue #38 stays unpublished until that approval
exists.

A review may only use evidence produced from one exact local commit. Mixing evidence from an
earlier head makes a green result unusable, even when the later code differs by one line.

## Required on the exact candidate

1. Focused tests for every changed package, using the candidate checkout.
2. Full `npm run test`.
3. `npm run lint`, `npm run typecheck`, `npm run check:docs`, `npm run check:generated` and
   `npm run build`.
4. `npm run eval -- --fake-agent` followed by `npm run eval:check`, so the hermetic summary names a
   run produced by this implementation digest. Keep real trial records under
   `eval-results/pilots/<runId>/`, separate from `eval-results/latest.json`.
5. Green CI for that exact commit, not merely for the base branch. The archive of the hermetic run
   must name that commit, or the report must state that the harness recorded only the parent SHA.
6. A fresh pack of the scoped CLI tarball, installed with `--ignore-scripts` in a clean consumer.
   Record the tarball SHA-256 and the source SHA. Smoke-test the installed artifact itself, not a
   checkout build: both Task Brief entry points, all four tabs, the 2D map, snapshot and brief
   responses, and an unknown action refusal. Confirm the three confirm-gated Work actions remain
   gated. The release workflow's own installed smoke covers `version`, `doctor --json` and the MCP
   handshake only; it does not exercise the dashboard, so it cannot stand in for this step.
7. A review against the frozen acceptance list, after all of the above exist, and a **CLEAN**
   verdict. A review that ends BLOCKED, or that leaves any item unverified, is not a release
   approval even if every other step is green. The shipped bytes must be the same tarball this
   review accepted; rebuilding after review invalidates it.

A Task Brief is a navigation aid. It shows selected checks with sources, working directories and
unknowns; it is not an exhaustive CI inventory and none of its rows is a pass claim.

## Publication boundary

No publication until the maintainer explicitly approves this specific release in #38. Before
publishing, re-check that the maintainer still controls the `@anvil-workflows` npm scope, that the
tag/version/source SHA agree, and that the bytes to be published are the exact tested tarball.
Never rebuild after testing. Keep the read-only dashboard default, confirmations and CLI approval
boundaries unchanged, and flag any change to `.github/workflows/**` for explicit review.
