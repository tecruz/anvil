// Phase 0 merge-gate demonstration (#34). This test fails on purpose so the required
// checks report a failure. It is reverted in the next commit and never merged.
import assert from 'node:assert/strict'
import { test } from 'node:test'

test('merge-gate demo: a deliberately failing required check', () => {
  assert.fail('deliberate failure for the Phase 0 merge-gate demonstration (#34)')
})
