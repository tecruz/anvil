# nested-project

Small repository with a subdirectory to test project root detection.

## Layout

- `packages/sub/` -- subdirectory containing the actual project
- `packages/sub/config.json` -- configuration the helper must read from the project root
- `packages/sub/src/helper.js` -- helper module to implement
- `packages/sub/test/helper.test.js` -- tests for the helper
