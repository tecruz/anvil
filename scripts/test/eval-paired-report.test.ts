import assert from 'node:assert/strict'
import { describe, test } from 'node:test'

import type { EvalModel, EvalScenario } from '../../packages/cli/src/eval-gate.ts'
import {
  buildPreflight,
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
      successfulDurationMs: { bare: 10_000, anvil: 6_000, pairs: 1 },
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

  test('each comparison is labelled exploratory on its own pair count', () => {
    const small = summarizePairs([result({ variant: 'bare' }), result({ variant: 'anvil' })])
    assert.match(formatPairedSummary(small).join('\n'), /1 pair does not support a significance claim/)

    // Six scenarios with one repetition each are six one-pair measurements. Summing them
    // into "six pairs" must not make the warning disappear.
    const oneEach = summarizePairs(
      Array.from({ length: 6 }, (_, index) => [
        result({ variant: 'bare', scenario: `scenario-${index}` }),
        result({ variant: 'anvil', scenario: `scenario-${index}` }),
      ]).flat(),
    )
    assert.equal(oneEach.totals.pairs, 6)
    const oneEachText = formatPairedSummary(oneEach).join('\n')
    assert.equal((oneEachText.match(/does not support a significance claim/g) ?? []).length, 6)

    const large = summarizePairs(
      Array.from({ length: 5 }, (_, repetition) => [
        result({ variant: 'bare', repetition }),
        result({ variant: 'anvil', repetition }),
      ]).flat(),
    )
    assert.equal(large.totals.pairs, 5)
    assert.doesNotMatch(formatPairedSummary(large).join('\n'), /does not support a significance claim/)
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
