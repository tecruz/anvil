/**
 * A `gh` runner that answers from memory.
 *
 * Every GitHub test goes through `GhOptions.run`, so no test shells out to `gh` and no test
 * touches the network. This fake keeps enough state for the provider's real parsing to be
 * exercised: `issue view` returns the current issue, `close`/`reopen`/`--add-label` mutate
 * it, and `comment` appends. It also records every argv array, so a test can assert that a
 * ticket title or body arrived as one element rather than inside a shell string.
 *
 * Only the subcommands the provider actually calls are implemented. Anything else fails
 * loudly, because a fake that silently accepts an unknown command hides a real regression.
 */

import type { RunResult } from '@anvil/providers'

export interface FakeIssue {
  number: number
  title: string
  body?: string
  state?: 'OPEN' | 'CLOSED'
  labels?: Array<{ name: string }>
  assignees?: Array<{ login: string }>
  url?: string
  milestone?: { title: string } | null
  comments?: Array<{ author?: { login?: string }; body?: string; createdAt?: string; url?: string }>
}

export interface FakeGh {
  run: (args: string[], cwd: string) => Promise<RunResult>
  /** Every argv array that was passed to the runner, in order. */
  calls: string[][]
  /** The in-memory issue, after any mutation. */
  issue: FakeIssue
}

function ok(stdout = ''): RunResult {
  return { stdout, stderr: '', exitCode: 0 }
}

function fail(stderr: string): RunResult {
  return { stdout: '', stderr, exitCode: 1 }
}

function flagValue(args: string[], flag: string): string | undefined {
  const index = args.indexOf(flag)
  return index === -1 ? undefined : args[index + 1]
}

export function fakeGh(options: { issue: FakeIssue; authenticated?: boolean; repoUrl?: string }): FakeGh {
  const issue: FakeIssue = {
    ...options.issue,
    url: options.issue.url ?? `https://github.com/acme/widgets/issues/${options.issue.number}`,
    labels: [...(options.issue.labels ?? [])],
    comments: [...(options.issue.comments ?? [])],
  }
  const calls: string[][] = []
  const authenticated = options.authenticated ?? true

  const run = async (args: string[]): Promise<RunResult> => {
    calls.push(args)

    if (args[0] === 'auth' && args[1] === 'status') {
      return authenticated
        ? ok('github.com\n  ✓ Logged in to github.com account octocat (keyring)\n')
        : fail('You are not logged into any GitHub hosts. Run gh auth login to authenticate.')
    }

    if (args[0] === 'repo' && args[1] === 'view') {
      return ok(JSON.stringify({ url: options.repoUrl ?? 'https://github.com/acme/widgets' }))
    }

    if (args[0] === 'issue' && args[1] === 'view') {
      return ok(JSON.stringify(issue))
    }

    if (args[0] === 'issue' && args[1] === 'create') {
      const title = flagValue(args, '--title') ?? ''
      const body = flagValue(args, '--body') ?? ''
      const labels = (flagValue(args, '--label') ?? '')
        .split(',')
        .filter((label) => label !== '')
        .map((name) => ({ name }))
      issue.title = title
      issue.body = body
      issue.labels = labels
      return ok(`${issue.url}\n`)
    }

    if (args[0] === 'issue' && args[1] === 'comment') {
      const body = flagValue(args, '--body') ?? ''
      issue.comments = [
        ...(issue.comments ?? []),
        { author: { login: 'octocat' }, body, createdAt: '2026-01-01T00:00:00Z' },
      ]
      return ok('')
    }

    if (args[0] === 'issue' && args[1] === 'close') {
      issue.state = 'CLOSED'
      return ok('')
    }

    if (args[0] === 'issue' && args[1] === 'reopen') {
      issue.state = 'OPEN'
      return ok('')
    }

    if (args[0] === 'issue' && args[1] === 'edit') {
      const label = flagValue(args, '--add-label')
      if (label !== undefined) issue.labels = [...(issue.labels ?? []), { name: label }]
      return ok('')
    }

    if (args[0] === 'issue' && args[1] === 'list') {
      const state = flagValue(args, '--state') ?? 'open'
      const closed = (issue.state ?? 'OPEN') === 'CLOSED'
      const matches = state === 'closed' ? closed : !closed
      return ok(JSON.stringify(matches ? [issue] : []))
    }

    return fail(`fake gh does not implement: ${args.join(' ')}`)
  }

  return { run, calls, issue }
}
