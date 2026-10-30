import assert from 'node:assert/strict'
import test from 'node:test'
import { format } from '../src/format.js'

test('format works for simple input', () => {
  assert.equal(format('hello'), 'hello')
})

test('format preserves surrounding whitespace', () => {
  assert.equal(format('  hello  '), '  hello  ')
})
