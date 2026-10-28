import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, describe, test } from 'node:test'

import {
  allDeclaredCompleted,
  checkEvalGate,
  checkpointFileName,
  checkRunRecord,
  checkRunRecordCompatibility,
  type EvalBaseline,
  type EvalLatest,
  type EvalRunRecord,
  type EvalRunRecordResult,
  type EvalScenario,
  hashDirectory,
  hashScenario,
  latestAttemptState,
  parseBaseline,
  parseLatest,
  parseRunRecord,
  readCheckpointDirectory,
  reconcileRunRecord,
  recordFixtureProblem,
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

  test('fails when the latest run does not record the implementation it evaluated', () => {
    const expected = baseline(matrix())
    const gate = checkEvalGate(expected, latest(matrix()), expected.scenarios, 'impl-hash')
    assert.equal(gate.ok, false)
    assert.match(gate.message, /does not record which implementation/)
  })

  test('fails when the latest run was produced by a different implementation', () => {
    const expected = baseline(matrix())
    const run = latest(matrix())
    run.implementation = 'old-impl'
    const gate = checkEvalGate(expected, run, expected.scenarios, 'new-impl')
    assert.equal(gate.ok, false)
    assert.match(gate.message, /different implementation/)
  })

  test('passes when the implementation matches', () => {
    const expected = baseline(matrix())
    const run = latest(matrix())
    run.implementation = 'impl-hash'
    const gate = checkEvalGate(expected, run, expected.scenarios, 'impl-hash')
    assert.equal(gate.ok, true, gate.message)
  })

  test('fails when a run recorded an agent error', () => {
    const scenarios = matrix()
    const run = latest(scenarios)
    run.results[0]!.error = 'agent timed out'
    const gate = checkEvalGate(baseline(scenarios), run)
    assert.equal(gate.ok, false)
    assert.match(gate.message, /agent error/)
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

function runRecord(over: Partial<EvalRunRecord> = {}): EvalRunRecord {
  return {
    schemaVersion: 1,
    runId: 'run-1',
    startedAt: '2026-10-27T00:00:00.000Z',
    completedAt: '2026-10-27T00:05:00.000Z',
    completionState: 'completed',
    commitSha: 'abc123',
    implementation: 'impl-hash',
    bundleDigest: 'bundle-hash',
    harnessDigest: 'harness-hash',
    models: [{ id: 'fake-agent', role: 'small' }],
    opencodeVersion: null,
    nodeVersion: process.version,
    publishTranscripts: false,
    subset: false,
    runKeys: ['tiny-code-change/bare/fake-agent', 'tiny-code-change/anvil/fake-agent'],
    executionOrder: ['tiny-code-change/bare/fake-agent', 'tiny-code-change/anvil/fake-agent'],
    results: [
      {
        scenario: 'tiny-code-change',
        variant: 'bare',
        model: 'fake-agent',
        modelRole: 'small',
        scenarioHash: 'sc-hash',
        sourceHash: 'src-hash',
        verified: true,
        hiddenVerified: true,
        verifyExitCodes: [0],
        costUsd: null,
        tokens: null,
        durationMs: 1000,
        transcript: '',
        attempts: [
          {
            startedAt: '2026-10-27T00:02:00.000Z',
            completedAt: '2026-10-27T00:02:30.000Z',
            state: 'completed',
          },
        ],
      },
      {
        scenario: 'tiny-code-change',
        variant: 'anvil',
        model: 'fake-agent',
        modelRole: 'small',
        scenarioHash: 'sc-hash',
        sourceHash: 'src-hash',
        verified: true,
        hiddenVerified: true,
        verifyExitCodes: [0],
        costUsd: null,
        tokens: null,
        durationMs: 1500,
        transcript: '',
        attempts: [
          {
            startedAt: '2026-10-27T00:03:00.000Z',
            completedAt: '2026-10-27T00:03:30.000Z',
            state: 'completed',
          },
        ],
      },
    ],
    ...over,
  }
}

function runRecordFor(run: EvalLatest): EvalRunRecord {
  const keys = run.results.map((result) => `${result.scenario}/${result.variant}/${result.model ?? 'unknown'}`)
  return runRecord({
    runId: run.runId ?? 'run-1',
    runKeys: keys,
    executionOrder: keys,
    results: run.results.map((result) => ({
      scenario: result.scenario,
      variant: result.variant,
      model: result.model,
      modelRole: result.modelRole,
      scenarioHash: result.scenarioHash,
      sourceHash: result.sourceHash,
      verified: result.verified,
      hiddenVerified: result.hiddenVerified,
      verifyExitCodes: [...result.verifyExitCodes],
      costUsd: null,
      tokens: null,
      durationMs: 0,
      transcript: '',
      ...(result.error === undefined ? {} : { error: result.error }),
      attempts: [
        {
          startedAt: '2026-10-27T00:02:00.000Z',
          completedAt: '2026-10-27T00:02:30.000Z',
          state: 'completed',
        },
      ],
    })),
  })
}

describe('run record contract', () => {
  test('parses a well-formed run record', () => {
    const parsed = parseRunRecord(runRecord()) as EvalRunRecord
    assert.equal(parsed.runId, 'run-1')
    assert.equal(parsed.completionState, 'completed')
  })

  test('refuses a run record with the wrong schema version', () => {
    const parsed = parseRunRecord({ ...runRecord(), schemaVersion: 2 })
    assert.match(parsed as string, /schemaVersion must be 1/)
  })

  test('refuses a run record with no runId', () => {
    const parsed = parseRunRecord({ ...runRecord(), runId: '' })
    assert.match(parsed as string, /no runId/)
  })

  test('refuses a run record with an invalid completion state', () => {
    const parsed = parseRunRecord({ ...runRecord(), completionState: 'unknown' as EvalRunRecord['completionState'] })
    assert.match(parsed as string, /completionState is invalid/)
  })

  test('passes a completed run record with matching implementation and all keys', () => {
    const gate = checkRunRecord(runRecord(), 'impl-hash', [
      'tiny-code-change/bare/fake-agent',
      'tiny-code-change/anvil/fake-agent',
    ])
    assert.equal(gate.ok, true, gate.message)
  })

  test('fails when there is no run record', () => {
    const gate = checkRunRecord(null, 'impl-hash', ['tiny-code-change/bare'])
    assert.equal(gate.ok, false)
    assert.match(gate.message, /no run record exists/)
  })

  test('fails when the run did not complete', () => {
    const gate = checkRunRecord(runRecord({ completionState: 'partial' }), 'impl-hash', [
      'tiny-code-change/bare',
      'tiny-code-change/anvil',
    ])
    assert.equal(gate.ok, false)
    assert.match(gate.message, /did not complete/)
  })

  test('fails when the implementation changed under the run', () => {
    const gate = checkRunRecord(runRecord({ implementation: 'old-impl' }), 'new-impl', ['tiny-code-change/bare'])
    assert.equal(gate.ok, false)
    assert.match(gate.message, /implementation changed under the run/)
  })

  test('fails when the run never executed a declared key', () => {
    const gate = checkRunRecord(runRecord(), 'impl-hash', [
      'tiny-code-change/bare/fake-agent',
      'medium-code-change/anvil/fake-agent',
    ])
    assert.equal(gate.ok, false)
    assert.match(gate.message, /never executed/)
  })

  test('fails when the record declares a key it never executed', () => {
    const record = runRecord()
    const extra = 'medium-code-change/anvil/fake-agent'
    record.runKeys.push(extra)
    record.executionOrder.push(extra)
    const gate = checkRunRecord(record, 'impl-hash', record.runKeys)
    assert.equal(gate.ok, false)
    assert.match(gate.message, /did not execute/)
  })

  test('fails when the record executed a key it never declared', () => {
    const record = runRecord()
    record.results.push({
      ...record.results[1]!,
      scenario: 'medium-code-change',
    })
    const gate = checkRunRecord(record, 'impl-hash', [
      'tiny-code-change/bare/fake-agent',
      'tiny-code-change/anvil/fake-agent',
    ])
    assert.equal(gate.ok, false)
    assert.match(gate.message, /never declared/)
  })

  test('fails when a completed result still carries an error', () => {
    const record = runRecord()
    record.results[0] = { ...record.results[0]!, error: 'agent failed' }
    const gate = checkRunRecord(record, 'impl-hash', record.runKeys)
    assert.equal(gate.ok, false)
    assert.match(gate.message, /recorded an error/)
  })

  test('fails when the last attempt completed but carries an error', () => {
    const record = runRecord()
    const result = record.results[0]!
    result.attempts = [
      ...result.attempts,
      {
        startedAt: '2026-10-27T00:04:00.000Z',
        completedAt: '2026-10-27T00:04:30.000Z',
        state: 'completed',
        error: 'agent failed',
      },
    ]
    const gate = checkRunRecord(record, 'impl-hash', record.runKeys)
    assert.equal(gate.ok, false)
    assert.match(gate.message, /recorded an error/)
  })

  test('fails when a completed attempt has no completion timestamp', () => {
    const record = runRecord()
    const result = record.results[0]!
    result.attempts = [{ ...result.attempts[0]!, completedAt: null }]
    const gate = checkRunRecord(record, 'impl-hash', record.runKeys)
    assert.equal(gate.ok, false)
    assert.match(gate.message, /without a completion timestamp/)
  })

  test('fails when a verified result reports a failing verifier exit code', () => {
    const record = runRecord()
    record.results[0] = { ...record.results[0]!, verified: true, verifyExitCodes: [1] }
    const gate = checkRunRecord(record, 'impl-hash', record.runKeys)
    assert.equal(gate.ok, false)
    assert.match(gate.message, /verified with a failing visible verifier/)
  })

  test('fails when a completed run has no completion timestamp', () => {
    const gate = checkRunRecord(runRecord({ completedAt: null }), 'impl-hash', runRecord().runKeys)
    assert.equal(gate.ok, false)
    assert.match(gate.message, /no completion timestamp/)
  })

  test('fails when a completed run does not record its harness', () => {
    const gate = checkRunRecord(runRecord({ harnessDigest: null }), 'impl-hash', runRecord().runKeys)
    assert.equal(gate.ok, false)
    assert.match(gate.message, /does not record the harness/)
  })

  test('fails when a subset run is offered as complete evidence', () => {
    const gate = checkRunRecord(runRecord({ subset: true }), 'impl-hash', runRecord().runKeys)
    assert.equal(gate.ok, false)
    assert.match(gate.message, /subset run/)
  })

  test('refuses a run record with an invalid verifier exit code', () => {
    const record = runRecord()
    record.results[0] = {
      ...record.results[0]!,
      verifyExitCodes: [0, 'nope'] as unknown as number[],
    }
    const parsed = parseRunRecord(record)
    assert.match(parsed as string, /verifyExitCodes is invalid/)
  })
})

describe('latest attempt state', () => {
  test('returns completed when the last attempt completed', () => {
    const result = runRecord().results[0]!
    assert.equal(latestAttemptState(result), 'completed')
  })

  test('returns failed when the last attempt failed', () => {
    const result: EvalRunRecordResult = {
      ...runRecord().results[0]!,
      attempts: [
        { startedAt: 't1', completedAt: 't2', state: 'completed' },
        { startedAt: 't3', completedAt: 't4', state: 'failed', error: 'boom' },
      ],
    }
    assert.equal(latestAttemptState(result), 'failed')
  })

  test('returns null when no attempts exist', () => {
    const result: EvalRunRecordResult = {
      ...runRecord().results[0]!,
      attempts: [],
    }
    assert.equal(latestAttemptState(result), null)
  })
})

describe('the eval gate rejects contradictory run evidence', () => {
  const scenarios = matrix()
  const expected = baseline(scenarios)

  function evidence(): { run: EvalLatest; record: EvalRunRecord } {
    const run = latest(scenarios)
    run.implementation = 'impl-hash'
    return { run, record: runRecordFor(run) }
  }

  test('fails when the summary and record disagree about an error', () => {
    const { run, record } = evidence()
    run.results[0]!.error = 'summary says the agent failed'
    const gate = checkEvalGate(expected, run, undefined, 'impl-hash', record)
    assert.equal(gate.ok, false)
    assert.match(gate.message, /error .* disagrees with run record/)
  })

  test('compares verifier exit codes in order instead of sorting them', () => {
    const { run, record } = evidence()
    run.results[0]!.verified = false
    run.results[0]!.verifyExitCodes = [0, 1]
    record.results[0]!.verified = false
    record.results[0]!.verifyExitCodes = [1, 0]
    const gate = checkEvalGate(expected, run, undefined, 'impl-hash', record)
    assert.equal(gate.ok, false)
    assert.match(gate.message, /verifyExitCodes disagree/)
  })

  test('fails when a summary claims a pass while reporting a failing verifier', () => {
    const { run, record } = evidence()
    run.results[0]!.verified = true
    run.results[0]!.verifyExitCodes = [1]
    record.results[0]!.verified = true
    record.results[0]!.verifyExitCodes = [0]
    const gate = checkEvalGate(expected, run, undefined, 'impl-hash', record)
    assert.equal(gate.ok, false)
    assert.match(gate.message, /failing visible verifier/)
  })

  test('fails when the summary does not reference the run record', () => {
    const { run, record } = evidence()
    delete run.runId
    const gate = checkEvalGate(expected, run, undefined, 'impl-hash', record)
    assert.equal(gate.ok, false)
    assert.match(gate.message, /does not reference a run/)
  })

  test('fails when the summary references a different run', () => {
    const { run, record } = evidence()
    run.runId = 'run-2'
    const gate = checkEvalGate(expected, run, undefined, 'impl-hash', record)
    assert.equal(gate.ok, false)
    assert.match(gate.message, /references run run-2/)
  })
})

describe('checkpoint reconciliation', () => {
  const hashes = Object.fromEntries(
    matrix().map((scenario) => [scenario.id, { scenarioHash: 'scenario-hash', sourceHash: 'source-hash' }]),
  )
  const key = 'tiny-code-change/anvil/fake-agent'

  test('encodes model ids so a slash does not create nested checkpoint paths', () => {
    const name = checkpointFileName({
      scenario: 'medium-verify-only',
      variant: 'anvil',
      model: 'provider/review-fake',
    })
    assert.equal(name, 'medium-verify-only--anvil--provider%2Freview-fake.json')
    assert.ok(!name.includes('/'))
  })

  test('reads nested checkpoints and reports malformed ones', () => {
    const dir = temp('anvil-eval-checkpoints-')
    mkdirSync(join(dir, 'provider'), { recursive: true })
    const checkpoint = runRecordFor(latest(matrix())).results[0]!
    writeFileSync(join(dir, 'provider', 'review-fake.json'), JSON.stringify(checkpoint), 'utf8')
    writeFileSync(join(dir, 'broken.json'), '{}', 'utf8')
    const read = readCheckpointDirectory(dir)
    assert.equal(read.entries.length, 1)
    assert.equal(read.rejected.length, 1)
  })

  test('recovers a completed checkpoint that run.json never recorded', () => {
    const record = runRecordFor(latest(matrix()))
    const missing = record.results.find((result) => `${result.scenario}/${result.variant}/${result.model}` === key)!
    record.results = record.results.filter((result) => result !== missing)
    record.executionOrder = record.executionOrder.filter((entry) => entry !== key)
    const reconciled = reconcileRunRecord(record, [{ result: missing, modifiedMs: 10 }], hashes)
    assert.equal(reconciled.changed, true)
    assert.equal(reconciled.record.results.length, 8)
    assert.equal(allDeclaredCompleted(reconciled.record), true)
  })

  test('prefers a newer completed checkpoint over a stale record entry', () => {
    const record = runRecordFor(latest(matrix()))
    const stale = record.results.find((result) => `${result.scenario}/${result.variant}/${result.model}` === key)!
    const newer: EvalRunRecordResult = {
      ...stale,
      verified: false,
      verifyExitCodes: [1],
      attempts: [
        ...stale.attempts,
        { startedAt: '2026-10-27T00:06:00.000Z', completedAt: '2026-10-27T00:06:30.000Z', state: 'completed' },
      ],
    }
    const reconciled = reconcileRunRecord(record, [{ result: newer, modifiedMs: 20 }], hashes)
    const got = reconciled.record.results.find(
      (result) => `${result.scenario}/${result.variant}/${result.model}` === key,
    )!
    assert.equal(reconciled.changed, true)
    assert.equal(got.verified, false)
    assert.equal(got.attempts.length, 2)
  })

  test('rejects a checkpoint whose hashes no longer match the fixtures', () => {
    const record = runRecordFor(latest(matrix()))
    const stale = record.results.find((result) => `${result.scenario}/${result.variant}/${result.model}` === key)!
    const reconciled = reconcileRunRecord(
      record,
      [{ result: { ...stale, sourceHash: 'other' }, modifiedMs: 10 }],
      hashes,
    )
    assert.equal(reconciled.changed, false)
    assert.match(reconciled.rejected.join('\n'), /hashes do not match/)
  })

  test('skips a failed checkpoint instead of recovering it as evidence', () => {
    const record = runRecordFor(latest(matrix()))
    const stale = record.results.find((result) => `${result.scenario}/${result.variant}/${result.model}` === key)!
    const failed: EvalRunRecordResult = {
      ...stale,
      attempts: [
        ...stale.attempts,
        { startedAt: '2026-10-27T00:06:00.000Z', completedAt: '2026-10-27T00:06:30.000Z', state: 'failed' },
      ],
    }
    const reconciled = reconcileRunRecord(record, [{ result: failed, modifiedMs: 10 }], hashes)
    assert.equal(reconciled.changed, false)
    const got = reconciled.record.results.find(
      (result) => `${result.scenario}/${result.variant}/${result.model}` === key,
    )!
    assert.equal(latestAttemptState(got), 'completed')
  })

  test('does not resurrect an equal-attempt success over a failed record', () => {
    const record = runRecordFor(latest(matrix()))
    const index = record.results.findIndex((result) => `${result.scenario}/${result.variant}/${result.model}` === key)
    const staleSuccess = record.results[index]!
    record.results[index] = {
      ...staleSuccess,
      attempts: [{ startedAt: '2026-10-27T00:06:00.000Z', completedAt: '2026-10-27T00:06:30.000Z', state: 'failed' }],
      error: 'the retry failed',
    }
    const reconciled = reconcileRunRecord(record, [{ result: staleSuccess, modifiedMs: 10 }], hashes)
    assert.equal(reconciled.changed, false)
    assert.equal(latestAttemptState(reconciled.record.results[index]!), 'failed')
  })

  test('recognises a record whose declared keys all completed', () => {
    assert.equal(allDeclaredCompleted(runRecord()), true)
    const failed = runRecord()
    failed.results[0]!.attempts = [
      { startedAt: '2026-10-27T00:02:00.000Z', completedAt: '2026-10-27T00:02:30.000Z', state: 'failed' },
    ]
    assert.equal(allDeclaredCompleted(failed), false)
  })

  test('reports the first completed result whose fixtures changed', () => {
    const recordHashes = { 'tiny-code-change': { scenarioHash: 'sc-hash', sourceHash: 'src-hash' } }
    assert.equal(recordFixtureProblem(runRecord(), recordHashes), null)
    assert.match(
      recordFixtureProblem(runRecord(), {
        'tiny-code-change': { scenarioHash: 'sc-hash', sourceHash: 'other' },
      }) ?? '',
      /different fixtures/,
    )
  })
})

describe('run record compatibility for resume', () => {
  const scenarios = {
    'tiny-code-change': { scenarioHash: 'sc-hash', sourceHash: 'src-hash' },
  }
  const models = [{ id: 'fake-agent', role: 'small' }]
  const config = (over: Partial<Parameters<typeof checkRunRecordCompatibility>[1]> = {}) => ({
    implementation: 'impl-hash',
    scenarioHashes: scenarios,
    models,
    bundleDigest: 'bundle-hash',
    harnessDigest: 'harness-hash',
    opencodeVersion: null,
    publishTranscripts: false,
    ...over,
  })

  test('passes when implementation, fixtures, models, and keys all match', () => {
    const gate = checkRunRecordCompatibility(runRecord(), config())
    assert.equal(gate.ok, true, gate.message)
  })

  test('fails when the implementation changed', () => {
    const gate = checkRunRecordCompatibility(runRecord({ implementation: 'old-impl' }), config())
    assert.equal(gate.ok, false)
    assert.match(gate.message, /cannot resume/)
  })

  test('fails when the harness changed', () => {
    const gate = checkRunRecordCompatibility(runRecord(), config({ harnessDigest: 'other-harness' }))
    assert.equal(gate.ok, false)
    assert.match(gate.message, /different harness/)
  })

  test('fails when the run does not record a harness digest', () => {
    const gate = checkRunRecordCompatibility(runRecord({ harnessDigest: null }), config())
    assert.equal(gate.ok, false)
    assert.match(gate.message, /does not record the harness/)
  })

  test('fails when the transcript policy changed', () => {
    const gate = checkRunRecordCompatibility(runRecord(), config({ publishTranscripts: true }))
    assert.equal(gate.ok, false)
    assert.match(gate.message, /transcripts/)
  })

  test('fails when the Node version changed', () => {
    const gate = checkRunRecordCompatibility(runRecord({ nodeVersion: 'v0.0.0' }), config())
    assert.equal(gate.ok, false)
    assert.match(gate.message, /Node/)
  })

  test('fails when the models changed', () => {
    const gate = checkRunRecordCompatibility(runRecord(), config({ models: [{ id: 'other-model', role: 'small' }] }))
    assert.equal(gate.ok, false)
    assert.match(gate.message, /cannot resume/)
  })

  test('fails when a fixture scenario hash changed', () => {
    const changed = { ...scenarios, 'tiny-code-change': { scenarioHash: 'new-sc-hash', sourceHash: 'src-hash' } }
    const gate = checkRunRecordCompatibility(runRecord(), config({ scenarioHashes: changed }))
    assert.equal(gate.ok, false)
    assert.match(gate.message, /fixture changed, cannot resume/)
  })

  test('fails when a source hash changed', () => {
    const changed = { ...scenarios, 'tiny-code-change': { scenarioHash: 'sc-hash', sourceHash: 'new-src-hash' } }
    const gate = checkRunRecordCompatibility(runRecord(), config({ scenarioHashes: changed }))
    assert.equal(gate.ok, false)
    assert.match(gate.message, /cannot resume/)
  })

  test('fails when there is no run record', () => {
    const gate = checkRunRecordCompatibility(null, config())
    assert.equal(gate.ok, false)
    assert.match(gate.message, /no run record exists to resume/)
  })
})
