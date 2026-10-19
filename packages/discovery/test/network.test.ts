/**
 * The network sources, with every transport injected.
 *
 * The theme of this file is the difference between "the network said no" and "we did not
 * ask". Every function here returns `null`, an empty array, or a warning rather than
 * throwing, because a discovery source that fails should not take down the run for the
 * sources that worked -- and conflating "asked and found nothing" with "could not ask" is
 * how a rate limit becomes an apparently-complete empty result that nobody questions.
 */

import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import {
  DEFAULT_MCP_REGISTRY,
  type DiscoverSeeds,
  discover,
  type FetchImpl,
  fetchMcpServers,
  type GhRun,
  parseServers,
  searchGitHub,
} from '@anvil/discovery'

const ANDROID: DiscoverSeeds = {
  officialOrgs: ['android', 'google'],
  keywords: ['android agent skills'],
  mcp: ['android'],
}

function ghOk(body: unknown): GhRun {
  return async () => ({ stdout: JSON.stringify(body), stderr: '', exitCode: 0 })
}

function ghFail(stderr: string): GhRun {
  return async () => ({ stdout: '', stderr, exitCode: 1 })
}

function fetchOk(body: unknown): FetchImpl {
  return async () => ({ status: 200, text: async () => (typeof body === 'string' ? body : JSON.stringify(body)) })
}

const REPOS = {
  total_count: 2,
  items: [
    {
      full_name: 'android/skills',
      html_url: 'https://github.com/android/skills',
      description: 'Official Android agent skills',
      stargazers_count: 1200,
      owner: { login: 'android', type: 'Organization' },
    },
    // A third-party agent-skills repo, not an awesome list. An awesome list is not agent
    // tooling, and `isAgentTooling` filters it out -- which is why this fixture has to be
    // agent tooling for the classification assertions to mean anything.
    {
      full_name: 'someone/android-agent-skills',
      html_url: 'https://github.com/someone/android-agent-skills',
      description: 'Community-maintained agent skills for Android',
      stargazers_count: 9000,
      owner: { login: 'someone', type: 'User' },
    },
  ],
}

describe('searchGitHub', () => {
  test('uses gh when one is injected, and does not shell out', async () => {
    const seen: string[][] = []
    const run: GhRun = async (args) => {
      seen.push(args)
      return { stdout: JSON.stringify(REPOS), stderr: '', exitCode: 0 }
    }
    const result = await searchGitHub('org:android', {
      cwd: '.',
      fetchImpl: fetchOk(REPOS),
      gh: run,
    })
    assert.equal(result?.via, 'gh')
    assert.equal(result?.results.length, 2)
    assert.deepEqual(seen[0]?.slice(0, 4), ['api', '-X', 'GET', 'search/repositories'])
  })

  test('the search query is passed as an argv element, never interpolated into a shell', async () => {
    // Keywords come from a playbook file, which `playbook add` installs from a URL. A seed
    // containing a space or a quote must not be able to reach a shell.
    const args: string[] = []
    const spy: GhRun = async (a) => {
      args.push(...a)
      return { stdout: JSON.stringify(REPOS), stderr: '', exitCode: 0 }
    }
    await searchGitHub('org:android', { cwd: '.', fetchImpl: fetchOk(REPOS), gh: spy })
    assert.ok(args.includes('q=org:android'), 'the query must appear whole as one argv element')
    assert.equal(
      args.some((a) => a.includes('&&') || a.includes(';')),
      false,
      'no shell metacharacter should survive into an argument',
    )
  })

  test('falls back to the REST API when gh declines', async () => {
    // A gh that is installed but not authenticated to the host should cost the better rate
    // limit, not the results.
    const result = await searchGitHub('org:android', {
      cwd: '.',
      gh: ghFail('gh: To get started with GitHub CLI, please run: gh auth login'),
      fetchImpl: fetchOk(REPOS),
    })
    assert.equal(result?.via, 'api')
    assert.match(result?.detail ?? '', /gh declined/)
  })

  test('a token is sent when one is configured', async () => {
    const headers: Array<Record<string, string>> = []
    const fetchImpl: FetchImpl = async (_url, init) => {
      headers.push(init.headers)
      return { status: 200, text: async () => JSON.stringify(REPOS) }
    }
    await searchGitHub('org:android', { cwd: '.', gh: ghFail('no'), fetchImpl, token: 'secret' })
    assert.equal(headers[0]?.authorization, 'Bearer secret')
  })

  test('no token means no authorization header, and the report says so', async () => {
    const headers: Array<Record<string, string>> = []
    const fetchImpl: FetchImpl = async (_url, init) => {
      headers.push(init.headers)
      return { status: 200, text: async () => JSON.stringify(REPOS) }
    }
    const result = await searchGitHub('org:android', { cwd: '.', gh: ghFail('no'), fetchImpl, token: '' })
    assert.equal(headers[0]?.authorization, undefined)
    assert.match(result?.detail ?? '', /anonymous/)
  })

  test('returns null rather than an empty list when it could not ask', async () => {
    const transportFail: FetchImpl = async () => {
      throw new Error('getaddrinfo ENOTFOUND api.github.com')
    }
    const result = await searchGitHub('org:android', {
      cwd: '.',
      gh: ghFail('not installed'),
      fetchImpl: transportFail,
    })
    assert.equal(result, null, 'null means "could not ask", which is not the same as "nothing found"')
  })

  test('a rate limit is a failure to ask, not an empty result', async () => {
    for (const status of [403, 429]) {
      const fetchImpl: FetchImpl = async () => ({ status, text: async () => '' })
      const result = await searchGitHub('org:android', { cwd: '.', gh: ghFail('no'), fetchImpl, token: 'x' })
      assert.equal(result, null, `HTTP ${String(status)} should not look like "no results"`)
    }
  })

  test('an unparseable response body is a failure to ask', async () => {
    const fetchImpl: FetchImpl = async () => ({ status: 200, text: async () => '<html>rate limited</html>' })
    const result = await searchGitHub('org:android', { cwd: '.', gh: ghFail('no'), fetchImpl, token: 'x' })
    assert.equal(result, null)
  })

  test('an item with no full_name is skipped rather than becoming owner "/"', async () => {
    const fetchImpl: FetchImpl = async () => ({
      status: 200,
      text: async () => JSON.stringify({ items: [{ html_url: 'https://github.com/x' }, { full_name: 'a/b' }] }),
    })
    const result = await searchGitHub('x', { cwd: '.', gh: ghFail('no'), fetchImpl, token: 'x' })
    assert.deepEqual(
      result?.results.map((r) => r.fullName),
      ['a/b'],
    )
  })

  test('a missing html_url is derived from full_name', async () => {
    const fetchImpl: FetchImpl = async () => ({
      status: 200,
      text: async () => JSON.stringify({ items: [{ full_name: 'a/b' }] }),
    })
    const result = await searchGitHub('x', { cwd: '.', gh: ghFail('no'), fetchImpl, token: 'x' })
    assert.equal(result?.results[0]?.url, 'https://github.com/a/b')
  })
})

describe('discover', () => {
  test('classifies an official-org repo as official and a third-party one as community', async () => {
    const result = await discover('android', ANDROID, {
      cwd: '.',
      gh: ghOk(REPOS),
      fetchImpl: fetchOk({ servers: [] }),
    })
    const official = result.entries.find((e) => e.repo === 'android/skills')
    const community = result.entries.find((e) => e.repo === 'someone/android-agent-skills')
    assert.equal(official?.tier, 'official')
    assert.equal(official?.section, 'skills', 'described as agent skills, so not community')
    assert.equal(community?.tier, 'community')
    assert.equal(community?.section, 'community', 'a third-party repo is community guidance whatever it is about')
  })

  test('the why names the evidence rather than asserting authority', async () => {
    const result = await discover('android', ANDROID, { cwd: '.', gh: ghOk(REPOS), fetchImpl: fetchOk({}) })
    const official = result.entries.find((e) => e.repo === 'android/skills')
    const community = result.entries.find((e) => e.repo === 'someone/android-agent-skills')
    assert.match(official?.why ?? '', /one of this playbook's official orgs/)
    assert.match(community?.why ?? '', /9000 star\(s\)/)
  })

  test('skips the network entirely when offline, and says so', async () => {
    let called = false
    const run: GhRun = async () => {
      called = true
      return { stdout: '{}', stderr: '', exitCode: 0 }
    }
    const result = await discover('android', ANDROID, { cwd: '.', gh: run, fetchImpl: fetchOk({}), online: false })
    assert.equal(called, false, 'offline must not shell out to gh')
    assert.deepEqual(result.entries, [])
    assert.match(result.sources[0]?.detail ?? '', /offline/)
  })

  test('warns when no transport could reach GitHub, rather than reporting zero results', async () => {
    const result = await discover('android', ANDROID, {
      cwd: '.',
      gh: ghFail('not found'),
      fetchImpl: async () => {
        throw new Error('offline')
      },
    })
    assert.ok(
      result.warnings.some((w) => /no transport could reach GitHub/.test(w)),
      result.warnings.join('; '),
    )
  })

  test('warns when GitHub answered but found nothing that is agent tooling', async () => {
    // Different from the previous case, and it matters: one is a broken transport, the other
    // is a registry whose seeds are wrong. Reporting both as "0 results" loses the difference.
    const plain = { items: [{ full_name: 'a/b', description: 'A library', stargazers_count: 5 }] }
    const result = await discover('android', ANDROID, { cwd: '.', gh: ghOk(plain), fetchImpl: fetchOk({}) })
    assert.deepEqual(result.entries, [])
    assert.ok(result.warnings.some((w) => /nothing matching these seeds is agent tooling/.test(w)))
  })

  test('two queries returning one repository produce one entry', async () => {
    const result = await discover('android', ANDROID, { cwd: '.', gh: ghOk(REPOS), fetchImpl: fetchOk({}) })
    const repos = result.entries.filter((e) => e.repo === 'android/skills')
    assert.equal(repos.length, 1, 'an org-scoped and a keyword query overlap by construction')
  })
})

describe('parseServers', () => {
  test('reads a bare list', () => {
    const entries = parseServers(JSON.stringify([{ name: 'a', url: 'https://x.test/a' }]))
    assert.deepEqual(
      entries.map((e) => e.name),
      ['a'],
    )
  })

  test('reads a servers envelope', () => {
    // The registry has published both shapes. Picking one and asserting on it is how this
    // function ends up returning [] against a registry that changed nothing about itself.
    const entries = parseServers(JSON.stringify({ servers: [{ name: 'b', url: 'https://x.test/b' }] }))
    assert.deepEqual(
      entries.map((e) => e.name),
      ['b'],
    )
  })

  test('falls back to the repository url when there is no direct one', () => {
    const entries = parseServers(JSON.stringify([{ name: 'c', repository: { url: 'https://github.com/o/c' } }]))
    assert.equal(entries[0]?.url, 'https://github.com/o/c')
  })

  test('skips a record with no name or no url', () => {
    assert.deepEqual(parseServers(JSON.stringify([{ url: 'https://x.test/a' }, { name: 'b' }])), [])
  })

  test('non-JSON and unexpected shapes yield no entries rather than throwing', () => {
    assert.deepEqual(parseServers('not json'), [])
    assert.deepEqual(parseServers(JSON.stringify({ data: [] })), [])
  })
})

describe('fetchMcpServers', () => {
  test('returns nothing for no terms, without a request', async () => {
    let called = false
    const fetchImpl: FetchImpl = async () => {
      called = true
      return { status: 200, text: async () => '[]' }
    }
    const result = await fetchMcpServers([], { fetchImpl })
    assert.equal(called, false)
    assert.deepEqual(result.entries, [])
    assert.match(result.detail, /no mcp terms/)
  })

  test('reports an unreachable registry without throwing', async () => {
    // The old wording said "no servers matched", which claimed the registry had answered.
    // It had not been reached at all, and a report that says "answered" when nothing was
    // asked is a report that lies in the reassuring direction.
    const fetchImpl: FetchImpl = async () => {
      throw new Error('offline')
    }
    const result = await fetchMcpServers(['android'], { fetchImpl })
    assert.deepEqual(result.entries, [])
    assert.equal(result.answered, false)
    assert.match(result.detail, /could not be reached/)
  })

  test('a registry that answered and matched nothing says so, and says it answered', async () => {
    const fetchImpl: FetchImpl = async () => ({ status: 200, text: async () => JSON.stringify({ servers: [] }) })
    const result = await fetchMcpServers(['android'], { fetchImpl })
    assert.equal(result.answered, true)
    assert.match(result.detail, /no servers matched/)
  })

  test('queries the configured registry, not only the public one', async () => {
    // The next requirement here is an enterprise registry; asserting the base URL is what
    // makes that a one-line change rather than a rewrite.
    const urls: string[] = []
    const fetchImpl: FetchImpl = async (url) => {
      urls.push(url)
      return { status: 200, text: async () => '[]' }
    }
    await fetchMcpServers(['android'], { fetchImpl, registry: 'https://mcp.internal.test' })
    assert.ok(urls[0]?.startsWith('https://mcp.internal.test/'), `got ${urls[0] ?? ''}`)
  })

  test('the default registry is the public one', () => {
    assert.match(DEFAULT_MCP_REGISTRY, /^https:\/\/registry\.modelcontextprotocol\.io/)
  })
})
