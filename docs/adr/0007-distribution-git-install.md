# ADR-0007: Distribution is a git install, so the workspace root is the package

- Status: accepted
- Date: 2026-09-30
- Milestone: post-M6
- Supersedes: [ADR-0006](0006-single-file-bundle-location.md) — the publish target only. Its
  layout decision, that the bundle lives in `packages/cli/dist` and `packages/cli` owns a bin
  pointing at it, still stands.

## Context

The project is not going to the npm registry yet. The distribution channel is
`npm install -g github:<owner>/anvil`, which changes what the manifests have to be, and the
constraint is not obvious.

**npm packs the repository root for a git dependency.** There is no subdirectory install.
This was tested rather than assumed, because the assumption is very plausible and the
alternative is a broken install:

```
$ npm install git+file:///repo#packages/cli
npm error command git --no-replace-objects checkout packages/cli
npm error error: pathspec 'packages/cli' did not match any file(s) known to git
```

npm parses the fragment after `#` as a *ref*, not a path. `packages/cli` is not a branch, so
the checkout fails. The root manifest is the only candidate for a git install, and ADR-0006
had made the root `private: true`, versionless and without a `bin` — so a git install of this
repository would have installed a package that provides no command and cannot be run.

**`prepare` is what makes it work at all.** `packages/*/dist/` is gitignored, so a clone has
no bundle. npm installs a git dependency's devDependencies and then runs its `prepare`
script, so `"prepare": "npm run build"` is the difference between an install that produces a
working CLI and one that ships nothing. The cost is real and was measured: the consumer
fetches the build toolchain (esbuild, typescript, biome) to produce a binary that then has
zero runtime dependencies.

**The version has to come from the root too**, since the root is what gets installed. The
build already refused to trust `npm_package_version` — a script run from the root only sees
the root's package — and reading `packages/cli`'s version is now wrong for the same reason:
that is not the manifest a user receives.

## Decision

The workspace root is the distributed package. It gains `name`, `version`, `license`, `bin`,
`files`, `repository` and `prepare`, and loses `private: true`. Its `bin` points **down** into
`packages/cli/dist/cli.js`, which is inside the package, so nothing escapes the package root
and no path surgery is needed.

`packages/cli` is renamed to `@anvil/cli`, because two manifests in one repository cannot both
be named `anvil` and the confusion is not worth tolerating. It keeps its own `bin` and
`files`, so it remains a coherent registry publish target if one is ever wanted.

A test asserts the root's and `packages/cli`'s versions agree, because two version fields that
can drift is a release-day surprise rather than a redundancy saved.

## Consequences

- `npm install -g github:tecruz/anvil` and `npx github:tecruz/anvil` work, and the `anvil`
  command is what the user types.
- A git install with no ref tracks the default branch, so a breaking change can reach a user
  without a version bump. The README tells users to pin a tag, and the reasoning is the same
  one that puts lockfiles in the plan's detection rules.
- `prepare` runs on every local `npm ci` as well, so a contributor's install builds the
  bundle. That is slower and is the correct trade: it means the thing a contributor tests is
  the thing a user installs.
- ADR-0006's rejected alternative — "publishing from the workspace root" — is now the chosen
  path. It was rejected because it forced the root to stop being private and to carry the
  CLI's dependencies "for no benefit". The benefit is that it is the only layout in which a
  git install can work at all, which the original analysis did not consider because it
  assumed the registry.

## Alternatives rejected

- **Keep ADR-0006 and document a clone-and-build install** (`git clone && npm ci && npm run
  build && npm link`). Correct, and it keeps every manifest as it was, but it asks every user
  to be a developer for the first five minutes. It remains a reasonable fallback and is
  documented in CONTRIBUTING.md.
- **Commit the built bundle** so no build is needed at install. It makes `dist/` a tracked,
  reviewable artifact, which reintroduces the "which artifact is current" ambiguity ADR-0006
  rejected, and every commit would carry a 400 kB diff.
- **Publish to a registry under a scope** to get proper version resolution. Deferred: it needs
  a name decision and credentials, and the git channel works without either.
