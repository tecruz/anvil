import { spawnSync } from 'node:child_process'

// The gate is part of the harness, not a second implementation of it. This wrapper only
// exists so `npm run eval:check` reads as a command and forwards its exit code.
const result = spawnSync(process.execPath, ['scripts/eval.ts', '--check'], {
  cwd: process.cwd(),
  stdio: 'inherit',
})

process.exit(result.status ?? 1)
