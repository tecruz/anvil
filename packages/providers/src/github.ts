/**
 * The GitHub transport, via the `gh` CLI.
 *
 * `gh` rather than the REST API because it already handles the things that go wrong: auth
 * refresh, GitHub Enterprise hosts, and enterprise proxy configuration. Anvil's value is
 * the workflow, not reimplementing a client's login flow.
 *
 * Every call goes through `execFile` with an argument array. PR bodies and branch names
 * come from ticket text, which is user input -- through a shell that is injection.
 *
 * The auth contract matters more than it looks. The target user walks into arbitrary
 * companies, and the common case is a **GitHub Enterprise host `gh` is not authenticated
 * to**. `authStatus` therefore probes the *detected host* and returns the exact command
 * to fix it, because "authentication failed" with no next step is the failure mode that
 * makes people give up on a tool.
 */

import { AnvilError, ErrorCode, runProcess, SHIP_GUARD_ENV } from '@anvil/core'
import type {
  AuthStatus,
  NormalizedState,
  ProviderCapabilities,
  ProviderId,
  Ticket,
  TicketDraft,
  TicketProvider,
  TicketQuery,
  TicketRef,
  Transition,
} from '@anvil/tickets'
import { repositoryOf } from '@anvil/tickets'
import type { ForgeTransport } from '@anvil/worktrees/ship'

export interface RunResult {
  stdout: string
  stderr: string
  exitCode: number
}

export interface GhOptions {
  /** Host to operate against. Detected from the remote; overridable. */
  host?: string
  /** Injected for tests, so no test ever shells out to gh. */
  run?: (args: string[], cwd: string) => Promise<RunResult>
  /** Injected for tests, so the push marker can be asserted without a remote. */
  runGit?: (args: string[], options: { cwd: string; env: NodeJS.ProcessEnv }) => Promise<RunResult>
}

/**
 * Run a gh subcommand.
 *
 * Through `runProcess`, because on Windows `gh` is a real `.exe` (so nothing is re-parsed
 * and the argv array is safe) but the same ENOENT trap applies to any shim on PATH.
 */
export async function gh(args: string[], cwd: string): Promise<RunResult> {
  return runProcess('gh', args, { cwd })
}

function runner(options: GhOptions | undefined): (args: string[], cwd: string) => Promise<RunResult> {
  const run = options?.run
  return run === undefined ? (args, cwd) => gh(args, cwd) : (args, cwd) => run(args, cwd)
}
/**
 * How to target a specific host, per gh subcommand.
 *
 * `--hostname` is **only** valid on the `auth` family. The repo-scoped commands
 * (`issue`, `pr`, `repo`) do not have that flag -- passing it makes them exit 1 with
 * "unknown flag: --hostname" -- and they already resolve the host from the repository's
 * own remote, which is the same host we detected. So for those we pass nothing and let
 * gh read the remote, and only `authStatus` needs the explicit flag.
 *
 * This distinction is invisible to the injected-runner tests (a fake accepts any argv),
 * and getting it wrong means every provider call fails against real gh for a GitHub
 * remote while `auth github` still passes -- the most confusing possible combination.
 */
function authHostArgs(host: string | undefined): string[] {
  return host === undefined || host === '' ? [] : ['--hostname', host]
}

/**
 * `--repo` for the repository a ref's URL names, or nothing for a bare number.
 *
 * A pasted URL points at a *specific* issue, not only at a number. Without `--repo`, `gh`
 * resolves that number against whichever repository anvil happens to be standing in, so
 * commenting on another repository's issue URL would comment on an unrelated issue that
 * happens to share the number.
 *
 * A ref with a URL that cannot name a repository is refused rather than silently read
 * against the current directory: the whole point of the URL is that it names the issue.
 * The URL is parsed by `@anvil/tickets`, so the transport and the pull-request body agree
 * on which repository a ticket belongs to.
 */
function repoArgs(ref: TicketRef): string[] {
  const hasUrl = ref.url !== undefined && ref.url !== ''
  if (!hasUrl) return []
  const repository = repositoryOf(ref.url)
  if (repository === null) {
    throw new AnvilError(ErrorCode.Usage, `Cannot tell which repository "${ref.url}" points at`, {
      hint: 'Use an issue URL shaped like https://github.com/<owner>/<repo>/issues/<number>, or pass a bare issue number.',
      details: { url: ref.url },
    })
  }
  return ['--repo', `${repository.host}/${repository.path}`]
}

/**
 * Flags that narrow `gh issue list` to a normalized state.
 *
 * `done`/`wontfix` are the only real issue states on GitHub (open/closed), so that is the
 * only narrowing worth asking the server for. The label-emulated states are *not* passed
 * as `--label`: a repository may spell the label `In Review`, which the server would not
 * match against `in-review`, and `todo` has to exclude label-carrying issues, which no
 * `gh` flag can express. `list` therefore filters every answer by normalized state.
 */
function stateFilterArgs(state: NormalizedState | undefined, label: string | undefined): string[] {
  const out: string[] = []
  if (state === 'done' || state === 'wontfix') out.push('--state', 'closed')
  else if (state !== undefined && state !== 'unknown') out.push('--state', 'open')
  if (label !== undefined) out.push('--label', label)
  return out
}

/** A state label anvil emulates on GitHub, in the spelling it adds by default. */
const STATE_LABELS = ['in-progress', 'in-review', 'wontfix'] as const
type StateLabel = (typeof STATE_LABELS)[number]

/**
 * The emulated state a label stands for.
 *
 * Repositories write these labels in different cases and spellings (`In Review`,
 * `in progress`), so the same pattern that parses a ticket is used to decide which
 * existing label a transition has to remove. Adding a second `in-review` beside an
 * existing `In Review` would leave the issue in two states at once.
 */
function stateLabelOf(label: string): StateLabel | null {
  if (/wont.?fix/i.test(label)) return 'wontfix'
  if (/in.?review/i.test(label)) return 'in-review'
  if (/in.?progress/i.test(label)) return 'in-progress'
  return null
}

/** The state labels an issue should carry after a transition. */
function desiredStateLabels(to: NormalizedState): StateLabel[] {
  if (to === 'in_progress') return ['in-progress']
  if (to === 'in_review') return ['in-review']
  if (to === 'wontfix') return ['wontfix']
  return []
}

/**
 * The canonical state of a GitHub issue, from its open/closed flag and labels.
 *
 * One function for `fetch` and `list`, so a listing and a single read cannot disagree
 * about what state an issue is in.
 */
function normalizedStateFor(state: string | undefined, labels: string[]): NormalizedState {
  const closed = (state ?? '').toUpperCase() === 'CLOSED'
  // A closed issue carrying the wontfix label is `wontfix`, not `done`: the label is the
  // only way to tell "we will not do this" from "we did it".
  if (labels.some((l) => /wont.?fix/i.test(l))) return 'wontfix'
  if (!closed) {
    if (labels.some((l) => /in.?review/i.test(l))) return 'in_review'
    if (labels.some((l) => /in.?progress/i.test(l))) return 'in_progress'
  }
  return closed ? 'done' : 'todo'
}

export class GitHubProvider implements TicketProvider {
  readonly id: ProviderId = 'github'
  readonly capabilities: ProviderCapabilities = {
    create: true,
    comment: true,
    // GitHub has no server-side state machine for issues, so `transition` is emulated by
    // a label rather than pretended to be a native transition.
    transition: true,
    link: true,
    list: true,
    rawBodies: false,
  }

  private readonly options: GhOptions

  constructor(options: GhOptions = {}) {
    this.options = options
  }

  /**
   * Offline auth check for a specific host.
   *
   * `gh auth status` exits non-zero when a *requested* host is not authenticated, even
   * when other hosts are, so the exit code alone is not enough -- the message matters, and
   * the remediation must name the host so the user does not log into the wrong one.
   */
  async authStatus(): Promise<AuthStatus> {
    const host = this.options.host
    // Through the injected runner, not `gh` directly. Otherwise this is the one method
    // that cannot be tested, and a test that "checks auth" silently reads whatever
    // credentials the developer actually has.
    const run = runner(this.options)
    const probe = await run(['auth', 'status', ...authHostArgs(host)], '.')
    const output = `${probe.stdout}\n${probe.stderr}`

    if (probe.exitCode === 0) {
      const who = /Logged in to .* account ([^\s(]+)/.exec(output)?.[1] ?? 'unknown'
      return { ok: true, identity: who }
    }

    if (/not logged in|no account|not found/i.test(output) || probe.exitCode === 4) {
      return {
        ok: false,
        detail: host === undefined ? 'gh is not logged in to any GitHub host' : `gh is not logged in to ${host}`,
        remediation: host === undefined ? 'gh auth login' : `gh auth login --hostname ${host}`,
      }
    }

    return {
      ok: false,
      detail: `gh auth status failed: ${output.trim().split('\n')[0] ?? 'unknown error'}`,
      remediation: host === undefined ? 'gh auth status' : `gh auth status --hostname ${host}`,
    }
  }

  async fetch(ref: TicketRef): Promise<Ticket> {
    const run = runner(this.options)
    const args = [
      'issue',
      'view',
      ref.id,
      '--json',
      'number,title,body,state,labels,assignees,url,milestone,comments',
      ...repoArgs(ref),
    ]
    const res = await run(args, '.')
    if (res.exitCode !== 0) {
      throw new AnvilError(ErrorCode.Usage, `gh issue view ${ref.id} failed: ${res.stderr.trim()}`, {
        hint: 'Check the issue number and that gh is authenticated to this host.',
      })
    }
    return parseGhIssue(res.stdout, ref)
  }

  /**
   * Issues in `query.state`, as refs.
   *
   * A failed call throws. Returning an empty list instead would tell `crew up` and
   * `issue list` that the tracker has no work, when the truth is that `gh` could not
   * answer -- a 403 or a typo in the host must not look like an empty backlog.
   *
   * The server-side filter is an optimization, not the answer: `gh issue list` cannot
   * exclude the state labels a normalized state also implies, so `todo` would otherwise
   * include everything already in progress or in review. The returned issues are filtered
   * by the same normalized state `fetch` reports.
   *
   * Because that filtering happens here, a page of results can be entirely consumed by
   * issues the caller did not ask for. `gh issue list` has no cursor, so the only way to
   * see past a truncated page is to ask for a larger one. The fetch therefore retries with
   * a bigger limit while the answer looks truncated and the wanted matches are short -- a
   * fixed over-fetch would report "no ready work" while the ready issue sat just past it.
   */
  async list(query: TicketQuery = {}): Promise<TicketRef[]> {
    const run = runner(this.options)
    const limit = query.limit ?? 30
    // `gh` refuses a limit above 1000; asking for more is clamped.
    const pageCap = 1000
    let request = Math.min(Math.max(limit * 4, 100), pageCap)

    for (;;) {
      const res = await run(
        [
          'issue',
          'list',
          '--json',
          'number,title,state,labels',
          '--limit',
          String(request),
          ...stateFilterArgs(query.state, query.label),
        ],
        '.',
      )
      if (res.exitCode !== 0) {
        throw new AnvilError(ErrorCode.Usage, `gh issue list failed: ${res.stderr.trim()}`, {
          hint: 'Check that gh is authenticated to this host, and that the repository has a remote.',
        })
      }
      let parsed: unknown
      try {
        parsed = JSON.parse(res.stdout || '[]')
      } catch {
        parsed = null
      }
      if (!Array.isArray(parsed)) {
        throw new AnvilError(ErrorCode.Internal, 'gh issue list returned something that is not a list', {
          hint: `Expected a JSON array, got: ${res.stdout.trim().slice(0, 200)}`,
        })
      }

      const out: TicketRef[] = []
      for (const issue of parsed) {
        const entry = issue as { number?: number; state?: string; labels?: Array<{ name?: string }> }
        const id = String(entry.number ?? '')
        if (id === '') continue
        const labels = (entry.labels ?? []).map((l) => l.name ?? '').filter((l) => l !== '')
        // `gh` already filtered by label, case-insensitively; comparing again here with
        // `includes` rejected an issue labelled `Bug` for a `bug` query.
        if (query.state !== undefined && normalizedStateFor(entry.state, labels) !== query.state) continue
        out.push({ provider: this.id, id, key: `gh-${id}` })
        if (out.length >= limit) return out
      }

      // A short page is the whole backlog, so nothing further can match. A full page may
      // be truncated, which is the only case worth a bigger request.
      const truncated = parsed.length >= request
      if (!truncated || request >= pageCap) return out
      request = Math.min(request * 2, pageCap)
    }
  }

  async create(draft: TicketDraft): Promise<TicketRef> {
    const run = runner(this.options)
    const res = await run(
      [
        'issue',
        'create',
        '--title',
        draft.title,
        '--body',
        draft.body ?? '',
        ...(draft.labels === undefined || draft.labels.length === 0 ? [] : ['--label', draft.labels.join(',')]),
      ],
      '.',
    )
    if (res.exitCode !== 0) {
      throw new AnvilError(ErrorCode.Internal, `gh issue create failed: ${res.stderr.trim()}`, {
        hint: 'Check that gh is authenticated and the repository has a remote.',
      })
    }
    // `gh issue create` has no `--json` output: it prints the new issue's URL on stdout, so
    // that is where the number comes from. Asking for `--json` is an "unknown flag" error
    // against real gh, and the mocked runner cannot see the difference.
    const url = lastIssueUrl(res.stdout)
    const id = /\/issues\/(\d+)/.exec(url)?.[1] ?? ''
    if (id === '') {
      throw new AnvilError(ErrorCode.Internal, 'gh issue create succeeded but printed no issue URL', {
        hint: `Expected a URL like https://github.com/owner/repo/issues/123, got: ${res.stdout.trim().slice(0, 200)}`,
      })
    }
    return { provider: this.id, id, key: `gh-${id}`, url }
  }

  async comment(ref: TicketRef, body: string): Promise<void> {
    const run = runner(this.options)
    const res = await run(['issue', 'comment', ref.id, '--body', body, ...repoArgs(ref)], '.')
    if (res.exitCode !== 0) {
      throw new AnvilError(ErrorCode.Internal, `gh issue comment failed: ${res.stderr.trim()}`)
    }
  }

  /**
   * GitHub issues have no transitions, only open/closed plus labels.
   *
   * Returned as a mapping anvil can act on, so the pipeline does not need to know the
   * difference between a real transition and an emulated one.
   */
  async transitions(ref: TicketRef): Promise<Transition[]> {
    const ticket = await this.fetch(ref)
    const out: Transition[] = []
    if (ticket.normalizedState !== 'done') out.push({ to: 'done', name: 'close' })
    if (ticket.normalizedState !== 'todo') out.push({ to: 'todo', name: 'reopen' })
    if (ticket.normalizedState !== 'in_progress') out.push({ to: 'in_progress', name: 'label: in-progress' })
    if (ticket.normalizedState !== 'in_review') out.push({ to: 'in_review', name: 'label: in-review' })
    return out
  }

  /**
   * Move an issue to a normalized state.
   *
   * The state is the *whole* state, not a label to add: going from `in_review` to `todo`
   * has to remove the `in-review` label, and going from `todo` to `in_progress` has to
   * remove the labels the earlier state implied. Adding without removing reported a
   * transition the issue never made, because `fetch` reads the label back as the state.
   */
  async transition(ref: TicketRef, to: NormalizedState): Promise<void> {
    if (to === 'unknown') {
      throw new AnvilError(ErrorCode.Usage, 'Cannot move a GitHub issue to "unknown"', {
        hint: 'Supported: todo, in_progress, in_review, done, wontfix.',
      })
    }
    const run = runner(this.options)
    const desired = desiredStateLabels(to)
    const current = await this.fetch(ref)

    // `done` and `wontfix` are closed; every other state is open.
    const wantsClosed = to === 'done' || to === 'wontfix'
    const isClosed = (current.state ?? '').toUpperCase() === 'CLOSED'
    if (wantsClosed && !isClosed) {
      const res = await run(['issue', 'close', ref.id, ...repoArgs(ref)], '.')
      if (res.exitCode !== 0) throw new AnvilError(ErrorCode.Internal, `gh issue close failed: ${res.stderr.trim()}`)
    } else if (!wantsClosed && isClosed) {
      // Reopening an open issue is an error ("issue is already open"), so this runs only
      // when the issue is actually closed.
      const res = await run(['issue', 'reopen', ref.id, ...repoArgs(ref)], '.')
      if (res.exitCode !== 0) throw new AnvilError(ErrorCode.Internal, `gh issue reopen failed: ${res.stderr.trim()}`)
    }

    const existing = current.labels ?? []
    const remove = existing.filter((label) => {
      const kind = stateLabelOf(label)
      return kind !== null && !desired.includes(kind)
    })
    const present = existing.map((label) => stateLabelOf(label)).filter((kind): kind is StateLabel => kind !== null)
    const add = desired.filter((kind) => !present.includes(kind))
    if (remove.length > 0 || add.length > 0) {
      await this.editLabels(ref, add, remove)
    }
  }

  /** Add and remove labels in one call, so the issue never stops between two states. */
  private async editLabels(ref: TicketRef, add: string[], remove: string[]): Promise<void> {
    const run = runner(this.options)
    const res = await run(
      [
        'issue',
        'edit',
        ref.id,
        ...(add.length === 0 ? [] : ['--add-label', add.join(',')]),
        ...(remove.length === 0 ? [] : ['--remove-label', remove.join(',')]),
        ...repoArgs(ref),
      ],
      '.',
    )
    if (res.exitCode !== 0) {
      const labels = [...add, ...remove].join(', ')
      throw new AnvilError(ErrorCode.Internal, `gh issue edit ${ref.id} failed: ${res.stderr.trim()}`, {
        hint: `The labels "${labels}" may not exist in this repository. Create them, or pick a state that needs no label.`,
      })
    }
  }

  /** A link GitHub renders back to the source, used for PR cross-references. */
  async link(ref: TicketRef, url: string, title?: string): Promise<void> {
    const label = title === undefined ? url : `${title}: ${url}`
    await this.comment(ref, label)
  }

  /** The `ForgeTransport` for the ship pipeline. */
  transport(): ForgeTransport {
    return new GhForgeTransport(this.options)
  }
}

/** The last http line in gh's output, which for `issue create` is the new issue's URL. */
function lastIssueUrl(stdout: string): string {
  return (
    stdout
      .trim()
      .split('\n')
      .filter((l) => l.startsWith('http'))
      .pop() ?? ''
  )
}

/** Map a `gh issue view --json` payload onto the canonical ticket. */
export function parseGhIssue(json: string, ref: TicketRef): Ticket {
  const raw = JSON.parse(json) as {
    number?: number
    title?: string
    body?: string
    state?: string
    labels?: Array<{ name?: string }>
    assignees?: Array<{ login?: string }>
    url?: string
    milestone?: { title?: string } | null
    comments?: Array<{
      author?: { login?: string }
      body?: string
      createdAt?: string
      url?: string
    }>
  }

  const id = String(raw.number ?? ref.id)
  const labels = (raw.labels ?? []).map((l) => l.name ?? '').filter((l) => l !== '')
  const comments = (raw.comments ?? []).map((c) => ({
    author: c.author?.login ?? 'unknown',
    body: c.body ?? '',
    at: c.createdAt ?? '',
    ...(c.url === undefined ? {} : { url: c.url }),
  }))

  // `in_review` and `in_progress` are inferred from a label, because GitHub has no such
  // state. Shared with `list` so a listing and a read cannot disagree.
  const normalizedState = normalizedStateFor(raw.state, labels)

  return {
    ref: {
      provider: 'github',
      id,
      key: `gh-${id}`,
      ...(raw.url === undefined ? {} : { url: raw.url }),
    },
    title: raw.title ?? '',
    ...(raw.body === undefined ? {} : { body: raw.body }),
    ...(raw.state === undefined ? {} : { state: raw.state }),
    normalizedState,
    labels,
    ...(raw.assignees?.[0]?.login === undefined ? {} : { assignee: raw.assignees[0].login }),
    ...(raw.milestone?.title === undefined ? {} : { milestone: raw.milestone.title }),
    baseBranch: null,
    comments,
    acceptance: extractAcceptance(raw.body),
    raw,
  }
}

/** Acceptance criteria, from either a checklist or a headed section. */
function extractAcceptance(body: string | undefined): string[] {
  if (body === undefined) return []
  const checks = [...body.matchAll(/^\s*[-*]\s*\[[ xX]\]\s*(.+)$/gm)].map((m) => (m[1] ?? '').trim())
  if (checks.length > 0) return checks
  const section = /#+ *acceptance criteria[^\n]*\n([\s\S]*?)(?=\n#|$)/i.exec(body)
  if (section === null) return []
  return (section[1] ?? '')
    .split('\n')
    .map((l) => l.replace(/^\s*[-*]\s*/, '').trim())
    .filter((l) => l !== '')
}

/** Detect the GitHub host from a remote URL, including GHE. */
export function hostFromRemote(remote: string | null): string | null {
  if (remote === null) return null
  const ssh = /^(?:ssh:\/\/)?git@([^:/]+)[:/]/.exec(remote)
  if (ssh !== null) return ssh[1] as string
  const https = /^https?:\/\/([^/]+)\//.exec(remote)
  if (https !== null) return https[1] as string
  return null
}

// ---------------------------------------------------------------------------
// Forge transport for `ship`
// ---------------------------------------------------------------------------

export class GhForgeTransport implements ForgeTransport {
  private readonly options: GhOptions

  constructor(options: GhOptions = {}) {
    // A parameter property would be fine here except that `erasableSyntaxOnly` is on:
    // TypeScript parameter properties are not erasable, so node cannot strip them.
    this.options = options
  }

  /**
   * Push the branch and set its upstream.
   *
   * `-u` matters: without it the branch exists on the remote but has no upstream, and
   * `gh pr create` cannot see it. This is git, not gh, so it runs git directly -- through
   * the shared runner, with an argument array and never a shell.
   */
  async pushBranch({ cwd, branch }: { cwd: string; branch: string }): Promise<{ ok: boolean; detail: string }> {
    // The claimed worktree installs a pre-push hook that refuses every push. This marker
    // is the one thing that opens it, and it lives only in this process: no file is left
    // behind for a later agent to reuse.
    const runGit = this.options.runGit ?? ((args, options) => runProcess('git', args, options))
    const res = await runGit(['push', '-u', 'origin', branch], {
      cwd,
      env: { ...process.env, [SHIP_GUARD_ENV]: '1' },
    })
    if (res.exitCode === 0) {
      return {
        ok: true,
        detail: `pushed ${branch}${res.stderr.trim() === '' ? '' : ` (${res.stderr.trim()})`}`,
      }
    }
    const detail = (res.stderr || res.stdout || `exit ${res.exitCode}`).trim()
    return { ok: false, detail }
  }

  async upsertPullRequest(options: {
    cwd: string
    branch: string
    base: string
    title: string
    body: string
    draft: boolean
    reviewers: string[]
  }): Promise<{ number: number; url: string; created: boolean }> {
    const run = runner(this.options)
    const existing = await this.findPullRequest({
      cwd: options.cwd,
      branch: options.branch,
    })

    if (existing !== null) {
      const edited = await run(
        ['pr', 'edit', String(existing.number), '--title', options.title, '--body', options.body],
        options.cwd,
      )
      if (edited.exitCode !== 0) {
        throw new AnvilError(ErrorCode.Internal, `gh pr edit failed: ${edited.stderr.trim()}`, {
          hint: 'Anvil will not open a second PR for the same branch; fix the edit failure or close the existing PR.',
        })
      }
      return { number: existing.number, url: existing.url, created: false }
    }

    const created = await run(
      [
        'pr',
        'create',
        '--title',
        options.title,
        '--body',
        options.body,
        '--base',
        options.base,
        '--head',
        options.branch,
        ...(options.draft ? ['--draft'] : []),
        // `gh pr create --reviewer` takes a bare handle or `org/team-name` -- no leading
        // `@`. CODEOWNERS entries are written `@name`, so the leading `@` is stripped here;
        // passing it through produced `--reviewer @@name`, which gh cannot resolve, and the
        // failure lands after the branch is already pushed.
        ...(options.reviewers.length === 0
          ? []
          : [
              '--reviewer',
              options.reviewers
                .map((r) => r.replace(/^@+/, ''))
                .filter((r) => r !== '')
                .join(','),
            ]),
      ],
      options.cwd,
    )
    if (created.exitCode !== 0) {
      throw new AnvilError(ErrorCode.Internal, `gh pr create failed: ${created.stderr.trim()}`, {
        hint: 'A common cause is an uncommitted or unpushed branch; check `git status` and `git log origin/HEAD..HEAD`.',
      })
    }
    const url =
      created.stdout
        .trim()
        .split('\n')
        .filter((l) => l.startsWith('http'))
        .pop() ?? ''
    const number = Number.parseInt(/\/pull\/(\d+)/.exec(url)?.[1] ?? '0', 10)
    return { number: Number.isFinite(number) ? number : 0, url, created: true }
  }

  async findPullRequest({
    cwd,
    branch,
  }: {
    cwd: string
    branch: string
  }): Promise<{ number: number; url: string; state: string } | null> {
    const run = runner(this.options)
    const res = await run(['pr', 'view', branch, '--json', 'number,url,state'], cwd)
    if (res.exitCode !== 0) return null
    try {
      const parsed = JSON.parse(res.stdout) as {
        number?: number
        url?: string
        state?: string
      }
      if (parsed.number === undefined) return null
      return {
        number: parsed.number,
        url: parsed.url ?? '',
        state: parsed.state ?? 'OPEN',
      }
    } catch {
      return null
    }
  }

  async sourceLink({ cwd, branch }: { cwd: string; branch: string }): Promise<string | null> {
    const run = runner(this.options)
    const res = await run(['repo', 'view', '--json', 'url'], cwd)
    if (res.exitCode !== 0) return null
    try {
      const url = (JSON.parse(res.stdout) as { url?: string }).url
      return url === undefined ? null : `${url}/tree/${branch}`
    } catch {
      return null
    }
  }
}
