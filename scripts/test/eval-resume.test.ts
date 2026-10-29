import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

import {
  checkpointFileName,
  type EvalRunRecord,
  type EvalScenario,
  hashScenarioSource,
} from '../../packages/cli/src/eval-gate.ts'

test('fake-agent resume validates verifier evidence before recovery and preserves evidence on refusal', {
  timeout: 600_000,
}, () => {
  const source = fileURLToPath(new URL('../../', import.meta.url))
  const workspace = mkdtempSync(join(tmpdir(), 'anvil-eval-resume-'))
  const root = join(workspace, 'repo')
  const runtime = join(workspace, 'runtime')
  mkdirSync(root)
  mkdirSync(runtime)
  try {
    // Run the real harness in an isolated copy. No checked-in evidence is ever changed,
    // no dependency installation is needed, and every invocation explicitly uses fake mode.
    const skip = new Set(['node_modules', 'dist', '.git'])
    for (const path of [
      'packages',
      'eval',
      'scripts/eval.ts',
      'scripts/build.mjs',
      'package.json',
      'package-lock.json',
    ]) {
      cpSync(join(source, path), join(root, path), {
        recursive: true,
        filter: (path) => !skip.has(basename(path)),
      })
    }
    symlinkSync(
      join(source, 'node_modules'),
      join(root, 'node_modules'),
      process.platform === 'win32' ? 'junction' : 'dir',
    )
    const env: NodeJS.ProcessEnv = { ...process.env, TMP: runtime, TEMP: runtime }
    delete env.ANVIL_EVAL
    // The harness must run fixture test discovery, not inherit this parent's test context.
    delete env.NODE_TEST_CONTEXT
    const invoke = (...args: string[]) => {
      const result = spawnSync(process.execPath, ['scripts/eval.ts', '--fake-agent', ...args], {
        cwd: root,
        env,
        encoding: 'utf8',
        timeout: 300_000,
      })
      assert.equal(result.error, undefined, result.error?.message)
      return { status: result.status, output: `${result.stdout}\n${result.stderr}` }
    }
    const read = (path: string) => readFileSync(join(root, path), 'utf8')
    const write = (path: string, value: unknown) =>
      writeFileSync(join(root, path), `${JSON.stringify(value, null, 2)}\n`)
    const record = () => JSON.parse(read('eval-results/run.json')) as EvalRunRecord
    const checkpoint = (result: EvalRunRecord['results'][number], runId: string) =>
      join('eval-results', 'checkpoints', runId, checkpointFileName(result))

    const scenarios = JSON.parse(read('eval/scenarios.json')) as { scenarios: EvalScenario[] }
    scenarios.scenarios
      .find((scenario) => scenario.id === 'tiny-verify-only')!
      .verify.push('node --test test/text.test.js')
    write('eval/scenarios.json', scenarios)
    let invocation = invoke('--write-baseline')
    assert.equal(invocation.status, 0, invocation.output)
    invocation = invoke('--check')
    assert.equal(invocation.status, 0, invocation.output)

    const complete = record()
    const original = complete.results.find(
      (entry) => entry.scenario === 'tiny-verify-only' && entry.variant === 'bare',
    )!
    assert.equal(original.verifyCount, 2)
    assert.deepEqual(original.verifyExitCodes, [0, 0])
    const originalKey = `${original.scenario}/${original.variant}/${original.model}/${original.repetition}`
    const partial = structuredClone(complete)
    partial.results = partial.results.filter(
      (entry) => entry.scenario !== original.scenario || entry.variant !== original.variant,
    )
    partial.executionOrder = partial.executionOrder.filter((key) => key !== originalKey)
    partial.completionState = 'in-progress'
    partial.completedAt = null
    write('eval-results/run.json', partial)
    write(checkpoint(original, complete.runId), { schemaVersion: 3, ...original, verifyCount: 1, verifyExitCodes: [0] })
    invocation = invoke('--resume')
    assert.equal(invocation.status, 0, invocation.output)
    assert.match(invocation.output, /Ignoring checkpoint.*reports 1 visible verifier commands.*defines 2/)
    assert.match(invocation.output, /1 of 20 keys remain/)
    const retried = record()
    const result = retried.results.find(
      (entry) => entry.scenario === original.scenario && entry.variant === original.variant,
    )!
    assert.equal(result.verifyCount, 2)
    assert.deepEqual(result.verifyExitCodes, [0, 0])
    assert.equal(retried.completionState, 'completed')
    invocation = invoke('--check')
    assert.equal(invocation.status, 0, invocation.output)

    // Corruption in run.json itself is refused, rather than silently rerunning completed
    // work or overwriting the previously valid summary and its archived provenance.
    const latestBefore = read('eval-results/latest.json')
    const archivePath = `eval-results/runs/${retried.runId}.json`
    const archiveBefore = read(archivePath)
    result.verifyCount = 1
    result.verifyExitCodes = [0]
    write('eval-results/run.json', retried)
    const recordBefore = read('eval-results/run.json')
    invocation = invoke('--resume')
    assert.equal(invocation.status, 1, invocation.output)
    assert.match(invocation.output, /reports 1 visible verifier commands.*defines 2.*cannot resume/)
    assert.equal(read('eval-results/run.json'), recordBefore)
    assert.equal(read('eval-results/latest.json'), latestBefore)
    assert.equal(read(archivePath), archiveBefore)

    // Refusing a fixture mismatch must not persist an otherwise recoverable checkpoint.
    const unstarted = structuredClone(complete)
    unstarted.results = unstarted.results.filter((entry) => !entry.scenario.startsWith('medium-code-change/'))
    unstarted.executionOrder = unstarted.executionOrder.filter((key) => !key.startsWith('medium-code-change/'))
    unstarted.completionState = 'in-progress'
    unstarted.completedAt = null
    write('eval-results/run.json', unstarted)
    const beforeRefusal = read('eval-results/run.json')
    const fixturePath = 'eval/solutions/medium-code-change.js'
    const fixture = read(fixturePath)
    writeFileSync(join(root, fixturePath), `${fixture}\n// Synthetic incompatible fixture.\n`)
    const scenario = scenarios.scenarios.find((entry) => entry.id === 'medium-code-change')!
    const recovered = complete.results.find((entry) => entry.scenario === scenario.id)!
    write(checkpoint(recovered, complete.runId), {
      schemaVersion: 3,
      ...recovered,
      sourceHash: hashScenarioSource(root, scenario),
    })
    invocation = invoke('--resume')
    assert.equal(invocation.status, 1, invocation.output)
    assert.match(invocation.output, /cannot resume/)
    assert.equal(read('eval-results/run.json'), beforeRefusal)
    assert.equal(read('eval-results/latest.json'), latestBefore)
    writeFileSync(join(root, fixturePath), fixture)
    invocation = invoke('--resume')
    assert.equal(invocation.status, 0, invocation.output)
    invocation = invoke('--check')
    assert.equal(invocation.status, 0, invocation.output)
  } finally {
    rmSync(workspace, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  }
})
