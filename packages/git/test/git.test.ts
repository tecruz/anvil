import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, describe, test } from 'node:test'

import { discoverRepo, type GitRunner, git, gitOrThrow, hasPromisorRemote } from '@anvil/git'

const roots: string[] = []

after(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true })
})

function tempDir(): string {
  const d = mkdtempSync(join(tmpdir(), 'anvil-git-'))
  roots.push(d)
  return d
}

function initRepo(dir: string): void {
  execFileSync('git', ['init', '--initial-branch=main'], {
    cwd: dir,
    stdio: 'pipe',
  })
  execFileSync('git', ['config', 'user.email', 'test@example.com'], {
    cwd: dir,
    stdio: 'pipe',
  })
  execFileSync('git', ['config', 'user.name', 'Test'], {
    cwd: dir,
    stdio: 'pipe',
  })
}

/** A repo with a real HEAD, so branch detection has something to resolve. */
function initRepoWithCommit(dir: string): void {
  initRepo(dir)
  writeFileSync(join(dir, 'README.md'), '# test\n')
  execFileSync('git', ['add', '.'], { cwd: dir, stdio: 'pipe' })
  execFileSync('git', ['commit', '-m', 'init'], { cwd: dir, stdio: 'pipe' })
}

describe('git', () => {
  test('runs a subcommand and returns stdout', async () => {
    const dir = tempDir()
    initRepo(dir)
    const out = await gitOrThrow(['rev-parse', '--is-inside-work-tree'], {
      cwd: dir,
    })
    assert.equal(out.trim(), 'true')
  })

  test('returns a non-zero exit code instead of throwing', async () => {
    const dir = tempDir()
    initRepo(dir)
    const res = await git(['rev-parse', '--verify', 'no-such-ref'], {
      cwd: dir,
    })
    assert.notEqual(res.exitCode, 0)
  })

  test('gitOrThrow throws with the command in the message', async () => {
    const dir = tempDir()
    initRepo(dir)
    await assert.rejects(() => gitOrThrow(['rev-parse', '--verify', 'nope'], { cwd: dir }))
  })

  test('a directory named like a flag is not treated as one', async () => {
    // Arguments are passed as an array, never through a shell, so a hostile ref name
    // cannot become a flag or a command.
    const dir = tempDir()
    initRepo(dir)
    const res = await git(['-C', dir, 'rev-parse', '--is-inside-work-tree'])
    assert.equal(res.exitCode, 0)
    assert.equal(res.stdout.trim(), 'true')
  })
})

describe('hasPromisorRemote', () => {
  test('is false without promisor configuration', async () => {
    const dir = tempDir()
    initRepoWithCommit(dir)
    assert.equal(await hasPromisorRemote(dir), false)
  })

  test('is true when a remote is a promisor', async () => {
    const dir = tempDir()
    initRepoWithCommit(dir)
    execFileSync('git', ['config', 'remote.origin.promisor', 'true'], { cwd: dir, stdio: 'pipe' })
    assert.equal(await hasPromisorRemote(dir), true)
  })

  test('is false when the only promisor remote is explicitly disabled', async () => {
    const dir = tempDir()
    initRepoWithCommit(dir)
    execFileSync('git', ['config', 'remote.origin.promisor', 'false'], { cwd: dir, stdio: 'pipe' })
    assert.equal(await hasPromisorRemote(dir), false)
  })

  test('is true for a partial-clone filter even without the promisor flag', async () => {
    const dir = tempDir()
    initRepoWithCommit(dir)
    execFileSync('git', ['config', 'remote.origin.partialclonefilter', 'blob:none'], { cwd: dir, stdio: 'pipe' })
    assert.equal(await hasPromisorRemote(dir), true)
  })

  test('fails closed when the promisor configuration cannot be read', async () => {
    const dir = tempDir()
    initRepoWithCommit(dir)
    const broken: GitRunner = async () => ({ stdout: '', stderr: 'error: bad config\n', exitCode: 128 })
    assert.equal(await hasPromisorRemote(dir, { run: broken }), true)
  })
})

describe('discoverRepo', () => {
  test('returns null outside a repository', async () => {
    // A temp dir is not a repo, unless a parent temp dir happens to be one.
    const dir = tempDir()
    const info = await discoverRepo(dir)
    assert.equal(info, null)
  })

  test('finds the root and branch from a subdirectory', async () => {
    const dir = tempDir()
    initRepoWithCommit(dir)
    const nested = join(dir, 'a', 'b')
    mkdirSync(nested, { recursive: true })

    const info = await discoverRepo(nested)
    assert.ok(info)
    // realpath.native on both sides: git may report forward slashes and lower-case the
    // drive on Windows, and we normalize at the boundary.
    assert.equal(
      info?.root.toLowerCase().replace(/\//g, '\\'),
      realpathSync.native(dir).toLowerCase().replace(/\//g, '\\'),
    )
    assert.equal(info?.branch, 'main')
    assert.equal(info?.remote, null)
  })

  test('reports a configured origin remote', async () => {
    const dir = tempDir()
    initRepo(dir)
    execFileSync('git', ['remote', 'add', 'origin', 'git@github.com:acme/app.git'], { cwd: dir, stdio: 'pipe' })

    const info = await discoverRepo(dir)
    assert.equal(info?.remote, 'git@github.com:acme/app.git')
  })

  test('returns null branch when HEAD is detached', async () => {
    const dir = tempDir()
    initRepo(dir)
    writeFileSync(join(dir, 'file.txt'), 'hello\n')
    execFileSync('git', ['add', '.'], { cwd: dir, stdio: 'pipe' })
    execFileSync('git', ['commit', '-m', 'init'], { cwd: dir, stdio: 'pipe' })
    execFileSync('git', ['checkout', '--detach', 'HEAD'], {
      cwd: dir,
      stdio: 'pipe',
    })

    const info = await discoverRepo(dir)
    assert.equal(info?.branch, null)
  })

  test('a repo with no commits resolves a root but has no branch yet', async () => {
    const dir = tempDir()
    initRepo(dir)
    const info = await discoverRepo(dir)
    assert.ok(info, 'the root should still resolve')
    // `--initial-branch=main` sets the unborn branch name, but `rev-parse --abbrev-ref
    // HEAD` legitimately fails until the first commit. null is the honest answer.
    assert.equal(info?.branch, null)
  })

  test('reports the realpath-normalized root on Windows', async () => {
    const dir = tempDir()
    initRepoWithCommit(dir)
    const info = await discoverRepo(dir)
    assert.ok(info)
    assert.ok(!info?.root.includes('/') || process.platform !== 'win32', 'no forward slashes on Windows')
  })
})
