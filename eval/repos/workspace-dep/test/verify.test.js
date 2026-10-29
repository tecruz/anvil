import assert from 'node:assert/strict'
import test from 'node:test'
import { depExists } from '../packages/b/index.js'

test('consumer receives the updated dependency', () => {
  assert.equal(depExists, true)
})
