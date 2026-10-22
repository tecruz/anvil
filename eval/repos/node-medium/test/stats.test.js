import assert from 'node:assert/strict'
import test from 'node:test'
import { mean } from '../src/stats.js'

test('mean averages a list', () => {
  assert.equal(mean([1, 2, 3, 4]), 2.5)
})

test('mean of one value is that value', () => {
  assert.equal(mean([7]), 7)
})
