/**
 * Isolated snapshots are the trust boundary for the opt-in ship policy. These controls use
 * real temporary git repositories: no model and no network.
 */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, describe, test } from 'node:test'

import { createEvidenceRunner } from '../src/commands/crew.ts'
import {
  prepareVerificationSnapshot,
  type VerificationSnapshot,
  worktreeRootFor,
} from '../src/verification-snapshot.ts'

const temps: string[] = []
after(() => {
  for (const dir of temps) rmSync(dir, { recursive: true, force: true })
})

function temp(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  temps.push(dir)
  return dir
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: 'pipe' })
}

/** Git checks CRLF out on Windows; the test fixture writes LF. Compare content, not newline style. */
function text(path: string): string {
  return readFileSync(path, 'utf8').replace(/\r\n/g, '\n')
}

function cleanRepo(): string {
  const repo = temp('anvil-snapshot-repo-')
  git(repo, 'init', '--initial-branch=main')
  git(repo, 'config', 'user.email', 'test@example.com')
  git(repo, 'config', 'user.name', 'Test')
  writeFileSync(join(repo, 'a.txt'), 'committed\n', 'utf8')
  git(repo, 'add', '.')
  git(repo, 'commit', '-m', 'init')
  return repo
}

describe('isolated verification snapshots', () => {
  test('a clean worktree yields a snapshot of its exact commit', async () => {
    const repo = cleanRepo()
    const commit = git(repo, 'rev-parse', 'HEAD').trim()
    const snapshot = await prepareVerificationSnapshot(repo)
    assert.ok(snapshot !== null)
    assert.equal(snapshot.commit, commit)
    assert.equal(text(join(snapshot.root, 'a.txt')), 'committed\n')

    // Writes in the snapshot cannot touch the claimed worktree.
    writeFileSync(join(snapshot.root, 'a.txt'), 'mutated in snapshot\n', 'utf8')
    writeFileSync(join(snapshot.root, 'extra.txt'), 'transient\n', 'utf8')
    assert.equal(text(join(repo, 'a.txt')), 'committed\n')
    assert.equal(existsSync(join(repo, 'extra.txt')), false)

    const path = snapshot.root
    snapshot.dispose()
    assert.equal(existsSync(path), false)
    snapshot.dispose()
    assert.equal(existsSync(path), false, 'disposing twice is safe')
  })

  test('a dirty worktree fails closed instead of falling back to the mutable checkout', async () => {
    const repo = cleanRepo()
    writeFileSync(join(repo, 'a.txt'), 'uncommitted\n', 'utf8')
    assert.equal(await prepareVerificationSnapshot(repo), null)
  })

  test('a nested directory resolves to its worktree root', () => {
    const repo = cleanRepo()
    mkdirSync(join(repo, 'packages', 'api'), { recursive: true })
    assert.equal(worktreeRootFor(join(repo, 'packages', 'api')), repo)
  })

  test('a linked claim worktree can be snapshotted', async () => {
    const main = cleanRepo()
    const commit = git(main, 'rev-parse', 'HEAD').trim()
    const linked = temp('anvil-linked-worktree-')
    git(main, 'worktree', 'add', '--detach', linked, 'HEAD')

    const snapshot = await prepareVerificationSnapshot(linked)
    assert.ok(snapshot !== null, 'claims are linked worktrees, not plain clones')
    assert.equal(snapshot.commit, commit)
    assert.equal(text(join(snapshot.root, 'a.txt')), 'committed\n')
    snapshot.dispose()
  })

  test('a branch that moved after the snapshot is no longer the checked tree', async () => {
    const repo = cleanRepo()
    const snapshot = await prepareVerificationSnapshot(repo)
    assert.ok(snapshot !== null)
    writeFileSync(join(repo, 'a.txt'), 'second commit\n', 'utf8')
    git(repo, 'add', 'a.txt')
    git(repo, 'commit', '-m', 'second')
    assert.notEqual(git(repo, 'rev-parse', 'HEAD').trim(), snapshot.commit)
    snapshot.dispose()
  })

  test('the policy runner executes in the snapshot and records the logical directory', async () => {
    const repo = cleanRepo()
    mkdirSync(join(repo, 'packages', 'api'), { recursive: true })
    const commit = git(repo, 'rev-parse', 'HEAD').trim()
    const seen: string[] = []
    const snapshots = new Map<string, VerificationSnapshot>()
    const runner = createEvidenceRunner({
      record: true,
      useSnapshot: true,
      snapshots,
      run: async (_command, cwd) => {
        seen.push(cwd)
        return { ok: true, code: 0, stdout: '', stderr: '' }
      },
    })
    try {
      const outcome = await runner('npm test', join(repo, 'packages', 'api'))
      assert.equal(outcome.ok, true)
      assert.equal(seen[0]?.startsWith(repo), false, 'the check did not run in the mutable worktree')
      assert.equal(outcome.logicalCwd, 'packages/api')
      assert.equal(outcome.revision, commit)
      assert.equal(outcome.revisionAfter, commit)
    } finally {
      for (const snapshot of snapshots.values()) snapshot.dispose()
    }
  })

  test('the policy runner fails closed on a dirty worktree', async () => {
    const repo = cleanRepo()
    writeFileSync(join(repo, 'a.txt'), 'uncommitted\n', 'utf8')
    let ran = false
    const snapshots = new Map<string, VerificationSnapshot>()
    const runner = createEvidenceRunner({
      record: true,
      useSnapshot: true,
      snapshots,
      run: async () => {
        ran = true
        return { ok: true, code: 0, stdout: '', stderr: '' }
      },
    })
    const outcome = await runner('npm test', repo)
    assert.equal(ran, false)
    assert.equal(outcome.ok, false)
    assert.equal(outcome.exitObserved, false)
    assert.match(outcome.stderr, /Cannot snapshot a clean commit/)
  })

  test('a branch that moves during the policy check makes the recorded verdict stale', async () => {
    const repo = cleanRepo()
    const snapshots = new Map<string, VerificationSnapshot>()
    const runner = createEvidenceRunner({
      record: true,
      useSnapshot: true,
      snapshots,
      run: async () => {
        writeFileSync(join(repo, 'a.txt'), 'second commit\n', 'utf8')
        git(repo, 'add', 'a.txt')
        git(repo, 'commit', '-m', 'second')
        return { ok: true, code: 0, stdout: '', stderr: '' }
      },
    })
    try {
      const outcome = await runner('npm test', repo)
      assert.notEqual(outcome.revisionAfter, outcome.revision)
    } finally {
      for (const snapshot of snapshots.values()) snapshot.dispose()
    }
  })

  test('without the policy the runner keeps using the mutable checkout', async () => {
    const repo = cleanRepo()
    const seen: string[] = []
    const runner = createEvidenceRunner({
      record: true,
      useSnapshot: false,
      snapshots: new Map(),
      run: async (_command, cwd) => {
        seen.push(cwd)
        return { ok: true, code: 0, stdout: '', stderr: '' }
      },
    })
    const outcome = await runner('npm test', repo)
    assert.equal(seen[0]?.replaceAll('\\', '/'), repo.replaceAll('\\', '/'))
    assert.equal(outcome.logicalCwd, undefined)
    assert.ok(typeof outcome.revision === 'string' && outcome.revision.length > 0, 'a revision was sampled')
  })
})
