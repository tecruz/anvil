import assert from 'node:assert/strict'
import test from 'node:test'
import { calcMean } from '../src/stats.js'

// workspace-dependency: verify correct import path was used
test('uses correct workspace package', () => {
  assert.equal(calcMean([1, 2, 3]), 2)
})
