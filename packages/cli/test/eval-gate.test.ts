import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, describe, test } from 'node:test'

import {
  checkEvalGate,
  type EvalBaseline,
  type EvalLatest,
  type EvalScenario,
  hashDirectory,
  hashScenario,
  parseBaseline,
  parseLatest,
  validateScenarioMatrix,
} from '../src/eval-gate.ts'

const temps: string[] = []
after(() => {
  for (const dir of temps) rmSync(dir, { recursive: true, force: true })
})

function temp(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  temps.push(dir)
  return dir
}

function scenario(over: Partial<EvalScenario> = {}): EvalScenario {
  return {
    id: 'tiny-code-change',
    size: 'tiny',
    kind: 'code-change',
    repo: 'eval/repos/node-tiny',
    task: 'Implement slugify.',
    verify: ['npm test'],
    expect: { verified: true, hiddenVerified: true },
    ...over,
  }
}

function matrix(): EvalScenario[] {
  return [
    scenario(),
    scenario({ id: 'tiny-verify-only', kind: 'verify-only', expect: { verified: true } }),
    scenario({ id: 'medium-code-change', size: 'medium', repo: 'eval/repos/node-medium' }),
    scenario({
      id: 'medium-verify-only',
      size: 'medium',
      kind: 'verify-only',
      repo: 'eval/repos/node-medium',
      expect: { verified: true },
    }),
  ]
}

function baseline(
  scenarios: readonly EvalScenario[],
  hashes: Record<string, { scenarioHash: string; sourceHash: string }> = {},
): EvalBaseline {
  return {
    schemaVersion: 1,
    scenarios: scenarios.map((s) => ({
      id: s.id,
      size: s.size,
      kind: s.kind,
      scenarioHash: hashes[s.id]?.scenarioHash ?? 'scenario-hash',
      sourceHash: hashes[s.id]?.sourceHash ?? 'source-hash',
      expect: s.expect,
    })),
  }
}

function latest(
  scenarios: readonly EvalScenario[],
  hashes: Record<string, { scenarioHash: string; sourceHash: string }> = {},
): EvalLatest {
  return {
    schemaVersion: 1,
    generatedAt: '2026-10-21T00:00:00.000Z',
    results: scenarios.flatMap((s) =>
      (['bare', 'anvil'] as const).map((variant) => ({
        scenario: s.id,
        size: s.size,
        kind: s.kind,
        variant,
        model: 'fake-agent',
        modelRole: null,
        opencodeVersion: null,
        scenarioHash: hashes[s.id]?.scenarioHash ?? 'scenario-hash',
        sourceHash: hashes[s.id]?.sourceHash ?? 'source-hash',
        verified: s.expect.verified !== false,
        hiddenVerified: s.expect.hiddenVerified === true ? true : null,
        verifyExitCodes: [0],
      })),
    ),
  }
}

describe('the eval scenario matrix', () => {
  test('accepts exactly the four required cells', () => {
    assert.equal(validateScenarioMatrix(matrix()), null)
  })

  test('rejects a matrix with a missing cell', () => {
    const scenarios = matrix().filter((s) => s.id !== 'medium-verify-only')
    assert.equal(validateScenarioMatrix(scenarios), 'the scenario matrix is missing medium / verify-only')
  })

  test('rejects a duplicate id rather than letting one scenario shadow another', () => {
    const scenarios = [...matrix(), scenario()]
    assert.match(validateScenarioMatrix(scenarios) ?? '', /duplicate scenario id/)
  })

  test('rejects a second scenario in a cell the matrix already covers', () => {
    const scenarios = [...matrix(), scenario({ id: 'tiny-code-change-again' })]
    assert.match(validateScenarioMatrix(scenarios) ?? '', /exactly one scenario per cell/)
  })

  test('rejects an unknown size or kind', () => {
    assert.match(validateScenarioMatrix([scenario({ size: 'huge' as EvalScenario['size'] })]) ?? '', /size/)
    assert.match(validateScenarioMatrix([scenario({ kind: 'review' as EvalScenario['kind'] })]) ?? '', /kind/)
  })
})

describe('eval hashes', () => {
  test('a scenario hash is stable across key order', () => {
    const a = scenario({ hidden: [{ from: 'a', to: 'b' }] })
    const b: EvalScenario = {
      expect: { hiddenVerified: true, verified: true },
      hidden: [{ to: 'b', from: 'a' }],
      verify: ['npm test'],
      task: 'Implement slugify.',
      repo: 'eval/repos/node-tiny',
      kind: 'code-change',
      size: 'tiny',
      id: 'tiny-code-change',
    }
    assert.equal(hashScenario(a), hashScenario(b))
  })

  test('a directory hash is stable for the same content', () => {
    const make = (): string => {
      const dir = temp('anvil-eval-hash-')
      mkdirSync(join(dir, 'src'), { recursive: true })
      writeFileSync(join(dir, 'src', 'a.js'), 'export const a = 1\n', 'utf8')
      return dir
    }
    assert.equal(hashDirectory(make()), hashDirectory(make()))
  })
})

describe('the eval gate', () => {
  test('passes when the current matrix and the latest run match the baseline', () => {
    const expected = baseline(matrix())
    const result = checkEvalGate(expected, latest(matrix()), expected.scenarios)
    assert.equal(result.ok, true, result.message)
  })

  test('fails when the scenario changed after the baseline was written', () => {
    const expected = baseline(matrix())
    const changed = expected.scenarios.map((scenario) =>
      scenario.id === 'medium-code-change'
        ? { ...scenario, scenarioHash: 'new-hash', sourceHash: 'new-source' }
        : scenario,
    )
    const gate = checkEvalGate(expected, latest(matrix()), changed)
    assert.equal(gate.ok, false)
    assert.match(gate.message, /scenario changed without updating the baseline/)
    assert.match(gate.message, /fixture or verifier changed without updating the baseline/)
  })

  test('fails when a scenario is added without updating the baseline', () => {
    const expected = baseline(matrix())
    const added = [...expected.scenarios, { ...expected.scenarios[0]!, id: 'new-scenario' }]
    const gate = checkEvalGate(expected, latest(matrix()), added)
    assert.equal(gate.ok, false)
    assert.match(gate.message, /new-scenario: the scenario was added/)
  })

  test('fails when the expectation changed without updating the baseline', () => {
    const expected = baseline(matrix())
    const changed = expected.scenarios.map((scenario) =>
      scenario.id === 'tiny-verify-only' ? { ...scenario, expect: { verified: false } } : scenario,
    )
    const gate = checkEvalGate(expected, latest(matrix()), changed)
    assert.equal(gate.ok, false)
    assert.match(gate.message, /expectation changed/)
  })

  test('fails when a scenario changed without updating the baseline', () => {
    const scenarios = matrix()
    const hashes = Object.fromEntries(scenarios.map((s) => [s.id, { scenarioHash: 'old', sourceHash: 'old' }]))
    const gate = checkEvalGate(baseline(scenarios, hashes), latest(scenarios))
    assert.equal(gate.ok, false)
    assert.match(gate.message, /scenario changed/)
  })

  test('fails when the fixture changed without updating the baseline', () => {
    const scenarios = matrix()
    const oldHashes = Object.fromEntries(scenarios.map((s) => [s.id, { scenarioHash: 'same', sourceHash: 'old' }]))
    const newHashes = Object.fromEntries(scenarios.map((s) => [s.id, { scenarioHash: 'same', sourceHash: 'new' }]))
    const gate = checkEvalGate(baseline(scenarios, oldHashes), latest(scenarios, newHashes))
    assert.equal(gate.ok, false)
    assert.match(gate.message, /fixture or verifier changed/)
  })

  test('fails when the latest run is missing one of the two variants', () => {
    const scenarios = matrix()
    const run = latest(scenarios)
    run.results = run.results.filter((result) => result.variant !== 'anvil')
    const gate = checkEvalGate(baseline(scenarios), run)
    assert.equal(gate.ok, false)
    assert.match(gate.message, /no anvil result/)
  })

  test('fails when a run did not meet the expectation', () => {
    const scenarios = matrix()
    const run = latest(scenarios)
    for (const result of run.results) result.verified = false
    const gate = checkEvalGate(baseline(scenarios), run)
    assert.equal(gate.ok, false)
    assert.match(gate.message, /visible verifier/)
  })

  test('fails when the latest run has a scenario the baseline does not', () => {
    const scenarios = matrix()
    const extra = scenario({ id: 'unexpected' })
    const gate = checkEvalGate(baseline(scenarios), latest([...scenarios, extra]))
    assert.equal(gate.ok, false)
    assert.match(gate.message, /unexpected/)
  })
})

describe('eval gate parsing', () => {
  test('a baseline with the wrong schema version is refused', () => {
    const parsed = parseBaseline({ schemaVersion: 2, scenarios: [] })
    assert.equal(parsed, 'baseline schemaVersion must be 1')
  })

  test('a latest summary with a non-boolean verdict is refused', () => {
    const run = latest(matrix())
    run.results[0]!.verified = 'yes' as unknown as boolean
    const parsed = parseLatest(run)
    assert.match(parsed as string, /verified is not a boolean/)
  })
})
