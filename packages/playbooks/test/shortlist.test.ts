/**
 * The shortlist: the handful of resources a worktree is given, as opposed to the plan's
 * full catalogue.
 *
 * The behaviour worth pinning is relevance. A coverage ticket must not be handed a billing
 * migration guide because the guide has a high confidence, and an agent must not be handed
 * a repository fix as if it were optional reading.
 */
import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { DEFAULT_SHORTLIST_LIMIT, type Suggestion, shortlistSuggestions, trustLabel } from '@anvil/playbooks'

function resource(over: Partial<Suggestion> & Pick<Suggestion, 'id' | 'title'>): Suggestion {
  return {
    tier: 'official',
    detail: '',
    evidence: ['registry/playbooks/android.yaml'],
    confidence: 0.65,
    provenance: 'curated',
    playbook: 'android',
    // Something to read or consult, which is what the shortlist is for. A repository change
    // omits this; see the test below.
    external: true,
    ...over,
  }
}

const relevant = resource({
  id: 'live:android:testing-setup',
  title: 'skill: testing-setup',
  detail: 'Test strategy, unit tests, UI tests and coverage for Android applications.',
  install: 'C:/Users/dev/.agents/skills/testing-setup/SKILL.md',
  trust: 'local-install',
  provenance: 'live',
})

const unrelated = resource({
  id: 'live:android:billing',
  title: 'skill: play-billing-library-version-upgrade',
  detail: 'Upgrade the Play Billing Library and migrate deprecated purchase APIs.',
  confidence: 0.7,
  trust: 'official-publisher',
  url: 'https://developer.android.com/google/play/billing/migrate',
})

const docs = resource({
  id: 'official:android:https://developer.android.com/develop',
  title: 'doc: Android developer documentation',
  detail: 'The platform APIs, the build system and the lifecycle.',
  url: 'https://developer.android.com/develop',
  confidence: 0.75,
})

describe('shortlistSuggestions', () => {
  test('a resource that mentions the ticket beats an unrelated higher-confidence one', () => {
    const shortlist = shortlistSuggestions([unrelated, relevant], {
      focus: 'Raise combined JaCoCo line coverage with stronger unit and UI tests',
    })

    assert.equal(shortlist[0]?.id, relevant.id)
  })

  test('display kind prefixes do not contribute relevance', () => {
    for (const kind of ['skill', 'agent', 'style', 'migration', 'community']) {
      const distractor = resource({
        id: `distractor:${kind}`,
        title: `${kind}: unrelated/tool`,
        detail: 'A database reference.',
        confidence: 0.9,
      })
      const actual = resource({
        id: `actual:${kind}`,
        title: 'doc: Reference',
        detail: `Guidance about ${kind}.`,
        confidence: 0.3,
      })

      const shortlist = shortlistSuggestions([distractor, actual], { focus: kind, limit: 1 })

      assert.equal(shortlist[0]?.id, actual.id, `${kind}: is display metadata, not a topic`)
    }
  })

  test('focus words do not match substrings of unrelated words', () => {
    for (const [term, word] of [
      ['line', 'pipeline'],
      ['unit', 'community'],
      ['test', 'contest'],
    ] as const) {
      const distractor = resource({
        id: `distractor:${word}`,
        title: 'doc: Unrelated tool',
        detail: `A ${word} reference.`,
        confidence: 0.9,
      })
      const actual = resource({
        id: `actual:${term}`,
        title: 'doc: Reference',
        detail: `Guidance about ${term}.`,
        confidence: 0.3,
      })

      const shortlist = shortlistSuggestions([distractor, actual], { focus: term, limit: 1 })

      assert.equal(shortlist[0]?.id, actual.id, `${term} must not match ${word}`)
    }
  })

  test('case and compound separators do not hide relevant resource words', () => {
    const actual = resource({
      id: 'actual:testing',
      title: 'skill: team/testing-setup',
      detail: 'Tools for unit-tests and line_coverage.',
      confidence: 0.3,
    })

    for (const focus of ['TESTING setup', 'testing-setup', 'testing_setup', 'unit tests', 'line coverage']) {
      const shortlist = shortlistSuggestions([unrelated, actual], { focus, limit: 1 })

      assert.equal(shortlist[0]?.id, actual.id, focus)
    }
  })

  test('the detail bound does not turn a partial word into a match', () => {
    const distractor = resource({
      id: 'distractor:truncated',
      title: 'doc: Unrelated reference',
      detail: `${' '.repeat(996)}testimony`,
      confidence: 0.9,
    })
    const actual = resource({
      id: 'actual:test',
      title: 'doc: Reference',
      detail: 'A test reference.',
      confidence: 0.3,
    })

    const shortlist = shortlistSuggestions([distractor, actual], { focus: 'test', limit: 1 })

    assert.equal(shortlist[0]?.id, actual.id)
  })

  test('the CountryTracker coverage ticket prefers Android tests over CI pipeline triage', () => {
    const triage = resource({
      id: 'live:ci:triage',
      title: 'community: Vasishtha15/ai-cicd-failure-triage-agent',
      detail:
        'AI-powered GitHub Actions agent that analyses CI/CD pipeline failures (tests, lint, dependencies, Docker).',
      tier: 'community',
      confidence: 0.3,
      provenance: 'live',
    })
    const testing = resource({
      ...relevant,
      // The installed skill does not mention coverage: `unit` and `tests` are its real hits.
      detail:
        'Analyze and create a testing strategy for native Android apps with unit tests, UI tests and screenshot tests.',
    })

    const shortlist = shortlistSuggestions([triage, testing], {
      focus: 'Raise combined JaCoCo line coverage with stronger unit and UI tests',
      limit: 1,
    })

    assert.equal(shortlist[0]?.id, testing.id)
  })

  test('no focus still returns a small tier and confidence list', () => {
    const shortlist = shortlistSuggestions([unrelated, docs])

    assert.equal(shortlist[0]?.id, docs.id)
    assert.equal(shortlist.length, 2)
  })

  test('respects the default and explicit limits', () => {
    const many = Array.from({ length: 12 }, (_, index) =>
      resource({ id: `resource:${String(index)}`, title: `doc: Resource ${String(index)}` }),
    )

    assert.equal(shortlistSuggestions(many).length, DEFAULT_SHORTLIST_LIMIT)
    assert.equal(shortlistSuggestions(many, { limit: 2 }).length, 2)
    assert.equal(shortlistSuggestions(many, { limit: 0 }).length, 1)
  })

  test('a derived repository fix is not offered as reading', () => {
    const fix: Suggestion = {
      id: 'fix:TEST_FAST',
      tier: 'derived',
      rule: 'TEST_FAST',
      title: 'A changed-files test subset is documented',
      detail: 'Document a fast test command.',
      evidence: ['AGENTS.md:8'],
      confidence: 0.9,
      severity: 'low',
      provenance: 'curated',
    }

    const shortlist = shortlistSuggestions([fix, relevant], { focus: 'tests' })

    assert.deepEqual(
      shortlist.map((s) => s.id),
      [relevant.id],
    )
  })

  test('a repository change is not offered as reading', () => {
    // `verify:` and `risk:` suggestions carry a playbook but are work in this repository,
    // not a resource to read. Marked by the absence of `external`, they must not appear --
    // an agent handed "add a lint command" as an aid would treat a repo fix as optional.
    const addLint: Suggestion = {
      id: 'verify:android:lint',
      tier: 'official',
      playbook: 'android',
      title: 'Add a lint command for Android (Jetpack Compose)',
      detail: 'Android (Jetpack Compose) projects conventionally use: ./gradlew lint',
      evidence: ['registry/playbooks/android.yaml'],
      confidence: 0.7,
      provenance: 'curated',
    }

    const shortlist = shortlistSuggestions([addLint, docs], { focus: 'android documentation' })

    assert.deepEqual(
      shortlist.map((s) => s.id),
      [docs.id],
    )
  })

  test('a tailored list is not padded with resources that do not answer the focus', () => {
    // `addLint` matches the focus strongly. It is a repository change, so it is excluded --
    // and the list must not then fall back to `docs`, which answers none of it. A short
    // honest list beats a padded misleading one.
    const addLint: Suggestion = {
      id: 'verify:android:lint',
      tier: 'official',
      playbook: 'android',
      title: 'Add a lint command for Android (Jetpack Compose)',
      detail: 'Android (Jetpack Compose) projects conventionally use: ./gradlew lint',
      evidence: ['registry/playbooks/android.yaml'],
      confidence: 0.7,
      provenance: 'curated',
    }

    const shortlist = shortlistSuggestions([addLint, docs], { focus: 'lint' })

    assert.deepEqual(shortlist, [])
  })

  test('one common word in a description is not relevance', () => {
    // Apache Maka is a "high-performance agent workspace": it shares only `performance` with
    // a Compose performance ticket, and that must not put it on the list.
    const maka = resource({
      id: 'live:jvm:maka',
      title: 'agent: apache/maka',
      detail: 'Apache Maka (Incubating) is a high-performance agent workspace that keeps a complete record.',
      tier: 'official',
      confidence: 0.65,
      provenance: 'live',
    })
    const composeDocs = resource({
      id: 'official:android:compose',
      title: 'doc: Jetpack Compose documentation',
      detail: 'The official guide to the UI toolkit and recomposition.',
      confidence: 0.75,
    })

    const shortlist = shortlistSuggestions([maka, composeDocs], { focus: 'Improve Compose performance' })

    assert.deepEqual(
      shortlist.map((s) => s.id),
      [composeDocs.id],
    )
  })

  test('a focus word in the resource label is enough on its own', () => {
    const labelled = resource({
      id: 'official:android:compose',
      title: 'doc: Jetpack Compose documentation',
      detail: 'Everything else.',
      confidence: 0.3,
    })
    const distractor = resource({
      id: 'live:android:other',
      title: 'agent: some/other-tool',
      detail: 'Compose is mentioned here once.',
      confidence: 0.9,
      provenance: 'live',
    })

    const shortlist = shortlistSuggestions([distractor, labelled], { focus: 'Compose performance' })

    assert.equal(shortlist.filter((s) => s.id === labelled.id).length, 1)
    assert.ok(!shortlist.some((s) => s.id === distractor.id))
  })

  test('two distinct words in the text are enough without a label match', () => {
    const twoWords = resource({
      id: 'official:android:perf',
      title: 'doc: Reference guide',
      detail: 'Improve Compose performance by reading what triggers recomposition.',
      confidence: 0.7,
    })

    const shortlist = shortlistSuggestions([twoWords], { focus: 'Improve Compose performance' })

    assert.deepEqual(
      shortlist.map((s) => s.id),
      [twoWords.id],
    )
  })

  test('a one-word focus still matches on that one word', () => {
    // With a focus of one word there is nothing to corroborate it, so a single match counts.
    const camera = resource({
      id: 'live:android:camera',
      title: 'skill: camera1-to-camerax',
      detail: 'Migrate legacy camera implementations to CameraX.',
      provenance: 'live',
    })

    const shortlist = shortlistSuggestions([camera], { focus: 'camera' })

    assert.deepEqual(
      shortlist.map((s) => s.id),
      [camera.id],
    )
  })

  test('the same installed skill is listed once', () => {
    const duplicate = resource({
      id: 'live:android:other',
      title: 'skill: testing-setup',
      install: 'C:/Users/dev/.agents/skills/testing-setup/SKILL.md',
      provenance: 'live',
    })

    const shortlist = shortlistSuggestions([relevant, duplicate], { focus: 'tests' })

    assert.equal(shortlist.length, 1)
  })

  test('a keyword buried in a long live description does not outrank a relevant resource', () => {
    // A live entry's detail is the repository's own GitHub description, which can run to
    // tens of thousands of characters and mention a topic in passing. Only the head of the
    // text counts, so a match thousands of characters in is not relevance.
    const noise = resource({
      id: 'live:android:noise',
      title: 'community: noise/aggregator',
      detail: `${'filler '.repeat(1000)}coverage tests`,
      confidence: 0.9,
      provenance: 'live',
      url: 'https://github.com/noise/aggregator',
    })
    assert.ok(noise.detail.includes('coverage'), 'the noise description does contain the words')

    const shortlist = shortlistSuggestions([noise, relevant], { focus: 'coverage tests', limit: 1 })

    assert.deepEqual(
      shortlist.map((s) => s.id),
      [relevant.id],
    )
  })

  test('a detail match within the bound still counts', () => {
    // The bound must not disable detail matching entirely: a genuinely relevant description
    // is short, and its words still rank it.
    const shortDetail = resource({
      id: 'live:android:coverage',
      title: 'community: some/coverage-tool',
      detail: 'Measures coverage across unit tests.',
      confidence: 0.3,
      provenance: 'live',
      url: 'https://github.com/some/coverage-tool',
    })

    const shortlist = shortlistSuggestions([unrelated, shortDetail], { focus: 'coverage tests', limit: 1 })

    assert.equal(shortlist[0]?.id, shortDetail.id)
  })

  test('trust is labelled separately from the tier', () => {
    assert.equal(trustLabel('official-publisher'), 'official publisher')
    assert.equal(trustLabel('local-install'), 'installed locally')
    assert.equal(trustLabel('third-party'), 'third party')
  })
})

describe('short technology names survive the focus filter', () => {
  // A ticket titled "Fix Go TLS" is entirely three- and two-letter words. The four-character
  // floor dropped every one of them, the focus matched nothing, and the "tailored" list
  // degenerated into the unfocused tier/confidence list -- exactly the padding the shortlist
  // is for. A curated allowlist of short *technology* names keeps them without readmitting
  // English noise.
  const go = resource({
    id: 'go:effective',
    title: 'doc: Effective Go',
    detail: 'The conventions the Go project follows.',
    url: 'https://go.dev/doc/effective_go',
  })
  const ci = resource({
    id: 'ci:actions',
    title: 'doc: GitHub Actions documentation',
    detail: 'The workflow syntax and contexts.',
    url: 'https://docs.github.com/en/actions',
    confidence: 0.9,
  })

  test('a one-word Go focus keeps the Go resources and drops the rest', () => {
    const focused = shortlistSuggestions([ci, go], { focus: 'Go' })
    assert.deepEqual(
      focused.map((s) => s.id),
      ['go:effective'],
    )
    // And it is genuinely tailored, not the fallback list in disguise.
    assert.notDeepEqual(
      focused.map((s) => s.id),
      shortlistSuggestions([ci, go]).map((s) => s.id),
    )
  })

  test('.NET and PHP are recognised, not dropped', () => {
    const dotnet = resource({ id: 'dotnet', title: 'doc: .NET documentation', detail: 'API reference.' })
    const php = resource({ id: 'php', title: 'doc: PHP manual', detail: 'The language reference.' })
    assert.deepEqual(
      shortlistSuggestions([ci, dotnet], { focus: '.NET' }).map((s) => s.id),
      ['dotnet'],
    )
    assert.deepEqual(
      shortlistSuggestions([ci, php], { focus: 'PHP' }).map((s) => s.id),
      ['php'],
    )
  })

  test('a short non-technology word is still dropped', () => {
    // The allowlist is the point: `do`/`of`/`to` are two letters and must not become terms, or
    // the filter is meaningless. With only such words the focus is empty and the list falls
    // back, which is the honest answer.
    const a = resource({ id: 'a', title: 'doc: Alpha', detail: 'Of to do.' })
    assert.deepEqual(
      shortlistSuggestions([a], { focus: 'do to of' }).map((s) => s.id),
      ['a'],
    )
  })
})
