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
import { describe, test } from 'node:test'
import type { DiscoveryEntry } from '@anvil/discovery'
import { liveEntriesForPlan } from '../src/commands/discover.ts'

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

describe('liveEntriesForPlan', () => {
  test('--offline asks for nothing, and fetches nothing', async () => {
    let fetched = false
    const result = await liveEntriesForPlan([ANDROID], {
      offline: true,
      refresh: false,
      cwd: '.',
      refreshLive: async () => {
        fetched = true
        return { live: new Map(), warnings: [], cached: [] }
      },
    })
    assert.equal(fetched, false)
    assert.equal(result.live.size, 0)
  })

  test('--refresh fetches for the playbooks that matched', async () => {
    const asked: string[][] = []
    const result = await liveEntriesForPlan([ANDROID], {
      offline: false,
      refresh: true,
      cwd: '.',
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
  })

  test('without --refresh the cache is read and nothing is fetched', async () => {
    let fetched = false
    const result = await liveEntriesForPlan([ANDROID], {
      offline: false,
      refresh: false,
      cwd: '.',
      refreshLive: async () => {
        fetched = true
        return { live: new Map(), warnings: [], cached: [] }
      },
    })
    assert.equal(fetched, false)
    // The machine's own cache is whatever it is; the point is that this path never fetched.
    assert.ok(result.live instanceof Map)
  })
})
