# ADR-0006: Single-file bundle lives in `packages/cli/dist`, not the workspace root

- Status: accepted — the layout stands; the *publish target* it chose is superseded by
  [ADR-0007](0007-distribution-git-install.md)
- Date: 2026-09-28
- Milestone: M0

> **Superseded in part.** This ADR decided that the bundle lives in `packages/cli/dist` and
> that `packages/cli` is the publishable unit, because the registry was the assumed channel.
> The distribution is now a git install, and npm packs the repository root for a git
> dependency — there is no subdirectory install, which was tested rather than assumed. So the
> root is now the package users receive, while everything below about *where the bundle is
> built* still holds. See ADR-0007.

## Context

`IMPLEMENTATION_PLAN.md` originally specified the CLI bundle at the workspace root:

```
anvil/
  package.json     "bin": { "anvil": "dist/cli.js" }
```

Two problems with that:

1. **A publishable package cannot ship a `bin` that points outside its own root.** The
   workspace root is `private: true` and is not the publish target; `packages/cli` is.
   A `bin` of `../../dist/cli.js` breaks on `npm publish` and on `npm link`.
2. **Root-level `dist/` invites ambiguity** about which artifact is current when several
   packages eventually emit build output.

The first shipped version of the code had already deviated from the plan: the build writes
to `packages/cli/dist/cli.js`, and `packages/cli/package.json` declares
`"bin": { "anvil": "./dist/cli.js" }`.

## Decision

The code stays as built. `packages/cli` owns the `bin`; the bundle is emitted to
`packages/cli/dist/cli.js` by `scripts/build.mjs`.

## Consequences

- `packages/cli` becomes the publishable unit when M6 publishes to npm. No path surgery.
- The plan's layout block was corrected to match, and the root `package.json` no longer
  claims a `bin`.
- `npm run build` is still a single command from the root; only the output location moved.
- `packages/*/dist/` is gitignored (already in place), so the artifact stays untracked.
- A future root-level convenience `dist/` symlink is unnecessary; `node
  packages/cli/dist/cli.js` is explicit and used in the M0 verification.

## Alternatives rejected

- **Root `dist/` with `bin` escaping the package**: unpublishable as written.
- **Compiling to `dist/` in every package and pointing `bin` at a symlink**: a symlink in
  a published tarball is fragile across platforms, and there is exactly one binary entry
  point.
- **Publishing from the workspace root**: would force the root to stop being private and
  to carry the CLI's dependencies, mixing concerns for no benefit.
