/**
 * References carry meaning: a URL names a forge, `gh-42` names GitHub, and `42` names
 * nothing at all. Provider selection depends on telling those apart, so the parsing is
 * pinned here rather than only through a command.
 */

import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { formatRef, parseRef, providerHintFor, repositoryOf } from '@anvil/tickets'

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

  test('an enterprise issue URL names github only when its host is known', () => {
    const ghe = 'https://ghe.acme-corp.com/acme/widgets/issues/42'
    assert.equal(providerHintFor(ghe), null)
    assert.equal(providerHintFor(ghe, ['ghe.acme-corp.com']), 'github')
    assert.equal(providerHintFor(ghe, ['acme-corp.com']), null)
    // Passing a known host does not turn a GitLab issue shape into GitHub.
    assert.equal(providerHintFor(GITLAB_URL, ['gitlab.com']), 'gitlab')
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

  test('a known enterprise host parses as a GitHub issue URL', () => {
    const ghe = 'https://ghe.acme-corp.com/acme/widgets/issues/42'
    assert.deepEqual(parseRef(ghe, 'local', ['ghe.acme-corp.com']), {
      provider: 'github',
      id: '42',
      key: 'gh-42',
      url: ghe,
    })
    // An explicit GitHub selection reads the number even when the caller did not pass the
    // host; the selection is a decision, not an inference.
    assert.equal(parseRef(ghe, 'github').id, '42')
    // Without either, it stays an opaque reference rather than being guessed as GitHub.
    assert.equal(parseRef(ghe, 'local').id, ghe)
  })

  test('formatRef shows the key and the URL when it has one', () => {
    assert.equal(formatRef(parseRef('gh-42')), 'gh-42')
    assert.match(formatRef(parseRef(GITHUB_URL)), /^gh-42 \(https:\/\/github\.com/)
  })

  test('a repository named issues or pull still parses to the issue number', () => {
    // The marker was found from the start of the path, so `acme/issues/issues/42` gave the
    // id `issues`. Scanning from the end finds the marker the number actually follows.
    assert.deepEqual(parseRef('https://github.com/acme/issues/issues/42'), {
      provider: 'github',
      id: '42',
      key: 'gh-42',
      url: 'https://github.com/acme/issues/issues/42',
    })
    assert.deepEqual(parseRef('https://github.com/acme/pull/pull/7'), {
      provider: 'github',
      id: '7',
      key: 'gh-7',
      url: 'https://github.com/acme/pull/pull/7',
    })
    // A path that only looks like a marker is not a ticket: the number has to follow it.
    assert.equal(parseRef('https://github.com/acme/issues/issues/not-a-number').provider, 'local')
  })

  test('a GitLab subgroup keeps the whole repository path', () => {
    assert.deepEqual(parseRef('https://gitlab.com/grp/sub/proj/-/issues/9'), {
      provider: 'gitlab',
      id: '9',
      key: 'gl-9',
      url: 'https://gitlab.com/grp/sub/proj/-/issues/9',
    })
  })
})

describe('repositoryOf', () => {
  test('names the repository a ticket URL points at', () => {
    assert.deepEqual(repositoryOf(GITHUB_URL), { host: 'github.com', path: 'acme/widgets' })
    assert.deepEqual(repositoryOf(GITLAB_URL), { host: 'gitlab.com', path: 'acme/widgets' })
    // An Enterprise host is kept as-is, so a pasted GHE URL is read on its own host.
    assert.deepEqual(repositoryOf('https://ghe.acme-corp.com/acme/widgets/issues/3'), {
      host: 'ghe.acme-corp.com',
      path: 'acme/widgets',
    })
  })

  test('a bare key or an unusable URL names no repository', () => {
    for (const input of [undefined, '', 'gh-42', 'not-a-url', 'https://example.com/docs/42']) {
      assert.equal(repositoryOf(input), null, `${String(input)} must not name a repository`)
    }
  })
})
