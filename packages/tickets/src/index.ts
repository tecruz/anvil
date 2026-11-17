/**
 * The canonical ticket model and the provider interface.
 *
 * Trackers do not agree: GitHub Issues has two states and infers "in review" from a
 * linked pull request, Jira has a configurable workflow, Linear has its own vocabulary.
 * The canonical model therefore keeps the provider's own `state` *and* a normalized one,
 * never discards `raw`, and makes each provider responsible for the mapping -- which is
 * part of that provider's contract tests.
 *
 * `normalizedState` is deliberately coarse. It exists so anvil can ask "is this done?"
 * without knowing which tracker it is talking to, not so it can render a board.
 */

export type ProviderId = string

export interface TicketRef {
  provider: ProviderId
  /** Provider-native id, e.g. '42' or '10001'. */
  id: string
  /** Human key used in branch names, e.g. 'gh-42' or 'PROJ-123'. */
  key: string
  url?: string
}

/** Coarse enough to be comparable, specific enough to be useful. */
export type NormalizedState = 'todo' | 'in_progress' | 'in_review' | 'done' | 'wontfix' | 'unknown'

export interface TicketComment {
  author: string
  body: string
  at: string
  url?: string
}

export interface TicketLink {
  kind: 'pr' | 'doc' | 'commit' | 'issue' | 'other'
  url: string
  title?: string
}

export interface Ticket {
  ref: TicketRef
  title: string
  /** Normalized markdown, converted from the provider's format when needed. */
  body?: string
  /** The provider's own state string, untouched. */
  state?: string
  normalizedState: NormalizedState
  type?: string
  priority?: string
  assignee?: string
  labels?: string[]
  milestone?: string
  /**
   * The branch this work should fork from: a parent/fix-version/target field, or null to
   * use the repository's default branch.
   */
  baseBranch?: string | null
  links?: TicketLink[]
  comments?: TicketComment[]
  /** Acceptance criteria, when the provider exposes them as a distinct field. */
  acceptance?: string[]
  /**
   * The provider's original payload. Never dropped: mapping is lossy, and losing the
   * original is how a round-trip silently corrupts a ticket.
   */
  raw?: unknown
}

export interface TicketDraft {
  title: string
  body?: string
  labels?: string[]
  baseBranch?: string | null
}

export interface TicketQuery {
  state?: NormalizedState
  label?: string
  limit?: number
}

export interface ProviderCapabilities {
  create: boolean
  comment: boolean
  transition: boolean
  link: boolean
  list: boolean
  /** True when the provider's body format is not markdown and must be converted. */
  rawBodies: boolean
}

export interface Transition {
  /** A name anvil maps to a provider-native id. */
  to: NormalizedState
  /** The provider's own name, for error messages. */
  name: string
}

export interface AuthStatus {
  ok: boolean
  /** Who we are, when the provider can say. */
  identity?: string
  /** The exact command to fix it, when it cannot. */
  remediation?: string
  detail?: string
}

export interface TicketProvider {
  id: ProviderId
  capabilities: ProviderCapabilities
  /** Cheap, offline check. Must not make a network call. */
  authStatus(): Promise<AuthStatus>
  fetch(ref: TicketRef): Promise<Ticket>
  list?(query: TicketQuery): Promise<TicketRef[]>
  create(draft: TicketDraft): Promise<TicketRef>
  comment(ref: TicketRef, body: string): Promise<void>
  /** Transitions available *now*, for mapping a normalized state to a native id. */
  transitions(ref: TicketRef): Promise<Transition[]>
  transition(ref: TicketRef, to: NormalizedState): Promise<void>
  link(ref: TicketRef, url: string, title?: string): Promise<void>
}

// ---------------------------------------------------------------------------
// Refs, slugs and branch names
// ---------------------------------------------------------------------------

/**
 * Branch-safe slug.
 *
 * Kept short on purpose: the slug is embedded in a branch name, and on Windows the branch
 * name is part of the worktree path, which is already near the length limit.
 */
export function slugify(text: string, maxLength = 30): string {
  const slug = text
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
  if (slug.length <= maxLength) return slug
  // Cut on a word boundary so the slug stays readable rather than truncated mid-word.
  const cut = slug.slice(0, maxLength)
  const lastDash = cut.lastIndexOf('-')
  return (lastDash > maxLength * 0.6 ? cut.slice(0, lastDash) : cut).replace(/-+$/, '')
}

/** Branch name for a ticket: `<key-slug>` or `<type>/<key-slug>`. */
export function branchNameFor(ref: TicketRef, title: string, prefix?: string): string {
  const key = ref.key
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
  const slug = slugify(title)
  const head = prefix === undefined || prefix === '' ? 'feat' : slugify(prefix, 12)
  return slug === '' ? head : `${head}/${key}-${slug}`
}

/**
 * The provider a reference names by itself, if any.
 *
 * Two shapes carry one: a hosted ticket URL (`.../issues/42` or a Jira `/browse/PROJ-123`)
 * and a `gh-42` / `gl-42` key. Everything else -- `42`, `#42`, `local-3`, `PROJ-123` --
 * names no provider, and the caller's default decides. This is separate from `parseRef`
 * because provider selection and reference parsing are two questions, and a caller has to
 * answer the first before it can answer the second.
 */
export function providerHintFor(
  input: string,
  githubHosts?: readonly (string | null | undefined)[],
  jiraSites?: readonly (string | null | undefined)[],
): ProviderId | null {
  const raw = input.trim()

  if (/^https?:\/\/[^\s]+$/i.test(raw)) {
    const parsed = parseTicketUrl(raw, githubHosts, jiraSites)
    return parsed === null ? null : parsed.provider
  }

  const hosted = /^(gh|gl)-(\d+)$/i.exec(raw)
  if (hosted !== null) return (hosted[1] as string).toLowerCase() === 'gh' ? 'github' : 'gitlab'

  return null
}

/** Parse a user-supplied ref: `42`, `#42`, `gh-42`, `PROJ-123`, or a full URL. */
export function parseRef(
  input: string,
  defaultProvider: ProviderId = 'local',
  githubHosts?: readonly (string | null | undefined)[],
  jiraSites?: readonly (string | null | undefined)[],
): TicketRef {
  const raw = input.trim()

  // A URL carries its own provider, and is worth honouring: pasting a ticket link is the
  // most natural thing a user can do.
  const url = /^(https?:\/\/[^\s]+)$/i.exec(raw)
  if (url !== null) {
    // When GitHub is *selected* (rather than inferred), the URL must be a GitHub issue URL
    // whatever its host is called: a `gitlab.*` or unknown host in GitHub's exact shape is
    // read as that issue, and any other shape is kept verbatim, so the GitHub provider
    // refuses it instead of turning part of the path into a `--repo`.
    if (defaultProvider === 'github') {
      const address = githubTicketAddress(raw)
      if (address !== null) {
        return { provider: 'github', id: address.id, key: `gh-${address.id}`, url: raw }
      }
    } else if (defaultProvider === 'jira') {
      // An explicit `--provider jira` is the user saying "this is Jira": any host with a
      // `/browse/<KEY>` path is accepted, because Jira Server deployments live on arbitrary
      // hostnames. Inference stays conservative and only recognises known Jira hosts.
      const address = jiraTicketAddress(raw)
      if (address !== null) {
        return { provider: 'jira', id: address.key, key: address.key, url: raw }
      }
    } else {
      const parsed = parseTicketUrl(raw, githubHosts, jiraSites)
      if (parsed !== null) return parsed
    }
  }

  // `gh-42` and `gl-42` name their provider, exactly as the URL forms do. Without this a
  // `github` selection would fetch issue 42 correctly, but a `gh-42` reference typed
  // against the default (local) provider would look for a local markdown file called
  // `gh-42`.
  const hosted = /^(gh|gl)-(\d+)$/i.exec(raw)
  if (hosted !== null) {
    const prefix = (hosted[1] as string).toLowerCase()
    const id = hosted[2] as string
    return { provider: prefix === 'gh' ? 'github' : 'gitlab', id, key: `${prefix}-${id}` }
  }

  const hash = /^#(\d+)$/.exec(raw)
  if (hash !== null) {
    const id = hash[1] as string
    return { provider: defaultProvider, id, key: numericKey(defaultProvider, id) }
  }

  const prefixed = /^([A-Za-z][\w-]*?)-(\d+)$/.exec(raw)
  if (prefixed !== null) {
    const prefix = prefixed[1] as string
    const id = prefixed[2] as string
    // A Jira issue key is case-sensitive in the API and conventionally uppercase. The
    // branch name is lowercased separately, so preserving `PROJ` here keeps `claim
    // PROJ-123` and `claim proj-123` on the same issue rather than two.
    if (defaultProvider === 'jira') {
      const key = `${prefix}-${id}`.toUpperCase()
      return { provider: 'jira', id: key, key }
    }
    return {
      provider: defaultProvider,
      id,
      key: `${prefix.toLowerCase()}-${id}`,
    }
  }

  const numeric = /^(\d+)$/.exec(raw)
  if (numeric !== null) {
    const id = numeric[1] as string
    return { provider: defaultProvider, id, key: numericKey(defaultProvider, id) }
  }

  // Anything else is treated as a key verbatim, e.g. `PROJ-123` or `local-7`.
  return { provider: defaultProvider, id: raw, key: raw.toLowerCase() }
}

/**
 * The prefix a provider uses in a human key.
 *
 * `github-42` and `gh-42` are the same ticket, and the transport, the claim registry and
 * the branch name all key on the short form. Deriving the key from the provider keeps a
 * numeric reference (`anvil claim 42 --provider github`) identical to the spelled-out one
 * (`anvil claim gh-42`), so a claim cannot end up under two keys.
 */
function keyPrefix(provider: ProviderId): string {
  if (provider === 'github') return 'gh'
  if (provider === 'gitlab') return 'gl'
  return provider
}

/**
 * The human key for a bare number under `provider`.
 *
 * Jira issue keys always carry a project prefix, so inventing `jira-42` would make a bare
 * number address the literal JIRA project. Keeping the number as the key lets the provider
 * refuse it as the ambiguous reference it is, before any write is made.
 */
function numericKey(provider: ProviderId, id: string): string {
  return provider === 'jira' ? id : `${keyPrefix(provider)}-${id}`
}

/** The repository a hosted ticket URL points at, independent of the forge. */
export interface TicketRepository {
  /** The host, without a scheme or port, e.g. `github.com` or `ghe.acme-corp.com`. */
  host: string
  /** `owner/repo` for GitHub, or the full group path for a GitLab subgroup. */
  path: string
}

interface TicketAddress {
  repository: TicketRepository
  id: string
}

/**
 * Split a hosted ticket URL into the repository it names and the issue number.
 *
 * The issue marker is found by scanning from the **end** for an `issues`/`pull` segment
 * followed by a number. Scanning from the start picks the wrong segment whenever the
 * repository itself is called `issues` or `pull` -- `github.com/acme/issues/issues/42`
 * used to yield the id `issues`, which then reached `gh issue view issues`. The number is
 * the last thing in the path that the marker can introduce, so the last match is the
 * right one.
 */
function parseTicketAddress(url: string): TicketAddress | null {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return null
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null
  const host = parsed.hostname.toLowerCase()
  const segments = parsed.pathname.split('/').filter((s) => s !== '')
  const safe = /^[A-Za-z0-9_.-]+$/

  let marker = -1
  for (let i = segments.length - 2; i >= 0; i--) {
    const segment = segments[i] as string
    if (segment !== 'issues' && segment !== 'pull') continue
    if (!/^\d+$/.test(segments[i + 1] ?? '')) continue
    marker = i
    break
  }
  if (marker < 2) return null

  // GitLab puts a `-` in front of its issue path (`group/project/-/issues/7`); it is a
  // separator in the URL, not part of the repository.
  const parts = segments.slice(0, marker).filter((s) => s !== '-' && s !== '')
  if (parts.length < 2 || !parts.every((s) => safe.test(s))) return null
  if (host === '') return null

  return {
    repository: { host, path: parts.join('/') },
    id: segments[marker + 1] as string,
  }
}

/**
 * A ticket address in GitHub's exact shape: `/<owner>/<repo>/issues|pull/<n>`.
 *
 * GitHub repositories are always two segments deep and an issue URL has nothing between
 * the repository and the marker (a trailing `/files` page is still that issue), so anything else -- a GitLab `/-/issues/` path, a
 * subgroup, a `tree/...` page that happens to end in `issues/42` -- is not a GitHub issue,
 * and must not be turned into a `--repo` argument.
 */
function githubTicketAddress(url: string): TicketAddress | null {
  const address = parseTicketAddress(url)
  if (address === null) return null
  let pathname: string
  try {
    pathname = new URL(url).pathname
  } catch {
    return null
  }
  const segments = pathname.split('/').filter((s) => s !== '')
  if (segments[2] !== 'issues' && segments[2] !== 'pull') return null
  if (`${segments[0]}/${segments[1]}` !== address.repository.path) return null
  return address
}

/**
 * The repository a ticket URL names, or null when the URL does not name one.
 *
 * Used to keep a pasted issue URL on its own repository: `gh --repo` for the transport,
 * and a repository-qualified closing keyword in the pull request body.
 */
export function repositoryOf(url: string | undefined): TicketRepository | null {
  if (url === undefined || url === '') return null
  return parseTicketAddress(url)?.repository ?? null
}

/** A hostname without a scheme, port, or path, for comparing a URL host to a known one. */
function normalizeHostName(host: string): string {
  return host
    .trim()
    .toLowerCase()
    .replace(/^[a-z][a-z0-9+.-]*:\/\//, '')
    .replace(/^[^@/]*@/, '')
    .replace(/\/.*$/, '')
    .replace(/:\d+$/, '')
}

/** A Jira issue key in a URL path. */
const JIRA_KEY = /^[A-Za-z][A-Za-z0-9_]*-[0-9]+$/

interface JiraTicketAddress {
  host: string
  key: string
}

/**
 * The Jira browse address a URL names: `/browse/<KEY>` on any host.
 *
 * Jira Cloud uses this shape, and so do most Server and Data Center deployments. Only the
 * *shape* is read here; whether the host is actually Jira is decided separately, so the
 * parser cannot turn an unrelated intranet page into a ticket just because its path has
 * "browse" in it.
 */
function jiraTicketAddress(url: string): JiraTicketAddress | null {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return null
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null
  const segments = parsed.pathname.split('/').filter((s) => s !== '')
  for (let i = segments.length - 2; i >= 0; i--) {
    if (segments[i] !== 'browse') continue
    const key = segments[i + 1] ?? ''
    if (!JIRA_KEY.test(key)) continue
    return { host: parsed.hostname.toLowerCase(), key: key.toUpperCase() }
  }
  return null
}

/**
 * Whether a host is recognisably Jira.
 *
 * Three signals, none of which needs the network: a Jira Cloud host (`*.atlassian.net`), the
 * long-standing convention of naming the tracker `jira.` something, or a site the caller
 * configured in `provider.jira.site`. An arbitrary company host is not guessed to be Jira
 * merely because the path looks right; `--provider jira` is how the user says so.
 */
function isKnownJiraHost(host: string, jiraSites: readonly (string | null | undefined)[] | undefined): boolean {
  const normalized = normalizeHostName(host)
  if (normalized.endsWith('.atlassian.net')) return true
  if (normalized.startsWith('jira.')) return true
  if (jiraSites === undefined) return false
  return jiraSites.some((candidate) => {
    if (candidate === null || candidate === undefined || candidate.trim() === '') return false
    return normalizeHostName(candidate) === normalized
  })
}

/**
 * Whether a URL host is one of the GitHub hosts the caller already knows.
 *
 * Provider inference stays pure and offline: the CLI supplies the host it detected from
 * `origin` (or `GH_HOST`), and this function only compares. An arbitrary unknown host is
 * never assumed to be GitHub -- a ticket link on a company's intranet may be anything.
 */
function isKnownGithubHost(host: string, githubHosts: readonly (string | null | undefined)[] | undefined): boolean {
  if (githubHosts === undefined) return false
  const wanted = normalizeHostName(host)
  return githubHosts.some((candidate) => {
    if (candidate === null || candidate === undefined || candidate.trim() === '') return false
    return normalizeHostName(candidate) === wanted
  })
}

function parseTicketUrl(
  url: string,
  githubHosts?: readonly (string | null | undefined)[],
  jiraSites?: readonly (string | null | undefined)[],
): TicketRef | null {
  const jira = jiraTicketAddress(url)
  if (jira !== null && isKnownJiraHost(jira.host, jiraSites)) {
    return { provider: 'jira', id: jira.key, key: jira.key, url }
  }

  const address = parseTicketAddress(url)
  if (address === null) return null
  // The provider is decided by the host, so a GHE URL still names no provider rather than
  // being read as GitHub against the public host. A host the caller already knows to be
  // this checkout's GitHub host (including GH_HOST) is treated as GitHub without any I/O
  // here; a host nobody named is not guessed.
  //
  // Only a URL in GitHub's exact issue shape can be GitHub: a GitLab `/-/issues/` path on
  // a host that is also this checkout's origin is still a GitLab issue.
  const github = githubTicketAddress(url)
  if (address.repository.host.includes('gitlab')) {
    return { provider: 'gitlab', id: address.id, key: `gl-${address.id}`, url }
  }
  if (github === null) return null
  if (address.repository.host.includes('github') || isKnownGithubHost(address.repository.host, githubHosts)) {
    return { provider: 'github', id: github.id, key: `gh-${github.id}`, url }
  }
  return null
}

/** Render a ticket ref for a human. */
export function formatRef(ref: TicketRef): string {
  return ref.url === undefined ? ref.key : `${ref.key} (${ref.url})`
}
