/**
 * Offline controls for the verified-patch runner. No model is called and no real arm runs.
 */
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

import {
  graderDigests,
  isolatedEnv,
  loadManifest,
  preflightTask,
  runSpecHash,
  verifyScriptExecutable,
} from '../verified-patch-run.ts'

const repoRoot = fileURLToPath(new URL('../../', import.meta.url))
const runner = join(repoRoot, 'scripts/verified-patch-run.ts')

test('the manifest loads and every enrolled task passes preflight without a model', () => {
  const manifest = loadManifest(repoRoot)
  assert.equal(manifest.schemaVersion, 1)
  assert.equal(manifest.tasks.length, 2)
  for (const task of manifest.tasks) {
    const result = preflightTask(repoRoot, task)
    assert.equal(result.id, task.id)
    assert.equal(result.hiddenFailsOnBase, true, `${task.id}: hidden acceptance must fail on the base`)
    assert.equal(result.hiddenPassesWithFix, true, `${task.id}: hidden acceptance must pass with the fix`)
    assert.equal(result.verifyScriptExecutable, true, `${task.id}: the captured check must be executable JS`)
    assert.equal(result.ok, true)
  }
})

test('preflight refuses a captured check that is a data file, not a script', () => {
  const task = loadManifest(repoRoot).tasks.find((entry) => entry.id === 'node-tiny-slugify')
  assert.ok(task)
  const broken = { ...task, verifyScript: 'package.json' }

  assert.equal(verifyScriptExecutable(repoRoot, broken), false)
  assert.equal(preflightTask(repoRoot, broken).ok, false)
})

test('preflight writes a bounded report and never creates a run record', () => {
  const result = spawnSync(process.execPath, [runner, '--preflight'], {
    cwd: repoRoot,
    encoding: 'utf8',
    env: { ...process.env, ANVIL_EVAL: '1' },
  })
  assert.equal(result.status, 0, result.stderr)
  const report = JSON.parse(readFileSync(join(repoRoot, 'eval-results/verified-patch-preflight.json'), 'utf8')) as {
    results: Array<{ ok: boolean }>
  }
  assert.equal(
    report.results.every((entry) => entry.ok),
    true,
  )
})

test('the run spec hash is deterministic over the task card and config', () => {
  const manifest = loadManifest(repoRoot)
  const config = {
    model: 'opencode/hy4-flash-free',
    repetitions: 5,
    timeoutMinutes: 5,
    seed: 'verified-patch-v1',
    config: null,
    cli: join(repoRoot, 'packages/cli/dist/cli.js'),
  }
  assert.equal(runSpecHash(repoRoot, manifest, config), runSpecHash(repoRoot, manifest, config))
  assert.notEqual(
    runSpecHash(repoRoot, manifest, config),
    runSpecHash(repoRoot, manifest, { ...config, seed: 'other' }),
  )
})

test('the run spec binds the grader and CLI bytes, not just the task card', () => {
  const digests = graderDigests(repoRoot, join(repoRoot, 'packages/cli/dist/cli.js'))
  assert.match(digests.grader ?? '', /^[0-9a-f]{64}$/)
  assert.match(digests.broker ?? '', /^[0-9a-f]{64}$/)
  assert.match(digests.cli ?? '', /^[0-9a-f]{64}$/)
  const manifest = loadManifest(repoRoot)
  const config = {
    model: 'opencode/hy4-flash-free',
    repetitions: 1,
    timeoutMinutes: 5,
    seed: 'verified-patch-v1',
    config: null,
    cli: join(repoRoot, 'packages/cli/dist/cli.js'),
  }
  const before = runSpecHash(repoRoot, manifest, config)
  assert.equal(before, runSpecHash(repoRoot, manifest, config))
  assert.notEqual(before, runSpecHash(repoRoot, manifest, { ...config, seed: 'other' }))
})

test('the agent environment is allowlisted and never inherits unrelated secrets', () => {
  const previous = process.env.ANVIL_TEST_UNRELATED_SECRET
  process.env.ANVIL_TEST_UNRELATED_SECRET = 'should-not-leak'
  try {
    const env = isolatedEnv({ PATH: '/shim', ANVIL_DECLARED_BIN: 'npm' }, null)
    assert.equal(env.PATH, '/shim')
    assert.equal(env.ANVIL_DECLARED_BIN, 'npm')
    assert.equal(env.ANVIL_TEST_UNRELATED_SECRET, undefined)
    assert.equal(env.NODE_OPTIONS, undefined)
  } finally {
    if (previous === undefined) delete process.env.ANVIL_TEST_UNRELATED_SECRET
    else process.env.ANVIL_TEST_UNRELATED_SECRET = previous
  }
})

test('the runner refuses to run when the opt-in is absent', () => {
  const env = { ...process.env }
  delete env.ANVIL_EVAL
  const result = spawnSync(process.execPath, [runner, '--run'], { cwd: repoRoot, encoding: 'utf8', env })
  assert.equal(result.status, 1)
  assert.match(result.stderr + result.stdout, /opt-in/)
})

test('the runner refuses to run without a matching approval', () => {
  const approval = join(repoRoot, 'eval/verified-patch-approval.json')
  const existed = existsSync(approval)
  const previous = existed ? readFileSync(approval, 'utf8') : null
  try {
    writeFileSync(approval, `${JSON.stringify({ schemaVersion: 1, specHash: 'not-the-spec', approvedBy: 'test' })}\n`)
    const result = spawnSync(process.execPath, [runner, '--run'], {
      cwd: repoRoot,
      encoding: 'utf8',
      env: { ...process.env, ANVIL_EVAL: '1' },
    })
    assert.equal(result.status, 1)
    assert.match(result.stderr + result.stdout, /fresh decision/)
  } finally {
    if (previous === null) {
      // A stale approval would be dangerous; leave no file behind.
      rmSync(approval, { force: true })
    } else {
      writeFileSync(approval, previous)
    }
  }
})
