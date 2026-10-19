/**
 * Proposals and the run orchestration.
 *
 * The proposal test that matters most round-trips the generated YAML through this project's
 * own parser and validator. A proposal is a file a maintainer will paste into
 * `registry/playbooks/*.yaml`, so "it looks about right" is not a sufficient standard: it has
 * to survive the exact gate it will later be checked against. Emitting a duplicate key --
 * which is what one section per entry produced -- renders as a single entry out of eight and
 * fails that gate loudly, which is the right failure, but only if the test asks.
 */

import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, test } from 'node:test'
import {
  type DiscoveryEntry,
  dedupeEntries,
  discoverLocal,
  type FetchImpl,
  type GhRun,
  matchTerms,
  proposePlaybookYaml,
  rankForProposal,
  runDiscovery,
} from '@anvil/discovery'
import { type DiscoverSeeds, parseYamlSubset, validatePlaybook } from '@anvil/playbooks'

const ANDROID: DiscoverSeeds = {
  officialOrgs: ['android', 'google'],
  keywords: ['android agent skills', 'android cli'],
  mcp: ['android'],
}

const NOW = '2026-10-02T12:00:00.000Z'

function entry(over: Partial<DiscoveryEntry> = {}): DiscoveryEntry {
  return {
    label: 'android/skills',
    url: 'https://github.com/android/skills',
    why: 'Official agent skills published by the Android team for agent workflows.',
    tier: 'official',
    section: 'skills',
    source: 'github-search',
    fetchedAt: NOW,
    stars: 1200,
    install: null,
    repo: 'android/skills',
    owner: 'android',
    ...over,
  }
}

function tempHome(): string {
  return mkdtempSync(join(tmpdir(), 'anvil-run-'))
}

function writeSkill(home: string, root: string, dir: string, body: string): void {
  mkdirSync(join(home, root, dir), { recursive: true })
  writeFileSync(join(home, root, dir, 'SKILL.md'), body, 'utf8')
}

describe('matchTerms', () => {
  test('includes the playbook id and the head of each keyword', () => {
    const terms = matchTerms('android', ANDROID)
    assert.ok(terms.includes('android'))
    assert.ok(terms.includes('jetpack') === false, 'not seeded, so not a term')
  })

  test('splits a hyphenated id so both halves match', () => {
    const terms = matchTerms('play-billing', { officialOrgs: [], keywords: [], mcp: [] })
    assert.ok(terms.includes('play-billing'))
    assert.ok(terms.includes('billing'))
  })

  test('takes the leading word of a multi-word keyword', () => {
    // "android agent skills" must match a skill described as "Skills for Android
    // development", so the head is the term rather than the whole phrase.
    assert.ok(
      matchTerms('node', { officialOrgs: [], keywords: ['typescript agent skills'], mcp: [] }).includes('typescript'),
    )
  })
})

describe('discoverLocal', () => {
  test('finds installed skills for the technology, with the path as the evidence', () => {
    const h = tempHome()
    try {
      writeSkill(
        h,
        join('.agents', 'skills'),
        'navigation-3',
        '---\nname: navigation-3\ndescription: Learn Jetpack Navigation 3 for Android.\n---\n',
      )
      const { entries, note } = discoverLocal('android', ANDROID, {
        env: { ANVIL_CONFIG_HOME: h } as NodeJS.ProcessEnv,
      })
      assert.equal(entries.length, 1)
      const one = entries[0]
      assert.equal(one?.label, 'navigation-3')
      assert.equal(one?.section, 'skills')
      assert.equal(one?.source, 'local-scan')
      assert.match(one?.why ?? '', /proves it is installed, not who maintains it/)
      assert.match(one?.install ?? '', /navigation-3/)
      assert.equal(one?.url, '', 'a local skill has no url, so none is invented')
      assert.match(note.detail, /1 for this technology/)
    } finally {
      rmSync(h, { recursive: true, force: true })
    }
  })

  test('collapses one skill installed in several directories, and says how many', () => {
    // The defect this pins: keying on the install path reported `navigation-3` three times on
    // a machine where it is installed under `.agents`, `.claude` and opencode. The count of
    // copies is reported because three copies that can drift is itself worth knowing.
    const h = tempHome()
    try {
      const body = '---\nname: styles\ndescription: Material 3 styling guidance for Android.\n---\n'
      writeSkill(h, join('.agents', 'skills'), 'styles', body)
      writeSkill(h, join('.claude', 'skills'), 'styles', body)
      writeSkill(h, join('.config', 'opencode', 'skills'), 'styles', body)
      const { entries } = discoverLocal('android', ANDROID, { env: { ANVIL_CONFIG_HOME: h } as NodeJS.ProcessEnv })
      assert.equal(entries.length, 1)
      assert.match(entries[0]?.why ?? '', /2 other location\(s\)/)
    } finally {
      rmSync(h, { recursive: true, force: true })
    }
  })

  test('reports when nothing is installed for the technology', () => {
    const h = tempHome()
    try {
      const { entries, note } = discoverLocal('android', ANDROID, {
        env: { ANVIL_CONFIG_HOME: h } as NodeJS.ProcessEnv,
      })
      assert.deepEqual(entries, [])
      assert.match(note.detail, /none for this technology/)
    } finally {
      rmSync(h, { recursive: true, force: true })
    }
  })
})

describe('dedupeEntries', () => {
  test('collapses one repository found by two queries', () => {
    const out = dedupeEntries([entry(), entry({ tier: 'community', section: 'community' })])
    assert.equal(out.length, 1)
    assert.equal(out[0]?.tier, 'official', 'official wins community')
  })

  test('collapses one local skill found under two roots', () => {
    const out = dedupeEntries([
      entry({ url: '', source: 'local-scan', repo: null, install: '/home/u/.agents/skills/x/SKILL.md' }),
      entry({ url: '', source: 'local-scan', repo: null, install: '/home/u/.claude/skills/x/SKILL.md' }),
    ])
    assert.equal(out.length, 1, 'keyed by name, not by install path')
  })

  test('keeps a trailing-slash variant from becoming a second entry', () => {
    const out = dedupeEntries([entry({ url: 'https://github.com/a/b' }), entry({ url: 'https://github.com/a/b/' })])
    assert.equal(out.length, 1)
  })

  test('prefers the record that has a star count', () => {
    const out = dedupeEntries([entry({ stars: null }), entry({ stars: 10 })])
    assert.equal(out[0]?.stars, 10)
  })
})

describe('rankForProposal', () => {
  test('official entries come before community ones', () => {
    const ranked = rankForProposal([
      entry({ tier: 'community', label: 'z/one' }),
      entry({ tier: 'official', label: 'a/two' }),
    ])
    assert.equal(ranked[0]?.tier, 'official')
  })

  test('sorts by stars within a tier, then by label so the output is stable', () => {
    const ranked = rankForProposal([
      entry({ label: 'b/low', stars: 5 }),
      entry({ label: 'a/high', stars: 5000 }),
      entry({ label: 'c/mid', stars: 500 }),
    ])
    assert.deepEqual(
      ranked.map((r) => r.label),
      ['a/high', 'c/mid', 'b/low'],
    )
  })
})

describe('proposePlaybookYaml', () => {
  const playbook = {
    id: 'android',
    title: 'Android (Jetpack Compose)',
    official: {
      docs: [{ label: 'Compose docs', url: 'https://developer.android.com/develop/ui/compose', why: 'x' }],
      skills: [],
      agents: [],
      mcp: [],
      styleGuides: [],
      migrationGuides: [],
    },
    community: [
      {
        repo: 'android/nowinandroid',
        label: 'Now in Android',
        url: 'https://github.com/android/nowinandroid',
        why: 'x',
        stars: null,
      },
    ],
  }

  test("the generated YAML parses with this project's own parser", () => {
    const { yaml } = proposePlaybookYaml(playbook, [entry()])
    // Not a smoke test: the proposal is a file that gets pasted into the registry, so it has
    // to survive the same subset parser and the same validator `npm run gen:playbooks` runs.
    assert.doesNotThrow(() => parseYamlSubset(yaml), yaml)
  })

  test('the generated entries validate as a playbook document', () => {
    const { yaml } = proposePlaybookYaml(playbook, [entry()])
    const { issues } = validatePlaybook(
      parseYamlSubset(
        `id: android\ntitle: Android\nmatch:\n  files: ['a']\n${yaml
          .split('\n')
          .filter((l) => !l.startsWith('#') && l !== '')
          .join('\n')}`,
      ),
    )
    const relevant = issues.filter((i) => !i.path.startsWith('match') && i.message !== 'required')
    assert.deepEqual(relevant, [], JSON.stringify(relevant))
  })

  test('a section key appears once, not once per entry', () => {
    // The duplicate-key defect: emitting `skills:` for each entry renders as the last entry
    // winning in most YAML readers, and as a hard error in this project's parser.
    const { yaml } = proposePlaybookYaml(playbook, [
      entry({ label: 'android/one', url: 'https://github.com/android/one' }),
      entry({ label: 'android/two', url: 'https://github.com/android/two' }),
    ])
    const skillKeys = yaml.split('\n').filter((l) => l.trim() === 'skills:')
    assert.equal(skillKeys.length, 1, yaml)
  })

  test('an entry the playbook already cites is not proposed again', () => {
    // A patch that re-adds a line already in the file is how a maintainer learns to
    // distrust the output.
    const { yaml, entries, duplicates } = proposePlaybookYaml(playbook, [
      entry({ url: 'https://developer.android.com/develop/ui/compose' }),
      entry({ url: 'https://github.com/android/nowinandroid' }),
    ])
    assert.deepEqual(entries, [])
    assert.equal(duplicates, 2)
    assert.match(yaml, /Nothing to add/)
  })

  test('a community entry is emitted as a list item with its repo, not as an official one', () => {
    const { yaml } = proposePlaybookYaml(playbook, [
      entry({
        tier: 'community',
        section: 'community',
        repo: 'someone/skills',
        url: 'https://github.com/someone/skills',
      }),
    ])
    assert.match(yaml, /^community:$/m)
    assert.match(yaml, /repo: 'someone\/skills'/)
    assert.doesNotMatch(yaml, /^official:$/m)
  })

  test('the discovery evidence is a comment, not a field the schema would reject', () => {
    const { yaml } = proposePlaybookYaml(playbook, [entry()])
    assert.match(yaml, /# github-search, fetched 2026-10-02T12:00:00.000Z, tier official/)
    assert.doesNotThrow(() => parseYamlSubset(yaml))
  })

  test('an entry with no url is dropped rather than rendered as an empty link', () => {
    // `check` rejects a resource without a url as an error, so emitting one hands the
    // maintainer a patch that fails their own gate.
    const { entries, duplicates } = proposePlaybookYaml(playbook, [
      entry({ url: '', source: 'local-scan', repo: null, install: '/home/u/skill' }),
    ])
    assert.deepEqual(entries, [])
    assert.equal(duplicates, 1)
  })

  test('a label containing a quote round-trips through the parser', () => {
    // Asserted on the parsed value rather than the rendered text: `owner''s` is the correct
    // YAML escaping of `owner's`, so a substring match on the raw output would be asserting
    // the wrong thing. What matters is that reading it back gives the original label.
    const { yaml } = proposePlaybookYaml(playbook, [
      entry({ label: "owner's repo", url: 'https://github.com/o/r', repo: 'o/r' }),
    ])
    const parsed = parseYamlSubset(
      `id: android\ntitle: Android\nmatch:\n  files: ['a']\n${yaml
        .split('\n')
        .filter((l) => !l.startsWith('#') && l !== '')
        .join('\n')}`,
    )
    const official = (parsed as { official: { skills: Array<{ label: string; url: string }> } }).official
    assert.equal(official.skills[0]?.label, "owner's repo")
    assert.equal(official.skills[0]?.url, 'https://github.com/o/r')
  })
})

describe('runDiscovery', () => {
  const ghFail: GhRun = async () => ({ stdout: '', stderr: 'not installed', exitCode: 127 })
  const fetchFail: FetchImpl = async () => {
    throw new Error('offline')
  }

  test('local-only runs the scan and touches no network', async () => {
    const h = tempHome()
    try {
      writeSkill(h, join('.agents', 'skills'), 'nav', '---\nname: nav\ndescription: Android navigation.\n---\n')
      let touchedNetwork = false
      const result = await runDiscovery(
        { id: 'android', discover: ANDROID },
        {
          cwd: '.',
          localOnly: true,
          env: { ANVIL_CONFIG_HOME: h } as NodeJS.ProcessEnv,
          fetchImpl: fetchFail,
          gh: async () => {
            touchedNetwork = true
            return { stdout: '{}', stderr: '', exitCode: 0 }
          },
        },
      )
      assert.equal(touchedNetwork, false)
      assert.equal(result.entries.length, 1)
      assert.match(result.sources[0]?.detail ?? '', /1 for this technology/)
      assert.match(result.sources[1]?.detail ?? '', /--local-only or offline/)
    } finally {
      rmSync(h, { recursive: true, force: true })
    }
  })

  test('local-only dedupes, which the early return used to skip', async () => {
    // The bug: the local-only path returned raw entries while the full path deduped, so the
    // same machine gave two different answers depending on a flag.
    const h = tempHome()
    try {
      const body = '---\nname: styles\ndescription: Android styling.\n---\n'
      writeSkill(h, join('.agents', 'skills'), 'styles', body)
      writeSkill(h, join('.claude', 'skills'), 'styles', body)
      const result = await runDiscovery(
        { id: 'android', discover: ANDROID },
        {
          cwd: '.',
          localOnly: true,
          env: { ANVIL_CONFIG_HOME: h } as NodeJS.ProcessEnv,
          fetchImpl: fetchFail,
          gh: ghFail,
        },
      )
      assert.equal(result.entries.length, 1)
    } finally {
      rmSync(h, { recursive: true, force: true })
    }
  })

  test('a local-scan entry survives alongside a failed network run', async () => {
    const h = tempHome()
    try {
      writeSkill(h, join('.agents', 'skills'), 'nav', '---\nname: nav\ndescription: Android navigation.\n---\n')
      const result = await runDiscovery(
        { id: 'android', discover: ANDROID },
        { cwd: '.', env: { ANVIL_CONFIG_HOME: h } as NodeJS.ProcessEnv, fetchImpl: fetchFail, gh: ghFail },
      )
      assert.equal(result.entries.length, 1, "one source failing must not remove another source's results")
      assert.ok(result.warnings.some((w) => /no transport/.test(w)))
    } finally {
      rmSync(h, { recursive: true, force: true })
    }
  })

  test('a registry server published by a seeded org is official, and an endpoint is not', async () => {
    // The registry publishes one URL per server: sometimes a repository, sometimes a running
    // endpoint. Only the first can be checked against the seeded orgs, and the difference is
    // the difference between first-party guidance and a stranger's server.
    const registry: FetchImpl = async () => ({
      status: 200,
      text: async () =>
        JSON.stringify({
          servers: [
            { name: 'android-mcp', url: 'https://github.com/android/android-mcp', description: 'By Android.' },
            { name: 'third-party-mcp', url: 'https://example.test/mcp', description: 'By someone.' },
          ],
        }),
    })
    const h = tempHome()
    try {
      const result = await runDiscovery(
        { id: 'android', discover: ANDROID },
        { cwd: '.', env: { ANVIL_CONFIG_HOME: h } as NodeJS.ProcessEnv, fetchImpl: registry, gh: ghFail },
      )
      const first = result.entries.find((e) => e.label === 'android-mcp')
      const second = result.entries.find((e) => e.label === 'third-party-mcp')
      assert.ok(first !== undefined)
      assert.ok(second !== undefined)
      assert.equal(first.tier, 'official')
      assert.equal(first.section, 'mcp')
      assert.equal(first.owner, 'android')
      assert.equal(first.repo, 'android/android-mcp')
      assert.match(first.why, /one of this playbook's official orgs/)
      assert.equal(second.tier, 'community')
      assert.equal(second.owner, null)
    } finally {
      rmSync(h, { recursive: true, force: true })
    }
  })
})
