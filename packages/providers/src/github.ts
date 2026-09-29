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

import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { AnvilError, ErrorCode } from '@anvil/core'
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
import type { ForgeTransport } from '@anvil/worktrees/ship'

const execFileAsync = promisify(execFile)

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
}

/** Run a gh subcommand. Never invokes a shell. */
export async function gh(args: string[], cwd: string): Promise<RunResult> {
  try {
    const { stdout, stderr } = await execFileAsync('gh', args, { cwd, encoding: 'utf8', windowsHide: true, maxBuffer: 8 * 1024 * 1024 })
    return { stdout, stderr, exitCode: 0 }
  } catch (err) {
    const e = err as { code?: number | string; stdout?: string; stderr?: string; message?: string }
    if (e !== null && typeof e === 'object' && typeof e.code === 'number') {
      return { stdout: e.stdout ?? '', stderr: e.stderr ?? e.message ?? '', exitCode: e.code }
    }
    throw new AnvilError(ErrorCode.ToolMissing, `Cannot run gh: ${e?.message ?? String(err)}`, {
      hint: 'Install the GitHub CLI (https://cli.github.com) and run `gh auth login`. anvil needs gh for the GitHub provider.',
      cause: err,
    })
  }
}

function runner(options: GhOptions | undefined): (args: string[], cwd: string) => Promise<RunResult> {
  const run = options?.run
  return run === undefined ? (args, cwd) => gh(args, cwd) : (args, cwd) => run(args, cwd)
}
/** `gh` prefix needed to target a specific host. */
function hostArgs(host: string | undefined): string[] {
  return host === undefined || host === '' ? [] : ['--hostname', host]
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
    const probe = await run(['auth', 'status', ...hostArgs(host)], '.')
    const output = `${probe.stdout}\n${probe.stderr}`

    if (probe.exitCode === 0) {
      const who = /Logged in to .* account ([^\s(]+)/.exec(output)?.[1] ?? 'unknown'
      return { ok: true, identity: who }
    }

    if (/not logged in|no account|not found/i.test(output) || probe.exitCode === 4) {
      return {
        ok: false,
        detail: host === undefined ? 'gh is not logged in to any GitHub host' : `gh is not logged in to ${host}`,
        remediation:
          host === undefined
            ? 'gh auth login'
            : `gh auth login --hostname ${host}`,
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
    const args = ['issue', 'view', ref.id, '--json', 'number,title,body,state,labels,assignees,url,milestone,comments', ...hostArgs(this.options.host)]
    const res = await run(args, '.')
    if (res.exitCode !== 0) {
      throw new AnvilError(ErrorCode.Usage, `gh issue view ${ref.id} failed: ${res.stderr.trim()}`, {
        hint: 'Check the issue number and that gh is authenticated to this host.',
      })
    }
    return parseGhIssue(res.stdout, ref)
  }

  async list(query: TicketQuery = {}): Promise<TicketRef[]> {
    const run = runner(this.options)
    const args = [
      'issue', 'list',
      '--json', 'number,title,state,labels',
      '--limit', String(query.limit ?? 30),
      ...(query.state === 'done' ? ['--state', 'closed'] : query.state === 'todo' ? ['--state', 'open'] : []),
      ...(query.label === undefined ? [] : ['--label', query.label]),
      ...hostArgs(this.options.host),
    ]
    const res = await run(args, '.')
    if (res.exitCode !== 0) return []
    const parsed: unknown = JSON.parse(res.stdout || '[]')
    if (!Array.isArray(parsed)) return []
    return parsed.map((issue) => {
      const n = (issue as { number?: number }).number
      const id = String(n ?? '')
      return { provider: this.id, id, key: `gh-${id}` }
    })
  }

  async create(draft: TicketDraft): Promise<TicketRef> {
    const run = runner(this.options)
    const res = await run(
      [
        'issue', 'create',
        '--title', draft.title,
        '--body', draft.body ?? '',
        ...(draft.labels === undefined || draft.labels.length === 0 ? [] : ['--label', draft.labels.join(',')]),
        ...hostArgs(this.options.host),
        '--json', 'number,url',
      ],
      '.',
    )
    if (res.exitCode !== 0) {
      throw new AnvilError(ErrorCode.Internal, `gh issue create failed: ${res.stderr.trim()}`, { hint: 'Check that gh is authenticated and the repository has a remote.' })
    }
    const parsed = JSON.parse(res.stdout || '{}') as { number?: number; url?: string }
    const id = String(parsed.number ?? '')
    return { provider: this.id, id, key: `gh-${id}`, ...(parsed.url === undefined ? {} : { url: parsed.url }) }
  }

  async comment(ref: TicketRef, body: string): Promise<void> {
    const run = runner(this.options)
    const res = await run(['issue', 'comment', ref.id, '--body', body, ...hostArgs(this.options.host)], '.')
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
    if (ticket.normalizedState === 'done') out.push({ to: 'todo', name: 'reopen' })
    out.push({ to: 'in_review', name: 'label: in-review' })
    return out
  }

  async transition(ref: TicketRef, to: NormalizedState): Promise<void> {
    const run = runner(this.options)
    if (to === 'done' || to === 'wontfix') {
      const res = await run(['issue', 'close', ref.id, ...hostArgs(this.options.host)], '.')
      if (res.exitCode !== 0) throw new AnvilError(ErrorCode.Internal, `gh issue close failed: ${res.stderr.trim()}`)
      return
    }
    if (to === 'todo' || to === 'in_progress') {
      const res = await run(['issue', 'reopen', ref.id, ...hostArgs(this.options.host)], '.')
      if (res.exitCode !== 0) throw new AnvilError(ErrorCode.Internal, `gh issue reopen failed: ${res.stderr.trim()}`)
      if (to === 'in_progress') {
        await this.addLabel(ref, 'in-progress')
      }
      return
    }
    if (to === 'in_review') {
      await this.addLabel(ref, 'in-review')
      return
    }
    throw new AnvilError(ErrorCode.Usage, `Cannot move a GitHub issue to "${to}"`, {
      hint: 'GitHub issues are open/closed; other states are emulated with labels. Supported: todo, in_progress, in_review, done, wontfix.',
    })
  }

  private async addLabel(ref: TicketRef, label: string): Promise<void> {
    const run = runner(this.options)
    const res = await run(['issue', 'edit', ref.id, '--add-label', label, ...hostArgs(this.options.host)], '.')
    if (res.exitCode !== 0) {
      throw new AnvilError(ErrorCode.Internal, `gh issue edit --add-label ${label} failed: ${res.stderr.trim()}`, {
        hint: `The label "${label}" may not exist in this repository. Create it, or pick a state that needs no label.`,
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
    comments?: Array<{ author?: { login?: string }; body?: string; createdAt?: string; url?: string }>
  }

  const id = String(raw.number ?? ref.id)
  const isClosed = (raw.state ?? '').toUpperCase() === 'CLOSED'
  const labels = (raw.labels ?? []).map((l) => l.name ?? '').filter((l) => l !== '')
  const comments = (raw.comments ?? []).map((c) => ({
    author: c.author?.login ?? 'unknown',
    body: c.body ?? '',
    at: c.createdAt ?? '',
    ...(c.url === undefined ? {} : { url: c.url }),
  }))

  // `in_review` is inferred from a label, because GitHub has no such state. Documented
  // here because the canonical model would otherwise look like it is inventing a state.
  let normalizedState: Ticket['normalizedState'] = isClosed ? 'done' : 'todo'
  if (!isClosed) {
    if (labels.some((l) => /wont.?fix/i.test(l))) normalizedState = 'wontfix'
    else if (labels.some((l) => /in.?review/i.test(l))) normalizedState = 'in_review'
    else if (labels.some((l) => /in.?progress/i.test(l))) normalizedState = 'in_progress'
  }

  return {
    ref: { provider: 'github', id, key: `gh-${id}`, ...(raw.url === undefined ? {} : { url: raw.url }) },
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
   * execFile with an argument array, never a shell.
   */
  async pushBranch({ cwd, branch }: { cwd: string; branch: string }): Promise<{ ok: boolean; detail: string }> {
    try {
      const { stderr } = await execFileAsync('git', ['push', '-u', 'origin', branch], { cwd, encoding: 'utf8', windowsHide: true })
      return { ok: true, detail: `pushed ${branch}${stderr.trim() === '' ? '' : ` (${stderr.trim()})`}` }
    } catch (err) {
      const e = err as { code?: number | string; stderr?: string; stdout?: string; message?: string }
      const detail = (e?.stderr ?? e?.stdout ?? e?.message ?? 'git push failed').trim()
      return {
        ok: false,
        detail,
      }
    }
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
    const existing = await this.findPullRequest({ cwd: options.cwd, branch: options.branch })

    if (existing !== null) {
      const edited = await run(
        ['pr', 'edit', String(existing.number), '--title', options.title, '--body', options.body, ...hostArgs(this.options.host)],
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
        'pr', 'create',
        '--title', options.title,
        '--body', options.body,
        '--base', options.base,
        '--head', options.branch,
        ...(options.draft ? ['--draft'] : []),
        ...(options.reviewers.length === 0 ? [] : ['--reviewer', options.reviewers.map((r) => `@${r}`).join(',')]),
        ...hostArgs(this.options.host),
      ],
      options.cwd,
    )
    if (created.exitCode !== 0) {
      throw new AnvilError(ErrorCode.Internal, `gh pr create failed: ${created.stderr.trim()}`, {
        hint: 'A common cause is an uncommitted or unpushed branch; check `git status` and `git log origin/HEAD..HEAD`.',
      })
    }
    const url = created.stdout.trim().split('\n').filter((l) => l.startsWith('http')).pop() ?? ''
    const number = Number.parseInt(/\/pull\/(\d+)/.exec(url)?.[1] ?? '0', 10)
    return { number: Number.isFinite(number) ? number : 0, url, created: true }
  }

  async findPullRequest({ cwd, branch }: { cwd: string; branch: string }): Promise<{ number: number; url: string; state: string } | null> {
    const run = runner(this.options)
    const res = await run(['pr', 'view', branch, '--json', 'number,url,state', ...hostArgs(this.options.host)], cwd)
    if (res.exitCode !== 0) return null
    try {
      const parsed = JSON.parse(res.stdout) as { number?: number; url?: string; state?: string }
      if (parsed.number === undefined) return null
      return { number: parsed.number, url: parsed.url ?? '', state: parsed.state ?? 'OPEN' }
    } catch {
      return null
    }
  }

  async sourceLink({ cwd, branch }: { cwd: string; branch: string }): Promise<string | null> {
    const run = runner(this.options)
    const res = await run(['repo', 'view', '--json', 'url', ...hostArgs(this.options.host)], cwd)
    if (res.exitCode !== 0) return null
    try {
      const url = (JSON.parse(res.stdout) as { url?: string }).url
      return url === undefined ? null : `${url}/tree/${branch}`
    } catch {
      return null
    }
  }
}
