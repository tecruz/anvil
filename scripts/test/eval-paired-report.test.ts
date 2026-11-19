import assert from 'node:assert/strict'
import { describe, test } from 'node:test'

import type { EvalModel, EvalScenario } from '../../packages/cli/src/eval-gate.ts'
import {
  buildPreflight,
  classifyPairedResult,
  formatPairedSummary,
  formatPreflight,
  type ScenarioResult,
  summarizePairs,
  taskSucceeded,
} from '../eval.ts'

function result(overrides: Partial<ScenarioResult> & Pick<ScenarioResult, 'variant'>): ScenarioResult {
  return {
    scenario: 'demo',
    size: 'tiny',
    kind: 'code-change',
    model: 'model',
    modelRole: 'small',
    opencodeVersion: null,
    scenarioHash: 'scenario-hash',
    sourceHash: 'source-hash',
    verifyCount: 1,
    hiddenVerifyCount: 1,
    verified: true,
    hiddenVerified: true,
    verifyExitCodes: [0, 0],
    repetition: 0,
    costUsd: null,
    tokens: null,
    durationMs: 1000,
    transcript: '',
    ...overrides,
  }
}

describe('paired comparison', () => {
  test('counts paired task success and averages only both-successful pairs', () => {
    const summary = summarizePairs([
      result({ variant: 'bare', durationMs: 10_000, costUsd: 0.1 }),
      result({ variant: 'anvil', durationMs: 6_000, costUsd: 0.06 }),
      result({ variant: 'bare', repetition: 1, error: 'the agent timed out', durationMs: 2_000 }),
      result({ variant: 'anvil', repetition: 1, durationMs: 4_000, costUsd: 0.04 }),
    ])

    assert.deepEqual(summary.totals, {
      pairs: 2,
      incomplete: 0,
      bothSucceeded: 1,
      onlyAnvil: 1,
      onlyBare: 0,
      neither: 0,
      runErrors: { bare: 1, anvil: 0 },
      errorPairs: { pairs: 1, onlyAnvil: 1, onlyBare: 0 },
      successfulDurationMs: { bare: 10_000, anvil: 6_000, pairs: 1, untimed: 0 },
      successfulCostUsd: { bare: 0.1, anvil: 0.06, pairs: 1, unpriced: 0 },
    })
  })

  test('a run error is not a successful pair, even when its verifier passed', () => {
    const summary = summarizePairs([
      result({ variant: 'bare', verified: true, error: 'the agent exited with code 1' }),
      result({ variant: 'anvil', verified: true }),
    ])

    assert.equal(summary.totals.onlyAnvil, 1)
    assert.equal(summary.totals.bothSucceeded, 0)
    assert.equal(summary.totals.runErrors.bare, 1)
    assert.equal(summary.totals.successfulDurationMs.pairs, 0)
  })

  test('a task failure with no run error stays in the scored verdict', () => {
    const failed = result({ variant: 'bare', verified: false, taskFailureReason: 'the agent did not run the check' })
    const summary = summarizePairs([failed, result({ variant: 'anvil' })])

    assert.equal(taskSucceeded(failed), false)
    assert.equal(summary.totals.pairs, 1)
    assert.equal(summary.totals.errorPairs.pairs, 0, 'a functioning harness did not fail the run')
    assert.equal(summary.totals.runErrors.bare, 0)
    assert.equal(summary.totals.onlyAnvil, 1)
  })

  test('a setup failure is reported as a run error, not as an agent failure', () => {
    const summary = summarizePairs([
      result({ variant: 'bare' }),
      result({
        variant: 'anvil',
        skillInstall: 'failed',
        skillAccess: 'not-installed',
        error: 'skill installation failed: missing source',
      }),
    ])

    assert.equal(summary.totals.runErrors.anvil, 1)
    const text = formatPairedSummary(summary).join('\n')
    assert.match(text, /run errors\s+bare 0, anvil 1/)
    assert.match(text, /harness setup failures, such as a failed skill installation/)
    assert.doesNotMatch(text, /agent failures/)
  })

  test('a missing counterpart is incomplete rather than a zero', () => {
    const summary = summarizePairs([result({ variant: 'bare' })])

    assert.equal(summary.totals.pairs, 0)
    assert.equal(summary.totals.incomplete, 1)
    assert.equal(summary.totals.neither, 0)
    assert.match(formatPairedSummary(summary).join('\n'), /0 complete, 1 incomplete/)
  })

  test('a successful pair without a ledger price keeps cost unknown', () => {
    const summary = summarizePairs([
      result({ variant: 'bare', costUsd: null }),
      result({ variant: 'anvil', costUsd: 0.02 }),
    ])

    assert.equal(summary.totals.successfulCostUsd.pairs, 0)
    assert.equal(summary.totals.successfulCostUsd.unpriced, 1)
    assert.equal(summary.totals.successfulCostUsd.bare, null)
    assert.equal(summary.totals.successfulCostUsd.anvil, null)
    assert.match(formatPairedSummary(summary).join('\n'), /unknown \(1 successful pair without a ledger price\)/)
  })

  test('aggregates installation and access facts for a skill comparison', () => {
    const summary = summarizePairs([
      result({ variant: 'bare', repetition: 0, skillInstall: 'not-installed', skillAccess: 'not-installed' }),
      result({ variant: 'anvil', repetition: 0, skillInstall: 'verified', skillAccess: 'observed' }),
      result({ variant: 'bare', repetition: 1, skillInstall: 'not-installed', skillAccess: 'not-installed' }),
      result({ variant: 'anvil', repetition: 1, skillInstall: 'verified', skillAccess: 'unknown' }),
    ])

    assert.deepEqual(summary.groups[0]?.skill, {
      installed: 2,
      installFailed: 0,
      installUnrecorded: 0,
      access: { observed: 1, notObserved: 0, unknown: 1 },
    })
    assert.match(formatPairedSummary(summary).join('\n'), /installed 2.*access observed 1.*unknown 1/)
  })

  test('each comparison is labelled by its own pair count, not the run total', () => {
    const small = summarizePairs([result({ variant: 'bare' }), result({ variant: 'anvil' })])
    assert.match(
      formatPairedSummary(small).join('\n'),
      /verdict\s+insufficient evidence: 1 usable pair is below the 5 needed to call a direction/,
    )

    // Six scenarios with one repetition each are six one-pair measurements. Summing them
    // into "six pairs" must not make the warning disappear.
    const oneEach = summarizePairs(
      ['a', 'b', 'c', 'd', 'e', 'f'].flatMap((scenario) => [
        result({ scenario, variant: 'bare' }),
        result({ scenario, variant: 'anvil' }),
      ]),
    )
    assert.equal(oneEach.totals.pairs, 6)
    const oneEachText = formatPairedSummary(oneEach).join('\n')
    assert.equal(
      (oneEachText.match(/insufficient evidence: 1 usable pair is below the 5/g) ?? []).length,
      6,
      'each group keeps its own verdict',
    )

    const large = summarizePairs(
      Array.from({ length: 5 }, (_, repetition) => [
        result({ variant: 'bare', repetition }),
        result({ variant: 'anvil', repetition }),
      ]).flat(),
    )
    assert.equal(large.totals.pairs, 5)
    const largeText = formatPairedSummary(large).join('\n')
    assert.match(largeText, /insufficient evidence: neither variant uniquely succeeded in any of 5 usable pairs/)
    assert.doesNotMatch(largeText, /is below the 5 needed/)
  })

  /** `total` repetitions of one scenario/model: `anvil` anvil-only wins, `bare` bare-only wins, the rest both succeed. */
  const split = (anvil: number, bare: number, total: number, extra: Partial<ScenarioResult> = {}) =>
    Array.from({ length: total }, (_, repetition) => {
      const winner: 'anvil' | 'bare' | null = repetition < anvil ? 'anvil' : repetition < anvil + bare ? 'bare' : null
      return [
        result({ ...extra, variant: 'bare', repetition, verified: winner !== 'anvil' }),
        result({ ...extra, variant: 'anvil', repetition, verified: winner !== 'bare' }),
      ]
    }).flat()
  const verdictOf = (anvil: number, bare: number, total: number) =>
    classifyPairedResult(summarizePairs(split(anvil, bare, total)).totals).verdict

  test('a direction needs five usable pairs, three one-sided wins and a margin of two', () => {
    const improvement = summarizePairs(split(3, 0, 5))
    assert.deepEqual(classifyPairedResult(improvement.totals), {
      verdict: 'measured-improvement',
      reason: 'anvil succeeded where bare did not in 3 pairs; the reverse happened in 0',
    })
    assert.match(formatPairedSummary(improvement).join('\n'), /verdict\s+measured improvement:/)

    const regression = summarizePairs(split(0, 3, 5))
    assert.equal(classifyPairedResult(regression.totals).verdict, 'measured-regression')
    assert.match(formatPairedSummary(regression).join('\n'), /verdict\s+measured regression:/)

    // The boundary, one step on each side of every threshold.
    const table: Array<[number, number, number, string]> = [
      [3, 0, 4, 'insufficient-evidence'], // four usable pairs
      [3, 0, 5, 'measured-improvement'], // exactly five, three one-sided, margin three
      [3, 1, 5, 'measured-improvement'], // margin exactly two
      [3, 2, 5, 'insufficient-evidence'], // mixed wins, margin one
      [2, 3, 5, 'insufficient-evidence'], // mixed wins the other way
      [2, 2, 5, 'insufficient-evidence'], // nonzero tie
      [2, 0, 5, 'insufficient-evidence'], // margin two but only two one-sided wins
      [1, 0, 5, 'insufficient-evidence'], // one differing pair calls nothing
      [1, 3, 5, 'measured-regression'], // regression with margin exactly two
      [4, 2, 6, 'measured-improvement'],
      [4, 3, 7, 'insufficient-evidence'],
    ]
    for (const [anvil, bare, total, expected] of table) {
      assert.equal(verdictOf(anvil, bare, total), expected, `${anvil}-${bare} of ${total}`)
    }
    assert.match(
      classifyPairedResult(summarizePairs(split(3, 2, 5)).totals).reason,
      /anvil only 3, bare only 2: a direction needs at least 3 one-sided pairs and a margin of 2/,
    )
    assert.match(
      classifyPairedResult(summarizePairs(split(2, 2, 5)).totals).reason,
      /2 pairs went each way; the pairs do not separate the variants/,
    )
  })

  test('pairs with a run error are excluded from the verdict and counted', () => {
    // Five pairs where anvil's skill installation failed: a harness failure, not a regression.
    const harness = summarizePairs(
      Array.from({ length: 5 }, (_, repetition) => [
        result({ variant: 'bare', repetition }),
        result({
          variant: 'anvil',
          repetition,
          verified: false,
          skillInstall: 'failed',
          error: 'skill installation failed: missing source',
        }),
      ]).flat(),
    )
    assert.deepEqual(harness.totals.errorPairs, { pairs: 5, onlyAnvil: 0, onlyBare: 5 })
    assert.deepEqual(classifyPairedResult(harness.totals), {
      verdict: 'insufficient-evidence',
      reason: 'no usable pair to compare (0 incomplete, 5 with a run error)',
    })
    assert.match(formatPairedSummary(harness).join('\n'), /5 complete, 0 incomplete, 5 with a run error \(excluded/)

    // Three clean anvil wins plus two errored bare-only pairs: the errored pairs must neither
    // count as usable nor dilute the margin.
    const mixed = summarizePairs([
      ...split(3, 0, 5),
      ...[5, 6].flatMap((repetition) => [
        result({ variant: 'bare', repetition }),
        result({ variant: 'anvil', repetition, verified: false, error: 'the agent timed out' }),
      ]),
    ])
    assert.deepEqual(classifyPairedResult(mixed.totals), {
      verdict: 'measured-improvement',
      reason:
        'anvil succeeded where bare did not in 3 pairs; the reverse happened in 0; 2 pairs with a run error excluded',
    })

    // Four clean pairs and one errored pair is below the minimum, not five.
    const short = summarizePairs([
      ...split(3, 0, 4),
      result({ variant: 'bare', repetition: 4 }),
      result({ variant: 'anvil', repetition: 4, error: 'the agent exited with code 1' }),
    ])
    assert.match(classifyPairedResult(short.totals).reason, /^4 usable pairs is below the 5 needed/)
  })

  test('incomplete and zero-pair groups never get a direction', () => {
    const none = summarizePairs([result({ variant: 'anvil' })])
    assert.deepEqual(classifyPairedResult(none.totals), {
      verdict: 'insufficient-evidence',
      reason: 'no usable pair to compare (1 incomplete, 0 with a run error)',
    })
    // Four complete anvil wins and three incomplete anvil-only repetitions: incomplete pairs
    // do not reach the five-pair minimum.
    const partial = summarizePairs([
      ...split(4, 0, 4),
      ...[10, 11, 12].map((repetition) => result({ variant: 'anvil', repetition })),
    ])
    assert.equal(partial.totals.incomplete, 3)
    assert.equal(classifyPairedResult(partial.totals).verdict, 'insufficient-evidence')
    assert.match(classifyPairedResult(partial.totals).reason, /^4 usable pairs is below the 5 needed/)
  })

  test('totals are descriptive: groups are never pooled into an overall verdict', () => {
    // Six scenarios with one anvil-only win between them: pooled, that is five usable pairs.
    const pooled = summarizePairs(
      ['a', 'b', 'c', 'd', 'e', 'f'].flatMap((scenario, index) => [
        result({ scenario, variant: 'bare', verified: index !== 0 }),
        result({ scenario, variant: 'anvil' }),
      ]),
    )
    const text = formatPairedSummary(pooled).join('\n')
    assert.doesNotMatch(text, /Verdict \(all repetitions\)/)
    assert.doesNotMatch(text, /measured improvement/)
    assert.match(text, /These totals are descriptive\. There is no overall verdict/)

    // Two groups with different verdicts each keep their own.
    const differing = summarizePairs([
      ...split(3, 0, 5, { scenario: 'improves' }),
      ...split(0, 3, 5, { scenario: 'regresses' }),
    ])
    const differingText = formatPairedSummary(differing).join('\n')
    const verdictLines = differingText.split('\n').filter((line) => /^\s+verdict\s/.test(line))
    assert.equal(verdictLines.length, 2)
    assert.match(verdictLines[0]!, /measured improvement/)
    assert.match(verdictLines[1]!, /measured regression/)
    assert.doesNotMatch(differingText, /insufficient evidence/)
  })

  test('synthetic fake-agent checks are never presented as real-agent evidence', () => {
    const synthetic = summarizePairs([
      result({ variant: 'bare', model: 'fake-agent', modelRole: null }),
      result({ variant: 'anvil', model: 'fake-agent', modelRole: null }),
    ])
    const syntheticText = formatPairedSummary(synthetic).join('\n')
    assert.match(syntheticText, /Evidence source: synthetic harness check \(fake-agent\)/)
    assert.match(syntheticText, /This is not real-agent evidence/)
    assert.match(syntheticText, /evidence\s+synthetic fake-agent check/)
    assert.doesNotMatch(syntheticText, /real-agent record/)

    const real = summarizePairs([result({ variant: 'bare' }), result({ variant: 'anvil' })])
    const realText = formatPairedSummary(real).join('\n')
    assert.match(realText, /Evidence source: real-agent results/)
    assert.match(realText, /evidence\s+real-agent record/)
    assert.doesNotMatch(realText, /synthetic/)

    const unknown = summarizePairs([
      result({ variant: 'bare', model: null }),
      result({ variant: 'anvil', model: null }),
    ])
    const unknownText = formatPairedSummary(unknown).join('\n')
    assert.match(unknownText, /Evidence source: unknown; no model was recorded/)
    assert.match(unknownText, /evidence\s+unknown source \(no model recorded\); not real-agent evidence/)
    assert.doesNotMatch(unknownText, /real-agent results|real-agent record/)

    const mixed = summarizePairs([
      result({ variant: 'bare', scenario: 'synthetic', model: 'fake-agent' }),
      result({ variant: 'anvil', scenario: 'synthetic', model: 'fake-agent' }),
      result({ variant: 'bare', scenario: 'real' }),
      result({ variant: 'anvil', scenario: 'real' }),
      result({ variant: 'bare', scenario: 'unrecorded', model: null }),
      result({ variant: 'anvil', scenario: 'unrecorded', model: null }),
    ])
    const mixedText = formatPairedSummary(mixed).join('\n')
    assert.match(mixedText, /Evidence source: mixed \(1 synthetic, 1 real-agent, 1 unknown group\(s\)\)/)
    // Each group keeps its own label: `real` sorts first, then `synthetic`, then `unrecorded`.
    const labels = mixedText.split('\n').filter((line) => /^\s+evidence\s/.test(line))
    assert.deepEqual(
      labels.map((line) => line.trim().replace(/^evidence\s+/, '')),
      [
        'real-agent record',
        'synthetic fake-agent check',
        'unknown source (no model recorded); not real-agent evidence',
      ],
    )
  })

  test('a verdict does not turn unknown cost or duration into a measured value', () => {
    const summary = summarizePairs(
      Array.from({ length: 5 }, (_, repetition) => [
        result({ variant: 'bare', repetition, costUsd: null, durationMs: null }),
        result({ variant: 'anvil', repetition, costUsd: null, durationMs: repetition === 0 ? 1000 : null }),
      ]).flat(),
    )
    const text = formatPairedSummary(summary).join('\n')
    assert.equal(summary.totals.successfulCostUsd.bare, null)
    assert.equal(summary.totals.successfulCostUsd.anvil, null)
    assert.deepEqual(summary.totals.successfulDurationMs, { bare: null, anvil: null, pairs: 0, untimed: 5 })
    assert.match(text, /successful cost\s+unknown/)
    assert.match(text, /successful time\s+unknown \(5 successful pairs without a recorded duration\)/)
    assert.match(text, /Unknown cost or duration stays unknown rather than becoming zero/)
  })
})

describe('task success', () => {
  test('requires the hidden verifier when the scenario declares one', () => {
    assert.equal(taskSucceeded(result({ variant: 'bare', hiddenVerified: false })), false)
    assert.equal(taskSucceeded(result({ variant: 'bare', hiddenVerified: true })), true)
  })

  test('does not require a hidden verdict when there is no hidden verifier', () => {
    assert.equal(taskSucceeded(result({ variant: 'bare', hiddenVerifyCount: 0, hiddenVerified: null })), true)
  })

  test('an agent error vetoes success', () => {
    assert.equal(taskSucceeded(result({ variant: 'bare', error: 'the agent timed out' })), false)
  })
})

describe('preflight', () => {
  const scenarios = [
    { id: 'tiny-code-change', timeoutMinutes: 5 },
    { id: 'skill-guidance', timeoutMinutes: 10 },
  ] satisfies Pick<EvalScenario, 'id' | 'timeoutMinutes'>[]
  const models = [{ id: 'model-a' }, { id: 'model-b' }] satisfies Pick<EvalModel, 'id'>[]

  test('counts agent invocations and sums the per-run timeouts of planned work', () => {
    const planned = [
      ...Array.from({ length: 4 }, () => scenarios[0]!),
      ...Array.from({ length: 2 }, () => scenarios[1]!),
    ]
    const preflight = buildPreflight({
      scenarios,
      models,
      repetitions: 3,
      declaredInvocations: 24,
      planned,
      fakeAgent: false,
    })

    assert.equal(preflight.plannedInvocations, 6)
    assert.equal(preflight.declaredInvocations, 24)
    assert.equal(preflight.agentTimeCeilingMinutes, 4 * 5 + 2 * 10)
    const text = formatPreflight(preflight).join('\n')
    assert.match(text, /agent runs\s+6 of 24 \(remaining after resume\)/)
    assert.match(text, /40 min if every planned run hits its own timeout/)
    assert.match(text, /cost\s+unknown.*never estimated here/)
  })

  test('a hermetic fake-agent run calls no model and has no agent-time ceiling', () => {
    const preflight = buildPreflight({
      scenarios,
      models,
      repetitions: 1,
      declaredInvocations: 8,
      planned: [...Array.from({ length: 4 }, () => scenarios[0]!), ...Array.from({ length: 4 }, () => scenarios[1]!)],
      fakeAgent: true,
    })

    assert.equal(preflight.agentTimeCeilingMinutes, 0)
    const text = formatPreflight(preflight).join('\n')
    assert.match(text, /no model is called and no tokens are spent/)
    assert.doesNotMatch(text, /time bound/)
  })

  test('a worst case at or above the scheduled workflow ceiling says to split the run', () => {
    const atCeiling = buildPreflight({
      scenarios: [{ id: 'skill-guidance', timeoutMinutes: 10 }],
      models: [{ id: 'model-a' }],
      repetitions: 3,
      declaredInvocations: 6,
      planned: Array.from({ length: 6 }, () => ({ id: 'skill-guidance', timeoutMinutes: 10 })),
      fakeAgent: false,
    })

    assert.equal(atCeiling.agentTimeCeilingMinutes, 60)
    assert.match(formatPreflight(atCeiling).join('\n'), /reaches the scheduled workflow's 60-minute ceiling/)

    const shorter = buildPreflight({
      scenarios: [{ id: 'skill-guidance', timeoutMinutes: 8 }],
      models: [{ id: 'model-a' }],
      repetitions: 3,
      declaredInvocations: 6,
      planned: Array.from({ length: 6 }, () => ({ id: 'skill-guidance', timeoutMinutes: 8 })),
      fakeAgent: false,
    })
    assert.equal(shorter.agentTimeCeilingMinutes, 48)
    assert.doesNotMatch(formatPreflight(shorter).join('\n'), /scheduled workflow's 60-minute ceiling/)
  })
})
