import assert from 'node:assert/strict'
import test from 'node:test'
import { slugify } from '../src/slug.js'

// The hidden verifier.
//
// This file is copied into the repository *after* the agent has finished, so it grades
// the work without handing the answer over. Everything here is stated in the repository's
// own README, so an agent that read the repository could satisfy it; an agent that did
// not will fail.

test('slugify lowercases the title', () => {
  assert.equal(slugify('Hello World'), 'hello-world')
})

test('slugify collapses runs of spaces into one dash', () => {
  assert.equal(slugify('a   b'), 'a-b')
})

test('slugify trims the dashes at the ends', () => {
  assert.equal(slugify('  Hello  '), 'hello')
})

test('slugify leaves an already-slugged title alone', () => {
  assert.equal(slugify('hello-world'), 'hello-world')
})
