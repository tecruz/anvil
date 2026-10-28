import assert from 'node:assert/strict'
import test from 'node:test'
import { format } from '../src/utils/index.js'

test('format sorts ascending', () => {
  assert.equal(format([3, 1, 2]), '1 2 3')
})
