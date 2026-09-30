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

/** Parse a user-supplied ref: `42`, `#42`, `gh-42`, `PROJ-123`, or a full URL. */
export function parseRef(input: string, defaultProvider: ProviderId = 'local'): TicketRef {
  const raw = input.trim()

  // A URL carries its own provider, and is worth honouring: pasting a ticket link is the
  // most natural thing a user can do.
  const url = /^(https?:\/\/[^\s]+)$/.exec(raw)
  if (url !== null) {
    const parsed = parseTicketUrl(raw)
    if (parsed !== null) return parsed
  }

  const hash = /^#(\d+)$/.exec(raw)
  if (hash !== null) {
    const id = hash[1] as string
    return { provider: defaultProvider, id, key: `${defaultProvider}-${id}` }
  }

  const prefixed = /^([A-Za-z][\w-]*?)-(\d+)$/.exec(raw)
  if (prefixed !== null) {
    const prefix = prefixed[1] as string
    const id = prefixed[2] as string
    return {
      provider: defaultProvider,
      id,
      key: `${prefix.toLowerCase()}-${id}`,
    }
  }

  const numeric = /^(\d+)$/.exec(raw)
  if (numeric !== null) {
    const id = numeric[1] as string
    return { provider: defaultProvider, id, key: `${defaultProvider}-${id}` }
  }

  // Anything else is treated as a key verbatim, e.g. `PROJ-123` or `local-7`.
  return { provider: defaultProvider, id: raw, key: raw.toLowerCase() }
}

function parseTicketUrl(url: string): TicketRef | null {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return null
  }
  const host = parsed.hostname.toLowerCase()
  const segments = parsed.pathname.split('/').filter((s) => s !== '')

  // github.com/<owner>/<repo>/issues/<n>
  if (host.includes('github')) {
    const idx = segments.findIndex((s) => s === 'issues' || s === 'pull')
    if (idx !== -1 && segments[idx + 1] !== undefined) {
      const id = segments[idx + 1] as string
      return { provider: 'github', id, key: `gh-${id}`, url }
    }
    return null
  }
  // gitlab.com/<group>/<project>/-/issues/<n>
  if (host.includes('gitlab')) {
    const idx = segments.indexOf('-')
    if (idx !== -1 && segments[idx + 1] === 'issues' && segments[idx + 2] !== undefined) {
      const id = segments[idx + 2] as string
      return { provider: 'gitlab', id, key: `gl-${id}`, url }
    }
    return null
  }
  return null
}

/** Render a ticket ref for a human. */
export function formatRef(ref: TicketRef): string {
  return ref.url === undefined ? ref.key : `${ref.key} (${ref.url})`
}
