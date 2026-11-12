# Skill guidance fixture

A tiny release-tooling project. `releaseLine` renders a version for the release notes.

## Release-line contract

- A stable version renders as `v<version>`, so `1.4.2` becomes `v1.4.2`.
- A version containing a hyphen is a pre-release: `2.0.0-rc.1` renders as
  `v2.0.0-rc.1 (pre-release)`.
- An empty version, or one that is not a string, is a caller error: throw a `TypeError`.

The visible test covers the stable case only. The team's operating procedure for release
changes is kept in an installed agent skill under `.agents/skills`.
