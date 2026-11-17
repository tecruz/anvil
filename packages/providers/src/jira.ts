/**
 * The Jira Cloud provider, over REST API v3.
 *
 * Unlike GitHub, Jira has no CLI that already owns authentication and host selection, so the
 * transport is `fetch`. It stays injectable (`JiraOptions.request`) because every test must
 * run without a network and without a live account.
 *
 * Three boundaries are deliberate:
 *
 * - **Credentials are environment only.** `JIRA_EMAIL` and `JIRA_API_TOKEN` are read when a
 *   request is made, never copied onto the provider, never logged, and never included in an
 *   error. A report names a variable, not a value.
 * - **Bodies are converted, not reinterpreted.** Jira Cloud stores descriptions and comments
 *   as Atlassian Document Format. `Ticket.body` stays markdown, so the conversion happens
 *   here (`adf.ts`) and ticket text is never treated as markup for anything but ADF.
 * - **Only Jira Cloud.** Server and Data Center have a different REST surface; pretending
 *   one client covers both produces authentication failures nobody can diagnose. See
 *   [ADR-0024](../../../docs/adr/0024-jira-cloud-rest-v3.md).
 *
 * Transitions are workflow-driven. A team's Jira workflow has whatever statuses and
 * transitions it has, so `transition` asks the issue which transitions are available *now*
 * and maps the target status onto them. A normalized state with no matching transition is
 * refused with the available names, rather than silently leaving the issue where it was.
 */

import { AnvilError, ErrorCode } from '@anvil/core'
import type {
  AuthStatus,
  NormalizedState,
  ProviderCapabilities,
  ProviderId,
  Ticket,
  TicketComment,
  TicketDraft,
  TicketLink,
  TicketProvider,
  TicketQuery,
  TicketRef,
  Transition,
} from '@anvil/tickets'
import { extractAcceptance } from './acceptance.ts'
import { type AdfDoc, adfToMarkdown, markdownToAdf } from './adf.ts'

/** A request the provider would make. The injectable test seam. */
export interface JiraHttpRequest {
  method: 'GET' | 'POST'
  url: string
  headers: Record<string, string>
  body?: string
}

export interface JiraHttpResponse {
  status: number
  body: string
}

export type JiraRequest = (request: JiraHttpRequest) => Promise<JiraHttpResponse>

export interface JiraOptions {
  /** Jira Cloud site, e.g. `https://acme.atlassian.net`. `null`/empty means unset. */
  site?: string | null
  /** Project key used by `list` and `create`, e.g. `PROJ`. */
  project?: string | null
  /** Issue type used by `create`. Defaults to `Task`. */
  issueType?: string | null
  /** Environment to read credentials from. Defaults to `process.env`; injected in tests. */
  env?: NodeJS.ProcessEnv
  /** Injected transport, so no test reaches the network. */
  request?: JiraRequest
}

/** The REST API version this provider speaks. */
const API = '/rest/api/3'

/** Fields read by `fetch`, in one request rather than one per property. */
const ISSUE_FIELDS = [
  'summary',
  'description',
  'status',
  'resolution',
  'issuetype',
  'priority',
  'assignee',
  'labels',
  'comment',
  'fixVersions',
  'issuelinks',
  'parent',
].join(',')

/** A Jira issue key: a project key, a dash, and a number. */
const ISSUE_KEY = /^[A-Za-z][A-Za-z0-9_]*-[0-9]+$/

/** A project key as Jira accepts it in a create payload and a JQL clause. */
const PROJECT_KEY = /^[A-Za-z][A-Za-z0-9_]*$/

/**
 * Status names that mean "a human is looking at this", not "someone is typing".
 *
 * Jira's status *category* is `indeterminate` for both, so the name is the only signal a
 * generic client has. It is applied only within that category: a `Done` status called
 * "Verified" is still done.
 */
const REVIEW_STATUS = /review|verif|\bqa\b|test/i

/** Resolutions that mean "we will not do this", used to map a done status to `wontfix`. */
const WONTFIX_RESOLUTION = /won'?t|reject|declin/i

/** A resolution to attach when moving to `done`. */
const DONE_RESOLUTION = /^(done|fixed|complete|completed|resolved|implemented)$/i

/** A search page. Jira Cloud caps `maxResults`; 100 is always accepted. */
const SEARCH_PAGE = 100

/** Request timeout. A hung socket must not hang `crew up`. */
const REQUEST_TIMEOUT_MS = 30_000

interface JiraStatus {
  name?: string
  statusCategory?: { key?: string; name?: string }
}

interface JiraResolution {
  name?: string
}

interface JiraCommentPayload {
  author?: { displayName?: string; emailAddress?: string }
  body?: unknown
  created?: string
  self?: string
}

interface JiraIssueFields {
  summary?: string
  description?: unknown
  status?: JiraStatus
  resolution?: JiraResolution | null
  issuetype?: { name?: string }
  priority?: { name?: string }
  assignee?: { displayName?: string; emailAddress?: string }
  labels?: string[]
  comment?: { comments?: JiraCommentPayload[] }
  fixVersions?: Array<{ name?: string }>
  issuelinks?: Array<{
    outwardIssue?: { key?: string; fields?: { summary?: string } }
    inwardIssue?: { key?: string; fields?: { summary?: string } }
  }>
}

interface JiraIssuePayload {
  id?: string
  key?: string
  self?: string
  fields?: JiraIssueFields
}

interface JiraTransitionPayload {
  id?: string
  name?: string
  to?: JiraStatus
  fields?: {
    resolution?: {
      required?: boolean
      allowedValues?: Array<{ id?: string; name?: string }>
    }
  }
}

/** A transition the issue can make right now, with the resolution it may need. */
interface JiraTransition {
  id: string
  name: string
  to: JiraStatus
  resolutions: Array<{ id: string; name: string }>
}

/**
 * Normalize a configured site into an origin, or null when it is unusable.
 *
 * Accepts what people paste: a bare host, a URL with a trailing slash, or a URL that
 * already includes `/rest/api/3`. Rejecting anything with a scheme other than http(s)
 * keeps `provider.jira.site` from becoming a file or javascript URL.
 */
export function normalizeJiraSite(value: string | null | undefined): string | null {
  if (value === null || value === undefined) return null
  const trimmed = value.trim()
  if (trimmed === '') return null
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`
  let parsed: URL
  try {
    parsed = new URL(withScheme)
  } catch {
    return null
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return null
  // Jira Cloud's REST API always lives at the site root, even when the browser URL has a
  // `/jira/...` path. Keeping a path would build `/jira/rest/api/3`, which does not exist.
  return `${parsed.protocol}//${parsed.host}`
}

/** Validate and normalize an issue key. Refuses option- and path-shaped ids. */
export function jiraIssueKey(value: string): string {
  const key = value.trim()
  if (!ISSUE_KEY.test(key)) {
    throw new AnvilError(ErrorCode.Usage, `Invalid Jira issue key "${value}"`, {
      hint: 'A Jira issue key looks like PROJ-123, or paste its browse URL.',
      details: { key: value },
    })
  }
  return key.toUpperCase()
}

/** Escape a value interpolated into a JQL string literal. */
function jqlQuote(value: string): string {
  if (/[\r\n\0]/.test(value)) {
    throw new AnvilError(ErrorCode.Usage, 'A JQL value may not contain a line break', {
      hint: 'Use a label or project key without control characters.',
    })
  }
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
}

/** The normalized state a status means, optionally taking a resolution into account. */
export function normalizedStateForJira(
  status: JiraStatus | undefined,
  resolution: JiraResolution | null | undefined,
): NormalizedState {
  const category = status?.statusCategory?.key?.toLowerCase()
  const name = status?.name ?? ''

  if (category === 'new') return 'todo'
  if (category === 'indeterminate') return REVIEW_STATUS.test(name) ? 'in_review' : 'in_progress'
  if (category === 'done') {
    const resolved = resolution?.name ?? ''
    return resolved !== '' && WONTFIX_RESOLUTION.test(resolved) ? 'wontfix' : 'done'
  }

  // A workflow can expose a status without a category. Fall back to the vocabulary Jira
  // itself uses, rather than reporting `unknown` for an issue that plainly has a state.
  if (category !== undefined && category !== '') return 'unknown'
  if (REVIEW_STATUS.test(name)) return 'in_review'
  if (/to.?do|open|backlog|new/i.test(name)) return 'todo'
  if (/done|closed|resolved|complete/i.test(name)) {
    const resolved = resolution?.name ?? ''
    return resolved !== '' && WONTFIX_RESOLUTION.test(resolved) ? 'wontfix' : 'done'
  }
  if (name !== '') return 'in_progress'
  return 'unknown'
}

/**
 * The resolution a done-shaped transition needs for `to`, if any.
 *
 * A `done` transition may offer only a team's own resolution names ("Shipped"). Any allowed
 * resolution is closer to the caller's intent than omitting a required field -- but a
 * rejection resolution is not: choosing it would make the issue `wontfix` while the caller
 * asked for `done`. A transition whose only choices are rejections therefore cannot reach
 * `done` at all.
 */
function resolutionFor(transition: JiraTransition, to: 'done' | 'wontfix'): { id: string; name: string } | null {
  if (to === 'wontfix') {
    return transition.resolutions.find((resolution) => WONTFIX_RESOLUTION.test(resolution.name)) ?? null
  }
  const accepted = transition.resolutions.filter((resolution) => !WONTFIX_RESOLUTION.test(resolution.name))
  return accepted.find((resolution) => DONE_RESOLUTION.test(resolution.name)) ?? accepted[0] ?? null
}

/** Whether a transition to a done status can land there as `done` rather than `wontfix`. */
function reachesDone(transition: JiraTransition): boolean {
  // No resolution field means the workflow requires none, so the status itself is the answer.
  return transition.resolutions.length === 0 || resolutionFor(transition, 'done') !== null
}

/** The default transport: built-in `fetch`, with a timeout and no header logging. */
async function defaultRequest(request: JiraHttpRequest): Promise<JiraHttpResponse> {
  let response: Response
  try {
    response = await fetch(request.url, {
      method: request.method,
      headers: request.headers,
      ...(request.body === undefined ? {} : { body: request.body }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    })
  } catch {
    const host = safeHost(request.url)
    throw new AnvilError(ErrorCode.AuthFailed, `Could not reach Jira at ${host}`, {
      hint: 'Check the site, the network and any proxy. `anvil auth jira` checks the local configuration without the network.',
      details: { host },
    })
  }
  let body: string
  try {
    body = await response.text()
  } catch {
    body = ''
  }
  return { status: response.status, body }
}

function safeHost(url: string): string {
  try {
    return new URL(url).host
  } catch {
    return '(unknown host)'
  }
}

/** A short, non-credential error message from a Jira error body. */
function jiraErrorMessage(body: string, status: number): string {
  try {
    const parsed = JSON.parse(body) as {
      errorMessages?: unknown
      errors?: Record<string, unknown>
    }
    const messages = Array.isArray(parsed.errorMessages)
      ? parsed.errorMessages.filter((m): m is string => typeof m === 'string' && m.trim() !== '')
      : []
    const fields = Object.entries(parsed.errors ?? {})
      .map(([field, message]) => `${field}: ${typeof message === 'string' ? message : 'invalid'}`)
      .filter((line) => line !== '')
    const text = [...messages, ...fields].join('; ')
    if (text !== '') return text.slice(0, 300)
  } catch {
    // Fall through to a status-only message: an HTML error page must not leak into output.
  }
  return `HTTP ${String(status)}`
}

/** Build the error for a non-2xx response, with a next step that depends on the status. */
function jiraHttpError(status: number, body: string, action: string): AnvilError {
  const detail = jiraErrorMessage(body, status)
  if (status === 401) {
    return new AnvilError(ErrorCode.AuthFailed, `Jira rejected the credentials while trying to ${action}: ${detail}`, {
      hint: 'Set JIRA_EMAIL and JIRA_API_TOKEN. A Jira API token is not your account password; create one at https://id.atlassian.com/manage-profile/security/api-tokens.',
      details: { status },
    })
  }
  if (status === 403) {
    return new AnvilError(ErrorCode.AuthFailed, `Jira refused permission to ${action}: ${detail}`, {
      hint: 'The token is valid but the account cannot perform this operation on this project. Check the project permissions in Jira.',
      details: { status },
    })
  }
  if (status === 404) {
    return new AnvilError(ErrorCode.Usage, `Jira could not find what ${action} needs: ${detail}`, {
      hint: 'Check the issue key and provider.jira.site; a Jira Cloud site is https://<name>.atlassian.net.',
      details: { status },
    })
  }
  if (status === 400) {
    return new AnvilError(ErrorCode.Usage, `Jira rejected the request to ${action}: ${detail}`, {
      hint: 'Check provider.jira.project, provider.jira.issueType, and the fields this workflow requires.',
      details: { status },
    })
  }
  return new AnvilError(ErrorCode.Internal, `Jira failed while trying to ${action}: ${detail}`, {
    hint: 'Retry. If it persists, check the site and https://status.atlassian.com.',
    details: { status },
  })
}

export class JiraProvider implements TicketProvider {
  readonly id: ProviderId = 'jira'
  readonly capabilities: ProviderCapabilities = {
    create: true,
    comment: true,
    transition: true,
    link: true,
    list: true,
    // Descriptions and comments are ADF, not markdown. The flag is how a caller knows the
    // body it reads was converted and the body it writes will be.
    rawBodies: true,
  }

  private readonly options: JiraOptions

  constructor(options: JiraOptions = {}) {
    this.options = options
  }

  /**
   * Offline auth check.
   *
   * It cannot prove the token works without a network call, and the contract says `authStatus`
   * must not make one. It does answer the two questions that account for almost every failure:
   * is the site configured, and are both variables present? A missing project is reported as
   * a note, not a failure: `claim PROJ-123` needs no project.
   */
  async authStatus(): Promise<AuthStatus> {
    const site = normalizeJiraSite(this.options.site)
    if (site === null) {
      return {
        ok: false,
        detail: 'provider.jira.site is not set',
        remediation:
          'Set provider.jira.site in anvil.config.json to your Jira Cloud site, for example "https://acme.atlassian.net".',
      }
    }

    const missing = this.missingCredentials()
    if (missing.length > 0) {
      return {
        ok: false,
        detail: `Jira credentials are not set: ${missing.join(', ')}`,
        remediation:
          'Set JIRA_EMAIL and JIRA_API_TOKEN in the environment. Create an API token at https://id.atlassian.com/manage-profile/security/api-tokens.',
      }
    }

    const project = this.options.project?.trim() ?? ''
    const notes: string[] = []
    if (project === '') notes.push('provider.jira.project is not set, so list and create are unavailable')
    notes.push(`site ${site}`)
    return {
      ok: true,
      // The email is half of the credential pair. Anvil reports that the pair is present,
      // never the pair itself; this check also runs in `--json`, which is easy to paste.
      detail: notes.join('; '),
    }
  }

  async fetch(ref: TicketRef): Promise<Ticket> {
    const key = this.keyOf(ref)
    const payload = (await this.call(
      'GET',
      `/issue/${encodeURIComponent(key)}?fields=${ISSUE_FIELDS}`,
    )) as JiraIssuePayload
    return this.toTicket(key, payload)
  }

  /**
   * Issues in the project, narrowed by the requested state and label.
   *
   * The JQL clause for `statusCategory` is a server-side narrowing; the final filter uses
   * the same mapping as `fetch`, because `in_review` vs `in_progress` is decided by status
   * *name*, which JQL cannot express portably. Pagination follows `nextPageToken` until the
   * caller's limit is met or Jira says the result is complete. If the page cap is reached
   * first, the answer is an explicit incomplete-listing error, not a truncated set reported
   * as "no ready work".
   */
  async list(query: TicketQuery = {}): Promise<TicketRef[]> {
    const project = this.projectKey()
    const limit = query.limit ?? 30
    const clauses = [`project = ${jqlQuote(project)}`]
    if (query.state === 'done' || query.state === 'wontfix') {
      clauses.push('statusCategory = Done')
    } else if (query.state !== undefined && query.state !== 'unknown') {
      clauses.push('statusCategory != Done')
    }
    if (query.label !== undefined && query.label.trim() !== '') {
      clauses.push(`labels = ${jqlQuote(query.label.trim())}`)
    }
    const jql = `${clauses.join(' AND ')} ORDER BY created ASC`

    const out: TicketRef[] = []
    const maxPages = Math.max(20, Math.ceil(limit / SEARCH_PAGE) + 1)
    let token: string | undefined
    const site = this.site()

    for (let page = 0; page < maxPages; page++) {
      const payload = (await this.call('POST', '/search/jql', {
        jql,
        fields: ['summary', 'status', 'resolution', 'labels'],
        maxResults: SEARCH_PAGE,
        ...(token === undefined ? {} : { nextPageToken: token }),
      })) as {
        issues?: JiraIssuePayload[]
        isLast?: boolean
        nextPageToken?: string
      }
      if (!Array.isArray(payload.issues)) {
        throw new AnvilError(ErrorCode.Internal, 'Jira search returned something that is not a list of issues', {
          hint: 'Expected an "issues" array from /rest/api/3/search/jql.',
        })
      }

      for (const issue of payload.issues) {
        const key = issue.key ?? ''
        if (key === '') continue
        const fields = issue.fields ?? {}
        const state = normalizedStateForJira(fields.status, fields.resolution)
        if (query.state !== undefined && state !== query.state) continue
        if (query.label !== undefined && query.label.trim() !== '') {
          const wanted = query.label.trim().toLowerCase()
          if (!(fields.labels ?? []).some((label) => label.toLowerCase() === wanted)) continue
        }
        out.push({ provider: this.id, id: key, key, url: `${site}/browse/${key}` })
        if (out.length >= limit) return out
      }

      if (payload.isLast === true) return out
      if (typeof payload.nextPageToken !== 'string' || payload.nextPageToken === '') return out
      token = payload.nextPageToken
    }

    throw new AnvilError(ErrorCode.Usage, 'Jira returned more issues than anvil can page through', {
      hint: `Narrow the query, or ask for fewer than ${(maxPages * SEARCH_PAGE).toLocaleString('en-US')} issues.`,
      details: { state: query.state ?? null, label: query.label ?? null, matches: out.length, limit },
    })
  }

  async create(draft: TicketDraft): Promise<TicketRef> {
    const site = this.site()
    const project = this.projectKey()
    const issueType = this.issueType()
    const payload = (await this.call('POST', '/issue', {
      fields: {
        project: { key: project },
        issuetype: { name: issueType },
        summary: draft.title,
        ...(draft.body === undefined ? {} : { description: markdownToAdf(draft.body) }),
        ...(draft.labels === undefined || draft.labels.length === 0 ? {} : { labels: draft.labels }),
      },
    })) as { id?: string; key?: string }

    const key = typeof payload.key === 'string' ? payload.key : ''
    if (!ISSUE_KEY.test(key)) {
      throw new AnvilError(ErrorCode.Internal, 'Jira created an issue but returned no issue key', {
        hint: 'Anvil needs the key (for example PROJ-123) to record the claim. Check that the project and issue type exist.',
      })
    }
    return { provider: this.id, id: key, key, url: `${site}/browse/${key}` }
  }

  async comment(ref: TicketRef, body: string): Promise<void> {
    const key = this.keyOf(ref)
    await this.call('POST', `/issue/${encodeURIComponent(key)}/comment`, {
      body: markdownToAdf(body),
    })
  }

  /** The transitions available **now**, mapped onto normalized states. */
  async transitions(ref: TicketRef): Promise<Transition[]> {
    const available = await this.transitionMetadata(ref)
    const out: Transition[] = []
    const seen = new Set<NormalizedState>()

    for (const transition of available) {
      const target = normalizedStateForJira(transition.to, null)
      if (target === 'unknown') continue
      // A done status can mean "won't fix" too, but only when the transition offers a
      // resolution that says so. And it can only mean `done` when it does not offer *only*
      // rejection resolutions. Listing either otherwise would promise a state the workflow
      // cannot reach.
      const states: NormalizedState[] = []
      if (target === 'done') {
        if (reachesDone(transition)) states.push('done')
        if (resolutionFor(transition, 'wontfix') !== null) states.push('wontfix')
      } else {
        states.push(target)
      }

      for (const state of states) {
        if (seen.has(state)) continue
        seen.add(state)
        out.push({ to: state, name: transition.name })
      }
    }
    return out
  }

  /**
   * Move the issue along its own workflow.
   *
   * The target is matched against the transitions Jira reports for this issue. `wontfix`
   * requires a transition to a done status whose resolution says so -- a status *name* that
   * happens to contain "reject" is not enough, because the transition would still leave the
   * issue with an ordinary resolution.
   */
  async transition(ref: TicketRef, to: NormalizedState): Promise<void> {
    if (to === 'unknown') {
      throw new AnvilError(ErrorCode.Usage, 'Cannot move a Jira issue to "unknown"', {
        hint: 'Supported: todo, in_progress, in_review, done, wontfix.',
      })
    }
    const key = this.keyOf(ref)
    const available = await this.transitionMetadata(ref)

    let chosen: JiraTransition | undefined
    let resolution: { id: string; name: string } | null = null
    if (to === 'wontfix') {
      for (const transition of available) {
        if (normalizedStateForJira(transition.to, null) !== 'done') continue
        const candidate = resolutionFor(transition, 'wontfix')
        if (candidate === null) continue
        chosen = transition
        resolution = candidate
        break
      }
    } else {
      if (to === 'done') {
        chosen = available.find(
          (transition) => normalizedStateForJira(transition.to, null) === 'done' && reachesDone(transition),
        )
      } else {
        chosen = available.find((transition) => normalizedStateForJira(transition.to, null) === to)
      }
      if (chosen !== undefined && to === 'done') resolution = resolutionFor(chosen, 'done')
    }

    if (chosen === undefined) {
      const names = available.map((transition) => `${transition.name} -> ${transition.to.name ?? 'unknown'}`)
      throw new AnvilError(ErrorCode.Usage, `Jira has no transition from ${key} to "${to}"`, {
        hint:
          names.length === 0
            ? 'This issue has no available transitions. Check the workflow and the account permissions.'
            : `Available now: ${names.join(', ')}. Map the state in the workflow, or move the issue in Jira.`,
        details: { issue: key, to, available: names },
      })
    }

    await this.call('POST', `/issue/${encodeURIComponent(key)}/transitions`, {
      transition: { id: chosen.id },
      ...(resolution === null ? {} : { resolution: { id: resolution.id } }),
    })
  }

  /** Jira renders a comment; the link contract is the same as GitHub's. */
  async link(ref: TicketRef, url: string, title?: string): Promise<void> {
    const label = title === undefined ? url : `${title}: ${url}`
    await this.comment(ref, label)
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  private site(): string {
    const site = normalizeJiraSite(this.options.site)
    if (site === null) {
      throw new AnvilError(ErrorCode.ConfigInvalid, 'The jira provider needs provider.jira.site', {
        hint: 'Set provider.jira.site to your Jira Cloud site, for example "https://acme.atlassian.net".',
      })
    }
    return site
  }

  private projectKey(): string {
    const project = this.options.project?.trim() ?? ''
    if (project === '') {
      throw new AnvilError(
        ErrorCode.ConfigInvalid,
        'The jira provider needs provider.jira.project for this operation',
        {
          hint: 'Set provider.jira.project to the project key, for example "PROJ". `claim PROJ-123` does not need it.',
        },
      )
    }
    if (!PROJECT_KEY.test(project)) {
      throw new AnvilError(ErrorCode.ConfigInvalid, `Invalid Jira project key in provider.jira.project: "${project}"`, {
        hint: 'A Jira project key starts with a letter and contains only letters, digits and underscores, for example PROJ.',
      })
    }
    return project
  }

  private issueType(): string {
    const issueType = this.options.issueType?.trim() ?? ''
    const value = issueType === '' ? 'Task' : issueType
    if (/[\r\n\0]/.test(value)) {
      throw new AnvilError(ErrorCode.ConfigInvalid, 'provider.jira.issueType may not contain a line break')
    }
    return value
  }

  /**
   * The issue key a ref names.
   *
   * A URL is honoured when the ref's id is not itself a key, so a claim recorded from a
   * browse URL still fetches the right issue. Anything else is refused before a request is
   * built.
   */
  private keyOf(ref: TicketRef): string {
    const candidates = [ref.id, ref.key]
    for (const candidate of candidates) {
      if (ISSUE_KEY.test(candidate.trim())) return jiraIssueKey(candidate)
    }
    if (ref.url !== undefined) {
      const match = /\/browse\/([A-Za-z][A-Za-z0-9_]*-[0-9]+)(?:[/?#]|$)/i.exec(ref.url)
      if (match !== null) return jiraIssueKey(match[1] as string)
    }
    throw new AnvilError(ErrorCode.Usage, `Invalid Jira issue key "${ref.id || ref.key}"`, {
      hint: 'A Jira issue key looks like PROJ-123, or paste its browse URL.',
      details: { id: ref.id, key: ref.key },
    })
  }

  private credentials(): { email: string; token: string } {
    const env = this.options.env ?? process.env
    const email = (env.JIRA_EMAIL ?? '').trim()
    const token = (env.JIRA_API_TOKEN ?? '').trim()
    const missing: string[] = []
    if (email === '') missing.push('JIRA_EMAIL')
    if (token === '') missing.push('JIRA_API_TOKEN')
    if (missing.length > 0) {
      throw new AnvilError(ErrorCode.AuthFailed, `Jira credentials are not set: ${missing.join(', ')}`, {
        hint: 'Set JIRA_EMAIL and JIRA_API_TOKEN in the environment. Anvil never writes them to disk.',
        details: { missing },
      })
    }
    return { email, token }
  }

  private missingCredentials(): string[] {
    const env = this.options.env ?? process.env
    const missing: string[] = []
    if ((env.JIRA_EMAIL ?? '').trim() === '') missing.push('JIRA_EMAIL')
    if ((env.JIRA_API_TOKEN ?? '').trim() === '') missing.push('JIRA_API_TOKEN')
    return missing
  }

  /** One authenticated REST call. The header is built here and never retained. */
  private async call(method: 'GET' | 'POST', path: string, payload?: unknown): Promise<unknown> {
    const site = this.site()
    const credentials = this.credentials()
    const request = this.options.request ?? defaultRequest
    const url = `${site}${API}${path}`
    const headers: Record<string, string> = {
      accept: 'application/json',
      authorization: `Basic ${Buffer.from(`${credentials.email}:${credentials.token}`, 'utf8').toString('base64')}`,
      ...(payload === undefined ? {} : { 'content-type': 'application/json' }),
    }

    let response: JiraHttpResponse
    try {
      response = await request({
        method,
        url,
        headers,
        ...(payload === undefined ? {} : { body: JSON.stringify(payload) }),
      })
    } catch (error) {
      if (error instanceof AnvilError) throw error
      // The transport failed before there was a response. Its message is not repeated:
      // some HTTP clients echo request details, and one of those is the auth header.
      const host = safeHost(url)
      throw new AnvilError(ErrorCode.AuthFailed, `Could not reach Jira at ${host}`, {
        hint: 'Check the site, the network and any proxy, then retry.',
        details: { host },
      })
    }

    const action = actionFor(method, path)
    if (response.status < 200 || response.status >= 300) {
      throw jiraHttpError(response.status, response.body, action)
    }
    if (response.body.trim() === '') return {}

    try {
      return JSON.parse(response.body) as unknown
    } catch {
      throw new AnvilError(ErrorCode.Internal, `Jira returned a response that is not JSON while trying to ${action}`, {
        hint: 'This usually means a proxy or SSO page answered instead of Jira. Check provider.jira.site and the network.',
      })
    }
  }

  /** The transitions metadata call, shared by `transitions` and `transition`. */
  private async transitionMetadata(ref: TicketRef): Promise<JiraTransition[]> {
    const key = this.keyOf(ref)
    const payload = (await this.call(
      'GET',
      `/issue/${encodeURIComponent(key)}/transitions?expand=transitions.fields`,
    )) as { transitions?: JiraTransitionPayload[] }

    const out: JiraTransition[] = []
    for (const transition of payload.transitions ?? []) {
      const id = typeof transition.id === 'string' ? transition.id : ''
      const name = typeof transition.name === 'string' ? transition.name : ''
      if (id === '' || name === '') continue
      const resolutions = (transition.fields?.resolution?.allowedValues ?? [])
        .map((resolution) => ({
          id: typeof resolution.id === 'string' ? resolution.id : '',
          name: typeof resolution.name === 'string' ? resolution.name : '',
        }))
        .filter((resolution) => resolution.id !== '')
      out.push({ id, name, to: transition.to ?? {}, resolutions })
    }
    return out
  }

  /** Map one issue payload onto the canonical ticket. */
  private toTicket(key: string, payload: JiraIssuePayload): Ticket {
    const fields = payload.fields ?? {}
    const body = fields.description === undefined ? undefined : adfToMarkdown(fields.description)
    const site = normalizeJiraSite(this.options.site)
    const comments: TicketComment[] = (fields.comment?.comments ?? []).map((comment) => ({
      author: comment.author?.displayName ?? comment.author?.emailAddress ?? 'unknown',
      body: comment.body === undefined ? '' : adfToMarkdown(comment.body),
      at: comment.created ?? '',
      ...(comment.self === undefined ? {} : { url: comment.self }),
    }))

    const links: TicketLink[] = []
    if (site !== null) {
      for (const link of fields.issuelinks ?? []) {
        const issue = link.outwardIssue ?? link.inwardIssue
        const linkedKey = issue?.key ?? ''
        if (linkedKey === '') continue
        links.push({
          kind: 'issue',
          url: `${site}/browse/${linkedKey}`,
          ...(issue?.fields?.summary === undefined ? {} : { title: issue.fields.summary }),
        })
      }
    }

    const assignee = fields.assignee?.displayName ?? fields.assignee?.emailAddress
    const milestone = fields.fixVersions?.[0]?.name
    const issueKey = payload.key ?? key

    return {
      ref: {
        provider: this.id,
        id: issueKey,
        key: issueKey,
        ...(site === null ? {} : { url: `${site}/browse/${issueKey}` }),
      },
      title: fields.summary ?? '',
      ...(body === undefined ? {} : { body }),
      ...(fields.status?.name === undefined ? {} : { state: fields.status.name }),
      normalizedState: normalizedStateForJira(fields.status, fields.resolution),
      ...(fields.issuetype?.name === undefined ? {} : { type: fields.issuetype.name }),
      ...(fields.priority?.name === undefined ? {} : { priority: fields.priority.name }),
      ...(assignee === undefined ? {} : { assignee }),
      ...(fields.labels === undefined ? {} : { labels: fields.labels }),
      ...(milestone === undefined ? {} : { milestone }),
      baseBranch: null,
      ...(links.length === 0 ? {} : { links }),
      comments,
      acceptance: extractAcceptance(body),
      raw: payload,
    }
  }
}

/** A human description of an operation, for an error that does not repeat the path. */
function actionFor(method: 'GET' | 'POST', path: string): string {
  if (method === 'GET' && path.startsWith('/issue/') && path.includes('/transitions')) {
    return 'read the issue transitions'
  }
  if (method === 'GET' && path.startsWith('/issue/')) return 'read the issue'
  if (method === 'POST' && path === '/issue') return 'create the issue'
  if (method === 'POST' && path.endsWith('/comment')) return 'comment on the issue'
  if (method === 'POST' && path.endsWith('/transitions')) return 'move the issue'
  if (method === 'POST' && path === '/search/jql') return 'list issues'
  return 'talk to Jira'
}

/** The ADF type a caller may need when building a body directly. */
export type { AdfDoc }
