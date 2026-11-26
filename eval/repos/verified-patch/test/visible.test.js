import assert from 'node:assert/strict'
import test from 'node:test'
import { slugify } from '../src/slug.js'

test('slugify lowercases and dashes spaces', () => {
  assert.equal(slugify('Hello World'), 'hello-world')
})
