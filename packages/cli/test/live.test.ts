/**
 * How `plan` and `brief` decide where their live guidance comes from.
 *
 * Three answers, and the flags choose: none (`--offline`), fetched now (`--refresh`), or
 * the cache (the default). The network answer is the expensive one, so the decision is
 * worth a test of its own rather than being inferred from a report that happens to contain
 * the right entries.
 *
 * The refresh is injected here, so the suite never touches the network: a test that fetched
 * for real would be a test whose result depends on somebody's rate limit.
 */

import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { describe, test } from 'node:test'
import { type CacheFile, cachePathFor, type DiscoveryEntry, saveCache } from '@anvil/discovery'
import { liveEntriesForPlan, loadLiveForPlan } from '../src/commands/discover.ts'

const ANDROID = { id: 'android', discover: { officialOrgs: ['android'], keywords: [], mcp: [] } }
const NODE = { id: 'node', discover: { officialOrgs: ['nodejs'], keywords: [], mcp: [] } }

function entry(label: string): DiscoveryEntry {
  return {
    label,
    url: `https://github.com/android/${label}`,
    why: 'Fetched now.',
    tier: 'official',
    section: 'skills',
    source: 'github-search',
    fetchedAt: new Date().toISOString(),
    stars: 10,
    install: null,
    repo: `android/${label}`,
    owner: 'android',
  }
}

function home(): string {
  return mkdtempSync(join(tmpdir(), 'anvil-live-'))
}

function env(h: string): NodeJS.ProcessEnv {
  return { ANVIL_CONFIG_HOME: h } as NodeJS.ProcessEnv
}

/** Install a skill under the temp home, the way `~/.agents/skills` holds them. */
function writeSkill(h: string, name: string, description: string): void {
  const dir = join(h, '.agents', 'skills', name)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'SKILL.md'), `---\nname: ${name}\ndescription: ${description}\n---\n\nBody.\n`, 'utf8')
}

function cache(fetchedAt: string): CacheFile {
  return {
    schemaVersion: 1,
    playbookId: 'android',
    fetchedAt,
    entries: [{ ...entry('agent-skills'), fetchedAt }],
  }
}

describe('loadLiveForPlan', () => {
  test('a fresh cache is merged, with no warning', () => {
    const h = home()
    try {
      saveCache(cache(new Date().toISOString()), env(h))
      const result = loadLiveForPlan([ANDROID], env(h))
      assert.equal(result.live.get('android')?.length, 1)
      assert.deepEqual(result.warnings, [])
    } finally {
      rmSync(h, { recursive: true, force: true })
    }
  })

  test('a stale cache is reported and left out, not merged with a warning', () => {
    const h = home()
    try {
      const old = new Date(Date.now() - 12 * 24 * 60 * 60 * 1000).toISOString()
      saveCache(cache(old), env(h))
      const result = loadLiveForPlan([ANDROID], env(h))
      // The entries still exist in the cache -- `discover` can show them -- but a plan
      // that presented a twelve-day-old search result as live guidance would be worse
      // than a plan with no live guidance at all.
      assert.equal(result.live.has('android'), false)
      assert.equal(result.warnings.length, 1)
      assert.match(result.warnings[0]!, /stale/)
      assert.match(result.warnings[0]!, /ignored/)
      assert.match(result.warnings[0]!, /--refresh/)
    } finally {
      rmSync(h, { recursive: true, force: true })
    }
  })

  test('a stale cache does not hide an installed skill', () => {
    const h = home()
    try {
      writeSkill(h, 'testing-setup', 'Android test strategy, unit tests and coverage.')
      const old = new Date(Date.now() - 12 * 24 * 60 * 60 * 1000).toISOString()
      saveCache(cache(old), env(h))

      const result = loadLiveForPlan([ANDROID], env(h))
      const entries = result.live.get('android') ?? []

      // The remote half is stale and dropped; the local half is a file read and stays.
      assert.equal(entries.length, 1)
      assert.equal(entries[0]?.source, 'local-scan')
      assert.equal(entries[0]?.trust, 'local-install')
      assert.equal(result.warnings.length, 1)
    } finally {
      rmSync(h, { recursive: true, force: true })
    }
  })

  test('an uninstalled skill is not resurrected from the cache', () => {
    const h = home()
    try {
      const cachedLocal: DiscoveryEntry = {
        label: 'testing-setup',
        url: '',
        why: 'Installed on this machine at /gone/SKILL.md.',
        tier: 'official',
        trust: 'local-install',
        section: 'skills',
        source: 'local-scan',
        fetchedAt: new Date().toISOString(),
        stars: null,
        install: '/gone/SKILL.md',
        repo: null,
        owner: null,
      }
      saveCache(
        { schemaVersion: 1, playbookId: 'android', fetchedAt: new Date().toISOString(), entries: [cachedLocal] },
        env(h),
      )

      const result = loadLiveForPlan([ANDROID], env(h))

      // The skill is gone from disk. A plan that kept the cached copy would point an agent
      // at a file that does not exist.
      assert.equal(result.live.has('android'), false)
    } finally {
      rmSync(h, { recursive: true, force: true })
    }
  })
})

describe('liveEntriesForPlan', () => {
  test('--offline lists installed skills and fetches nothing', async () => {
    const h = home()
    try {
      writeSkill(h, 'testing-setup', 'Android test strategy, unit tests and coverage.')
      let fetched = false
      const result = await liveEntriesForPlan([ANDROID], {
        offline: true,
        refresh: false,
        cwd: '.',
        env: env(h),
        refreshLive: async () => {
          fetched = true
          return { live: new Map(), warnings: [], cached: [] }
        },
      })
      assert.equal(fetched, false)
      assert.equal(result.live.get('android')?.length, 1)
      assert.equal(result.live.get('android')?.[0]?.source, 'local-scan')
      assert.equal(result.live.get('android')?.[0]?.trust, 'local-install')
    } finally {
      rmSync(h, { recursive: true, force: true })
    }
  })

  test('--refresh fetches for the playbooks that matched', async () => {
    const h = home()
    try {
      const asked: string[][] = []
      const result = await liveEntriesForPlan([ANDROID], {
        offline: false,
        refresh: true,
        cwd: '.',
        env: env(h),
        refreshLive: async (playbooks) => {
          asked.push(playbooks.map((p) => p.id))
          const live = new Map<string, DiscoveryEntry[]>()
          live.set('android', [entry('agent-skills')])
          return { live, warnings: ['a warning worth carrying'], cached: ['/tmp/android.json'] }
        },
      })
      assert.deepEqual(asked, [['android']])
      assert.equal(result.live.get('android')?.length, 1)
      assert.deepEqual(result.warnings, ['a warning worth carrying'])
    } finally {
      rmSync(h, { recursive: true, force: true })
    }
  })

  test('a fresh cache is read and nothing is fetched', async () => {
    const h = home()
    try {
      writeSkill(h, 'testing-setup', 'Android test strategy and coverage.')
      saveCache(cache(new Date().toISOString()), env(h))
      let fetched = false
      const result = await liveEntriesForPlan([ANDROID], {
        offline: false,
        refresh: false,
        cwd: '.',
        env: env(h),
        refreshLive: async () => {
          fetched = true
          return { live: new Map(), warnings: [], cached: [] }
        },
      })
      assert.equal(fetched, false)
      // The installed skill and the cached remote entry, in that order.
      const ids = result.live.get('android')?.map((e) => e.source) ?? []
      assert.deepEqual(ids, ['local-scan', 'github-search'])
    } finally {
      rmSync(h, { recursive: true, force: true })
    }
  })

  test('a refresh that could not answer for a playbook does not hide its installed skill', async () => {
    const h = home()
    try {
      writeSkill(h, 'testing-setup', 'Android test strategy and coverage.')
      const result = await liveEntriesForPlan([ANDROID], {
        offline: false,
        refresh: true,
        cwd: '.',
        env: env(h),
        refreshLive: async () => ({ live: new Map(), warnings: [], cached: [] }),
      })
      assert.equal(result.live.get('android')?.length, 1)
      assert.equal(result.live.get('android')?.[0]?.source, 'local-scan')
    } finally {
      rmSync(h, { recursive: true, force: true })
    }
  })

  test('a missing cache is fetched by default and merged with installed skills', async () => {
    // The enrichment this default exists for: a machine that has never run discovery still
    // gets live guidance, without the user having to know `--refresh` exists.
    const h = home()
    try {
      writeSkill(h, 'testing-setup', 'Android test strategy and coverage.')
      const asked: string[][] = []
      const result = await liveEntriesForPlan([ANDROID], {
        offline: false,
        refresh: false,
        cwd: '.',
        env: env(h),
        refreshLive: async (playbooks) => {
          asked.push(playbooks.map((p) => p.id))
          const live = new Map<string, DiscoveryEntry[]>()
          live.set('android', [entry('agent-skills')])
          return { live, warnings: [], cached: [] }
        },
      })
      assert.deepEqual(asked, [['android']], 'an absent cache is the case enrichment exists for')
      const sources = result.live.get('android')?.map((e) => e.source) ?? []
      assert.ok(sources.includes('local-scan'), 'the installed skill survives the fetch')
      assert.ok(sources.includes('github-search'), 'the fetched entry is merged in')
    } finally {
      rmSync(h, { recursive: true, force: true })
    }
  })

  test('the default fetches a stale cache instead of leaving it out', async () => {
    // Under the previous default a stale cache was reported and left out, and the fix was a
    // flag the reader had to know. The default now completes the stale cache itself.
    const h = home()
    try {
      const old = new Date(Date.now() - 12 * 24 * 60 * 60 * 1000).toISOString()
      saveCache(cache(old), env(h))
      const asked: string[][] = []
      const result = await liveEntriesForPlan([ANDROID], {
        offline: false,
        refresh: false,
        cwd: '.',
        env: env(h),
        refreshLive: async (playbooks) => {
          asked.push(playbooks.map((p) => p.id))
          const live = new Map<string, DiscoveryEntry[]>()
          live.set('android', [{ ...entry('agent-skills'), fetchedAt: new Date().toISOString() }])
          return { live, warnings: [], cached: [] }
        },
      })
      assert.deepEqual(asked, [['android']])
      assert.equal(result.live.get('android')?.length, 1)
      assert.deepEqual(result.warnings, [], 'the fetch answered, so there is no staleness warning')
    } finally {
      rmSync(h, { recursive: true, force: true })
    }
  })

  test('only a playbook whose cache cannot answer is fetched', async () => {
    // Fetching a fresh cache again would spend a rate limit to rediscover what was fetched an
    // hour ago; the enrichment is per playbook, so a matched technology with a fresh cache is
    // left alone while one with no cache is fetched.
    const h = home()
    try {
      saveCache(cache(new Date().toISOString()), env(h))
      const asked: string[][] = []
      const result = await liveEntriesForPlan([ANDROID, NODE], {
        offline: false,
        refresh: false,
        cwd: '.',
        env: env(h),
        refreshLive: async (playbooks) => {
          asked.push(playbooks.map((p) => p.id))
          const live = new Map<string, DiscoveryEntry[]>()
          live.set('node', [entry('node-tooling')])
          return { live, warnings: [], cached: [] }
        },
      })
      assert.deepEqual(asked, [['node']], 'the fresh android cache is reused, not refetched')
      assert.equal(result.live.get('android')?.length, 1)
      assert.equal(result.live.get('node')?.length, 1)
    } finally {
      rmSync(h, { recursive: true, force: true })
    }
  })

  test('an unreadable cache is reported and refetched', async () => {
    const h = home()
    try {
      const path = cachePathFor('android', env(h))
      mkdirSync(dirname(path), { recursive: true })
      writeFileSync(path, 'not json', 'utf8')
      let fetched = false
      const result = await liveEntriesForPlan([ANDROID], {
        offline: false,
        refresh: false,
        cwd: '.',
        env: env(h),
        refreshLive: async () => {
          fetched = true
          const live = new Map<string, DiscoveryEntry[]>()
          live.set('android', [entry('agent-skills')])
          return { live, warnings: [], cached: [] }
        },
      })
      assert.equal(fetched, true)
      assert.equal(result.warnings.length, 1)
      assert.match(result.warnings[0]!, /unreadable/)
      assert.equal(result.live.get('android')?.length, 1)
    } finally {
      rmSync(h, { recursive: true, force: true })
    }
  })

  test('an enrichment that reaches no source keeps installed skills and its warning', async () => {
    const h = home()
    try {
      writeSkill(h, 'testing-setup', 'Android test strategy and coverage.')
      const result = await liveEntriesForPlan([ANDROID], {
        offline: false,
        refresh: false,
        cwd: '.',
        env: env(h),
        refreshLive: async () => ({ live: new Map(), warnings: ['no transport could reach GitHub'], cached: [] }),
      })
      assert.equal(result.live.get('android')?.length, 1)
      assert.equal(result.live.get('android')?.[0]?.source, 'local-scan')
      assert.deepEqual(result.warnings, ['no transport could reach GitHub'])
    } finally {
      rmSync(h, { recursive: true, force: true })
    }
  })

  test('a local-only cache is fetched, not trusted as an answer', async () => {
    // `discover --local-only` writes a fresh cache holding only local-scan entries. Reusing it
    // would suppress online enrichment for a week, which is the opposite of the default.
    const h = home()
    try {
      writeSkill(h, 'testing-setup', 'Android test strategy and coverage.')
      const localOnly: DiscoveryEntry = {
        ...entry('testing-setup'),
        url: '',
        source: 'local-scan',
        trust: 'local-install',
        install: join(h, '.agents', 'skills', 'testing-setup', 'SKILL.md'),
        repo: null,
        owner: null,
      }
      saveCache(
        {
          schemaVersion: 1,
          playbookId: 'android',
          fetchedAt: new Date().toISOString(),
          entries: [localOnly],
          remoteAnswered: false,
        },
        env(h),
      )
      let fetched = false
      const result = await liveEntriesForPlan([ANDROID], {
        offline: false,
        refresh: false,
        cwd: '.',
        env: env(h),
        refreshLive: async () => {
          fetched = true
          const live = new Map<string, DiscoveryEntry[]>()
          live.set('android', [entry('agent-skills')])
          return { live, warnings: [], cached: [] }
        },
      })
      assert.equal(fetched, true, 'a cache with no complete remote answer must be fetched')
      const sources = result.live.get('android')?.map((e) => e.source) ?? []
      assert.ok(sources.includes('local-scan'), 'the installed skill is still listed')
      assert.ok(sources.includes('github-search'), 'the missing remote half is fetched')
    } finally {
      rmSync(h, { recursive: true, force: true })
    }
  })

  test('a partial cache is fetched again', async () => {
    // A cache written when one source did not answer is not complete, so the default retries
    // it rather than presenting the half-answer as the whole truth.
    const h = home()
    try {
      saveCache(
        {
          schemaVersion: 1,
          playbookId: 'android',
          fetchedAt: new Date().toISOString(),
          entries: [entry('agent-skills')],
          remoteAnswered: false,
        },
        env(h),
      )
      let fetched = false
      await liveEntriesForPlan([ANDROID], {
        offline: false,
        refresh: false,
        cwd: '.',
        env: env(h),
        refreshLive: async () => {
          fetched = true
          return { live: new Map(), warnings: [], cached: [] }
        },
      })
      assert.equal(fetched, true, 'an incomplete cache must be retried')
    } finally {
      rmSync(h, { recursive: true, force: true })
    }
  })

  test('a complete empty answer is reused instead of fetched again', async () => {
    // "Asked, nothing matched" is a complete answer. A cache holding it has no entries to
    // show, but there is still nothing to retry until it ages out.
    const h = home()
    try {
      saveCache(
        {
          schemaVersion: 1,
          playbookId: 'android',
          fetchedAt: new Date().toISOString(),
          entries: [],
          remoteAnswered: true,
        },
        env(h),
      )
      let fetched = false
      const result = await liveEntriesForPlan([ANDROID], {
        offline: false,
        refresh: false,
        cwd: '.',
        env: env(h),
        refreshLive: async () => {
          fetched = true
          return { live: new Map(), warnings: [], cached: [] }
        },
      })
      assert.equal(fetched, false, 'an answered empty cache must not be fetched again')
      assert.deepEqual(result.warnings, [])
    } finally {
      rmSync(h, { recursive: true, force: true })
    }
  })
})
