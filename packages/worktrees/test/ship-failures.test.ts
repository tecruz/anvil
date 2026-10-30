import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, describe, test } from 'node:test'
import { buildProfile, type ProjectProfile } from '@anvil/profile'
import type { Ticket } from '@anvil/tickets'
import { claimTicket } from '@anvil/worktrees'
import { type ForgeTransport, ship } from '@anvil/worktrees/ship'

const temps: string[] = []
after(() => {
  for (const t of temps) rmSync(t, { recursive: true, force: true })
})

function temp(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), prefix))
  temps.push(d)
  return d
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: 'pipe' })
}

const ticket = (over: Partial<Ticket> = {}): Ticket => ({
  ref: { provider: 'local', id: '1', key: 'local-1' },
  title: 'Add login redirect',
  body: 'Users land on /dashboard after login.',
  acceptance: ['Redirects to /dashboard'],
  normalizedState: 'todo',
  ...over,
})

function makeRepoWithOrigin(): { repo: string; origin: string } {
  const repo = temp('anvil-ship-repo-')
  git(repo, 'init', '--initial-branch=main')
  git(repo, 'config', 'user.email', 'test@example.com')
  git(repo, 'config', 'user.name', 'Test')
  writeFileSync(join(repo, 'README.md'), '# test repo\n', 'utf8')
  git(repo, 'add', '.')
  git(repo, 'commit', '-m', 'init')

  const origin = temp('anvil-ship-origin-')
  execFileSync('git', ['init', '--bare', '--initial-branch=main', origin], { stdio: 'pipe' })
  git(repo, 'remote', 'add', 'origin', origin)
  git(repo, 'push', '-u', 'origin', 'main')
  return { repo, origin }
}

function profileIn(root: string): ProjectProfile {
  return buildProfile(root, { root, host: null, remote: null, defaultBranch: null }).profile
}

function baseProfile(root: string): ProjectProfile {
  const profile = profileIn(root)
  return {
    ...profile,
    commands: { ...profile.commands, test: [{ cmd: 'true', source: 'documented' as const }] },
  }
}

function recordingTransport(opts: {
  pushOk?: boolean
  pushDetail?: string
  pushThrows?: boolean
  prOk?: boolean
  prDetail?: string
  findThrows?: boolean
}): ForgeTransport & { calls: string[] } {
  const calls: string[] = []
  const transport: ForgeTransport = {
    async pushBranch(options) {
      calls.push(`push:${options.branch}`)
      return { ok: opts.pushOk ?? true, detail: opts.pushDetail ?? 'pushed' }
    },
    async upsertPullRequest(options) {
      calls.push(`pr:${options.branch}`)
      return { number: 42, url: 'https://example.com/pr/42', created: true }
    },
    async findPullRequest() {
      calls.push('find-pr')
      return null
    },
    async sourceLink() {
      calls.push('source-link')
      return null
    },
  }
  if (opts.prOk === false) {
    transport.upsertPullRequest = async () => {
      calls.push('pr-fail')
      throw new Error(opts.prDetail ?? 'PR creation failed')
    }
  }
  if (opts.pushOk === false) {
    transport.pushBranch = async () => {
      calls.push('push-fail')
      return { ok: false, detail: opts.pushDetail ?? 'push rejected' }
    }
  }
  if (opts.pushThrows === true) {
    transport.pushBranch = async () => {
      calls.push('push-throw')
      throw new Error(opts.pushDetail ?? 'network unavailable')
    }
  }
  if (opts.findThrows === true) {
    transport.findPullRequest = async () => {
      calls.push('find-pr-throw')
      throw new Error(opts.prDetail ?? 'gh timed out')
    }
  }
  return { ...transport, calls }
}

function shipOptions(repo: string, worktree: string, transport: ForgeTransport) {
  return {
    repoRoot: repo,
    worktreePath: worktree,
    branch: 'feat/local-1-slug',
    baseBranch: 'main',
    ticket: ticket(),
    profile: baseProfile(repo),
    transport,
    run: async () => ({ ok: true, code: 0, stdout: '', stderr: '' }),
    read: () => null,
    draft: false,
    extraReviewers: [],
    probe: true,
    skipVerify: false,
    updateTicket: false,
  }
}

/** Claim, make a real commit, and return the worktree path/branch for shipping. */
async function claimAndCommit(repo: string): Promise<{ worktreePath: string; branch: string }> {
  const claimResult = await claimTicket({
    repoRoot: repo,
    ticket: ticket(),
    worktreeRoot: join(temp('anvil-ship-claim-'), 'wt'),
  })
  const { claim } = claimResult
  writeFileSync(join(claim.worktreePath, 'change.txt'), 'a change\n', 'utf8')
  git(claim.worktreePath, 'add', 'change.txt')
  git(claim.worktreePath, 'commit', '-m', 'claim work')
  return { worktreePath: claim.worktreePath, branch: claim.branch }
}

describe('ship: failure at each mutation boundary', () => {
  test('verify failure stops before push — nothing reaches the transport', async () => {
    const { repo } = makeRepoWithOrigin()
    const transport = recordingTransport({})
    const { worktreePath } = await claimAndCommit(repo)

    const options = shipOptions(repo, worktreePath, transport)
    options.run = async () => ({ ok: false, code: 1, stdout: '', stderr: 'tests failed' })

    const result = await ship(options)

    assert.equal(result.ok, false)
    assert.equal(result.stages[0]!.name, 'refuse')
    assert.equal(result.stages[0]!.ok, true)
    assert.equal(result.stages[1]!.name, 'verify')
    assert.equal(result.stages[1]!.ok, false)
    assert.equal(
      result.stages.find((s) => s.name === 'push'),
      undefined,
    )
    assert.equal(transport.calls.filter((c) => c.startsWith('push')).length, 0)
  })

  test('push failure — branch is not pushed, no PR stage', async () => {
    const { repo } = makeRepoWithOrigin()
    const transport = recordingTransport({ pushOk: false, pushDetail: 'rejected by hook' })
    const { worktreePath } = await claimAndCommit(repo)

    const options = shipOptions(repo, worktreePath, transport)
    const result = await ship(options)

    assert.equal(result.ok, false)
    assert.equal(result.stages.find((s) => s.name === 'push')?.ok, false)
    assert.equal(
      result.stages.find((s) => s.name === 'pr'),
      undefined,
    )
  })

  test('a thrown push is a failed push stage, not an uncaught crash', async () => {
    const { repo } = makeRepoWithOrigin()
    const transport = recordingTransport({ pushThrows: true, pushDetail: 'network unavailable' })
    const { worktreePath } = await claimAndCommit(repo)

    const result = await ship(shipOptions(repo, worktreePath, transport))

    assert.equal(result.ok, false)
    const push = result.stages.find((s) => s.name === 'push')
    assert.equal(push?.ok, false)
    assert.match(push?.detail ?? '', /network unavailable/)
    assert.equal(
      result.stages.find((s) => s.name === 'pr'),
      undefined,
    )
  })

  test('a provider failure after the push reports that the push already succeeded', async () => {
    const { repo } = makeRepoWithOrigin()
    const transport = recordingTransport({ findThrows: true, prDetail: 'gh timed out' })
    const { worktreePath } = await claimAndCommit(repo)

    const result = await ship(shipOptions(repo, worktreePath, transport))

    assert.equal(result.ok, false)
    assert.equal(result.stages.find((s) => s.name === 'push')?.ok, true)
    const pr = result.stages.find((s) => s.name === 'pr')
    assert.equal(pr?.ok, false)
    assert.match(pr?.detail ?? '', /push succeeded/)
    assert.match(pr?.detail ?? '', /gh timed out/)
    assert.equal(transport.calls.filter((c) => c === 'push:feat/local-1-slug').length, 1)
    assert.equal(transport.calls.includes('find-pr-throw'), true)
  })

  test('an unavailable base branch refuses before the transport is called', async () => {
    const { repo } = makeRepoWithOrigin()
    const transport = recordingTransport({})
    const { worktreePath } = await claimAndCommit(repo)

    const options = shipOptions(repo, worktreePath, transport)
    options.baseBranch = 'does-not-exist'
    const result = await ship(options)

    assert.equal(result.ok, false)
    const refuse = result.stages.find((s) => s.name === 'refuse')
    assert.equal(refuse?.ok, false)
    assert.match(refuse?.detail ?? '', /Cannot resolve base branch/)
    assert.equal(transport.calls.length, 0)
  })

  test('a diff without a merge base refuses before verify, push, or any provider call', async () => {
    const { repo } = makeRepoWithOrigin()
    const transport = recordingTransport({})
    const { worktreePath } = await claimAndCommit(repo)

    // Point the remote-tracking base at an unrelated root commit. The branch still has
    // commits, but the three-dot diff has no merge base -- the same state a shallow fetch
    // can produce after the base advances.
    const unrelated = git(repo, 'commit-tree', 'HEAD^{tree}', '-m', 'unrelated history').trim()
    git(repo, 'update-ref', 'refs/remotes/origin/main', unrelated)

    let verifyRuns = 0
    const options = shipOptions(repo, worktreePath, transport)
    options.run = async () => {
      verifyRuns += 1
      return { ok: true, code: 0, stdout: '', stderr: '' }
    }

    const result = await ship(options)

    assert.equal(result.ok, false)
    const refuse = result.stages.find((s) => s.name === 'refuse')
    assert.equal(refuse?.ok, false)
    assert.match(refuse?.detail ?? '', /Cannot compute changed files/)
    assert.match(refuse?.detail ?? '', /no merge base/)
    assert.match(refuse?.hint ?? '', /shares history/)
    assert.equal(verifyRuns, 0, 'the diff failure is a refusal, so verification must not start')
    assert.equal(
      result.stages.find((s) => s.name === 'push'),
      undefined,
    )
    assert.equal(transport.calls.length, 0)
  })

  for (const explicitRef of [false, true]) {
    test(`a remote-only base ships with risk analysis and the short PR target (explicit ref: ${explicitRef})`, async () => {
      const { repo } = makeRepoWithOrigin()
      execFileSync('git', ['push', 'origin', 'main:refs/heads/release'], { cwd: repo, stdio: 'pipe' })
      const { claim } = await claimTicket({
        repoRoot: repo,
        ticket: ticket(),
        base: 'release',
        worktreeRoot: join(temp('anvil-remote-base-'), 'wt'),
      })
      assert.equal(claim.baseRef, 'origin/release')
      assert.equal(execFileSync('git', ['branch', '--list', 'release'], { cwd: repo, encoding: 'utf8' }).trim(), '')
      writeFileSync(join(claim.worktreePath, 'change.txt'), 'change\n')
      execFileSync('git', ['add', 'change.txt'], { cwd: claim.worktreePath })
      execFileSync('git', ['commit', '-m', 'change'], { cwd: claim.worktreePath, stdio: 'pipe' })
      const transport = recordingTransport({})
      let target: string | undefined
      transport.upsertPullRequest = async (options) => {
        target = options.base
        return { number: 42, url: 'https://example.com/pr/42', created: true }
      }
      const options = {
        ...shipOptions(repo, claim.worktreePath, transport),
        branch: claim.branch,
        baseBranch: claim.baseBranch,
        ...(explicitRef ? { baseRef: claim.baseRef } : {}),
      }
      options.profile.risk = [{ glob: 'change.txt', level: 'high', reason: 'fixture', origin: 'heuristic' }]
      const result = await ship(options)
      assert.equal(result.ok, true)
      assert.equal(target, 'release')
      assert.deepEqual(result.risk.highPaths, ['change.txt'], 'diff must use the resolved ref too')
    })
  }

  test('push succeeds, PR fails — branch pushed but no PR (documented partial failure)', async () => {
    const { repo } = makeRepoWithOrigin()
    const transport = recordingTransport({ pushOk: true, prOk: false, prDetail: 'rate limited' })
    const { worktreePath } = await claimAndCommit(repo)

    const options = shipOptions(repo, worktreePath, transport)
    const result = await ship(options)

    assert.equal(result.ok, false)
    assert.equal(result.stages.find((s) => s.name === 'push')?.ok, true)
    assert.equal(result.stages.find((s) => s.name === 'pr')?.ok, false)
    assert.equal(transport.calls.filter((c) => c.startsWith('push')).length, 1)
  })

  test('happy path — verify passes, push succeeds, PR opened', async () => {
    const { repo } = makeRepoWithOrigin()
    const transport = recordingTransport({})
    const { worktreePath } = await claimAndCommit(repo)

    const options = shipOptions(repo, worktreePath, transport)
    const result = await ship(options)

    assert.equal(result.ok, true)
    assert.equal(result.stages.find((s) => s.name === 'refuse')?.ok, true)
    assert.equal(result.stages.find((s) => s.name === 'verify')?.ok, true)
    assert.equal(result.stages.find((s) => s.name === 'push')?.ok, true)
    assert.equal(result.stages.find((s) => s.name === 'pr')?.ok, true)
    assert.equal(transport.calls.filter((c) => c.startsWith('push')).length, 1)
    assert.equal(result.pr?.number, 42)
  })

  test('skipVerify — no verify stage failures, push still runs', async () => {
    const { repo } = makeRepoWithOrigin()
    const transport = recordingTransport({})
    const { worktreePath } = await claimAndCommit(repo)

    const options = shipOptions(repo, worktreePath, transport)
    options.skipVerify = true
    options.probe = false

    const result = await ship(options)

    assert.equal(result.ok, true)
    const verifyStage = result.stages.find((s) => s.name === 'verify')
    assert.ok(verifyStage !== undefined, 'verify stage exists even when skipped')
    assert.equal(verifyStage!.ok, true)
    assert.equal(result.stages.find((s) => s.name === 'push')?.ok, true)
  })

  test('no verify commands detected — verify stage fails', async () => {
    const { repo } = makeRepoWithOrigin()
    const transport = recordingTransport({})
    const { worktreePath } = await claimAndCommit(repo)

    const options = shipOptions(repo, worktreePath, transport)
    options.profile = { ...options.profile, commands: {} }
    options.probe = true

    const result = await ship(options)

    assert.equal(result.ok, false)
    const verifyStage = result.stages.find((s) => s.name === 'verify')
    assert.ok(verifyStage !== undefined)
    assert.equal(verifyStage!.ok, false)
  })
})
