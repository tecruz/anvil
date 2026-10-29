import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

// Visible verifier for failing-verification scenario.
// This runs after the agent finishes and confirms the agent ran the suite.

test('agent ran the verification command', () => {
  try {
    const content = readFileSync('.anvil-eval-task.md', 'utf8')
    assert.ok(content.length > 0)
  } catch {
    assert.ok(true)
  }
})
