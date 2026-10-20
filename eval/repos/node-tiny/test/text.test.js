import assert from 'node:assert/strict'
import test from 'node:test'
import { truncate } from '../src/text.js'

test('truncate leaves a short string alone', () => {
  assert.equal(truncate('hello', 10), 'hello')
})

test('truncate cuts and marks a long string', () => {
  assert.equal(truncate('hello world', 8), 'hello w…')
})
