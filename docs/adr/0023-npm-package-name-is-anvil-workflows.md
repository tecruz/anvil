# ADR-0023: The registry package name is `@anvil-workflows/cli`

- Status: accepted
- Date: 2026-11-17
- Milestone: Phase 4
- Supersedes: the package name in [ADR-0012](0012-versioned-prebuilt-distribution.md); the
  distribution decision itself stands

## Context

ADR-0012 chose `@anvil/cli` to avoid the unrelated unscoped `anvil` package. Phase 4's
name-control check on 2026-11-17 found that the `@anvil` **scope** was already in use:
npmjs.com listed `@anvil/common-asc`, with `kyle-mccarthy` named as the package's publisher,
and the registry endpoint also listed that package under the scope. Neither establishes
scope ownership or maintainer access. `@anvil/cli` returned 404, which does not prove that
it was never published. At that first check the maintainer's npm account was not
authenticated on the build machine (`npm whoami` returned `ENEEDAUTH`), and no `NPM_TOKEN`
repository secret was listed.

The maintainer selected `@anvil-workflows/cli`. The `@anvil-workflows` scope did not exist
when checked (`{"error":"Scope not found"}`), and `@anvil-workflows/cli` returned 404. The
maintainer then created the org; `npm org ls anvil-workflows --json` returned
`{"tecruz":"owner"}` on 2026-11-17, which confirms name control. The package is still
unpublished. The check is recorded in
[the npm scope evidence](../evidence/2026-11-17-npm-scope.md).

## Decision

**Publish `packages/cli` as `@anvil-workflows/cli`. The executable stays `anvil`, and the
root git-install package stays `anvil`.**

- Everything in ADR-0012 about build-once, the tarball allowlist, checksums, provenance and
  the tag boundary is unchanged. Only the registry package name changes.
- The release workflow packs `--workspace @anvil-workflows/cli`, refuses to publish when the
  packed name differs from that exact string, and titles release notes with the new name.
- The registry channel remains unreleased until a first release is separately approved.

## Consequences

- `packages/cli/package.json`, the lockfile workspace link, the release workflow, the
  packaging tests and the architecture documents name the new package.
- An `NPM_TOKEN`, when created, must grant publish access to `@anvil-workflows/cli`. It is
  not a credential for `@anvil`, and it must not be granted to ordinary pull-request CI.
- Scope control and package availability are snapshots. Re-check maintainer membership and
  the intended package/version immediately before the first release, because either can
  change after this confirmation.
- The packed tarball filename changes to `anvil-workflows-cli-<version>.tgz`. The command
  users type does not change.

## Alternatives rejected

- **Keep `@anvil/cli`.** The scope already contains an unrelated package, and maintainer
  control was not established. A new maintainer-controlled org avoids that uncertainty.
- **`anvil-cli` or `@anvil-tools/cli`.** Both names are already published by other people.
- **`@tecruz/cli`.** The npm scope does not exist and matches a personal account name; the
  maintainer chose a product-named scope instead.
