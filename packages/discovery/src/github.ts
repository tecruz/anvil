/**
 * GitHub discovery: repository search, and the classification that follows it.
 *
 * `gh` first, because it already solves the parts that go wrong. Authentication refresh,
 * GitHub Enterprise hosts, enterprise proxy configuration -- all of it is `gh`'s problem
 * and none of it is the discovery layer's, and reimplementing a login flow is exactly the
 * work `providers/src/github.ts` says anvil should not do. The documented precedent is
 * also there: `gh` rather than raw REST because anvil's value is the workflow.
 *
 * The fallback exists for the same reason `runProcess` tolerates a missing binary: on a
 * machine without `gh`, discovery should still work, less well. GitHub's unauthenticated
 * search allowance is 10 requests a minute, which is enough for one playbook's keywords and
 * not enough for a full sweep -- so the fallback reports what it is and how much room it
 * has, rather than silently returning a truncated list that reads like a complete one.
 *
 * Every call goes through `execFile` with an argument array via `runProcess`. Keywords come
 * from a playbook file, which is data anvil installs from a URL, so they are untrusted
 * input and a shell would be an injection.
 */

import { runProcess } from '@anvil/core'
import { communityConfidence, type DiscoverSeeds, type LiveResource } from '@anvil/playbooks'
import { defaultTimeoutMs, type FetchImpl, requestJson } from './transport.ts'

export type DiscoverySource = 'github-search' | 'mcp-registry' | 'local-scan' | 'cache'

/**
 * Who vouches for an entry, kept separate from the ranking tier.
 *
 * The tier says how *useful* an entry is; trust says who stands behind it, and the two are
 * not the same claim. A skill installed in `~/.agents/skills` is useful and worth listing,
 * but the file on disk proves only that someone installed it -- not that the technology's
 * maintainers wrote it. Folding that into `tier: official` reads as "first-party" and is
 * false, so the publisher evidence gets its own field.
 */
export type DiscoveryTrust = 'official-publisher' | 'local-install' | 'third-party'

/**
 * The subset of `gh` this module uses. Injected so no test shells out.
 *
 * The live suite exists because of a defect this seam could not catch: a mocked runner
 * accepts any argv, so a wrong flag passes against a fake and fails against real `gh`.
 * `ANVIL_LIVE=1 npm run test:live` is where the argv shape gets checked against the real
 * binary.
 */
export type GhRun = (args: string[], cwd: string) => Promise<{ stdout: string; stderr: string; exitCode: number }>

export interface SearchResult {
  /** `owner/name`. */
  fullName: string
  owner: string
  url: string
  description: string | null
  stars: number
  /** True when GitHub says the owner is an organization rather than a person. */
  isOrg: boolean
}

export interface DiscoveryEntry {
  label: string
  url: string
  why: string
  tier: 'official' | 'community'
  /**
   * Who vouches for it: the technology's orgs, this machine, or nobody in particular.
   *
   * Optional because caches and fixtures written before the field existed still load. Every
   * producer in this package sets it; a reader that finds it absent must fall back to the
   * source rather than assume a publisher.
   */
  trust?: DiscoveryTrust
  section: LiveResource['section']
  source: DiscoverySource
  fetchedAt: string
  stars: number | null
  install: string | null
  /** `owner/name`, when the entry is repo-shaped. */
  repo: string | null
  /** Owner login, when the entry is repo-shaped. */
  owner: string | null
}

export interface DiscoverOptions {
  fetchImpl: FetchImpl
  /** Injected gh runner. Omit to shell out. */
  gh?: GhRun
  /** Token for the REST fallback. Defaults to the environment. */
  token?: string | undefined
  /** Repository results per query. */
  perQuery?: number
  timeoutMs?: number
  /** Set false to skip network sources entirely. */
  online?: boolean
  cwd: string
}

export interface SourceNote {
  source: DiscoverySource
  /** What the source produced, or why it produced nothing. */
  detail: string
  entries: number
  /**
   * Whether the source answered at all.
   *
   * The difference between "answered, and found nothing" and "could not be asked" is the
   * difference between a fact and an absence, and the detail string alone cannot carry it
   * safely. It is also what decides whether the source's previous answers survive a refresh:
   * a source that could not be reached must not erase what it contributed last time.
   */
  answered: boolean
  /**
   * Whether *every* query this source was asked answered.
   *
   * Optional, and absent means the same as `answered`, so notes written before the field
   * existed are still complete. A source can answer some queries and fail others -- an org
   * search succeeds while a keyword search times out -- and that is answered without being
   * complete. The distinction matters twice: a partial source must not replace all of its
   * previous entries, and a cache built from it must not be reused as a whole answer.
   */
  complete?: boolean
}

export interface PlaybookDiscovery {
  playbookId: string
  entries: DiscoveryEntry[]
  sources: SourceNote[]
  /** Non-fatal problems: a source that could not be reached. */
  warnings: string[]
}

export interface DiscoveryReport {
  fetchedAt: string
  playbooks: PlaybookDiscovery[]
  warnings: string[]
}

const DEFAULT_RESULTS_PER_QUERY = 8

/**
 * Max queries run per playbook.
 *
 * A seed list is authored data and an untrusted one -- `playbook add` installs YAML from a
 * URL -- so it cannot be trusted to stay short. The cap is what keeps a hundred keywords
 * from spending a hundred minutes of an authenticated rate limit.
 */
const MAX_QUERIES = 6

/**
 * The live official cap. Mirrors `plan.ts` so both sides of the merge rank the same claim
 * alike; the constant is repeated rather than imported because `plan.ts` reaches into
 * `@anvil/audit` and `@anvil/profile`, and pulling that into a leaf package to save one
 * number would couple the two.
 */
const LIVE_OFFICIAL_CAP = 0.65

/**
 * How long a `gh` probe may take.
 *
 * `gh --version` is a local binary; a probe that has not returned in five seconds is not
 * going to. Kept below the request timeout so a broken install degrades to REST quickly.
 */
const GH_PROBE_TIMEOUT_MS = 5_000

async function defaultGh(
  args: string[],
  cwd: string,
  timeoutMs: number = defaultTimeoutMs,
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  // The HTTP path has always been bounded; the preferred transport was not. A hung `gh`
  // (a blocked network, an unresponsive enterprise proxy) made automatic enrichment wait
  // forever, and the user cannot tell that apart from a tool that is thinking.
  const res = await runProcess('gh', args, { cwd, timeoutMs })
  return { stdout: res.stdout, stderr: res.stderr, exitCode: res.exitCode }
}

/**
 * Confidence for a discovered entry.
 *
 * Official discovery is capped below curated official guidance (0.7) because the org check
 * is a seed list that can be wrong and nobody reviewed the entry. Community discovery
 * reuses the curated star ladder one notch down, so "widely starred" means the same thing
 * on both sides of the merge.
 */
export function liveConfidence(entry: DiscoveryEntry): number {
  if (entry.tier === 'official') return LIVE_OFFICIAL_CAP
  const ladder = communityConfidence({ stars: entry.stars })
  return Math.max(0.3, Number((ladder - 0.05).toFixed(2)))
}

/** True when `owner` is one of the playbook's seeded official orgs. Case-insensitive. */
export function isOfficialOrg(owner: string, seeds: DiscoverSeeds): boolean {
  const lower = owner.toLowerCase()
  return seeds.officialOrgs.some((org) => org.toLowerCase() === lower)
}

/**
 * The GitHub repository a URL points at, when it points at one.
 *
 * The MCP registry publishes one URL per server, and that URL is sometimes a repository and
 * sometimes a running endpoint. The org check needs a login, so it can only be applied to
 * the first kind: without this, every registry entry was filed as community, and the
 * server published by the technology's own org was filed alongside a stranger's.
 *
 * Returns null for anything that is not a GitHub repository URL, which is the answer the
 * caller needs for the endpoint case: no owner, so no claim.
 */
export function ownerFromGitHubUrl(url: string): { owner: string; repo: string } | null {
  const trimmed = url.trim()
  if (trimmed === '') return null
  let parsed: URL
  try {
    parsed = new URL(trimmed.includes('://') ? trimmed : `https://${trimmed}`)
  } catch {
    return null
  }
  if (parsed.hostname.toLowerCase() !== 'github.com') return null
  const parts = parsed.pathname.split('/').filter((part) => part !== '')
  const owner = parts[0] ?? ''
  const repo = (parts[1] ?? '').replace(/\.git$/, '')
  if (owner === '' || repo === '') return null
  return { owner, repo }
}

/**
 * How much of a repository description is read when classifying it.
 *
 * A GitHub description is normally a sentence. Nothing stops a maintainer from pasting tens
 * of thousands of characters into it, and reading all of it let a repository that merely
 * mentioned `agent` 33,000 characters into a catch-all description pass the agent-tooling
 * filter -- and then drag that whole description into the plan. The repository name and the
 * head of the description are what a reader takes as the summary of what a project is.
 */
const DESCRIPTION_CHARS = 1000

/** The name and the head of the description, lowercased, for sectioning and tooling checks. */
function classifyText(repo: Pick<SearchResult, 'fullName' | 'description'>): string {
  return `${repo.fullName} ${descriptionHead(repo.description)}`.toLowerCase()
}

/** The head of a description, empty when there is none, without a word cut by the bound. */
function descriptionHead(description: string | null): string {
  const text = description ?? ''
  if (text.length <= DESCRIPTION_CHARS) return text
  const head = text.slice(0, DESCRIPTION_CHARS)
  const cut = /[a-z0-9]/i.test(text[DESCRIPTION_CHARS] ?? '')
  return cut ? `${head.replace(/[a-z0-9]+$/i, '')}…` : `${head}…`
}

/**
 * Which playbook section a repo belongs in, from its name and description.
 *
 * The order is fixed and the first match wins, so the result is a function of the seeds
 * alone rather than of map iteration order. `mcp` is checked first because an MCP server
 * that also calls itself a skill should land in `mcp`, which is the more specific claim.
 */
export function sectionFor(repo: Pick<SearchResult, 'fullName' | 'description'>): LiveResource['section'] {
  const haystack = classifyText(repo)
  if (/\bmcp\b/.test(haystack)) return 'mcp'
  if (/skill/.test(haystack)) return 'skills'
  if (/\bagent\b|\bcli\b|assistant|copilot|opencode|claude/.test(haystack)) return 'agents'
  return 'community'
}

/**
 * True when a repo is agent tooling at all, rather than any repo that mentions the topic.
 *
 * A search for `android cli` returns Android CLI *tools*, not agent tooling for Android,
 * and offering those would put "an APK signer" in a plan whose job is agent guidance. The
 * tooling keyword must appear in the name or the head of the description, not tens of
 * thousands of characters into a catch-all blurb.
 */
export function isAgentTooling(repo: Pick<SearchResult, 'fullName' | 'description'>): boolean {
  return /agent|skill|\bmcp\b|copilot|claude|opencode|toolkit|assistant/.test(classifyText(repo))
}

/**
 * Build the queries a playbook's seeds imply.
 *
 * Official orgs first: a repo published by the org that speaks for the technology is the
 * most valuable thing to find, and it is the cheapest query to answer.
 */
export function queriesFor(seeds: DiscoverSeeds): string[] {
  const out: string[] = []
  for (const org of seeds.officialOrgs) out.push(`org:${org} (agent OR skills OR mcp OR cli)`)
  for (const keyword of seeds.keywords) out.push(keyword)
  return out.slice(0, MAX_QUERIES)
}

const SEARCH_ENDPOINT = 'https://api.github.com/search/repositories'

interface RawSearchItem {
  full_name?: unknown
  html_url?: unknown
  description?: unknown
  stargazers_count?: unknown
  owner?: { login?: unknown; type?: unknown }
}

interface SearchPage {
  results: SearchResult[]
  /**
   * GitHub's own admission that it timed out before searching everything.
   *
   * `incomplete_results: true` means the list is real but not the whole answer. Treating it
   * as complete wrote a truncated list into the cache as a finished answer, and the next
   * week's plan could not tell that a query had been cut short.
   */
  incomplete: boolean
}

function parseSearchResponse(body: string): SearchPage | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(body)
  } catch {
    return null
  }
  const items = (parsed as { items?: unknown }).items
  if (!Array.isArray(items)) return null
  const out: SearchResult[] = []
  for (const raw of items) {
    const item = raw as RawSearchItem
    const fullName = typeof item.full_name === 'string' ? item.full_name : ''
    const slash = fullName.indexOf('/')
    if (slash < 1) continue
    const owner = fullName.slice(0, slash)
    const htmlUrl = typeof item.html_url === 'string' ? item.html_url : ''
    out.push({
      fullName,
      owner,
      url: htmlUrl === '' ? `https://github.com/${fullName}` : htmlUrl,
      description: typeof item.description === 'string' ? item.description : null,
      stars: typeof item.stargazers_count === 'number' ? item.stargazers_count : 0,
      isOrg: item.owner?.type === 'Organization',
    })
  }
  return { results: out, incomplete: (parsed as { incomplete_results?: unknown }).incomplete_results === true }
}

type SearchOutcome = { results: SearchResult[]; incomplete: boolean; via: 'gh' | 'api'; detail: string }

/**
 * Bound a `gh` invocation, including an injected one.
 *
 * `defaultGh` passes the timeout to `runProcess` so the child is killed. This guard is the
 * outer half: a test (or an enterprise `gh` wrapper) that never settles is raced against the
 * same bound, so a broken transport becomes "gh declined" and falls through to REST instead
 * of holding the enrichment open indefinitely.
 */
async function withGhTimeout<T>(work: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`gh did not answer within ${String(timeoutMs)}ms`)), timeoutMs)
  })
  try {
    return await Promise.race([work, timeout])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

/**
 * Search GitHub for one query.
 *
 * `null` means "could not ask", which callers report as a warning. The empty array is a real
 * answer -- the query ran and matched nothing -- and conflating the two is how a broken
 * transport becomes an apparently-complete empty result.
 */
export async function searchGitHub(query: string, options: DiscoverOptions): Promise<SearchOutcome | null> {
  const perQuery = options.perQuery ?? DEFAULT_RESULTS_PER_QUERY
  const timeoutMs = options.timeoutMs ?? defaultTimeoutMs

  if (options.gh !== undefined || (await ghIsInstalled(timeoutMs))) {
    const run: GhRun = options.gh ?? ((args, cwd) => defaultGh(args, cwd, timeoutMs))
    let res: { stdout: string; stderr: string; exitCode: number }
    try {
      res = await withGhTimeout(
        run(
          [
            'api',
            '-X',
            'GET',
            'search/repositories',
            '-f',
            `q=${query}`,
            '-f',
            'sort=stars',
            '-f',
            'order=desc',
            '-f',
            `per_page=${String(perQuery)}`,
          ],
          options.cwd,
        ),
        timeoutMs,
      )
    } catch {
      // gh is present but could not be run at all -- a broken shim, an argument cmd.exe
      // refuses on an untrusted seed, or a timeout. That is "gh is unavailable" by another
      // name, so fall to the API rather than aborting a discovery run whose other sources
      // still work.
      return searchViaApi(query, perQuery, options)
    }
    if (res.exitCode === 0) {
      const parsed = parseSearchResponse(res.stdout)
      if (parsed !== null) {
        return {
          results: parsed.results,
          incomplete: parsed.incomplete,
          via: 'gh',
          detail: `gh api search, ${String(parsed.results.length)} result(s)${parsed.incomplete ? ', incomplete' : ''}`,
        }
      }
      return null
    }
    // gh is installed but declined -- an expired token, or a host it is not authenticated
    // to. Falling through to REST is right: that should cost the better rate limit, not
    // the results. The gh failure is carried into the detail so the report can say why.
    const ghDetail = res.stderr.trim().split('\n')[0] ?? `exit ${String(res.exitCode)}`
    const fallback = await searchViaApi(query, perQuery, options)
    if (fallback !== null) return { ...fallback, detail: `${fallback.detail}; gh declined (${ghDetail})` }
    return null
  }

  return searchViaApi(query, perQuery, options)
}

/**
 * Whether `gh` is on PATH.
 *
 * Cached per process: it cannot change mid-run, and probing per query would spawn a process
 * per seed for a fact that is fixed for the whole command. `gh --version` is the cheapest
 * command that proves the binary runs -- a PATH lookup proves only that the file exists,
 * and a broken gh should fall through to REST rather than fail the run. The probe is bounded
 * too: an install that hangs on `--version` must not hang the whole discovery run.
 */
let ghInstalled: boolean | null = null
async function ghIsInstalled(timeoutMs: number): Promise<boolean> {
  if (ghInstalled !== null) return ghInstalled
  try {
    const res = await runProcess('gh', ['--version'], {
      cwd: '.',
      timeoutMs: Math.min(timeoutMs, GH_PROBE_TIMEOUT_MS),
    })
    ghInstalled = res.exitCode === 0
  } catch {
    // `runProcess` throws ToolMissing when the binary is absent -- the exact case this probe
    // exists to detect -- and throws on a timeout. A missing or hung gh is a fallback to the
    // REST API, not a failed run, and a probe that propagated would abort every `plan` on a
    // machine the README supports.
    ghInstalled = false
  }
  return ghInstalled
}

/** The direct API path, token or anonymous. */
async function searchViaApi(query: string, perQuery: number, options: DiscoverOptions): Promise<SearchOutcome | null> {
  const url = `${SEARCH_ENDPOINT}?q=${encodeURIComponent(`${query} sort:stars`)}&sort=stars&order=desc&per_page=${String(perQuery)}`
  const token = options.token ?? process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN ?? ''
  const res = await requestJson(url, {
    fetchImpl: options.fetchImpl,
    ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
    ...(token === '' ? {} : { headers: { authorization: `Bearer ${token}` } }),
  })
  if (res.transportError !== undefined) return null
  // 403 covers GitHub's secondary rate limit, 429 the primary. Both are "not now", not
  // "never", and neither is a reason to report the playbook as having no results.
  if (res.status !== 200) return null
  const parsed = parseSearchResponse(res.body)
  if (parsed === null) return null
  const authNote = token === '' ? 'anonymous (10 req/min)' : 'authenticated'
  return {
    results: parsed.results,
    incomplete: parsed.incomplete,
    via: 'api',
    detail: `api.github.com, ${authNote}, ${String(parsed.results.length)} result(s)${
      parsed.incomplete ? ', incomplete' : ''
    }`,
  }
}

/** One repo, classified official or community, with a `why` that names the evidence. */
function classifyRepo(
  repo: SearchResult,
  seeds: DiscoverSeeds,
  source: DiscoverySource,
  fetchedAt: string,
): DiscoveryEntry {
  const official = isOfficialOrg(repo.owner, seeds)
  const description =
    repo.description === null ? 'No description on the repository.' : descriptionHead(repo.description)
  const evidence = official
    ? ` Published by ${repo.owner}, one of this playbook's official orgs.`
    : ` ${String(repo.stars)} star(s) on GitHub; found by repository search.`
  return {
    label: repo.fullName,
    url: repo.url,
    why: `${description}${evidence}`,
    tier: official ? 'official' : 'community',
    trust: official ? 'official-publisher' : 'third-party',
    // A community repo is always community guidance, whatever it is about. Reclassifying it
    // into `official.mcp` would assert the project maintains it, which the org check just
    // said it does not.
    section: official ? sectionFor(repo) : 'community',
    source,
    fetchedAt,
    stars: repo.stars,
    install: null,
    repo: repo.fullName,
    owner: repo.owner,
  }
}

/**
 * Run every network source for one playbook and classify what comes back.
 *
 * Sources are independent: a failure of one never removes another's results, which is what
 * lets `--local-only` be a real answer rather than a degraded one.
 */
export async function discover(
  playbookId: string,
  seeds: DiscoverSeeds,
  options: DiscoverOptions,
): Promise<PlaybookDiscovery> {
  const fetchedAt = new Date().toISOString()
  const sources: SourceNote[] = []
  const warnings: string[] = []
  const entries: DiscoveryEntry[] = []

  if (options.online === false) {
    sources.push({ source: 'github-search', detail: 'skipped, offline', entries: 0, answered: false })
    return { playbookId, entries, sources, warnings }
  }

  const perQuery = options.perQuery ?? DEFAULT_RESULTS_PER_QUERY
  // Keyed by full name: two keywords finding one repo is one entry, not two identical
  // suggestions in the plan.
  const found = new Map<string, SearchResult>()
  const queries = queriesFor(seeds)
  let detail = ''
  let failures = 0
  let incompleteQueries = 0

  for (const query of queries) {
    const outcome = await searchGitHub(query, { ...options, perQuery })
    if (outcome === null) {
      failures++
      continue
    }
    if (outcome.incomplete) incompleteQueries++
    if (detail === '') detail = `${outcome.via}: ${outcome.detail}`
    for (const r of outcome.results) {
      if (!found.has(r.fullName)) found.set(r.fullName, r)
    }
  }

  const agentish = [...found.values()].filter(isAgentTooling)
  for (const repo of agentish) entries.push(classifyRepo(repo, seeds, 'github-search', fetchedAt))

  if (failures === queries.length) {
    warnings.push(
      `${playbookId}: no transport could reach GitHub (gh unavailable, no token, or the network is blocked)`,
    )
    sources.push({ source: 'github-search', detail: 'no transport available', entries: 0, answered: false })
  } else {
    // A source with several queries can be partly answered: the org search succeeded and the
    // keyword search was rate-limited, or GitHub itself timed out and returned
    // `incomplete_results`. `answered` stays true -- some results are real -- but `complete`
    // records that the source did not have its whole say, so a cache written from this run
    // is not presented as a finished answer.
    const complete = failures === 0 && incompleteQueries === 0
    const partialReasons: string[] = []
    if (failures > 0) partialReasons.push(`${String(failures)} of ${String(queries.length)} queries failed`)
    if (incompleteQueries > 0) {
      partialReasons.push(
        `${String(incompleteQueries)} of ${String(queries.length)} queries returned incomplete results`,
      )
    }
    const partial = complete ? detail : `${detail}; ${partialReasons.join('; ')}`
    sources.push({
      source: 'github-search',
      detail: partial,
      entries: agentish.length,
      answered: true,
      complete,
    })
    if (failures > 0) {
      warnings.push(
        `${playbookId}: GitHub answered ${String(queries.length - failures)} of ${String(queries.length)} queries; the rest could not be reached`,
      )
    }
    if (incompleteQueries > 0) {
      warnings.push(
        `${playbookId}: GitHub returned incomplete results for ${String(incompleteQueries)} of ${String(queries.length)} queries; the cache will be marked partial`,
      )
    }
    if (agentish.length === 0) {
      warnings.push(`${playbookId}: GitHub answered, but nothing matching these seeds is agent tooling`)
    }
  }

  return { playbookId, entries, sources, warnings }
}

/**
 * Whether every remote source a playbook asks has answered.
 *
 * A playbook asks GitHub when it declares an org or a keyword, and the MCP registry when it
 * declares an mcp term. This is the per-source merge's question turned around: a run in which
 * an asked source did not answer is partial, and a cache built from it must not be presented
 * as a complete one. A missing half is exactly what the next fetch is for.
 */
export function remoteSourcesAnswered(seeds: DiscoverSeeds, sources: readonly SourceNote[]): boolean {
  // Complete, not merely answered: a source that ran two queries and failed one has not
  // finished answering, and a cache built from it is missing exactly the half that failed.
  const complete = (source: SourceNote['source']): boolean => {
    const notes = sources.filter((note) => note.source === source)
    return notes.length > 0 && notes.every((note) => note.answered && note.complete !== false)
  }
  if ((seeds.officialOrgs.length > 0 || seeds.keywords.length > 0) && !complete('github-search')) return false
  if (seeds.mcp.length > 0 && !complete('mcp-registry')) return false
  return true
}

/** Discover every playbook that declares seeds, in id order for a stable report. */
export async function discoverAll(
  playbooks: ReadonlyArray<{ id: string; discover: DiscoverSeeds }>,
  options: DiscoverOptions,
): Promise<DiscoveryReport> {
  const fetchedAt = new Date().toISOString()
  const withSeeds = playbooks
    .filter((p) => p.discover.officialOrgs.length > 0 || p.discover.keywords.length > 0 || p.discover.mcp.length > 0)
    .sort((a, b) => a.id.localeCompare(b.id))

  const results: PlaybookDiscovery[] = []
  for (const p of withSeeds) {
    results.push(await discover(p.id, p.discover, options))
  }
  return {
    fetchedAt,
    playbooks: results,
    warnings: results.flatMap((r) => r.warnings),
  }
}
