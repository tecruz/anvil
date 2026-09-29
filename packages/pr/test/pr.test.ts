import { test, describe, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'

import {
  analyzeRisk,
  codeownersMatches,
  parseCodeowners,
  renderPrBody,
  renderPrTitle,
  resolveReviewers,
} from '@anvil/pr'
import { buildProfile, type ProjectProfile } from '@anvil/profile'
import type { Ticket } from '@anvil/tickets'
import { ship, verifyCommands, type ForgeTransport, type ShipOptions } from '@anvil/worktrees/ship'
import { GitHubProvider, hostFromRemote, parseGhIssue } from '@anvil/providers'

// ===========================================================================
// Risk analysis
// ===========================================================================

const RISK = [
  { glob: '**/migrations/**', level: 'high' as const, reason: 'schema or data migration', origin: 'heuristic' as const },
  { glob: '.github/workflows/**', level: 'high' as const, reason: 'CI definition', origin: 'heuristic' as const },
  { glob: '**/package.json', level: 'medium' as const, reason: 'dependency manifest', origin: 'heuristic' as const },
  { glob: '**/Dockerfile*', level: 'medium' as const, reason: 'image definition', origin: 'heuristic' as const },
]

describe('risk analysis', () => {
  test('finds nothing in an unremarkable diff', () => {
    const r = analyzeRisk(['src/index.ts', 'src/util.ts'], RISK)
    assert.equal(r.level, null)
    assert.deepEqual(r.highPaths, [])
  })

  test('detects a high-risk path', () => {
    const r = analyzeRisk(['app/migrations/0002_add_users.py'], RISK)
    assert.equal(r.level, 'high')
    assert.deepEqual(r.highPaths, ['app/migrations/0002_add_users.py'])
  })

  test('separates high from medium', () => {
    const r = analyzeRisk(['package.json', 'app/migrations/1.py'], RISK)
    assert.equal(r.level, 'high', 'high wins the overall level')
    assert.deepEqual(r.highPaths, ['app/migrations/1.py'])
    assert.deepEqual(r.mediumPaths, ['package.json'])
  })

  test('an unanchored double-star glob matches at any depth', () => {
    const r = analyzeRisk(['migrations/0001.py'], RISK)
    assert.deepEqual(r.highPaths, ['migrations/0001.py'])
  })

  test('an anchored glob does not match at another depth', () => {
    const r = analyzeRisk(['.github/workflows/ci.yml'], RISK)
    assert.deepEqual(r.highPaths, ['.github/workflows/ci.yml'])
    const other = analyzeRisk(['sub/.github/workflows/ci.yml'], RISK)
    assert.deepEqual(other.highPaths, [], '.github/ is anchored to the repo root')
  })

  test('a path matching two globs is reported once per level', () => {
    const r = analyzeRisk(['Dockerfile'], RISK)
    assert.deepEqual(r.mediumPaths, ['Dockerfile'])
  })
})

// ===========================================================================
// CODEOWNERS
// ===========================================================================

describe('CODEOWNERS', () => {
  const OWNERS = [
    '# repository defaults',
    '*                       @platform',
    '',
    '*.js                   @frontend',
    'apps/api/              @backend-team',
    'apps/api/migrations/   @db-team',
    '/docs/                 @writers',
    'infra/                 @sre',
  ].join('\n')

  test('parses rules, dropping comments and blanks', () => {
    const rules = parseCodeowners(OWNERS)
    assert.equal(rules.length, 6)
    assert.deepEqual(rules[0]?.owners, ['@platform'])
  })

  test('the last matching pattern wins, as git specifies', () => {
    assert.deepEqual(resolveReviewers(['apps/api/migrations/001.py'], OWNERS), ['@db-team'])
    assert.deepEqual(resolveReviewers(['apps/api/users.js'], OWNERS), ['@backend-team'])
  })

  test('a later catch-all overrides an earlier specific rule', () => {
    const owners = ['src/ @specific', '* @catchall'].join('\n')
    assert.deepEqual(resolveReviewers(['src/x.ts'], owners), ['@catchall'])
  })

  test('a pattern without a slash matches the file name at any depth', () => {
    // Git's CODEOWNERS rule 1: "a pattern that does not contain a `/` is matched against
    // the file name in any directory". So `*.js` legitimately claims nested files.
    assert.deepEqual(resolveReviewers(['a/b/foo.js'], OWNERS), ['@frontend'])
  })

  test('a pattern containing a slash is matched from the CODEOWNERS directory', () => {
    // Rule 2: a pattern with a slash is relative to the CODEOWNERS file's directory,
    // which for a repo-root file is the repo root. `*.js` still claims it, because rule
    // 1 applies to that pattern and it comes later in the file.
    assert.deepEqual(resolveReviewers(['src/other/api.js'], OWNERS), ['@frontend'])
    assert.deepEqual(resolveReviewers(['docs/nested/deep/readme.md'], OWNERS), ['@writers'])
  })

  test('a leading slash anchors to the root', () => {
    assert.deepEqual(resolveReviewers(['docs/readme.md'], OWNERS), ['@writers'])
    assert.deepEqual(resolveReviewers(['guide/docs/readme.md'], OWNERS), ['@platform'])
  })

  test('reviewers are deduplicated and sorted', () => {
    const owners = ['* @a', 'src/ @b'].join('\n')
    assert.deepEqual(resolveReviewers(['src/x.ts', 'other/y.ts'], owners), ['@a', '@b'])
  })

  test('no CODEOWNERS means no reviewers, not a default', () => {
    assert.deepEqual(resolveReviewers(['a.ts'], ''), [])
  })

  test('pattern matching handles ** across segments', () => {
    assert.equal(codeownersMatches('a/b/c/d.ts', 'a/**/d.ts'), true)
    assert.equal(codeownersMatches('a/d.ts', 'a/**/d.ts'), true)
    assert.equal(codeownersMatches('a/b/x.ts', 'a/**/d.ts'), false)
  })
})

// ===========================================================================
// PR body
// ===========================================================================

const ticket = (over: Partial<Ticket> = {}): Ticket => ({
  ref: { provider: 'github', id: '42', key: 'gh-42', url: 'https://github.com/acme/app/issues/42' },
  title: 'Add login redirect',
  body: 'Users should land on /dashboard after login.',
  acceptance: ['Redirects to /dashboard', 'Preserves returnTo'],
  normalizedState: 'todo',
  ...over,
})

describe('PR body', () => {
  const base = { risk: analyzeRisk([], RISK), reviewers: [] as string[], verifyCommands: ['npm test'] }

  test('leads with the ticket description, not boilerplate', () => {
    const body = renderPrBody({ ...base, ticket: ticket() })
    assert.ok(body.indexOf('Users should land on') < body.indexOf('### Acceptance criteria'))
  })

  test('includes acceptance criteria as a checklist', () => {
    const body = renderPrBody({ ...base, ticket: ticket() })
    assert.match(body, /- \[ \] Redirects to \/dashboard/)
    assert.match(body, /- \[ \] Preserves returnTo/)
  })

  test('includes the GitHub closing keyword so the ticket closes on merge', () => {
    assert.match(renderPrBody({ ...base, ticket: ticket() }), /Closes gh-42/)
  })

  test('a local ticket gets no closing keyword, because there is nothing to close', () => {
    const local = ticket({ ref: { provider: 'local', id: '1', key: 'local-1' } })
    const body = renderPrBody({ ...base, ticket: local })
    assert.doesNotMatch(body, /Closes local-1/)
    assert.match(body, /Ticket: local-1 \(local\)/)
  })

  test('adds a risk checklist naming the files, only when the diff warrants it', () => {
    const clean = renderPrBody({ ...base, ticket: ticket() })
    assert.doesNotMatch(clean, /High-risk changes/)

    const risky = renderPrBody({
      ...base,
      ticket: ticket(),
      risk: analyzeRisk(['app/migrations/1.py'], RISK),
    })
    assert.match(risky, /High-risk changes/)
    assert.match(risky, /app\/migrations\/1\.py/, 'the checklist must name the file that triggered it')
  })

  test('reports verification results when it actually ran them', () => {
    const body = renderPrBody({
      ...base,
      ticket: ticket(),
      verification: [
        { command: 'npm test', ok: true },
        { command: 'npm run lint', ok: false },
      ],
    })
    assert.match(body, /\| `npm test` \| pass \|/)
    assert.match(body, /\| `npm run lint` \| FAIL \|/)
  })

  test('says plainly when verification was not run', () => {
    const body = renderPrBody({ ...base, ticket: ticket() })
    assert.match(body, /Not run by anvil/)
  })

  test('names CODEOWNERS reviewers', () => {
    const body = renderPrBody({ ...base, ticket: ticket(), reviewers: ['backend-team'] })
    assert.match(body, /@backend-team/)
  })

  test('the title is prefixed with the key so it is greppable', () => {
    assert.equal(renderPrTitle(ticket()), 'gh-42: Add login redirect')
  })
})

// ===========================================================================
// Ship pipeline, with an injected transport
// ===========================================================================

interface FakeForge extends ForgeTransport {
  calls: string[]
  pushed: boolean
  prs: Array<{ branch: string; number: number }>
  failPush?: string
}

function fakeForge(options: { existingPr?: number } = {}): FakeForge {
  const calls: string[] = []
  const prs: FakeForge['prs'] = []
  if (options.existingPr !== undefined) prs.push({ branch: 'any', number: options.existingPr })
  return {
    calls,
    pushed: false,
    prs,
    async pushBranch(o) {
      calls.push('push')
      if (this.failPush !== undefined) return { ok: false, detail: this.failPush }
      this.pushed = true
      return { ok: true, detail: `pushed ${o.branch}` }
    },
    async findPullRequest() {
      calls.push('findPr')
      const found = prs.find((p) => p.branch === 'feat/x')
      return found === undefined ? null : { number: found.number, url: `https://github.com/acme/app/pull/${found.number}`, state: 'OPEN' }
    },
    async upsertPullRequest(o) {
      calls.push('upsertPr')
      const existing = prs.find((p) => p.branch === o.branch)
      if (existing !== undefined) return { number: existing.number, url: `https://github.com/acme/app/pull/${existing.number}`, created: false }
      prs.push({ branch: o.branch, number: 7 })
      return { number: 7, url: 'https://github.com/acme/app/pull/7', created: true }
    },
    async sourceLink() {
      return 'https://github.com/acme/app/tree/feat/x'
    },
  }
}

const temps: string[] = []
function repo(): string {
  const d = mkdtempSync(join(tmpdir(), 'anvil-m4-'))
  temps.push(d)
  const git = (...args: string[]): string => execFileSync('git', args, { cwd: d, encoding: 'utf8', stdio: 'pipe' })
  git('init', '--initial-branch=main')
  git('config', 'user.email', 't@e.com')
  git('config', 'user.name', 'T')
  writeFileSync(join(d, 'README.md'), '# repo\n', 'utf8')
  // A real script, so the profile has verify commands to select. Without one, ship has
  // nothing to run and a "verify failed" test passes for the wrong reason.
  writeFileSync(
    join(d, 'package.json'),
    JSON.stringify({ name: 'repo', scripts: { test: 'true', lint: 'true' } }),
    'utf8',
  )
  // A real CODEOWNERS, so reviewer resolution is exercised end to end.
  mkdirSync(join(d, '.github'), { recursive: true })
  writeFileSync(join(d, '.github', 'CODEOWNERS'), '* @platform\napp/ @backend\n', 'utf8')
  mkdirSync(join(d, 'app', 'migrations'), { recursive: true })
  git('add', '.')
  git('commit', '-m', 'init')
  return d
}

function commitIn(dir: string, name: string, message: string): void {
  const path = join(dir, name)
  mkdirSync(join(path, '..'), { recursive: true })
  writeFileSync(path, 'x\n', 'utf8')
  const git = (...args: string[]): string => execFileSync('git', args, { cwd: dir, encoding: 'utf8', stdio: 'pipe' })
  git('add', '.')
  git('commit', '-m', message)
}

/**
 * Put the repo on the feature branch and commit there.
 *
 * Committing on `main` and then asking ship to compare `main..HEAD` finds nothing, which
 * is the refusal working correctly -- and a test that mistakes that for a ship bug wastes
 * an hour.
 */
function workOnBranch(dir: string, name: string, message: string): void {
  const git = (...args: string[]): string => execFileSync('git', args, { cwd: dir, encoding: 'utf8', stdio: 'pipe' })
  git('checkout', '-b', 'feat/x')
  commitIn(dir, name, message)
}

function shipOptions(dir: string, over: Partial<ShipOptions> = {}): ShipOptions {
  const profile = buildProfile(dir, { root: dir, host: null, remote: null, defaultBranch: null }).profile
  return {
    repoRoot: dir,
    worktreePath: dir,
    branch: 'feat/x',
    baseBranch: 'main',
    ticket: ticket(),
    profile,
    transport: fakeForge(),
    run: async () => ({ ok: true, code: 0, stdout: '', stderr: '' }),
    read: (rel) => {
      // Read through Node rather than a shell, so a filename with a space in it works
      // and nothing here can be interpreted as a command.
      try {
        return execFileSync('node', ['-e', `process.stdout.write(require('fs').readFileSync(${JSON.stringify(join(dir, rel))},'utf8'))`], {
          encoding: 'utf8',
        })
      } catch {
        return null
      }
    },
    draft: false,
    extraReviewers: [],
    probe: false,
    skipVerify: false,
    updateTicket: true,
    ...over,
  }
}

after(() => {
  for (const t of temps) rmSync(t, { recursive: true, force: true })
})

describe('verify command selection', () => {
  const profile = {
    commands: {
      testFast: [{ cmd: 'npm run test:fast', source: 'detected' as const }],
      test: [{ cmd: 'npm test', source: 'detected' as const }],
      lint: [{ cmd: 'npm run lint', source: 'detected' as const }],
      build: [{ cmd: 'npm run build', source: 'detected' as const }],
    },
  } as unknown as ProjectProfile
  const cmds = verifyCommands(profile)

  test('runs the cheapest signal first and the slowest last', () => {
    assert.deepEqual(cmds, ['npm run test:fast', 'npm test', 'npm run lint', 'npm run build'])
  })

  test('no duplicates when two kinds share a command', () => {
    const dup = { commands: { test: [{ cmd: 'make check', source: 'detected' as const }], lint: [{ cmd: 'make check', source: 'detected' as const }] } } as unknown as ProjectProfile
    assert.deepEqual(verifyCommands(dup), ['make check'])
  })
})

describe('ship pipeline', () => {
  test('refuses before pushing when there is nothing committed', async () => {
    const dir = repo()
    const forge = fakeForge()
    const result = await ship(shipOptions(dir, { transport: forge }))
    assert.equal(result.ok, false)
    assert.equal(result.stages[0]?.name, 'refuse')
    assert.equal(forge.pushed, false, 'a refused ship must not push')
    assert.deepEqual(forge.calls, [], 'and must not touch the forge at all')
  })

  test('refuses when the worktree has uncommitted changes', async () => {
    const dir = repo()
    workOnBranch(dir, 'a.txt', 'work')
    writeFileSync(join(dir, 'scratch.txt'), 'uncommitted', 'utf8')
    const forge = fakeForge()
    const result = await ship(shipOptions(dir, { transport: forge }))
    assert.equal(result.ok, false)
    assert.match(result.stages[0]?.detail ?? '', /uncommitted/)
    assert.equal(forge.pushed, false)
  })

  test('the happy path runs refuse, push, pr, ticket in that order', async () => {
    const dir = repo()
    workOnBranch(dir, 'a.txt', 'work')
    const forge = fakeForge()
    const commented: string[] = []
    const result = await ship(
      shipOptions(dir, {
        transport: forge,
        ticketOps: {
          comment: async (_ref, body) => {
            commented.push(body)
          },
          transition: async () => {},
        },
      }),
    )
    assert.equal(result.ok, true)
    assert.deepEqual(result.stages.map((s) => s.name), ['refuse', 'verify', 'push', 'pr', 'ticket'])
    assert.equal(result.pr?.number, 7)
    assert.equal(commented.length, 1)
    assert.match(commented[0] ?? '', /#7/)
  })

  test('a failed verify stops the ship before the push', async () => {
    const dir = repo()
    workOnBranch(dir, 'a.txt', 'work')
    const forge = fakeForge()
    const result = await ship(
      shipOptions(dir, {
        transport: forge,
        probe: true,
        run: async () => ({ ok: false, code: 1, stdout: '', stderr: 'tests failed' }),
      }),
    )
    assert.equal(result.ok, false)
    assert.equal(result.stages.find((s) => s.name === 'verify')?.ok, false)
    assert.equal(forge.pushed, false, 'nothing broken may reach the remote')
  })

  test('verify is not run unless asked', async () => {
    const dir = repo()
    workOnBranch(dir, 'a.txt', 'work')
    let ran = 0
    const result = await ship(
      shipOptions(dir, {
        run: async () => {
          ran++
          return { ok: true, code: 0, stdout: '', stderr: '' }
        },
      }),
    )
    assert.equal(result.ok, true)
    assert.equal(ran, 0, 'builds are slow and expensive; opt in with --probe')
    assert.match(result.stages.find((s) => s.name === 'verify')?.detail ?? '', /--probe/)
  })

  test('a push failure stops the ship and reports why', async () => {
    const dir = repo()
    workOnBranch(dir, 'a.txt', 'work')
    const forge = fakeForge()
    forge.failPush = 'permission denied'
    const result = await ship(shipOptions(dir, { transport: forge }))
    assert.equal(result.ok, false)
    assert.equal(result.stages.find((s) => s.name === 'push')?.ok, false)
    assert.match(result.stages.find((s) => s.name === 'push')?.detail ?? '', /permission denied/)
  })

  test('an existing PR is updated rather than duplicated', async () => {
    const dir = repo()
    workOnBranch(dir, 'a.txt', 'work')
    const forge = fakeForge()
    forge.prs.push({ branch: 'feat/x', number: 12 })
    const result = await ship(shipOptions(dir, { transport: forge }))
    assert.equal(result.pr?.number, 12)
    assert.equal(result.pr?.created, false)
  })

  test('a diff touching a high-risk path puts the risk in the ticket comment', async () => {
    const dir = repo()
    workOnBranch(dir, join('app', 'migrations', '001.py'), 'migration')
    const forge = fakeForge()
    const commented: string[] = []
    const result = await ship(
      shipOptions(dir, {
        transport: forge,
        ticketOps: { comment: async (_r, b) => { commented.push(b) }, transition: async () => {} },
      }),
    )
    assert.equal(result.risk.level, 'high')
    assert.match(commented[0] ?? '', /high-risk path/)
  })

  test('a ticket update failure is reported but does not discard the PR', async () => {
    const dir = repo()
    workOnBranch(dir, 'a.txt', 'work')
    const forge = fakeForge()
    const result = await ship(
      shipOptions(dir, {
        transport: forge,
        ticketOps: {
          comment: async () => {
            throw new Error('403 Forbidden')
          },
          transition: async () => {},
        },
      }),
    )
    assert.equal(result.ok, true, 'the PR exists; a ticket failure is not a reason to fail')
    const stage = result.stages.find((s) => s.name === 'ticket')
    assert.equal(stage?.ok, false)
    assert.match(stage?.detail ?? '', /403 Forbidden/)
  })

  test('--skip-verify skips the stage and says so', async () => {
    const dir = repo()
    workOnBranch(dir, 'a.txt', 'work')
    const result = await ship(shipOptions(dir, { skipVerify: true }))
    assert.match(result.stages.find((s) => s.name === 'verify')?.detail ?? '', /--skip-verify/)
  })

  test('reviewers from CODEOWNERS and the command line are merged', async () => {
    const dir = repo()
    workOnBranch(dir, 'app/thing.py', 'work')
    const forge = fakeForge()
    let requested: string[] = []
    const wrapped: ForgeTransport = {
      ...forge,
      upsertPullRequest: async (o) => {
        requested = o.reviewers
        return forge.upsertPullRequest(o)
      },
    }
    await ship(shipOptions(dir, { transport: wrapped, extraReviewers: ['@extra'] }))
    // The diff touches app/, so `@backend` wins over the `*` catch-all by last-match-wins,
    // and the command-line reviewer is added on top. CODEOWNERS owners keep their `@`;
    // gh accepts it, and the PR body strips it for display.
    assert.deepEqual(requested, ['@backend', 'extra'])
  })
})

// ===========================================================================
// gh transport
// ===========================================================================

describe('GitHub transport', () => {
  test('detects the host from ssh and https remotes, including GHE', () => {
    assert.equal(hostFromRemote('git@github.com:acme/app.git'), 'github.com')
    assert.equal(hostFromRemote('https://github.com/acme/app.git'), 'github.com')
    assert.equal(hostFromRemote('git@ghe.acme-corp.com:acme/app.git'), 'ghe.acme-corp.com')
    assert.equal(hostFromRemote(null), null)
  })

  test('a not-logged-in status returns the exact login command for that host', async () => {
    // The GHE case is the common one when joining a new company, and the remediation has
    // to name the host or the user authenticates to the wrong one.
    const provider = new GitHubProvider({
      host: 'ghe.acme-corp.com',
      run: async () => ({ stdout: '', stderr: 'You are not logged into any GitHub hosts. To log in, run: gh auth login', exitCode: 1 }),
    })
    const status = await provider.authStatus()
    assert.equal(status.ok, false)
    assert.equal(status.remediation, 'gh auth login --hostname ghe.acme-corp.com')
  })

  test('a successful status reports who is logged in', async () => {
    const provider = new GitHubProvider({
      host: 'github.com',
      run: async () => ({ stdout: 'github.com\n  ✓ Logged in to github.com account octocat (keyring)', stderr: '', exitCode: 0 }),
    })
    const status = await provider.authStatus()
    assert.equal(status.ok, true)
    assert.equal(status.identity, 'octocat')
  })

  test('an unexpected failure still returns a runnable command', async () => {
    const provider = new GitHubProvider({
      run: async () => ({ stdout: '', stderr: 'something odd happened', exitCode: 2 }),
    })
    const status = await provider.authStatus()
    assert.equal(status.ok, false)
    assert.equal(status.remediation, 'gh auth status')
  })

  test('never passes a body through a shell', async () => {
    // Ticket text is user input. If this ever became a shell string, `; rm -rf /` in a
    // ticket title would execute.
    let seen: string[] = []
    const provider = new GitHubProvider({
      run: async (args) => {
        seen = args
        return { stdout: '{}', stderr: '', exitCode: 0 }
      },
    })
    await provider.comment({ provider: 'github', id: '1', key: 'gh-1' }, 'hello; rm -rf / #$(whoami)')
    assert.ok(seen.includes('hello; rm -rf / #$(whoami)'), 'the body is one argv element')
  })

  test('maps a closed issue to done', () => {
    const t = parseGhIssue(JSON.stringify({ number: 5, title: 'x', state: 'CLOSED', body: '' }), { provider: 'github', id: '5', key: 'gh-5' })
    assert.equal(t.normalizedState, 'done')
  })

  test('infers in_review from a label, because GitHub has no such state', () => {
    const t = parseGhIssue(JSON.stringify({ number: 5, title: 'x', state: 'OPEN', labels: [{ name: 'in-review' }], body: '' }), { provider: 'github', id: '5', key: 'gh-5' })
    assert.equal(t.normalizedState, 'in_review')
  })

  test('infers wontfix before in_review, so the more specific label wins', () => {
    const t = parseGhIssue(
      JSON.stringify({ number: 5, state: 'OPEN', labels: [{ name: 'in-review' }, { name: 'wontfix' }], body: '' }),
      { provider: 'github', id: '5', key: 'gh-5' },
    )
    assert.equal(t.normalizedState, 'wontfix')
  })

  test('extracts acceptance criteria from a checklist', () => {
    const body = 'Do the thing.\n\n- [ ] one\n- [x] two\n'
    const t = parseGhIssue(JSON.stringify({ number: 5, state: 'OPEN', body }), { provider: 'github', id: '5', key: 'gh-5' })
    assert.deepEqual(t.acceptance, ['one', 'two'])
  })

  test('extracts acceptance criteria from a headed section', () => {
    const body = '## Acceptance Criteria\n- first\n- second\n\n## Notes\nnot this\n'
    const t = parseGhIssue(JSON.stringify({ number: 5, state: 'OPEN', body }), { provider: 'github', id: '5', key: 'gh-5' })
    assert.deepEqual(t.acceptance, ['first', 'second'])
  })

  test('preserves the raw payload', () => {
    const raw = { number: 5, state: 'OPEN', body: 'x' }
    const t = parseGhIssue(JSON.stringify(raw), { provider: 'github', id: '5', key: 'gh-5' })
    assert.deepEqual(t.raw, raw)
  })

  test('an unsupported transition names the ones that work', async () => {
    const provider = new GitHubProvider({
      run: async () => ({ stdout: JSON.stringify({ number: 5, state: 'OPEN' }), stderr: '', exitCode: 0 }),
    })
    // The list of supported states lives in the hint, not the message -- which is the
    // point of having a hint, so assert on both.
    await assert.rejects(
      () => provider.transition({ provider: 'github', id: '5', key: 'gh-5' }, 'unknown' as never),
      (err: unknown) => {
        assert.ok(err instanceof Error)
        assert.match(err.message, /Cannot move a GitHub issue to "unknown"/)
        const hint = (err as { hint?: string }).hint ?? ''
        assert.match(hint, /todo, in_progress, in_review, done, wontfix/)
        return true
      },
    )
  })
})

