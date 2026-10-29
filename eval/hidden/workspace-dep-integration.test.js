import assert from 'node:assert/strict'
import test from 'node:test'
import { dep } from '../packages/a/index.js'

// Hidden verifier for workspace-dependency scenario.
// This file is copied into the repository *after* the agent has finished,
// so it grades the work without handing the answer over.
//
// It checks that @repo/a exports dep = true after the fix.

test('@repo/a exports dep = true', () => {
  assert.equal(dep, true)
})
