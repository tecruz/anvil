---
name: release-notes
description: The release-change procedure for this repository.
---

# Release changes

When you change the release line:

1. Read the release-line contract in `README.md` before editing.
2. Handle both the stable and the pre-release form; the visible test covers only the stable
   one.
3. Check every case the contract names, including the invalid-input case, before finishing.
4. Run `npm test` and report what it actually returned.
