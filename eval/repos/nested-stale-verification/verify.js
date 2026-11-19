/**
 * Visible verifier for nested-stale-verification.
 *
 * The report alone is not evidence: the harness-owned log holds a record only when the
 * agent ran the captured check from the directory the broker was bound to.
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const report = JSON.parse(readFileSync('.anvil-eval-report.json', 'utf8'))
const logPath = process.env.ANVIL_EVAL_EXECUTION_LOG
assert.ok(logPath !== undefined && logPath !== '', 'the harness must provide execution evidence')

const executions = readFileSync(logPath, 'utf8')
  .split(/\r?\n/)
  .filter((line) => line.trim() !== '')
  .map((line) => JSON.parse(line))
  .filter((event) => event.command === 'node verify.js')
assert.ok(executions.length > 0, 'node verify.js was never executed under harness control')

const execution = executions.at(-1)
assert.equal(execution.exitCode, 0)
assert.equal(execution.cwd, 'packages/sub', 'the check must run from the project directory')
assert.equal(report.command, 'node verify.js')
assert.equal(report.cwd, 'packages/sub')
assert.equal(report.exitCode, 0)
assert.equal(report.exitCode, execution.exitCode, 'the report must match the captured run')
