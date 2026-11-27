import { spawnSync } from 'node:child_process'

// The visible, harness-controlled check for this fixture. The broker captures this file and
// executes it with Node; the hidden acceptance test is applied separately after the arm ends.
const result = spawnSync(process.execPath, ['--test', 'test/text.test.js'], {
  stdio: 'inherit',
})
process.exit(result.status ?? 1)
