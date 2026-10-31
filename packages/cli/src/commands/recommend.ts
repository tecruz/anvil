/**
 * Optional resources for a ticket, in the shape the context bundle renders.
 *
 * This is the bridge between the plan (a catalogue of everything that could help a
 * repository) and a worktree (which needs a handful of aids for one task). It ranks with
 * `shortlistSuggestions` and maps the result into `@anvil/tickets`' dependency-free
 * `RecommendedResource`, so neither the worktree nor the bundle package has to know about
 * playbooks, audit or discovery.
 *
 * Nothing here installs, fetches or runs a resource. A recommendation is a line of text.
 */

import { audit } from '@anvil/audit'
import {
  buildPlan,
  type LiveResource,
  loadPlaybooks,
  type MatchResult,
  matchPlaybooks,
  type Suggestion,
  shortlistSuggestions,
  trustLabel,
} from '@anvil/playbooks'
import { buildProfile, type ProjectProfile } from '@anvil/profile'
import type { Ticket } from '@anvil/tickets'
import type { RecommendedResource } from '@anvil/tickets/context'
import { loadLiveForPlan } from './discover.ts'
import { toPlaybookMatchInfo } from './matches.ts'

/** How many resources a worktree carries by default. */
export const RECOMMEND_LIMIT = 5

/**
 * The text a resource is matched against: the ticket's own words.
 *
 * Bounded, because ticket bodies are arbitrary length and matching does not get better with
 * the ten-thousandth character. Every field is included so a label like `coverage` counts.
 */
export function ticketFocus(ticket: Ticket): string {
  const parts: string[] = [ticket.title]
  if (ticket.body !== undefined) parts.push(ticket.body)
  if (ticket.acceptance !== undefined) parts.push(...ticket.acceptance)
  if (ticket.labels !== undefined) parts.push(...ticket.labels)
  return parts.join('\n').slice(0, 4000)
}

/**
 * Rank external resources for one ticket.
 *
 * `live` is the same map `plan` and `brief` use: installed skills plus a fresh discovery
 * cache. A ticket with no focus still gets a short tier/confidence list rather than nothing.
 */
export function recommendResources(options: {
  profile: ProjectProfile
  matches: readonly MatchResult[]
  live: ReadonlyMap<string, readonly LiveResource[]>
  ticket?: Ticket
  limit?: number
}): RecommendedResource[] {
  const report = audit(options.profile, {
    playbookMatches: toPlaybookMatchInfo(options.matches, options.profile),
  })
  const plan = buildPlan(report, options.profile, options.matches, [], options.live, {})

  const limit = options.limit ?? RECOMMEND_LIMIT
  const shortlist =
    options.ticket === undefined
      ? shortlistSuggestions(plan.suggestions, { limit })
      : shortlistSuggestions(plan.suggestions, { focus: ticketFocus(options.ticket), limit })

  return shortlist.map(toRecommendedResource)
}

/**
 * Rank external resources for a ticket against an already-built profile.
 *
 * Reads installed skills and a fresh discovery cache only -- no network, which is what makes
 * it safe on the claim path. `plan` and `brief` merge the same two sources.
 */
export function recommendForProfile(profile: ProjectProfile, ticket: Ticket): RecommendedResource[] {
  const { playbooks } = loadPlaybooks(process.env)
  const matches = matchPlaybooks(profile, playbooks)
  const { live } = loadLiveForPlan(matches.map((match) => match.playbook))
  return recommendResources({ profile, matches, live, ticket })
}

/**
 * Rank external resources against the tree the work will actually happen in.
 *
 * The profile is read from `worktreePath`, not the caller's checkout: a claim branches from a
 * base ref that may be a different stack than the branch that was open, and recommending the
 * wrong language's docs is worse than recommending nothing.
 */
export function recommendForWorktree(worktreePath: string, ticket: Ticket): RecommendedResource[] {
  const profile = buildProfile(worktreePath, {
    root: worktreePath,
    host: null,
    remote: null,
    defaultBranch: null,
  }).profile
  return recommendForProfile(profile, ticket)
}

/** One ranked suggestion, reduced to what the bundle shows. */
export function toRecommendedResource(suggestion: Suggestion): RecommendedResource {
  const { kind, label } = splitTitle(suggestion.title)
  const install = (suggestion.install ?? '').trim()
  const location = install !== '' ? install : (suggestion.url ?? '').trim()
  return {
    kind,
    label,
    why: suggestion.detail,
    location,
    trust: suggestion.trust === undefined ? 'unclassified' : trustLabel(suggestion.trust),
    provenance: suggestion.provenance,
  }
}

/** Titles are `${kind}: ${label}`; anything else is a single label. */
function splitTitle(title: string): { kind: string; label: string } {
  const index = title.indexOf(':')
  if (index === -1) return { kind: 'resource', label: title.trim() }
  return { kind: title.slice(0, index).trim(), label: title.slice(index + 1).trim() }
}
