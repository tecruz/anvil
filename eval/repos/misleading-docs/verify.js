import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

// The visible verifier for this verify-only scenario. It grades the report the agent
// writes, not the agent's prose: a no-op agent leaves no report and fails here.
const report = JSON.parse(readFileSync('.anvil-eval-report.json', 'utf8'))
const pkg = JSON.parse(readFileSync('package.json', 'utf8'))

assert.ok(
  report.command === 'npm test' || report.command === 'npm run test',
  'the report must name the supported test command',
)
assert.ok(pkg.scripts.test, 'package.json must define the test script the report names')
assert.equal(pkg.scripts['test:old'], undefined, 'the README names a script that does not exist')
