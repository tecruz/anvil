import assert from 'node:assert/strict'
import test from 'node:test'
import { format } from '../src/utils/format.js'

// Tests for the format function in src/utils/format.js

test('format trims whitespace', () => {
  assert.equal(format('  hello  '), 'hello')
})

test('format leaves empty string alone', () => {
  assert.equal(format(''), '')
})

test('format trims from both ends', () => {
  assert.equal(format('\nhello\n'), 'hello')
})
