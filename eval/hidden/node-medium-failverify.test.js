import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import test from 'node:test'

// failing-verification: verify command ran and produced output
test('verify ran and produced evidence', () => {
  assert.ok(existsSync('test/hidden-failverify.test.js'), 'hidden test was copied')
})
