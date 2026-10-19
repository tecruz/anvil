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
import { type FetchImpl, requestJson } from './transport.ts'

export type DiscoverySource = 'github-search' | 'mcp-registry' | 'local-scan' | 'cache'

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

async function defaultGh(args: string[], cwd: string): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const res = await runProcess('gh', args, { cwd })
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
 * Which playbook section a repo belongs in, from its name and description.
 *
 * The order is fixed and the first match wins, so the result is a function of the seeds
 * alone rather than of map iteration order. `mcp` is checked first because an MCP server
 * that also calls itself a skill should land in `mcp`, which is the more specific claim.
 */
export function sectionFor(repo: Pick<SearchResult, 'fullName' | 'description'>): LiveResource['section'] {
  const haystack = `${repo.fullName} ${repo.description ?? ''}`.toLowerCase()
  if (/\bmcp\b/.test(haystack)) return 'mcp'
  if (/skill/.test(haystack)) return 'skills'
  if (/\bagent\b|\bcli\b|assistant|copilot|opencode|claude/.test(haystack)) return 'agents'
  return 'community'
}

/**
 * True when a repo is agent tooling at all, rather than any repo that mentions the topic.
 *
 * A search for `android cli` returns Android CLI *tools*, not agent tooling for Android,
 * and offering those would put "an APK signer" in a plan whose job is agent guidance.
 */
export function isAgentTooling(repo: Pick<SearchResult, 'fullName' | 'description'>): boolean {
  const haystack = `${repo.fullName} ${repo.description ?? ''}`.toLowerCase()
  return /agent|skill|\bmcp\b|copilot|claude|opencode|toolkit|assistant/.test(haystack)
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

function parseSearchResponse(body: string): SearchResult[] | null {
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
  return out
}

type SearchOutcome = { results: SearchResult[]; via: 'gh' | 'api'; detail: string }

/**
 * Search GitHub for one query.
 *
 * `null` means "could not ask", which callers report as a warning. The empty array is a real
 * answer -- the query ran and matched nothing -- and conflating the two is how a broken
 * transport becomes an apparently-complete empty result.
 */
export async function searchGitHub(query: string, options: DiscoverOptions): Promise<SearchOutcome | null> {
  const perQuery = options.perQuery ?? DEFAULT_RESULTS_PER_QUERY

  if (options.gh !== undefined || (await ghIsInstalled())) {
    const run = options.gh ?? defaultGh
    const res = await run(
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
    )
    if (res.exitCode === 0) {
      const parsed = parseSearchResponse(res.stdout)
      if (parsed !== null) {
        return { results: parsed, via: 'gh', detail: `gh api search, ${String(parsed.length)} result(s)` }
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
 * and a broken gh should fall through to REST rather than fail the run.
 */
let ghInstalled: boolean | null = null
async function ghIsInstalled(): Promise<boolean> {
  if (ghInstalled !== null) return ghInstalled
  const res = await runProcess('gh', ['--version'], { cwd: '.' })
  ghInstalled = res.exitCode === 0
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
  return { results: parsed, via: 'api', detail: `api.github.com, ${authNote}, ${String(parsed.length)} result(s)` }
}

/** One repo, classified official or community, with a `why` that names the evidence. */
function classifyRepo(
  repo: SearchResult,
  seeds: DiscoverSeeds,
  source: DiscoverySource,
  fetchedAt: string,
): DiscoveryEntry {
  const official = isOfficialOrg(repo.owner, seeds)
  const description = repo.description ?? 'No description on the repository.'
  const evidence = official
    ? ` Published by ${repo.owner}, one of this playbook's official orgs.`
    : ` ${String(repo.stars)} star(s) on GitHub; found by repository search.`
  return {
    label: repo.fullName,
    url: repo.url,
    why: `${description}${evidence}`,
    tier: official ? 'official' : 'community',
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
    sources.push({ source: 'github-search', detail: 'skipped, offline', entries: 0 })
    return { playbookId, entries, sources, warnings }
  }

  const perQuery = options.perQuery ?? DEFAULT_RESULTS_PER_QUERY
  // Keyed by full name: two keywords finding one repo is one entry, not two identical
  // suggestions in the plan.
  const found = new Map<string, SearchResult>()
  const queries = queriesFor(seeds)
  let detail = ''
  let failures = 0

  for (const query of queries) {
    const outcome = await searchGitHub(query, { ...options, perQuery })
    if (outcome === null) {
      failures++
      continue
    }
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
    sources.push({ source: 'github-search', detail: 'no transport available', entries: 0 })
  } else {
    sources.push({ source: 'github-search', detail, entries: agentish.length })
    if (agentish.length === 0) {
      warnings.push(`${playbookId}: GitHub answered, but nothing matching these seeds is agent tooling`)
    }
  }

  return { playbookId, entries, sources, warnings }
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
