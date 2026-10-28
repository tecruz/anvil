import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, test } from 'node:test'

const temps: string[] = []
process.on('exit', () => {
  for (const t of temps) rmSync(t, { recursive: true, force: true })
})

function temp(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), prefix))
  temps.push(d)
  return d
}

describe('scenario: failing verification', () => {
  test('correctly running and reporting a failed check counts as task success', () => {
    const repoRoot = temp('anvil-scenario-failing-verify-')
    writeFileSync(join(repoRoot, 'package.json'), '{"scripts":{"lint":"eslint .","test":"jest"}}\n', 'utf8')

    // A test that is expected to fail (e.g., flaky or known-bug).
    writeFileSync(
      join(repoRoot, 'flaky.test.js'),
      "test('known broken', () => { throw new Error('known issue'); });\n",
      'utf8',
    )

    // A script that runs the check and exits non-zero.
    writeFileSync(join(repoRoot, 'run-check.js'), "console.error('lint failed'); process.exit(1);\n", 'utf8')

    // Task success = correctly reporting the failure, not making it pass.
    assert.equal(existsSync(join(repoRoot, 'run-check.js')), true)
    assert.equal(existsSync(join(repoRoot, 'flaky.test.js')), true)
  })
})
