import assert from 'node:assert/strict'
import test from 'node:test'
import { median } from '../src/stats.js'

// The hidden verifier.
//
// This file is copied into the repository *after* the agent has finished, so it grades
// the work without handing the answer over. Everything here is stated in the repository's
// own README, so an agent that read the repository could satisfy it; an agent that did
// not will fail.

test('median returns the middle value of an odd list', () => {
  assert.equal(median([3, 1, 2]), 2)
})

test('median averages the two middle values of an even list', () => {
  assert.equal(median([4, 1, 3, 2]), 2.5)
})

test('median does not mutate the input list', () => {
  const input = [3, 1, 2]
  median(input)
  assert.deepEqual(input, [3, 1, 2])
})

test('median of one value is that value', () => {
  assert.equal(median([9]), 9)
})
