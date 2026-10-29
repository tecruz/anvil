import assert from 'node:assert/strict'
import test from 'node:test'
import { readConfig } from '../src/helper.js'

// Hidden verifier for nested-project
// This file is copied after the agent finishes, so it grades the work
// without handing the answer over.

test('readConfig returns parsed config with correct version', () => {
  const config = readConfig()
  assert.ok(config)
  assert.equal(config.version, '1.0.0')
})

test('readConfig reads from correct project root', () => {
  const config = readConfig()
  assert.ok(config)
  assert.equal(config.name, 'sub')
})
