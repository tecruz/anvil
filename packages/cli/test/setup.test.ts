import assert from 'node:assert/strict'
import { type ChildProcess, execFileSync, spawn } from 'node:child_process'
import {
  copyFileSync,
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
import { after, describe, type TestContext, test } from 'node:test'
import { pathToFileURL } from 'node:url'
import {
  buildSetupApprovalGrant,
  buildSetupPlan,
  readSetupApplicationJournal,
  type SetupApplicationRecord,
  type SetupExecutionPlan,
  type SetupPlan,
  type SetupPlanValidation,
  saveSetupApprovalGrant,
  validateSetupPlan,
} from '@anvil/derive'
import { git as gitExec, normalizeGitPath } from '@anvil/git'
import { approveSetupPlan, repositoryState, SetupApprovalRefusal, worktreeFromStatus } from '../src/commands/setup.ts'

const CLI = join(import.meta.dirname, '..', 'src', 'main.ts')
const roots: string[] = []
/** Every child this suite starts, so a failed or timed-out test cannot leak one. */
const children = new Set<ChildProcess>()

/** Kill a child and wait for it to exit, so cleanup never runs against a live fixture. */
async function terminate(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return
  await new Promise<void>((resolve) => {
    const done = () => resolve()
    child.once('exit', done)
    child.once('error', done)
    if (!child.kill('SIGKILL')) done()
  })
}

function track<T extends ChildProcess>(child: T): T {
  children.add(child)
  const forget = () => children.delete(child)
  child.once('exit', forget)
  child.once('error', forget)
  return child
}

after(async () => {
  await Promise.all([...children].map((child) => terminate(child)))
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
function run(cwd: string, args: string[], extraEnv: Record<string, string> = {}, input?: string) {
  try {
    return {
      code: 0,
      stdout: execFileSync(process.execPath, [CLI, 'setup', ...args], {
        cwd,
        encoding: 'utf8',
        stdio: 'pipe',
        input,
        env: { ...process.env, NO_COLOR: '1', ANVIL_CONFIG_HOME: join(cwd, '.config-home'), ...extraEnv },
      }),
    }
  } catch (cause) {
    const failure = cause as { status: number; stdout: string; stderr: string }
    return { code: failure.status, stdout: failure.stdout, stderr: failure.stderr }
  }
}
/**
 * Run one real CLI process without blocking the test, so two invocations overlap.
 *
 * The synchronous `run` helper is enough for a single command; contention needs both
 * processes alive at the same time, each doing its own preflight and lock wait. The child is
 * registered for teardown and is killed if it somehow outlives the test.
 */
function runConcurrently(
  t: TestContext,
  cwd: string,
  args: string[],
  extraEnv: Record<string, string> = {},
  timeoutMs = 150_000,
) {
  const child = track(
    spawn(process.execPath, [CLI, 'setup', ...args], {
      cwd,
      env: { ...process.env, NO_COLOR: '1', ANVIL_CONFIG_HOME: join(cwd, '.config-home'), ...extraEnv },
      stdio: ['ignore', 'pipe', 'pipe'],
    }),
  )
  t.after(() => terminate(child))
  return new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
    let stdout = ''
    let stderr = ''
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      reject(new Error(`anvil setup ${args.join(' ')} did not finish within ${timeoutMs}ms`))
    }, timeoutMs)
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => {
      stdout += chunk
    })
    child.stderr.on('data', (chunk: string) => {
      stderr += chunk
    })
    child.once('error', (cause) => {
      clearTimeout(timer)
      reject(cause)
    })
    child.once('close', (code) => {
      clearTimeout(timer)
      resolve({ code, stdout, stderr })
    })
  })
}

/**
 * A process that takes the real repository lock and then stops at a chosen point.
 *
 * `holding` takes the lock without touching the grant and waits for a release file, so
 * callers started behind it are provably queued at the same time. `started` runs the real
 * application path up to its first mutation, which is after the attempt is consumed and its
 * `started` journal is published. `reserved` only consumes the grant, leaving no journal.
 * `window` consumes the grant and keeps its record multiply-linked until the test says
 * otherwise. `publishing` stops inside the real create-only publisher, after the temporary
 * file is written or after the destination is linked.
 */
const HOLDER_SCRIPT = `
import { existsSync, linkSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { applySetupPlan, consumeSetupApproval } from ${JSON.stringify(new URL('../../derive/src/index.ts', import.meta.url).href)}
import { withRepoLock } from ${JSON.stringify(new URL('../../git/src/index.ts', import.meta.url).href)}

const repo = process.env.ANVIL_TEST_REPO
const grant = process.env.ANVIL_TEST_GRANT
const state = () => ({ root: repo, head: process.env.ANVIL_TEST_HEAD, worktree: 'clean' })
const send = (message) => { if (process.send) process.send(message) }
const hold = () => new Promise((resolve) => setTimeout(resolve, 600000))
const marker = (value) => writeFileSync(process.env.ANVIL_TEST_MARKER, value)
const block = () => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 600000)
const waitForRelease = () => {
  const release = process.env.ANVIL_TEST_RELEASE
  const deadline = Date.now() + 600000
  while (release !== undefined && !existsSync(release) && Date.now() < deadline) {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50)
  }
}

await withRepoLock({ cwd: repo, name: 'setup-apply' }, async () => {
  const mode = process.env.ANVIL_TEST_MODE
  if (mode === 'holding') {
    // Take the real lock and hold it until the test releases it. Every caller started
    // behind this record is already queued, so their critical sections really overlap.
    marker('holding')
    waitForRelease()
    return
  }
  if (mode === 'reserved') {
    const consumption = consumeSetupApproval(grant, state(), { env: process.env })
    if (!consumption.reserved) throw new Error('the holder failed to reserve the attempt')
    send('reserved')
    await hold()
    return
  }
  if (mode === 'window') {
    const consumption = consumeSetupApproval(grant, state(), { env: process.env })
    if (!consumption.reserved) throw new Error('the holder failed to reserve the attempt')
    // A hard link is how the record is published. While it exists the record is
    // multiply-linked, which is exactly what a concurrent reader refuses to trust.
    const dir = join(process.env.ANVIL_APPROVAL_HOME, grant)
    linkSync(join(dir, 'transition.json'), join(dir, 'transition.link.tmp'))
    send('window')
    // Hold the window open until the test has watched another process queue on the
    // repository lock, so that reader is guaranteed to observe the multiply-linked record.
    await new Promise((resolve) => process.once('message', resolve))
    rmSync(join(dir, 'transition.link.tmp'))
    return
  }
  if (mode === 'publishing') {
    const step = process.env.ANVIL_TEST_STEP
    const record = await applySetupPlan({
      saved: JSON.parse(process.env.ANVIL_TEST_PLAN),
      repository: state(),
      grantId: grant,
      lock: async (work) => work(),
      refresh: async () => state(),
      env: process.env,
      hooks: {
        duringPublish: (reached) => {
          if (reached !== step) return
          // The real publisher has written its temporary file or linked the destination.
          // Block there so the test can kill the process mid-publication.
          marker(reached)
          block()
        },
      },
    })
    if (record.status !== 'applied') throw new Error(\`the holder did not apply: \${record.status}: \${record.reason}\`)
    return
  }
  const record = await applySetupPlan({
    saved: JSON.parse(process.env.ANVIL_TEST_PLAN),
    repository: state(),
    grantId: grant,
    lock: async (work) => work(),
    refresh: async () => state(),
    env: process.env,
    hooks: {
      beforeWrite: () => {
        // A synchronous marker, not an IPC message: the hook blocks the event loop right
        // after this, so a queued send might never flush on a loaded runner.
        marker('started')
        block()
      },
    },
  })
  if (record.status !== 'applied') throw new Error(\`the holder did not apply: \${record.status}: \${record.reason}\`)
  // Release the repository lock here rather than holding it, so a queued caller observes
  // the recorded success instead of waiting for this process to die.
})
`

interface Holder {
  child: ChildProcess
  /** Resolves once the holder reports it reached the requested point. */
  ready(message: string): Promise<void>
  /** Ends a held publication window and lets the holder release the lock. */
  release(): void
  /** Resolves with how the process ended; never rejects, so a spawn error cannot leak. */
  exited: Promise<{ code: number | null; spawnError: Error | null }>
}

function startHolder(t: TestContext, env: Record<string, string>): Holder {
  const child = track(
    spawn(process.execPath, ['--input-type=module', '-e', HOLDER_SCRIPT], {
      env: { ...process.env, ...env },
      stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
    }),
  )
  t.after(() => terminate(child))
  let stderr = ''
  child.stderr?.setEncoding('utf8')
  child.stderr?.on('data', (chunk: string) => {
    stderr += chunk
  })
  const exited = new Promise<{ code: number | null; spawnError: Error | null }>((resolve) => {
    child.once('error', (spawnError) => resolve({ code: null, spawnError }))
    child.once('exit', (code) => resolve({ code, spawnError: null }))
  })
  const ready = (message: string): Promise<void> =>
    new Promise((resolve, reject) => {
      const onMessage = (value: unknown) => {
        if (value !== message) return
        child.off('message', onMessage)
        resolve()
      }
      child.on('message', onMessage)
      child.once('error', (spawnError) => {
        child.off('message', onMessage)
        reject(spawnError)
      })
      child.once('exit', (code) => {
        child.off('message', onMessage)
        reject(new Error(`the holder exited ${String(code)} before "${message}": ${stderr}`))
      })
    })
  const release = () => {
    if (child.connected) child.send('release')
  }
  return { child, ready, release, exited }
}

/** Wait until `count` processes have records in the `setup-apply` repository lock. */
async function waitForContention(root: string, count: number): Promise<void> {
  const directory = join(root, '.git', 'anvil-locks', 'setup-apply.lock')
  const deadline = Date.now() + 120_000
  for (;;) {
    let records: string[] = []
    try {
      records = readdirSync(directory)
    } catch {
      // The lock directory appears when the first holder registers; absence means no contention.
    }
    if (records.length >= count) return
    if (Date.now() >= deadline) {
      throw new Error(`expected ${count} lock records in ${directory}, saw ${records.length}`)
    }
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
}

/** Wait until a holder has synchronously written its marker file. */
async function waitForFile(path: string): Promise<void> {
  const deadline = Date.now() + 120_000
  while (!existsSync(path)) {
    if (Date.now() >= deadline) throw new Error(`timed out waiting for ${path}`)
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
}

function proposal(root: string): SetupPlan {
  const result = run(root, ['plan', '--json'])
  assert.equal(result.code, 0, result.stdout)
  return (JSON.parse(result.stdout) as { data: SetupPlan }).data
}
function executionPlan(root: string, source = 'skill.md', name = 'my-skill'): SetupExecutionPlan {
  const result = run(root, ['plan', '--adapter', 'local-skill', '--source', source, '--name', name, '--json'])
  assert.equal(result.code, 0, result.stdout + result.stderr)
  return (JSON.parse(result.stdout) as { data: SetupExecutionPlan }).data
}
function save(plan: SetupPlan): string {
  return saveData(plan)
}
function saveData(data: unknown): string {
  const path = join(scratch(), 'plan.json')
  writeFileSync(path, JSON.stringify(data))
  return path
}
function skillContent(name = 'my-skill', body = 'Do the thing.\n'): string {
  return `---\nname: ${name}\ndescription: A test skill for ${name}.\n---\n\n# ${name}\n\n${body}`
}
/** A throwaway approval store outside the repository, so grants never touch the real home. */
function approvalEnv(): Record<string, string> {
  const store = mkdtempSync(join(tmpdir(), 'anvil-approvals-'))
  roots.push(store)
  return { ANVIL_APPROVAL_HOME: store }
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

  test('a promisor remote on a Git without --no-lazy-fetch fails closed instead of fetching', async () => {
    const root = normalizeGitPath(repo())
    const guarded: boolean[] = []
    // Simulate Git < 2.45: configuration is readable, but `--no-lazy-fetch` is unknown and
    // must abort the read rather than let it become an implicit fetch.
    const older: typeof gitExec = async (args, options) => {
      guarded.push(options?.noLazyFetch === true)
      if (args[0] === 'config' && args.includes('--get-regexp')) {
        return args.some((arg) => arg.includes('promisor'))
          ? { stdout: 'remote.origin.promisor\ntrue\0', stderr: '', exitCode: 0 }
          : { stdout: '', stderr: '', exitCode: 1 }
      }
      if (options?.noLazyFetch === true) {
        return { stdout: '', stderr: "error: unknown option `no-lazy-fetch'\n", exitCode: 129 }
      }
      return { stdout: '', stderr: '', exitCode: 1 }
    }
    const state = await repositoryState(root, older)
    assert.equal(state.worktree, 'unknown')
    assert.equal(state.head, null)
    assert.ok(guarded.some(Boolean), 'expected the guard to be requested once a promisor is detected')
  })

  test('a repository without a promisor remote never requests --no-lazy-fetch', async () => {
    const root = normalizeGitPath(repo())
    const flags: boolean[] = []
    const wrapped: typeof gitExec = async (args, options) => {
      flags.push(options?.noLazyFetch === true)
      return gitExec(args, options)
    }
    const state = await repositoryState(root, wrapped)
    assert.equal(state.worktree, 'clean')
    assert.ok(flags.length > 0, 'expected metadata reads to run')
    // A non-promisor repository must keep working on a Git that predates the flag.
    assert.ok(flags.every((flag) => flag === false))
  })

  test('a relocated split index cannot refresh a shared index in the Git directory', () => {
    const root = repo()
    const outside = scratch()
    const relocated = join(outside, 'custom-index')
    // Start from the real index so the working tree still matches HEAD afterwards.
    copyFileSync(join(root, '.git', 'index'), relocated)
    const env = { GIT_INDEX_FILE: relocated }
    execFileSync('git', ['update-index', '--split-index'], {
      cwd: root,
      stdio: 'pipe',
      env: { ...process.env, ...env },
    })
    const shared = readdirSync(join(root, '.git')).find((name) => name.startsWith('sharedindex.'))
    assert.ok(shared, 'expected a shared index in the Git directory')
    const path = join(root, '.git', shared)
    const past = new Date('2020-01-01T00:00:00Z')
    utimesSync(path, past, past)
    const before = statSync(path).mtimeMs
    // The index lives outside .git; its shared index does not. Checking only the index
    // directory would read the index and refresh the shared index's metadata.
    const result = run(root, ['plan', '--json'], env)
    assert.equal(result.code, 0, result.stdout)
    const plan = (JSON.parse(result.stdout) as { data: SetupPlan }).data
    assert.equal(plan.repository.worktree, 'unknown')
    assert.equal(statSync(path).mtimeMs, before)
  })

  test('a shared index filename is refused without regard to case', () => {
    const root = repo()
    // A case-insensitive filesystem can open `sharedindex.*` under any casing.
    writeFileSync(join(root, '.git', `SHAREDINDEX.${'a'.repeat(40)}`), '')
    assert.equal(proposal(root).repository.worktree, 'unknown')
  })

  test('a shared index beside the index path as given is not missed', async () => {
    const root = normalizeGitPath(repo())
    const lexical = mkdtempSync(join(tmpdir(), 'anvil-lexical-'))
    const canonical = mkdtempSync(join(tmpdir(), 'anvil-canonical-'))
    roots.push(lexical, canonical)
    writeFileSync(join(lexical, `sharedindex.${'a'.repeat(40)}`), '')
    let indexRead = false
    const runner: typeof gitExec = async (args) => {
      if (args.includes('config')) return { stdout: '', stderr: '', exitCode: 1 }
      if (args.includes('--show-toplevel')) return { stdout: `${root}\n`, stderr: '', exitCode: 0 }
      if (args.includes('--verify')) return { stdout: `${'b'.repeat(40)}\n`, stderr: '', exitCode: 0 }
      if (args.includes('--git-path')) {
        // Git falls back to a shared index beside the path as given; the canonical form
        // resolves a linked index away from that directory.
        const value = args.includes('--path-format=absolute') ? join(canonical, 'index') : join(lexical, 'index')
        return { stdout: `${value}\n`, stderr: '', exitCode: 0 }
      }
      if (args.includes('--absolute-git-dir')) {
        return { stdout: `${join(root, '.git')}\n`, stderr: '', exitCode: 0 }
      }
      if (args.includes('ls-files')) {
        indexRead = true
        return { stdout: `H 100644 ${'c'.repeat(40)} 0\ttracked.txt\0`, stderr: '', exitCode: 0 }
      }
      if (args.includes('status')) return { stdout: '', stderr: '', exitCode: 0 }
      throw new Error(`Unexpected command: ${args.join(' ')}`)
    }
    const state = await repositoryState(root, runner)
    assert.equal(state.worktree, 'unknown')
    assert.equal(indexRead, false)
  })

  test('a promisor probe warning keeps the snapshot unknown and the saved plan stale', async () => {
    const root = normalizeGitPath(repo())
    const saved = proposal(root)
    assert.equal(saved.repository.worktree, 'clean')
    const warned: typeof gitExec = async (args, options) => {
      if (args.includes('--get-regexp')) {
        return args.some((arg) => arg.includes('promisor'))
          ? { stdout: 'remote.origin.promisor\nfalse\0', stderr: 'warning: could not read all config\n', exitCode: 0 }
          : { stdout: '', stderr: '', exitCode: 1 }
      }
      return gitExec(args, options)
    }
    const state = await repositoryState(root, warned)
    // The probe cannot prove absence, so no later clean read may turn the snapshot clean.
    assert.equal(state.worktree, 'unknown')
    const current = buildSetupPlan({
      repository: state,
      declared: { commands: [], tools: [], env: [], services: [], references: [] },
      projectDir: '',
    })
    assert.equal(validateSetupPlan(saved, current).status, 'stale')
  })

  test('a shared index behind a symlink-plus-dotdot parent is not missed', {
    skip: process.platform === 'win32' ? 'Windows normalizes .. before resolving links' : false,
  }, async () => {
    const root = normalizeGitPath(repo())
    const outside = scratch()
    mkdirSync(join(outside, 'child'))
    symlinkSync(join(outside, 'child'), join(root, 'link'))
    // `/root/link/..` is `outside`, not `root`: `resolve()` would collapse `..` first.
    writeFileSync(join(outside, `sharedindex.${'a'.repeat(40)}`), '')
    let indexRead = false
    const runner: typeof gitExec = async (args) => {
      if (args.includes('config')) return { stdout: '', stderr: '', exitCode: 1 }
      if (args.includes('--show-toplevel')) return { stdout: `${root}\n`, stderr: '', exitCode: 0 }
      if (args.includes('--verify')) return { stdout: `${'b'.repeat(40)}\n`, stderr: '', exitCode: 0 }
      if (args.includes('--git-path')) {
        // Build the path textually: `join()` would collapse `..` before Git sees it.
        return { stdout: `${root}/link/../index\n`, stderr: '', exitCode: 0 }
      }
      if (args.includes('--absolute-git-dir')) {
        return { stdout: `${join(root, '.git')}\n`, stderr: '', exitCode: 0 }
      }
      if (args.includes('ls-files') || args.includes('status')) {
        indexRead = true
        return { stdout: '', stderr: '', exitCode: 0 }
      }
      throw new Error(`Unexpected command: ${args.join(' ')}`)
    }
    const state = await repositoryState(root, runner)
    assert.equal(state.worktree, 'unknown')
    assert.equal(indexRead, false)
  })

  test('a leading space in the index path is not trimmed away', async () => {
    const root = normalizeGitPath(repo())
    // Both directories exist, so trimming would scan the wrong one and miss the shared
    // index. A leading space is a valid filename character, not formatting.
    mkdirSync(join(root, ' index-dir'))
    mkdirSync(join(root, 'index-dir'))
    writeFileSync(join(root, ' index-dir', `sharedindex.${'a'.repeat(40)}`), '')
    let indexRead = false
    const runner: typeof gitExec = async (args) => {
      if (args.includes('config')) return { stdout: '', stderr: '', exitCode: 1 }
      if (args.includes('--show-toplevel')) return { stdout: `${root}\n`, stderr: '', exitCode: 0 }
      if (args.includes('--verify')) return { stdout: `${'b'.repeat(40)}\n`, stderr: '', exitCode: 0 }
      if (args.includes('--git-path')) return { stdout: ' index-dir/index\n', stderr: '', exitCode: 0 }
      if (args.includes('--absolute-git-dir')) {
        return { stdout: `${join(root, '.git')}\n`, stderr: '', exitCode: 0 }
      }
      if (args.includes('ls-files') || args.includes('status')) {
        indexRead = true
        return { stdout: '', stderr: '', exitCode: 0 }
      }
      throw new Error(`Unexpected command: ${args.join(' ')}`)
    }
    const state = await repositoryState(root, runner)
    assert.equal(state.worktree, 'unknown')
    assert.equal(indexRead, false)
  })

  test('a local-skill execution plan is a proposal and validates unchanged inputs', () => {
    const root = repo()
    const content = skillContent('my-skill', 'Do the thing.\n\n```js\nconsole.log(1)\n```\n')
    writeFileSync(join(root, 'skill.md'), content)
    commit(root)
    const before = git(root, 'status', '--porcelain')
    const plan = executionPlan(root)
    assert.equal(plan.kind, 'setup-execution-plan')
    assert.equal(plan.adapter, 'local-skill/v1')
    assert.equal(plan.status, 'proposed')
    assert.equal(plan.executed, false)
    assert.equal(plan.approval, 'not-granted')
    assert.equal(plan.executionSupported, true)
    assert.equal(plan.source.path, 'skill.md')
    assert.equal(plan.source.content, content)
    assert.equal(plan.skill.destination, '.agents/skills/my-skill/SKILL.md')
    assert.equal(plan.operations.at(-1)?.kind, 'write-file')
    assert.equal(plan.effects.overwrite, false)
    assert.equal(plan.effects.network, false)
    assert.equal(plan.effects.credentials, false)
    // Planning reads and validates; it never creates the destination or dirtifies the repo.
    assert.equal(existsSync(join(root, '.agents')), false)
    assert.equal(git(root, 'status', '--porcelain'), before)

    const text = run(root, ['plan', '--adapter', 'local-skill', '--source', 'skill.md', '--name', 'my-skill'])
    assert.equal(text.code, 0, text.stdout + text.stderr)
    assert.match(text.stdout, /Execution plan:/)
    assert.match(text.stdout, /Not approved/)
    assert.match(text.stdout, /Approval and application are separate commands/)
    assert.match(text.stdout, /Do the thing/)
    // The preview fence is longer than any run of backticks in the skill body.
    assert.match(text.stdout, /````markdown/)
    assert.match(text.stdout, /filesystem only; no processes, network or credentials/)
    assert.equal(existsSync(join(root, '.agents')), false)

    const validation = run(root, ['validate', '--plan', saveData(plan), '--json'])
    assert.equal(validation.code, 0, validation.stdout)
    const envelope = JSON.parse(validation.stdout) as { ok: boolean; data: SetupExecutionPlan }
    assert.equal(envelope.ok, true)
    assert.equal((envelope.data as unknown as { status: string }).status, 'current')
    assert.equal((envelope.data as unknown as { approval: string }).approval, 'not-granted')
    assert.equal((envelope.data as unknown as { executed: boolean }).executed, false)
  })

  test('the content preview neutralises terminal control sequences but keeps the exact bytes', () => {
    const root = repo()
    const content = skillContent('my-skill', 'visible\u001b[2J\u001b[H\u0007overwrite')
    writeFileSync(join(root, 'skill.md'), content)
    commit(root)
    const plan = executionPlan(root)
    // The recorded plan and its digest keep the exact source bytes; only the human preview
    // is transformed.
    assert.equal(plan.source.content, content)
    const text = run(root, ['plan', '--adapter', 'local-skill', '--source', 'skill.md', '--name', 'my-skill'])
    assert.equal(text.code, 0, text.stdout + text.stderr)
    assert.ok(!text.stdout.includes('\u001b'), 'raw escape leaked into the preview')
    assert.ok(!text.stdout.includes('\u0007'), 'raw bell leaked into the preview')
    assert.ok(text.stdout.includes('visible\\u001b[2J\\u001b[H\\u0007overwrite'))
  })

  test('execution-plan validation refuses changed sources, tampering, dirty state and missing sources', () => {
    const root = repo()
    writeFileSync(join(root, 'skill.md'), skillContent())
    commit(root)
    const plan = executionPlan(root)
    const saved = saveData(plan)

    writeFileSync(join(root, 'skill.md'), skillContent('my-skill', 'A changed body.\n'))
    const stale = run(root, ['validate', '--plan', saved, '--json'])
    assert.equal(stale.code, 5)
    assert.equal((JSON.parse(stale.stdout) as { data: { status: string } }).data.status, 'stale')

    const tampered = structuredClone(plan)
    tampered.source.content = 'not the source'
    const invalid = run(root, ['validate', '--plan', saveData(tampered), '--json'])
    assert.equal(invalid.code, 5)
    assert.equal((JSON.parse(invalid.stdout) as { data: { status: string } }).data.status, 'invalid')

    writeFileSync(join(root, 'skill.md'), skillContent())
    // Restoring the committed bytes makes the worktree clean again.
    assert.equal(git(root, 'status', '--porcelain'), '')
    writeFileSync(join(root, 'untracked.txt'), 'new work')
    const dirtyPlan = executionPlan(root)
    assert.equal(dirtyPlan.repository.worktree, 'dirty')
    const dirty = run(root, ['validate', '--plan', saveData(dirtyPlan), '--json'])
    assert.equal(dirty.code, 5)
    assert.equal((JSON.parse(dirty.stdout) as { data: { status: string } }).data.status, 'unknown')

    rmSync(join(root, 'skill.md'))
    const missing = run(root, ['validate', '--plan', saved, '--json'])
    assert.equal(missing.code, 5)
    assert.equal((JSON.parse(missing.stdout) as { data: { status: string } }).data.status, 'stale')
    assert.match((JSON.parse(missing.stdout) as { data: { reason: string } }).data.reason, /does not exist/)
  })

  test('adapter flags are strict and never mix with legacy plan or validate modes', () => {
    const root = repo()
    writeFileSync(join(root, 'skill.md'), skillContent())
    commit(root)
    const saved = saveData(executionPlan(root))
    for (const args of [
      ['plan', '--adapter', 'local-skill', '--name', 'my-skill'],
      ['plan', '--adapter', 'local-skill', '--source', 'skill.md'],
      ['plan', '--source', 'skill.md', '--name', 'my-skill'],
      ['plan', '--adapter', 'other', '--source', 'skill.md', '--name', 'my-skill'],
      ['plan', '--adapter', 'local-skill', '--source', 'skill.md', '--name', 'my-skill', '--plan', saved],
      ['validate', '--plan', saved, '--adapter', 'local-skill'],
      ['validate', '--plan', saved, '--source', 'skill.md'],
      ['validate', '--plan', saved, '--name', 'my-skill'],
      ['apply', '--plan', saved],
      ['approve', '--plan', saved],
    ]) {
      const result = run(root, [...args, '--json'])
      assert.equal(result.code, 2, `${args.join(' ')}: ${result.stdout}${result.stderr ?? ''}`)
    }
  })

  test('invalid names and paths are refused without touching the destination', () => {
    const root = repo()
    writeFileSync(join(root, 'skill.md'), skillContent())
    commit(root)
    for (const name of ['Uppercase', 'under_score', 'double--hyphen', '../escape', 'a'.repeat(256)]) {
      assert.equal(run(root, ['plan', '--adapter', 'local-skill', '--source', 'skill.md', '--name', name]).code, 3)
    }
    for (const source of ['../outside.md', '/tmp/skill.md', 'C:\\skill.md', '.git/config']) {
      assert.equal(run(root, ['plan', '--adapter', 'local-skill', '--source', source, '--name', 'my-skill']).code, 3)
    }
    assert.equal(existsSync(join(root, '.agents')), false)
  })

  test('an existing destination is refused and its content is preserved', () => {
    const root = repo()
    writeFileSync(join(root, 'skill.md'), skillContent())
    const existing = join(root, '.agents', 'skills', 'my-skill', 'SKILL.md')
    mkdirSync(join(root, '.agents', 'skills', 'my-skill'), { recursive: true })
    writeFileSync(existing, 'EXISTING CONTENT MUST SURVIVE')
    commit(root)
    const result = run(root, [
      'plan',
      '--adapter',
      'local-skill',
      '--source',
      'skill.md',
      '--name',
      'my-skill',
      '--json',
    ])
    assert.equal(result.code, 5, result.stdout)
    assert.equal(readFileSync(existing, 'utf8'), 'EXISTING CONTENT MUST SURVIVE')
    assert.equal(git(root, 'status', '--porcelain'), '')
  })

  test('approve requires an interactive terminal and writes nothing when it is refused', () => {
    const root = repo()
    writeFileSync(join(root, 'skill.md'), skillContent())
    commit(root)
    const plan = executionPlan(root)
    const saved = saveData(plan)
    const store = mkdtempSync(join(tmpdir(), 'anvil-approvals-'))
    roots.push(store)
    const env = { ANVIL_APPROVAL_HOME: store }

    // A piped digest is not a review: stdin is not a terminal, so approval is refused and no
    // grant is written.
    const refused = run(root, ['approve', '--plan', saved, '--json'], env, `${plan.digest}\n`)
    assert.equal(refused.code, 2, refused.stdout + refused.stderr)
    assert.equal(existsSync(join(root, '.agents')), false)
    assert.deepEqual(readdirSync(store), [])
  })

  test('the approval flow shows the plan, issues an active grant and never touches the repository', async () => {
    const root = repo()
    writeFileSync(join(root, 'skill.md'), skillContent())
    commit(root)
    const plan = executionPlan(root)
    const state = await repositoryState(normalizeGitPath(root))
    const store = mkdtempSync(join(tmpdir(), 'anvil-approvals-'))
    roots.push(store)
    const env = { ANVIL_APPROVAL_HOME: store }
    const before = git(root, 'status', '--porcelain')

    const shown: SetupExecutionPlan[] = []
    const record = await approveSetupPlan({
      saved: plan,
      repository: state,
      confirm: async (planShown) => {
        shown.push(planShown)
        return planShown.digest
      },
      refresh: async () => state,
      env,
    })
    assert.equal(record.status, 'active')
    assert.equal(shown.length, 1)
    assert.equal(shown[0]?.digest, plan.digest)

    // Approving writes to the store only: nothing lands in the repository.
    assert.equal(existsSync(join(root, '.agents')), false)
    assert.equal(git(root, 'status', '--porcelain'), before)

    // The same grant is inspectable and revocable through the CLI.
    const shownRecord = run(root, ['approval', '--grant', record.id, '--json'], env)
    assert.equal(shownRecord.code, 0, shownRecord.stdout)
    assert.equal((JSON.parse(shownRecord.stdout) as { data: { status: string } }).data.status, 'active')

    const revoked = run(root, ['revoke', '--grant', record.id, '--json'], env)
    assert.equal(revoked.code, 0, revoked.stdout)
    assert.equal((JSON.parse(revoked.stdout) as { data: { status: string } }).data.status, 'revoked')
  })

  test('approve refuses a plan that moved while the reviewer read it', async () => {
    const root = repo()
    writeFileSync(join(root, 'skill.md'), skillContent())
    commit(root)
    const plan = executionPlan(root)
    const before = await repositoryState(normalizeGitPath(root))
    const store = mkdtempSync(join(tmpdir(), 'anvil-approvals-'))
    roots.push(store)
    const env = { ANVIL_APPROVAL_HOME: store }

    await assert.rejects(
      () =>
        approveSetupPlan({
          saved: plan,
          repository: before,
          confirm: async () => {
            // The repository changes between showing the plan and refreshing it.
            writeFileSync(join(root, 'skill.md'), skillContent('my-skill', 'Changed while reading.\n'))
            commit(root)
            return plan.digest
          },
          refresh: () => repositoryState(normalizeGitPath(root)),
          env,
        }),
      (error: unknown) => error instanceof SetupApprovalRefusal && error.payload.status === 'stale',
    )
    assert.deepEqual(readdirSync(store), [])
  })

  test('approve refuses an approval whose repository moved during publication', async () => {
    const root = repo()
    writeFileSync(join(root, 'skill.md'), skillContent())
    commit(root)
    const plan = executionPlan(root)
    const before = await repositoryState(normalizeGitPath(root))
    const store = mkdtempSync(join(tmpdir(), 'anvil-approvals-'))
    roots.push(store)
    const env = { ANVIL_APPROVAL_HOME: store }

    let refreshes = 0
    await assert.rejects(
      () =>
        approveSetupPlan({
          saved: plan,
          repository: before,
          confirm: async () => plan.digest,
          refresh: async () => {
            refreshes += 1
            // Revalidation after confirmation sees the same commit; the readback after
            // publication sees a moved HEAD, so the grant must not be reported active.
            return refreshes === 1 ? before : { ...before, head: 'b'.repeat(40) }
          },
          env,
        }),
      (error: unknown) => error instanceof SetupApprovalRefusal,
    )
    // The grant was written, but it is not reported as a successful approval.
    assert.equal(readdirSync(store).length, 1)
  })

  test('approval refuses a stale plan and a non-execution proposal', () => {
    const root = repo({ commands: [{ kind: 'install', cmd: 'npm ci' }] })
    writeFileSync(join(root, 'skill.md'), skillContent())
    commit(root)
    const plan = executionPlan(root)
    const saved = saveData(plan)
    const env = approvalEnv()

    // An owner-command proposal is not a local-skill execution plan.
    const ownerPlan = proposal(root)
    assert.equal(run(root, ['approve', '--plan', save(ownerPlan), '--json'], env, `${ownerPlan.digest}\n`).code, 5)

    // A stale plan (new HEAD, changed source) cannot be approved even with its own digest.
    writeFileSync(join(root, 'skill.md'), skillContent('my-skill', 'A changed body.\n'))
    commit(root)
    assert.equal(run(root, ['approve', '--plan', saved, '--json'], env, `${plan.digest}\n`).code, 5)
  })

  test('approval flags are strict and a confirmation flag is not accepted', () => {
    const root = repo()
    const env = approvalEnv()
    for (const args of [
      ['approve'],
      ['approval'],
      ['revoke'],
      ['approval', '--grant', 'x', '--plan', 'plan.json'],
      ['approve', '--plan', 'plan.json', '--grant', 'x'],
      ['validate', '--plan', 'plan.json', '--grant', 'x'],
      ['plan', '--grant', 'x'],
      ['plan', '--plan', 'plan.json'],
      ['apply', '--plan', 'plan.json'],
      // A digest passed as a flag is not consent and is not a known flag.
      ['approve', '--confirm', 'x'],
    ]) {
      const result = run(root, [...args, '--json'], env)
      assert.equal(result.code, 2, `${args.join(' ')}: ${result.stdout}${result.stderr ?? ''}`)
    }
  })

  test('apply flags are strict: both the plan and the grant are required', () => {
    const root = repo()
    const env = approvalEnv()
    for (const args of [
      ['apply'],
      ['apply', '--plan', 'plan.json'],
      ['apply', '--grant', 'x'],
      ['apply', '--plan', 'plan.json', '--grant', 'x', '--adapter', 'local-skill'],
      ['apply', '--plan', 'plan.json', '--grant', 'x', '--source', 'skill.md'],
      ['apply', '--plan', 'plan.json', '--grant', 'x', '--name', 'my-skill'],
      ['apply', '--plan', 'plan.json', '--grant', 'x', '--confirm', 'yes'],
    ]) {
      const result = run(root, [...args, '--json'], env)
      assert.equal(result.code, 2, `${args.join(' ')}: ${result.stdout}${result.stderr ?? ''}`)
    }
  })

  test('apply installs an approved plan once, then reports the recorded success without writing again', () => {
    const root = repo()
    writeFileSync(join(root, 'skill.md'), skillContent())
    commit(root)
    const plan = executionPlan(root)
    const env = approvalEnv()
    const grant = buildSetupApprovalGrant(plan, { id: '11111111-2222-4333-8444-555555555555' })
    saveSetupApprovalGrant(grant, { env })
    const saved = saveData(plan)

    const applied = run(root, ['apply', '--plan', saved, '--grant', grant.id, '--json'], env)
    assert.equal(applied.code, 0, applied.stdout + applied.stderr)
    const record = (JSON.parse(applied.stdout) as { data: SetupApplicationRecord }).data
    assert.equal(record.status, 'applied')
    assert.equal(record.executed, true)
    assert.equal(record.verified, true)
    const installed = join(root, '.agents', 'skills', 'my-skill', 'SKILL.md')
    assert.equal(readFileSync(installed, 'utf8'), skillContent())
    assert.match(git(root, 'status', '--porcelain'), /\.agents\//)

    const again = run(root, ['apply', '--plan', saved, '--grant', grant.id, '--json'], env)
    assert.equal(again.code, 0, again.stdout + again.stderr)
    const second = (JSON.parse(again.stdout) as { data: SetupApplicationRecord }).data
    assert.equal(second.status, 'applied')
    assert.equal(second.executed, false)
    assert.equal(second.alreadyApplied, true)
    assert.equal(readFileSync(installed, 'utf8'), skillContent())
  })

  test('apply refuses an owner-command proposal and a stale plan without writing', () => {
    const root = repo({ commands: [{ kind: 'install', cmd: 'npm ci' }] })
    writeFileSync(join(root, 'skill.md'), skillContent())
    commit(root)
    const plan = executionPlan(root)
    const env = approvalEnv()
    const grant = buildSetupApprovalGrant(plan, { id: '22222222-3333-4444-8555-666666666666' })
    saveSetupApprovalGrant(grant, { env })

    const owner = run(root, ['apply', '--plan', save(proposal(root)), '--grant', grant.id, '--json'], env)
    assert.equal(owner.code, 5, owner.stdout)
    assert.equal(existsSync(join(root, '.agents')), false)

    writeFileSync(join(root, 'skill.md'), skillContent('my-skill', 'Changed after approval.\n'))
    commit(root)
    const stale = run(root, ['apply', '--plan', saveData(plan), '--grant', grant.id, '--json'], env)
    assert.equal(stale.code, 5, stale.stdout)
    assert.equal((JSON.parse(stale.stdout) as { ok: boolean }).ok, false)
    assert.equal(existsSync(join(root, '.agents')), false)
  })

  test('two real apply processes contend for the repository lock and write exactly once', {
    timeout: 180_000,
  }, async (t) => {
    const root = repo()
    writeFileSync(join(root, 'skill.md'), skillContent())
    commit(root)
    const plan = executionPlan(root)
    const env = approvalEnv()
    const grant = buildSetupApprovalGrant(plan, { id: '33333333-4444-4555-8666-777777777777' })
    saveSetupApprovalGrant(grant, { env })
    const saved = saveData(plan)
    const { ANVIL_APPROVAL_HOME: store } = env
    assert.ok(store)

    // A separate holder owns the real repository lock while both apply processes start.
    // Waiting for its marker and then for three lock records proves both applies are queued
    // concurrently; releasing the holder makes them contend instead of running in sequence.
    const marker = join(store, 'holder-holding')
    const release = join(store, 'holder-release')
    const holder = startHolder(t, {
      ANVIL_TEST_MODE: 'holding',
      ANVIL_TEST_REPO: grant.repository.root,
      ANVIL_TEST_MARKER: marker,
      ANVIL_TEST_RELEASE: release,
      ...env,
    })
    await waitForFile(marker)

    const pending = [
      runConcurrently(t, root, ['apply', '--plan', saved, '--grant', grant.id, '--json'], env),
      runConcurrently(t, root, ['apply', '--plan', saved, '--grant', grant.id, '--json'], env),
    ]
    // Holder, plus both applies: each contender registers exactly one lock record.
    await waitForContention(root, 3)
    writeFileSync(release, 'release')
    const results = await Promise.all(pending)
    const records = results.map((result) => {
      assert.equal(result.code, 0, result.stdout + result.stderr)
      return (JSON.parse(result.stdout) as { ok: boolean; data: SetupApplicationRecord }).data
    })
    assert.deepEqual(
      records.map((record) => record.status),
      ['applied', 'applied'],
      'a contended grant is applied, never refused',
    )
    assert.equal(records.filter((record) => record.executed).length, 1, 'only one process may write')
    assert.equal(
      records.filter((record) => record.alreadyApplied).length,
      1,
      'the loser reports the recorded attempt without writing',
    )
    const outcome = await holder.exited
    assert.equal(outcome.spawnError, null)
    assert.equal(outcome.code, 0, 'the holder released the lock without applying')
    assert.equal(readFileSync(join(root, '.agents', 'skills', 'my-skill', 'SKILL.md'), 'utf8'), skillContent())
    assert.deepEqual(
      readdirSync(join(root, '.git', 'anvil-locks', 'setup-apply.lock')),
      [],
      'every process released the repository lock',
    )
  })

  test('a process killed while holding the lock after its journal started is reported as interrupted', {
    timeout: 180_000,
  }, async (t) => {
    const root = repo()
    writeFileSync(join(root, 'skill.md'), skillContent())
    commit(root)
    const plan = executionPlan(root)
    const env = approvalEnv()
    const grant = buildSetupApprovalGrant(plan, { id: '44444444-5555-4666-8777-888888888888' })
    saveSetupApprovalGrant(grant, { env })
    const saved = saveData(plan)

    const { ANVIL_APPROVAL_HOME: store } = env
    assert.ok(store)
    const marker = join(store, 'holder-started')
    const holder = startHolder(t, {
      ANVIL_TEST_MODE: 'started',
      // The plan records the realpath-normalized root; the holder must use that same spelling
      // or its revalidation refuses the plan as belonging to another repository.
      ANVIL_TEST_REPO: grant.repository.root,
      ANVIL_TEST_HEAD: grant.repository.head,
      ANVIL_TEST_GRANT: grant.id,
      ANVIL_TEST_PLAN: JSON.stringify(plan),
      ANVIL_TEST_MARKER: marker,
      ...env,
    })
    await waitForFile(marker)
    // The holder consumed the attempt, published its `started` journal and is holding the
    // repository lock. Killing it is the crash this test is about: nothing recorded an
    // outcome, and the lock record now belongs to a dead process.
    holder.child.kill('SIGKILL')
    const outcome = await holder.exited
    assert.equal(outcome.spawnError, null)
    assert.notEqual(outcome.code, 0, 'the holder must not exit successfully')

    const result = run(root, ['apply', '--plan', saved, '--grant', grant.id, '--json'], env)
    assert.equal(result.code, 5, result.stdout + result.stderr)
    const record = (JSON.parse(result.stdout) as { ok: boolean; data: SetupApplicationRecord }).data
    assert.equal(record.status, 'interrupted')
    assert.equal(record.executed, false)
    assert.match(record.reason, /never recorded an outcome/)
    assert.equal(existsSync(join(root, '.agents')), false, 'a killed attempt wrote nothing')
    assert.deepEqual(
      readdirSync(join(root, '.git', 'anvil-locks', 'setup-apply.lock')),
      [],
      'the dead lock record is reaped instead of blocking the next apply',
    )
  })

  test('a process killed between reserving the attempt and its journal is reported as interrupted', {
    timeout: 180_000,
  }, async (t) => {
    const root = repo()
    writeFileSync(join(root, 'skill.md'), skillContent())
    commit(root)
    const plan = executionPlan(root)
    const env = approvalEnv()
    const grant = buildSetupApprovalGrant(plan, { id: '55555555-6666-4777-8888-999999999999' })
    saveSetupApprovalGrant(grant, { env })
    const saved = saveData(plan)

    const holder = startHolder(t, {
      ANVIL_TEST_MODE: 'reserved',
      ANVIL_TEST_REPO: grant.repository.root,
      ANVIL_TEST_HEAD: grant.repository.head,
      ANVIL_TEST_GRANT: grant.id,
      ANVIL_TEST_PLAN: JSON.stringify(plan),
      ...env,
    })
    await holder.ready('reserved')
    // The single attempt is now reserved, but the writer died before publishing a journal.
    holder.child.kill('SIGKILL')
    const outcome = await holder.exited
    assert.equal(outcome.spawnError, null)
    assert.notEqual(outcome.code, 0, 'the holder must not exit successfully')

    const result = run(root, ['apply', '--plan', saved, '--grant', grant.id, '--json'], env)
    assert.equal(result.code, 5, result.stdout + result.stderr)
    const record = (JSON.parse(result.stdout) as { ok: boolean; data: SetupApplicationRecord }).data
    assert.equal(record.status, 'interrupted')
    assert.equal(record.executed, false)
    assert.match(record.reason, /no application journal exists/)
    assert.equal(existsSync(join(root, '.agents')), false, 'a reserved-but-journal-less attempt wrote nothing')
    assert.deepEqual(
      readdirSync(join(root, '.git', 'anvil-locks', 'setup-apply.lock')),
      [],
      'the dead lock record is reaped instead of blocking the next apply',
    )
  })

  test('a real reservation caught in its publication window is settled under the lock, not refused', {
    timeout: 180_000,
  }, async (t) => {
    const root = repo()
    writeFileSync(join(root, 'skill.md'), skillContent())
    commit(root)
    const plan = executionPlan(root)
    const env = approvalEnv()
    const grant = buildSetupApprovalGrant(plan, { id: '66666666-7777-4888-8999-aaaaaaaaaaaa' })
    saveSetupApprovalGrant(grant, { env })
    const saved = saveData(plan)

    const holder = startHolder(t, {
      ANVIL_TEST_MODE: 'window',
      ANVIL_TEST_REPO: grant.repository.root,
      ANVIL_TEST_HEAD: grant.repository.head,
      ANVIL_TEST_GRANT: grant.id,
      ANVIL_TEST_PLAN: JSON.stringify(plan),
      ...env,
    })
    await holder.ready('window')

    // The consumed record exists but is multiply-linked right now, so a concurrent reader
    // cannot trust it. The apply below starts while that publication window is still open.
    const applied = runConcurrently(t, root, ['apply', '--plan', saved, '--grant', grant.id, '--json'], env)
    let contention: Error | null = null
    try {
      // One waiter record joins the holder's record only after the reader has taken the settle
      // path and reached the repository lock, so the window is observed, not merely raced.
      await waitForContention(root, 2)
    } catch (cause) {
      contention = cause as Error
    } finally {
      // Closing the window lets the holder release the lock; the waiter then re-reads the record.
      holder.release()
    }
    const result = await applied
    assert.equal(contention, null, `${contention?.message}\n${result.stdout}${result.stderr}`)
    assert.equal(result.code, 5, result.stdout + result.stderr)
    const record = (JSON.parse(result.stdout) as { ok: boolean; data: SetupApplicationRecord }).data
    assert.equal(record.status, 'interrupted')
    assert.equal(record.executed, false)
    assert.match(record.reason, /no application journal exists/)
    assert.doesNotMatch(record.reason, /cannot be inspected/, 'the window is waited out, not called corrupt')
    assert.equal(existsSync(join(root, '.agents')), false, 'the settled attempt wrote nothing')
    const outcome = await holder.exited
    assert.equal(outcome.spawnError, null)
    assert.equal(outcome.code, 0, 'the holder released the lock without applying')
    assert.deepEqual(
      readdirSync(join(root, '.git', 'anvil-locks', 'setup-apply.lock')),
      [],
      'both processes released the repository lock',
    )
  })

  test('a process killed after its temporary file is written is reported as interrupted', {
    timeout: 180_000,
  }, async (t) => {
    const root = repo()
    writeFileSync(join(root, 'skill.md'), skillContent())
    commit(root)
    const plan = executionPlan(root)
    const env = approvalEnv()
    const grant = buildSetupApprovalGrant(plan, { id: '77777777-8888-4999-8aaa-bbbbbbbbbbbb' })
    saveSetupApprovalGrant(grant, { env })
    const saved = saveData(plan)
    const { ANVIL_APPROVAL_HOME: store } = env
    assert.ok(store)

    const marker = join(store, 'publish-temp-written')
    const holder = startHolder(t, {
      ANVIL_TEST_MODE: 'publishing',
      ANVIL_TEST_STEP: 'temp-written',
      ANVIL_TEST_REPO: grant.repository.root,
      ANVIL_TEST_HEAD: grant.repository.head,
      ANVIL_TEST_GRANT: grant.id,
      ANVIL_TEST_PLAN: JSON.stringify(plan),
      ANVIL_TEST_MARKER: marker,
      ...env,
    })
    await waitForFile(marker)
    // The real publisher has written its temporary file but has not linked the destination.
    holder.child.kill('SIGKILL')
    const outcome = await holder.exited
    assert.equal(outcome.spawnError, null)
    assert.notEqual(outcome.code, 0, 'the holder must not exit successfully')

    const destination = join(root, '.agents', 'skills', 'my-skill')
    assert.equal(existsSync(join(destination, 'SKILL.md')), false, 'an unpublished artifact is not visible')
    assert.ok(
      readdirSync(destination).some((name) => /^\.SKILL\.md\..+\.tmp$/.test(name)),
      'the kill landed inside publication, leaving its temporary file',
    )

    const result = run(root, ['apply', '--plan', saved, '--grant', grant.id, '--json'], env)
    assert.equal(result.code, 5, result.stdout + result.stderr)
    const record = (JSON.parse(result.stdout) as { ok: boolean; data: SetupApplicationRecord }).data
    assert.equal(record.status, 'interrupted')
    assert.equal(record.executed, false)
    assert.match(record.reason, /never recorded an outcome/)
    assert.equal(existsSync(join(destination, 'SKILL.md')), false, 'the interrupted attempt is not retried')
    const journal = readSetupApplicationJournal(join(store, grant.id))
    assert.equal(journal.state, 'present')
    assert.equal(journal.state === 'present' ? journal.journal.status : null, 'started')
    assert.deepEqual(
      readdirSync(join(root, '.git', 'anvil-locks', 'setup-apply.lock')),
      [],
      'the dead lock record is reaped instead of blocking the next apply',
    )
  })

  test('a process killed after the destination is linked is reported as interrupted without a rewrite', {
    timeout: 180_000,
  }, async (t) => {
    const root = repo()
    writeFileSync(join(root, 'skill.md'), skillContent())
    commit(root)
    const plan = executionPlan(root)
    const env = approvalEnv()
    const grant = buildSetupApprovalGrant(plan, { id: '88888888-9999-4aaa-8bbb-cccccccccccc' })
    saveSetupApprovalGrant(grant, { env })
    const saved = saveData(plan)
    const { ANVIL_APPROVAL_HOME: store } = env
    assert.ok(store)

    const marker = join(store, 'publish-linked')
    const holder = startHolder(t, {
      ANVIL_TEST_MODE: 'publishing',
      ANVIL_TEST_STEP: 'linked',
      ANVIL_TEST_REPO: grant.repository.root,
      ANVIL_TEST_HEAD: grant.repository.head,
      ANVIL_TEST_GRANT: grant.id,
      ANVIL_TEST_PLAN: JSON.stringify(plan),
      ANVIL_TEST_MARKER: marker,
      ...env,
    })
    await waitForFile(marker)
    // The real publisher linked the destination, but the process died before it recorded an
    // outcome or removed its temporary file. The artifact is present; the attempt is not done.
    holder.child.kill('SIGKILL')
    const outcome = await holder.exited
    assert.equal(outcome.spawnError, null)
    assert.notEqual(outcome.code, 0, 'the holder must not exit successfully')

    const installed = join(root, '.agents', 'skills', 'my-skill', 'SKILL.md')
    assert.equal(readFileSync(installed, 'utf8'), skillContent())
    const publishedAt = statSync(installed).mtimeMs

    const result = run(root, ['apply', '--plan', saved, '--grant', grant.id, '--json'], env)
    assert.equal(result.code, 5, result.stdout + result.stderr)
    const record = (JSON.parse(result.stdout) as { ok: boolean; data: SetupApplicationRecord }).data
    assert.equal(record.status, 'interrupted')
    assert.equal(record.executed, false)
    assert.match(record.reason, /never recorded an outcome/)
    assert.equal(readFileSync(installed, 'utf8'), skillContent(), 'the linked artifact is preserved')
    assert.equal(statSync(installed).mtimeMs, publishedAt, 'the interrupted attempt does not write again')
    const journal = readSetupApplicationJournal(join(store, grant.id))
    assert.equal(journal.state, 'present')
    assert.equal(journal.state === 'present' ? journal.journal.status : null, 'started')
    assert.deepEqual(
      readdirSync(join(root, '.git', 'anvil-locks', 'setup-apply.lock')),
      [],
      'the dead lock record is reaped instead of blocking the next apply',
    )
  })
})
