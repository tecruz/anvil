/**
 * Fetch live guidance now, for the playbooks that matched, and cache what came back.
 *
 * This is the `--refresh` path. The plan and the brief normally read a cache some earlier
 * run wrote, which costs no network and answers with what was true then; asking for a
 * refresh is asking for a new answer, so this runs the sources and writes the cache again.
 *
 * Two rules carry over from the rest of the package, because they are what makes a refresh
 * safe to run in front of a report:
 *
 *   - A source that fails does not remove another source's results. A run that finds
 *     nothing keeps the entries the cache already had, rather than replacing them with
 *     nothing, and says so in the warnings.
 *   - Nothing is written to the registry. The cache is derived data in the user's own home
 *     directory, and the next run regenerates it.
 */

import type { DiscoverSeeds } from '@anvil/playbooks'
import { loadCache, oldestEntryTimestamp, saveCache, usableEntries } from './cache.ts'
import type { DiscoveryEntry } from './github.ts'
import { mergeBySource } from './merge.ts'
import { type RunOptions, runDiscovery } from './run.ts'

export interface RefreshResult {
  /** The entries to merge, by playbook id. */
  live: Map<string, DiscoveryEntry[]>
  warnings: string[]
  /** The cache files written, for the report to name. */
  cached: string[]
}

/**
 * Refresh the cache for the given playbooks.
 *
 * Only playbooks that declare seeds are fetched: a playbook with nothing to look for has
 * nothing to find, and asking the network about it would spend a rate limit to learn
 * nothing.
 */
export async function refreshLive(
  playbooks: ReadonlyArray<{ id: string; discover: DiscoverSeeds }>,
  options: RunOptions,
): Promise<RefreshResult> {
  const live = new Map<string, DiscoveryEntry[]>()
  const warnings: string[] = []
  const cached: string[] = []
  const env = options.env ?? process.env

  for (const playbook of playbooks) {
    const seeds = playbook.discover
    if (seeds.officialOrgs.length === 0 && seeds.keywords.length === 0 && seeds.mcp.length === 0) continue

    const result = await runDiscovery(playbook, options)
    warnings.push(...result.warnings)

    // The same per-source rule as the cache write: a source that answered replaces its own
    // entries, a source that could not be reached keeps the ones it contributed last time.
    const previous = usableEntries(loadCache(playbook.id, env))
    const entries = mergeBySource(previous, result.entries, result.sources)

    if (result.entries.length === 0) {
      // A refresh that found nothing keeps what the last run found. The cache is only
      // replaced by an answer, and "no answer" is not an answer -- a plan that lost its
      // live guidance because a registry was briefly unreachable would look like the
      // ecosystem having published nothing.
      if (entries.length > 0) live.set(playbook.id, entries)
      warnings.push(`${playbook.id}: the refresh found nothing; the cached entries were kept`)
      continue
    }

    const path = saveCache(
      {
        schemaVersion: 1,
        playbookId: result.playbookId,
        // The age of the cache is the age of its oldest entry, so a half that could not be
        // refreshed keeps reporting itself as old.
        fetchedAt: oldestEntryTimestamp(entries),
        entries,
      },
      env,
    )
    cached.push(path)
    live.set(playbook.id, entries)
  }

  return { live, warnings, cached }
}
