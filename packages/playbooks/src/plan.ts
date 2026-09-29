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
import type { CommunityResource, Playbook, Resource } from './schema.ts'
import type { MatchResult } from './match.ts'

export type PlanTier = 'derived' | 'official' | 'community'

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
}

export interface Plan {
  schemaVersion: 1
  score: number
  grade: ReadinessReport['grade']
  /** Playbooks that matched, with why. */
  playbooks: Array<{ id: string; title: string; confidence: number; reasons: string[] }>
  suggestions: Suggestion[]
  counts: Record<PlanTier, number>
  /** Anything that could not be loaded, so it is visible rather than silent. */
  warnings: string[]
}

const TIER_ORDER: Record<PlanTier, number> = { derived: 0, official: 1, community: 2 }

const SEVERITY_ORDER: Record<Finding['severity'], number> = { blocker: 0, high: 1, medium: 2, low: 3, info: 4 }

export function buildPlan(
  report: ReadinessReport,
  profile: ProjectProfile,
  matches: readonly MatchResult[],
  warnings: readonly string[] = [],
): Plan {
  const suggestions: Suggestion[] = []

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
  for (const match of matches) {
    for (const suggestion of playbookSuggestions(match.playbook, profile, claimedRiskGlobs)) {
      suggestions.push(suggestion)
    }
  }

  const ranked = rankSuggestions(dedupe(suggestions))

  return {
    schemaVersion: 1,
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
    warnings: [...warnings],
  }
}

/** Guidance a playbook contributes for a specific repo, not a generic resource dump. */
function playbookSuggestions(playbook: Playbook, profile: ProjectProfile, claimedRiskGlobs: Set<string>): Suggestion[] {
  const out: Suggestion[] = []
  const base = { playbook: playbook.id }

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
      out.push({
        ...base,
        id: `official:${playbook.id}:${resource.url}`,
        tier: 'official',
        title: `${kind}: ${resource.label}`,
        detail: resource.why,
        evidence: [playbook.source ?? playbook.id],
        url: resource.url,
        ...(resource.install === undefined ? {} : { install: resource.install }),
        confidence: kind === 'doc' || kind === 'style' ? 0.75 : 0.7,
      })
    }
  }

  for (const resource of playbook.community) {
    out.push({
      ...base,
      id: `community:${playbook.id}:${resource.repo}`,
      tier: 'community',
      title: `community: ${resource.label}`,
      detail: resource.why,
      evidence: [playbook.source ?? playbook.id],
      url: resource.url,
      ...(resource.install === undefined ? {} : { install: resource.install }),
      // Popularity nudges the ranking, but does not manufacture confidence: "widely
      // starred" is not "correct for your repo".
      confidence: communityConfidence(resource),
    })
  }

  return out
}

function communityConfidence(resource: CommunityResource): number {
  if (resource.stars === null) return 0.4
  if (resource.stars >= 20000) return 0.6
  if (resource.stars >= 5000) return 0.5
  if (resource.stars >= 1000) return 0.45
  return 0.35
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
