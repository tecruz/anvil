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

  test('a missing gh falls back to the API instead of aborting the run', async () => {
    // `runProcess` throws ToolMissing when the binary is absent. The probe has to read that as
    // "gh is unavailable" and use the REST fallback, or a machine without gh -- the locked-down
    // machine the README supports -- cannot run discovery or a default `plan` at all.
    const originalPath = process.env.PATH
    process.env.PATH = ''
    try {
      const result = await searchGitHub('org:android', { cwd: '.', fetchImpl: fetchOk(REPOS) })
      assert.equal(result?.via, 'api', 'the REST fallback must answer when gh is absent')
    } finally {
      if (originalPath === undefined) delete process.env.PATH
      else process.env.PATH = originalPath
    }
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

  test('a tooling keyword buried in a huge description does not admit the repository', async () => {
    // A search result's description can be a catch-all blurb of tens of thousands of
    // characters. One incidental `agent` deep inside it used to admit an unrelated repository.
    const huge = {
      items: [{ full_name: 'someone/notes', description: `${'topic, '.repeat(6000)} agent`, stargazers_count: 5 }],
    }
    const result = await discover('android', ANDROID, { cwd: '.', gh: ghOk(huge), fetchImpl: fetchOk({}) })
    assert.deepEqual(result.entries, [])
  })

  test('a long but relevant description is bounded in the stored evidence', async () => {
    // Even an admitted repository must not carry tens of thousands of characters into a plan.
    const long = 'agent tools, '.repeat(400)
    const items = {
      items: [
        {
          full_name: 'android/agent-skills',
          description: long,
          stargazers_count: 5,
          owner: { login: 'android', type: 'Organization' },
        },
      ],
    }
    const result = await discover('android', ANDROID, { cwd: '.', gh: ghOk(items), fetchImpl: fetchOk({}) })
    const entry = result.entries.find((e) => e.repo === 'android/agent-skills')
    assert.ok(entry !== undefined)
    assert.ok(entry.why.length < 1200, `evidence ran to ${String(entry.why.length)} characters`)
    assert.ok(entry.why.includes('…'), 'the truncation is visible rather than silent')
  })

  test('two queries returning one repository produce one entry', async () => {
    const result = await discover('android', ANDROID, { cwd: '.', gh: ghOk(REPOS), fetchImpl: fetchOk({}) })
    const repos = result.entries.filter((e) => e.repo === 'android/skills')
    assert.equal(repos.length, 1, 'an org-scoped and a keyword query overlap by construction')
  })

  test('a partially answered search is incomplete and says so', async () => {
    // Two keyword queries, one succeeds and one is unavailable. The source did answer, so
    // its results are real, but it did not have its whole say. A cache written from this run
    // must be marked partial or the failed query is not retried for a week.
    const seeds: DiscoverSeeds = { officialOrgs: [], keywords: ['first query', 'second query'], mcp: [] }
    const gh: GhRun = async (args) => {
      const query = args.find((arg) => arg.startsWith('q=')) ?? ''
      return query.includes('first')
        ? { stdout: JSON.stringify(REPOS), stderr: '', exitCode: 0 }
        : { stdout: '', stderr: 'rate limited', exitCode: 1 }
    }
    const result = await discover('partial', seeds, {
      cwd: '.',
      gh,
      fetchImpl: async () => {
        throw new Error('offline')
      },
    })
    const note = result.sources.find((s) => s.source === 'github-search')
    assert.equal(note?.answered, true, 'the successful query is a real answer')
    assert.equal(note?.complete, false, 'the source did not answer every query')
    assert.match(note?.detail ?? '', /1 of 2 queries failed/)
    assert.ok(
      result.warnings.some((w) => /GitHub answered 1 of 2 queries/.test(w)),
      result.warnings.join('; '),
    )
  })

  test('an incomplete search result is not cached as a complete answer', async () => {
    // GitHub sets `incomplete_results: true` when its own search timed out. The items are
    // real, so they are kept, but the source has not finished answering -- writing this into
    // the cache as complete froze a truncated list for the whole TTL.
    const seeds: DiscoverSeeds = { officialOrgs: [], keywords: ['only query'], mcp: [] }
    const body = { incomplete_results: true, items: REPOS.items }
    const result = await discover('incomplete', seeds, { cwd: '.', gh: ghOk(body), fetchImpl: fetchOk({}) })
    const note = result.sources.find((s) => s.source === 'github-search')
    assert.equal(note?.answered, true, 'the partial list is still a real answer')
    assert.equal(note?.complete, false, 'GitHub did not finish searching')
    assert.match(note?.detail ?? '', /incomplete/)
    assert.equal(result.entries.length, 2, 'the results that were returned are kept')
    assert.ok(
      result.warnings.some((w) => /incomplete results/.test(w)),
      result.warnings.join('; '),
    )
  })

  test('a gh that never answers is bounded and falls back to the API', async () => {
    // The preferred transport is a subprocess, so the HTTP timeout never covered it. A hung
    // gh made automatic enrichment wait forever; it must fall through like any other decline.
    const hung: GhRun = () => new Promise(() => {})
    const result = await searchGitHub('org:android', {
      cwd: '.',
      gh: hung,
      fetchImpl: fetchOk(REPOS),
      timeoutMs: 25,
    })
    assert.equal(result?.via, 'api', 'a timeout is "gh declined", not a hang')
  })

  test('discovery does not hang when gh hangs and the API is unreachable', async () => {
    const hung: GhRun = () => new Promise(() => {})
    const started = Date.now()
    const result = await discover('android', ANDROID, {
      cwd: '.',
      gh: hung,
      fetchImpl: async () => {
        throw new Error('offline')
      },
      timeoutMs: 25,
    })
    assert.ok(Date.now() - started < 5_000, 'the run must be bounded by the timeout')
    assert.ok(result.warnings.some((w) => /no transport could reach GitHub/.test(w)))
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

  test('reads the nested server record the v0 API returns', () => {
    // The live registry nests the record under `server`; reading the top level found nothing
    // and reported "no servers matched" for a response that clearly had servers in it.
    const body = JSON.stringify({
      servers: [
        {
          server: {
            name: 'ai.x/thing',
            description: 'A thing',
            repository: { url: 'https://github.com/o/thing', source: 'github' },
            remotes: [{ type: 'streamable-http', url: 'https://thing.test/mcp' }],
          },
          _meta: { 'io.modelcontextprotocol.registry/official': {} },
        },
      ],
    })
    assert.deepEqual(parseServers(body), [
      { name: 'ai.x/thing', url: 'https://github.com/o/thing', description: 'A thing' },
    ])
  })

  test('prefers the repository over the connection endpoint, then the website', () => {
    const withRepo = JSON.stringify({
      servers: [
        {
          server: {
            name: 's',
            repository: { url: 'https://github.com/o/s' },
            websiteUrl: 'https://s.test',
            remotes: [{ url: 'https://s.test/mcp' }],
          },
        },
      ],
    })
    assert.equal(parseServers(withRepo)[0]?.url, 'https://github.com/o/s')

    const noRepo = JSON.stringify({
      servers: [{ server: { name: 's', websiteUrl: 'https://s.test', remotes: [{ url: 'https://s.test/mcp' }] } }],
    })
    assert.equal(parseServers(noRepo)[0]?.url, 'https://s.test')
  })

  test('reads a remote endpoint when a nested record has no repository or website', () => {
    const body = JSON.stringify({
      servers: [{ server: { name: 's', remotes: [{ type: 'streamable-http', url: 'https://s.test/mcp' }] } }],
    })
    assert.deepEqual(parseServers(body), [{ name: 's', url: 'https://s.test/mcp', description: null }])
  })

  test('skips a nested record with an empty repository and no other url', () => {
    const body = JSON.stringify({ servers: [{ server: { name: 's', repository: {} } }] })
    assert.deepEqual(parseServers(body), [])
  })

  test('does not select a plain-http url the cache would reject', () => {
    // An http URL passes through discovery but is dropped by the cache's own check, so the
    // server would appear in one plan and vanish from the next. The https endpoint wins.
    const body = JSON.stringify({
      servers: [{ server: { name: 's', websiteUrl: 'http://s.test', remotes: [{ url: 'https://s.test/mcp' }] } }],
    })
    assert.equal(parseServers(body)[0]?.url, 'https://s.test/mcp')
  })

  test('skips a server whose only url is not https', () => {
    const body = JSON.stringify({ servers: [{ server: { name: 's', websiteUrl: 'http://s.test' } }] })
    assert.deepEqual(parseServers(body), [])
  })

  test('keeps the latest version when a server is listed once per version', () => {
    const meta = (isLatest: boolean) => ({ 'io.modelcontextprotocol.registry/official': { isLatest } })
    const body = JSON.stringify({
      servers: [
        {
          server: { name: 's', description: 'old', repository: { url: 'https://github.com/o/s' } },
          _meta: meta(false),
        },
        {
          server: { name: 's', description: 'new', repository: { url: 'https://github.com/o/s' } },
          _meta: meta(true),
        },
      ],
    })
    const entries = parseServers(body)
    assert.equal(entries.length, 1, 'the same server must not appear once per version')
    assert.equal(entries[0]?.description, 'new')
  })

  test('does not fall back to an older version when the latest has no usable url', () => {
    // Picking the URL before the version let an older https record survive as if it were
    // current. The version is chosen first; if its URL cannot be used, the server is dropped.
    const meta = (isLatest: boolean) => ({ 'io.modelcontextprotocol.registry/official': { isLatest } })
    const body = JSON.stringify({
      servers: [
        { server: { name: 's', repository: { url: 'https://old.test' } }, _meta: meta(false) },
        { server: { name: 's', websiteUrl: 'http://new.test' }, _meta: meta(true) },
      ],
    })
    assert.deepEqual(parseServers(body), [])
  })

  test('a hostless https string is not a url, so a usable remote is used instead', () => {
    const body = JSON.stringify({
      servers: [{ server: { name: 's', websiteUrl: 'https://', remotes: [{ url: 'https://valid.test/mcp' }] } }],
    })
    assert.equal(parseServers(body)[0]?.url, 'https://valid.test/mcp')
  })

  test('skips a server whose only url is hostless', () => {
    const body = JSON.stringify({ servers: [{ server: { name: 's', websiteUrl: 'https://' } }] })
    assert.deepEqual(parseServers(body), [])
  })

  test('a url-less legacy duplicate does not hide a usable sibling', () => {
    // Two unmarked records for one name: the first has no URL, the second does. Neither is a
    // stated version, so the usable one is the only reasonable answer.
    const body = JSON.stringify([{ name: 'legacy' }, { name: 'legacy', url: 'https://valid.test/mcp' }])
    assert.equal(parseServers(body)[0]?.url, 'https://valid.test/mcp')
  })

  test('a stated historical record is not offered as current', () => {
    const meta = (isLatest: boolean) => ({ 'io.modelcontextprotocol.registry/official': { isLatest } })
    const body = JSON.stringify({
      servers: [{ server: { name: 's', repository: { url: 'https://old.test' } }, _meta: meta(false) }],
    })
    assert.deepEqual(parseServers(body), [])
  })

  test('a latest record beats an unmarked one', () => {
    const meta = (isLatest: boolean) => ({ 'io.modelcontextprotocol.registry/official': { isLatest } })
    const body = JSON.stringify({
      servers: [
        { server: { name: 's', repository: { url: 'https://unmarked.test' } } },
        { server: { name: 's', repository: { url: 'https://latest.test' } }, _meta: meta(true) },
      ],
    })
    assert.equal(parseServers(body)[0]?.url, 'https://latest.test')
  })

  test('a response with a very large remotes array does not overflow the stack', () => {
    // Spreading the remotes into an argument list threw RangeError at a few hundred thousand
    // entries, below the transport's own response-size cap.
    const body = JSON.stringify({
      servers: [
        {
          server: {
            name: 's',
            remotes: Array.from({ length: 200_000 }, (_, i) => (i === 0 ? { url: 'https://s.test/mcp' } : {})),
          },
        },
      ],
    })
    assert.equal(parseServers(body)[0]?.url, 'https://s.test/mcp')
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

  test('a term below the registry minimum is not requested, and is not an answer', async () => {
    // The registry rejects a shorter `search` with HTTP 422, so asking it is a query that can
    // never complete. It is not asked at all -- but a run that asked nothing is not an
    // answered empty registry either, or a merge would erase the cached servers.
    let called = 0
    const fetchImpl: FetchImpl = async () => {
      called++
      return { status: 200, text: async () => JSON.stringify({ servers: [] }) }
    }
    const result = await fetchMcpServers(['ci'], { fetchImpl })
    assert.equal(called, 0)
    assert.equal(result.answered, false)
    assert.equal(result.complete, false)
    assert.equal(result.skipped, true)
    assert.deepEqual(result.entries, [])
    assert.match(result.detail, /nothing was asked/)
  })

  test('no terms at all is complete, because there was nothing to ask', async () => {
    const fetchImpl: FetchImpl = async () => {
      throw new Error('no request should be made')
    }
    const result = await fetchMcpServers([], { fetchImpl })
    assert.equal(result.answered, true)
    assert.equal(result.complete, true)
    assert.equal(result.skipped, false)
  })

  test('a below-minimum term does not spoil the answer for the others', async () => {
    const urls: string[] = []
    const fetchImpl: FetchImpl = async (url) => {
      urls.push(url)
      return { status: 200, text: async () => JSON.stringify({ servers: [] }) }
    }
    const result = await fetchMcpServers(['github-actions', 'ci'], { fetchImpl })
    assert.equal(urls.length, 1, 'only the searchable term is asked')
    assert.match(urls[0] ?? '', /search=github-actions/)
    assert.equal(result.answered, true)
    assert.equal(result.complete, true)
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
    assert.equal(result.complete, true)
    assert.match(result.detail, /no servers matched/)
  })

  test('an HTTP 200 that is not a registry response is not an answer', async () => {
    // A proxy login page or an error object from an intermediary used to parse to an empty
    // list, erase the cached MCP entries, and mark the cache complete. It is a failed query.
    for (const body of ['<html>Proxy login</html>', JSON.stringify({ error: 'service unavailable' })]) {
      const result = await fetchMcpServers(['android'], { fetchImpl: fetchOk(body) })
      assert.equal(result.answered, false, body)
      assert.equal(result.complete, false, body)
      assert.match(result.detail, /not with a registry response/, body)
    }
  })

  test('a list of records that are not servers is not an answered registry', async () => {
    // An error record, a list of JSON primitives, and a payload whose `name` field moved all
    // parsed to an empty list. That read as "the registry answered and matched nothing":
    // the cached MCP entries were replaced with nothing, no warning was shown, and the next
    // plan made no request. None of these is a registry response.
    const bodies = [
      JSON.stringify([{ error: 'service unavailable' }]),
      JSON.stringify({ servers: [null, 42, 'unavailable'] }),
      JSON.stringify({ servers: [{ server: { id: 'changed-name-field' } }] }),
    ]
    for (const body of bodies) {
      const result = await fetchMcpServers(['android'], { fetchImpl: fetchOk(body) })
      assert.equal(result.answered, false, body)
      assert.equal(result.complete, false, body)
      assert.match(result.detail, /not with a registry response/, body)
    }
  })

  test('a list of real servers filtered out is still an answer', async () => {
    // The other half of the rule: records that carry a name but are historical or have no
    // usable https URL are servers the registry answered with, just not ones worth showing.
    // Treating those as malformed would refetch a correct empty answer on every run.
    const body = JSON.stringify({
      servers: [{ server: { name: 's', websiteUrl: 'http://s.test' } }],
    })
    const result = await fetchMcpServers(['android'], { fetchImpl: fetchOk(body) })
    assert.equal(result.answered, true)
    assert.equal(result.complete, true)
    assert.deepEqual(result.entries, [])
    assert.match(result.detail, /no servers matched/)
  })

  test('a list mixing real servers with junk is partial, not a complete answer', async () => {
    // One recognizable sibling used to let the junk through: the query was counted as
    // answered and complete, so the cached MCP entries were erased and no warning was shown.
    // The good records are still kept, but the query is unfinished and the next run asks.
    const body = JSON.stringify({
      servers: [
        { server: { name: 'real', websiteUrl: 'https://real.test/mcp' } },
        { server: { id: 'renamed', websiteUrl: 'https://renamed.test/mcp' } },
        null,
      ],
    })
    const result = await fetchMcpServers(['android'], { fetchImpl: fetchOk(body) })
    assert.equal(result.answered, true)
    assert.equal(result.complete, false)
    assert.deepEqual(result.entries, [{ name: 'real', url: 'https://real.test/mcp', description: null }])
    assert.match(result.detail, /malformed records/)
  })

  test('a partially answered registry is incomplete and reports the failed queries', async () => {
    const fetchImpl: FetchImpl = async (url) =>
      url.includes('search=first')
        ? { status: 200, text: async () => JSON.stringify({ servers: [] }) }
        : { status: 503, text: async () => '' }
    const result = await fetchMcpServers(['first', 'second'], { fetchImpl })
    assert.equal(result.answered, true)
    assert.equal(result.complete, false)
    assert.match(result.detail, /1 of 2 query\(s\) did not answer/)
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

  test('asks for the latest version, not every published one', async () => {
    const urls: string[] = []
    const fetchImpl: FetchImpl = async (url) => {
      urls.push(url)
      return { status: 200, text: async () => '[]' }
    }
    await fetchMcpServers(['python'], { fetchImpl })
    assert.match(urls[0] ?? '', /[?&]version=latest(&|$)/, `got ${urls[0] ?? ''}`)
  })

  test('the default registry is the public one', () => {
    assert.match(DEFAULT_MCP_REGISTRY, /^https:\/\/registry\.modelcontextprotocol\.io/)
  })
})
