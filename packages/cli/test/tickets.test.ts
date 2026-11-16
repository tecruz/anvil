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
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join, resolve } from 'node:path'
import { after, describe, test } from 'node:test'
import { defaultConfig, makeStyle } from '@anvil/core'
import { LocalTicketProvider, type RunResult } from '@anvil/providers'
import type { TicketProvider, TicketRef } from '@anvil/tickets'
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
function ghOnPath(issue: typeof ISSUE = ISSUE, list: Array<typeof ISSUE> = [], logPath: string | null = null): string {
  const dir = temp('anvil-gh-stub-')
  writeFileSync(join(dir, 'issue.json'), JSON.stringify(issue), 'utf8')
  writeFileSync(join(dir, 'list.json'), JSON.stringify(list), 'utf8')
  writeFileSync(
    join(dir, 'gh.cjs'),
    [
      "const fs = require('node:fs')",
      "const path = require('node:path')",
      "const issue = fs.readFileSync(path.join(__dirname, 'issue.json'), 'utf8')",
      "const list = fs.readFileSync(path.join(__dirname, 'list.json'), 'utf8')",
      `const logPath = ${JSON.stringify(logPath)}`,
      'const args = process.argv.slice(2)',
      'if (logPath !== null) fs.appendFileSync(logPath, JSON.stringify(args) + "\\n")',
      'const at = args.lastIndexOf("--")',
      'const id = at === -1 ? args[2] : args[at + 1]',
      'const flag = (name) => { const i = args.indexOf(name); return i === -1 ? undefined : args[i + 1] }',
      "if (args[0] === 'auth') {",
      "  process.stdout.write('Logged in to github.com account octocat\\n')",
      '  process.exit(0)',
      '}',
      "if (args[0] === 'repo' && args[1] === 'view') {",
      '  process.stdout.write(JSON.stringify({ url: "https://github.com/acme/widgets" }) + "\\n")',
      '  process.exit(0)',
      '}',
      "if (args[0] === 'issue' && args[1] === 'list') {",
      // Synchronous: a large listing written asynchronously is cut short by process.exit.
      '  fs.writeSync(1, list + "\\n")',
      '  process.exit(0)',
      '}',
      "if (args[0] === 'issue' && args[1] === 'view') {",
      // Answer for the number asked for, the way gh does. A stub that always replays one
      // issue makes separate claims collide on one branch.
      '  const wanted = JSON.parse(list).find((entry) => String(entry.number) === String(id))',
      '  process.stdout.write((wanted === undefined ? issue : JSON.stringify(wanted)) + "\\n")',
      '  process.exit(0)',
      '}',
      "if (args[0] === 'issue' && args[1] === 'create') {",
      '  process.stdout.write("https://github.com/acme/widgets/issues/77\\n")',
      '  process.exit(0)',
      '}',
      "if (args[0] === 'issue' && args[1] === 'comment') {",
      '  process.stdout.write("https://github.com/acme/widgets/issues/" + id + "#issuecomment-1\\n")',
      '  process.exit(0)',
      '}',
      "if (args[0] === 'issue' && (args[1] === 'close' || args[1] === 'reopen' || args[1] === 'edit')) {",
      '  process.exit(0)',
      '}',
      "if (args[0] === 'pr' && args[1] === 'view') {",
      "  process.stderr.write('no pull requests found for branch\\n')",
      '  process.exit(1)',
      '}',
      "if (args[0] === 'pr' && args[1] === 'create') {",
      '  process.stdout.write("https://github.com/acme/widgets/pull/9\\n")',
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

  test('ANVIL_TICKETS_DIR wins, and a relative path is resolved against the main worktree', () => {
    const repo = temp('anvil-tickets-dir-')
    const elsewhere = temp('anvil-tickets-elsewhere-')
    assert.equal(ticketsDirFor(repo, { ANVIL_TICKETS_DIR: elsewhere }), resolve(elsewhere))
    assert.equal(ticketsDirFor(repo, { ANVIL_TICKETS_DIR: 'relative/tickets' }), resolve(repo, 'relative/tickets'))
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

  test('a configured local provider still wins over a GitHub URL reference', async () => {
    const repo = temp('anvil-tickets-resolve-')
    const resolved = await ticketProviderFor(
      repo,
      { ref: ISSUE.url },
      {
        config: { ...defaultConfig(), provider: { default: 'local' } },
        host: null,
        gh: { run: fakeGhRun() },
      },
    )
    assert.equal(resolved.id, 'local')
    assert.equal(resolved.source, 'config')
    assert.equal(resolved.ref?.url, ISSUE.url)
  })

  test('GH_HOST makes an enterprise issue URL select github without any origin probe', async () => {
    const repo = temp('anvil-tickets-resolve-')
    const enterprise = {
      ...ISSUE,
      url: 'https://ghe.acme-corp.com/acme/widgets/issues/42',
    }
    const resolved = await ticketProviderFor(
      repo,
      { ref: enterprise.url },
      {
        config: defaultConfig(),
        host: null,
        env: { GH_HOST: 'ghe.acme-corp.com' },
        gh: { run: fakeGhRun(enterprise) },
      },
    )
    assert.equal(resolved.id, 'github')
    assert.equal(resolved.source, 'ref')
    assert.equal(resolved.ref?.id, '42')
  })

  test('a ticket URL authenticates against its own host, not the checkout origin', async () => {
    const repo = temp('anvil-tickets-resolve-')
    const calls: string[][] = []
    const run = fakeGhRun()
    const resolved = await ticketProviderFor(
      repo,
      { ref: ISSUE.url },
      {
        config: defaultConfig(),
        host: 'ghe.acme-corp.com',
        gh: {
          run: async (args) => {
            calls.push(args)
            return run(args)
          },
        },
      },
    )
    await readTicket(resolved)
    const auth = calls.find((args) => args[0] === 'auth' && args[1] === 'status')
    assert.deepEqual(auth, ['auth', 'status', '--hostname', 'github.com'])
    const view = calls.find((args) => args[0] === 'issue' && args[1] === 'view')
    assert.ok(view !== undefined)
    assert.equal(view[view.indexOf('--repo') + 1], 'github.com/acme/widgets')
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

describe('a listing decides the work, so its failures are not empty answers', () => {
  test('a failed GitHub listing fails issue list instead of reporting no tickets', { timeout: 180_000 }, () => {
    // `issue list` and `crew up` both read "no tickets" as "nothing to do". A 403 is not
    // an empty backlog, and must reach the caller as a failure with the transport's words.
    const repo = makeRepo()
    const stub = temp('anvil-gh-failing-')
    writeFileSync(
      join(stub, 'gh.cjs'),
      [
        'const args = process.argv.slice(2)',
        "if (args[0] === 'auth') {",
        "  process.stdout.write('Logged in to github.com account octocat\\n')",
        '  process.exit(0)',
        '}',
        "process.stderr.write('HTTP 403: resource not accessible by integration\\n')",
        'process.exit(1)',
        '',
      ].join('\n'),
      'utf8',
    )
    if (process.platform === 'win32') {
      writeFileSync(join(stub, 'gh.cmd'), '@echo off\r\nnode "%~dp0gh.cjs" %*\r\n', 'utf8')
    } else {
      const shim = join(stub, 'gh')
      writeFileSync(shim, '#!/bin/sh\nexec node "$(dirname "$0")/gh.cjs" "$@"\n', 'utf8')
      chmodSync(shim, 0o755)
    }

    let failure: { status: number; stdout: string; stderr: string } | null = null
    try {
      execFileSync(process.execPath, [CLI_MAIN, 'issue', 'list', '--provider', 'github', '--json'], {
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
    } catch (err) {
      const e = err as { status?: number; stdout?: string; stderr?: string }
      failure = { status: e.status ?? -1, stdout: e.stdout ?? '', stderr: e.stderr ?? '' }
    }

    assert.ok(failure !== null, 'a failed listing must exit non-zero')
    assert.notEqual(failure.status, 0)
    const envelope = JSON.parse(failure.stdout) as { ok: boolean; error?: { message?: string } }
    assert.equal(envelope.ok, false)
    assert.match(envelope.error?.message ?? '', /403/)
  })

  test('crew up --limit asks the provider for that many, not for a default page', { timeout: 180_000 }, () => {
    // One ready issue behind a full 1,000-issue page of reviewed work. `--limit 1` is
    // answerable from that page; listing the default 30 first would report the backlog as
    // incomplete and refuse to start a crew that `issue list --limit 1` can see.
    const repo = makeRepo()
    const reviewing = Array.from({ length: 999 }, (_, i) => ({
      ...ISSUE,
      number: i + 1,
      title: `Reviewed ${i + 1}`,
      url: `https://github.com/acme/widgets/issues/${i + 1}`,
      labels: [{ name: 'in-review' }],
    }))
    const ready = { ...ISSUE, number: 1000, title: 'Ready', url: 'https://github.com/acme/widgets/issues/1000' }
    const stub = ghOnPath(ready, [...reviewing, ready])
    const worktreeRoot = `${repo}-crew-worktrees`
    temps.push(worktreeRoot)
    const configHome = temp('anvil-tickets-config-')
    writeFileSync(
      join(configHome, 'anvil.config.json'),
      JSON.stringify({ schemaVersion: 1, git: { worktreeRoot } }),
      'utf8',
    )

    const stdout = execFileSync(
      process.execPath,
      [CLI_MAIN, 'crew', 'up', '--provider', 'github', '--limit', '1', '--json'],
      {
        cwd: repo,
        encoding: 'utf8',
        stdio: 'pipe',
        env: {
          ...process.env,
          NO_COLOR: '1',
          ANVIL_CONFIG_HOME: configHome,
          PATH: `${stub}${delimiter}${process.env.PATH ?? ''}`,
        },
      },
    )

    const envelope = JSON.parse(stdout) as { ok: boolean; data: { claims: Array<{ key: string }> } }
    assert.equal(envelope.ok, true)
    assert.deepEqual(
      envelope.data.claims.map((c) => c.key),
      ['gh-1000'],
    )
  })

  test('crew up claims only the tickets still in todo', { timeout: 180_000 }, () => {
    // A ticket already in review is not ready work. The crew takes its list from the
    // provider, so the provider's answer -- not just its --state flag -- has to exclude it.
    const repo = makeRepo()
    const todo = { ...ISSUE, number: 42, title: 'Login redirect drops the return path' }
    const alsoTodo = {
      ...ISSUE,
      number: 44,
      title: 'Expired sessions skip the audit log',
      url: 'https://github.com/acme/widgets/issues/44',
    }
    const reviewing = {
      ...ISSUE,
      number: 43,
      title: 'Already in review',
      url: 'https://github.com/acme/widgets/issues/43',
      labels: [{ name: 'in-review' }],
    }
    // The stub answers every `issue list` with all three, regardless of flags, the way a
    // server cannot express "open but not in-review". Filtering is the provider's job.
    const stub = ghOnPath(todo, [todo, reviewing, alsoTodo])
    const worktreeRoot = `${repo}-crew-worktrees`
    temps.push(worktreeRoot)
    const configHome = temp('anvil-tickets-config-')
    writeFileSync(
      join(configHome, 'anvil.config.json'),
      JSON.stringify({ schemaVersion: 1, git: { worktreeRoot } }),
      'utf8',
    )

    const stdout = execFileSync(process.execPath, [CLI_MAIN, 'crew', 'up', '--provider', 'github', '--json'], {
      cwd: repo,
      encoding: 'utf8',
      stdio: 'pipe',
      env: {
        ...process.env,
        NO_COLOR: '1',
        ANVIL_CONFIG_HOME: configHome,
        PATH: `${stub}${delimiter}${process.env.PATH ?? ''}`,
      },
    })

    const envelope = JSON.parse(stdout) as {
      ok: boolean
      data: { claims: Array<{ key: string; branch: string }>; failures: unknown[] }
    }
    assert.equal(envelope.ok, true)
    assert.deepEqual(envelope.data.failures, [])
    // Only the two todo issues may become claims; the in-review issue is not ready work.
    assert.deepEqual(
      envelope.data.claims.map((c) => c.key),
      ['gh-42', 'gh-44'],
    )
  })
})

describe('the issue subcommands select GitHub at the command level', () => {
  function runIssue(repo: string, stub: string, args: string[]): string {
    return execFileSync(process.execPath, [CLI_MAIN, 'issue', ...args, '--provider', 'github', '--json'], {
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
  }

  test('create writes through GitHub, not local', { timeout: 180_000 }, () => {
    const repo = makeRepo()
    const stub = ghOnPath()
    const envelope = JSON.parse(runIssue(repo, stub, ['create', 'A GitHub issue'])) as {
      ok: boolean
      data: { provider: string; created: { provider: string; id: string; key: string; url?: string } }
    }
    assert.equal(envelope.ok, true)
    assert.equal(envelope.data.provider, 'github')
    assert.equal(envelope.data.created.provider, 'github')
    assert.equal(envelope.data.created.key, 'gh-77')
    assert.equal(existsSync(join(repo, '.anvil', 'tickets', '77.md')), false, 'no local file was written')
  })

  test('show reads through GitHub', { timeout: 180_000 }, () => {
    const repo = makeRepo()
    const stub = ghOnPath(ISSUE)
    const envelope = JSON.parse(runIssue(repo, stub, ['show', '42'])) as {
      ok: boolean
      data: { provider: string; ticket: { ref: { key: string }; title: string } }
    }
    assert.equal(envelope.ok, true)
    assert.equal(envelope.data.provider, 'github')
    assert.equal(envelope.data.ticket.ref.key, 'gh-42')
    assert.equal(envelope.data.ticket.title, ISSUE.title)
  })

  test('comment writes through GitHub', { timeout: 180_000 }, () => {
    const repo = makeRepo()
    const log = join(temp('anvil-gh-log-'), 'calls.jsonl')
    const stub = ghOnPath(ISSUE, [], log)
    const envelope = JSON.parse(runIssue(repo, stub, ['comment', '42', '--body', 'hello'])) as {
      ok: boolean
      data: { provider: string }
    }
    assert.equal(envelope.ok, true)
    assert.equal(envelope.data.provider, 'github')
    const calls = readFileSync(log, 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as string[])
    const comment = calls.find((args) => args[0] === 'issue' && args[1] === 'comment')
    assert.ok(comment !== undefined)
    assert.equal(comment[comment.indexOf('--body') + 1], 'hello')
    assert.equal(comment[comment.indexOf('--') + 1], '42')
  })

  test('set-state transitions through GitHub', { timeout: 180_000 }, () => {
    const repo = makeRepo()
    const log = join(temp('anvil-gh-log-'), 'calls.jsonl')
    const stub = ghOnPath(ISSUE, [], log)
    const envelope = JSON.parse(runIssue(repo, stub, ['set-state', '42', 'in_review'])) as {
      ok: boolean
      data: { provider: string; state: string }
    }
    assert.equal(envelope.ok, true)
    assert.equal(envelope.data.provider, 'github')
    assert.equal(envelope.data.state, 'in_review')
    const calls = readFileSync(log, 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as string[])
    assert.ok(calls.some((args) => args[0] === 'issue' && args[1] === 'edit'))
  })

  for (const sub of ['pull', 'refresh'] as const) {
    test(`${sub} reads the ticket through GitHub`, { timeout: 180_000 }, () => {
      const repo = makeRepo()
      const stub = ghOnPath(ISSUE)
      const envelope = JSON.parse(runIssue(repo, stub, [sub, '42'])) as {
        ok: boolean
        data: { ref: { key: string }; written: string[] }
      }
      assert.equal(envelope.ok, true)
      assert.equal(envelope.data.ref.key, 'gh-42')
      assert.ok(envelope.data.written.includes('.anvil/ticket.md'))
      assert.match(readFileSync(join(repo, '.anvil', 'ticket.md'), 'utf8'), /Login redirect drops the return path/)
    })
  }
})

describe('ship resolves the claim provider at the CLI boundary', () => {
  function repoWithRemote(): string {
    const repo = makeRepo()
    const remote = temp('anvil-ship-remote-')
    git(remote, 'init', '--bare', '--initial-branch=main')
    git(repo, 'remote', 'add', 'origin', remote)
    git(repo, 'push', '-u', 'origin', 'main')
    return repo
  }

  // On Windows the stub `gh` is a `.cmd` shim, and anvil refuses by design to pass a
  // multi-line pull request body through cmd (packages/core/src/exec.ts, assertSafeArgument).
  // A real `gh.exe` is not a shim, so this is a limit of the stub, not of ship: the claim and
  // provider resolution these tests pin are platform-independent and run on Linux and macOS.
  const shipSkip =
    process.platform === 'win32' ? 'the stub gh is a .cmd shim, which ship refuses for a multi-line body' : false

  function runCli(cwd: string, stub: string, args: string[], env: NodeJS.ProcessEnv): string {
    return execFileSync(process.execPath, [CLI_MAIN, ...args], {
      cwd,
      encoding: 'utf8',
      stdio: 'pipe',
      env: {
        ...process.env,
        NO_COLOR: '1',
        ANVIL_CONFIG_HOME: temp('anvil-tickets-config-'),
        PATH: `${stub}${delimiter}${process.env.PATH ?? ''}`,
        ...env,
      },
    })
  }

  function commitWork(worktree: string): void {
    writeFileSync(join(worktree, 'change.txt'), 'shipped\n', 'utf8')
    git(worktree, 'add', 'change.txt')
    git(worktree, 'commit', '-m', 'ship this change')
  }

  test('a local claim uses ANVIL_TICKETS_DIR relative to the main worktree, from a worktree', {
    timeout: 180_000,
    skip: shipSkip,
  }, async () => {
    const repo = repoWithRemote()
    const log = join(temp('anvil-gh-log-'), 'calls.jsonl')
    const stub = ghOnPath(ISSUE, [], log)
    const env = { ANVIL_TICKETS_DIR: 'custom-tickets' }

    runCli(repo, stub, ['issue', 'create', 'Local ship target'], env)
    const claimed = JSON.parse(runCli(repo, stub, ['claim', 'local-1', '--json'], env)) as {
      data: { worktree: string; key: string }
    }
    assert.equal(claimed.data.key, 'local-1')
    commitWork(claimed.data.worktree)

    const shipped = JSON.parse(runCli(claimed.data.worktree, stub, ['ship', 'local-1', '--json'], env)) as {
      ok: boolean
      data: { stages: Array<{ name: string; ok: boolean }> }
    }
    assert.equal(shipped.ok, true)
    assert.deepEqual(shipped.data.stages.find((stage) => stage.name === 'ticket')?.ok, true)

    // The local ticket in the custom directory advanced, and no GitHub issue command ran.
    const ticketFile = readFileSync(join(repo, 'custom-tickets', '1.md'), 'utf8')
    assert.match(ticketFile, /state: in_review/)
    assert.match(ticketFile, /pull request/i)
    const calls = readFileSync(log, 'utf8')
      .trim()
      .split('\n')
      .filter((line) => line !== '')
      .map((line) => JSON.parse(line) as string[])
    assert.equal(
      calls.some((args) => args[0] === 'issue'),
      false,
      'a local ticket must not be updated through GitHub',
    )
  })

  test('a GitHub claim keeps its URL, so ship updates the claimed repository', {
    timeout: 180_000,
    skip: shipSkip,
  }, () => {
    const repo = repoWithRemote()
    const issue = { ...ISSUE, url: 'https://github.com/acme/other-repo/issues/42' }
    const log = join(temp('anvil-gh-log-'), 'calls.jsonl')
    const stub = ghOnPath(issue, [issue], log)

    const claimed = JSON.parse(
      execFileSync(process.execPath, [CLI_MAIN, 'claim', issue.url, '--json'], {
        cwd: repo,
        encoding: 'utf8',
        stdio: 'pipe',
        env: {
          ...process.env,
          NO_COLOR: '1',
          ANVIL_CONFIG_HOME: temp('anvil-tickets-config-'),
          PATH: `${stub}${delimiter}${process.env.PATH ?? ''}`,
        },
      }),
    ) as { data: { worktree: string; key: string } }
    assert.equal(claimed.data.key, 'gh-42')
    commitWork(claimed.data.worktree)

    const shipped = JSON.parse(
      execFileSync(process.execPath, [CLI_MAIN, 'ship', 'gh-42', '--json'], {
        cwd: claimed.data.worktree,
        encoding: 'utf8',
        stdio: 'pipe',
        env: {
          ...process.env,
          NO_COLOR: '1',
          ANVIL_CONFIG_HOME: temp('anvil-tickets-config-'),
          PATH: `${stub}${delimiter}${process.env.PATH ?? ''}`,
        },
      }),
    ) as { ok: boolean }
    assert.equal(shipped.ok, true)

    const calls = readFileSync(log, 'utf8')
      .trim()
      .split('\n')
      .filter((line) => line !== '')
      .map((line) => JSON.parse(line) as string[])
    for (const command of ['comment', 'edit'] as const) {
      const call = calls.find((args) => args[0] === 'issue' && args[1] === command)
      assert.ok(call !== undefined, `issue ${command} was never called`)
      assert.equal(call[call.indexOf('--repo') + 1], 'github.com/acme/other-repo')
    }
  })
})

describe('issue sync refuses a URL from a different repository', () => {
  test('a claim for repo A is not used for a repo B issue URL', { timeout: 180_000 }, async () => {
    const repo = makeRepo()
    const claimUrl = 'https://github.com/acme/repo-A/issues/42'
    const requested = 'https://github.com/acme/repo-B/issues/42'
    mkdirSync(join(repo, '.anvil'), { recursive: true })
    writeFileSync(
      join(repo, '.anvil', 'claims.json'),
      JSON.stringify({
        schemaVersion: 1,
        claims: [
          {
            key: 'gh-42',
            ticket: { provider: 'github', id: '42', key: 'gh-42', url: claimUrl },
            branch: 'feat/gh-42-thing',
            baseBranch: 'main',
            baseRef: 'main',
            worktreePath: repo,
            worktreeId: null,
            state: 'active',
            createdAt: '2026-01-01T00:00:00Z',
          },
        ],
      }),
      'utf8',
    )

    const provider: TicketProvider = {
      id: 'github',
      capabilities: {
        create: true,
        comment: true,
        transition: true,
        link: true,
        list: true,
        rawBodies: false,
      },
      authStatus: async () => ({ ok: true }),
      fetch: async (ref: TicketRef) => ({ ref, title: 'stub', normalizedState: 'todo' }),
      list: async () => [],
      create: async () => ({ provider: 'github', id: '1', key: 'gh-1' }),
      comment: async () => undefined,
      transitions: async () => [],
      transition: async () => undefined,
      link: async () => undefined,
    }
    const ctx = {
      cwd: repo,
      repoRoot: repo,
      repo: null,
      style: makeStyle(false),
      json: true,
      say: () => undefined,
      out: () => undefined,
      outFailure: () => undefined,
      writeRaw: () => undefined,
      writeError: () => undefined,
      providerFor: async () => ({
        id: 'github' as const,
        source: 'config' as const,
        provider,
        ref: { provider: 'github', id: '42', key: 'gh-42', url: requested },
      }),
    }

    await assert.rejects(
      () => issueCommand.run(ctx, ['sync', requested, '--json']),
      (err: Error) => /repo-B/.test(err.message) && /repo-A/.test(err.message),
    )
  })
})

describe('commands enforce provider capabilities themselves', () => {
  function stubProvider(): TicketProvider {
    return {
      id: 'stub',
      capabilities: {
        create: false,
        comment: false,
        transition: false,
        link: false,
        list: false,
        rawBodies: false,
      },
      authStatus: async () => ({ ok: true }),
      fetch: async (ref: TicketRef) => ({ ref, title: 'stub', normalizedState: 'todo' }),
      list: async () => [],
      create: async () => ({ provider: 'stub', id: '1', key: 'stub-1' }),
      comment: async () => undefined,
      transitions: async () => [],
      transition: async () => undefined,
      link: async () => undefined,
    }
  }

  for (const [capability, argv] of [
    ['create', ['create', 'A title']],
    ['list', ['list']],
    ['comment', ['comment', '1', '--body', 'hello']],
    ['transition', ['set-state', '1', 'in_review']],
  ] as const) {
    test(`issue ${argv[0]} names the missing "${capability}" capability`, { timeout: 180_000 }, async () => {
      const repo = makeRepo()
      const ctx = {
        cwd: repo,
        repoRoot: repo,
        repo: null,
        style: makeStyle(false),
        json: true,
        say: () => undefined,
        out: () => undefined,
        outFailure: () => undefined,
        writeRaw: () => undefined,
        writeError: () => undefined,
        providerFor: async () => ({
          id: 'local' as const,
          source: 'config' as const,
          provider: stubProvider(),
          ref: { provider: 'local', id: '1', key: 'local-1' },
        }),
      }
      await assert.rejects(
        () => issueCommand.run(ctx, [...argv, '--json']),
        (err: Error) => new RegExp(`"${capability}" capability`).test(err.message),
      )
    })
  }
})

describe('automatic crew selection keeps the ref the provider listed', () => {
  test('a non-numeric local ticket id is not reparsed from its display key', { timeout: 180_000 }, async () => {
    const repo = makeRepo()
    const tickets = temp('anvil-tickets-local-')
    const provider = new LocalTicketProvider({ dir: tickets })
    const created = await provider.create({ title: 'Investigate the incident', body: 'Body.' })
    // The file name is the id. A non-numeric id is a real local ticket, and
    // `local-incident` is not the key of a file called `local-incident.md`.
    renameSync(join(tickets, `${created.id}.md`), join(tickets, 'incident.md'))

    const worktreeRoot = `${repo}-crew-worktrees`
    temps.push(worktreeRoot)
    const configHome = temp('anvil-tickets-config-')
    writeFileSync(
      join(configHome, 'anvil.config.json'),
      JSON.stringify({ schemaVersion: 1, git: { worktreeRoot } }),
      'utf8',
    )

    const stdout = execFileSync(process.execPath, [CLI_MAIN, 'crew', 'up', '--json'], {
      cwd: repo,
      encoding: 'utf8',
      stdio: 'pipe',
      env: {
        ...process.env,
        NO_COLOR: '1',
        ANVIL_CONFIG_HOME: configHome,
        ANVIL_TICKETS_DIR: tickets,
      },
    })

    const envelope = JSON.parse(stdout) as {
      ok: boolean
      data: { claims: Array<{ key: string; worktree: string }>; failures: unknown[] }
    }
    assert.equal(envelope.ok, true)
    assert.deepEqual(envelope.data.failures, [])
    assert.equal(envelope.data.claims.length, 1)
    assert.equal(envelope.data.claims[0]?.key, 'local-incident')
    const bundle = readFileSync(join(envelope.data.claims[0]!.worktree, CONTEXT_FILE), 'utf8')
    assert.match(bundle, /Investigate the incident/)
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

  test('anvil crew up --tickets gh-42 claims the issue with a stub gh on PATH', { timeout: 180_000 }, () => {
    const repo = makeRepo()
    const stub = ghOnPath()
    const worktreeRoot = `${repo}-crew-worktrees`
    temps.push(worktreeRoot)
    // The crew reads its worktree root from configuration. Point the global config at the
    // temp directory so the worktrees are created there rather than in a developer's
    // `~/.anvil`, and keep the repository itself clean.
    const configHome = temp('anvil-tickets-config-')
    writeFileSync(
      join(configHome, 'anvil.config.json'),
      JSON.stringify({ schemaVersion: 1, git: { worktreeRoot } }),
      'utf8',
    )

    const stdout = execFileSync(process.execPath, [CLI_MAIN, 'crew', 'up', '--tickets', 'gh-42', '--json'], {
      cwd: repo,
      encoding: 'utf8',
      stdio: 'pipe',
      env: {
        ...process.env,
        NO_COLOR: '1',
        ANVIL_CONFIG_HOME: configHome,
        PATH: `${stub}${delimiter}${process.env.PATH ?? ''}`,
      },
    })

    const envelope = JSON.parse(stdout) as {
      ok: boolean
      data: { claims: Array<{ key: string; branch: string; worktree: string }>; failures: unknown[] }
    }
    assert.equal(envelope.ok, true)
    assert.deepEqual(envelope.data.failures, [])
    assert.equal(envelope.data.claims.length, 1)
    const claim = envelope.data.claims[0]!
    assert.equal(claim.key, 'gh-42')
    assert.match(claim.branch, /^feat\/gh-42-login-redirect-drops-the/)

    // The same bundle `claim` writes: a crew claim is not a degraded one.
    const bundle = readFileSync(join(claim.worktree, CONTEXT_FILE), 'utf8')
    assert.match(bundle, /Login redirect drops the return path/)
    assert.match(bundle, /- \[ \] the return path survives the redirect/)

    const registry = JSON.parse(readFileSync(join(repo, '.anvil', 'claims.json'), 'utf8')) as {
      claims: Array<{ key: string; ticket: { provider: string; id: string; key: string } }>
    }
    assert.equal(registry.claims[0]?.ticket.provider, 'github')
    assert.equal(registry.claims[0]?.ticket.key, 'gh-42')
  })
})
