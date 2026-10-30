import assert from 'node:assert/strict'
import test from 'node:test'
import { main } from '../src/index.js'

test('main returns the updated value', () => {
  assert.equal(main(), 'updated')
})
