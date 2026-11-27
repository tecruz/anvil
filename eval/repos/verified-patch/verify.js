import { spawnSync } from 'node:child_process'

const result = spawnSync(process.execPath, ['--test', 'test/visible.test.js'], {
  stdio: 'inherit',
})
process.exit(result.status ?? 1)
