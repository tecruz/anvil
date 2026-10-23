/**
 * The push guard, tested the way an agent would hit it: through `git push`.
 *
 * A hook asserted only as a string is not tested. These build a real repository with a
 * bare remote, claim a real ticket, and let git run the installed hook -- refused for a
 * plain push, allowed with the marker `anvil ship` sets, and chained with the
 * repository's own hooks when there are any.
 */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, describe, test } from 'node:test'

import { SHIP_GUARD_ENV } from '@anvil/core'
import type { Ticket } from '@anvil/tickets'
import { claimTicket } from '@anvil/worktrees'
import {
  guardKey,
  PUSH_GUARD_DIR,
  PUSH_GUARD_HOOK,
  renderChainedHook,
  renderPrePushHook,
  shellQuote,
} from '@anvil/worktrees/hooks'

const temps: string[] = []
after(() => {
  for (const t of temps) rmSync(t, { recursive: true, force: true })
})

function temp(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  temps.push(dir)
  return dir
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
  const repo = temp('anvil-guard-repo-')
  git(repo, 'init', '--initial-branch=main')
  git(repo, 'config', 'user.email', 'test@example.com')
  git(repo, 'config', 'user.name', 'Test')
  writeFileSync(join(repo, 'README.md'), '# test repo\n', 'utf8')
  git(repo, 'add', '.')
  git(repo, 'commit', '-m', 'init')

  const origin = temp('anvil-guard-origin-')
  execFileSync('git', ['init', '--bare', '--initial-branch=main', origin], { stdio: 'pipe' })
  git(repo, 'remote', 'add', 'origin', origin)
  git(repo, 'push', '-u', 'origin', 'main')
  return { repo, origin }
}

interface PushResult {
  ok: boolean
  output: string
}

function tryPush(cwd: string, branch: string, env: Record<string, string> = {}): PushResult {
  try {
    execFileSync('git', ['push', '-u', 'origin', branch], {
      cwd,
      encoding: 'utf8',
      stdio: 'pipe',
      env: { ...process.env, ...env },
    })
    return { ok: true, output: '' }
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string }
    return { ok: false, output: `${e.stdout ?? ''}${e.stderr ?? ''}` }
  }
}

async function claim(repo: string) {
  return claimTicket({
    repoRoot: repo,
    ticket: ticket(),
    worktreeRoot: join(temp('anvil-guard-wt-'), 'wt'),
  })
}

describe('push guard: rendered hook', () => {
  test('refuses unless the ship marker is exactly 1', () => {
    const hook = renderPrePushHook({ key: 'local-1', previousHook: null })
    assert.match(hook, /^#!\/bin\/sh/)
    assert.match(hook, new RegExp(`\\[ "\\$${SHIP_GUARD_ENV}" = "1" \\]`))
    assert.match(hook, /refusing to push from the claimed worktree for local-1/)
    assert.match(hook, /anvil ship local-1/)
    assert.match(hook, /--no-verify/)
    assert.ok(!hook.includes('\r\n'), 'git runs hooks through sh, so CRLF breaks the shebang')
  })

  test('execs the repository pre-push only after the marker is checked', () => {
    const hook = renderPrePushHook({ key: 'local-1', previousHook: 'C:\\repo\\.githooks\\pre-push' })
    // Forward slashes: a backslash is literal inside a single-quoted sh string, and Git for
    // Windows sh can execute a drive-letter path only in the forward-slash form.
    assert.match(hook, /exec 'C:\/repo\/\.githooks\/pre-push' "\$@"/)
    const markerAt = hook.indexOf('ANVIL_SHIP')
    const execAt = hook.indexOf('exec ')
    assert.ok(markerAt < execAt, 'the guard must run before the chained hook')
  })

  test('a chained hook forwards its arguments and exit code with exec', () => {
    const hook = renderChainedHook('C:\\repo dir\\.githooks\\pre-commit')
    assert.match(hook, /exec 'C:\/repo dir\/\.githooks\/pre-commit' "\$@"/)
    assert.ok(!hook.includes('\r\n'))
  })

  test('guardKey keeps the key script-safe even when it came from a ticket', () => {
    const key = guardKey("../../etc'; rm -rf / #")
    assert.match(key, /^[A-Za-z0-9._-]+$/)
    assert.ok(!key.includes("'"))
    assert.equal(guardKey(''), 'claim')
  })

  test('shellQuote survives a quote in the path', () => {
    assert.equal(shellQuote("a'b"), `'a'\\''b'`)
  })
})

describe('push guard: installed in a claim', () => {
  test('claim installs a pre-push hook in the worktree', async () => {
    const { repo } = makeRepoWithOrigin()
    const result = await claim(repo)

    assert.equal(result.pushGuard.installed, true, result.pushGuard.detail)
    assert.ok(existsSync(join(result.claim.worktreePath, PUSH_GUARD_DIR, PUSH_GUARD_HOOK)))
    assert.match(result.pushGuard.detail, /refuses pushes unless ANVIL_SHIP=1/)
    const configured = git(result.claim.worktreePath, 'config', '--worktree', '--get', 'core.hooksPath')
    assert.equal(
      configured.trim().replace(/\\/g, '/'),
      join(result.claim.worktreePath, PUSH_GUARD_DIR).replace(/\\/g, '/'),
    )
  })

  test('a plain push from the claimed worktree is refused', async () => {
    const { repo } = makeRepoWithOrigin()
    const result = await claim(repo)
    const pushed = tryPush(result.claim.worktreePath, result.claim.branch)

    assert.equal(pushed.ok, false, 'the guard must refuse the push')
    assert.match(pushed.output, /refusing to push/)
    assert.match(pushed.output, /anvil ship local-1/)
  })

  test('ANVIL_SHIP=1 lets the same push through', async () => {
    const { repo, origin } = makeRepoWithOrigin()
    const result = await claim(repo)
    const pushed = tryPush(result.claim.worktreePath, result.claim.branch, { [SHIP_GUARD_ENV]: '1' })

    assert.equal(pushed.ok, true, pushed.output)
    assert.equal(git(origin, 'rev-parse', '--verify', result.claim.branch).trim().length > 0, true)
  })

  test('the guard is per worktree: the main worktree still pushes', async () => {
    const { repo } = makeRepoWithOrigin()
    await claim(repo)
    const pushed = tryPush(repo, 'main')
    assert.equal(pushed.ok, true, pushed.output)
  })

  test("the repository's own pre-push still runs, after the guard allows it", async () => {
    const { repo } = makeRepoWithOrigin()
    mkdirSync(join(repo, '.githooks'), { recursive: true })
    const own = join(repo, '.githooks', PUSH_GUARD_HOOK)
    writeFileSync(own, '#!/bin/sh\nprintf "chained\\n" >> chained.txt\nexit 0\n', 'utf8')
    if (process.platform !== 'win32') chmodSync(own, 0o755)
    git(repo, 'add', '.githooks/pre-push')
    git(repo, 'commit', '-m', 'add a repository pre-push')
    // Claims branch from `origin/main` when it exists, so the hook must be on the remote
    // before the worktree is created or the claim would not see it at all.
    git(repo, 'push', 'origin', 'main')
    git(repo, 'config', 'core.hooksPath', '.githooks')

    const result = await claim(repo)
    assert.equal(result.pushGuard.installed, true, result.pushGuard.detail)
    assert.ok(result.pushGuard.chained.includes(PUSH_GUARD_HOOK), 'pre-push must be chained, not replaced')

    // Refused: the repository's hook must not run on a push the guard blocked.
    const refused = tryPush(result.claim.worktreePath, result.claim.branch)
    assert.equal(refused.ok, false)
    assert.equal(existsSync(join(result.claim.worktreePath, 'chained.txt')), false)

    const allowed = tryPush(result.claim.worktreePath, result.claim.branch, { [SHIP_GUARD_ENV]: '1' })
    assert.equal(allowed.ok, true, allowed.output)
    assert.equal(readFileSync(join(result.claim.worktreePath, 'chained.txt'), 'utf8'), 'chained\n')
  })
})
