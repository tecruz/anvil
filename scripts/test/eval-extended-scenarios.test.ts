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

function addHidden(workdir: string, scenario: EvalScenario): void {
  for (const file of scenario.hidden ?? []) {
    const target = join(workdir, ...file.to.split('/'))
    mkdirSync(dirname(target), { recursive: true })
    cpSync(join(source, file.from), target)
  }
}

function runCommand(command: string, cwd: string): { status: number | null; output: string } {
  const [bin, ...args] = tokenizeCommand(command)
  if (bin === undefined) throw new Error(`empty command in ${command}`)
  const { file, args: argv } = spawnArgv(bin, args, { env: process.env, platform: process.platform })
  const needsVerbatim = process.platform === 'win32' && file.toLowerCase().endsWith('cmd.exe')
  const env = { ...process.env }
  delete env.NODE_TEST_CONTEXT
  const result = spawnSync(file, argv, {
    cwd,
    env,
    encoding: 'utf8',
    timeout: 30_000,
    ...(needsVerbatim ? { windowsVerbatimArguments: true } : {}),
  })
  assert.equal(result.error, undefined, result.error?.message)
  return { status: result.status, output: `${result.stdout}\n${result.stderr}` }
}

function verifyVisible(workdir: string, scenario: EvalScenario): number | null {
  const cwd = projectDir(workdir, scenario)
  return scenario.verify.map((command) => runCommand(command, cwd).status).find((status) => status !== 0) ?? 0
}

function verifyHidden(workdir: string, scenario: EvalScenario): number | null {
  return (
    (scenario.hiddenVerify ?? [])
      .map((command) => runCommand(command, workdir).status)
      .find((status) => status !== 0) ?? 0
  )
}

describe('extended eval scenarios', () => {
  for (const scenario of extended) {
    test(`${scenario.id}: the known-good solution passes both verifiers`, () => {
      const workdir = fixture(scenario)
      applySolution(workdir, scenario)
      assert.equal(verifyVisible(workdir, scenario), 0, 'the visible verifier must accept the solution')
      addHidden(workdir, scenario)
      assert.equal(verifyHidden(workdir, scenario), 0, 'the hidden verifier must accept the solution')
    })

    test(`${scenario.id}: a no-op fails grading`, () => {
      const workdir = fixture(scenario)
      assert.notEqual(verifyVisible(workdir, scenario), 0, 'the visible verifier must reject a no-op')
      addHidden(workdir, scenario)
      assert.notEqual(verifyHidden(workdir, scenario), 0, 'the hidden verifier must reject a no-op')
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

  test('failing-verification rejects a report that was not backed by an execution', () => {
    const scenario = scenarios.find((entry) => entry.id === 'failing-verification')!
    const workdir = fixture(scenario)
    writeFileSync(
      join(workdir, '.anvil-eval-report.json'),
      `${JSON.stringify({ command: 'node run-check.js', exitCode: 1, status: 'failed', executionToken: 'fabricated' })}\n`,
      'utf8',
    )
    assert.notEqual(verifyVisible(workdir, scenario), 0, 'a fabricated report must not pass the visible verifier')
    addHidden(workdir, scenario)
    assert.notEqual(verifyHidden(workdir, scenario), 0, 'a fabricated report must not pass the hidden verifier')
  })
})
