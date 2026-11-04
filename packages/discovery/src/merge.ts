/**
 * Combining this run's entries with the ones the cache already had.
 *
 * The rule is one sentence: **a source that answered completely replaces its own entries; a
 * source that could not be reached, or answered only part of its queries, keeps them.**
 *
 * The obvious implementation -- write whatever this run found -- has a failure mode that
 * is easy to miss and expensive to notice. Discovery has three sources that answer
 * independently. A run where GitHub is rate-limited but the MCP registry answers used to
 * write a cache holding only the MCP entries: the GitHub half was erased by a source that
 * simply did not run. The next plan then showed fewer live entries than the one before it,
 * with nothing to say why, and the honest-looking conclusion -- that the ecosystem had
 * published less -- was the one conclusion the tool was entitled to draw.
 *
 * So the merge is per source and, within a source, per answer. A source that answered every
 * query has a fresh answer and replaces its old entries, including when the answer is
 * "nothing matched" -- that is a real answer and it replaces a stale one. A source that could
 * not be reached keeps its last answer, with its own age, because not knowing is not the same
 * as knowing there is nothing. A source that answered some queries and failed others is the
 * mixed case: the fresh entries are added, but the old ones are kept too, because the cache
 * cannot tell which old entry came from the query that failed. The cache is marked incomplete,
 * so the next run asks again and can then drop what is genuinely gone.
 */

import type { DiscoveryEntry, DiscoverySource, SourceNote } from './github.ts'
import { dedupeEntries } from './run.ts'

/**
 * Merge this run's entries with the previous ones, per source.
 *
 * `notes` are the source notes of this run. A source that appears and answered every query
 * replaces its previous entries; a source that did not answer, answered partially, or did not
 * run at all keeps them.
 */
export function mergeBySource(
  previous: readonly DiscoveryEntry[],
  fresh: readonly DiscoveryEntry[],
  notes: readonly SourceNote[],
): DiscoveryEntry[] {
  const answered = new Set<DiscoverySource>()
  for (const note of notes) {
    if (note.answered && note.complete !== false) answered.add(note.source)
  }
  const kept = previous.filter((entry) => !answered.has(entry.source))
  return dedupeEntries([...fresh, ...kept])
}

/**
 * The sources this run could not get an answer from.
 *
 * For the report, and for the caller that has to say which half of the cache is stale.
 */
export function unansweredSources(notes: readonly SourceNote[]): DiscoverySource[] {
  const out: DiscoverySource[] = []
  for (const note of notes) {
    if (!note.answered && !out.includes(note.source)) out.push(note.source)
  }
  return out
}
