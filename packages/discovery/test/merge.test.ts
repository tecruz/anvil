/**
 * The per-source merge: a source that answered replaces its own entries, and a source that
 * could not be reached keeps them.
 *
 * The failure this prevents is quiet and easy to miss. Discovery has three sources that
 * answer independently. A run where GitHub is rate-limited but the MCP registry answers
 * used to write a cache holding only the MCP entries: the GitHub half was erased by a source
 * that did not run. The next plan then showed fewer live entries than the one before it,
 * with nothing to say why, and the conclusion the reader would draw -- that the ecosystem
 * had published less -- is the one conclusion the tool was never entitled to draw.
 */

import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { type DiscoveryEntry, mergeBySource, type SourceNote, unansweredSources } from '@anvil/discovery'

function entry(over: Partial<DiscoveryEntry> = {}): DiscoveryEntry {
  return {
    label: 'android/agent-skills',
    url: 'https://github.com/android/agent-skills',
    why: 'Official Android agent skills.',
    tier: 'official',
    section: 'skills',
    source: 'github-search',
    fetchedAt: '2026-10-01T00:00:00.000Z',
    stars: 900,
    install: null,
    repo: 'android/agent-skills',
    owner: 'android',
    ...over,
  }
}

function note(source: SourceNote['source'], answered: boolean, entries = 0): SourceNote {
  return {
    source,
    answered,
    entries,
    detail: answered ? 'answered' : 'could not be reached',
  }
}

describe('mergeBySource', () => {
  test('a source that answered replaces its own entries', () => {
    const previous = [entry({ label: 'android/old', url: 'https://github.com/android/old' })]
    const fresh = [entry({ label: 'android/new', url: 'https://github.com/android/new' })]
    const merged = mergeBySource(previous, fresh, [note('github-search', true, 1)])
    assert.equal(merged.length, 1)
    assert.equal(merged[0]?.label, 'android/new')
  })

  test('a source that could not be reached keeps its entries', () => {
    const previous = [entry({ label: 'android/old', url: 'https://github.com/android/old' })]
    const fresh = [entry({ label: 'other/server', url: 'https://example.test/server', source: 'mcp-registry' })]
    const merged = mergeBySource(previous, fresh, [note('github-search', false), note('mcp-registry', true, 1)])
    assert.equal(merged.length, 2)
    const labels = merged.map((e) => e.label).sort()
    assert.deepEqual(labels, ['android/old', 'other/server'])
  })

  test('a source that did not run at all keeps its entries', () => {
    // The local-only run never asks the MCP registry, so the registry's last answer stands.
    const previous = [entry({ label: 'other/server', url: 'https://example.test/server', source: 'mcp-registry' })]
    const merged = mergeBySource(previous, [], [note('local-scan', true, 0), note('github-search', false)])
    assert.equal(merged.length, 1)
    assert.equal(merged[0]?.label, 'other/server')
  })

  test('a source that answered with nothing replaces its entries too', () => {
    // "Answered, and found nothing" is a real answer. Keeping the old entries would mean
    // the cache could never shrink, and a source that stopped publishing would keep its
    // entries forever.
    const previous = [entry({ label: 'android/old', url: 'https://github.com/android/old' })]
    const merged = mergeBySource(previous, [], [note('github-search', true, 0)])
    assert.equal(merged.length, 0)
  })

  test('the merge dedupes, so an entry found twice is one entry', () => {
    const previous = [entry()]
    const fresh = [entry()]
    const merged = mergeBySource(previous, fresh, [note('github-search', true, 1)])
    assert.equal(merged.length, 1)
  })
})

describe('unansweredSources', () => {
  test('names the sources that could not answer, once each', () => {
    const out = unansweredSources([
      note('github-search', false),
      note('github-search', false),
      note('mcp-registry', true),
      note('local-scan', true),
    ])
    assert.deepEqual(out, ['github-search'])
  })
})
