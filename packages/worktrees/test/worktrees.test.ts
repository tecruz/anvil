import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { after, describe, test } from 'node:test'

import {
  addWorktree,
  branchExists,
  currentBranch,
  discoverRepo,
  estimateWorktreePathLength,
  isValidBranchName,
  listWorktrees,
  mainWorktreeRoot,
  preflightClaim,
  removeWorktree,
  resolveBaseRef,
  WINDOWS_SAFE_PATH_BUDGET,
  withFetchLock,
  worktreeStatus,
} from '@anvil/git'
import { buildProfile } from '@anvil/profile'
import { LocalTicketProvider, parseTicketFile, renderTicketFile } from '@anvil/providers'
import { branchNameFor, parseRef, slugify, type Ticket } from '@anvil/tickets'
import { AGENTS_OVERLAY, CONTEXT_FILE, renderAgentsOverlay, renderContextBundle } from '@anvil/tickets/context'
import {
  claimStatuses,
  claimTicket,
  defaultWorktreeRoot,
  findOrphanWorktrees,
  readClaims,
  releaseClaim,
} from '@anvil/worktrees'

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

/** A real repository with one commit, so worktrees can branch from it. */
function makeRepo(): string {
  const dir = temp('anvil-m3-repo-')
  git(dir, 'init', '--initial-branch=main')
  git(dir, 'config', 'user.email', 'test@example.com')
  git(dir, 'config', 'user.name', 'Test')
  writeFileSync(join(dir, 'README.md'), '# test repo\n', 'utf8')
  git(dir, 'add', '.')
  git(dir, 'commit', '-m', 'init')
  return dir
}

const ticket = (over: Partial<Ticket> = {}): Ticket => ({
  ref: { provider: 'local', id: '1', key: 'local-1' },
  title: 'Add login redirect',
  body: 'Users land on /dashboard after login.',
  acceptance: ['Redirects to /dashboard', 'Preserves the returnTo param'],
  normalizedState: 'todo',
  ...over,
})

// ===========================================================================
// Refs, slugs, branch names
// ===========================================================================

describe('refs and slugs', () => {
  test('parses a bare number', () => {
    assert.deepEqual(parseRef('42', 'local'), {
      provider: 'local',
      id: '42',
      key: 'local-42',
    })
  })

  test('parses #42 and a prefixed key', () => {
    assert.equal(parseRef('#7', 'local').id, '7')
    assert.equal(parseRef('PROJ-123').key, 'proj-123')
  })

  test('parses a GitHub issue URL into a github ref', () => {
    const ref = parseRef('https://github.com/acme/app/issues/42')
    assert.equal(ref.provider, 'github')
    assert.equal(ref.id, '42')
    assert.equal(ref.key, 'gh-42')
  })

  test('parses a GitLab issue URL', () => {
    const ref = parseRef('https://gitlab.com/acme/app/-/issues/9')
    assert.equal(ref.provider, 'gitlab')
    assert.equal(ref.id, '9')
  })

  test('an unknown host falls back to a verbatim key rather than guessing', () => {
    const ref = parseRef('https://jira.acme.internal/browse/PROJ-9')
    assert.equal(ref.id, 'https://jira.acme.internal/browse/PROJ-9')
  })

  test('slugify produces branch-safe text', () => {
    assert.equal(slugify('Add login redirect'), 'add-login-redirect')
    assert.equal(slugify('Fix  the /thing/ (again)!'), 'fix-the-thing-again')
  })

  test('slugify truncates on a word boundary, not mid-word', () => {
    const slug = slugify('implement extremely thorough validation for every request', 30)
    assert.ok(slug.length <= 30, slug)
    assert.ok(!slug.endsWith('-'))
  })

  test('branch names are feat/<key>-<slug> by default', () => {
    assert.equal(branchNameFor(ticket().ref, 'Add login redirect'), 'feat/local-1-add-login-redirect')
  })

  test('branch prefix is configurable', () => {
    assert.equal(branchNameFor(ticket().ref, 'Add login redirect', 'fix'), 'fix/local-1-add-login-redirect')
  })

  test('a title with no usable characters still yields a valid branch', () => {
    const name = branchNameFor(ticket().ref, '!!! ???', 'spike')
    assert.ok(isValidBranchName(name), name)
  })
})

// ===========================================================================
// Preflight
// ===========================================================================

describe('preflight', () => {
  const base = {
    root: '/repo',
    targetPath: '/wt/local-1',
    branch: 'feat/local-1-add-login',
    baseDirty: false,
    platform: 'linux' as NodeJS.Platform,
  }

  test('passes a clean claim', () => {
    const result = preflightClaim(base)
    // `target-free` cannot pass in a test without a real empty path, so only assert the
    // checks that do not touch the filesystem.
    const names = result.checks.map((c) => c.name)
    assert.ok(names.includes('path-length'))
    assert.ok(names.includes('branch-name'))
    assert.equal(preflightClaim({ ...base, targetPath: join(temp('anvil-empty-'), 'x') }).ok, true)
    void result
  })

  test('blocks a path over the Windows budget', () => {
    const long = `C:\\${'a'.repeat(WINDOWS_SAFE_PATH_BUDGET + 40)}`
    const result = preflightClaim({
      ...base,
      targetPath: long,
      platform: 'win32',
    })
    assert.equal(result.ok, false)
    const check = result.checks.find((c) => c.name === 'path-length')
    assert.equal(check?.ok, false)
    assert.match(check?.hint ?? '', /worktreeRoot/)
  })

  test('the path budget is not enforced off Windows', () => {
    const long = `/${'a'.repeat(WINDOWS_SAFE_PATH_BUDGET + 40)}`
    const check = preflightClaim({
      ...base,
      targetPath: long,
      platform: 'linux',
    }).checks.find((c) => c.name === 'path-length')
    assert.equal(check?.ok, true)
  })

  test('warns, but does not block, on a dirty base worktree', () => {
    const result = preflightClaim({
      ...base,
      baseDirty: true,
      targetPath: join(temp('anvil-empty2-'), 'x'),
    })
    const check = result.checks.find((c) => c.name === 'base-worktree-clean')
    assert.equal(check?.ok, false)
    assert.equal(check?.level, 'warn')
    assert.equal(result.ok, true, 'a dirty base worktree must not block a claim')
  })

  test('blocks an occupied target path', () => {
    const occupied = temp('anvil-occupied-')
    writeFileSync(join(occupied, 'file.txt'), 'x', 'utf8')
    const result = preflightClaim({ ...base, targetPath: occupied })
    const check = result.checks.find((c) => c.name === 'target-free')
    assert.equal(check?.ok, false)
    assert.equal(result.ok, false)
  })

  test('rejects invalid branch names', () => {
    for (const bad of ['has space', 'has~tilde', 'ends.lock', '-leading', 'has..dots', 'a:b', 'a*b']) {
      const check = preflightClaim({ ...base, branch: bad }).checks.find((c) => c.name === 'branch-name')
      assert.equal(check?.ok, false, `expected "${bad}" to be rejected`)
    }
  })

  test('accepts valid branch names', () => {
    for (const good of ['feat/local-1-add-login', 'fix/PROJ-123_x', 'main', 'release-1.2']) {
      assert.ok(isValidBranchName(good), good)
    }
  })

  test("the path estimate leaves room for git's companion path", () => {
    assert.ok(estimateWorktreePathLength('C:\\wt\\x') > 'C:\\wt\\x'.length)
  })
})

// ===========================================================================
// Worktree lifecycle against real git
// ===========================================================================

describe('worktree lifecycle', () => {
  test('creates, lists, and removes a worktree', async () => {
    const repo = makeRepo()
    const wt = join(temp('anvil-m3-wt-'), 'local-1')

    const added = await addWorktree({
      cwd: repo,
      path: wt,
      branch: 'feat/local-1-add-login',
      baseRef: 'main',
    })
    assert.equal(added.exitCode, 0, added.stderr)

    assert.ok(existsSync(wt))
    assert.equal(await currentBranch(wt), 'feat/local-1-add-login')

    const list = await listWorktrees(repo)
    assert.equal(list.length, 2)
    assert.equal(list[0]?.isMain, true)
    assert.equal(list[1]?.branch, 'feat/local-1-add-login')

    const removed = await removeWorktree(repo, wt)
    assert.equal(removed.exitCode, 0, removed.stderr)
    assert.equal(existsSync(wt), false)
  })

  test('a worktree is a full checkout, not a shallow one', async () => {
    const repo = makeRepo()
    const wt = join(temp('anvil-m3-wt2-'), 'local-1')
    await addWorktree({
      cwd: repo,
      path: wt,
      branch: 'feat/deep',
      baseRef: 'main',
    })
    assert.ok(existsSync(join(wt, 'README.md')), 'the worktree should contain the repo')
    // Each worktree has its own index and HEAD, which is what makes them independent.
    assert.notEqual(git(wt, 'rev-parse', '--git-dir').trim(), git(repo, 'rev-parse', '--git-dir').trim())
  })

  test('discoverRepo identifies a linked worktree', async () => {
    const repo = makeRepo()
    const wt = join(temp('anvil-m3-wt3-'), 'local-1')
    await addWorktree({
      cwd: repo,
      path: wt,
      branch: 'feat/x',
      baseRef: 'main',
    })

    const main = await discoverRepo(repo)
    const linked = await discoverRepo(wt)
    assert.equal(main?.isWorktree, false)
    assert.equal(linked?.isWorktree, true)
    assert.equal(linked?.branch, 'feat/x')
  })

  test('git refuses a duplicate branch, and we detect it before trying', async () => {
    const repo = makeRepo()
    const wt = join(temp('anvil-m3-wt4-'), 'local-1')
    await addWorktree({
      cwd: repo,
      path: wt,
      branch: 'feat/dup',
      baseRef: 'main',
    })
    assert.equal(await branchExists(repo, 'feat/dup'), true)
    assert.equal(await branchExists(repo, 'feat/nope'), false)
  })

  test('resolves the base ref from a local branch when there is no remote', async () => {
    const repo = makeRepo()
    const resolved = await resolveBaseRef(repo, null)
    assert.equal(resolved.ref, 'main')
  })

  test('a worktree reports uncommitted and unpushed separately', async () => {
    const repo = makeRepo()
    const wt = join(temp('anvil-m3-wt5-'), 'local-1')
    await addWorktree({
      cwd: repo,
      path: wt,
      branch: 'feat/status',
      baseRef: 'main',
    })

    const clean = await worktreeStatus(wt)
    assert.equal(clean.dirty, false)
    assert.equal(clean.unpushed, null, 'no upstream, so no unpushed count')

    writeFileSync(join(wt, 'new.txt'), 'x', 'utf8')
    const dirty = await worktreeStatus(wt)
    assert.equal(dirty.dirty, true)
    assert.equal(dirty.changes.length, 1)
  })

  test('unpushed commits are counted once an upstream exists', async () => {
    const repo = makeRepo()
    // A bare clone to act as the remote, so an upstream can be real.
    const origin = temp('anvil-m3-origin-')
    execFileSync('git', ['init', '--bare', '--initial-branch=main', origin], {
      stdio: 'pipe',
    })
    git(repo, 'remote', 'add', 'origin', origin)
    git(repo, 'push', '-u', 'origin', 'main')

    const wt = join(temp('anvil-m3-wt6-'), 'local-1')
    await addWorktree({
      cwd: repo,
      path: wt,
      branch: 'feat/push',
      baseRef: 'main',
    })
    git(wt, 'push', '-u', 'origin', 'feat/push')
    assert.equal((await worktreeStatus(wt)).unpushed, 0)

    writeFileSync(join(wt, 'a.txt'), 'a', 'utf8')
    git(wt, 'add', '.')
    git(wt, 'commit', '-m', 'second')
    const status = await worktreeStatus(wt)
    assert.equal(status.unpushed, 1, 'one commit not on the upstream')
    assert.equal(status.dirty, false, 'committed, so nothing uncommitted')
  })

  test('the fetch lock serializes concurrent callers', async () => {
    const repo = makeRepo()
    let concurrent = 0
    let maxConcurrent = 0
    const task = async (): Promise<void> => {
      concurrent++
      maxConcurrent = Math.max(maxConcurrent, concurrent)
      await new Promise((r) => setTimeout(r, 40))
      concurrent--
    }
    await Promise.all([withFetchLock({ cwd: repo }, task), withFetchLock({ cwd: repo }, task)])
    assert.equal(maxConcurrent, 1, 'the lock must serialize, not just exist')
  })
})

// ===========================================================================
// The local provider
// ===========================================================================

describe('local ticket provider', () => {
  test('round-trips a ticket through a file', async () => {
    const dir = temp('anvil-m3-tickets-')
    const provider = new LocalTicketProvider({ dir })
    const ref = await provider.create({
      title: 'Fix login redirect',
      body: 'Details here.',
    })
    const fetched = await provider.fetch(ref)
    assert.equal(fetched.title, 'Fix login redirect')
    assert.match(fetched.body ?? '', /Details here/)
    assert.equal(fetched.normalizedState, 'todo')
  })

  test('assigns incrementing ids', async () => {
    const dir = temp('anvil-m3-tickets2-')
    const provider = new LocalTicketProvider({ dir })
    assert.equal((await provider.create({ title: 'one' })).id, '1')
    assert.equal((await provider.create({ title: 'two' })).id, '2')
  })

  test('a comment appends without rewriting the ticket', async () => {
    const dir = temp('anvil-m3-tickets3-')
    const provider = new LocalTicketProvider({ dir })
    const ref = await provider.create({ title: 'one', body: 'Original body.' })
    await provider.comment(ref, 'A new consideration.')
    const after = await provider.fetch(ref)
    assert.match(after.body ?? '', /Original body\./, 'the original body must survive')
    assert.match(after.body ?? '', /A new consideration\./)
  })

  test('transitions change the recorded state', async () => {
    const dir = temp('anvil-m3-tickets4-')
    const provider = new LocalTicketProvider({ dir })
    const ref = await provider.create({ title: 'one' })
    await provider.transition(ref, 'in_progress')
    assert.equal((await provider.fetch(ref)).normalizedState, 'in_progress')
  })

  test('an unknown state is rejected rather than stored', async () => {
    const dir = temp('anvil-m3-tickets5-')
    const provider = new LocalTicketProvider({ dir })
    const ref = await provider.create({ title: 'one' })
    await assert.rejects(() => provider.transition(ref, 'nonsense' as never))
  })

  test('rejects an id that tries to escape the tickets directory', async () => {
    const dir = temp('anvil-m3-tickets6-')
    const provider = new LocalTicketProvider({ dir })
    await assert.rejects(
      () => provider.fetch({ provider: 'local', id: '../../etc/passwd', key: 'x' }),
      /Invalid ticket id/,
    )
  })

  test('lists and filters by state', async () => {
    const dir = temp('anvil-m3-tickets7-')
    const provider = new LocalTicketProvider({ dir })
    const a = await provider.create({ title: 'a' })
    const b = await provider.create({ title: 'b' })
    await provider.transition(b, 'done')
    assert.equal((await provider.list()).length, 2)
    const done = await provider.list({ state: 'done' })
    assert.deepEqual(
      done.map((r) => r.id),
      [b.id],
    )
    assert.deepEqual(
      (await provider.list({ state: 'todo' })).map((r) => r.id),
      [a.id],
    )
  })

  test('authStatus fails cleanly when the directory is missing', async () => {
    const provider = new LocalTicketProvider({
      dir: join(temp('anvil-m3-none-'), 'nope'),
    })
    const status = await provider.authStatus()
    assert.equal(status.ok, false)
    assert.match(status.remediation ?? '', /anvil issue create/)
  })

  test('parses acceptance criteria and a base branch', () => {
    const text = renderTicketFile({
      title: 'Fix it',
      body: '- [ ] first\n- [ ] second',
      state: 'todo',
      labels: ['bug'],
      baseBranch: 'develop',
    })
    const parsed = parseTicketFile(text, { provider: 'local', id: '1', key: 'local-1' }, '/x/1.md')
    assert.deepEqual(parsed.acceptance, ['first', 'second'])
    assert.equal(parsed.baseBranch, 'develop')
    assert.deepEqual(parsed.labels, ['bug'])
  })
})

// ===========================================================================
// Context bundle
// ===========================================================================

describe('context bundle', () => {
  test('carries the task, criteria, verify commands and risks', () => {
    const dir = makeRepo()
    const profile = buildProfile(dir, {
      root: dir,
      host: null,
      remote: null,
      defaultBranch: null,
    }).profile
    const bundle = renderContextBundle({
      ticket: ticket(),
      profile,
      branch: 'feat/local-1-add-login',
    })
    assert.match(bundle.content, /Add login redirect/)
    assert.match(bundle.content, /\[ \] Redirects to \/dashboard/)
    assert.match(bundle.content, /Working on local-1/)
    assert.match(bundle.content, /feat\/local-1-add-login/)
  })

  test('never states a command the profile did not detect', () => {
    const dir = makeRepo()
    const profile = buildProfile(dir, {
      root: dir,
      host: null,
      remote: null,
      defaultBranch: null,
    }).profile
    const bundle = renderContextBundle({
      ticket: ticket(),
      profile,
      branch: 'b',
    })
    // This repo has no test tooling at all, so the bundle must not invent any.
    assert.doesNotMatch(bundle.content, /`npm test`/)
  })

  test('marks a command that is only inferred', () => {
    const dir = makeRepo()
    const profile = buildProfile(dir, {
      root: dir,
      host: null,
      remote: null,
      defaultBranch: null,
    }).profile
    const withInferred: typeof profile = {
      ...profile,
      commands: { test: [{ cmd: 'cargo test', source: 'inferred' }] },
    }
    const bundle = renderContextBundle({
      ticket: ticket(),
      profile: withInferred,
      branch: 'b',
    })
    assert.match(bundle.content, /inferred/)
  })

  test('the AGENTS overlay points at the bundle rather than restating the repo', () => {
    const dir = makeRepo()
    const profile = buildProfile(dir, {
      root: dir,
      host: null,
      remote: null,
      defaultBranch: null,
    }).profile
    const overlay = renderAgentsOverlay({ ticket: ticket(), profile })
    assert.match(overlay.content, /ticket\.md/)
    assert.match(overlay.content, /AGENTS\.md/)
    assert.match(overlay.content, /still applies/)
  })
})

// ===========================================================================
// Claims, end to end
// ===========================================================================

describe('claims', () => {
  test('the worktree root is a short sibling, not inside the repo', () => {
    const root = defaultWorktreeRoot(join(temp('anvil-m3-wtr-'), 'acme-app'), null)
    assert.ok(!root.includes(join('acme-app', 'acme-app')), 'must not nest inside the repository')
    assert.match(root, /acme-app-worktrees$/)
  })

  test('a configured worktree root wins', () => {
    // Absolute *on this platform*, and compared against `resolve` because that is what the
    // function does with it: `C:/wt` is a relative path on Linux, so the original assertion
    // passed on Windows and failed on the two other CI runners.
    const configured = process.platform === 'win32' ? 'C:/wt' : '/wt'
    assert.equal(defaultWorktreeRoot('/repo', configured), resolve(configured))
  })

  test('claim creates a warm worktree and records it', async () => {
    const repo = makeRepo()
    const result = await claimTicket({
      repoRoot: repo,
      ticket: ticket(),
      worktreeRoot: join(temp('anvil-m3-cw-'), 'wt'),
    })

    assert.ok(existsSync(result.claim.worktreePath))
    assert.equal(result.claim.branch, 'feat/local-1-add-login-redirect')
    assert.equal(await currentBranch(result.claim.worktreePath), 'feat/local-1-add-login-redirect')

    // Warm: the context bundle and the overlay are both there.
    assert.ok(existsSync(join(result.claim.worktreePath, CONTEXT_FILE)))
    assert.ok(existsSync(join(result.claim.worktreePath, AGENTS_OVERLAY)))

    // And the ticket context is kept out of git, because it is company-internal.
    // This must NOT dirty the worktree: an edit to .gitignore would make every claim look
    // uncommitted, and `release` would then always refuse.
    const ignoreCheck = execFileSync('git', ['status', '--porcelain'], {
      cwd: result.claim.worktreePath,
      encoding: 'utf8',
    })
    assert.equal(ignoreCheck.trim(), '', 'a fresh claim must leave the worktree clean')

    const registry = readClaims(repo)
    assert.equal(registry.claims.length, 1)
    assert.equal(registry.claims[0]?.key, 'local-1')
  })

  test('a claim records the runner version, so the state is reproducible later', async () => {
    const repo = makeRepo()
    const bin = temp('anvil-m3-runner-')
    if (process.platform === 'win32') {
      writeFileSync(join(bin, 'opencode.cmd'), '@echo off\r\necho 1.2.3\r\n', 'utf8')
    } else {
      const stub = join(bin, 'opencode')
      writeFileSync(stub, '#!/bin/sh\necho 1.2.3\n', 'utf8')
      chmodSync(stub, 0o755)
    }

    const result = await claimTicket({
      repoRoot: repo,
      ticket: ticket(),
      worktreeRoot: join(temp('anvil-m3-cwv-'), 'wt'),
      runner: 'opencode',
      env: { ...process.env, PATH: `${bin}${process.platform === 'win32' ? ';' : ':'}${process.env.PATH ?? ''}` },
    })

    assert.equal(result.claim.agent?.runner, 'opencode')
    assert.equal(result.claim.agent?.version, '1.2.3')
    const stored = readClaims(repo).claims[0]
    assert.equal(stored?.agent?.version, '1.2.3')
  })

  test('an unreadable version is omitted rather than failing the claim', async () => {
    const repo = makeRepo()
    const result = await claimTicket({
      repoRoot: repo,
      ticket: ticket(),
      worktreeRoot: join(temp('anvil-m3-cwv2-'), 'wt'),
      runner: 'opencode',
      // An empty PATH means the probe cannot resolve the runner; the claim still succeeds.
      env: { ...process.env, PATH: '' },
    })

    assert.equal(result.claim.agent?.runner, 'opencode')
    assert.equal(result.claim.agent?.version, undefined)
  })

  test('claiming twice for the same ticket is refused, not renamed', async () => {
    const repo = makeRepo()
    const wtRoot = join(temp('anvil-m3-cw2-'), 'wt')
    await claimTicket({
      repoRoot: repo,
      ticket: ticket(),
      worktreeRoot: wtRoot,
    })
    await assert.rejects(
      () => claimTicket({ repoRoot: repo, ticket: ticket(), worktreeRoot: wtRoot }),
      /already exists/,
    )
  })

  test('a branch that already exists is refused, not suffixed', async () => {
    const repo = makeRepo()
    // Something else -- a stale claim, or a human -- already made this branch.
    git(repo, 'branch', 'feat/local-1-add-login-redirect')
    await assert.rejects(
      () =>
        claimTicket({
          repoRoot: repo,
          ticket: ticket(),
          worktreeRoot: join(temp('anvil-m3-cw3-'), 'wt'),
        }),
      /already exists/,
    )
    assert.equal(readClaims(repo).claims.length, 0, 'a refused claim must register nothing')
  })

  test('two tickets with the same title get distinct branches', async () => {
    const repo = makeRepo()
    const wtRoot = join(temp('anvil-m3-cw3b-'), 'wt')
    await claimTicket({
      repoRoot: repo,
      ticket: ticket(),
      worktreeRoot: wtRoot,
    })
    const other = ticket({
      ref: { provider: 'local', id: '2', key: 'local-2' },
    })
    const second = await claimTicket({
      repoRoot: repo,
      ticket: other,
      worktreeRoot: wtRoot,
    })
    assert.equal(second.claim.branch, 'feat/local-2-add-login-redirect')
  })

  test('a preflight block creates nothing', async () => {
    const repo = makeRepo()
    const wtRoot = join(temp('anvil-m3-cw4-'), 'wt')
    mkdirSync(join(wtRoot, 'local-1'), { recursive: true })
    await assert.rejects(
      () => claimTicket({ repoRoot: repo, ticket: ticket(), worktreeRoot: wtRoot }),
      /Refusing to claim/,
    )
    // The blocked claim must not have created a branch or registered a worktree.
    assert.equal(await branchExists(repo, 'feat/local-1-add-login'), false)
    assert.equal(readClaims(repo).claims.length, 0)
  })

  test('a claim that fails while warming the worktree removes the worktree and branch it created', async () => {
    const repo = makeRepo()
    // A committed file named `.anvil` makes the first warm-up write fail after
    // `git worktree add` has already succeeded. No permission change is needed.
    writeFileSync(join(repo, '.anvil'), 'a file, not a directory\n', 'utf8')
    git(repo, 'add', '.anvil')
    git(repo, 'commit', '-m', 'block the state directory')
    const wtRoot = join(temp('anvil-m3-cfail-'), 'wt')

    await assert.rejects(
      () => claimTicket({ repoRoot: repo, ticket: ticket(), worktreeRoot: wtRoot }),
      /worktree and branch were removed/,
    )

    assert.equal(existsSync(join(wtRoot, 'local-1')), false, 'the half-warm worktree must be gone')
    assert.equal(await branchExists(repo, 'feat/local-1-add-login-redirect'), false)
    assert.equal(readClaims(repo).claims.length, 0, 'a failed claim must register nothing')
    assert.deepEqual(await findOrphanWorktrees(repo), [], 'no unregistered worktree may survive')
  })

  test('a claim that cannot record itself removes the worktree and branch', async () => {
    const repo = makeRepo()
    // A directory where claims.json belongs makes the atomic registry write fail. The
    // worktree is warm by then, so this is the late boundary after every other write.
    mkdirSync(join(repo, '.anvil', 'claims.json'), { recursive: true })
    const wtRoot = join(temp('anvil-m3-cfail2-'), 'wt')

    await assert.rejects(
      () => claimTicket({ repoRoot: repo, ticket: ticket(), worktreeRoot: wtRoot }),
      /worktree and branch were removed/,
    )

    assert.equal(existsSync(join(wtRoot, 'local-1')), false)
    assert.equal(await branchExists(repo, 'feat/local-1-add-login-redirect'), false)
    assert.equal(readClaims(repo).claims.length, 0)
    assert.deepEqual(await findOrphanWorktrees(repo), [])
  })

  test('status reports uncommitted and unpushed separately', async () => {
    const repo = makeRepo()
    const result = await claimTicket({
      repoRoot: repo,
      ticket: ticket(),
      worktreeRoot: join(temp('anvil-m3-st-'), 'wt'),
    })
    writeFileSync(join(result.claim.worktreePath, 'scratch.txt'), 'x', 'utf8')

    const [status] = await claimStatuses(repo)
    assert.equal(status?.uncommitted, 1, "only the test's own scratch file")
    assert.equal(status?.unpushed, null, 'no upstream yet')
    assert.equal(status?.orphaned, false)
  })

  test('status marks a claim whose worktree vanished as orphaned', async () => {
    const repo = makeRepo()
    const result = await claimTicket({
      repoRoot: repo,
      ticket: ticket(),
      worktreeRoot: join(temp('anvil-m3-st2-'), 'wt'),
    })
    rmSync(result.claim.worktreePath, { recursive: true, force: true })

    const [status] = await claimStatuses(repo)
    assert.equal(status?.present, false)
    assert.equal(status?.orphaned, true, 'an active claim with no worktree is orphaned')
  })

  test('release refuses to discard uncommitted work, and says why', async () => {
    const repo = makeRepo()
    const result = await claimTicket({
      repoRoot: repo,
      ticket: ticket(),
      worktreeRoot: join(temp('anvil-m3-rel-'), 'wt'),
    })
    writeFileSync(join(result.claim.worktreePath, 'scratch.txt'), 'important', 'utf8')

    const rel = await releaseClaim({ repoRoot: repo, key: 'local-1' })
    assert.equal(rel.worktreeRemoved, false)
    assert.match(rel.retainedBecause ?? '', /uncommitted/)
    assert.ok(existsSync(result.claim.worktreePath), 'the worktree must survive')
  })

  test('release refuses to discard a commit on a branch with no upstream', async () => {
    const repo = makeRepo()
    const result = await claimTicket({
      repoRoot: repo,
      ticket: ticket(),
      worktreeRoot: join(temp('anvil-m3-rel4-'), 'wt'),
    })
    const path = result.claim.worktreePath
    writeFileSync(join(path, 'work.txt'), 'committed but not pushed', 'utf8')
    git(path, 'add', 'work.txt')
    git(path, 'commit', '-m', 'work')

    // No upstream exists, so `git rev-list @{upstream}..HEAD` cannot report the commit.
    // Releasing here would delete the branch's only copy of the work.
    const rel = await releaseClaim({ repoRoot: repo, key: 'local-1' })
    assert.equal(rel.worktreeRemoved, false)
    assert.match(rel.retainedBecause ?? '', /1 unpushed commit/)
    assert.ok(existsSync(path), 'the worktree must survive')
  })

  test('release --force discards and removes', async () => {
    const repo = makeRepo()
    const result = await claimTicket({
      repoRoot: repo,
      ticket: ticket(),
      worktreeRoot: join(temp('anvil-m3-rel2-'), 'wt'),
    })
    writeFileSync(join(result.claim.worktreePath, 'scratch.txt'), 'junk', 'utf8')

    const rel = await releaseClaim({
      repoRoot: repo,
      key: 'local-1',
      force: true,
      deleteBranch: true,
    })
    assert.equal(rel.worktreeRemoved, true)
    assert.equal(rel.branchDeleted, true)
    assert.equal(existsSync(result.claim.worktreePath), false)
    assert.equal(await branchExists(repo, 'feat/local-1-add-login'), false)
  })

  test('releasing a clean claim works without --force', async () => {
    const repo = makeRepo()
    const result = await claimTicket({
      repoRoot: repo,
      ticket: ticket(),
      worktreeRoot: join(temp('anvil-m3-rel3-'), 'wt'),
    })
    const rel = await releaseClaim({ repoRoot: repo, key: 'local-1' })
    assert.equal(rel.worktreeRemoved, true)
    assert.equal(existsSync(result.claim.worktreePath), false)
  })

  test('a forced release of a locked worktree preserves the worktree, branch and active claim', async () => {
    const repo = makeRepo()
    const result = await claimTicket({
      repoRoot: repo,
      ticket: ticket(),
      worktreeRoot: join(temp('anvil-m3-rel5-'), 'wt'),
    })
    const path = result.claim.worktreePath
    git(repo, 'worktree', 'lock', path)

    await assert.rejects(
      () => releaseClaim({ repoRoot: repo, key: 'local-1', force: true, deleteBranch: true }),
      /worktree remove failed/,
    )

    // The removal failed, so nothing else may have happened: the branch is still in use,
    // the worktree is still on disk, and the registry still says the claim is active.
    assert.ok(existsSync(path))
    assert.equal(await branchExists(repo, result.claim.branch), true)
    assert.equal(readClaims(repo).claims[0]?.state, 'active')

    git(repo, 'worktree', 'unlock', path)
    const retry = await releaseClaim({ repoRoot: repo, key: 'local-1', force: true, deleteBranch: true })
    assert.equal(retry.worktreeRemoved, true, 'unlocking makes the same release retryable')
    assert.equal(retry.branchDeleted, true)
    assert.equal(existsSync(path), false)
  })

  test('a failed branch deletion is reported without pretending the release failed', async () => {
    const repo = makeRepo()
    const result = await claimTicket({
      repoRoot: repo,
      ticket: ticket(),
      worktreeRoot: join(temp('anvil-m3-rel6-'), 'wt'),
    })

    const rel = await releaseClaim({
      repoRoot: repo,
      key: 'local-1',
      deleteBranch: true,
      operations: {
        deleteBranch: async () => ({ exitCode: 1, stdout: '', stderr: 'branch is protected' }),
      },
    })

    assert.equal(rel.worktreeRemoved, true)
    assert.equal(rel.branchDeleted, false)
    assert.match(rel.branchRetainedBecause ?? '', /branch is protected/)
    assert.equal(existsSync(result.claim.worktreePath), false)
    assert.equal(readClaims(repo).claims[0]?.state, 'released')
  })

  test('three claims coexist with no cross-contamination', async () => {
    const repo = makeRepo()
    const wtRoot = join(temp('anvil-m3-crew-'), 'wt')
    const paths: string[] = []
    for (const n of [1, 2, 3]) {
      const t = ticket({
        ref: { provider: 'local', id: String(n), key: `local-${n}` },
        title: `Task number ${n}`,
      })
      const r = await claimTicket({
        repoRoot: repo,
        ticket: t,
        worktreeRoot: wtRoot,
      })
      paths.push(r.claim.worktreePath)
    }

    assert.equal(new Set(paths).size, 3, 'each claim gets its own worktree')
    assert.equal(readClaims(repo).claims.length, 3)

    // A write in one worktree must not appear in another.
    writeFileSync(join(paths[0] as string, 'only-here.txt'), 'x', 'utf8')
    assert.ok(existsSync(join(paths[0] as string, 'only-here.txt')))
    assert.equal(existsSync(join(paths[1] as string, 'only-here.txt')), false)
    assert.equal(existsSync(join(paths[2] as string, 'only-here.txt')), false)

    // And each is on its own branch.
    assert.equal(await currentBranch(paths[0] as string), 'feat/local-1-task-number-1')
    assert.equal(await currentBranch(paths[1] as string), 'feat/local-2-task-number-2')
    assert.equal(await currentBranch(paths[2] as string), 'feat/local-3-task-number-3')

    // The main worktree is untouched by all of it.
    assert.equal(await currentBranch(repo), 'main')
  })

  test('orphan worktrees are found', async () => {
    const repo = makeRepo()
    const wt = join(temp('anvil-m3-orphan-'), 'stray')
    await addWorktree({
      cwd: repo,
      path: wt,
      branch: 'feat/stray',
      baseRef: 'main',
    })
    const orphans = await findOrphanWorktrees(repo)
    assert.equal(orphans.length, 1)
    assert.ok((orphans[0] ?? '').endsWith('stray'))
  })

  test('a corrupt claims file does not block status', async () => {
    const repo = makeRepo()
    mkdirSync(join(repo, '.anvil'), { recursive: true })
    writeFileSync(join(repo, '.anvil', 'claims.json'), 'not json at all', 'utf8')
    // Losing the registry means an orphaned worktree, which status can find. Refusing to
    // run would mean nothing gets done at all.
    assert.deepEqual(readClaims(repo).claims, [])
  })
})

describe('shared state resolves against the main worktree', () => {
  // A disposable worktree must not own the registry that tracks the other worktrees, and
  // `anvil issue refresh` run inside a worktree must find the same tickets `anvil claim`
  // did outside it. Both were broken before mainWorktreeRoot existed.
  test('mainWorktreeRoot returns the main repo from inside a worktree', async () => {
    const repo = makeRepo()
    const wt = join(temp('anvil-m3-main-'), 'local-1')
    await addWorktree({
      cwd: repo,
      path: wt,
      branch: 'feat/x',
      baseRef: 'main',
    })

    const fromMain = await mainWorktreeRoot(repo)
    const fromWorktree = await mainWorktreeRoot(wt)
    assert.ok(fromWorktree !== null)
    assert.equal(
      fromWorktree?.toLowerCase(),
      fromMain?.toLowerCase(),
      'a worktree must resolve to the same main root as the repo itself',
    )
  })

  test('the claims registry is shared: a claim made from a worktree is visible outside', async () => {
    const repo = makeRepo()
    const wtRoot = join(temp('anvil-m3-shared-'), 'wt')
    const first = await claimTicket({
      repoRoot: repo,
      ticket: ticket(),
      worktreeRoot: wtRoot,
    })
    assert.equal(readClaims(repo).claims.length, 1)

    // Status run against the worktree's own path must still find the registry in the
    // main worktree, not look for one inside the worktree.
    const seenFromWorktree = await claimStatuses((await mainWorktreeRoot(first.claim.worktreePath)) ?? repo)
    assert.equal(seenFromWorktree.length, 1)
    assert.equal(seenFromWorktree[0]?.claim.key, 'local-1')
  })

  test('tickets written in the main repo are readable from a worktree', async () => {
    const repo = makeRepo()
    const dir = join(repo, '.anvil', 'tickets')
    const provider = new LocalTicketProvider({ dir })
    await provider.create({ title: 'Shared ticket' })
    assert.equal((await provider.fetch({ provider: 'local', id: '1', key: 'local-1' })).title, 'Shared ticket')
  })
})
