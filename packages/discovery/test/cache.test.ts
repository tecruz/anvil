/**
 * The cache.
 *
 * The behaviours pinned here are the ones that decide whether a failed run is visible or
 * invisible: a corrupt cache, an expired one, and a write interrupted halfway all have to end
 * up as a *stated* condition rather than an empty list that reads like "there is nothing".
 */

import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, test } from 'node:test'
import {
  type CacheFile,
  cachePathFor,
  type DiscoveryEntry,
  discoveryCacheDir,
  isEntry,
  loadCache,
  saveCache,
  usableEntries,
} from '@anvil/discovery'

function home(): string {
  return mkdtempSync(join(tmpdir(), 'anvil-cache-'))
}

function env(h: string): NodeJS.ProcessEnv {
  return { ANVIL_CONFIG_HOME: h } as NodeJS.ProcessEnv
}

function entry(over: Partial<DiscoveryEntry> = {}): DiscoveryEntry {
  return {
    label: 'android/skills',
    url: 'https://github.com/android/skills',
    why: 'Official Android agent skills.',
    tier: 'official',
    section: 'skills',
    source: 'github-search',
    fetchedAt: new Date().toISOString(),
    stars: 120,
    install: null,
    repo: 'android/skills',
    owner: 'android',
    ...over,
  }
}

describe('cache paths', () => {
  test('honours ANVIL_CONFIG_HOME, so tests never touch the real home directory', () => {
    const h = home()
    try {
      const dir = discoveryCacheDir(env(h))
      // Compared with separators normalised, because a path assertion written for POSIX
      // separators fails on Windows for a reason that has nothing to do with the code.
      const normalised = dir.replace(/\\/g, '/')
      assert.ok(normalised.endsWith('/.anvil/cache/discovery'), `got ${dir}`)
      assert.equal(cachePathFor('android', env(h)), join(dir, 'android.json'))
    } finally {
      rmSync(h, { recursive: true, force: true })
    }
  })

  test('the playbook id becomes the filename, with no path of its own', () => {
    const h = home()
    try {
      const dir = discoveryCacheDir(env(h))
      assert.equal(cachePathFor('android', env(h)), join(dir, 'android.json'))
      // The schema constrains ids to lowercase alphanumerics and hyphens, and `join` is the
      // only thing standing between a crafted id and a write outside the cache directory.
      // Asserted on the join rather than by trying an escape, which would depend on how the
      // platform normalises `..` inside a path.
      assert.equal(cachePathFor('a-b', env(h)), join(dir, 'a-b.json'))
    } finally {
      rmSync(h, { recursive: true, force: true })
    }
  })
})

describe('saveCache and loadCache', () => {
  test('round-trips a record', () => {
    const h = home()
    try {
      const file: CacheFile = {
        schemaVersion: 1,
        playbookId: 'android',
        fetchedAt: new Date().toISOString(),
        entries: [entry()],
      }
      const path = saveCache(file, env(h))
      assert.ok(existsSync(path))
      const read = loadCache('android', env(h))
      assert.equal(read.status, 'fresh')
      assert.equal(read.cache?.entries.length, 1)
      assert.equal(read.cache?.entries[0]?.label, 'android/skills')
    } finally {
      rmSync(h, { recursive: true, force: true })
    }
  })

  test('a missing cache is absent, not an error', () => {
    const h = home()
    try {
      const read = loadCache('android', env(h))
      assert.equal(read.status, 'absent')
      assert.equal(read.cache, null)
      assert.deepEqual(usableEntries(read), [])
    } finally {
      rmSync(h, { recursive: true, force: true })
    }
  })

  test('an expired cache is stale and still usable, with a message that names the fix', () => {
    const h = home()
    try {
      const old = new Date(Date.now() - 9 * 24 * 60 * 60 * 1000).toISOString()
      saveCache({ schemaVersion: 1, playbookId: 'android', fetchedAt: old, entries: [entry()] }, env(h))
      const read = loadCache('android', env(h))
      assert.equal(read.status, 'stale')
      // Stale still has its entries: a week-old answer beats no answer, as long as the
      // reader is told it is a week old.
      assert.equal(read.cache?.entries.length, 1)
      assert.match(read.detail, /--refresh/)
      assert.equal(read.detail.includes('android'), true)
    } finally {
      rmSync(h, { recursive: true, force: true })
    }
  })

  test('a fresh cache is not stale', () => {
    const h = home()
    try {
      saveCache({ schemaVersion: 1, playbookId: 'go', fetchedAt: new Date().toISOString(), entries: [entry()] }, env(h))
      assert.equal(loadCache('go', env(h)).status, 'fresh')
    } finally {
      rmSync(h, { recursive: true, force: true })
    }
  })

  test('corrupt JSON is unreadable rather than a thrown error', () => {
    // Throwing would turn a half-written file from an interrupted run into a tool that
    // cannot start, for a file whose whole purpose is to be regenerated.
    const h = home()
    try {
      saveCache({ schemaVersion: 1, playbookId: 'android', fetchedAt: new Date().toISOString(), entries: [] }, env(h))
      writeFileSync(cachePathFor('android', env(h)), '{ not json', 'utf8')
      const read = loadCache('android', env(h))
      assert.equal(read.status, 'unreadable')
      assert.equal(read.cache, null)
      assert.deepEqual(usableEntries(read), [])
    } finally {
      rmSync(h, { recursive: true, force: true })
    }
  })

  test('JSON that is not a discovery record is unreadable', () => {
    const h = home()
    try {
      const path = cachePathFor('android', env(h))
      saveCache({ schemaVersion: 1, playbookId: 'android', fetchedAt: new Date().toISOString(), entries: [] }, env(h))
      writeFileSync(path, JSON.stringify({ hello: 'world' }), 'utf8')
      assert.equal(loadCache('android', env(h)).status, 'unreadable')
    } finally {
      rmSync(h, { recursive: true, force: true })
    }
  })

  test('a record with no fetch timestamp is unreadable, because it cannot be aged', () => {
    const h = home()
    try {
      const path = cachePathFor('android', env(h))
      saveCache({ schemaVersion: 1, playbookId: 'android', fetchedAt: new Date().toISOString(), entries: [] }, env(h))
      writeFileSync(path, JSON.stringify({ schemaVersion: 1, playbookId: 'android', entries: [] }), 'utf8')
      assert.equal(loadCache('android', env(h)).status, 'unreadable')
    } finally {
      rmSync(h, { recursive: true, force: true })
    }
  })

  test('an unparseable timestamp is unreadable rather than treated as brand new', () => {
    // `Date.parse` returns NaN, and `NaN > TTL` is false -- so without the explicit check
    // this would read as freshly fetched, forever.
    const h = home()
    try {
      const path = cachePathFor('android', env(h))
      saveCache({ schemaVersion: 1, playbookId: 'android', fetchedAt: new Date().toISOString(), entries: [] }, env(h))
      writeFileSync(
        path,
        JSON.stringify({ schemaVersion: 1, playbookId: 'android', fetchedAt: 'soon', entries: [] }),
        'utf8',
      )
      assert.equal(loadCache('android', env(h)).status, 'unreadable')
    } finally {
      rmSync(h, { recursive: true, force: true })
    }
  })

  test('the write leaves no temp file behind', () => {
    const h = home()
    try {
      const path = saveCache(
        { schemaVersion: 1, playbookId: 'android', fetchedAt: new Date().toISOString(), entries: [entry()] },
        env(h),
      )
      assert.equal(path.endsWith('.tmp'), false)
      assert.equal(existsSync(`${path}.tmp`), false, 'the rename should have consumed it')
      assert.doesNotThrow(() => JSON.parse(readFileSync(path, 'utf8')))
    } finally {
      rmSync(h, { recursive: true, force: true })
    }
  })
})

describe('isEntry', () => {
  test('accepts a well-formed entry', () => {
    assert.ok(isEntry(entry()))
  })

  test('accepts a local skill, which has no url', () => {
    // The only source that works offline, so a rule of "every entry needs an https URL"
    // would silently delete it.
    assert.ok(
      isEntry(entry({ url: '', source: 'local-scan', install: '/home/u/.agents/skills/x/SKILL.md', repo: null })),
    )
  })

  test('rejects an http or relative url', () => {
    assert.equal(isEntry(entry({ url: 'http://github.com/a/b' })), false)
    assert.equal(isEntry(entry({ url: '/local/path' })), false)
    assert.equal(isEntry(entry({ url: 'javascript:alert(1)' })), false)
  })

  test('rejects an empty url that did not come from a local scan', () => {
    assert.equal(isEntry(entry({ url: '', source: 'github-search' })), false)
  })

  test('rejects an entry with no explanation', () => {
    assert.equal(isEntry(entry({ why: '' })), false)
    assert.equal(isEntry(entry({ why: '   ' })), false)
  })

  test('rejects an unknown tier', () => {
    assert.equal(isEntry(entry({ tier: 'vibes' as never })), false)
  })

  test('rejects a non-string install, rather than letting it reach a renderer that trims it', () => {
    // A cache is a file any process may have written. A numeric install used to pass the URL
    // check and then throw in `brief`, far from the cache that caused it.
    assert.equal(isEntry(entry({ url: 'https://example.org/tool', install: 42 as never })), false)
    assert.equal(isEntry(entry({ url: 'https://example.org/tool', install: {} as never })), false)
  })

  test('rejects non-objects', () => {
    for (const value of [null, undefined, 'x', 42, []]) assert.equal(isEntry(value), false)
  })
})

describe('usableEntries', () => {
  test('drops entries that fail validation, keeping the rest', () => {
    // One bad record from an older run must not cost the whole cache.
    const h = home()
    try {
      // Written raw rather than through `saveCache` so the invalid entries exist at all --
      // `saveCache` has no validation of its own, and that is deliberate: it is a cache
      // writer, and validation happens on read where a foreign record can also turn up.
      saveCache({ schemaVersion: 1, playbookId: 'android', fetchedAt: new Date().toISOString(), entries: [] }, env(h))
      const path = cachePathFor('android', env(h))
      writeFileSync(
        path,
        JSON.stringify({
          schemaVersion: 1,
          playbookId: 'android',
          fetchedAt: new Date().toISOString(),
          entries: [entry(), { label: 'broken' }, entry({ label: 'other/repo' })],
        }),
        'utf8',
      )
      const kept = usableEntries(loadCache('android', env(h)))
      assert.equal(kept.length, 2)
      assert.deepEqual(
        kept.map((e) => e.label),
        ['android/skills', 'other/repo'],
      )
    } finally {
      rmSync(h, { recursive: true, force: true })
    }
  })
})
