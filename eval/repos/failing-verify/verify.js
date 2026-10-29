import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

// The visible verifier for this verify-only scenario. The report must cite the execution
// record that `run-check.js` writes, so a report written without running the check fails.
const report = JSON.parse(readFileSync('.anvil-eval-report.json', 'utf8'))
const execution = JSON.parse(readFileSync('.anvil-eval-execution.json', 'utf8'))

assert.equal(report.command, 'node run-check.js')
assert.equal(report.exitCode, 1)
assert.equal(report.status, 'failed')
assert.equal(execution.command, 'node run-check.js')
assert.equal(execution.exitCode, 1)
assert.equal(report.executionToken, execution.token, 'the report must cite the check that produced it')
