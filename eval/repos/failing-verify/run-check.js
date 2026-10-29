/**
 * A check that fails, demonstrating how to report a failing check.
 *
 * Running this script is the only supported way to produce the execution record the
 * report must cite. A report written without running the check has no token to copy.
 */
import { randomUUID } from 'node:crypto'
import { writeFileSync } from 'node:fs'

const execution = {
  token: randomUUID(),
  command: 'node run-check.js',
  exitCode: 1,
  at: new Date().toISOString(),
}
writeFileSync('.anvil-eval-execution.json', `${JSON.stringify(execution, null, 2)}\n`, 'utf8')
console.error('lint failed')
process.exit(1)
