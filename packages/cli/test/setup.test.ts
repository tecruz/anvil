import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, describe, test } from 'node:test'
import { pathToFileURL } from 'node:url'
import { buildSetupPlan, type SetupPlan, type SetupPlanValidation, validateSetupPlan } from '@anvil/derive'
import { normalizeGitPath } from '@anvil/git'
import { worktreeFromStatus } from '../src/commands/setup.ts'

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
    // A path-comparison regression must not silently degrade the target to `unknown`.
    assert.equal(plan.repository.worktree, 'clean')
    assert.equal(plan.repository.root, normalizeGitPath(target))
  })

  test('a directory alias for the repository root keeps a clean snapshot', (t) => {
    const root = repo({ commands: [{ kind: 'install', cmd: 'npm ci' }] })
    const alias = join(scratch(), 'alias')
    try {
      symlinkSync(root, alias, process.platform === 'win32' ? 'junction' : 'dir')
    } catch {
      t.skip('directory aliases are unavailable here')
      return
    }
    const result = run(alias, ['plan', '--profile', alias, '--json'])
    assert.equal(result.code, 0, result.stdout)
    const plan = (JSON.parse(result.stdout) as { data: SetupPlan }).data
    assert.equal(plan.repository.root, normalizeGitPath(root))
    assert.equal(plan.repository.head, git(root, 'rev-parse', 'HEAD').trim())
    assert.equal(plan.repository.worktree, 'clean')
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

  test('a Git warning on stderr cannot become a clean snapshot or a current plan', () => {
    const root = repo()
    // This is the shape Git produces when a working directory cannot be opened: exit 0,
    // empty stdout and a warning on stderr. Treating that as clean would validate as current.
    const status = { stdout: '', stderr: "warning: could not open directory 'private/'\n", exitCode: 0 }
    assert.equal(worktreeFromStatus(status), 'unknown')
    assert.equal(worktreeFromStatus({ stdout: ' M tracked.txt\0', stderr: '', exitCode: 0 }), 'dirty')
    const plan = buildSetupPlan({
      repository: {
        root: normalizeGitPath(root),
        head: git(root, 'rev-parse', 'HEAD').trim(),
        worktree: worktreeFromStatus(status),
      },
      declared: { commands: [], tools: [], env: [], services: [], references: [] },
      projectDir: '',
    })
    assert.equal(plan.repository.worktree, 'unknown')
    assert.equal(validateSetupPlan(structuredClone(plan), plan).status, 'unknown')
  })

  test('assume-unchanged and skip-worktree entries cannot hide a dirty file', () => {
    for (const flag of ['--assume-unchanged', '--skip-worktree']) {
      const root = repo()
      writeFileSync(join(root, 'tracked.txt'), 'one\n')
      commit(root)
      git(root, 'update-index', flag, 'tracked.txt')
      writeFileSync(join(root, 'tracked.txt'), 'two\n')
      assert.equal(proposal(root).repository.worktree, 'unknown', flag)
    }
  })

  test('a split index is refused without refreshing shared index metadata', () => {
    const root = repo()
    git(root, 'update-index', '--split-index')
    const shared = readdirSync(join(root, '.git')).find((name) => name.startsWith('sharedindex.'))
    assert.ok(shared, 'expected update-index --split-index to create a shared index')
    const path = join(root, '.git', shared)
    const past = new Date('2020-01-01T00:00:00Z')
    utimesSync(path, past, past)
    const before = statSync(path).mtimeMs
    const plan = proposal(root)
    assert.equal(plan.repository.worktree, 'unknown')
    // Reading a split index refreshes this file even with --no-optional-locks.
    assert.equal(statSync(path).mtimeMs, before)
    assert.equal(run(root, ['validate', '--plan', save(plan), '--json']).code, 5)
  })

  test('setup metadata reads never lazily fetch missing promisor objects', (t) => {
    const work = scratch()
    const source = repo()
    const origin = join(work, 'origin.git')
    git(work, 'clone', '--bare', source, origin)
    git(origin, 'config', 'uploadpack.allowFilter', 'true')
    const target = join(work, 'partial')
    git(work, 'clone', '--no-local', '--filter=tree:0', '--no-checkout', pathToFileURL(origin).href, target)
    // Confirm the fixture is actually missing the HEAD tree; some Git versions keep it.
    try {
      execFileSync('git', ['cat-file', '-e', 'HEAD^{tree}'], {
        cwd: target,
        stdio: 'pipe',
        env: { ...process.env, GIT_NO_LAZY_FETCH: '1' },
      })
      t.skip('this Git kept the filtered tree locally')
      return
    } catch {
      // Expected: the tree is absent until a lazy fetch asks the promisor remote.
    }
    const trace = join(work, 'trace.txt')
    const result = run(target, ['plan', '--json'], { GIT_TRACE: trace })
    assert.equal(result.code, 0, result.stdout)
    const plan = (JSON.parse(result.stdout) as { data: SetupPlan }).data
    assert.equal(plan.repository.worktree, 'unknown')
    // A trace line for `fetch origin` is the observable form of the implicit fetch.
    assert.ok(existsSync(trace), 'expected GIT_TRACE output')
    assert.doesNotMatch(readFileSync(trace, 'utf8'), /fetch origin/)
  })
})
