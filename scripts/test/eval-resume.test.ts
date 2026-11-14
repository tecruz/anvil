import assert from 'node:assert/strict'
import { type ChildProcess, spawn, spawnSync } from 'node:child_process'
import { once } from 'node:events'
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

import {
  checkpointFileName,
  type EvalRunRecord,
  type EvalRunRecordResult,
  type EvalScenario,
  hashScenarioSource,
  readCheckpointDirectory,
  resultKey,
} from '../../packages/cli/src/eval-gate.ts'

interface IsolatedHarness {
  root: string
  env: NodeJS.ProcessEnv
  read: (path: string) => string
  write: (path: string, value: unknown) => void
  invoke: (...args: string[]) => { status: number | null; output: string }
  cleanup: () => void
}

/**
 * Copy the harness into a throwaway repository and isolate the child's environment.
 *
 * No checked-in evidence is ever changed, no dependency installation is needed, and every
 * invocation explicitly uses fake mode. The Git settings keep a developer's global config
 * (signing, hooks, a worktree pointer) from reaching the copied harness's commits, and all
 * temp files land under the test's runtime directory.
 */
function isolatedHarness(prefix: string): IsolatedHarness {
  const source = fileURLToPath(new URL('../../', import.meta.url))
  const workspace = mkdtempSync(join(tmpdir(), prefix))
  const root = join(workspace, 'repo')
  const runtime = join(workspace, 'runtime')
  mkdirSync(root)
  mkdirSync(runtime)
  const skip = new Set(['node_modules', 'dist', '.git'])
  for (const path of [
    'packages',
    'eval',
    'scripts/eval.ts',
    'scripts/eval-check-broker.ts',
    'scripts/build.mjs',
    'package.json',
    'package-lock.json',
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

  const gitConfig = join(workspace, 'gitconfig')
  const hooks = join(workspace, 'hooks')
  writeFileSync(gitConfig, '')
  mkdirSync(hooks)
  const env: NodeJS.ProcessEnv = { ...process.env, TMP: runtime, TEMP: runtime, TMPDIR: runtime }
  delete env.ANVIL_EVAL
  delete env.ANVIL_EVAL_FAKE_HALT_AFTER_CHECKPOINTS
  // The harness must run fixture test discovery, not inherit this parent's test context.
  delete env.NODE_TEST_CONTEXT
  for (const key of Object.keys(env)) {
    if (key.startsWith('GIT_CONFIG_KEY_') || key.startsWith('GIT_CONFIG_VALUE_')) delete env[key]
  }
  delete env.GIT_DIR
  delete env.GIT_WORK_TREE
  delete env.GIT_INDEX_FILE
  env.GIT_CONFIG_GLOBAL = gitConfig
  env.GIT_CONFIG_NOSYSTEM = '1'
  env.GIT_CONFIG_COUNT = '3'
  env.GIT_CONFIG_KEY_0 = 'commit.gpgsign'
  env.GIT_CONFIG_VALUE_0 = 'false'
  env.GIT_CONFIG_KEY_1 = 'core.hooksPath'
  env.GIT_CONFIG_VALUE_1 = hooks
  env.GIT_CONFIG_KEY_2 = 'tag.gpgsign'
  env.GIT_CONFIG_VALUE_2 = 'false'
  // The harness passes user.name/user.email with `git -c` on its own commits; this gives
  // any commit the anvil CLI makes in the child an identity without a global config.
  env.GIT_AUTHOR_NAME = 'anvil eval'
  env.GIT_AUTHOR_EMAIL = 'eval@anvil.local'
  env.GIT_COMMITTER_NAME = 'anvil eval'
  env.GIT_COMMITTER_EMAIL = 'eval@anvil.local'

  return {
    root,
    env,
    read: (path) => readFileSync(join(root, path), 'utf8'),
    write: (path, value) => writeFileSync(join(root, path), `${JSON.stringify(value, null, 2)}\n`),
    invoke: (...args) => {
      const result = spawnSync(process.execPath, ['scripts/eval.ts', '--fake-agent', ...args], {
        cwd: root,
        env,
        encoding: 'utf8',
        timeout: 300_000,
      })
      assert.equal(result.error, undefined, result.error?.message)
      return { status: result.status, output: `${result.stdout}\n${result.stderr}` }
    },
    cleanup: () => rmSync(workspace, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }),
  }
}

/** Split a run key into the fields `checkpointFileName` encodes. */
function keyFields(key: string): Pick<EvalRunRecordResult, 'scenario' | 'variant' | 'model' | 'repetition'> {
  const parts = key.split('/')
  const repetition = Number(parts.pop())
  const model = parts.pop()!
  const variant = parts.pop()! as EvalRunRecordResult['variant']
  return { scenario: parts.join('/'), variant, model, repetition }
}

/** Wait for a marker line without a fixed sleep, then leave the child running. */
function waitForMarker(
  child: ChildProcess,
  marker: RegExp,
  capture: { output: string },
  timeoutMs: number,
): Promise<void> {
  return new Promise((resolve, reject) => {
    let settled = false
    let timer: NodeJS.Timeout
    const finish = (error?: Error) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (error === undefined) resolve()
      else reject(error)
    }
    const onData = (chunk: Buffer | string) => {
      capture.output += chunk.toString()
      if (marker.test(capture.output)) finish()
    }
    timer = setTimeout(
      () => finish(new Error(`timed out after ${timeoutMs}ms waiting for ${marker}\n${capture.output}`)),
      timeoutMs,
    )
    child.stdout?.on('data', onData)
    child.stderr?.on('data', onData)
    child.on('error', (error) => finish(error))
    child.on('exit', (code, signal) =>
      finish(new Error(`exited before ${marker} (code ${code}, signal ${signal})\n${capture.output}`)),
    )
  })
}

/** Kill the child and wait for its close, so no process is touching files during cleanup. */
async function killAndWait(child: ChildProcess): Promise<void> {
  if (child.pid === undefined) return
  if (child.exitCode !== null || child.signalCode !== null) return
  const closed = once(child, 'close')
  child.kill('SIGKILL')
  await closed
}

test('fake-agent resume validates verifier evidence before recovery and preserves evidence on refusal', {
  timeout: 600_000,
}, () => {
  const harness = isolatedHarness('anvil-eval-resume-')
  try {
    // Run the real harness in an isolated copy. No checked-in evidence is ever changed,
    // no dependency installation is needed, and every invocation explicitly uses fake mode.
    const { root, read, write, invoke } = harness
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
    // The default suite is the original four-scenario smoke matrix: four scenarios, two
    // variants each. An extended scenario slipping into the default run would double the
    // scheduled benchmark's spend.
    assert.equal(complete.results.length, 8)
    assert.equal(complete.runKeys.length, 8)
    assert.equal(complete.subset, false)
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
    assert.match(invocation.output, /1 of 8 keys remain/)
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
    harness.cleanup()
  }
})

test('an interrupted fake-agent run keeps its checkpoint and resume reuses it', {
  timeout: 900_000,
}, async () => {
  const harness = isolatedHarness('anvil-eval-interrupted-')
  let child: ChildProcess | undefined
  try {
    const { root, env, read, invoke } = harness
    // A complete baseline first: the final --check then proves the resumed record is
    // certifiable against this matrix instead of bootstrapping on a missing baseline.
    const baseline = invoke('--write-baseline')
    assert.equal(baseline.status, 0, baseline.output)

    // Halt after two new checkpoints: run.json then holds the first result, while the
    // second result exists only in its checkpoint. Killing here proves recovery from the
    // checkpoint rather than from a partially written record.
    const capture = { output: '' }
    child = spawn(process.execPath, ['scripts/eval.ts', '--fake-agent'], {
      cwd: root,
      env: { ...env, ANVIL_EVAL_FAKE_HALT_AFTER_CHECKPOINTS: '2' },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    const marker = /anvil-eval: halted after checkpoint (.+?)\r?\n/
    await waitForMarker(child, marker, capture, 240_000)
    const match = capture.output.match(marker)
    assert.ok(match !== null, capture.output)
    const haltedKey = match[1]!
    // SIGKILL is TerminateProcess on Windows and immediate on POSIX; either way the child
    // has exited before any file below is read.
    await killAndWait(child)
    child = undefined

    const interrupted = JSON.parse(read('eval-results/run.json')) as EvalRunRecord
    assert.equal(interrupted.completionState, 'in-progress')
    assert.equal(interrupted.completedAt, null)
    assert.equal(interrupted.runKeys.length, 8)
    assert.equal(haltedKey, interrupted.runKeys[1])
    assert.equal(interrupted.results.length, 1)
    assert.deepEqual(interrupted.results.map(resultKey), [interrupted.runKeys[0]])
    assert.equal(interrupted.executionOrder.includes(haltedKey), false)

    const directory = join(root, 'eval-results', 'checkpoints', interrupted.runId)
    const checkpointRead = readCheckpointDirectory(directory)
    assert.deepEqual(checkpointRead.rejected, [])
    assert.equal(checkpointRead.entries.length, 2)
    assert.deepEqual(
      checkpointRead.entries.map((entry) => resultKey(entry.result)).sort(),
      [...interrupted.runKeys.slice(0, 2)].sort(),
    )

    const haltedPath = join(directory, checkpointFileName(keyFields(haltedKey)))
    assert.ok(existsSync(haltedPath), `${haltedPath} must survive the interruption`)
    const checkpoint = JSON.parse(readFileSync(haltedPath, 'utf8')) as EvalRunRecordResult
    assert.equal(resultKey(checkpoint), haltedKey)
    assert.equal(checkpoint.attempts.length, 1)
    assert.equal(checkpoint.attempts[0]!.state, 'completed')
    // The completed atomic writes left no temp file behind, and the kill did not add one.
    assert.deepEqual(
      readdirSync(directory).filter((name) => name.startsWith('.tmp-')),
      [],
    )

    // Resume without the halt hook: it must adopt the checkpoint instead of rerunning it.
    const resumedInvocation = invoke('--resume')
    assert.equal(resumedInvocation.status, 0, resumedInvocation.output)
    assert.match(resumedInvocation.output, /Recovered completed checkpoints for run /)
    assert.match(
      resumedInvocation.output,
      new RegExp(`${interrupted.runKeys.length - 2} of ${interrupted.runKeys.length} keys remain`),
    )

    const resumed = JSON.parse(read('eval-results/run.json')) as EvalRunRecord
    assert.equal(resumed.runId, interrupted.runId)
    assert.equal(resumed.completionState, 'completed')
    assert.equal(resumed.completedAt !== null, true)
    assert.equal(resumed.results.length, 8)
    const matches = resumed.results.filter((result) => resultKey(result) === haltedKey)
    assert.equal(matches.length, 1)
    const reused = matches[0]!
    // The same attempt timestamps prove the checkpoint was reused, not rerun.
    assert.equal(reused.attempts.length, 1)
    assert.equal(reused.attempts[0]!.startedAt, checkpoint.attempts[0]!.startedAt)
    assert.equal(reused.attempts[0]!.completedAt, checkpoint.attempts[0]!.completedAt)
    assert.equal(reused.durationMs, checkpoint.durationMs)

    const check = invoke('--check')
    assert.equal(check.status, 0, check.output)
    assert.doesNotMatch(check.output, /No eval baseline exists yet/)
  } finally {
    if (child !== undefined) await killAndWait(child)
    harness.cleanup()
  }
})
