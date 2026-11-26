import assert from 'node:assert/strict'
import test from 'node:test'
import { slugify } from '../src/slug.js'

test('slugify trims ends and collapses runs of spaces', () => {
  assert.equal(slugify('  Hello   World  '), 'hello-world')
  assert.equal(slugify('A B'), 'a-b')
})
