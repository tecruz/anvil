/**
 * The live-discovery layer as seen from the playbook side: the seeds in the registry, and
 * how discovered resources merge into a plan.
 *
 * The merge rules are the whole point of the feature, and each one exists because the
 * alternative produces output a reader cannot act on:
 *
 *   - Curated wins a contested URL. Otherwise `plan` would print the same link twice on a
 *     screen sized for one, and which copy appeared would depend on network state.
 *   - Live confidence is capped below curated. A fetched entry nobody reviewed must not
 *     read as settled advice.
 *   - Ordering is stable. Two runs over the same cache produce the same plan.
 */

import assert from 'node:assert/strict'
import { dirname, join, resolve } from 'node:path'
import { describe, test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { audit } from '@anvil/audit'
import {
  buildPlan,
  type LiveResource,
  loadBuiltins,
  matchPlaybooks,
  normalizeUrl,
  parsePlaybook,
  parseYamlSubset,
  validatePlaybook,
} from '@anvil/playbooks'
import { buildProfile } from '@anvil/profile'

const here = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = resolve(here, '..', '..', '..')
const NOW = '2026-10-02T12:00:00.000Z'

function live(over: Partial<LiveResource> = {}): LiveResource {
  return {
    label: 'android/skills',
    url: 'https://github.com/android/skills',
    why: 'Official agent skills published by the Android team.',
    tier: 'official',
    section: 'skills',
    stars: 1200,
    install: null,
    source: 'github-search',
    fetchedAt: NOW,
    ...over,
  }
}

function planWith(liveEntries: Map<string, LiveResource[]>, fixture = 'jvm-gradle') {
  const root = join(REPO_ROOT, 'fixtures', fixture)
  const profile = buildProfile(root, { root, host: null, remote: null, defaultBranch: null }).profile
  const { playbooks } = loadBuiltins()
  const matches = matchPlaybooks(profile, playbooks)
  return buildPlan(audit(profile), profile, matches, [], liveEntries)
}

// ---------------------------------------------------------------------------
// Seeds in the registry
// ---------------------------------------------------------------------------

describe('discovery seeds in the built-in registry', () => {
  const { playbooks } = loadBuiltins()

  test('every playbook declares at least one seed, so the command is useful for all of them', () => {
    // The feature was asked for across every technology. A playbook with no seeds is one
    // `anvil playbook discover` silently skips, which reads as "nothing found".
    for (const p of playbooks) {
      const total = p.discover.officialOrgs.length + p.discover.keywords.length + p.discover.mcp.length
      assert.ok(total > 0, `${p.id} declares no discovery seeds`)
    }
  })

  test('every playbook names at least one official org', () => {
    for (const p of playbooks) {
      assert.ok(
        p.discover.officialOrgs.length > 0,
        `${p.id} has no officialOrgs, so nothing can be classified official`,
      )
    }
  })

  test('an official org looks like a GitHub login', () => {
    for (const p of playbooks) {
      for (const org of p.discover.officialOrgs) {
        assert.match(org, /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/, `${p.id}: "${org}" is not a GitHub login`)
      }
    }
  })

  test('keywords carry the technology name, since they are what the search runs on', () => {
    // A keyword of "tools" would match every repository on GitHub and return a plan full of
    // unrelated projects.
    for (const p of playbooks) {
      const terms = [p.id, ...p.id.split('-'), ...p.discover.keywords]
      const distinctive = terms.some((t) => t.length >= 4 && !/^(tool|tools|code|app|apps)$/i.test(t))
      assert.ok(distinctive, `${p.id} has no distinctive term to search on`)
    }
  })

  test('the android playbook declares the org that publishes its own tooling', () => {
    // The gap that motivated the package: `android.yaml` listed no agents and no MCP servers
    // because there was nowhere to record "Google publishes these; go and find them".
    const android = playbooks.find((p) => p.id === 'android')
    assert.ok(android !== undefined)
    assert.ok(
      android.discover.officialOrgs.some((o) => o === 'android' || o === 'google'),
      'the Android team publishes under the android and google orgs',
    )
    assert.ok(android.discover.keywords.length > 0)
    assert.ok(android.discover.mcp.length > 0)
  })

  test('seeds do not restate an entry the playbook already cites', () => {
    // A seed that duplicates curated data is two places to rot for one fact.
    for (const p of playbooks) {
      for (const keyword of p.discover.keywords) {
        const url = p.official.docs.find((d) => d.url.includes(keyword))
        assert.equal(url, undefined, `${p.id}: keyword "${keyword}" restates ${url?.url ?? ''}`)
      }
    }
  })
})

describe('discover section validation', () => {
  const MINIMAL = "id: toy\ntitle: Toy\npriority: 10\nmatch:\n  files: ['toy.toml']\n"

  test('accepts the three seed lists', () => {
    const { playbook, issues } = validatePlaybook(
      parseYamlSubset(`${MINIMAL}discover:\n  officialOrgs: ['a', 'b']\n  keywords: ['x']\n  mcp: ['y']\n`),
    )
    assert.deepEqual(issues, [])
    assert.deepEqual(playbook?.discover.officialOrgs, ['a', 'b'])
    assert.deepEqual(playbook?.discover.keywords, ['x'])
    assert.deepEqual(playbook?.discover.mcp, ['y'])
  })

  test('an absent discover section is empty, not an error', () => {
    const { playbook, issues } = validatePlaybook(parseYamlSubset(MINIMAL))
    assert.deepEqual(issues, [])
    assert.deepEqual(playbook?.discover, { officialOrgs: [], keywords: [], mcp: [] })
  })

  test('rejects an unknown seed key with a dotted path', () => {
    const { issues } = validatePlaybook(parseYamlSubset(`${MINIMAL}discover:\n  orgs: ['a']\n`))
    assert.ok(issues.some((i) => i.path === 'discover.orgs' && i.message === 'unknown key'))
  })

  test('rejects a seed list that is not a list', () => {
    const { issues } = validatePlaybook(parseYamlSubset(`${MINIMAL}discover:\n  officialOrgs: android\n`))
    assert.ok(issues.some((i) => i.path === 'discover.officialOrgs'))
  })

  test('rejects an official org that is not a GitHub login', () => {
    // A typo here is silent in the worst way: the search runs, matches nothing, and the
    // plan reports that the ecosystem has published nothing.
    const { issues } = validatePlaybook(
      parseYamlSubset(`${MINIMAL}discover:\n  officialOrgs: ['android ', 'not a login']\n`),
    )
    const orgs = issues.filter((i) => i.path === 'discover.officialOrgs')
    assert.equal(orgs.length, 2)
    assert.match(orgs[0]?.message ?? '', /not a GitHub login/)
  })

  test('rejects a blank keyword or mcp term', () => {
    const { issues } = validatePlaybook(parseYamlSubset(`${MINIMAL}discover:\n  keywords: ['']\n  mcp: ['  ']\n`))
    assert.ok(issues.some((i) => i.path === 'discover.keywords' && /non-empty/.test(i.message)))
    assert.ok(issues.some((i) => i.path === 'discover.mcp' && /non-empty/.test(i.message)))
  })

  test('accepts a login with a hyphen, because GitHub allows one', () => {
    const { issues } = validatePlaybook(parseYamlSubset(`${MINIMAL}discover:\n  officialOrgs: ['google-deepmind']\n`))
    assert.deepEqual(issues, [])
  })

  test('parsePlaybook keeps discover through a full round trip', () => {
    const pb = parsePlaybook(`${MINIMAL}discover:\n  officialOrgs: ['acme']\n`, 'toy.yaml')
    assert.deepEqual(pb.discover.officialOrgs, ['acme'])
  })
})

// ---------------------------------------------------------------------------
// Merging live entries into the plan
// ---------------------------------------------------------------------------

describe('plan merge', () => {
  test('a live entry appears with its provenance marked', () => {
    const plan = planWith(new Map([['jvm', [live({ section: 'skills' })]]]))
    const entry = plan.suggestions.find((s) => s.id.startsWith('live:jvm:'))
    assert.ok(entry !== undefined, 'expected a live suggestion')
    assert.equal(entry.provenance, 'live')
    assert.equal(entry.fetchedAt, NOW)
    assert.equal(entry.tier, 'official')
    assert.match(entry.title, /^skill: /)
  })

  test('every curated suggestion is marked curated', () => {
    const plan = planWith(new Map([['jvm', [live()]]]))
    for (const s of plan.suggestions.filter((x) => !x.id.startsWith('live:'))) {
      assert.equal(s.provenance, 'curated', `${s.id} should be curated`)
      assert.equal(s.fetchedAt, undefined, `${s.id} is curated, so it has no fetch time`)
    }
  })

  test('a curated entry wins a url a live entry also has', () => {
    const plan = planWith(new Map([['jvm', [live({ url: 'https://developer.android.com/develop' })]]]))
    assert.equal(
      plan.suggestions.filter((s) => s.url === 'https://developer.android.com/develop').length,
      1,
      'the same link printed twice reads as two separate concerns',
    )
    assert.equal(plan.suggestions.find((s) => s.url === 'https://developer.android.com/develop')?.provenance, 'curated')
  })

  test('live official confidence is below curated official confidence', () => {
    const plan = planWith(new Map([['jvm', [live({ tier: 'official', stars: 999_999 })]]]))
    const liveEntry = plan.suggestions.find((s) => s.id.startsWith('live:jvm:'))
    const curated = plan.suggestions.filter((s) => s.tier === 'official' && s.provenance === 'curated')
    assert.ok(curated.length > 0)
    for (const c of curated) {
      assert.ok(
        (liveEntry?.confidence ?? 1) < c.confidence,
        `live ${String(liveEntry?.confidence)} should rank below curated ${String(c.confidence)}`,
      )
    }
  })

  test('a live community entry lands in the community tier', () => {
    const plan = planWith(new Map([['jvm', [live({ tier: 'community', section: 'community' })]]]))
    const entry = plan.suggestions.find((s) => s.id.startsWith('live:jvm:'))
    assert.equal(entry?.tier, 'community')
  })

  test('live evidence names the source and the time, because there is no file to cite', () => {
    const plan = planWith(new Map([['jvm', [live({ source: 'local-scan' })]]]))
    const entry = plan.suggestions.find((s) => s.id.startsWith('live:jvm:'))
    assert.ok(
      entry?.evidence.some((e) => e === `live:local-scan ${NOW}`),
      JSON.stringify(entry?.evidence),
    )
  })

  test('a local skill gets no url, rather than a file:// one', () => {
    const plan = planWith(
      new Map([
        [
          'jvm',
          [live({ url: '', section: 'skills', source: 'local-scan', install: '/home/u/.agents/skills/x/SKILL.md' })],
        ],
      ]),
    )
    const entry = plan.suggestions.find((s) => s.id.startsWith('live:jvm:'))
    assert.ok(entry !== undefined)
    assert.equal(entry.url, undefined, 'a file:// url renders as a broken href in every consumer')
    assert.ok(entry.evidence.includes('/home/u/.agents/skills/x/SKILL.md'))
  })

  test('two local skills with the same install path do not collide', () => {
    const plan = planWith(
      new Map([
        [
          'jvm',
          [
            live({ label: 'one', url: '', install: '/a', source: 'local-scan' }),
            live({ label: 'two', url: '', install: '/b', source: 'local-scan' }),
          ],
        ],
      ]),
    )
    assert.equal(plan.suggestions.filter((s) => s.id.startsWith('live:jvm:')).length, 2)
  })

  test('live entries are not attributed to a playbook that did not match', () => {
    // Discovery is keyed by playbook id, so a cached `android` entry on a repo that matched
    // only `node` must not appear.
    const plan = planWith(new Map([['android', [live()]]]), 'node-npm')
    assert.equal(plan.suggestions.filter((s) => s.id.startsWith('live:')).length, 0)
  })

  test('the same cache produces the same order twice', () => {
    const cache = new Map([['jvm', [live(), live({ label: 'x/y', url: 'https://github.com/x/y' })]]])
    const first = planWith(cache).suggestions.map((s) => s.id)
    const second = planWith(cache).suggestions.map((s) => s.id)
    assert.deepEqual(first, second)
  })

  test('counts include live entries', () => {
    const plan = planWith(new Map([['jvm', [live({ tier: 'official' })]]]))
    assert.equal(
      plan.counts.official,
      plan.suggestions.filter((s) => s.tier === 'official').length,
      'a count that omits live entries misreports the plan size',
    )
    assert.ok(plan.counts.official > 0)
  })

  test('an empty cache changes nothing about the plan', () => {
    const withoutLive = planWith(new Map())
    const withEmptyLive = planWith(new Map([['jvm', []]]))
    assert.deepEqual(
      withEmptyLive.suggestions.map((s) => s.id),
      withoutLive.suggestions.map((s) => s.id),
    )
  })

  test('tier ordering survives the merge: derived, then official, then community', () => {
    const plan = planWith(
      new Map([
        ['jvm', [live({ tier: 'community', section: 'community' }), live({ tier: 'official', section: 'agents' })]],
      ]),
    )
    const order = plan.suggestions.map((s) => s.tier)
    const lastDerived = order.lastIndexOf('derived')
    const firstOfficial = order.indexOf('official')
    const lastOfficial = order.lastIndexOf('official')
    const firstCommunity = order.indexOf('community')
    if (lastDerived !== -1 && firstOfficial !== -1) assert.ok(lastDerived < firstOfficial)
    if (lastOfficial !== -1 && firstCommunity !== -1) assert.ok(lastOfficial < firstCommunity)
  })
})

describe('normalizeUrl', () => {
  test('treats a scheme, case and trailing slash as insignificant', () => {
    const canonical = normalizeUrl('https://github.com/a/b')
    assert.equal(normalizeUrl('https://GitHub.com/a/b/'), canonical)
    assert.equal(normalizeUrl('github.com/a/b'), canonical)
    assert.equal(normalizeUrl('  https://github.com/a/b  '), canonical)
  })

  test('keeps paths distinct', () => {
    assert.notEqual(normalizeUrl('https://github.com/a/b'), normalizeUrl('https://github.com/a/c'))
  })

  test('unparseable input does not throw', () => {
    assert.equal(typeof normalizeUrl('not a url at all'), 'string')
  })
})
