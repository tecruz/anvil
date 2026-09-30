/**
 * The live `gh` contract suite.
 *
 * The mocked suite proves the pipeline calls what the test told it to call. It cannot
 * prove the thing being called is a real command that accepts real flags -- and the most
 * expensive defect in this package's history was exactly that: `--hostname` was passed to
 * `gh issue view`, which does not have that flag, so every GitHub operation failed while
 * `auth github` (the one command that *does* accept it) kept passing. 442 tests were green
 * throughout, because a fake runner accepts any argv.
 *
 * So this suite runs against the installed `gh`, behind `ANVIL_LIVE=1`, and never in
 * default CI. Two tiers:
 *
 *   1. **Flag contract** (no auth, no network). Record the argv the provider actually
 *      builds for every call it makes, then ask the real binary which flags it accepts.
 *      This is the check that would have caught the bug, and it needs nothing but `gh`
 *      being installed.
 *   2. **Live behaviour** (auth). Probe the real auth path, and if `ANVIL_LIVE_REPO` names a
 *      repository, run a real read-only provider call against it.
 *
 *   ANVIL_LIVE=1                      run this suite
 *   ANVIL_LIVE_HOST=ghe.acme-corp.com  probe that host's auth (optional)
 *   ANVIL_LIVE_REPO=owner/repo         real read-only issue list (optional)
 */

import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, describe, test } from 'node:test'

import { runProcess } from '@anvil/core'
import { GhForgeTransport, GitHubProvider, type RunResult } from '@anvil/providers'

const LIVE = process.env.ANVIL_LIVE === '1'
const HOST = process.env.ANVIL_LIVE_HOST
const LIVE_REPO = process.env.ANVIL_LIVE_REPO

const temps: string[] = []
after(() => {
  for (const t of temps) rmSync(t, { recursive: true, force: true })
})

describe('the gh flag contract (live)', {
  skip: LIVE ? false : 'set ANVIL_LIVE=1',
}, () => {
  /** argv of every gh call the provider would make, in order. */
  const captured: string[][] = []
  /** Help text per subcommand, e.g. `issue view`. */
  const help = new Map<string, string>()

  before(async () => {
    const run = async (args: string[]): Promise<RunResult> => {
      captured.push(args)
      // Enough output for every parse on the paths below to succeed, so the calls are not
      // short-circuited by an early throw before their argv is recorded. `gh issue create`
      // has no --json, so it is the one that answers with a printed URL, like the real one.
      if (args[0] === 'pr' && args[1] === 'view') return { stdout: '', stderr: 'no PR', exitCode: 1 }
      if (args[0] === 'issue' && args[1] === 'create') {
        return {
          stdout: 'https://github.com/example/app/issues/1\n',
          stderr: '',
          exitCode: 0,
        }
      }
      return {
        stdout: '{"number":1,"url":"https://example.test/pull/1","state":"OPEN"}',
        stderr: '',
        exitCode: 0,
      }
    }
    const provider = new GitHubProvider({ host: 'ghe.acme-corp.com', run })
    const transport = new GhForgeTransport({ host: 'ghe.acme-corp.com', run })
    const ref = { provider: 'github', id: '1', key: 'gh-1' }

    await provider.authStatus()
    await provider.fetch(ref)
    await provider.list()
    await provider.create({ title: 't', body: 'b' })
    await provider.comment(ref, 'hi')
    await provider.link(ref, 'https://example.test/x')
    await provider.transition(ref, 'in_progress')
    await provider.transition(ref, 'done')
    await provider.transition(ref, 'in_review')
    await transport.findPullRequest({ cwd: '.', branch: 'feat/x' })
    await transport.sourceLink({ cwd: '.', branch: 'feat/x' })
    await transport.upsertPullRequest({
      cwd: '.',
      branch: 'feat/x',
      base: 'main',
      title: 't',
      body: 'b',
      draft: true,
      reviewers: ['@a'],
    })

    for (const argv of captured) {
      const sub = `${argv[0]} ${argv[1]}`.trim()
      if (help.has(sub)) continue
      const r = await runProcess('gh', [argv[0] as string, argv[1] as string, '--help'])
      help.set(sub, `${r.stdout}\n${r.stderr}`)
    }
  })

  test('gh is installed and the help parsed', () => {
    assert.ok(captured.length >= 12, `expected to record every call, saw ${captured.length}`)
    for (const [sub, text] of help) {
      // gh's help capitalises the heading differently per command ("USAGE" vs "Usage:").
      assert.match(text, /usage/i, `gh ${sub} --help produced no usage: ${text.slice(0, 200)}`)
    }
  })

  test('every flag anvil sends is a flag the installed gh accepts', () => {
    // The check that earns this suite its keep. `--hostname` on `gh issue view` was
    // accepted by a mocked runner and rejected by the real binary, in a code path whose
    // failure lands after the branch is already pushed.
    const offenders: string[] = []
    for (const argv of captured) {
      const sub = `${argv[0]} ${argv[1]}`.trim()
      const text = help.get(sub) ?? ''
      for (const arg of argv) {
        if (!arg.startsWith('--')) continue
        if (!text.includes(arg)) offenders.push(`gh ${sub} does not accept ${arg}  [${argv.join(' ')}]`)
      }
    }
    assert.deepEqual(offenders, [], `flags the installed gh does not accept:\n${offenders.join('\n')}`)
  })

  test('--hostname reaches the auth family and nothing else', () => {
    // Named explicitly, not just implied by the check above, because the distinction is
    // the whole point: `gh auth status --hostname <host>` is valid and names the right
    // Enterprise host, while the repo-scoped commands resolve the host from the remote.
    const withFlag = captured.filter((a) => a.includes('--hostname'))
    assert.ok(withFlag.length > 0, 'the auth probe should still pass --hostname')
    for (const argv of withFlag) {
      assert.equal(argv[0], 'auth', `--hostname must not reach \`gh ${argv[0]} ${argv[1]}\``)
    }
  })
})

describe('live gh behaviour', {
  skip: LIVE ? false : 'set ANVIL_LIVE=1',
}, () => {
  test('authStatus runs the real gh and always returns a runnable next step', async () => {
    // The documented contract for this method: it may fail, but never with a bare
    // "auth failed" -- a failure has to name the command that fixes it.
    const provider = new GitHubProvider(HOST === undefined ? {} : { host: HOST })
    const status = await provider.authStatus()
    assert.equal(typeof status.ok, 'boolean')
    if (status.ok) {
      assert.ok((status.identity ?? '') !== '', 'a success must say who is logged in')
    } else {
      assert.match(status.remediation ?? '', /gh auth/, 'a failure must name a gh auth command')
    }
  })

  test('a real provider call against a real repository works', {
    skip: LIVE_REPO === undefined ? 'set ANVIL_LIVE_REPO=owner/repo' : false,
  }, async () => {
    // The end-to-end shape the flag contract cannot prove: that the argv gh accepts is
    // also the argv that works. Read-only, and against a throwaway repo whose only
    // content is the remote, so nothing is created.
    const dir = mkdtempSync(join(tmpdir(), 'anvil-live-gh-'))
    temps.push(dir)
    writeFileSync(join(dir, 'placeholder'), '', 'utf8')
    const git = (...args: string[]) => execFileSync('git', args, { cwd: dir, stdio: 'pipe' })
    git('init', '-q', '-b', 'main')
    git('remote', 'add', 'origin', `https://github.com/${LIVE_REPO}.git`)
    const provider = new GitHubProvider()
    const refs = await provider.list({ limit: 1 })
    assert.ok(Array.isArray(refs))
  })
})
