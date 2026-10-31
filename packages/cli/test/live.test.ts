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
import { join } from 'node:path'
import { describe, test } from 'node:test'
import { type CacheFile, type DiscoveryEntry, saveCache } from '@anvil/discovery'
import { liveEntriesForPlan, loadLiveForPlan } from '../src/commands/discover.ts'

const ANDROID = { id: 'android', discover: { officialOrgs: ['android'], keywords: [], mcp: [] } }

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

  test('the default cache path applies the same stale rule', async () => {
    const h = home()
    try {
      const old = new Date(Date.now() - 12 * 24 * 60 * 60 * 1000).toISOString()
      saveCache(cache(old), env(h))
      const result = await liveEntriesForPlan([ANDROID], {
        offline: false,
        refresh: false,
        cwd: '.',
        env: env(h),
      })
      assert.equal(result.live.size, 0)
      assert.equal(result.warnings.length, 1)
      assert.match(result.warnings[0]!, /--refresh/)
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

  test('without --refresh the cache is read and nothing is fetched', async () => {
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
})
