/**
 * A check that fails, demonstrating how to report a failing check.
 *
 * Running this script is the only supported way to produce execution evidence. The
 * harness owns the log path (`ANVIL_EVAL_EXECUTION_LOG`) and reads it after the agent
 * finishes, so a report written without running the check has nothing to match.
 */
import { appendFileSync } from 'node:fs'

const execution = {
  command: 'node run-check.js',
  exitCode: 1,
  at: new Date().toISOString(),
}
const log = process.env.ANVIL_EVAL_EXECUTION_LOG
if (log !== undefined && log !== '') {
  appendFileSync(log, `${JSON.stringify(execution)}\n`, 'utf8')
}
console.error('lint failed')
process.exit(1)
