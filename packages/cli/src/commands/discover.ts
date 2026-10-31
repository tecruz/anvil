/**
 * `anvil playbook discover` -- fetch what a curated playbook does not know yet.
 *
 * Three decisions are baked in here, and each is the opposite of the convenient choice:
 *
 *   - **It never writes to `registry/playbooks/`.** The cache goes to
 *     `~/.anvil/cache/discovery/`. A tool that edits curated data makes a network response
 *     into reviewed-looking content, and the first bad fetch becomes permanent.
 *
 *   - **It exits 0 when a source is unreachable.** A missing `gh`, an absent token, a rate
 *     limit: these are partial results, and the run reports them as warnings. Exiting
 *     non-zero would make `discover` look broken on the locked-down machine the README says
 *     anvil is built for, where the local scan still worked.
 *
 *   - **`--propose` prints instead of caching.** Both outputs are available and neither is
 *     implied by the other, because the two audiences are different: a user wants their
 *     plan enriched, and a maintainer wants a diff to review.
 *
 * A real `fetch` is passed in rather than injected through the command surface: the seam
 * exists for tests, and the unit suite drives `runDiscovery` directly with a fake. This
 * function is the wiring, not the logic.
 */

import { AnvilError, ErrorCode, renderTable } from '@anvil/core'
import {
  type DiscoveryEntry,
  discoverLocal,
  type FetchImpl,
  loadCache,
  mergeBySource,
  oldestEntryTimestamp,
  proposePlaybookYaml,
  type RefreshResult,
  type RunOptions,
  type RunResult,
  refreshLive,
  runDiscovery,
  type SourceNote,
  saveCache,
  usableEntries,
} from '@anvil/discovery'
import { type DiscoverSeeds, matchPlaybooks, type Playbook } from '@anvil/playbooks'
import { buildProfile } from '@anvil/profile'
import type { CommandContext } from './types.ts'

const DEFAULT_PROPOSAL_LIMIT = 5

/**
 * The fetch the CLI uses for the network sources.
 *
 * Node's own fetch, with the timeout the package asks for. A network failure throws here
 * and becomes a warning there: the package turns "could not be reached" into a source that
 * contributed nothing, rather than into a failed command.
 */
const liveFetch: FetchImpl = async (url, init) => {
  const res = await fetch(url, { headers: init.headers, signal: init.signal })
  return { status: res.status, text: () => res.text() }
}

/**
 * The default target set: the playbooks this repository matched, or every playbook when
 * `--all` is passed or there is no repository to match against.
 *
 * Defaulting to the whole registry would spend a rate limit on fifteen technologies to
 * answer a question about one; defaulting to "nothing, say so" would make the command
 * useless outside a repo. Matching the repo is the answer to the question a user actually
 * has.
 */
export function targetsFor(
  playbooks: readonly Playbook[],
  options: { all: boolean; repoRoot: string | null },
): { targets: Playbook[]; matched: boolean } {
  if (options.all || options.repoRoot === null) return { targets: [...playbooks], matched: false }
  const profile = buildProfile(options.repoRoot, {
    root: options.repoRoot,
    host: null,
    remote: null,
    defaultBranch: null,
  }).profile
  const matches = matchPlaybooks(profile, playbooks)
  return { targets: matches.map((m) => m.playbook), matched: true }
}

export async function runDiscover(
  ctx: CommandContext,
  allPlaybooks: readonly Playbook[],
  id: string | undefined,
  values: Record<string, string | boolean | string[] | undefined>,
): Promise<undefined> {
  const localOnly = values['local-only'] === true
  const propose = values.propose === true
  const all = values.all === true

  let playbooks: Playbook[]
  if (id !== undefined && id !== '') {
    const found = allPlaybooks.find((p) => p.id === id)
    if (found === undefined) {
      throw new AnvilError(ErrorCode.Usage, `No playbook "${id}"`, {
        hint: 'Run `anvil playbook list` to see the ids.',
      })
    }
    playbooks = [found]
  } else {
    playbooks = targetsFor(allPlaybooks, { all, repoRoot: ctx.repoRoot }).targets
  }

  const seeded = playbooks.filter(
    (p) => p.discover.officialOrgs.length > 0 || p.discover.keywords.length > 0 || p.discover.mcp.length > 0,
  )
  if (seeded.length === 0) {
    throw new AnvilError(ErrorCode.Usage, 'No playbook in scope declares discovery seeds', {
      hint: 'A playbook needs a `discover:` section with `officialOrgs`, `keywords` or `mcp` before there is anything to look for.',
    })
  }

  const results: RunResult[] = []
  const writes: Array<{ playbookId: string; entries: DiscoveryEntry[]; fetchedAt: string }> = []
  for (const playbook of seeded) {
    const cached = values.refresh === true ? null : loadCache(playbook.id, process.env)

    // A fresh cache already answers the question. Running the searches again to rediscover
    // what was fetched an hour ago spends a rate limit to produce the same plan, and
    // `--refresh` is how a caller says the answer has changed. `--local-only` and `--offline`
    // are the exception: those are requests to look at this machine, so they always scan.
    if (localOnly !== true && values.offline !== true && cached?.status === 'fresh' && cached.cache !== null) {
      const entries = usableEntries(cached)
      results.push({
        playbookId: playbook.id,
        entries,
        sources: [
          {
            source: 'cache',
            detail: `${cached.detail}; --refresh to fetch again`,
            entries: entries.length,
            answered: true,
          },
        ],
        warnings: [],
        kept: entries.length,
      })
      continue
    }

    const result = await runDiscovery(playbook, {
      cwd: ctx.cwd,
      online: values.offline !== true,
      env: process.env,
      ...(localOnly ? { localOnly: true } : {}),
      fetchImpl: liveFetch,
    })
    if (result.entries.length === 0) {
      results.push({ ...result, kept: 0 })
      continue
    }

    // The merge is per source: a source that answered replaces its own entries, and a
    // source that could not be reached keeps the ones it contributed last time. A run where
    // GitHub is rate-limited but the MCP registry answers must not erase the GitHub half of
    // the cache -- the next plan would then show less live guidance than the one before it,
    // with nothing to say why.
    const prior = cached !== null && cached.cache !== null ? usableEntries(cached) : []
    const entries = mergeBySource(prior, result.entries, result.sources)
    // Only what came back is written. A run that found nothing leaves the cache alone, and
    // the file's timestamp is the age of its oldest entry, so a merged cache never looks
    // fresher than the part of it that is actually old.
    writes.push({ playbookId: playbook.id, entries, fetchedAt: oldestEntryTimestamp(entries) })
    results.push({ ...result, kept: entries.length - result.entries.length })
  }

  const warnings = results.flatMap((r) => r.warnings)

  if (propose) {
    const limit = parseLimit(values.limit) ?? DEFAULT_PROPOSAL_LIMIT
    const proposals = seeded
      .map((p) => proposePlaybookYaml(p, results.find((r) => r.playbookId === p.id)?.entries ?? []))
      .filter((p) => p.entries.length > 0)
      .slice(0, limit)

    const data = {
      schemaVersion: 1,
      proposed: proposals.length,
      skipped: seeded.length - proposals.length,
      proposals: proposals.map((p) => ({ playbook: p.playbookId, entries: p.entries.length, yaml: p.yaml })),
      warnings,
    }

    ctx.out(data, () =>
      renderProposals(
        ctx,
        proposals.map((p) => p.yaml),
        warnings,
      ),
    )
    return undefined
  }

  // Only a run that produced entries writes. A rate-limited run that returned nothing must
  // not replace a week-old cache with an empty one, or a transient failure becomes seven days
  // of "anvil found nothing" with no indication why. A run that reused a fresh cache has
  // nothing to write at all.
  const written: string[] = []
  for (const w of writes) {
    written.push(
      saveCache(
        {
          schemaVersion: 1,
          playbookId: w.playbookId,
          fetchedAt: w.fetchedAt,
          entries: w.entries,
        },
        process.env,
      ),
    )
  }

  const data = {
    schemaVersion: 1,
    fetchedAt: new Date().toISOString(),
    playbooks: results.map((r) => ({
      id: r.playbookId,
      entries: r.entries.length,
      // Entries this run kept from the cache rather than fetched: the whole cache when it
      // was fresh enough to reuse, the fetched half when a local-only run merged into it.
      kept: r.kept,
      sources: r.sources,
      sample: r.entries
        .slice(0, 5)
        .map((e) => ({ label: e.label, tier: e.tier, section: e.section, source: e.source })),
    })),
    cacheWritten: written.length,
    cacheSkipped: results.filter((r) => r.entries.length === 0).map((r) => r.playbookId),
    warnings,
  }

  ctx.out(data, () => renderDiscover(ctx, results, written, warnings))
  return undefined
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

function renderDiscover(
  ctx: CommandContext,
  results: readonly RunResult[],
  written: readonly string[],
  warnings: readonly string[],
): string {
  const s = ctx.style
  const out: string[] = []
  const total = results.reduce((n, r) => n + r.entries.length, 0)

  out.push(
    `${s.bold('Discovery')}  ${String(total)} entr${total === 1 ? 'y' : 'ies'} from ${String(results.length)} playbook(s)`,
  )
  out.push('')

  const rows: Array<[string, string, string, string]> = []
  for (const r of results) {
    for (const note of sourceRows(r.sources)) rows.push([r.playbookId, note.source, String(note.entries), note.detail])
  }
  if (rows.length > 0) out.push(renderTable(['playbook', 'source', 'n', 'detail'], rows, s))

  if (written.length > 0) {
    out.push('')
    out.push(s.green(`Cached ${String(written.length)} playbook(s).`))
    out.push(s.dim(`  ${written[0] ?? ''}${written.length > 1 ? ` (and ${String(written.length - 1)} more)` : ''}`))
    out.push(s.dim('  `anvil plan` and `anvil brief` merge these, ranked below curated entries.'))
  }

  const skipped = results.filter((r) => r.entries.length === 0)
  if (skipped.length > 0) {
    out.push('')
    out.push(s.yellow(`Found nothing for: ${skipped.map((r) => r.playbookId).join(', ')}`))
    out.push(s.dim('  The existing cache was left alone. An empty run never overwrites a good one.'))
  }

  if (warnings.length > 0) {
    out.push('')
    out.push(s.yellow(`Warnings (${warnings.length})`))
    for (const w of warnings) out.push(`  ${w}`)
  }

  out.push('')
  out.push(
    s.dim(
      'Nothing was written to registry/playbooks/. `anvil playbook discover --propose` prints what a maintainer would merge.',
    ),
  )
  return out.join('\n')
}

function sourceRows(sources: readonly SourceNote[]): Array<{ source: string; entries: number; detail: string }> {
  return sources.map((n) => ({ source: n.source, entries: n.entries, detail: n.detail }))
}

function renderProposals(ctx: CommandContext, blocks: readonly string[], warnings: readonly string[]): string {
  const s = ctx.style
  const out: string[] = []
  if (blocks.length === 0) {
    out.push(s.green('Nothing to propose. Every discovered entry is already cited by its playbook.'))
  } else {
    out.push(s.bold(`${String(blocks.length)} proposal(s)`))
    out.push(s.dim('Merge what you agree with into registry/playbooks/*.yaml, then `npm run gen:playbooks`.'))
    for (const block of blocks) {
      out.push('')
      out.push(block)
    }
  }
  if (warnings.length > 0) {
    out.push('')
    out.push(s.yellow(`Warnings (${warnings.length})`))
    for (const w of warnings) out.push(`  ${w}`)
  }
  return out.join('\n')
}

/**
 * Local skills already installed for the matched playbooks.
 *
 * Always available, including under `--offline`: it reads files and cannot fail. This is why
 * `plan` and `brief` can list an installed Android skill on a machine with no network and no
 * cache at all -- the source that answers the question cannot be stale, because it is not a
 * fetch.
 */
export function loadLocalForPlan(
  playbooks: ReadonlyArray<{ id: string; discover: DiscoverSeeds }>,
  env: NodeJS.ProcessEnv = process.env,
): Map<string, DiscoveryEntry[]> {
  const live = new Map<string, DiscoveryEntry[]>()
  for (const playbook of playbooks) {
    const entries = discoverLocal(playbook.id, playbook.discover, { env }).entries
    if (entries.length > 0) live.set(playbook.id, entries)
  }
  return live
}

/**
 * The live entries a plan or a brief should merge, and the warnings that came with them.
 *
 * Two halves with different lifetimes, which is the point of splitting them here:
 *
 *   - **Local skills are re-scanned every time.** They are files on this machine, so a skill
 *     installed after the last fetch appears, and one deleted since does not come back from
 *     the cache. A stale cache cannot take them away.
 *   - **Remote entries come from the cache, and only when it is fresh.** A stale cache is
 *     reported and left out -- a week-old search result presented as live guidance is noise
 *     dressed as advice. `--refresh` replaces it with a new answer.
 *
 * A missing or corrupt cache produces a warning and no remote entries, and is not an error.
 * `plan` has to keep working on a machine that has never run `discover`, which is every
 * machine on the first day.
 */
export function loadLiveForPlan(
  playbooks: ReadonlyArray<{ id: string; discover: DiscoverSeeds }>,
  env: NodeJS.ProcessEnv = process.env,
): {
  live: Map<string, DiscoveryEntry[]>
  warnings: string[]
} {
  const live = loadLocalForPlan(playbooks, env)
  const warnings: string[] = []
  for (const playbook of playbooks) {
    const read = loadCache(playbook.id, env)
    if (read.status === 'absent') continue
    if (read.status === 'unreadable') {
      warnings.push(
        `discovery cache for ${playbook.id} is unreadable (${read.detail}); run \`anvil playbook discover ${playbook.id} --refresh\``,
      )
      continue
    }
    if (read.status === 'stale') {
      warnings.push(
        `discovery cache for ${playbook.id} is stale (${read.detail}); its cached remote entries were ignored. Installed skills are still listed. Re-run with --refresh to fetch a new answer.`,
      )
      continue
    }
    // Fresh: the remote half only. The local half was just re-scanned, so keeping the cached
    // copy of it would resurrect an uninstalled skill and double-list an installed one.
    const remote = usableEntries(read).filter((entry) => entry.source !== 'local-scan')
    if (remote.length === 0) continue
    live.set(playbook.id, [...(live.get(playbook.id) ?? []), ...remote])
  }
  return { live, warnings }
}

/**
 * The live entries a plan or a brief should merge, and the warnings that came with them.
 *
 * Three ways to get them, and the flags choose:
 *
 *   - `--offline`: installed skills only. No cache, no network.
 *   - `--refresh`: fetched now, for the playbooks that matched. A refresh that finds
 *     nothing keeps the entries the cache already had, so a registry that is briefly
 *     unreachable costs guidance rather than removing it.
 *   - the default: installed skills plus a fresh cache, read from the home directory. No
 *     network, which is what makes `plan` cheap enough to run on every question.
 */
export async function liveEntriesForPlan(
  playbooks: ReadonlyArray<{ id: string; discover: DiscoverSeeds }>,
  options: {
    offline: boolean
    refresh: boolean
    cwd: string
    /** Injected in the unit test; the real `process.env` in every other call. */
    env?: NodeJS.ProcessEnv
    /** Injected in the unit test; the real one in every other call. */
    refreshLive?: (
      playbooks: ReadonlyArray<{ id: string; discover: DiscoverSeeds }>,
      options: RunOptions,
    ) => Promise<RefreshResult>
  },
): Promise<{ live: Map<string, DiscoveryEntry[]>; warnings: string[] }> {
  const env = options.env ?? process.env
  if (options.offline) return { live: loadLocalForPlan(playbooks, env), warnings: [] }

  if (!options.refresh) return loadLiveForPlan(playbooks, env)

  const refresh = options.refreshLive ?? refreshLive
  const result = await refresh(playbooks, {
    cwd: options.cwd,
    online: true,
    env,
    fetchImpl: liveFetch,
  })
  return { live: mergeLocalInto(result.live, loadLocalForPlan(playbooks, env)), warnings: result.warnings }
}

/**
 * Fold re-scanned local skills into a refreshed map without duplicating them.
 *
 * A refresh already runs the local scan, so this normally changes nothing. It matters when
 * the refresh could not answer for a playbook that still has an installed skill: the machine
 * knows the skill is there, and a failed fetch must not hide it.
 */
function mergeLocalInto(
  live: ReadonlyMap<string, DiscoveryEntry[]>,
  local: ReadonlyMap<string, DiscoveryEntry[]>,
): Map<string, DiscoveryEntry[]> {
  const out = new Map<string, DiscoveryEntry[]>()
  for (const [id, entries] of live) out.set(id, [...entries])
  for (const [id, entries] of local) {
    const existing = out.get(id)
    if (existing === undefined) {
      out.set(id, [...entries])
      continue
    }
    const keys = new Set(existing.map(entryKey))
    for (const entry of entries) {
      const key = entryKey(entry)
      if (keys.has(key)) continue
      keys.add(key)
      existing.push(entry)
    }
  }
  return out
}

/** Identity for the local/remote merge: URL, then install path, then label. */
function entryKey(entry: DiscoveryEntry): string {
  const url = entry.url.trim()
  if (url !== '') return `url:${url.toLowerCase()}`
  const install = (entry.install ?? '').trim()
  if (install !== '') return `install:${install.toLowerCase()}`
  return `label:${entry.label.toLowerCase()}`
}
