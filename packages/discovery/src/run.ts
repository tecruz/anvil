/**
 * The run: every source, for one playbook or all of them, into the cache.
 *
 * This is where the package's rules are enforced rather than described. Sources are
 * independent and each contributes what it can; a failure is recorded on the source note and
 * in `warnings`, never by silently shortening the list. The cache is written only from what
 * actually came back, and only when something did -- an empty run over a working network
 * would otherwise overwrite a good cache with an empty one and turn a transient rate limit
 * into a week of "anvil found nothing".
 */

import { type DiscoverSeeds, normalizeUrl } from '@anvil/playbooks'
import {
  type DiscoverOptions,
  type DiscoveryEntry,
  type DiscoverySource,
  discover as discoverGitHub,
  type SourceNote,
} from './github.ts'
import { type LocalSkill, scanLocalSkills, skillMatchesSeeds } from './localScan.ts'
import { DEFAULT_MCP_REGISTRY, fetchMcpServers } from './mcpRegistry.ts'

export interface RunOptions extends DiscoverOptions {
  /** Skip the network sources. The local scan still runs. */
  localOnly?: boolean
  env?: NodeJS.ProcessEnv
  /** MCP registry base. Defaults to the public one. */
  mcpRegistry?: string
}

export interface RunResult {
  playbookId: string
  entries: DiscoveryEntry[]
  sources: SourceNote[]
  warnings: string[]
  /** Entries that were already in the cache before this run, for a refresh report. */
  kept: number
}

/** Terms a local skill is matched against: the playbook id, its words, and its keywords. */
export function matchTerms(playbookId: string, seeds: DiscoverSeeds): string[] {
  const terms = new Set<string>()
  terms.add(playbookId)
  for (const part of playbookId.split('-')) if (part.length >= 4) terms.add(part)
  for (const keyword of seeds.keywords) {
    // The leading word of each keyword is the technology name; the rest is the qualifier
    // ("android agent skills" -> "android"). Matching on the whole phrase would miss a skill
    // described as "Skills for Android development".
    const head = keyword.trim().split(/\s+/)[0]
    if (head !== undefined && head.length >= 4) terms.add(head)
  }
  return [...terms]
}

/**
 * The local scan, as a source note plus entries.
 *
 * Always runs, including under `--local-only` and `--offline`: it reads files, so there is no
 * reason for it to be gated behind a network flag, and it is the source that makes the
 * package useful on the machine the user is actually sitting at.
 *
 * Takes only the `env` it needs rather than the whole `RunOptions`, so it is callable from a
 * test -- or from `plan` -- without constructing a `FetchImpl` it will never use. That is the
 * point of this function: it has no network dependency to satisfy.
 */
export function discoverLocal(
  playbookId: string,
  seeds: DiscoverSeeds,
  options: { env?: NodeJS.ProcessEnv } = {},
): { entries: DiscoveryEntry[]; note: SourceNote } {
  const skills = scanLocalSkills(options.env === undefined ? {} : { env: options.env })
  const terms = matchTerms(playbookId, seeds)
  const matched = skills.filter((s) => skillMatchesSeeds(s, terms))

  // Grouped by name, because a skill is routinely installed in more than one tool's
  // directory -- the same `navigation-3` under `~/.agents/skills`, `~/.claude/skills` and
  // `~/.config/opencode/skills` is one skill, not three, and listing it three times makes a
  // plan look like it found three things when it found one.
  //
  // The count of locations is kept and reported rather than discarded, because three copies
  // of one skill is itself a fact worth knowing: they drift, and a user who edited one of
  // them has changed only that one.
  const byName = new Map<string, LocalSkill[]>()
  for (const skill of matched) {
    const key = skill.name.toLowerCase()
    const list = byName.get(key)
    if (list === undefined) byName.set(key, [skill])
    else list.push(skill)
  }

  const fetchedAt = new Date().toISOString()
  const entries: DiscoveryEntry[] = []
  for (const group of [...byName.values()].sort((a, b) => a[0]!.name.localeCompare(b[0]!.name))) {
    const first = group[0]
    if (first === undefined) continue
    const elsewhere = group.slice(1).map((s) => s.root)
    const locations =
      group.length === 1
        ? ''
        : ` Also installed in ${String(group.length - 1)} other location(s) (${elsewhere.join(', ')}); copies can drift.`
    entries.push({
      label: first.name,
      // A local skill has no URL of its own, so the evidence is the file that proves it. The
      // plan renders a link, and a `file://` URL would be worse than none, so `url` is empty
      // and the path goes in `why` and `install`.
      url: '',
      why: `Installed on this machine at ${first.path}. ${first.description || 'No description in its SKILL.md.'} Found by scanning the agent skills directories; this proves it is installed, not who maintains it.${locations}`,
      tier: 'official',
      section: 'skills',
      source: 'local-scan' satisfies DiscoverySource,
      fetchedAt,
      stars: null,
      install: first.path,
      repo: null,
      owner: null,
    })
  }

  return {
    entries,
    note: {
      source: 'local-scan',
      detail:
        matched.length === 0
          ? `scanned ${String(skills.length)} installed skill(s), none for this technology`
          : `scanned ${String(skills.length)} installed skill(s), ${String(entries.length)} for this technology`,
      entries: entries.length,
    },
  }
}

/** Discover one playbook across every source. */
export async function runDiscovery(
  playbook: { id: string; discover: DiscoverSeeds },
  options: RunOptions,
): Promise<RunResult> {
  const { id, discover: seeds } = playbook
  const warnings: string[] = []
  const sources: SourceNote[] = []
  const entries: DiscoveryEntry[] = []

  const local = discoverLocal(id, seeds, options)
  sources.push(local.note)
  entries.push(...local.entries)

  if (options.localOnly === true || options.online === false) {
    sources.push({ source: 'github-search', detail: 'skipped (--local-only or offline)', entries: 0 })
    // Dedupe here as well as below. This early return was the bug: `--local-only` produced
    // raw entries while a full run produced deduped ones, so the same machine gave two
    // different answers for the same skills depending on a flag.
    return { playbookId: id, entries: dedupeEntries(entries), sources, warnings, kept: 0 }
  }

  const github = await discoverGitHub(id, seeds, options)
  sources.push(...github.sources)
  entries.push(...github.entries)
  warnings.push(...github.warnings)

  if (seeds.mcp.length > 0) {
    const mcp = await fetchMcpServers(seeds.mcp, {
      fetchImpl: options.fetchImpl,
      ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
      ...(options.mcpRegistry === undefined ? {} : { registry: options.mcpRegistry }),
    })
    const mcpEntries: DiscoveryEntry[] = mcp.entries.map((server) => ({
      label: server.name,
      url: server.url,
      why: `${server.description ?? 'No description published.'} Listed in the official MCP registry${options.mcpRegistry === undefined || options.mcpRegistry === DEFAULT_MCP_REGISTRY ? '' : ` (${options.mcpRegistry})`}.`,
      tier: 'community',
      section: 'mcp',
      source: 'mcp-registry',
      fetchedAt: new Date().toISOString(),
      stars: null,
      install: null,
      repo: null,
      owner: null,
    }))
    entries.push(...mcpEntries)
    sources.push({ source: 'mcp-registry', detail: mcp.detail, entries: mcpEntries.length })
  }

  return { playbookId: id, entries: dedupeEntries(entries), sources, warnings, kept: 0 }
}

/**
 * Deduplicate, keeping the higher-ranked entry.
 *
 * Three key schemes, because the three kinds of entry have three different identities. A
 * repository is its URL. A local skill is its *name*, not its path -- the same skill
 * installed under two tool directories is one skill, and keying on the path reported it
 * twice. And an install path is the last resort, so a nameless local entry still collapses.
 *
 * Official beats community, and among equals the record with a star count is the better one,
 * so that an org-scoped search result is not displaced by a keyword search's version of it.
 */
export function dedupeEntries(entries: readonly DiscoveryEntry[]): DiscoveryEntry[] {
  const byKey = new Map<string, DiscoveryEntry>()
  for (const entry of entries) {
    const key =
      entry.url.trim() === ''
        ? entry.source === 'local-scan'
          ? `name:${entry.label.toLowerCase()}`
          : `path:${entry.install ?? entry.label}`
        : `url:${normalizeUrl(entry.url)}`
    const existing = byKey.get(key)
    if (existing === undefined) {
      byKey.set(key, entry)
      continue
    }
    if (existing.tier === 'community' && entry.tier === 'official') byKey.set(key, entry)
    else if (existing.tier === entry.tier && existing.stars === null && entry.stars !== null) byKey.set(key, entry)
  }
  return [...byKey.values()]
}

/** Discover one playbook across every source. */
