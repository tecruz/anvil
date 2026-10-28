import assert from 'node:assert/strict'
import test from 'node:test'
import { capitalize } from '../src/util.js'

// Tests for the capitalize function in src/util.js

test('capitalize first char', () => {
  assert.equal(capitalize('hello'), 'Hello')
})

test('capitalize already capitalized', () => {
  assert.equal(capitalize('Hello'), 'Hello')
})

test('capitalize empty string', () => {
  assert.equal(capitalize(''), '')
})

test('capitalize with numbers', () => {
  assert.equal(capitalize('123abc'), '123abc')
})

test('capitalize with special chars', () => {
  assert.equal(capitalize('$test'), '$test')
})
