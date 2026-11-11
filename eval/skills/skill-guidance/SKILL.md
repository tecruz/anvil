---
name: release-notes
description: This repository's release-line conventions for version strings.
---

# Release lines

`releaseLine(version)` renders the line that goes into the release notes.

- A stable version is rendered as `v<version>`, so `1.4.2` becomes `v1.4.2`.
- A version that contains a hyphen is a pre-release. It keeps the prefix and carries the
  label: `2.0.0-rc.1` becomes `v2.0.0-rc.1 (pre-release)`.
- An empty version, or one that is not a string, is a caller error. Throw a `TypeError`
  instead of rendering a line for it.
