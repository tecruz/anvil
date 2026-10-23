import assert from 'node:assert/strict'
import test from 'node:test'
import { unique } from '../src/lists.js'

test('unique keeps the first occurrence of each value', () => {
  assert.deepEqual(unique([1, 2, 1, 3, 2]), [1, 2, 3])
})
