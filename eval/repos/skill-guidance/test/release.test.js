import assert from 'node:assert/strict'
import { test } from 'node:test'
import { releaseLine } from '../src/release.js'

test('a stable version is rendered with a v prefix', () => {
  assert.equal(releaseLine('1.4.2'), 'v1.4.2')
})
