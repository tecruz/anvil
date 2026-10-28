# ADR-0012: Versioned prebuilt distribution via a scoped registry package

- Status: accepted
- Date: 2026-10-28
- Milestone: Phase 4
- Supersedes: none — extends [ADR-0007](0007-distribution-git-install.md)

## Release status

The decision is accepted, but the registry channel is **unreleased**. Acceptance records the
intended design, not an available npm package. GitHub installation remains the supported
channel until a scoped release has been published and verified.

The existing release workflow still packs and publishes the repository root (`anvil`), not
the scoped `packages/cli` workspace. Before advertising registry installation, it must pack,
test, and publish the scoped artifact, and installation of the published `@anvil/cli` package
must be verified from the registry.

## Context

ADR-0007 established that the repository root is the distributed package for the git install
channel (`npm install -g github:tecruz/anvil`), because npm packs the repository root and there
is no subdirectory install. That channel works today, but it has two problems the plan's Phase 4
addresses:

1. **Every install rebuilds.** `prepare` runs `npm run build`, so the consumer fetches the
   build toolchain (esbuild, TypeScript, biome) to produce a binary that then has zero runtime
   dependencies. That is slow, and it means the installed artifact is whatever the local
   toolchain produced, not what was tested.
2. **No versioned release.** A git install with no tag tracks the default branch, so a breaking
   change reaches a user without a version bump. The README tells users to pin a tag, but the
   registry cannot enforce it, and there is no checksummed artifact to verify.

Phase 4 will ship a versioned prebuilt distribution: a tarball built once, tested exactly as those
bytes, checksummed, and published to a registry. The git channel remains tested and supported
for users who prefer it.

## Decision

**Publish `packages/cli` as `@anvil/cli` to the npm registry, built once from a release tag.**

- The root manifest stays `anvil` for the git install channel (ADR-0007 unchanged).
- `packages/cli` is already named `@anvil/cli`, has its own `bin` (`./dist/cli.js`), its own
  `files` allowlist (`dist/cli.js`), and zero runtime dependencies — it is already a coherent
  registry publish target.
- The executable users type stays `anvil`, because that is what `bin` declares. The package
  name (`@anvil/cli`) is scoped to avoid colliding with the unrelated unscoped `anvil` on npm
  (which the README already warns users away from).
- The published tarball contains only the built CLI bundle, its `package.json`, `LICENSE`, and
  the README. Source, fixtures, tests, transcripts, and build-tool dependencies are excluded.
- Release is triggered by a protected version tag (`v0.1.0`, `v0.2.0`, …). A SHA-pinned release
  workflow builds the tarball, installs it into an isolated consumer project, smoke-tests the
  installed binary (version, help, JSON, doctor, MCP handshake), records the tarball checksum
  and source SHA, and publishes those same bytes — never rebuilt after testing.

**The git channel is not retired.** `npm install -g github:tecruz/anvil#v0.1.0` keeps working
and remains covered by CI. The registry will be an additional, faster, checksummed channel — not a
replacement.

## Consequences

- Once released, users can `npm install -g @anvil/cli` and type `anvil`, with a pinned version and a
  checksummed artifact.
- The root manifest is unchanged: `private` stays undefined, `prepare` still builds, and the
  git install path is still tested by CI and by `packages/cli/test/package.test.ts`.
- `packages/cli/package.json` gains nothing structural (name, bin, files, engines already
  exist). What changes is process: releases are cut from tags, not from `main` directly.
- A version-tag release workflow is added under `.github/workflows/`, scoped with least
  privilege and OIDC where the registry supports it. Publishing credentials are never granted
  to ordinary PR CI.
- The tarball's checksum and the source commit SHA are recorded in the release notes, so a
  user can verify the published bytes match what was tested.

## Alternatives rejected

- **Publish the root manifest as `@tecruz/anvil`.** This would make the git install and the
  registry install different packages with different names, and the root would lose its role as
  the `anvil` command's install unit. Keeping the root as `anvil` (git) and publishing
  `@anvil/cli` (registry) keeps both channels coherent.
- **Commit the built bundle to `main`.** Rejected by ADR-0007: tracked `dist/` reintroduces
  the "which artifact is current" ambiguity and every commit would carry a multi-hundred-kB
  diff. Build-once-from-tag is the same principle without the commit noise.
- **Publish from `main` on every merge.** Rejected: `main` is not a release, and rebuilding
  after testing invalidates the evidence. Tags are the release boundary.
