import assert from 'node:assert/strict'
import test from 'node:test'
import { format } from '../../src/utils/index.js'

// Integration test for format function
// This file imports and calls format() from src/utils/index.js

test('integration format function', () => {
  assert.equal(format('  test  '), 'test')
})
