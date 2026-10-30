import assert from 'node:assert/strict'
import test from 'node:test'
import { render } from '../src/consumer.js'
import { format } from '../src/format.js'

// Hidden integration test for cross-file scenario.
// This file is copied into the repository *after* the agent has finished,
// so it grades the work without handing the answer over.
//
// The shared helper must preserve whitespace; the consumer decides what to do.

test('format preserves whitespace unchanged', () => {
  assert.equal(format('  hello  '), '  hello  ')
})

test('render passes through format results', () => {
  assert.equal(render('  hello  '), '  hello  ')
})
