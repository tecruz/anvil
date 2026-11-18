import assert from 'node:assert/strict'
import { type ChildProcess, spawn, spawnSync } from 'node:child_process'
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
  latestAttemptState,
  readCheckpointDirectory,
  resultKey,
} from '../../packages/cli/src/eval-gate.ts'

interface Invocation {
  status: number | null
  output: string
}

interface IsolatedHarness {
  root: string
  env: NodeJS.ProcessEnv
  read: (path: string) => string
  write: (path: string, value: unknown) => void
  invoke: (...args: string[]) => Invocation
  /** Invoke with an explicit cap, for a test that shares one deadline across steps. */
  invokeWithin: (timeoutMs: number, ...args: string[]) => Invocation
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

  function invokeWithin(timeoutMs: number, ...args: string[]): Invocation {
    const result = spawnSync(process.execPath, ['scripts/eval.ts', '--fake-agent', ...args], {
      cwd: root,
      env,
      encoding: 'utf8',
      timeout: timeoutMs,
    })
    assert.equal(result.error, undefined, result.error?.message)
    return { status: result.status, output: `${result.stdout}\n${result.stderr}` }
  }

  return {
    root,
    env,
    read: (path) => readFileSync(join(root, path), 'utf8'),
    write: (path, value) => writeFileSync(join(root, path), `${JSON.stringify(value, null, 2)}\n`),
    invoke: (...args) => invokeWithin(300_000, ...args),
    invokeWithin,
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

/**
 * A child whose `close` is captured immediately after spawn.
 *
 * `close` can be emitted before the test gets around to killing or reaping the child, so a
 * later `once(child, 'close')` can wait forever. Capturing the promise at spawn time makes
 * the wait independent of how much of the child's earlier lifecycle has already happened.
 */
interface TrackedChild {
  child: ChildProcess
  closed: Promise<void>
}

function spawnTracked(command: string, args: string[], options: Parameters<typeof spawn>[2]): TrackedChild {
  const child = spawn(command, args, options)
  return { child, closed: new Promise((resolve) => child.once('close', () => resolve())) }
}

/** Kill the child and wait, bounded, for its close, so no process touches files during cleanup. */
async function killAndWait(tracked: TrackedChild, timeoutMs: number): Promise<void> {
  const { child, closed } = tracked
  // A child that already exited still needs its close waited for: stdio streams are closed
  // only then, and the fixture is not safe to read or delete until they are.
  if (child.pid !== undefined && child.exitCode === null && child.signalCode === null) {
    child.kill('SIGKILL')
  }
  let timer: NodeJS.Timeout | undefined
  const timedOut = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(
      () =>
        reject(
          new Error(
            `timed out after ${timeoutMs}ms waiting for child ${child.pid ?? '(no pid)'} to close after SIGKILL (exit code ${child.exitCode}, signal ${child.signalCode})`,
          ),
        ),
      timeoutMs,
    )
  })
  try {
    await Promise.race([closed, timedOut])
  } finally {
    clearTimeout(timer)
  }
}

/**
 * A shared budget for a multi-step test.
 *
 * Each step's preference is clamped to the time left, so the steps cannot add up to more
 * than the budget. Without this, four independent caps of 300s, 240s, 300s and 300s can
 * outlive the test runner's own timeout, and the test dies with no useful failure message.
 */
interface Deadline {
  step: (preferredMs: number, label: string) => number
}

function budget(budgetMs: number): Deadline {
  const deadline = Date.now() + budgetMs
  return {
    step(preferredMs, label) {
      const remaining = deadline - Date.now()
      if (remaining <= 0) throw new Error(`the test's ${budgetMs}ms budget was spent before ${label}`)
      return Math.min(preferredMs, remaining)
    },
  }
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

test('resume keeps a failed attempt as a scored failure instead of retrying it', { timeout: 600_000 }, () => {
  const harness = isolatedHarness('anvil-eval-resume-failed-')
  try {
    const { read, write, invoke } = harness
    const baseline = invoke('--write-baseline')
    assert.equal(baseline.status, 0, baseline.output)

    const complete = JSON.parse(read('eval-results/run.json')) as EvalRunRecord
    const failed = structuredClone(complete)
    const target = failed.results[0]!
    target.verified = false
    target.error = 'agent exited 1'
    target.attempts = [
      {
        ...target.attempts[0]!,
        state: 'failed',
        error: 'agent exited 1',
      },
    ]
    failed.completionState = 'in-progress'
    failed.completedAt = null
    const targetKey = resultKey(target)
    const latestBefore = read('eval-results/latest.json')
    write('eval-results/run.json', failed)

    const resumed = invoke('--resume')
    assert.equal(resumed.status, 0, resumed.output)
    assert.match(resumed.output, /already settled all 8 keys/)
    assert.match(resumed.output, /1 failed key\(s\) remain scored failures and will not be retried/)
    assert.match(resumed.output, /agent exited 1/)
    assert.match(resumed.output, /finished in state partial/)

    const after = JSON.parse(read('eval-results/run.json')) as EvalRunRecord
    assert.equal(after.completionState, 'partial')
    const scored = after.results.find((entry) => resultKey(entry) === targetKey)
    assert.ok(scored !== undefined)
    assert.equal(scored.attempts.length, 1)
    assert.equal(scored.attempts[0]!.state, 'failed')
    assert.equal(scored.error, 'agent exited 1')
    assert.equal(scored.verified, false)
    assert.equal(read('eval-results/latest.json'), latestBefore)

    const check = invoke('--check')
    assert.equal(check.status, 0, check.output)
  } finally {
    harness.cleanup()
  }
})

test('resume recovers a failure that exists only in a checkpoint and runs the remaining work', {
  timeout: 600_000,
}, () => {
  const harness = isolatedHarness('anvil-eval-resume-checkpoint-only-failure-')
  try {
    const { read, write, invoke } = harness
    const baseline = invoke('--write-baseline')
    assert.equal(baseline.status, 0, baseline.output)

    const complete = JSON.parse(read('eval-results/run.json')) as EvalRunRecord
    // Build the state from the baseline record: two results are missing from run.json, and
    // one of them exists only as a failed checkpoint. At least one other declared key is
    // still missing, so resume has genuine work to do besides the failure.
    const failedOnly = complete.results[0]!
    const missingOnly = complete.results[1]!
    // The baseline run leaves a checkpoint for every key. Drop them, so the only checkpoint
    // left is the failure this test writes; otherwise recovery would settle everything.
    rmSync(join(harness.root, 'eval-results', 'checkpoints', complete.runId), {
      recursive: true,
      force: true,
    })
    mkdirSync(join(harness.root, 'eval-results', 'checkpoints', complete.runId), { recursive: true })
    const partial = structuredClone(complete)
    partial.results = partial.results.filter((entry) => resultKey(entry) !== resultKey(failedOnly))
    partial.results = partial.results.filter((entry) => resultKey(entry) !== resultKey(missingOnly))
    partial.executionOrder = partial.executionOrder.filter(
      (key) => key !== resultKey(failedOnly) && key !== resultKey(missingOnly),
    )
    partial.completionState = 'in-progress'
    partial.completedAt = null
    write('eval-results/run.json', partial)

    const failedCheckpoint = structuredClone(failedOnly)
    failedCheckpoint.verified = false
    failedCheckpoint.error = 'agent exited 1'
    failedCheckpoint.attempts = [
      {
        ...failedCheckpoint.attempts[0]!,
        state: 'failed',
        error: 'agent exited 1',
      },
    ]
    const checkpointPath = join('eval-results', 'checkpoints', complete.runId, checkpointFileName(failedCheckpoint))
    write(checkpointPath, { schemaVersion: 3, ...failedCheckpoint })
    const latestBefore = read('eval-results/latest.json')

    const resumed = invoke('--resume')
    assert.equal(resumed.status, 0, resumed.output)
    assert.match(resumed.output, /1 of 8 keys remain/)
    assert.match(resumed.output, /agent exited 1/)
    assert.match(resumed.output, /finished in state partial/)
    assert.match(resumed.output, /1 failed key\(s\) remain scored failures and will not be retried/)

    const after = JSON.parse(read('eval-results/run.json')) as EvalRunRecord
    assert.equal(after.completionState, 'partial')
    const failed = after.results.find((entry) => resultKey(entry) === resultKey(failedOnly))
    assert.ok(failed !== undefined)
    // The failure came from the checkpoint and was never retried: one attempt, still failed.
    assert.equal(failed.attempts.length, 1)
    assert.equal(failed.attempts[0]!.state, 'failed')
    assert.equal(failed.attempts[0]!.startedAt, failedCheckpoint.attempts[0]!.startedAt)
    assert.equal(failed.error, 'agent exited 1')
    assert.equal(failed.verified, false)
    // The genuinely missing key was run, and only that key.
    const recovered = after.results.find((entry) => resultKey(entry) === resultKey(missingOnly))
    assert.ok(recovered !== undefined)
    assert.equal(latestAttemptState(recovered), 'completed')
    assert.equal(after.results.length, complete.results.length)
    assert.equal(read('eval-results/latest.json'), latestBefore)

    const check = invoke('--check')
    assert.equal(check.status, 0, check.output)
  } finally {
    harness.cleanup()
  }
})

test('resume refuses an unreadable checkpoint whose key is not settled', { timeout: 600_000 }, () => {
  const harness = isolatedHarness('anvil-eval-resume-unreadable-')
  try {
    const { read, invoke } = harness
    const baseline = invoke('--write-baseline')
    assert.equal(baseline.status, 0, baseline.output)

    const complete = JSON.parse(read('eval-results/run.json')) as EvalRunRecord
    const target = complete.results[0]!
    const partial = structuredClone(complete)
    partial.results = partial.results.filter((entry) => resultKey(entry) !== resultKey(target))
    partial.executionOrder = partial.executionOrder.filter((key) => key !== resultKey(target))
    partial.completionState = 'in-progress'
    partial.completedAt = null
    harness.write('eval-results/run.json', partial)
    const recordBefore = read('eval-results/run.json')
    const latestBefore = read('eval-results/latest.json')
    const archivePath = `eval-results/runs/${complete.runId}.json`
    const archiveBefore = read(archivePath)

    // The filename is the checkpoint for a declared key that is not settled, so ignoring the
    // unreadable file would silently rerun work the run may already have done.
    writeFileSync(
      join(harness.root, 'eval-results', 'checkpoints', complete.runId, checkpointFileName(target)),
      '{ not json',
      'utf8',
    )

    const refused = invoke('--resume')
    assert.equal(refused.status, 1, refused.output)
    assert.match(refused.output, /is unreadable/)
    assert.match(refused.output, /not settled/)
    assert.equal(read('eval-results/run.json'), recordBefore)
    assert.equal(read('eval-results/latest.json'), latestBefore)
    assert.equal(read(archivePath), archiveBefore)

    // An unreadable file whose name does not map to a declared key cannot cause a rerun, so
    // it is ignored. Over-refusing here would make one stray temp file block every resume.
    rmSync(join(harness.root, 'eval-results', 'checkpoints', complete.runId, checkpointFileName(target)))
    writeFileSync(
      join(harness.root, 'eval-results', 'checkpoints', complete.runId, 'not-a-declared-key.json'),
      '{ not json',
      'utf8',
    )
    const resumed = invoke('--resume')
    assert.equal(resumed.status, 0, resumed.output)
    assert.match(resumed.output, /Ignoring checkpoint not-a-declared-key\.json/)
    const after = JSON.parse(read('eval-results/run.json')) as EvalRunRecord
    assert.equal(
      latestAttemptState(after.results.find((entry) => resultKey(entry) === resultKey(target))!),
      'completed',
    )

    // The same file for a key the record already settled cannot cause a rerun either, so it
    // stays a warning rather than a refusal.
    const settledKey = after.results[0]!
    writeFileSync(
      join(harness.root, 'eval-results', 'checkpoints', complete.runId, checkpointFileName(settledKey)),
      '{ not json',
      'utf8',
    )
    const settledRead = invoke('--resume')
    assert.equal(settledRead.status, 0, settledRead.output)
    assert.match(settledRead.output, new RegExp(`Ignoring checkpoint ${checkpointFileName(settledKey)}`))
  } finally {
    harness.cleanup()
  }
})

test('resume refuses a checkpoint that would replace a recorded failure', { timeout: 600_000 }, () => {
  const harness = isolatedHarness('anvil-eval-resume-conflict-')
  try {
    const { read, invoke } = harness
    const baseline = invoke('--write-baseline')
    assert.equal(baseline.status, 0, baseline.output)

    const complete = JSON.parse(read('eval-results/run.json')) as EvalRunRecord
    const completed = complete.results[0]!
    const failed = structuredClone(complete)
    const target = failed.results[0]!
    target.verified = false
    target.error = 'agent exited 1'
    target.attempts = [{ ...target.attempts[0]!, state: 'failed', error: 'agent exited 1' }]
    failed.completionState = 'in-progress'
    failed.completedAt = null
    harness.write('eval-results/run.json', failed)
    const recordBefore = read('eval-results/run.json')
    const latestBefore = read('eval-results/latest.json')

    // A completed checkpoint for a key the record already settled as failed. It reports a
    // later attempt than run.json's failed one, so it is not the stale file written before
    // that failure: a terminal failure is final, and resuming must refuse rather than adopt
    // the success or silently drop it.
    const retried = structuredClone(completed)
    retried.attempts = [
      {
        startedAt: '2026-11-18T00:09:00.000Z',
        completedAt: '2026-11-18T00:09:30.000Z',
        state: 'completed',
      },
    ]
    harness.write(join('eval-results', 'checkpoints', complete.runId, checkpointFileName(retried)), {
      schemaVersion: 3,
      ...retried,
    })

    const refused = invoke('--resume')
    assert.equal(refused.status, 1, refused.output)
    assert.match(refused.output, /checkpoints disagree/)
    assert.match(refused.output, /checkpoint is completed but run\.json recorded failed/)
    assert.equal(read('eval-results/run.json'), recordBefore)
    assert.equal(read('eval-results/latest.json'), latestBefore)
    const after = JSON.parse(read('eval-results/run.json')) as EvalRunRecord
    assert.equal(latestAttemptState(after.results[0]!), 'failed')
  } finally {
    harness.cleanup()
  }
})

test('resume refuses a run record with a result it never declared', { timeout: 600_000 }, () => {
  const harness = isolatedHarness('anvil-eval-resume-undeclared-')
  try {
    const { read, invoke } = harness
    const baseline = invoke('--write-baseline')
    assert.equal(baseline.status, 0, baseline.output)

    const complete = JSON.parse(read('eval-results/run.json')) as EvalRunRecord
    const undeclared = structuredClone(complete.results[0]!)
    undeclared.repetition = 9
    const corrupt = structuredClone(complete)
    corrupt.results.push(undeclared)
    corrupt.completionState = 'in-progress'
    corrupt.completedAt = null
    harness.write('eval-results/run.json', corrupt)
    const recordBefore = read('eval-results/run.json')
    const latestBefore = read('eval-results/latest.json')

    const refused = invoke('--resume')
    assert.equal(refused.status, 1, refused.output)
    assert.match(refused.output, /which it did not declare; cannot resume/)
    assert.equal(read('eval-results/run.json'), recordBefore)
    assert.equal(read('eval-results/latest.json'), latestBefore)
  } finally {
    harness.cleanup()
  }
})

test('a fresh run archives an unfinished record before starting a new one', { timeout: 600_000 }, () => {
  const harness = isolatedHarness('anvil-eval-fresh-archive-')
  try {
    const { read, invoke } = harness
    const baseline = invoke('--write-baseline')
    assert.equal(baseline.status, 0, baseline.output)

    const complete = JSON.parse(read('eval-results/run.json')) as EvalRunRecord
    const partial = structuredClone(complete)
    // A partial run has its own id and was never archived: only a completed run is archived
    // when it is promoted. Give it a fresh id so this test does not reuse the baseline's.
    partial.runId = 'partial-run-before-fresh'
    partial.results = partial.results.slice(0, 1)
    partial.executionOrder = partial.executionOrder.slice(0, 1)
    partial.completionState = 'partial'
    partial.completedAt = null
    harness.write('eval-results/run.json', partial)
    assert.equal(existsSync(join(harness.root, 'eval-results', 'runs', `${partial.runId}.json`)), false)

    const fresh = invoke()
    assert.equal(fresh.status, 0, fresh.output)
    assert.match(fresh.output, new RegExp(`Archived previous partial run ${partial.runId}`))

    // The partial record keeps its scored work under its own run id, and its archive is a
    // byte-for-byte copy of what run.json held before the fresh run replaced it.
    const archived = JSON.parse(
      readFileSync(join(harness.root, 'eval-results', 'runs', `${partial.runId}.json`), 'utf8'),
    ) as EvalRunRecord
    assert.equal(archived.runId, partial.runId)
    assert.equal(archived.completionState, 'partial')
    assert.equal(archived.results.length, 1)
    assert.equal(resultKey(archived.results[0]!), resultKey(partial.results[0]!))

    const started = JSON.parse(read('eval-results/run.json')) as EvalRunRecord
    assert.notEqual(started.runId, partial.runId)
    assert.equal(started.runId.length > 0, true)
  } finally {
    harness.cleanup()
  }
})

test('a fresh run does not overwrite an existing archive of the same run', { timeout: 600_000 }, () => {
  const harness = isolatedHarness('anvil-eval-fresh-archive-keep-')
  try {
    const { read, invoke } = harness
    const baseline = invoke('--write-baseline')
    assert.equal(baseline.status, 0, baseline.output)

    const complete = JSON.parse(read('eval-results/run.json')) as EvalRunRecord
    const partial = structuredClone(complete)
    partial.runId = 'failed-run-already-archived'
    partial.results = partial.results.slice(0, 1)
    partial.executionOrder = partial.executionOrder.slice(0, 1)
    partial.completionState = 'failed'
    partial.completedAt = null
    harness.write('eval-results/run.json', partial)
    // A different archive already exists for this run id; the fresh run must keep it.
    harness.write(`eval-results/runs/${partial.runId}.json`, { ...partial, runId: partial.runId, results: [] })
    const archiveBefore = read(`eval-results/runs/${partial.runId}.json`)

    const fresh = invoke()
    assert.equal(fresh.status, 0, fresh.output)
    assert.match(fresh.output, /already archived; keeping the existing archive/)
    assert.equal(read(`eval-results/runs/${partial.runId}.json`), archiveBefore)
  } finally {
    harness.cleanup()
  }
})

test('an interrupted fake-agent run keeps its checkpoint and resume reuses it', {
  // The budget below is deliberately smaller than this timeout, so a slow step fails with its
  // own message instead of the runner killing the test first.
  timeout: 900_000,
}, async () => {
  const harness = isolatedHarness('anvil-eval-interrupted-')
  // The five steps cannot add up to more than this: baseline 240s + halt marker 150s + the
  // killed child 30s + resume 240s + check 120s. Previously each step had its own 240-300s
  // cap, which summed to ~1140s and outlived the runner's 900s timeout.
  const deadline = budget(780_000)
  let running: TrackedChild | undefined
  try {
    const { root, env, read, invokeWithin } = harness
    // A complete baseline first: the final --check then proves the resumed record is
    // certifiable against this matrix instead of bootstrapping on a missing baseline.
    const baseline = invokeWithin(deadline.step(240_000, 'the baseline'), '--write-baseline')
    assert.equal(baseline.status, 0, baseline.output)

    // Halt after two new checkpoints: run.json then holds the first result, while the
    // second result exists only in its checkpoint. Killing here proves recovery from the
    // checkpoint rather than from a partially written record.
    const capture = { output: '' }
    running = spawnTracked(process.execPath, ['scripts/eval.ts', '--fake-agent'], {
      cwd: root,
      env: { ...env, ANVIL_EVAL_FAKE_HALT_AFTER_CHECKPOINTS: '2' },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    const marker = /anvil-eval: halted after checkpoint (.+?)\r?\n/
    await waitForMarker(running.child, marker, capture, deadline.step(180_000, 'the halt marker'))
    const match = capture.output.match(marker)
    assert.ok(match !== null, capture.output)
    const haltedKey = match[1]!
    // SIGKILL is TerminateProcess on Windows and immediate on POSIX; either way the child
    // has exited before any file below is read.
    await killAndWait(running, deadline.step(30_000, 'the killed child'))
    running = undefined

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
    const resumedInvocation = invokeWithin(deadline.step(240_000, 'the resume'), '--resume')
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

    const check = invokeWithin(deadline.step(120_000, 'the final check'), '--check')
    assert.equal(check.status, 0, check.output)
    assert.doesNotMatch(check.output, /No eval baseline exists yet/)
  } finally {
    if (running !== undefined) await killAndWait(running, 60_000)
    harness.cleanup()
  }
})

test('the gate refuses hermetic evidence that is not fake-agent only', { timeout: 600_000 }, () => {
  const harness = isolatedHarness('anvil-eval-hermetic-')
  try {
    const { root, invoke } = harness
    const baseline = invoke('--write-baseline')
    assert.equal(baseline.status, 0, baseline.output)
    const passing = invoke('--check')
    assert.equal(passing.status, 0, passing.output)

    // Relabel the promoted run as a real model everywhere it is recorded: the summary, the run
    // record and its archive. Every other check still agrees, so only the guard can refuse it.
    const files = [
      'eval-results/latest.json',
      'eval-results/run.json',
      ...readdirSync(join(root, 'eval-results', 'runs')).map((name) => `eval-results/runs/${name}`),
    ]
    for (const file of files) {
      const path = join(root, file)
      writeFileSync(path, readFileSync(path, 'utf8').replaceAll('"fake-agent"', '"opencode/real-model"'))
    }
    const refused = invoke('--check')
    assert.notEqual(refused.status, 0, refused.output)
    assert.match(refused.output, /the hermetic evidence is not fake-agent only/)
    assert.match(refused.output, /declares model opencode\/real-model, not fake-agent/)
  } finally {
    harness.cleanup()
  }
})
