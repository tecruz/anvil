/**
 * References carry meaning: a URL names a forge, `gh-42` names GitHub, and `42` names
 * nothing at all. Provider selection depends on telling those apart, so the parsing is
 * pinned here rather than only through a command.
 */

import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { formatRef, parseRef, providerHintFor } from '@anvil/tickets'

const GITHUB_URL = 'https://github.com/acme/widgets/issues/42'
const GITLAB_URL = 'https://gitlab.com/acme/widgets/-/issues/7'

describe('providerHintFor', () => {
  test('a GitHub URL names github, a GitLab URL names gitlab', () => {
    assert.equal(providerHintFor(GITHUB_URL), 'github')
    assert.equal(providerHintFor(GITLAB_URL), 'gitlab')
  })

  test('a gh- or gl- key names its forge, case-insensitively', () => {
    assert.equal(providerHintFor('gh-42'), 'github')
    assert.equal(providerHintFor('GH-42'), 'github')
    assert.equal(providerHintFor('gl-7'), 'gitlab')
  })

  test('a bare number, a local key or a project key names no provider', () => {
    for (const input of ['42', '#42', 'local-3', 'PROJ-123', 'abc', '']) {
      assert.equal(providerHintFor(input), null, `${input} must not name a provider`)
    }
  })

  test('a URL that is not a ticket URL names no provider', () => {
    assert.equal(providerHintFor('https://example.com/docs/42'), null)
  })
})

describe('parseRef', () => {
  test('gh-42 is a GitHub ref, not a local file called gh-42', () => {
    assert.deepEqual(parseRef('gh-42'), { provider: 'github', id: '42', key: 'gh-42' })
    assert.deepEqual(parseRef('GH-42', 'local'), { provider: 'github', id: '42', key: 'gh-42' })
  })

  test('gl-7 is a GitLab ref', () => {
    assert.deepEqual(parseRef('gl-7'), { provider: 'gitlab', id: '7', key: 'gl-7' })
  })

  test('a numeric ref takes the key prefix of the selected provider', () => {
    // `anvil claim 42 --provider github` and `anvil claim gh-42` are the same claim.
    assert.deepEqual(parseRef('42', 'github'), { provider: 'github', id: '42', key: 'gh-42' })
    assert.deepEqual(parseRef('#42', 'github'), { provider: 'github', id: '42', key: 'gh-42' })
    assert.deepEqual(parseRef('42', 'local'), { provider: 'local', id: '42', key: 'local-42' })
  })

  test('a project key keeps its own prefix and the selected provider', () => {
    assert.deepEqual(parseRef('PROJ-123', 'jira'), { provider: 'jira', id: '123', key: 'proj-123' })
  })

  test('a local key stays local and keeps its prefix', () => {
    assert.deepEqual(parseRef('local-3'), { provider: 'local', id: '3', key: 'local-3' })
  })

  test('a URL keeps its own forge even when a default is supplied', () => {
    const ref = parseRef(GITHUB_URL, 'local')
    assert.equal(ref.provider, 'github')
    assert.equal(ref.id, '42')
    assert.equal(ref.key, 'gh-42')
    assert.equal(ref.url, GITHUB_URL)
  })

  test('formatRef shows the key and the URL when it has one', () => {
    assert.equal(formatRef(parseRef('gh-42')), 'gh-42')
    assert.match(formatRef(parseRef(GITHUB_URL)), /^gh-42 \(https:\/\/github\.com/)
  })
})
