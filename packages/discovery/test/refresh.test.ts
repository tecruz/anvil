/**
 * The refresh path: fetch now, cache what came back, keep what did not.
 *
 * The rule this suite exists for is the one a refresh is most likely to break. A cache is
 * the last good answer, and a refresh that finds nothing -- because a registry was briefly
 * unreachable, or a rate limit arrived -- must not replace it with nothing. A plan that
 * lost its live guidance because a server was down would say, truthfully and uselessly,
 * that the ecosystem has published nothing.
 */

import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
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
    assert.equal(result.cached.length, 0, 'a refresh that found nothing writes nothing')
    assert.ok(result.warnings.some((w) => /found nothing; the cached entries were kept/.test(w)))
    assert.equal(loadCache('android', env).cache?.entries.length, 1)
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
