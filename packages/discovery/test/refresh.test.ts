/**
 * The refresh path: fetch now, cache what came back, keep what did not.
 *
 * The rule this suite exists for is the one a refresh is most likely to break. A cache is
 * the last good answer, and a refresh where no remote source answered -- because a registry
 * was briefly unreachable, or a rate limit arrived -- must not replace it with nothing. A
 * plan that lost its live guidance because a server was down would say, truthfully and
 * uselessly, that the ecosystem has published nothing.
 *
 * The other half is the opposite: a source that answered and matched nothing is an answer,
 * and caching that empty answer is what keeps a default `plan` from asking again on every
 * run.
 */

import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, describe, test } from 'node:test'
import {
  type DiscoverSeeds,
  type DiscoveryEntry,
  type FetchImpl,
  type GhRun,
  loadCache,
  refreshLive,
  saveCache,
} from '@anvil/discovery'

const ANDROID: DiscoverSeeds = {
  officialOrgs: ['android'],
  keywords: ['android cli'],
  mcp: ['android'],
}

const temps: string[] = []
after(() => {
  for (const t of temps) rmSync(t, { recursive: true, force: true })
})

function tempHome(): string {
  const dir = mkdtempSync(join(tmpdir(), 'anvil-refresh-'))
  temps.push(dir)
  return dir
}

function cachedEntry(label: string): DiscoveryEntry {
  return {
    label,
    url: `https://github.com/${label}`,
    why: 'Fetched by an earlier run.',
    tier: 'official',
    section: 'skills',
    source: 'github-search',
    fetchedAt: new Date().toISOString(),
    stars: 10,
    install: null,
    repo: label,
    owner: label.slice(0, label.indexOf('/')),
  }
}

describe('refreshLive', () => {
  const ghFail: GhRun = async () => ({ stdout: '', stderr: 'not installed', exitCode: 127 })
  const fetchFail: FetchImpl = async () => {
    throw new Error('offline')
  }

  test('a refresh writes the cache and returns the entries it found', async () => {
    const home = tempHome()
    const env = { ANVIL_CONFIG_HOME: home } as NodeJS.ProcessEnv
    const fetchImpl: FetchImpl = async () => ({
      status: 200,
      text: async () =>
        JSON.stringify({
          items: [
            {
              full_name: 'android/agent-skills',
              html_url: 'https://github.com/android/agent-skills',
              description: 'Official Android agent skills for agent workflows.',
              stargazers_count: 900,
              owner: { login: 'android', type: 'Organization' },
            },
          ],
        }),
    })

    const result = await refreshLive([{ id: 'android', discover: ANDROID }], {
      cwd: '.',
      env,
      fetchImpl,
      gh: ghFail,
    })

    assert.equal(result.live.get('android')?.length, 1)
    assert.equal(result.cached.length, 1)
    const read = loadCache('android', env)
    assert.equal(read.status, 'fresh')
    assert.equal(read.cache?.entries.length, 1)
  })

  test('a refresh that finds nothing keeps the cached entries', async () => {
    const home = tempHome()
    const env = { ANVIL_CONFIG_HOME: home } as NodeJS.ProcessEnv
    saveCache(
      {
        schemaVersion: 1,
        playbookId: 'android',
        fetchedAt: new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString(),
        entries: [cachedEntry('android/agent-skills')],
      },
      env,
    )

    const result = await refreshLive([{ id: 'android', discover: ANDROID }], {
      cwd: '.',
      env,
      fetchImpl: fetchFail,
      gh: ghFail,
    })

    assert.equal(result.live.get('android')?.length, 1, 'the cached entries must survive a failed refresh')
    assert.equal(result.cached.length, 0, 'a failed refresh writes nothing')
    assert.ok(result.warnings.some((w) => /found nothing; the cached entries were kept/.test(w)))
    assert.equal(loadCache('android', env).cache?.entries.length, 1)
  })

  test('an answered empty result is cached, so the next run does not ask again', async () => {
    // GitHub answers with a repository that is not agent tooling, and the MCP registry
    // answers with nothing. Both answered, both matched nothing, and the empty answer is
    // exactly what stops a default `plan` from spending the request again on every run.
    const home = tempHome()
    const env = { ANVIL_CONFIG_HOME: home } as NodeJS.ProcessEnv
    const fetchImpl: FetchImpl = async (url) => ({
      status: 200,
      text: async () =>
        url.includes('/v0/servers')
          ? JSON.stringify({ servers: [] })
          : JSON.stringify({
              items: [
                {
                  full_name: 'someone/plain',
                  html_url: 'https://github.com/someone/plain',
                  description: 'A library',
                  stargazers_count: 5,
                  owner: { login: 'someone', type: 'User' },
                },
              ],
            }),
    })

    const result = await refreshLive([{ id: 'android', discover: ANDROID }], {
      cwd: '.',
      env,
      fetchImpl,
      gh: ghFail,
    })

    assert.equal(result.cached.length, 1, 'an answered empty result is still an answer')
    assert.equal(result.live.get('android')?.length, 0)
    const read = loadCache('android', env)
    assert.equal(read.status, 'fresh')
    assert.equal(read.cache?.entries.length, 0, 'the empty answer is remembered')
  })

  test('a failed refresh does not cache a local-only result', async () => {
    // The failure that would poison the default: a teammate's installed skill is the only
    // entry a failed fetch has, and writing it as a fresh cache would make the next seven
    // days look answered when the network was never reached.
    const home = tempHome()
    const env = { ANVIL_CONFIG_HOME: home } as NodeJS.ProcessEnv
    const skillDir = join(home, '.agents', 'skills', 'zz-anvil-refresh-skill')
    mkdirSync(skillDir, { recursive: true })
    writeFileSync(
      join(skillDir, 'SKILL.md'),
      '---\nname: zz-anvil-refresh-skill\ndescription: A fixture.\n---\n\nBody.\n',
    )

    const result = await refreshLive([{ id: 'android', discover: ANDROID }], {
      cwd: '.',
      env,
      fetchImpl: fetchFail,
      gh: ghFail,
    })

    assert.equal(result.cached.length, 0, 'a failed fetch must not be cached as a fresh answer')
    assert.equal(loadCache('android', env).status, 'absent')
  })

  test('a partial fetch is marked incomplete, so the next run retries it', async () => {
    // GitHub fails while the MCP registry answers nothing. The cache must not present that as
    // a complete answer: a source that was asked and did not answer is a gap, and the marker
    // is what makes a default `plan` fetch again rather than trust a half-answer.
    const home = tempHome()
    const env = { ANVIL_CONFIG_HOME: home } as NodeJS.ProcessEnv
    const fetchImpl: FetchImpl = async (url) => {
      if (url.includes('/v0/servers')) return { status: 200, text: async () => JSON.stringify({ servers: [] }) }
      throw new Error('offline')
    }

    const result = await refreshLive([{ id: 'android', discover: ANDROID }], {
      cwd: '.',
      env,
      fetchImpl,
      gh: ghFail,
    })

    assert.equal(result.cached.length, 1, 'the source that did answer is still cached')
    assert.equal(loadCache('android', env).cache?.remoteAnswered, false)
    assert.equal(result.live.get('android')?.length, 0)
  })

  test('a source that answered only some of its queries is incomplete', async () => {
    // The partial-fetch case above fails a whole source. This one succeeds on the first
    // query and fails the second, which still leaves the cache missing a half that the next
    // run must ask for.
    const home = tempHome()
    const env = { ANVIL_CONFIG_HOME: home } as NodeJS.ProcessEnv
    const seeds: DiscoverSeeds = { officialOrgs: [], keywords: ['first query', 'second query'], mcp: [] }
    const gh: GhRun = async (args) => {
      const query = args.find((arg) => arg.startsWith('q=')) ?? ''
      return query.includes('first')
        ? {
            stdout: JSON.stringify({
              items: [
                {
                  full_name: 'android/agent-skills',
                  html_url: 'https://github.com/android/agent-skills',
                  description: 'Official Android agent skills.',
                  stargazers_count: 9,
                  owner: { login: 'android', type: 'Organization' },
                },
              ],
            }),
            stderr: '',
            exitCode: 0,
          }
        : { stdout: '', stderr: 'rate limited', exitCode: 1 }
    }
    const fetchImpl: FetchImpl = async () => {
      throw new Error('offline')
    }

    const result = await refreshLive([{ id: 'partial', discover: seeds }], { cwd: '.', env, fetchImpl, gh })

    assert.equal(result.cached.length, 1)
    assert.equal(loadCache('partial', env).cache?.remoteAnswered, false)
    assert.ok(
      result.warnings.some((w) => /GitHub answered 1 of 2 queries/.test(w)),
      result.warnings.join('; '),
    )
  })

  test('an invalid registry response keeps the cached MCP entries and marks the cache partial', async () => {
    // An HTTP 200 from a proxy login page or an error object used to count as "the registry
    // answered and found nothing": the old entries were erased and the cache marked complete.
    // It is a failed query, so the entries survive and the next run asks again.
    const home = tempHome()
    const env = { ANVIL_CONFIG_HOME: home } as NodeJS.ProcessEnv
    const old = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString()
    saveCache(
      {
        schemaVersion: 1,
        playbookId: 'android',
        fetchedAt: old,
        entries: [
          {
            ...cachedEntry('android/mcp-server'),
            url: 'https://mcp.test/server',
            source: 'mcp-registry',
            section: 'mcp',
            repo: null,
            owner: null,
            fetchedAt: old,
          },
        ],
        remoteAnswered: true,
      },
      env,
    )
    const fetchImpl: FetchImpl = async (url) => {
      if (url.includes('/v0/servers')) return { status: 200, text: async () => '<html>Proxy login</html>' }
      return {
        status: 200,
        text: async () =>
          JSON.stringify({
            items: [
              {
                full_name: 'android/agent-skills',
                html_url: 'https://github.com/android/agent-skills',
                description: 'Official Android agent skills.',
                stargazers_count: 9,
                owner: { login: 'android', type: 'Organization' },
              },
            ],
          }),
      }
    }

    const result = await refreshLive([{ id: 'android', discover: ANDROID }], { cwd: '.', env, fetchImpl, gh: ghFail })

    const read = loadCache('android', env)
    assert.equal(read.cache?.remoteAnswered, false)
    assert.ok(
      read.cache?.entries.some((entry) => entry.source === 'mcp-registry'),
      'the cached MCP entry must not be erased by a body that is not a registry response',
    )
    assert.ok(
      result.warnings.some((w) => /MCP registry could not be reached/.test(w)),
      result.warnings.join('; '),
    )
  })

  test('a mixed registry list keeps cached MCP entries and marks the cache partial', async () => {
    // A body with one real server beside records that are not servers is not a finished
    // answer. The real server is added, the cache is marked partial so the next plan asks
    // again, and neither the old MCP entries nor a warning is lost.
    const home = tempHome()
    const env = { ANVIL_CONFIG_HOME: home } as NodeJS.ProcessEnv
    const old = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString()
    saveCache(
      {
        schemaVersion: 1,
        playbookId: 'android',
        fetchedAt: old,
        entries: [
          {
            ...cachedEntry('android/mcp-server'),
            url: 'https://mcp.test/server',
            source: 'mcp-registry',
            section: 'mcp',
            repo: null,
            owner: null,
            fetchedAt: old,
          },
        ],
        remoteAnswered: true,
      },
      env,
    )
    const fetchImpl: FetchImpl = async (url) => {
      if (url.includes('/v0/servers')) {
        return {
          status: 200,
          text: async () =>
            JSON.stringify({
              servers: [
                { server: { name: 'new-mcp', websiteUrl: 'https://new.test/mcp' } },
                { server: { id: 'renamed', websiteUrl: 'https://renamed.test/mcp' } },
              ],
            }),
        }
      }
      return {
        status: 200,
        text: async () =>
          JSON.stringify({
            items: [
              {
                full_name: 'android/agent-skills',
                html_url: 'https://github.com/android/agent-skills',
                description: 'Official Android agent skills.',
                stargazers_count: 9,
                owner: { login: 'android', type: 'Organization' },
              },
            ],
          }),
      }
    }

    const result = await refreshLive([{ id: 'android', discover: ANDROID }], { cwd: '.', env, fetchImpl, gh: ghFail })

    const read = loadCache('android', env)
    assert.equal(read.cache?.remoteAnswered, false)
    const labels = read.cache?.entries.map((entry) => entry.label) ?? []
    assert.ok(labels.includes('android/mcp-server'), 'the cached MCP entry must survive a mixed body')
    assert.ok(labels.includes('new-mcp'), 'the real server in the mixed body is still used')
    assert.ok(
      result.warnings.some((w) => /MCP registry answered only part of its queries/.test(w)),
      result.warnings.join('; '),
    )
  })

  test('a fully answered run is marked complete', async () => {
    const home = tempHome()
    const env = { ANVIL_CONFIG_HOME: home } as NodeJS.ProcessEnv
    const fetchImpl: FetchImpl = async (url) => ({
      status: 200,
      text: async () =>
        url.includes('/v0/servers')
          ? JSON.stringify({ servers: [] })
          : JSON.stringify({
              items: [
                {
                  full_name: 'android/agent-skills',
                  html_url: 'https://github.com/android/agent-skills',
                  description: 'Official Android agent skills.',
                  stargazers_count: 9,
                  owner: { login: 'android', type: 'Organization' },
                },
              ],
            }),
    })

    await refreshLive([{ id: 'android', discover: ANDROID }], { cwd: '.', env, fetchImpl, gh: ghFail })

    assert.equal(loadCache('android', env).cache?.remoteAnswered, true)
  })

  test('an unwritable cache keeps the fetched entries and warns', async () => {
    // A read-only home, or a full disk, must cost the next run a repeat fetch -- not this run
    // the guidance it already has.
    const home = tempHome()
    const env = { ANVIL_CONFIG_HOME: home } as NodeJS.ProcessEnv
    // A regular file where the cache directory belongs, so mkdirSync under it fails.
    writeFileSync(join(home, '.anvil'), 'not a directory', 'utf8')
    const fetchImpl: FetchImpl = async (url) => ({
      status: 200,
      text: async () =>
        url.includes('/v0/servers')
          ? JSON.stringify({ servers: [] })
          : JSON.stringify({
              items: [
                {
                  full_name: 'android/agent-skills',
                  html_url: 'https://github.com/android/agent-skills',
                  description: 'Official Android agent skills.',
                  stargazers_count: 9,
                  owner: { login: 'android', type: 'Organization' },
                },
              ],
            }),
    })

    const result = await refreshLive([{ id: 'android', discover: ANDROID }], { cwd: '.', env, fetchImpl, gh: ghFail })

    assert.equal(result.live.get('android')?.length, 1, 'the fetched entry is still returned')
    assert.equal(result.cached.length, 0)
    assert.ok(
      result.warnings.some((w) => /could not write the discovery cache/.test(w)),
      result.warnings.join('; '),
    )
  })

  test('a playbook with no seeds is not fetched', async () => {
    const home = tempHome()
    let touched = false
    const fetchImpl: FetchImpl = async () => {
      touched = true
      throw new Error('should not be called')
    }
    const result = await refreshLive([{ id: 'empty', discover: { officialOrgs: [], keywords: [], mcp: [] } }], {
      cwd: '.',
      env: { ANVIL_CONFIG_HOME: home } as NodeJS.ProcessEnv,
      fetchImpl,
      gh: ghFail,
    })
    assert.equal(touched, false)
    assert.equal(result.live.size, 0)
  })
})
