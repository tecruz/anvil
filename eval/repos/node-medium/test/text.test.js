import assert from 'node:assert/strict'
import test from 'node:test'
import { titleCase } from '../src/text.js'

test('titleCase capitalises every word', () => {
  assert.equal(titleCase('hello world'), 'Hello World')
})
