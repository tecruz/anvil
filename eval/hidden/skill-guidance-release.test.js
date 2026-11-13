import assert from 'node:assert/strict'
import { test } from 'node:test'
import { releaseLine } from '../src/release.js'

test('a pre-release keeps its label', () => {
  assert.equal(releaseLine('2.0.0-rc.1'), 'v2.0.0-rc.1 (pre-release)')
})

test('a stable version is unchanged by the pre-release rule', () => {
  assert.equal(releaseLine('10.0.0'), 'v10.0.0')
})

test('an empty version is a caller error', () => {
  assert.throws(() => releaseLine(''), TypeError)
})

test('a non-string version is a caller error', () => {
  assert.throws(() => releaseLine(null), TypeError)
})
