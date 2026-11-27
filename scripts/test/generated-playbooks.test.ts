/**
 * Regression for the generated-playbook check that CI could not see.
 *
 * `npm ci` runs `prepare`, which used to run `gen:playbooks` before `check` compared the
 * generated file with the YAML sources. A stale `generated.ts` was therefore rewritten by
 * the install and the comparison could only pass: the very step meant to catch a missing
 * regeneration was the step that repaired it. `build` now checks instead of writing, so an
 * install fails on stale data before a bundle can be produced from it.
 */

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { cpSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const repoRoot = fileURLToPath(new URL('../../', import.meta.url))
const manifest = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8')) as {
  scripts: Record<string, string>
}

/** Run the generator in a temporary copy so the real registry is never touched by a test. */
function generator(output: string, args: readonly string[]): { status: number | null; stderr: string } {
  const result = spawnSync(process.execPath, ['scripts/gen-playbooks.ts', ...args], {
    cwd: output,
    encoding: 'utf8',
  })
  return { status: result.status, stderr: `${result.stdout ?? ''}\n${result.stderr ?? ''}` }
}

test('install and build verify generated playbooks instead of repairing them', () => {
  const build = manifest.scripts.build ?? ''
  const prepare = manifest.scripts.prepare ?? ''
  const check = manifest.scripts.check ?? ''

  // `gen:playbooks` remains a deliberate, human-run command after editing a registry file.
  // It must not be reachable from `prepare` or `build`, or an install hides the staleness.
  assert.doesNotMatch(build, /gen:playbooks/, 'build must not regenerate the file it depends on')
  assert.doesNotMatch(prepare, /gen:playbooks/, 'prepare must not regenerate the file it depends on')
  assert.match(build, /check:generated/, 'build must fail on stale generated playbooks')
  assert.match(prepare, /npm run build/, 'prepare must go through the checking build')

  const checkedAt = check.indexOf('check:generated')
  const builtAt = check.indexOf('npm run build')
  assert.ok(checkedAt >= 0, 'check must call check:generated')
  assert.ok(builtAt > checkedAt, 'check must report stale generated data before it builds a bundle')
})

test('a stale registry fails --check, and regeneration repairs it', () => {
  const workspace = mkdtempSync(join(tmpdir(), 'anvil-generated-playbooks-'))
  try {
    for (const path of ['scripts/gen-playbooks.ts', 'packages/playbooks/src', 'registry/playbooks']) {
      cpSync(join(repoRoot, path), join(workspace, path), { recursive: true })
    }
    // `schema.ts` imports `@anvil/core`; the checkout's workspace links resolve it.
    symlinkSync(join(repoRoot, 'node_modules'), join(workspace, 'node_modules'), 'junction')

    assert.equal(generator(workspace, ['--check']).status, 0, 'a clean copy must pass')

    const yaml = join(workspace, 'registry', 'playbooks', 'node.yaml')
    const original = readFileSync(yaml, 'utf8')
    try {
      writeFileSync(yaml, `${original}\n# this edit was never generated\n`, 'utf8')

      const stale = generator(workspace, ['--check'])
      assert.notEqual(stale.status, 0, 'a registry edit without regeneration must fail')
      assert.match(stale.stderr, /stale; run `npm run gen:playbooks`/)

      assert.equal(generator(workspace, []).status, 0, 'regeneration must succeed')
      assert.equal(generator(workspace, ['--check']).status, 0, 'the regenerated copy must pass')
    } finally {
      writeFileSync(yaml, original, 'utf8')
    }
  } finally {
    rmSync(workspace, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  }
})
