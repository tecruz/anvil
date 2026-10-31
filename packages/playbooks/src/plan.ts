/**
 * The plan: turn a readiness report plus the matched playbooks into a ranked to-do list.
 *
 * Three tiers, in the order the plan document defines them:
 *
 *   derived    -- from this repository's own facts. Highest confidence, because nothing
 *                 outside the repo was consulted.
 *   official   -- the technology's own documentation, skills and MCP servers. High
 *                 confidence, but a reader still has to know *when* to reach for them.
 *   community  -- well-known third-party resources. Useful, and ranked below official
 *                 because "widely accepted" is a weaker claim than "maintained by the
 *                 project".
 *
 * Ranking is by (tier, confidence, severity) rather than severity alone, because the
 * document's point is that a repo which scores badly usually needs several cheap derived
 * fixes before any amount of external guidance helps.
 */

import type { Finding, ReadinessReport } from '@anvil/audit'
import { matchesAny, matchesGlob, type ProjectProfile } from '@anvil/profile'
import type { MatchResult } from './match.ts'
import type { LiveResource, Playbook, Resource } from './schema.ts'

export type PlanTier = 'derived' | 'official' | 'community'

/** Who vouches for a resource, as opposed to which tier it ranks in. */
export type SuggestionTrust = 'official-publisher' | 'local-install' | 'third-party'

/** Short, unambiguous label for a trust value, for terminals and context bundles. */
export function trustLabel(trust: SuggestionTrust): string {
  if (trust === 'official-publisher') return 'official publisher'
  if (trust === 'local-install') return 'installed locally'
  return 'third party'
}

/** How to build the plan. */
export interface PlanOptions {
  /**
   * Keep suggestions the repository already satisfies.
   *
   * Off by default: the plan is a list of what to do next, and a repository that already
   * follows the guidance has nothing to do about it. The count of what was left out is
   * still reported, so the omission is visible rather than silent.
   */
  includeSatisfied?: boolean
}

export interface Suggestion {
  /** Stable id for dedupe and for `--only <tier>` filtering. */
  id: string
  tier: PlanTier
  /** The finding that prompted this, when there is one. */
  rule?: string
  title: string
  detail: string
  /** `file:line` when the suggestion came from repo evidence. */
  evidence: string[]
  url?: string
  install?: string
  /** 0..1. Surfaced so a reader can judge the advice. */
  confidence: number
  /** The finding's severity, when derived from a finding. */
  severity?: Finding['severity']
  /** The playbook that supplied this, for official/community entries. */
  playbook?: string
  /**
   * Who vouches for a resource, kept apart from the tier.
   *
   * Absent on derived fixes: those come from this repository's own facts, so there is no
   * outside publisher to name. `official-publisher` means the technology's own orgs publish
   * it; `local-install` means it is on this machine and nothing more; `third-party` is
   * everyone else.
   */
  trust?: SuggestionTrust
  /**
   * True for an external resource: something to read, consult or install.
   *
   * Absent on a change to this repository -- a missing verify command, a high-risk glob.
   * The worktree shortlist wants only the former, because "add a lint command" is work, not
   * reading, and offering it as an aid invites an agent to skip it. Derived fixes carry no
   * playbook and no `external`, so they are excluded on both counts.
   */
  external?: boolean
  /**
   * Where the guidance came from.
   *
   * `curated` is a playbook a human wrote and a reviewer read. `live` was fetched at
   * runtime and is capped below curated confidence, so the reader can see which is which
   * rather than having to infer it from a number.
   */
  provenance: 'curated' | 'live'
  /** When the live fetch happened. Absent on curated entries. */
  fetchedAt?: string
}

export interface Plan {
  schemaVersion: 2
  score: number
  grade: ReadinessReport['grade']
  /** Playbooks that matched, with why. */
  playbooks: Array<{
    id: string
    title: string
    confidence: number
    reasons: string[]
  }>
  suggestions: Suggestion[]
  counts: Record<PlanTier, number>
  /**
   * Suggestions left out because the repository already satisfies them.
   *
   * The count is part of the contract because the omission is a decision, and a decision
   * the reader cannot see is one they cannot check. `--include-satisfied` prints them.
   */
  satisfied: number
  /** Anything that could not be loaded, so it is visible rather than silent. */
  warnings: string[]
}

const TIER_ORDER: Record<PlanTier, number> = {
  derived: 0,
  official: 1,
  community: 2,
}

const SEVERITY_ORDER: Record<Finding['severity'], number> = {
  blocker: 0,
  high: 1,
  medium: 2,
  low: 3,
  info: 4,
}

export function buildPlan(
  report: ReadinessReport,
  profile: ProjectProfile,
  matches: readonly MatchResult[],
  warnings: readonly string[] = [],
  live: ReadonlyMap<string, readonly LiveResource[]> = new Map(),
  options: PlanOptions = {},
): Plan {
  const suggestions: Suggestion[] = []
  let satisfied = 0

  // Tier 1: derived. Every failing/warning finding that carries a fix.
  for (const finding of report.findings) {
    if (finding.status === 'pass' || finding.fix === null) continue
    const fix = finding.fix
    suggestions.push({
      id: `fix:${finding.id}`,
      tier: fix.origin,
      rule: finding.id,
      title: finding.title,
      detail: `${fix.summary} -- ${finding.detail}`,
      evidence: finding.evidence,
      severity: finding.severity,
      confidence: fix.confidence,
      provenance: 'curated',
      ...(fix.source?.url === undefined ? {} : { url: fix.source.url }),
    })
  }

  // Tiers 2 and 3: guidance from the matched playbooks.
  //
  // `matches` arrives sorted by priority, so the first playbook to claim a risk glob keeps
  // it. An Android repo matches both `jvm` and `android` and both declare
  // `**/build.gradle.kts`; without this the same advice appears twice, which reads as two
  // separate concerns rather than one.
  const claimedRiskGlobs = new Set<string>()
  const claimedUrls = new Set<string>()
  for (const match of matches) {
    const produced = playbookSuggestions(match.playbook, profile, claimedRiskGlobs, options)
    for (const suggestion of produced.suggestions) {
      // Collected as the curated suggestions are made, rather than in a second pass: a URL
      // is only claimed once a suggestion carrying it exists, and the two must not be able
      // to disagree.
      if (suggestion.url !== undefined) claimedUrls.add(normalizeUrl(suggestion.url))
      suggestions.push(suggestion)
    }
    satisfied += produced.satisfied
  }

  // Tier 4: live-discovered resources for the same playbooks, keyed by playbook id.
  //
  // Merged *after* the curated pass so a hand-written entry always wins a URL a fetch also
  // found. The alternative -- letting a live entry displace a curated one, because the
  // fetch happened to be fresher -- would make an audit's output depend on network state,
  // which is the opposite of what this file's output is for.
  for (const match of matches) {
    const entries = live.get(match.playbook.id)
    if (entries === undefined) continue
    for (const entry of entries) {
      // A local skill has no URL, so it cannot collide with a curated link; it is keyed by
      // its install path instead.
      if (entry.url.trim() !== '' && claimedUrls.has(normalizeUrl(entry.url))) continue
      claimedUrls.add(normalizeUrl(entry.url))
      suggestions.push(liveSuggestion(match.playbook.id, entry))
    }
  }

  const ranked = rankSuggestions(dedupe(suggestions))

  return {
    schemaVersion: 2,
    score: report.score,
    grade: report.grade,
    playbooks: matches.map((m) => ({
      id: m.playbook.id,
      title: m.playbook.title,
      confidence: Number(m.confidence.toFixed(2)),
      reasons: m.reasons.map((r) => `${r.kind}:${r.pattern} -> ${r.matched}`),
    })),
    suggestions: ranked,
    counts: {
      derived: ranked.filter((s) => s.tier === 'derived').length,
      official: ranked.filter((s) => s.tier === 'official').length,
      community: ranked.filter((s) => s.tier === 'community').length,
    },
    satisfied,
    warnings: [...warnings],
  }
}

/** Guidance a playbook contributes for a specific repo, not a generic resource dump. */
function playbookSuggestions(
  playbook: Playbook,
  profile: ProjectProfile,
  claimedRiskGlobs: Set<string>,
  options: PlanOptions,
): { suggestions: Suggestion[]; satisfied: number } {
  const out: Suggestion[] = []
  const base = { playbook: playbook.id }
  let satisfied = 0

  // A documented test command is only useful if the repo does not already have one, so
  // these are conditional rather than always-on.
  const missing = (kind: keyof typeof playbook.verify): boolean => {
    const commands = profile.commands[kind]
    return commands === undefined || commands.length === 0
  }

  for (const [kind, cmds] of Object.entries(playbook.verify)) {
    if (cmds.length === 0) continue
    if (!missing(kind as keyof typeof playbook.verify)) continue
    out.push({
      ...base,
      id: `verify:${playbook.id}:${kind}`,
      tier: 'official',
      title: `Add a ${kind} command for ${playbook.title}`,
      detail: `${playbook.title} projects conventionally use: ${cmds.join(' or ')}`,
      evidence: [playbook.source ?? playbook.id],
      confidence: 0.7,
      provenance: 'curated',
    })
  }

  // A risk glob is only worth mentioning when the repo actually has something matching it.
  //
  // This is the single biggest source of noise in the plan. A Node playbook declares five
  // risk globs; on a repo with no `pnpm-lock.yaml` and no Dockerfile, all five are advice
  // about files that do not exist. Offering them made a well-matched repo show more
  // external guidance than derived work, and a list that is mostly irrelevant stops being
  // read.
  //
  // The conditional also means the suggestion is *derived* in the useful sense: it is
  // about this repository's files, not about the ecosystem in general.
  for (const glob of playbook.riskGlobs) {
    if (claimedRiskGlobs.has(glob)) continue
    if (!matchesAny(profile.files, glob)) continue
    claimedRiskGlobs.add(glob)
    const hit = profile.files.find((f) => matchesGlob(f, glob))
    out.push({
      ...base,
      id: `risk:${playbook.id}:${glob}`,
      tier: 'official',
      title: `Treat ${glob} as high-risk`,
      detail: `The ${playbook.title} playbook marks this path as risky, and this repo has ${
        hit ?? 'files matching it'
      }: ${playbook.conventions.reviewFocus[0] ?? 'changes here reach past code review'}`,
      evidence: [playbook.source ?? playbook.id, ...(hit === undefined ? [] : [hit])],
      confidence: 0.7,
      provenance: 'curated',
    })
  }

  const officialGroups: Array<[string, Resource[]]> = [
    ['doc', playbook.official.docs],
    ['skill', playbook.official.skills],
    ['agent', playbook.official.agents],
    ['mcp', playbook.official.mcp],
    ['style', playbook.official.styleGuides],
    ['migration', playbook.official.migrationGuides],
  ]
  for (const [kind, resources] of officialGroups) {
    for (const resource of resources) {
      // The repository may already follow this guidance, in which case the suggestion is
      // noise: the reader has it, and being told about it teaches them to skip the list.
      const satisfiedBy = satisfiedByFile(resource, profile)
      if (satisfiedBy !== null) {
        satisfied++
        if (options.includeSatisfied !== true) continue
      }
      out.push({
        ...base,
        id: `official:${playbook.id}:${resource.url}`,
        tier: 'official',
        title: `${kind}: ${resource.label}`,
        detail: resource.why,
        evidence: [playbook.source ?? playbook.id, ...(satisfiedBy === null ? [] : [satisfiedBy])],
        url: resource.url,
        ...(resource.install === undefined ? {} : { install: resource.install }),
        confidence: kind === 'doc' || kind === 'style' ? 0.75 : 0.7,
        provenance: 'curated',
        external: true,
        // The publisher is read from the URL, not assumed because the entry is in the official
        // list: `Context7` is filed under `official.mcp` and hosted by upstash, which the node
        // playbook's seeds do not name.
        trust: curatedTrust({ url: resource.url }, playbook.discover),
      })
    }
  }

  for (const resource of playbook.community) {
    const satisfiedBy = satisfiedByFile(resource, profile)
    if (satisfiedBy !== null) {
      satisfied++
      if (options.includeSatisfied !== true) continue
    }
    out.push({
      ...base,
      id: `community:${playbook.id}:${resource.repo}`,
      tier: 'community',
      title: `community: ${resource.label}`,
      detail: resource.why,
      evidence: [playbook.source ?? playbook.id, ...(satisfiedBy === null ? [] : [satisfiedBy])],
      url: resource.url,
      ...(resource.install === undefined ? {} : { install: resource.install }),
      // Popularity nudges the ranking, but does not manufacture confidence: "widely
      // starred" is not "correct for your repo".
      confidence: communityConfidence(resource),
      provenance: 'curated',
      external: true,
      // Community is where the resource ranks, not who publishes it: a repo the playbook's own
      // orgs own (`android/nowinandroid`) is first-party even though it ranks below the
      // hand-written official list.
      trust: curatedTrust({ repo: resource.repo }, playbook.discover),
    })
  }

  return { suggestions: out, satisfied }
}

/**
 * True when an owner is one a playbook's seeds call official.
 *
 * Case-insensitive, because GitHub logins are, and applies the same way whether the owner came
 * from a community entry's `repo` or a URL.
 */
export function ownerIsOfficial(owner: string, orgs: readonly string[]): boolean {
  const normalized = owner.trim().toLowerCase()
  if (normalized === '') return false
  return orgs.some((org) => org.trim().toLowerCase() === normalized)
}

/** The `owner` segment of a GitHub repository URL, or null when the URL is not one. */
function githubOwnerFromUrl(url: string): string | null {
  if (hostFromUrl(url) !== 'github.com') return null
  const owner = pathFromUrl(url)
    .split('/')
    .find((segment) => segment !== '')
  return owner === undefined ? null : owner
}

/** The lower-cased host of a URL, with a leading `www.` removed, or null when it has none. */
function hostFromUrl(url: string): string | null {
  const trimmed = url.trim()
  if (trimmed === '') return null
  try {
    return new URL(trimmed).hostname.toLowerCase().replace(/^www\./, '')
  } catch {
    return null
  }
}

/** The path of a URL, or empty when it cannot be parsed. */
function pathFromUrl(url: string): string {
  try {
    return new URL(url.trim()).pathname
  } catch {
    return ''
  }
}

/**
 * True when a URL's host and path match a declared official domain.
 *
 * A declaration is `host` or `host/path`:
 *
 *   - `host` matches that exact host at any path. Subdomains do not match, so `go.dev` does not
 *     cover `pkg.go.dev`: the two publish different things, and a shared host is not evidence
 *     of a shared publisher.
 *   - `host/path` scopes to a namespace -- the URL path must be `path` or under it. This is how
 *     a shared host carries publisher evidence: `hexdocs.pm/elixir`, `pkg.go.dev/golang.org/x`.
 *   - `host/` (a trailing slash and nothing after) matches only the root, for a registry whose
 *     landing page is official but whose contents are third-party.
 *
 * Both host sides are normalised the same way, so a declared `www.acme.dev` matches a URL
 * on `acme.dev` and the reverse. Only the host is case-folded: a URL path is case-sensitive,
 * so a declared `AcmeSDK` namespace is not widened to `acmesdk`.
 */
function isOfficialDomain(host: string, urlPath: string, domains: readonly string[]): boolean {
  const path = urlPath.replace(/^\/+/, '').replace(/\/+$/, '')
  return domains.some((raw) => {
    const entry = raw.trim()
    const slash = entry.indexOf('/')
    const entryHost = (slash === -1 ? entry : entry.slice(0, slash)).toLowerCase().replace(/^www\./, '')
    if (entryHost === '' || entryHost !== host) return false
    if (slash === -1) return true
    const entryPath = entry.slice(slash + 1).replace(/\/+$/, '')
    if (entryPath === '') return path === ''
    return path === entryPath || path.startsWith(`${entryPath}/`)
  })
}

/** The evidence a playbook offers about who publishes on its behalf. */
export interface PublisherEvidence {
  /** GitHub orgs the seeds call official. */
  officialOrgs: readonly string[]
  /** Hostnames, or `host/path` namespaces, the technology publishes its own docs on. */
  officialDomains?: readonly string[]
}

/**
 * Who publishes a curated resource, read from its evidence rather than its tier.
 *
 * The evidence is an owner or a domain, never the list an entry sits in:
 *
 *   - A community entry names its `repo`; an official entry may cite a GitHub URL. An owner
 *     among the playbook's `officialOrgs` is `official-publisher`; any other owner is
 *     `third-party`, so a first-party-looking URL is not taken at face value.
 *   - With no owner to read, the URL host and path are checked against the playbook's declared
 *     `officialDomains`. A match is `official-publisher`.
 *   - Neither available -- an unrecognised host -- is `third-party`. An unknown publisher is
 *     not an official one; the honest label is the one that makes no claim.
 */
export function curatedTrust(
  input: { repo?: string | null; url?: string | null },
  evidence: PublisherEvidence,
): SuggestionTrust {
  const repo = (input.repo ?? '').trim()
  const owner = repo !== '' ? (repo.split('/')[0] ?? '') : (githubOwnerFromUrl(input.url ?? '') ?? '')
  if (owner.trim() !== '') {
    return ownerIsOfficial(owner, evidence.officialOrgs) ? 'official-publisher' : 'third-party'
  }
  const url = input.url ?? ''
  const host = hostFromUrl(url)
  if (host !== null && isOfficialDomain(host, pathFromUrl(url), evidence.officialDomains ?? [])) {
    return 'official-publisher'
  }
  return 'third-party'
}

/**
 * The file that says the repository already follows this resource's guidance.
 *
 * Null when the resource declares no `satisfiedBy` globs, or when none of them match.
 * The check is file presence, not content: a file's existence is the one signal that can
 * be read without reading it, and a suggestion that costs a repository scan to decide is
 * a suggestion that will not be decided.
 */
function satisfiedByFile(resource: Resource, profile: ProjectProfile): string | null {
  const globs = resource.satisfiedBy
  if (globs === undefined || globs.length === 0) return null
  for (const glob of globs) {
    const hit = profile.files.find((f) => matchesGlob(f, glob))
    if (hit !== undefined) return hit
  }
  return null
}

/**
 * Confidence for a community resource, from its star count.
 *
 * Takes only the field it reads, rather than a `CommunityResource`, for a reason that is
 * about reuse rather than tidiness: live discovery ranks with this same ladder, and its
 * entries are not community resources -- they have no `repo` and no hand-written `why`. A
 * parameter that admits both keeps the table single-sourced, which is what stops curated
 * and discovered entries from drifting apart on what "widely starred" means.
 */
export function communityConfidence(resource: { stars: number | null }): number {
  if (resource.stars === null) return 0.4
  if (resource.stars >= 20000) return 0.6
  if (resource.stars >= 5000) return 0.5
  if (resource.stars >= 1000) return 0.45
  return 0.35
}

/** Section name as a plan title prefix, matching the curated groups. */
const LIVE_SECTION_LABEL: Record<LiveResource['section'], string> = {
  docs: 'doc',
  skills: 'skill',
  agents: 'agent',
  mcp: 'mcp',
  styleGuides: 'style',
  migrationGuides: 'migration',
  community: 'community',
}

/**
 * Live official guidance is capped below curated official guidance.
 *
 * 0.7 is what a curated `skill`, `agent` or `mcp` entry scores. A discovered one scores at
 * most 0.65: same tier, same shape of claim, but nobody reviewed it, and the org check that
 * promoted it to `official` is a seed list that can be wrong. A wrong link at 0.75 reads as
 * settled advice; the same link at 0.65 with a `live` label reads as a lead.
 */
const LIVE_OFFICIAL_CAP = 0.65

/**
 * Who vouches for a live resource, read from `trust` and falling back to its source.
 *
 * `trust` was added after the first discovery caches existed, so an entry written before
 * then carries none. A reader that finds it absent must read the evidence rather than leave
 * the attribution blank: a `local-scan` entry is a file on this machine (`local-install`),
 * an entry the seeds matched to an official org is `official-publisher`, and anything else
 * is `third-party`. The plan and the brief share this one rule so the same cache cannot
 * produce a labelled suggestion on one screen and an unlabelled one on the other.
 */
export function liveTrust(entry: {
  trust?: string | null
  source?: string | null
  tier?: string | null
}): SuggestionTrust {
  if (entry.trust === 'official-publisher' || entry.trust === 'local-install' || entry.trust === 'third-party') {
    return entry.trust
  }
  if (entry.source === 'local-scan') return 'local-install'
  return entry.tier === 'official' ? 'official-publisher' : 'third-party'
}

function liveSuggestion(playbookId: string, entry: LiveResource): Suggestion {
  // A local skill is a file on this machine, not a link. `url` is omitted rather than
  // pointing at `file://`, which renders as a broken href in every consumer that takes one
  // -- and the evidence line already carries the path, which is the part a reader needs.
  const url = entry.url.trim()
  const trust = liveTrust(entry)
  return {
    id: `live:${playbookId}:${url === '' ? (entry.install ?? entry.label) : normalizeUrl(url)}`,
    tier: entry.tier,
    playbook: playbookId,
    title: `${LIVE_SECTION_LABEL[entry.section]}: ${entry.label}`,
    detail: entry.why,
    // The evidence is the fetch itself: which source produced this and when. A live entry
    // has no file to point at, and claiming one would be a lie about where it came from.
    evidence: [`live:${entry.source} ${entry.fetchedAt}`, ...(entry.install === null ? [] : [entry.install])],
    ...(url === '' ? {} : { url }),
    ...(entry.install === null ? {} : { install: entry.install }),
    confidence:
      entry.tier === 'official'
        ? LIVE_OFFICIAL_CAP
        : // The curated ladder, one notch down: same signal, less authority.
          Math.max(0.3, Number((communityConfidence(entry) - 0.05).toFixed(2))),
    provenance: 'live',
    fetchedAt: entry.fetchedAt,
    external: true,
    trust,
  }
}

/**
 * A URL reduced to a comparable key, for the curated-wins dedupe.
 *
 * Normalising rather than string-comparing because the two sides write the same link
 * differently: a curated entry cites `https://github.com/android/nowinandroid`, while a
 * search result arrives as `github.com/android/nowinandroid` in some shapes and with a
 * trailing slash in others. Without this, the same resource prints twice on a screen that
 * has room for one of them.
 */
export function normalizeUrl(url: string): string {
  const trimmed = url.trim().toLowerCase()
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//.test(trimmed) ? trimmed : `https://${trimmed}`
  try {
    const parsed = new URL(withScheme)
    const path = parsed.pathname.replace(/\/+$/, '')
    return `${parsed.host}${path}${parsed.search}${parsed.hash}`
  } catch {
    return trimmed
  }
}

function dedupe(suggestions: readonly Suggestion[]): Suggestion[] {
  const seen = new Set<string>()
  const out: Suggestion[] = []
  for (const s of suggestions) {
    if (seen.has(s.id)) continue
    seen.add(s.id)
    out.push(s)
  }
  return out
}

export function rankSuggestions(suggestions: readonly Suggestion[]): Suggestion[] {
  return [...suggestions].sort((a, b) => {
    const tier = TIER_ORDER[a.tier] - TIER_ORDER[b.tier]
    if (tier !== 0) return tier
    const sevA = a.severity === undefined ? 9 : SEVERITY_ORDER[a.severity]
    const sevB = b.severity === undefined ? 9 : SEVERITY_ORDER[b.severity]
    if (sevA !== sevB) return sevA - sevB
    if (a.confidence !== b.confidence) return b.confidence - a.confidence
    return a.id < b.id ? -1 : 1
  })
}

/** How many resources a claim, crew launch or ticket refresh carries into a worktree. */
export const DEFAULT_SHORTLIST_LIMIT = 5

export interface ShortlistOptions {
  /**
   * Free text describing the work: a ticket title, body, labels, or a goal.
   *
   * Matched against resource labels and details by whole word. A resource is offered only
   * when it answers the focus -- a focus word in its own label, or two distinct focus words
   * in its text. Absent focus produces a tier/confidence list instead, which is still small
   * and still optional -- it just is not tailored.
   */
  focus?: string
  /** Maximum entries. Defaults to [DEFAULT_SHORTLIST_LIMIT]; never fewer than one. */
  limit?: number
}

/** Grammatical words that would match almost every resource and rank nothing. */
const SHORTLIST_STOPWORDS = new Set([
  'the',
  'and',
  'for',
  'with',
  'this',
  'that',
  'from',
  'into',
  'your',
  'will',
  'must',
  'should',
  'when',
  'then',
  'than',
  'have',
  'has',
  'are',
  'was',
  'were',
  'not',
  'but',
  'all',
  'any',
  'can',
  'may',
  'use',
  'using',
  'add',
  'make',
  'need',
  'needs',
  'want',
  'work',
  'repo',
  'repository',
])

/**
 * A small, ranked reading list for one piece of work.
 *
 * The plan is a catalogue: useful when you are deciding what to improve, and far too long
 * to put in front of an agent that is already working on a ticket. This is the other view --
 * at most a handful of external resources, ranked by how many of the ticket's own words they
 * mention, with tier and confidence as tie-breakers.
 *
 * Only external resources are eligible (`external` set): something to read or consult. A
 * change to this repository -- a missing verify command, a high-risk glob, or a derived fix
 * -- is work, not an aid, and offering it as optional reading invites an agent to skip it.
 *
 * With a focus, the list is tailored rather than padded: a resource that does not answer the
 * focus is left out even when that means fewer than `limit`. Precision is the point -- a
 * coverage ticket handed a CI triage agent because both mention "tests" is the failure this
 * avoids, and a short honest list is better than a full misleading one.
 */
export function shortlistSuggestions(suggestions: readonly Suggestion[], options: ShortlistOptions = {}): Suggestion[] {
  const limit = Math.max(1, Math.floor(options.limit ?? DEFAULT_SHORTLIST_LIMIT))
  const terms = focusTerms(options.focus ?? '')
  const scored: Array<{ suggestion: Suggestion; score: number }> = []
  for (const suggestion of suggestions) {
    if (suggestion.external !== true) continue
    // With a focus, only a resource that actually answers it is offered -- the list is
    // tailored, not a tier/confidence catalogue padded to the limit. See `focusRelevance`.
    const relevance = focusRelevance(suggestion, terms)
    if (relevance === null) continue
    scored.push({ suggestion, score: scoreSuggestion(suggestion, relevance) })
  }

  scored.sort((a, b) => {
    if (a.score !== b.score) return b.score - a.score
    const tier = TIER_ORDER[a.suggestion.tier] - TIER_ORDER[b.suggestion.tier]
    if (tier !== 0) return tier
    if (a.suggestion.confidence !== b.suggestion.confidence) return b.suggestion.confidence - a.suggestion.confidence
    return a.suggestion.title.localeCompare(b.suggestion.title)
  })

  const seen = new Set<string>()
  const out: Suggestion[] = []
  for (const { suggestion } of scored) {
    const key = shortlistKey(suggestion)
    if (seen.has(key)) continue
    seen.add(key)
    out.push(suggestion)
    if (out.length === limit) break
  }
  return out
}

/** Shared word boundaries: punctuation separates names such as `testing-setup` and `unit_tests`. */
function shortlistWords(text: string): string[] {
  return text.toLowerCase().match(/[a-z0-9]+/g) ?? []
}

/** Lower-cased, de-duplicated words long enough to mean something. */
function focusTerms(focus: string): string[] {
  const out: string[] = []
  const seen = new Set<string>()
  for (const raw of shortlistWords(focus)) {
    if (raw.length < 4 || SHORTLIST_STOPWORDS.has(raw) || seen.has(raw)) continue
    seen.add(raw)
    out.push(raw)
    if (out.length === 20) break
  }
  return out
}

/**
 * How much of a resource's detail participates in a shortlist match.
 *
 * A curated `why` is a sentence or two -- the registry's longest is under 500 characters. A
 * live entry's detail is the repository's own GitHub description, which can run to tens of
 * thousands of characters and list every topic the maintainer could think of. Matching
 * against all of it let a description that happened to mention the ticket's words 20,000
 * characters in outrank a resource actually about the task, so the match is bounded to the
 * part a reader would take as the summary. The bound sits well above every curated `why`, so
 * no hand-written reason is ever truncated.
 */
const SHORTLIST_DETAIL_CHARS = 1000

/** How many distinct focus words a suggestion matches, or null when it does not earn a place. */
function focusRelevance(suggestion: Suggestion, terms: readonly string[]): number | null {
  // No focus is the untailored case: every resource qualifies and the tie-breakers order it.
  if (terms.length === 0) return 0

  // The kind in the title is display metadata, not the resource's topic. In particular, every
  // `community:` row used to match a ticket asking for `unit` tests.
  const label = new Set(
    shortlistWords(suggestion.title.replace(/^(?:doc|skill|agent|mcp|style|migration|community):\s*/i, '')),
  )
  const detail = new Set(shortlistWords(boundedDetail(suggestion.detail)))

  let matches = 0
  let inLabel = false
  for (const term of terms) {
    const inLabelHit = label.has(term)
    if (inLabelHit || detail.has(term)) matches++
    if (inLabelHit) inLabel = true
    if (matches === 3) break
  }

  // A focus word in the resource's own label is the strongest signal. Otherwise a resource
  // must match two distinct focus words: one word in a long description is a coincidence,
  // and coincidence is what put a "high-performance workspace" in a Compose performance list
  // and a CI triage agent in a coverage list. A one-word focus is the exception -- there is
  // only one word, so one match is all the corroboration the ticket could offer.
  const needed = Math.min(2, terms.length)
  return inLabel || matches >= needed ? matches : null
}

/** The head of a resource's detail, without a word cut by the bound (`testimony` -> `test`). */
function boundedDetail(detail: string): string {
  if (detail.length <= SHORTLIST_DETAIL_CHARS) return detail
  const head = detail.slice(0, SHORTLIST_DETAIL_CHARS)
  const cut = /[a-z0-9]/i.test(detail[SHORTLIST_DETAIL_CHARS] ?? '')
  return cut ? head.replace(/[a-z0-9]+$/i, '') : head
}

function scoreSuggestion(suggestion: Suggestion, relevance: number): number {
  // Relevance dominates confidence: a resource that mentions the ticket's own words is the
  // point of the list, and a high-confidence unrelated doc is exactly the noise this removes.
  const tierBonus = suggestion.tier === 'official' ? 0.5 : 0
  return relevance * 2 + tierBonus + suggestion.confidence
}

/** A stable identity for de-duplication: install path, then URL, then id. */
function shortlistKey(suggestion: Suggestion): string {
  const install = (suggestion.install ?? '').trim().toLowerCase()
  if (install !== '') return `install:${install}`
  const url = (suggestion.url ?? '').trim()
  if (url !== '') return `url:${normalizeUrl(url)}`
  return `id:${suggestion.id}`
}
