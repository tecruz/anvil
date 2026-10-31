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

    const shortlist = shortlistSuggestions([addLint, docs], { focus: 'lint' })

    assert.deepEqual(
      shortlist.map((s) => s.id),
      [docs.id],
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

  test('trust is labelled separately from the tier', () => {
    assert.equal(trustLabel('official-publisher'), 'official publisher')
    assert.equal(trustLabel('local-install'), 'installed locally')
    assert.equal(trustLabel('third-party'), 'third party')
  })
})
