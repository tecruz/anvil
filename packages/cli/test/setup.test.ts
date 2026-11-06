import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, describe, test } from 'node:test'
import type { SetupPlan, SetupPlanValidation } from '@anvil/derive'

const CLI = join(import.meta.dirname, '..', 'src', 'main.ts')
const roots: string[] = []
after(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true })
})
function scratch(): string {
  const root = mkdtempSync(join(tmpdir(), 'anvil-setup-'))
  roots.push(root)
  return root
}
function git(cwd: string, ...args: string[]) {
  return execFileSync('git', args, { cwd, stdio: 'pipe', encoding: 'utf8' })
}
function commit(root: string) {
  git(root, 'add', '.')
  git(
    root,
    '-c',
    'user.name=Anvil Test',
    '-c',
    'user.email=anvil@example.invalid',
    '-c',
    'core.hooksPath=.no-hooks',
    'commit',
    '-m',
    'fixture',
  )
}
function repo(project: Record<string, unknown> = {}): string {
  const root = scratch()
  git(root, 'init', '--initial-branch=main')
  writeFileSync(join(root, 'anvil.config.json'), JSON.stringify({ project }))
  writeFileSync(join(root, 'AGENTS.md'), '# Fixture\n')
  writeFileSync(join(root, '.gitignore'), '.config-home/\n')
  commit(root)
  return root
}
function run(cwd: string, args: string[], extraEnv: Record<string, string> = {}) {
  try {
    return {
      code: 0,
      stdout: execFileSync(process.execPath, [CLI, 'setup', ...args], {
        cwd,
        encoding: 'utf8',
        stdio: 'pipe',
        env: { ...process.env, NO_COLOR: '1', ANVIL_CONFIG_HOME: join(cwd, '.config-home'), ...extraEnv },
      }),
    }
  } catch (cause) {
    const failure = cause as { status: number; stdout: string; stderr: string }
    return { code: failure.status, stdout: failure.stdout, stderr: failure.stderr }
  }
}
function proposal(root: string): SetupPlan {
  const result = run(root, ['plan', '--json'])
  assert.equal(result.code, 0, result.stdout)
  return (JSON.parse(result.stdout) as { data: SetupPlan }).data
}
function save(plan: SetupPlan): string {
  const path = join(scratch(), 'plan.json')
  writeFileSync(path, JSON.stringify(plan))
  return path
}

describe('anvil setup', () => {
  test('plan never executes owner commands, expands secrets, copies references or writes staging', () => {
    const root = repo({
      commands: [{ kind: 'install', cmd: 'node install.cjs' }],
      tools: [{ id: 'node', install: 'echo $ANVIL_SETUP_SECRET', version: '^22' }],
      env: [{ name: 'ANVIL_SETUP_SECRET' }],
      references: [{ id: 'policy', path: 'policy.md' }],
    })
    writeFileSync(join(root, 'install.cjs'), "require('node:fs').writeFileSync('EXECUTED', 'bad')")
    writeFileSync(join(root, 'policy.md'), 'PRIVATE-POLICY-CONTENT')
    commit(root)
    const before = git(root, 'status', '--porcelain')
    const config = readFileSync(join(root, 'anvil.config.json'), 'utf8')
    const result = run(root, ['plan', '--json'], { ANVIL_SETUP_SECRET: 'DO-NOT-COPY-THIS-VALUE' })
    assert.equal(result.code, 0, result.stdout)
    assert.ok(!result.stdout.includes('DO-NOT-COPY-THIS-VALUE'))
    assert.ok(!result.stdout.includes('PRIVATE-POLICY-CONTENT'))
    assert.equal(existsSync(join(root, 'EXECUTED')), false)
    assert.equal(existsSync(join(root, '.anvil')), false)
    assert.equal(git(root, 'status', '--porcelain'), before)
    assert.equal(readFileSync(join(root, 'anvil.config.json'), 'utf8'), config)
    const plan = (JSON.parse(result.stdout) as { data: SetupPlan }).data
    assert.equal(plan.actions.length, 2)
    assert.equal(plan.repository.worktree, 'clean')
    assert.equal(plan.approval, 'not-granted')
    assert.equal(plan.actions[0]?.verification, 'not-run')
  })

  test('a clean unchanged plan validates, but never grants approval', () => {
    const root = repo({ commands: [{ kind: 'install', cmd: 'npm ci' }] })
    const first = proposal(root)
    assert.deepEqual(proposal(root), first)
    const result = run(root, ['validate', '--plan', save(first), '--json'])
    assert.equal(result.code, 0, result.stdout)
    const envelope = JSON.parse(result.stdout) as { ok: boolean; data: SetupPlanValidation }
    assert.equal(envelope.ok, true)
    assert.equal(envelope.data.status, 'current')
    assert.equal(envelope.data.approval, 'not-granted')
    assert.equal(envelope.data.executed, false)
    const text = run(root, ['plan'])
    assert.match(text.stdout, /Nothing executed/)
    assert.match(text.stdout, /permissions \/ file changes \/ immutable reference: unknown/)
  })

  test('tampering, dirty files and a new HEAD refuse validation on a failure envelope', () => {
    const root = repo({ commands: [{ kind: 'install', cmd: 'npm ci' }] })
    const plan = proposal(root)
    const saved = save(plan)
    const changed = structuredClone(plan)
    changed.actions[0]!.command = 'malicious command'
    const tampered = run(root, ['validate', '--plan', save(changed), '--json'])
    assert.equal(tampered.code, 5)
    assert.equal((JSON.parse(tampered.stdout) as { data: SetupPlanValidation }).data.status, 'invalid')
    writeFileSync(join(root, 'untracked.txt'), 'new work')
    const dirty = run(root, ['validate', '--plan', saved, '--json'])
    assert.equal(dirty.code, 5)
    assert.equal((JSON.parse(dirty.stdout) as { ok: boolean }).ok, false)
    const dirtyPlan = proposal(root)
    assert.equal(dirtyPlan.repository.worktree, 'dirty')
    assert.equal(run(root, ['validate', '--plan', save(dirtyPlan), '--json']).code, 5)
    commit(root)
    const stale = run(root, ['validate', '--plan', saved, '--json'])
    assert.equal(stale.code, 5)
    assert.equal((JSON.parse(stale.stdout) as { data: SetupPlanValidation }).data.status, 'stale')
  })

  test('global declaration changes invalidate a saved plan even when Git stays clean', () => {
    const root = repo()
    const home = join(root, '.config-home')
    mkdirSync(home)
    writeFileSync(
      join(home, 'anvil.config.json'),
      JSON.stringify({ project: { tools: [{ id: 'sdk', install: 'get-sdk' }] } }),
    )
    const saved = save(proposal(root))
    writeFileSync(
      join(home, 'anvil.config.json'),
      JSON.stringify({ project: { tools: [{ id: 'sdk', install: 'different' }] } }),
    )
    const result = run(root, ['validate', '--plan', saved, '--json'])
    assert.equal(result.code, 5)
    assert.equal(git(root, 'status', '--porcelain'), '')
  })

  test('an explicit target, not the caller repository, supplies declarations and repository identity', () => {
    const caller = repo({ commands: [{ kind: 'install', cmd: 'wrong' }] })
    const target = repo({ commands: [{ kind: 'install', cmd: 'right', dir: 'app' }] })
    const result = run(caller, ['plan', '--profile', target, '--json'])
    assert.equal(result.code, 0, result.stdout)
    const plan = (JSON.parse(result.stdout) as { data: SetupPlan }).data
    assert.equal(plan.actions[0]?.command, 'right')
    assert.equal(plan.actions[0]?.cwd, 'app')
    assert.equal(plan.repository.head, git(target, 'rev-parse', 'HEAD').trim())
  })

  test('there is no execute, approve, apply or implicit checking mode', () => {
    const root = repo()
    for (const args of [
      [],
      ['execute'],
      ['approve'],
      ['plan', '--apply'],
      ['plan', '--check'],
      ['plan', '--approve'],
      ['validate'],
    ]) {
      const result = run(root, [...args, '--json'])
      assert.equal(result.code, 2, result.stdout)
    }
  })

  test('invalid, oversized and non-file plan inputs are refused', () => {
    const root = repo()
    const dir = scratch()
    const bad = join(dir, 'bad.json')
    writeFileSync(bad, 'not json')
    const large = join(dir, 'large.json')
    writeFileSync(large, ' '.repeat(1024 * 1024 + 1))
    for (const path of [bad, large, dir, join(dir, 'missing.json')]) {
      assert.equal(run(root, ['validate', '--plan', path, '--json']).code, 3)
    }
  })

  test('a repository fsmonitor hook is not invoked by setup metadata checks', () => {
    const root = repo()
    const hook = join(root, 'monitor.cjs')
    writeFileSync(hook, "require('node:fs').writeFileSync('MONITOR-RAN', 'bad')")
    commit(root)
    git(root, 'config', 'core.fsmonitor', `${JSON.stringify(process.execPath)} ${JSON.stringify(hook)}`)
    proposal(root)
    assert.equal(existsSync(join(root, 'MONITOR-RAN')), false)
  })

  test('metadata checks do not refresh the Git index on disk', () => {
    const root = repo()
    const index = join(root, '.git', 'index')
    const before = readFileSync(index)
    // The file's content stays unchanged, but a normal status refresh would record the new
    // stat data in the index. --no-optional-locks must prevent that otherwise-hidden write.
    utimesSync(join(root, 'AGENTS.md'), new Date('2020-01-01'), new Date('2020-01-01'))
    assert.equal(proposal(root).repository.worktree, 'clean')
    assert.deepEqual(readFileSync(index), before)
  })

  test('status never executes configured clean filters, including required filters', () => {
    const root = repo()
    writeFileSync(join(root, 'tracked.txt'), 'unchanged\n')
    writeFileSync(join(root, '.gitattributes'), 'tracked.txt filter=setup-test\n')
    const script = join(root, 'filter.cjs')
    writeFileSync(
      script,
      "const fs=require('node:fs');fs.writeFileSync('FILTER-RAN','bad');process.stdout.write(fs.readFileSync(0));",
    )
    commit(root)
    // Configure only after committing: the fixture itself must not run the test filter.
    git(root, 'config', 'filter.setup-test.clean', `${JSON.stringify(process.execPath)} ${JSON.stringify(script)}`)
    git(root, 'config', 'filter.setup-test.required', 'true')
    utimesSync(join(root, 'tracked.txt'), new Date('2020-01-01'), new Date('2020-01-01'))
    assert.equal(proposal(root).repository.worktree, 'clean')
    assert.equal(existsSync(join(root, 'FILTER-RAN')), false)
  })

  test('a submodule makes repository state unknown without recursive helper execution', () => {
    const root = repo()
    const head = git(root, 'rev-parse', 'HEAD').trim()
    git(root, 'update-index', '--add', '--cacheinfo', `160000,${head},nested-module`)
    git(
      root,
      '-c',
      'user.name=Anvil Test',
      '-c',
      'user.email=anvil@example.invalid',
      '-c',
      'core.hooksPath=.no-hooks',
      'commit',
      '-m',
      'gitlink fixture',
    )
    assert.equal(proposal(root).repository.worktree, 'unknown')
  })

  test('unborn, nested and truncated targets cannot validate as a clean repository snapshot', () => {
    const unborn = scratch()
    git(unborn, 'init', '--initial-branch=main')
    assert.equal(proposal(unborn).repository.head, null)
    const root = repo()
    const nested = join(root, 'nested')
    mkdirSync(nested)
    const result = run(root, ['plan', '--profile', nested, '--json'])
    assert.equal(result.code, 0, result.stdout)
    assert.equal((JSON.parse(result.stdout) as { data: SetupPlan }).data.repository.worktree, 'unknown')
    const truncated = run(root, ['plan', '--max-files', '1', '--json'])
    assert.equal(truncated.code, 0, truncated.stdout)
    assert.equal((JSON.parse(truncated.stdout) as { data: SetupPlan }).data.repository.worktree, 'unknown')
  })
})
