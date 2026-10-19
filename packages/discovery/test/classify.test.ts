/**
 * Classification and the confidence ladder.
 *
 * The classification is the one place this package makes a claim about who maintains a
 * repository, so it is tested at the boundary: org matching is case-insensitive and
 * exact, and a near-miss on an org name does not count as official.
 */

import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import {
  type DiscoverSeeds,
  isAgentTooling,
  isOfficialOrg,
  liveConfidence,
  queriesFor,
  sectionFor,
} from '@anvil/discovery'

const ANDROID: DiscoverSeeds = {
  officialOrgs: ['android', 'google'],
  keywords: ['android agent skills', 'android cli'],
  mcp: ['android'],
}

const NOW = '2026-10-02T12:00:00.000Z'

function entry(over: Partial<Parameters<typeof liveConfidence>[0]> = {}): Parameters<typeof liveConfidence>[0] {
  return {
    label: 'owner/repo',
    url: 'https://github.com/owner/repo',
    why: 'because',
    tier: 'community',
    section: 'community',
    source: 'github-search',
    fetchedAt: NOW,
    stars: null,
    install: null,
    repo: 'owner/repo',
    owner: 'owner',
    ...over,
  }
}

describe('isOfficialOrg', () => {
  test('matches a seeded org exactly', () => {
    assert.ok(isOfficialOrg('android', ANDROID))
    assert.ok(isOfficialOrg('google', ANDROID))
  })

  test('is case-insensitive, because GitHub logins are', () => {
    assert.ok(isOfficialOrg('Android', ANDROID))
    assert.ok(isOfficialOrg('GOOGLE', ANDROID))
  })

  test('does not match a prefix or a suffix of a seeded org', () => {
    // Substring matching would call `androidx-compat` and `not-google` official, which is
    // the whole claim this function makes.
    assert.equal(isOfficialOrg('androidx', ANDROID), false)
    assert.equal(isOfficialOrg('my-google-fork', ANDROID), false)
    assert.equal(isOfficialOrg('goog', ANDROID), false)
  })

  test('no seeds means nothing is official', () => {
    const none: DiscoverSeeds = { officialOrgs: [], keywords: ['x'], mcp: [] }
    assert.equal(isOfficialOrg('android', none), false)
  })
})

describe('sectionFor', () => {
  test('an MCP server lands in mcp', () => {
    assert.equal(sectionFor({ fullName: 'org/x', description: 'An MCP server for Go' }), 'mcp')
  })

  test('a skills repository lands in skills', () => {
    assert.equal(sectionFor({ fullName: 'org/skills', description: 'Official agent skills' }), 'skills')
  })

  test('a CLI lands in agents', () => {
    assert.equal(sectionFor({ fullName: 'org/cli', description: 'A command-line assistant for Android' }), 'agents')
  })

  test('mcp wins over skills when a repository claims both', () => {
    // Order is fixed rather than map-iteration order, so the result is a function of the
    // seeds and not of which key happened to be checked first.
    assert.equal(sectionFor({ fullName: 'org/x', description: 'MCP server and skills, both' }), 'mcp')
  })

  test('anything unrecognised is community', () => {
    assert.equal(sectionFor({ fullName: 'org/lib', description: 'A fast JSON parser' }), 'community')
  })

  test('a missing description does not throw', () => {
    assert.equal(sectionFor({ fullName: 'org/x', description: null }), 'community')
  })
})

describe('isAgentTooling', () => {
  test('accepts a repository that is agent tooling', () => {
    assert.ok(isAgentTooling({ fullName: 'android/skills', description: 'Official agent skills' }))
    assert.ok(isAgentTooling({ fullName: 'x', description: 'An MCP server for Postgres' }))
  })

  test('rejects a repository that merely mentions the technology', () => {
    // A search for `android cli` returns ordinary Android command-line tools. Offering
    // those in a plan whose job is agent guidance puts an APK signer next to an agent skill.
    assert.equal(isAgentTooling({ fullName: 'some/apk-signer', description: 'Sign Android APKs' }), false)
  })
})

describe('liveConfidence', () => {
  test('official discovery is capped below curated official guidance', () => {
    // Curated `skill`/`agent`/`mcp` entries score 0.7. A discovered one must not reach it,
    // because the org check is a seed list and nobody reviewed the entry.
    assert.equal(liveConfidence(entry({ tier: 'official', stars: 999_999 })), 0.65)
  })

  test('community discovery sits one notch below the curated ladder', () => {
    // 20000+ stars is 0.6 curated, so 0.55 live.
    assert.equal(liveConfidence(entry({ tier: 'community', stars: 25_000 })), 0.55)
    assert.equal(liveConfidence(entry({ tier: 'community', stars: 6_000 })), 0.45)
    assert.equal(liveConfidence(entry({ tier: 'community', stars: 1_500 })), 0.4)
  })

  test('never drops below the floor, whatever the star count', () => {
    assert.equal(liveConfidence(entry({ tier: 'community', stars: 0 })), 0.3)
    assert.equal(liveConfidence(entry({ tier: 'community', stars: null })), 0.35)
  })

  test('an official entry outranks a community one at equal stars', () => {
    assert.ok(
      liveConfidence(entry({ tier: 'official', stars: 10 })) > liveConfidence(entry({ tier: 'community', stars: 10 })),
    )
  })
})

describe('queriesFor', () => {
  test('puts official orgs first', () => {
    // An org-scoped query is the cheapest way to find the most valuable thing: a repository
    // published by the org that speaks for the technology.
    const queries = queriesFor(ANDROID)
    assert.match(queries[0] ?? '', /^org:android/)
    assert.match(queries[1] ?? '', /^org:google/)
  })

  test('caps the number of queries a seed list can spend', () => {
    // `playbook add` installs YAML from a URL, so a seed list is untrusted input and cannot
    // be assumed short. Six queries is the ceiling on one playbook's rate-limit budget.
    const greedy: DiscoverSeeds = {
      officialOrgs: ['a', 'b', 'c', 'd'],
      keywords: ['1', '2', '3', '4', '5', '6', '7', '8'],
      mcp: [],
    }
    assert.ok(queriesFor(greedy).length <= 6, `got ${String(queriesFor(greedy).length)} queries`)
  })

  test('keywords come after the orgs', () => {
    const queries = queriesFor(ANDROID)
    const lastOrg = queries.findLastIndex((q) => q.startsWith('org:'))
    const firstKeyword = queries.indexOf('android agent skills')
    assert.ok(firstKeyword !== -1, JSON.stringify(queries))
    assert.ok(firstKeyword > lastOrg, `keyword at ${String(firstKeyword)} must follow every org-scoped query`)
  })

  test('an empty seed list produces no queries rather than a wildcard', () => {
    assert.deepEqual(queriesFor({ officialOrgs: [], keywords: [], mcp: [] }), [])
  })
})
