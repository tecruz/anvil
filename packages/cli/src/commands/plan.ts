/**
 * `anvil plan` -- ranked fixes for a repository.
 *
 * The bridge between `doctor` ("you score 42") and `init` (M2b, "here is the AGENTS.md").
 * Pure data: no LLM is involved, and nothing is written to the repository.
 */

import { resolve } from 'node:path'
import { audit, type ReadinessReport } from '@anvil/audit'
import { AnvilError, ErrorCode, parseCliArgs, renderTable } from '@anvil/core'
import { discoverRepo } from '@anvil/git'
import { buildPlan, loadPlaybooks, matchPlaybooks, type Plan, type PlanTier } from '@anvil/playbooks'
import { buildProfile, type ProjectProfile, profileWarnings } from '@anvil/profile'
import { liveEntriesForPlan } from './discover.ts'
import { toPlaybookMatchInfo } from './matches.ts'
import type { Command, CommandContext } from './types.ts'

const TIERS: readonly PlanTier[] = ['derived', 'official', 'community']

function detectHost(remote: string | null): 'github' | 'gitlab' | 'bitbucket' | 'azure' | null {
  if (remote === null) return null
  if (/github\.com|github\./i.test(remote)) return 'github'
  if (/gitlab/i.test(remote)) return 'gitlab'
  if (/bitbucket/i.test(remote)) return 'bitbucket'
  if (/dev\.azure\.com|visualstudio\.com/i.test(remote)) return 'azure'
  return null
}

async function loadProfile(ctx: CommandContext, target: string | undefined): Promise<ProjectProfile> {
  const dir = target ?? ctx.repoRoot
  if (dir === undefined || dir === null) {
    throw new AnvilError(ErrorCode.NotAGitRepo, 'Not inside a git repository', {
      hint: 'Run anvil from inside a repository, or pass --profile <dir>.',
    })
  }
  const root = resolve(dir)
  const info = target === undefined ? ctx.repo : await discoverRepo(root)
  return buildProfile(root, {
    root,
    host: detectHost(info?.remote ?? null),
    remote: info?.remote ?? null,
    defaultBranch: info?.defaultBranch ?? null,
  }).profile
}

export const planCommand: Command = {
  name: 'plan',
  summary: 'Rank fixes as derived / official / community.',
  usage:
    'anvil plan [--json] [--profile <dir>] [--tier <t>] [--only <ids>] [--limit <n>] [--offline] [--refresh] [--include-satisfied]',
  details: [
    'Three tiers, ranked in this order:',
    '',
    "  derived    from this repository's own facts. Highest confidence, because nothing",
    '             outside the repo was consulted.',
    "  official   the technology's own documentation, skills and MCP servers.",
    '  community  well-known third-party resources, ranked below official because',
    '             "widely accepted" is a weaker claim than "maintained by the project".',
    '',
    'Reads only. Nothing is written to the repository.',
    '',
    'Guidance from `anvil playbook discover` is merged in, marked live and ranked below the',
    'curated entries of the same tier. It reads a cache in your home directory, so it costs',
    'no network here; run `anvil playbook discover` to populate it, or --refresh to fetch it',
    'now. A cache older than seven days is reported and left out rather than merged, because',
    'a stale search result is noise dressed as guidance; --refresh replaces it with a new',
    'answer.',
    '',
    'A suggestion the repository already satisfies is left out, and the count of those is',
    'printed. --include-satisfied keeps them.',
    '',
    '--tier <t>     only suggestions from one tier (derived, official, community)',
    '--only <ids>   comma-separated suggestion ids, e.g. fix:AGENTS_FILE',
    '--limit <n>    show at most n suggestions',
    '--offline      ignore the discovery cache entirely',
    '--refresh      fetch live guidance now and cache it, instead of reading the cache',
    '--include-satisfied',
    '               keep suggestions this repository already satisfies',
  ].join('\n'),
  flags: {
    json: { type: 'boolean', short: 'j' },
    help: { type: 'boolean', short: 'h' },
    profile: { type: 'string' },
    tier: { type: 'string', multiple: true },
    only: { type: 'string' },
    limit: { type: 'string' },
    offline: { type: 'boolean' },
    refresh: { type: 'boolean' },
    'include-satisfied': { type: 'boolean' },
  },

  async run(ctx, rawArgs) {
    const args = parseCliArgs(rawArgs, planCommand.flags)
    const target = typeof args.values.profile === 'string' ? args.values.profile : undefined
    const includeSatisfied = args.values['include-satisfied'] === true
    const profile = await loadProfile(ctx, target)

    const { playbooks, warnings } = loadPlaybooks(process.env)
    const matches = matchPlaybooks(profile, playbooks)
    const report: ReadinessReport = audit(profile, {
      playbookMatches: toPlaybookMatchInfo(matches, profile),
    })

    // Discovery runs *after* matching, because the cache is keyed by playbook id and a
    // playbook that did not match contributes nothing. Reading it before would mean
    // reporting cached entries for technologies this repository does not use.
    const offline = args.values.offline === true
    const refresh = args.values.refresh === true
    if (offline && refresh) {
      throw new AnvilError(ErrorCode.Usage, '--offline and --refresh contradict each other', {
        hint: '--offline asks for no network at all; --refresh asks for a fetch. Pick one.',
      })
    }
    const { live, warnings: liveWarnings } = await liveEntriesForPlan(
      matches.map((m) => m.playbook),
      { offline, refresh, cwd: ctx.cwd },
    )

    const plan = buildPlan(
      report,
      profile,
      matches,
      [...profileWarnings(profile), ...warnings, ...liveWarnings],
      live,
      { includeSatisfied },
    )

    const tiers = parseTiers(args.values.tier)
    const only = parseIds(args.values.only)
    const limit = parseLimit(args.values.limit)

    let suggestions = plan.suggestions
    if (tiers !== null) suggestions = suggestions.filter((s) => tiers.has(s.tier))
    if (only !== null) suggestions = suggestions.filter((s) => only.has(s.id))
    if (limit !== null) suggestions = suggestions.slice(0, limit)

    const data = { ...plan, suggestions, counts: countTiers(suggestions) }

    ctx.out(data, () => renderPlan(ctx, data, includeSatisfied))
    return undefined
  },
}

function countTiers(suggestions: Plan['suggestions']): Record<PlanTier, number> {
  return {
    derived: suggestions.filter((s) => s.tier === 'derived').length,
    official: suggestions.filter((s) => s.tier === 'official').length,
    community: suggestions.filter((s) => s.tier === 'community').length,
  }
}

function parseTiers(value: unknown): Set<PlanTier> | null {
  const list = Array.isArray(value) ? value : typeof value === 'string' ? value.split(',') : []
  const cleaned = list.map((v) => (v as string).trim()).filter((v) => v !== '')
  if (cleaned.length === 0) return null
  const out = new Set<PlanTier>()
  for (const raw of cleaned) {
    if (!TIERS.includes(raw as PlanTier)) {
      throw new AnvilError(ErrorCode.Usage, `Unknown tier: ${raw}`, {
        hint: `Expected one of: ${TIERS.join(', ')}`,
      })
    }
    out.add(raw as PlanTier)
  }
  return out
}

function parseIds(value: unknown): Set<string> | null {
  if (typeof value !== 'string' || value === '') return null
  return new Set(
    value
      .split(',')
      .map((v) => v.trim())
      .filter((v) => v !== ''),
  )
}

function parseLimit(value: unknown): number | null {
  if (typeof value !== 'string' || value === '') return null
  const n = Number.parseInt(value, 10)
  if (!Number.isFinite(n) || n < 1) {
    throw new AnvilError(ErrorCode.Usage, `Invalid --limit: ${value}`, {
      hint: 'Expected a positive integer.',
    })
  }
  return n
}

function renderPlan(ctx: CommandContext, plan: Plan, includeSatisfied: boolean): string {
  const s = ctx.style
  const out: string[] = []

  out.push(`${s.bold('Plan')}  readiness ${String(plan.score)}/100 ${plan.grade}`)
  out.push(
    `  ${String(plan.counts.derived).padStart(2)} derived   ${String(plan.counts.official).padStart(2)} official   ${String(plan.counts.community).padStart(2)} community`,
  )
  if (plan.satisfied > 0) {
    // Stated, not hidden: the list is short because some of it was left out, and a reader
    // who cannot see that will assume the list is everything there is to know.
    out.push(
      s.dim(
        `  ${String(plan.satisfied).padStart(2)} satisfied   already followed by this repository${includeSatisfied ? '; shown here' : '; --include-satisfied to see them'}`,
      ),
    )
  }

  out.push('')
  out.push(s.bold('Matched playbooks'))
  if (plan.playbooks.length === 0) {
    out.push(s.yellow('  (none)'))
    out.push(s.dim('  No playbook matched this repository. Add one with ANVIL_PLAYBOOKS=<dir>.'))
  } else {
    for (const p of plan.playbooks) {
      out.push(`  ${s.bold(p.title)} ${s.dim(`(${p.id}, confidence ${p.confidence})`)}`)
      for (const reason of p.reasons) out.push(`    ${s.dim(reason)}`)
    }
  }

  const tiers: PlanTier[] = ['derived', 'official', 'community']
  for (const tier of tiers) {
    const items = plan.suggestions.filter((s2) => s2.tier === tier)
    if (items.length === 0) continue
    out.push('')
    // The live count is called out per tier rather than marked on each row: a plan can carry
    // dozens of live entries, and a per-row marker would put `live` on most of a screen
    // without telling the reader anything they would act on differently. The wording names
    // discovery rather than the `discover` command, because a plan can also be given live
    // entries by its own --refresh.
    const liveCount = items.filter((i) => i.provenance === 'live').length
    out.push(
      s.bold(`${tier} (${String(items.length)})`) +
        (liveCount === 0 ? '' : s.dim(`  ${String(liveCount)} live, from discovery`)),
    )
    out.push(
      renderTable(
        ['#', 'suggestion', 'conf', 'detail'],
        items.map((item, i) => [String(i + 1), item.title, item.confidence.toFixed(2), item.detail]),
        s,
      ),
    )
  }

  if (plan.warnings.length > 0) {
    out.push('')
    out.push(s.yellow('Warnings'))
    for (const w of plan.warnings) out.push(`  ${w}`)
  }

  return out.join('\n')
}
