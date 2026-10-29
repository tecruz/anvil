import assert from 'node:assert/strict'
import test from 'node:test'
import { depExists } from '../index.js'

test('consumer sees the updated dependency', () => {
  assert.equal(depExists, true)
})
