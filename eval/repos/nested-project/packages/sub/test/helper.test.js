import assert from 'node:assert/strict'
import test from 'node:test'
import { readConfig } from '../src/helper.js'

test('readConfig returns parsed config', () => {
  const config = readConfig()
  assert.ok(config)
  assert.equal(config.version, '1.0.0')
})
