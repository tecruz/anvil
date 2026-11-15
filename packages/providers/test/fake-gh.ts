/**
 * A `gh` runner that answers from memory.
 *
 * Every GitHub test goes through `GhOptions.run`, so no test shells out to `gh` and no test
 * touches the network. This fake keeps enough state for the provider's real parsing to be
 * exercised: `issue view` returns the current issue, `close`/`reopen`/`--add-label`/
 * `--remove-label` mutate it, `comment` appends, and `issue list` answers from the same
 * store. It also records every argv array, so a test can assert that a ticket title or body
 * arrived as one element rather than inside a shell string.
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
  /** The in-memory issues, keyed by number, after any mutation. */
  issues: Map<number, FakeIssue>
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

function listFlags(args: string[], flag: string): string[] {
  const out: string[] = []
  for (let i = 0; i < args.length; i++) {
    if (args[i] === flag && args[i + 1] !== undefined) out.push(args[i + 1] as string)
  }
  return out
}

function fresh(issue: FakeIssue): FakeIssue {
  return {
    ...issue,
    url: issue.url ?? `https://github.com/acme/widgets/issues/${issue.number}`,
    labels: [...(issue.labels ?? [])],
    comments: [...(issue.comments ?? [])],
  }
}

/**
 * The issues the fake answers for, plus the list `gh issue list` returns.
 *
 * `issues` is a store rather than one record, because the contract suite seeds several
 * tickets against one provider and a listing has to see all of them. `listIssues` can
 * describe a backlog whose members are not the issue `view` resolves.
 */
export function fakeGh(options: {
  issue?: FakeIssue
  issues?: FakeIssue[]
  authenticated?: boolean
  repoUrl?: string
  listIssues?: FakeIssue[]
  /** Fail `issue list` with this stderr, the way a real 403 does. */
  listFailure?: string
}): FakeGh {
  const store = new Map<number, FakeIssue>()
  for (const entry of options.issues ?? (options.issue === undefined ? [] : [options.issue])) {
    store.set(entry.number, fresh(entry))
  }
  const calls: string[][] = []
  const authenticated = options.authenticated ?? true
  let nextNumber = Math.max(0, ...store.keys()) + 1

  /** The issue a command names, or the most recent one when it names nothing. */
  const target = (args: string[]): FakeIssue | undefined => {
    const id = Number.parseInt(args[2] ?? '', 10)
    if (Number.isFinite(id) && store.has(id)) return store.get(id)
    return [...store.values()].at(-1)
  }

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
      const issue = target(args)
      if (issue === undefined) return fail(`no issue ${args[2] ?? ''}`)
      return ok(JSON.stringify(issue))
    }

    if (args[0] === 'issue' && args[1] === 'create') {
      const title = flagValue(args, '--title') ?? ''
      const body = flagValue(args, '--body') ?? ''
      const labels = listFlags(args, '--label')
        .flatMap((value) => value.split(','))
        .filter((label) => label !== '')
        .map((name) => ({ name }))
      const number = nextNumber++
      const issue = fresh({
        number,
        title,
        body,
        url: `https://github.com/acme/widgets/issues/${number}`,
        labels,
      })
      store.set(number, issue)
      return ok(`${issue.url}\n`)
    }

    if (args[0] === 'issue' && args[1] === 'comment') {
      const issue = target(args)
      if (issue === undefined) return fail(`no issue ${args[2] ?? ''}`)
      const body = flagValue(args, '--body') ?? ''
      issue.comments = [
        ...(issue.comments ?? []),
        { author: { login: 'octocat' }, body, createdAt: '2026-01-01T00:00:00Z' },
      ]
      // Real `gh issue comment` prints the comment URL, which callers may read.
      return ok(`${issue.url}#issuecomment-1\n`)
    }

    if (args[0] === 'issue' && (args[1] === 'close' || args[1] === 'reopen')) {
      const issue = target(args)
      if (issue === undefined) return fail(`no issue ${args[2] ?? ''}`)
      issue.state = args[1] === 'close' ? 'CLOSED' : 'OPEN'
      return ok('')
    }

    if (args[0] === 'issue' && args[1] === 'edit') {
      const issue = target(args)
      if (issue === undefined) return fail(`no issue ${args[2] ?? ''}`)
      // Both flags in one call, because anvil sends the state change as a single edit and
      // the fake must not hide a missing `--remove-label`.
      const added = listFlags(args, '--add-label')
        .flatMap((value) => value.split(','))
        .filter((l) => l !== '')
      const removed = new Set(
        listFlags(args, '--remove-label')
          .flatMap((value) => value.split(','))
          .filter((l) => l !== ''),
      )
      const kept = (issue.labels ?? []).filter((l) => !removed.has(l.name))
      issue.labels = [...kept, ...added.map((name) => ({ name }))]
      return ok('')
    }

    if (args[0] === 'issue' && args[1] === 'list') {
      if (options.listFailure !== undefined) return fail(options.listFailure)
      const state = flagValue(args, '--state')
      const wanted = listFlags(args, '--label')
      const limit = Number.parseInt(flagValue(args, '--limit') ?? '30', 10)
      const issues = options.listIssues ?? [...store.values()]
      const matches = issues.filter((entry) => {
        if (state !== undefined) {
          const closed = (entry.state ?? 'OPEN') === 'CLOSED'
          if (state === 'closed' ? !closed : closed) return false
        }
        for (const label of wanted) {
          // GitHub matches labels case-insensitively (`--label bug` finds `Bug`).
          if (!(entry.labels ?? []).some((l) => l.name.toLowerCase() === label.toLowerCase())) return false
        }
        return true
      })
      // The real command returns at most `--limit` results, newest first. A caller has to
      // ask for more to see past a truncated page, which is what `list` relies on.
      return ok(JSON.stringify(matches.slice(0, Number.isFinite(limit) ? limit : 30)))
    }

    return fail(`fake gh does not implement: ${args.join(' ')}`)
  }

  return { run, calls, issues: store }
}
