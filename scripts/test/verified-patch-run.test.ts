/**
 * Offline controls for the verified-patch runner. No model is called and no real arm runs.
 */
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

import { loadManifest, preflightTask, runSpecHash } from '../verified-patch-run.ts'

const repoRoot = fileURLToPath(new URL('../../', import.meta.url))
const runner = join(repoRoot, 'scripts/verified-patch-run.ts')

test('the manifest loads and its single task passes preflight without a model', () => {
  const manifest = loadManifest(repoRoot)
  assert.equal(manifest.schemaVersion, 1)
  assert.equal(manifest.tasks.length, 1)
  const task = manifest.tasks[0]
  assert.ok(task, 'the manifest must declare a task')
  const result = preflightTask(repoRoot, task)
  assert.equal(result.id, 'verified-patch')
  assert.equal(result.hiddenFailsOnBase, true)
  assert.equal(result.hiddenPassesWithFix, true)
  assert.equal(result.ok, true)
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
