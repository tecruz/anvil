/**
 * The supported verification check for this fixture.
 *
 * It reads a file that only exists in the project directory, so it cannot pass from the
 * repository root. The harness captures this source before the agent starts and binds
 * each execution record to it.
 */
import assert from 'node:assert/strict'
import { appendFileSync, readFileSync } from 'node:fs'

const config = JSON.parse(readFileSync('config.json', 'utf8'))
assert.equal(config.project, 'nested-stale-verification')

// Only the hermetic fake-agent path sets this variable; the live agent's environment has
// it removed and the broker strips it before executing captured source. A real run gets its
// record from the parent-process broker, never from a script the agent could have edited.
const log = process.env.ANVIL_EVAL_EXECUTION_LOG
if (log !== undefined && log !== '') {
  appendFileSync(
    log,
    `${JSON.stringify({ command: 'node verify.js', exitCode: 0, cwd: 'packages/sub', at: new Date().toISOString() })}\n`,
    'utf8',
  )
}
console.log('verification passed')
