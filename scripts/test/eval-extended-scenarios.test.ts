import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { after, describe, test } from 'node:test'
import { fileURLToPath } from 'node:url'

import type { EvalScenario } from '../../packages/cli/src/eval-gate.ts'
import { tokenizeCommand } from '../../packages/core/src/args.ts'
import { spawnArgv } from '../../packages/core/src/exec.ts'
import { buildProfile } from '../../packages/profile/src/index.ts'

const source = fileURLToPath(new URL('../../', import.meta.url))
const scenarios = (
  JSON.parse(readFileSync(join(source, 'eval/scenarios.json'), 'utf8')) as { scenarios: EvalScenario[] }
).scenarios
const smoke = new Set(['tiny-code-change', 'tiny-verify-only', 'medium-code-change', 'medium-verify-only'])
const extended = scenarios.filter((scenario) => !smoke.has(scenario.id))
const temps: string[] = []

after(() => {
  for (const dir of temps) rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
})

function fixture(scenario: EvalScenario): string {
  const workdir = mkdtempSync(join(tmpdir(), `anvil-eval-${scenario.id}-`))
  temps.push(workdir)
  cpSync(join(source, scenario.repo), workdir, { recursive: true })
  return workdir
}

/**
 * The harness-owned execution log for a scenario.
 *
 * For captureExecution scenarios, the harness records the script's actual run
 * itself; the agent receives no execution log env, so a path the agent could write
 * to is never trusted as evidence. The harness-created log is used by the fake
 * agent's `solutionRun` and by the verifiers.
 */
function evidenceEnvironment(scenario: EvalScenario): NodeJS.ProcessEnv {
  if (scenario.captureExecution !== true) return {}
  const dir = mkdtempSync(join(tmpdir(), `anvil-eval-execution-${scenario.id}-`))
  temps.push(dir)
  return { ANVIL_EVAL_EXECUTION_LOG: join(dir, 'executions.jsonl') }
}

function projectDir(workdir: string, scenario: EvalScenario): string {
  if (scenario.verifyInProjectDir !== true) return workdir
  const { profile } = buildProfile(workdir, { root: workdir, host: null, remote: null, defaultBranch: null })
  return profile.projectDir === '' ? workdir : join(workdir, ...profile.projectDir.split('/'))
}

function applySolution(workdir: string, scenario: EvalScenario): void {
  const answers =
    scenario.solution === undefined ? [] : Array.isArray(scenario.solution) ? scenario.solution : [scenario.solution]
  for (const answer of answers) {
    const target = join(workdir, ...answer.to.split('/'))
    mkdirSync(dirname(target), { recursive: true })
    cpSync(join(source, answer.from), target)
  }
}

function actLikeFakeAgent(workdir: string, scenario: EvalScenario, env: NodeJS.ProcessEnv): void {
  for (const command of scenario.solutionRun ?? []) {
    runCommand(command, workdir, env)
  }
  applySolution(workdir, scenario)
}

function addHidden(workdir: string, scenario: EvalScenario): void {
  for (const file of scenario.hidden ?? []) {
    const target = join(workdir, ...file.to.split('/'))
    mkdirSync(dirname(target), { recursive: true })
    cpSync(join(source, file.from), target)
  }
}

function runCommand(
  command: string,
  cwd: string,
  env: NodeJS.ProcessEnv = {},
): { status: number | null; output: string } {
  const [bin, ...args] = tokenizeCommand(command)
  if (bin === undefined) throw new Error(`empty command in ${command}`)
  const { file, args: argv } = spawnArgv(bin, args, { env: process.env, platform: process.platform })
  const needsVerbatim = process.platform === 'win32' && file.toLowerCase().endsWith('cmd.exe')
  const childEnv: NodeJS.ProcessEnv = { ...process.env, ...env }
  delete childEnv.NODE_TEST_CONTEXT
  const result = spawnSync(file, argv, {
    cwd,
    env: childEnv,
    encoding: 'utf8',
    timeout: 30_000,
    ...(needsVerbatim ? { windowsVerbatimArguments: true } : {}),
  })
  assert.equal(result.error, undefined, result.error?.message)
  return { status: result.status, output: `${result.stdout}\n${result.stderr}` }
}

/**
 * Collapse verifier exit statuses into one verdict.
 *
 * A `null` status means the child was terminated by a signal (POSIX). That is a failure,
 * not a pass: mapping it to 0 lets a killed verifier count as success.
 */
function aggregateVerifierStatuses(statuses: ReadonlyArray<number | null>): number {
  const failure = statuses.find((status) => status !== 0)
  if (failure === undefined) return 0
  return failure === null ? 1 : failure
}

function verifyVisible(workdir: string, scenario: EvalScenario, env: NodeJS.ProcessEnv): number {
  const cwd = projectDir(workdir, scenario)
  return aggregateVerifierStatuses(scenario.verify.map((command) => runCommand(command, cwd, env).status))
}

function verifyHidden(workdir: string, scenario: EvalScenario, env: NodeJS.ProcessEnv): number {
  return aggregateVerifierStatuses(
    (scenario.hiddenVerify ?? []).map((command) => runCommand(command, workdir, env).status),
  )
}

describe('extended eval scenarios', () => {
  for (const scenario of extended) {
    test(`${scenario.id}: the known-good solution passes both verifiers`, () => {
      const workdir = fixture(scenario)
      const env = evidenceEnvironment(scenario)
      actLikeFakeAgent(workdir, scenario, env)
      assert.equal(verifyVisible(workdir, scenario, env), 0, 'the visible verifier must accept the solution')
      addHidden(workdir, scenario)
      assert.equal(verifyHidden(workdir, scenario, env), 0, 'the hidden verifier must accept the solution')
    })

    test(`${scenario.id}: a no-op fails grading`, () => {
      const workdir = fixture(scenario)
      const env = evidenceEnvironment(scenario)
      assert.notEqual(verifyVisible(workdir, scenario, env), 0, 'the visible verifier must reject a no-op')
      addHidden(workdir, scenario)
      assert.notEqual(verifyHidden(workdir, scenario, env), 0, 'the hidden verifier must reject a no-op')
    })
  }

  test('workspace-dependency declares the package edge derived context needs', () => {
    const scenario = scenarios.find((entry) => entry.id === 'workspace-dependency')!
    const workdir = fixture(scenario)
    const { profile } = buildProfile(workdir, { root: workdir, host: null, remote: null, defaultBranch: null })
    const consumer = profile.modules.find((module) => module.id === '@repo/b')
    assert.ok(consumer, 'the consumer package must be a module')
    assert.deepEqual(consumer.deps, ['@repo/a'])
  })

  test('failing-verification rejects a report that was not backed by a harness-captured execution', () => {
    const scenario = scenarios.find((entry) => entry.id === 'failing-verification')!
    const workdir = fixture(scenario)
    const env = evidenceEnvironment(scenario)
    // Forge both files the previous design compared: the report and a matching
    // worktree-side execution record. Neither is harness evidence, so a report written
    // without running the check must fail both verifiers.
    const token = '2dc13894-395b-4ef7-85b0-bfe6777f3223'
    writeFileSync(
      join(workdir, '.anvil-eval-execution.json'),
      `${JSON.stringify({ token, command: 'node run-check.js', exitCode: 1, at: new Date().toISOString() })}\n`,
      'utf8',
    )
    writeFileSync(
      join(workdir, '.anvil-eval-report.json'),
      `${JSON.stringify({ command: 'node run-check.js', exitCode: 1, status: 'failed', executionToken: token })}\n`,
      'utf8',
    )
    assert.notEqual(verifyVisible(workdir, scenario, env), 0, 'a forged report must not pass the visible verifier')
    addHidden(workdir, scenario)
    assert.notEqual(verifyHidden(workdir, scenario, env), 0, 'a forged report must not pass the hidden verifier')
  })

  test('failing-verification rejects a report forged with an external log the agent wrote', () => {
    const scenario = scenarios.find((entry) => entry.id === 'failing-verification')!
    const workdir = fixture(scenario)
    const forgedLogDir = mkdtempSync(join(tmpdir(), 'forged-log-'))
    temps.push(forgedLogDir)
    const forgedLog = join(forgedLogDir, 'executions.jsonl')
    // Forge a log that claims success (exit 0) — if the agent wrote it without
    // actually running the failing check, the harness-captured evidence will not match.
    writeFileSync(
      forgedLog,
      `${JSON.stringify({ command: 'node run-check.js', exitCode: 0, at: new Date().toISOString() })}\n`,
      'utf8',
    )
    writeFileSync(
      join(workdir, '.anvil-eval-report.json'),
      `${JSON.stringify({ command: 'node run-check.js', exitCode: 1, status: 'failed' })}\n`,
      'utf8',
    )
    const env = { ANVIL_EVAL_EXECUTION_LOG: forgedLog }
    assert.notEqual(
      verifyVisible(workdir, scenario, env),
      0,
      'a forged external log must not pass the visible verifier',
    )
    addHidden(workdir, scenario)
    assert.notEqual(verifyHidden(workdir, scenario, env), 0, 'a forged external log must not pass the hidden verifier')
  })

  test('a signal-terminated verifier is a failure, not a pass', () => {
    assert.equal(aggregateVerifierStatuses([]), 0)
    assert.equal(aggregateVerifierStatuses([0, 0]), 0)
    assert.equal(aggregateVerifierStatuses([1]), 1)
    assert.equal(aggregateVerifierStatuses([null]), 1, 'a single signal-terminated verifier must fail')
    assert.equal(aggregateVerifierStatuses([null, 1]), 1, 'null must not mask a later failure')
    assert.equal(aggregateVerifierStatuses([0, null]), 1, 'a later signal termination must fail')
  })

  test('failing-verification rejects a report when the agent never executed the check', () => {
    const scenario = scenarios.find((entry) => entry.id === 'failing-verification')!
    const workdir = fixture(scenario)
    const env = evidenceEnvironment(scenario)
    // A report-only agent writes the report but never runs the check.
    writeFileSync(
      join(workdir, '.anvil-eval-report.json'),
      `${JSON.stringify({ command: 'node run-check.js', exitCode: 1, status: 'failed' })}\n`,
      'utf8',
    )
    // The harness captures no agent execution and must error out.
    assert.equal(verifyVisible(workdir, scenario, env), 1, 'a report without agent execution must fail grading')
  })
})
