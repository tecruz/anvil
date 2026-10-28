import assert from 'node:assert/strict'
import test from 'node:test'
import { capitalize } from '../src/util.js'

test('capitalize first char', () => {
  assert.equal(capitalize('hello'), 'Hello')
})
