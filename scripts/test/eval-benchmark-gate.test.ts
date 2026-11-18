import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { after, describe, test } from 'node:test'
import { fileURLToPath } from 'node:url'

import {
  buildBenchmarkSummary,
  checkBenchmarkRun,
  type EvalBaseline,
  type EvalBaselineScenario,
  type EvalRunRecord,
  type EvalRunRecordResult,
  type EvalScenario,
  hashImplementation,
  hashScenario,
  hashScenarioSource,
} from '../../packages/cli/src/eval-gate.ts'
import { benchmarkGateCommand, evalGateHint } from '../eval.ts'

const IMPLEMENTATION = 'impl-1'
const HARNESS = 'harness-1'
const COMMIT = 'commit-1'
const MODEL = { id: 'model-a', role: 'small' }

/**
 * A scenario as the baseline describes it. Hashes are opaque strings: the benchmark gate only
 * compares them, so a readable value proves the comparison ran without pretending to hash a fixture.
 */
function scenario(id: string, overrides: Partial<EvalBaselineScenario> = {}): EvalBaselineScenario {
  return {
    id,
    size: 'tiny',
    kind: 'code-change',
    scenarioHash: `scenario-${id}`,
    sourceHash: `source-${id}`,
    verify: ['npm test'],
    hiddenVerify: [],
    expect: { verified: true },
    ...overrides,
  }
}

function result(
  definition: EvalBaselineScenario,
  variant: 'bare' | 'anvil',
  model = MODEL,
  overrides: Partial<EvalRunRecordResult> = {},
): EvalRunRecordResult {
  return {
    scenario: definition.id,
    variant,
    model: model.id,
    modelRole: model.role,
    scenarioHash: definition.scenarioHash,
    sourceHash: definition.sourceHash,
    verifyCount: 1,
    hiddenVerifyCount: 0,
    attempts: [
      {
        startedAt: '2026-11-16T00:00:00.000Z',
        completedAt: '2026-11-16T00:00:05.000Z',
        state: 'completed',
      },
    ],
    verified: true,
    hiddenVerified: null,
    verifyExitCodes: [0],
    costUsd: null,
    tokens: null,
    durationMs: null,
    transcript: '',
    repetition: 0,
    ...overrides,
  }
}

function recordFor(
  scenarios: readonly EvalBaselineScenario[],
  models: ReadonlyArray<{ id: string; role: string }> = [MODEL],
  repetitions = 1,
  overrides: Partial<EvalRunRecord> = {},
): EvalRunRecord {
  const results: EvalRunRecordResult[] = []
  for (const model of models) {
    for (const definition of scenarios) {
      for (let repetition = 0; repetition < repetitions; repetition += 1) {
        for (const variant of ['bare', 'anvil'] as const) {
          results.push(result(definition, variant, model as { id: string; role: 'small' | 'frontier' }, { repetition }))
        }
      }
    }
  }
  const runKeys = results.map((entry) => `${entry.scenario}/${entry.variant}/${entry.model}/${entry.repetition}`)
  return {
    schemaVersion: 3,
    runId: 'run-1',
    startedAt: '2026-11-16T00:00:00.000Z',
    completedAt: '2026-11-16T00:01:00.000Z',
    completionState: 'completed',
    commitSha: COMMIT,
    implementation: IMPLEMENTATION,
    bundleDigest: 'bundle-1',
    harnessDigest: HARNESS,
    models: models.map((model) => ({ ...model })),
    opencodeVersion: '2.1.4',
    nodeVersion: 'v24.0.0',
    publishTranscripts: false,
    subset: false,
    scenarioHashes: Object.fromEntries(
      scenarios.map((definition) => [
        definition.id,
        { scenarioHash: definition.scenarioHash, sourceHash: definition.sourceHash },
      ]),
    ),
    repetitions,
    seed: 'seed-1',
    order: 'alternate',
    runKeys,
    executionOrder: runKeys,
    results,
    ...overrides,
  }
}

function baseline(scenarios: readonly EvalBaselineScenario[]): EvalBaseline {
  return { schemaVersion: 3, scenarios: [...scenarios] }
}

function check(
  record: EvalRunRecord | null,
  scenarios: readonly EvalBaselineScenario[],
  overrides: Partial<Parameters<typeof checkBenchmarkRun>[0]> = {},
) {
  return checkBenchmarkRun({
    expectedRunId: 'run-1',
    record,
    requiredKeys: record?.runKeys ?? [],
    baseline: baseline(scenarios),
    current: scenarios,
    implementation: IMPLEMENTATION,
    harnessDigest: HARNESS,
    commitSha: COMMIT,
    ...overrides,
  })
}

describe('real-agent benchmark gate', () => {
  test('accepts a complete real-agent run and keeps unknown measurements unknown', () => {
    const scenarios = [scenario('tiny-code-change'), scenario('tiny-verify-only')]
    const record = recordFor(scenarios)

    const gate = check(record, scenarios)
    assert.equal(gate.ok, true, gate.message)

    const summary = buildBenchmarkSummary(record, scenarios)
    assert.equal(summary.evidence, 'real-agent')
    assert.equal(summary.runId, 'run-1')
    assert.equal(summary.commitSha, COMMIT)
    assert.equal(summary.results.length, 4)
    for (const result of summary.results) {
      assert.equal(result.model, MODEL.id)
      assert.equal(result.costUsd, null)
      assert.equal(result.tokens, null)
      assert.equal(result.durationMs, null)
    }
  })

  test('refuses a record for another run', () => {
    const scenarios = [scenario('tiny-code-change')]
    const gate = check(recordFor(scenarios), scenarios, { expectedRunId: 'run-2' })
    assert.equal(gate.ok, false)
    assert.match(gate.message, /another run's evidence is not authority/)
  })

  test('refuses a record from a different checkout commit', () => {
    const scenarios = [scenario('tiny-code-change')]
    const gate = check(recordFor(scenarios), scenarios, { commitSha: 'commit-2' })
    assert.equal(gate.ok, false)
    assert.match(gate.message, /not from this checkout/)
  })

  test('refuses a fake-agent record: the benchmark is the other evidence channel', () => {
    const scenarios = [scenario('tiny-code-change')]
    const record = recordFor(scenarios, [{ id: 'fake-agent', role: 'small' }])
    const gate = check(record, scenarios)
    assert.equal(gate.ok, false)
    assert.match(gate.message, /validates real-agent evidence/)
    assert.match(gate.message, /fake-agent/)
  })

  test('refuses a record that declares no model', () => {
    const scenarios = [scenario('tiny-code-change')]
    const gate = check(recordFor(scenarios, []), scenarios)
    assert.equal(gate.ok, false)
    assert.match(gate.message, /declares no model/)
  })

  test('refuses a declared model that produced no result', () => {
    const scenarios = [scenario('tiny-code-change')]
    const record = recordFor(scenarios)
    record.models = [{ id: 'model-unused', role: 'frontier' }]
    const gate = check(record, scenarios)
    assert.equal(gate.ok, false)
    assert.match(gate.message, /used model model-a, which the run does not declare/)
    assert.match(gate.message, /declares model model-unused but no result used it/)
  })

  test('refuses a result whose model role disagrees with the declaration', () => {
    const scenarios = [scenario('tiny-code-change')]
    const record = recordFor(scenarios)
    record.models = [{ id: MODEL.id, role: 'frontier' }]
    const gate = check(record, scenarios)
    assert.equal(gate.ok, false)
    assert.match(gate.message, /records role small but declares frontier/)
  })

  test('refuses a result with no model', () => {
    const scenarios = [scenario('tiny-code-change')]
    const record = recordFor(scenarios)
    record.results[0] = { ...record.results[0]!, model: null }
    const gate = check(record, scenarios)
    assert.equal(gate.ok, false)
    assert.match(gate.message, /has no model/)
  })

  test('refuses a record that did not execute the requested matrix', () => {
    const requested = [scenario('tiny-code-change'), scenario('tiny-verify-only')]
    const record = recordFor([requested[0]!])
    const gate = check(record, requested, { requiredKeys: recordFor(requested).runKeys })
    assert.equal(gate.ok, false)
    assert.match(gate.message, /never executed tiny-verify-only/)
  })

  test('refuses a record marked partial', () => {
    const scenarios = [scenario('tiny-code-change')]
    const gate = check(recordFor(scenarios, [MODEL], 1, { completionState: 'partial' }), scenarios)
    assert.equal(gate.ok, false)
    assert.match(gate.message, /did not complete \(state: partial\)/)
  })

  test('refuses a subset run', () => {
    const scenarios = [scenario('tiny-code-change')]
    const gate = check(recordFor(scenarios, [MODEL], 1, { subset: true }), scenarios)
    assert.equal(gate.ok, false)
    assert.match(gate.message, /subset run/)
  })

  test('refuses a recorded agent error', () => {
    const scenarios = [scenario('tiny-code-change')]
    const record = recordFor(scenarios)
    const first = record.results[0]!
    record.results[0] = {
      ...first,
      error: 'agent exited 1',
      attempts: first.attempts.map((attempt) => ({ ...attempt, error: 'agent exited 1' })),
    }
    const gate = check(record, scenarios)
    assert.equal(gate.ok, false)
    assert.match(gate.message, /recorded an error/)
  })

  test('refuses a failed verifier expectation', () => {
    const scenarios = [scenario('tiny-code-change')]
    const record = recordFor(scenarios)
    record.results[0] = { ...record.results[0]!, verified: false, verifyExitCodes: [1] }
    const gate = check(record, scenarios)
    assert.equal(gate.ok, false)
    assert.match(gate.message, /did not pass the visible verifier/)
  })

  test('refuses evidence from a different implementation', () => {
    const scenarios = [scenario('tiny-code-change')]
    const gate = check(recordFor(scenarios), scenarios, { implementation: 'impl-2' })
    assert.equal(gate.ok, false)
    assert.match(gate.message, /implementation changed under the run/)
  })

  test('refuses evidence recorded against different fixtures', () => {
    const scenarios = [scenario('tiny-code-change')]
    const record = recordFor(scenarios)
    record.results[0] = { ...record.results[0]!, sourceHash: 'source-changed' }
    const gate = check(record, scenarios)
    assert.equal(gate.ok, false)
    assert.match(gate.message, /fixtures that disagree/)
  })

  test('refuses a record whose statement about a verifier is self-contradictory', () => {
    const scenarios = [scenario('tiny-code-change')]
    const record = recordFor(scenarios)
    record.results[0] = { ...record.results[0]!, verified: true, verifyExitCodes: [1] }
    const gate = check(record, scenarios)
    assert.equal(gate.ok, false)
    assert.match(gate.message, /verified with a failing visible verifier/)
  })

  test('refuses evidence captured for a different scenario selection', () => {
    const scenarios = [scenario('tiny-code-change')]
    const record = recordFor(scenarios)
    record.scenarioHashes = {
      ...record.scenarioHashes,
      'an-unvalidated-scenario': { scenarioHash: 'other-scenario', sourceHash: 'other-source' },
    }
    const gate = check(record, scenarios)
    assert.equal(gate.ok, false)
    assert.match(gate.message, /not part of the matrix this gate validated/)
  })

  test('accepts every model in a multi-model repetition run', () => {
    const scenarios = [scenario('tiny-code-change')]
    const models = [
      { id: 'model-a', role: 'small' },
      { id: 'model-b', role: 'frontier' },
    ]
    const record = recordFor(scenarios, models, 2)
    const gate = check(record, scenarios)
    assert.equal(gate.ok, true, gate.message)
    assert.equal(record.results.length, 8)
  })

  test('refuses a missing run record', () => {
    const scenarios = [scenario('tiny-code-change')]
    const gate = check(null, scenarios)
    assert.equal(gate.ok, false)
    assert.match(gate.message, /has no evidence to validate/)
  })
})

const SMOKE_IDS = new Set(['tiny-code-change', 'tiny-verify-only', 'medium-code-change', 'medium-verify-only'])
const temps: string[] = []
after(() => {
  for (const dir of temps) rmSync(dir, { recursive: true, force: true })
})

/** Copy the harness and its fixtures into a throwaway repository, with no Git or build output. */
function copyHarness(prefix: string): string {
  const source = fileURLToPath(new URL('../../', import.meta.url))
  const workspace = mkdtempSync(join(tmpdir(), prefix))
  temps.push(workspace)
  const root = join(workspace, 'repo')
  mkdirSync(root)
  mkdirSync(join(root, 'eval-results'))
  const skip = new Set(['node_modules', 'dist', '.git'])
  for (const path of [
    'packages',
    'eval',
    'scripts/eval.ts',
    'scripts/eval-check-broker.ts',
    'scripts/build.mjs',
    'package.json',
    'package-lock.json',
    'eval-results/baseline.json',
  ]) {
    cpSync(join(source, path), join(root, path), {
      recursive: true,
      filter: (entry) => !skip.has(basename(entry)),
    })
  }
  symlinkSync(
    join(source, 'node_modules'),
    join(root, 'node_modules'),
    process.platform === 'win32' ? 'junction' : 'dir',
  )
  return root
}

/** The same harness fingerprint `scripts/eval.ts` computes, so the synthetic record is valid. */
function harnessDigestAt(root: string): string {
  const hash = createHash('sha256')
  for (const rel of ['scripts/eval.ts', 'scripts/eval-check-broker.ts', 'eval/models.json']) {
    hash.update(rel)
    hash.update('\0')
    hash.update(readFileSync(join(root, ...rel.split('/'))))
    hash.update('\0')
  }
  return hash.digest('hex')
}

/** Write the run record a complete real-agent smoke run would leave behind. */
function writeRealRun(root: string, modelId: string, runId = 'run-1'): EvalRunRecord {
  const parsed = JSON.parse(readFileSync(join(root, 'eval', 'scenarios.json'), 'utf8')) as { scenarios: EvalScenario[] }
  const scenarios = parsed.scenarios.filter((scenario) => SMOKE_IDS.has(scenario.id))
  const results: EvalRunRecordResult[] = []
  for (const scenario of scenarios) {
    const hiddenCount = (scenario.hiddenVerify ?? []).length
    for (const variant of ['bare', 'anvil'] as const) {
      results.push({
        scenario: scenario.id,
        variant,
        model: modelId,
        modelRole: 'small',
        scenarioHash: hashScenario(scenario),
        sourceHash: hashScenarioSource(root, scenario),
        verifyCount: scenario.verify.length,
        hiddenVerifyCount: hiddenCount,
        attempts: [
          {
            startedAt: '2026-11-16T00:00:00.000Z',
            completedAt: '2026-11-16T00:00:05.000Z',
            state: 'completed',
          },
        ],
        verified: scenario.expect.verified === true,
        hiddenVerified: hiddenCount === 0 ? null : scenario.expect.hiddenVerified === true,
        verifyExitCodes: Array(scenario.verify.length + hiddenCount).fill(0),
        costUsd: null,
        tokens: null,
        durationMs: null,
        transcript: '',
        repetition: 0,
      })
    }
  }
  const runKeys = results.map((result) => `${result.scenario}/${result.variant}/${result.model}/${result.repetition}`)
  const record: EvalRunRecord = {
    schemaVersion: 3,
    runId,
    startedAt: '2026-11-16T00:00:00.000Z',
    completedAt: '2026-11-16T00:01:00.000Z',
    completionState: 'completed',
    commitSha: null,
    implementation: hashImplementation(root),
    bundleDigest: null,
    harnessDigest: harnessDigestAt(root),
    models: [{ id: modelId, role: 'small' }],
    opencodeVersion: '2.1.4',
    nodeVersion: process.version,
    publishTranscripts: false,
    subset: false,
    scenarioHashes: Object.fromEntries(
      scenarios.map((scenario) => [
        scenario.id,
        { scenarioHash: hashScenario(scenario), sourceHash: hashScenarioSource(root, scenario) },
      ]),
    ),
    repetitions: 1,
    seed: 'seed-1',
    order: 'alternate',
    runKeys,
    executionOrder: runKeys,
    results,
  }
  writeFileSync(join(root, 'eval-results', 'run.json'), JSON.stringify(record, null, 2))
  return record
}

function invokeCheck(root: string, ...args: string[]): { status: number | null; output: string } {
  const env: NodeJS.ProcessEnv = { ...process.env }
  delete env.ANVIL_EVAL
  const result = spawnSync(process.execPath, ['scripts/eval.ts', ...args], {
    cwd: root,
    env,
    encoding: 'utf8',
    timeout: 60_000,
  })
  assert.equal(result.error, undefined, result.error?.message)
  return { status: result.status, output: `${result.stdout}\n${result.stderr}` }
}

describe('benchmark gate CLI', () => {
  test('validates the named real-agent run without creating or reading latest.json', () => {
    const root = copyHarness('anvil-benchmark-cli-')
    writeRealRun(root, 'opencode/deepseek-v4.1-flash-free')

    const result = invokeCheck(root, '--check-run', 'run-1', '--models', 'small')
    assert.equal(result.status, 0, result.output)
    assert.equal(existsSync(join(root, 'eval-results', 'latest.json')), false)

    const summary = JSON.parse(readFileSync(join(root, 'eval-results', 'benchmark-summary.json'), 'utf8')) as {
      evidence: string
      runId: string
      results: Array<{ costUsd: number | null; durationMs: number | null; tokens: number | null }>
    }
    assert.equal(summary.evidence, 'real-agent')
    assert.equal(summary.runId, 'run-1')
    assert.equal(summary.results.length, 8)
    for (const entry of summary.results) {
      assert.equal(entry.costUsd, null)
      assert.equal(entry.tokens, null)
      assert.equal(entry.durationMs, null)
    }
    assert.equal(existsSync(join(root, 'eval-results', 'baseline.json')), true)
  })

  test('refuses a run id it has no record for and writes no summary', () => {
    const root = copyHarness('anvil-benchmark-other-')
    writeRealRun(root, 'opencode/deepseek-v4.1-flash-free', 'run-1')

    const result = invokeCheck(root, '--check-run', 'run-2', '--models', 'small')
    assert.equal(result.status, 1)
    assert.match(result.output, /no run record exists for run run-2/)
    assert.equal(existsSync(join(root, 'eval-results', 'benchmark-summary.json')), false)
  })

  test('refuses a run produced by a different implementation and writes no summary', () => {
    const root = copyHarness('anvil-benchmark-impl-')
    const record = writeRealRun(root, 'opencode/deepseek-v4.1-flash-free')
    record.implementation = 'a-different-implementation'
    writeFileSync(join(root, 'eval-results', 'run.json'), JSON.stringify(record, null, 2))

    const result = invokeCheck(root, '--check-run', 'run-1', '--models', 'small')
    assert.equal(result.status, 1)
    assert.match(result.output, /implementation changed under the run/)
    assert.equal(existsSync(join(root, 'eval-results', 'benchmark-summary.json')), false)
  })

  test('refuses --check-run without a run id instead of exiting or starting a run', () => {
    const root = copyHarness('anvil-benchmark-no-id-')
    writeRealRun(root, 'opencode/deepseek-v4.1-flash-free')
    for (const enabled of [false, true]) {
      const env: NodeJS.ProcessEnv = { ...process.env }
      if (enabled) env.ANVIL_EVAL = '1'
      else delete env.ANVIL_EVAL
      const result = spawnSync(process.execPath, ['scripts/eval.ts', '--check-run'], {
        cwd: root,
        env,
        encoding: 'utf8',
        timeout: 60_000,
      })
      const output = `${result.stdout}\n${result.stderr}`
      assert.equal(result.status, 1, output)
      assert.match(output, /--check-run needs the run id/)
      assert.doesNotMatch(output, /opt-in|Preflight|anvil-eval/)
    }
    assert.equal(existsSync(join(root, 'eval-results', 'benchmark-summary.json')), false)
  })
})

describe('benchmark gate hint', () => {
  const realResults = [{ model: 'model-a' }] as unknown as Parameters<typeof evalGateHint>[0]
  const fakeResults = [{ model: 'fake-agent' }] as unknown as Parameters<typeof evalGateHint>[0]

  test('reproduces the flags the run used', () => {
    assert.equal(
      benchmarkGateCommand('run-1', ['--models', 'all', '--repetitions', '2', '--order', 'fixed'], 2, 'fixed'),
      'npm run eval -- --check-run run-1 --models all --repetitions 2 --order fixed',
    )
    const hint = evalGateHint(realResults, 'run-1', ['--models', 'frontier'], 3, 'fixed', false)
    assert.match(hint, /--models frontier --repetitions 3 --order fixed/)
  })

  test('uses the defaults when the invocation named none', () => {
    assert.equal(
      benchmarkGateCommand('run-1', [], 1, 'alternate'),
      'npm run eval -- --check-run run-1 --models small --repetitions 1 --order alternate',
    )
  })

  test('normalizes spaced role lists so the printed command stays copyable', () => {
    assert.equal(
      benchmarkGateCommand('run-1', ['--models', 'frontier, small'], 2, 'fixed'),
      'npm run eval -- --check-run run-1 --models small,frontier --repetitions 2 --order fixed',
    )
    assert.equal(
      benchmarkGateCommand('run-1', ['--models', 'ALL'], 1, 'alternate'),
      'npm run eval -- --check-run run-1 --models all --repetitions 1 --order alternate',
    )
  })

  test('does not offer the complete-matrix gate for hermetic or subset runs', () => {
    assert.match(evalGateHint(fakeResults, 'run-1', [], 1, 'alternate', false), /eval:check/)
    assert.match(evalGateHint(realResults, 'run-1', [], 1, 'alternate', true), /subset run/)
  })

  test('does not claim eval:check compares a run that was not promoted', () => {
    const hinted = evalGateHint(fakeResults, 'run-1', [], 1, 'alternate', false, false)
    assert.doesNotMatch(hinted, /compare this run/)
    assert.match(hinted, /not promoted/)
    assert.match(hinted, /last promoted run, not the run just printed/)
    // A promoted run keeps the plain instruction.
    assert.match(evalGateHint(fakeResults, 'run-1', [], 1, 'alternate', false, true), /compare this run/)
  })
})
