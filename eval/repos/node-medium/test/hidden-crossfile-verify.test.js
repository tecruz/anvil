import assert from 'node:assert/strict'
import test from 'node:test'
import { format } from '../src/utils/index.js'

// Hidden integration test for cross-file regression
// The task is to fix a typo in src/utils/format.js.
// The hidden test imports and calls format() from src/utils/index.js;
// a local edit to format.js alone is insufficient.

test('cross-file format test', () => {
  assert.equal(format(' test '), 'test')
})
