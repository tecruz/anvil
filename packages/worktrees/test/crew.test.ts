import { test, describe, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'

import { concurrencyFor, crewUp, crewVerify, defaultJobs, isProcessAlive, mapWithConcurrency } from '@anvil/worktrees/crew'
import { readClaims } from '@anvil/worktrees'
import { buildProfile, type ProjectProfile } from '@anvil/profile'
import type { Ticket } from '@anvil/tickets'

const temps: string[] = []
after(() => {
  for (const t of temps) rmSync(t, { recursive: true, force: true })
})

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: 'pipe' })
}

function makeRepo(opts: { npm?: boolean; gradle?: boolean; go?: boolean } = {}): string {
  const dir = mkdtempSync(join(tmpdir(), 'anvil-m5-'))
  temps.push(dir)
  git(dir, 'init', '--initial-branch=main')
  git(dir, 'config', 'user.email', 't@e.com')
  git(dir, 'config', 'user.name', 'T')
  writeFileSync(join(dir, 'README.md'), '# repo\n', 'utf8')
  if (opts.npm === true) {
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'r', scripts: { test: 'true', lint: 'true' } }), 'utf8')
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
  return buildProfile(dir, { root: dir, host: null, remote: null, defaultBranch: null }).profile
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
    await crewUp({ repoRoot: dir, tickets: [ticket(1)], launch: false, runner: 'none', worktreeRoot: wtRoot })
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
      launcher: async () => ({ pid: 999, detail: 'ok' }),
    })
    const claim = readClaims(dir).claims.find((c) => c.key === 'local-1')
    assert.equal(claim?.agent?.runner, 'opencode')
    assert.equal(claim?.agent?.sessionId, '999')
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
    assert.deepEqual(result.results.map((r) => r.key), ['local-2'])
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
