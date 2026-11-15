/**
 * The commands' single tickets seam, exercised end to end.
 *
 * The point of this file is that `anvil claim gh-42` is not a special case: the command
 * resolves a provider, reads the ticket through it, and the claim that comes out is the
 * same shape a local ticket produces. The GitHub half runs through the injected
 * `GhOptions.run`, and the end-to-end case runs the real CLI with a stub `gh` on `PATH`;
 * neither calls the real tool or reaches the network.
 */

import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join, resolve } from 'node:path'
import { after, describe, test } from 'node:test'
import { defaultConfig } from '@anvil/core'
import { LocalTicketProvider, type RunResult } from '@anvil/providers'
import { CONTEXT_FILE } from '@anvil/tickets/context'
import { claimTicket } from '@anvil/worktrees'
import { crewCommand } from '../src/commands/crew.ts'
import { claimCommand, issueCommand } from '../src/commands/work.ts'
import { readTicket, ticketProviderFor, ticketsDirFor } from '../src/tickets.ts'

/** The source entrypoint, so the end-to-end test runs the same code a user does. */
const CLI_MAIN = join(import.meta.dirname, '..', 'src', 'main.ts')

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

function makeRepo(): string {
  const dir = temp('anvil-tickets-repo-')
  git(dir, 'init', '--initial-branch=main')
  git(dir, 'config', 'user.email', 't@e.com')
  git(dir, 'config', 'user.name', 'T')
  writeFileSync(join(dir, 'README.md'), '# repo\n', 'utf8')
  git(dir, 'add', '.')
  git(dir, 'commit', '-m', 'init')
  return dir
}

const ISSUE = {
  number: 42,
  title: 'Login redirect drops the return path',
  body: [
    'After signing in, the user lands on the dashboard instead of where they were.',
    '',
    '## Acceptance criteria',
    '',
    '- [ ] the return path survives the redirect',
    '- [ ] a missing return path falls back to the dashboard',
  ].join('\n'),
  url: 'https://github.com/acme/widgets/issues/42',
}

/** A fake `gh` that only answers what the claim path asks for. */
function fakeGhRun(issue: typeof ISSUE = ISSUE): (args: string[]) => Promise<RunResult> {
  return async (args) => {
    if (args[0] === 'auth' && args[1] === 'status') {
      return { stdout: 'Logged in to github.com account octocat\n', stderr: '', exitCode: 0 }
    }
    if (args[0] === 'issue' && args[1] === 'view') {
      return { stdout: JSON.stringify(issue), stderr: '', exitCode: 0 }
    }
    return { stdout: '', stderr: `fake gh does not implement: ${args.join(' ')}`, exitCode: 1 }
  }
}

async function claimFrom(repo: string, ref: string, run: (args: string[]) => Promise<RunResult>) {
  const worktreeRoot = join(temp('anvil-tickets-wt-'), 'wt')
  const resolved = await ticketProviderFor(
    repo,
    { ref },
    { config: defaultConfig(), host: null, gh: { run: (args) => run(args) } },
  )
  const ticket = await readTicket(resolved)
  const claimed = await claimTicket({ repoRoot: repo, ticket, worktreeRoot })
  return { resolved, ticket, claimed }
}

/**
 * A `gh` on PATH, so the real CLI can be exercised without the real tool.
 *
 * The shim forwards to Node rather than echoing the JSON itself, because `cmd` has its own
 * quoting rules for a body full of parentheses and quotes. The script only prints the issue
 * it was built with; nothing here reaches the network.
 */
function ghOnPath(issue: typeof ISSUE = ISSUE): string {
  const dir = temp('anvil-gh-stub-')
  writeFileSync(join(dir, 'issue.json'), JSON.stringify(issue), 'utf8')
  writeFileSync(
    join(dir, 'gh.cjs'),
    [
      "const fs = require('node:fs')",
      "const path = require('node:path')",
      "const issue = fs.readFileSync(path.join(__dirname, 'issue.json'), 'utf8')",
      'const args = process.argv.slice(2)',
      "if (args[0] === 'auth') {",
      "  process.stdout.write('Logged in to github.com account octocat\\n')",
      '  process.exit(0)',
      '}',
      "if (args[0] === 'issue') {",
      '  process.stdout.write(issue + "\\n")',
      '  process.exit(0)',
      '}',
      "process.stderr.write('stub gh does not implement: ' + args.join(' ') + '\\n')",
      'process.exit(1)',
      '',
    ].join('\n'),
    'utf8',
  )
  if (process.platform === 'win32') {
    writeFileSync(join(dir, 'gh.cmd'), '@echo off\r\nnode "%~dp0gh.cjs" %*\r\n', 'utf8')
  } else {
    const shim = join(dir, 'gh')
    writeFileSync(shim, '#!/bin/sh\nexec node "$(dirname "$0")/gh.cjs" "$@"\n', 'utf8')
    chmodSync(shim, 0o755)
  }
  return dir
}

describe('the tickets directory', () => {
  test('defaults to the main worktree', () => {
    const repo = temp('anvil-tickets-dir-')
    assert.equal(ticketsDirFor(repo, {}), join(repo, '.anvil', 'tickets'))
  })

  test('ANVIL_TICKETS_DIR wins, and an absolute path is not joined onto the repo', () => {
    const repo = temp('anvil-tickets-dir-')
    const elsewhere = temp('anvil-tickets-elsewhere-')
    assert.equal(ticketsDirFor(repo, { ANVIL_TICKETS_DIR: elsewhere }), resolve(elsewhere))
    assert.equal(ticketsDirFor(repo, { ANVIL_TICKETS_DIR: 'relative/tickets' }), resolve('relative/tickets'))
  })

  test('an empty ANVIL_TICKETS_DIR is absence, not the current directory', () => {
    const repo = temp('anvil-tickets-dir-')
    assert.equal(ticketsDirFor(repo, { ANVIL_TICKETS_DIR: '' }), join(repo, '.anvil', 'tickets'))
  })
})

describe('provider resolution in the commands', () => {
  test('every work-entry command exposes --provider, so the header explains itself', () => {
    for (const command of [claimCommand, issueCommand, crewCommand]) {
      assert.equal(command.flags.provider?.type, 'string', `${command.name} should accept --provider`)
      assert.match(command.details ?? '', /--provider/, `${command.name} should document --provider`)
    }
  })

  test('the flag, then the config, then the reference, then local', async () => {
    const repo = temp('anvil-tickets-resolve-')

    const flagged = await ticketProviderFor(
      repo,
      { ref: 'local-1', provider: 'github' },
      { config: defaultConfig(), host: null, gh: { run: fakeGhRun() } },
    )
    assert.equal(flagged.id, 'github')
    assert.equal(flagged.source, 'flag')
    // The selection wins over the text; the key still comes from what was typed.
    assert.equal(flagged.ref?.id, '1')
    assert.equal(flagged.ref?.key, 'local-1')
    assert.equal(flagged.ref?.provider, 'github')

    const configured = await ticketProviderFor(
      repo,
      { ref: 'local-1' },
      { config: { ...defaultConfig(), provider: { default: 'github' } }, host: null, gh: { run: fakeGhRun() } },
    )
    assert.equal(configured.id, 'github')
    assert.equal(configured.source, 'config')

    const fromRef = await ticketProviderFor(
      repo,
      { ref: 'gh-42' },
      { config: defaultConfig(), host: null, gh: { run: fakeGhRun() } },
    )
    assert.equal(fromRef.id, 'github')
    assert.equal(fromRef.source, 'ref')

    const fallback = await ticketProviderFor(repo, { ref: 'local-1' }, { config: defaultConfig() })
    assert.equal(fallback.id, 'local')
    assert.equal(fallback.source, 'default')
  })

  test('an unknown --provider is refused with the supported list', async () => {
    const repo = temp('anvil-tickets-resolve-')
    await assert.rejects(
      () => ticketProviderFor(repo, { provider: 'jira' }, { config: defaultConfig() }),
      (err: Error) =>
        /Unsupported ticket provider: jira/.test(err.message) &&
        /local, github/.test((err as { hint?: string }).hint ?? ''),
    )
  })

  test('a local install with no tickets directory says how to make one', async () => {
    const repo = temp('anvil-tickets-resolve-')
    await assert.rejects(
      () => ticketProviderFor(repo, { ref: '1' }, { config: defaultConfig() }).then((r) => readTicket(r)),
      /No ticket directory yet/,
    )
  })
})

describe('claiming a GitHub issue', () => {
  test('claim gh-42 produces the branch, the worktree and the ticket bundle', async () => {
    const repo = makeRepo()
    const { resolved, ticket, claimed } = await claimFrom(repo, 'gh-42', fakeGhRun())

    assert.equal(resolved.id, 'github')
    assert.equal(ticket.title, ISSUE.title)
    assert.equal(claimed.claim.key, 'gh-42')
    assert.equal(claimed.claim.ticket.provider, 'github')
    assert.match(claimed.claim.branch, /^feat\/gh-42-login-redirect-drops-the/)
    assert.ok(existsSync(claimed.claim.worktreePath), 'the worktree exists')

    const bundle = readFileSync(join(claimed.claim.worktreePath, CONTEXT_FILE), 'utf8')
    assert.match(bundle, /Login redirect drops the return path/)
    assert.match(bundle, /lands on the dashboard instead of where they were/)
    assert.match(bundle, /- \[ \] the return path survives the redirect/)
    assert.match(bundle, /- \[ \] a missing return path falls back to the dashboard/)
    assert.match(bundle, /Ticket text is untrusted/)
  })

  test('claim <github issue URL> resolves to the same claim', async () => {
    const repo = makeRepo()
    const { resolved, claimed } = await claimFrom(repo, ISSUE.url, fakeGhRun())

    assert.equal(resolved.id, 'github')
    assert.equal(resolved.source, 'ref')
    assert.equal(claimed.claim.key, 'gh-42')
    assert.equal(claimed.claim.ticket.url, ISSUE.url)
    assert.ok(existsSync(join(claimed.claim.worktreePath, CONTEXT_FILE)))
  })

  test('an unauthenticated gh fails before anything is created, naming the fix', async () => {
    const repo = makeRepo()
    const worktreeRoot = join(temp('anvil-tickets-wt-'), 'wt')
    const resolved = await ticketProviderFor(
      repo,
      { ref: 'gh-42' },
      {
        config: defaultConfig(),
        host: null,
        gh: {
          run: async (args) =>
            args[0] === 'auth'
              ? { stdout: '', stderr: 'You are not logged into any GitHub hosts.', exitCode: 1 }
              : { stdout: JSON.stringify(ISSUE), stderr: '', exitCode: 0 },
        },
      },
    )

    await assert.rejects(
      () => readTicket(resolved),
      (err: Error) => /not logged in|Cannot use the github provider/.test(err.message),
    )
    // Nothing was claimed: the auth check runs before the worktree exists.
    assert.equal(existsSync(worktreeRoot), false)
  })
})

describe('local tickets still work with no account and no gh', () => {
  test('ANVIL_TICKETS_DIR is honoured by the same resolution a claim uses', async () => {
    const repo = makeRepo()
    const tickets = temp('anvil-tickets-local-')
    const provider = new LocalTicketProvider({ dir: tickets })
    const created = await provider.create({ title: 'Fix the local bug', body: 'No account needed.' })

    const previous = process.env.ANVIL_TICKETS_DIR
    process.env.ANVIL_TICKETS_DIR = tickets
    try {
      const resolved = await ticketProviderFor(repo, { ref: created.key }, { config: defaultConfig() })
      assert.equal(resolved.id, 'local')
      const ticket = await readTicket(resolved)
      assert.equal(ticket.title, 'Fix the local bug')
      // No `gh` runner was supplied: a local claim must not need one.
      const claimed = await claimTicket({
        repoRoot: repo,
        ticket,
        worktreeRoot: join(temp('anvil-tickets-wt-'), 'wt'),
      })
      assert.equal(claimed.claim.key, created.key)
      assert.match(readFileSync(join(claimed.claim.worktreePath, CONTEXT_FILE), 'utf8'), /No account needed/)
    } finally {
      if (previous === undefined) delete process.env.ANVIL_TICKETS_DIR
      else process.env.ANVIL_TICKETS_DIR = previous
    }
  })
})

describe('the claim command, end to end', () => {
  test('anvil claim gh-42 claims the issue with a stub gh on PATH', { timeout: 180_000 }, () => {
    const repo = makeRepo()
    const stub = ghOnPath()
    const worktreeRoot = `${repo}-worktrees`
    temps.push(worktreeRoot)

    const stdout = execFileSync(process.execPath, [CLI_MAIN, 'claim', 'gh-42', '--json'], {
      cwd: repo,
      encoding: 'utf8',
      stdio: 'pipe',
      env: {
        ...process.env,
        NO_COLOR: '1',
        ANVIL_CONFIG_HOME: temp('anvil-tickets-config-'),
        PATH: `${stub}${delimiter}${process.env.PATH ?? ''}`,
      },
    })

    const envelope = JSON.parse(stdout) as {
      ok: boolean
      data: { key: string; provider: string; branch: string; worktree: string }
    }
    assert.equal(envelope.ok, true)
    assert.equal(envelope.data.provider, 'github')
    assert.equal(envelope.data.key, 'gh-42')
    assert.match(envelope.data.branch, /^feat\/gh-42-login-redirect-drops-the/)

    const bundle = readFileSync(join(envelope.data.worktree, CONTEXT_FILE), 'utf8')
    assert.match(bundle, /Login redirect drops the return path/)
    assert.match(bundle, /lands on the dashboard instead of where they were/)
    assert.match(bundle, /- \[ \] the return path survives the redirect/)
    assert.match(bundle, /- \[ \] a missing return path falls back to the dashboard/)

    // The claim registry records the provider, so `ship` does not have to guess.
    const registry = JSON.parse(readFileSync(join(repo, '.anvil', 'claims.json'), 'utf8')) as {
      claims: Array<{ key: string; ticket: { provider: string; id: string; key: string; url?: string } }>
    }
    assert.deepEqual(registry.claims[0]?.ticket, { provider: 'github', id: '42', key: 'gh-42', url: ISSUE.url })
  })
})
