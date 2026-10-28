import assert from 'node:assert/strict'
import test from 'node:test'
import { calcMean } from '../src/index.js'

// Tests for the workspace-dependency scenario
// The hidden test checks that src/index.js uses stat instead of lists

test('workspace index test', () => {
  assert.equal(typeof calcMean, 'function')
  assert.equal(calcMean([1, 2, 3]), 2)
})
