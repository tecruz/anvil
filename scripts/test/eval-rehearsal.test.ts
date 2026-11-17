import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, dirname, join } from 'node:path'
import { after, describe, test } from 'node:test'
import { fileURLToPath } from 'node:url'

import { checkpointFileName } from '../../packages/cli/src/eval-gate.ts'
import { assertGateRejection, validateRehearsalArtifacts } from '../eval-rehearsal.ts'

const source = fileURLToPath(new URL('../../', import.meta.url))
const temps: string[] = []

after(() => {
  for (const dir of temps) rmSync(dir, { recursive: true, force: true })
})

function temp(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  temps.push(dir)
  return dir
}

interface FixtureResult {
  scenario: string
  variant: 'bare' | 'anvil'
  model: string
  repetition: number
}

interface FixtureRun {
  schemaVersion: number
  runId: string
  runKeys: string[]
  results: FixtureResult[]
}

function keyOf(result: FixtureResult): string {
  return `${result.scenario}/${result.variant}/${result.model}/${result.repetition}`
}

function fixtureRun(): FixtureRun {
  const results: FixtureResult[] = [
    { scenario: 'tiny-code-change', variant: 'bare', model: 'fake-agent', repetition: 0 },
    { scenario: 'tiny-code-change', variant: 'anvil', model: 'fake-agent', repetition: 0 },
  ]
  return {
    schemaVersion: 3,
    runId: 'run-1',
    runKeys: results.map(keyOf),
    results,
  }
}

function writeJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`)
}

function writeFixture(run: FixtureRun): { root: string; checkpointDir: string } {
  const root = temp('anvil-eval-rehearsal-')
  const checkpointDir = join(root, 'eval-results', 'checkpoints', run.runId)
  writeJson(join(root, 'eval-results', 'failure-rehearsal.json'), { expectedGate: 'reject', runId: run.runId })
  writeFileSync(
    join(root, 'eval-results', 'gate-rejection.log'),
    'eval gate failed:\n  - tiny-code-change: a run did not pass the visible verifier\n',
  )
  writeJson(join(root, 'eval-results', 'run.json'), run)
  writeJson(join(root, 'eval-results', 'runs', `${run.runId}.json`), run)
  for (const result of run.results) {
    writeJson(join(checkpointDir, checkpointFileName(result)), { schemaVersion: run.schemaVersion, ...result })
  }
  return { root, checkpointDir }
}

describe('failure rehearsal artifacts', () => {
  test('accepts a complete run and returns what it checked', () => {
    const { root } = writeFixture(fixtureRun())
    assert.deepEqual(validateRehearsalArtifacts(root), { files: 3, checkpoints: 2 })
  })

  test('rejects a missing or empty required file', () => {
    const { root } = writeFixture(fixtureRun())
    rmSync(join(root, 'eval-results', 'gate-rejection.log'))
    assert.throws(
      () => validateRehearsalArtifacts(root),
      /missing or empty required artifact: eval-results\/gate-rejection\.log/,
    )
  })

  test('rejects a rehearsal record that names another run', () => {
    const { root } = writeFixture(fixtureRun())
    writeJson(join(root, 'eval-results', 'failure-rehearsal.json'), { expectedGate: 'reject', runId: 'other' })
    assert.throws(() => validateRehearsalArtifacts(root), /rehearsal record does not describe this run/)
  })

  test('rejects a run archive that names another run', () => {
    const run = fixtureRun()
    const { root } = writeFixture(run)
    writeJson(join(root, 'eval-results', 'runs', `${run.runId}.json`), { runId: 'other' })
    assert.throws(() => validateRehearsalArtifacts(root), /run archive names another run/)
  })

  test('rejects a missing checkpoint', () => {
    const run = fixtureRun()
    const { root, checkpointDir } = writeFixture(run)
    rmSync(join(checkpointDir, checkpointFileName(run.results[0] as FixtureResult)))
    assert.throws(() => validateRehearsalArtifacts(root), /expected 2 checkpoints, found 1/)
  })

  test('rejects an extra checkpoint', () => {
    const { root, checkpointDir } = writeFixture(fixtureRun())
    writeJson(join(checkpointDir, 'unexpected.json'), {})
    assert.throws(() => validateRehearsalArtifacts(root), /expected 2 checkpoints, found 3/)
  })

  test('rejects an empty checkpoint', () => {
    const run = fixtureRun()
    const { root, checkpointDir } = writeFixture(run)
    writeFileSync(join(checkpointDir, checkpointFileName(run.results[0] as FixtureResult)), '')
    assert.throws(() => validateRehearsalArtifacts(root), /missing or empty checkpoint/)
  })

  test('rejects a malformed checkpoint', () => {
    const run = fixtureRun()
    const { root, checkpointDir } = writeFixture(run)
    writeFileSync(join(checkpointDir, checkpointFileName(run.results[0] as FixtureResult)), '{')
    assert.throws(() => validateRehearsalArtifacts(root), /JSON|Expected|Unexpected/)
  })

  test('rejects a checkpoint naming another result', () => {
    const run = fixtureRun()
    const { root, checkpointDir } = writeFixture(run)
    const fileName = checkpointFileName(run.results[0] as FixtureResult)
    const checkpoint = JSON.parse(readFileSync(join(checkpointDir, fileName), 'utf8')) as Record<string, unknown>
    checkpoint.variant = 'anvil'
    writeJson(join(checkpointDir, fileName), checkpoint)
    assert.throws(() => validateRehearsalArtifacts(root), /does not describe the run result it names/)
  })

  test('rejects a checkpoint with the wrong schema version', () => {
    const run = fixtureRun()
    const { root, checkpointDir } = writeFixture(run)
    const fileName = checkpointFileName(run.results[0] as FixtureResult)
    const checkpoint = JSON.parse(readFileSync(join(checkpointDir, fileName), 'utf8')) as Record<string, unknown>
    checkpoint.schemaVersion = 1
    writeJson(join(checkpointDir, fileName), checkpoint)
    assert.throws(() => validateRehearsalArtifacts(root), /does not describe the run result it names/)
  })

  test('rejects results that do not cover the declared run keys', () => {
    const run = fixtureRun()
    run.runKeys[0] = 'a-different-key'
    const { root } = writeFixture(run)
    assert.throws(() => validateRehearsalArtifacts(root), /run record results do not cover the declared run keys/)
  })

  test('rejects duplicate result identities', () => {
    const run = fixtureRun()
    run.results[1] = { ...run.results[0] } as FixtureResult
    run.runKeys[1] = run.runKeys[0] as string
    const { root, checkpointDir } = writeFixture(run)
    // The duplicate result overwrote the first checkpoint file, so add one more to keep the
    // count equal and reach the duplicate-identity check rather than the count check.
    writeJson(join(checkpointDir, 'unrelated.json'), {})
    assert.throws(() => validateRehearsalArtifacts(root), /duplicate run result for checkpoint/)
  })
})

describe('failure rehearsal gate assertion', () => {
  const diagnostic = 'eval gate failed:\n  - tiny-code-change: a run did not pass the visible verifier\n'
  const logPath = (): string => join(temp('anvil-eval-gate-'), 'gate-rejection.log')

  test('accepts exit 1 with the targeted diagnostic', () => {
    const path = logPath()
    const outcome = assertGateRejection({
      logPath: path,
      run: () => ({ status: 1, output: diagnostic }),
    })
    assert.equal(outcome.status, 1)
    assert.match(readFileSync(path, 'utf8'), /tiny-code-change: a run did not pass the visible verifier/)
  })

  test('rejects a gate that accepted the tampering', () => {
    assert.throws(
      () =>
        assertGateRejection({
          logPath: logPath(),
          report: () => {},
          run: () => ({ status: 0, output: 'eval gate passed: every scenario met its baseline.\n' }),
        }),
      /expected the hermetic gate to exit 1 for tampered evidence, got 0\./,
    )
  })

  test('rejects a crash', () => {
    assert.throws(
      () =>
        assertGateRejection({ logPath: logPath(), report: () => {}, run: () => ({ status: 2, output: diagnostic }) }),
      /expected the hermetic gate to exit 1 for tampered evidence, got 2\./,
    )
  })

  test('rejects a missing command', () => {
    assert.throws(
      () => assertGateRejection({ logPath: logPath(), report: () => {}, run: () => ({ status: null, output: '' }) }),
      /expected the hermetic gate to exit 1 for tampered evidence, got null\./,
    )
  })

  test('rejects a failure without the targeted diagnostic', () => {
    assert.throws(
      () =>
        assertGateRejection({
          logPath: logPath(),
          report: () => {},
          run: () => ({
            status: 1,
            output: 'eval gate failed:\n  - medium-code-change: a run did not pass the visible verifier\n',
          }),
        }),
      /the gate failed without the expected tampered-evidence diagnostic/,
    )
  })
})

const rehearsalScript = join(source, 'scripts', 'eval-rehearsal.ts')

/** Run the real CLI with a controlled working directory and environment. */
function runCli(root: string, command: string, env: NodeJS.ProcessEnv = {}) {
  const result = spawnSync(process.execPath, [rehearsalScript, command], {
    cwd: root,
    env: { ...process.env, ...env },
    encoding: 'utf8',
    timeout: 30_000,
  })
  assert.equal(result.error, undefined, result.error?.message)
  return result
}

/**
 * Put a fake `npm` first on PATH.
 *
 * The real runner only shells out to `npm run eval:check`; this keeps the subprocess tests
 * hermetic while still exercising the runner's stream capture and status handling.
 */
function writeFakeNpm(dir: string): void {
  if (process.platform === 'win32') {
    writeFileSync(
      join(dir, 'npm.cmd'),
      [
        '@echo off',
        'if "%MOCK_NPM_STREAM%"=="stdout" goto stdout',
        'echo %MOCK_NPM_OUTPUT% 1>&2',
        'goto done',
        ':stdout',
        'echo %MOCK_NPM_OUTPUT%',
        ':done',
        'exit /b %MOCK_NPM_STATUS%',
        '',
      ].join('\r\n'),
    )
    return
  }
  writeFileSync(
    join(dir, 'npm'),
    [
      '#!/bin/sh',
      'if [ "$MOCK_NPM_STREAM" = "stdout" ]; then',
      '  printf \'%s\\n\' "$MOCK_NPM_OUTPUT"',
      'else',
      '  printf \'%s\\n\' "$MOCK_NPM_OUTPUT" >&2',
      'fi',
      'exit "$MOCK_NPM_STATUS"',
      '',
    ].join('\n'),
    { encoding: 'utf8', mode: 0o755 },
  )
}

function gateWorkspace(): { root: string; bin: string } {
  const root = temp('anvil-eval-rehearsal-cli-')
  mkdirSync(join(root, 'eval-results'), { recursive: true })
  const bin = temp('anvil-eval-fake-npm-')
  writeFakeNpm(bin)
  return { root, bin }
}

function gateEnv(
  bin: string,
  status: number,
  output: string,
  stream: 'stdout' | 'stderr' = 'stderr',
): NodeJS.ProcessEnv {
  return {
    PATH: `${bin}${delimiter}${process.env.PATH ?? ''}`,
    MOCK_NPM_STATUS: String(status),
    MOCK_NPM_OUTPUT: output,
    MOCK_NPM_STREAM: stream,
  }
}

describe('failure rehearsal CLI', () => {
  const diagnostic = 'eval gate failed: tiny-code-change: a run did not pass the visible verifier'

  test('assert-gate accepts the diagnostic from either stream', () => {
    for (const stream of ['stderr', 'stdout'] as const) {
      const { root, bin } = gateWorkspace()
      const result = runCli(root, 'assert-gate', gateEnv(bin, 1, diagnostic, stream))
      assert.equal(result.status, 0, result.stdout + result.stderr)
      assert.match(
        readFileSync(join(root, 'eval-results', 'gate-rejection.log'), 'utf8'),
        /tiny-code-change: a run did not pass the visible verifier/,
      )
    }
  })

  test('assert-gate reports a gate that accepted the tampering', () => {
    const { root, bin } = gateWorkspace()
    const result = runCli(root, 'assert-gate', gateEnv(bin, 0, 'eval gate passed', 'stdout'))
    assert.equal(result.status, 1)
    assert.match(result.stderr, /::error::expected the hermetic gate to exit 1 for tampered evidence, got 0\./)
  })

  test('assert-gate reports a crash and a missing command', () => {
    for (const status of [2, 127]) {
      const { root, bin } = gateWorkspace()
      const result = runCli(root, 'assert-gate', gateEnv(bin, status, diagnostic))
      assert.equal(result.status, 1)
      assert.match(
        result.stderr,
        new RegExp(`::error::expected the hermetic gate to exit 1 for tampered evidence, got ${status}\\.`),
      )
    }
  })

  test('assert-gate rejects a failure with an unrelated diagnostic', () => {
    const { root, bin } = gateWorkspace()
    const result = runCli(
      root,
      'assert-gate',
      gateEnv(bin, 1, 'eval gate failed: medium-code-change: a run did not pass the visible verifier'),
    )
    assert.equal(result.status, 1)
    assert.match(result.stderr, /::error::the gate failed without the expected tampered-evidence diagnostic/)
  })

  test('validate-artifacts accepts complete evidence and reports missing evidence', () => {
    const { root } = writeFixture(fixtureRun())
    let result = runCli(root, 'validate-artifacts')
    assert.equal(result.status, 0, result.stdout + result.stderr)
    assert.match(result.stdout, /Validated 3 files, the run archive and 2 checkpoints/)

    rmSync(join(root, 'eval-results', 'gate-rejection.log'))
    result = runCli(root, 'validate-artifacts')
    assert.equal(result.status, 1)
    assert.match(result.stderr, /::error::missing or empty required artifact: eval-results\/gate-rejection\.log/)
  })

  test('an unknown command is a usage error', () => {
    const { root } = gateWorkspace()
    const result = runCli(root, 'not-a-check')
    assert.equal(result.status, 2)
    assert.match(result.stderr, /usage: node scripts\/eval-rehearsal\.ts/)
  })
})

test('the rehearsal workflow runs the tested checks', () => {
  const workflow = readFileSync(join(source, '.github', 'workflows', 'eval.yml'), 'utf8')
  assert.match(workflow, /run: node scripts\/eval-rehearsal\.ts assert-gate/)
  assert.match(workflow, /run: node scripts\/eval-rehearsal\.ts validate-artifacts/)
})
