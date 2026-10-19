/**
 * The discovery cache: where live results go, and when they are no longer trusted.
 *
 * A cache rather than an in-place registry edit, and that is the whole argument in one
 * sentence: `registry/playbooks/*.yaml` is reviewed, hand-maintained data, and a tool that
 * writes to it makes a fetch a content change. The cache is the opposite -- derived,
 * disposable, and labelled with when it was derived.
 *
 * It lives under `~/.anvil/cache/discovery/` rather than in the repository, for two reasons.
 * The results describe ecosystems, not this project, so committing them would put a
 * technology's 2026 state into a repository in 2027. And anvil must work in a repo the user
 * is not allowed to modify, which is a rule the rest of this codebase already holds to.
 *
 * A corrupt or unreadable cache is treated as absent, with a warning. The alternative --
 * throwing -- turns a half-written file from an interrupted run into a tool that cannot
 * start, for a file whose entire purpose is to be regenerated.
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { CONFIG_DIR_NAME } from '@anvil/core'
import type { DiscoveryEntry } from './github.ts'

export const CACHE_DIR_NAME = 'discovery'

/** Seven days. Long enough that `plan` is useful daily, short enough that a dead link is gone. */
export const DEFAULT_TTL_DAYS = 7

const TTL_MS = DEFAULT_TTL_DAYS * 24 * 60 * 60 * 1000

export interface CacheFile {
  schemaVersion: 1
  playbookId: string
  /**
   * When the cache's *oldest* entry was fetched.
   *
   * Not when the file was written. The two differ as soon as a run merges: a local scan
   * today plus network entries from last month is a file written today and as old as its
   * oldest answer, and a timestamp that said "today" would make a month-old half look
   * fresh. The age of the cache is the age of the least fresh thing in it.
   */
  fetchedAt: string
  entries: DiscoveryEntry[]
}

export type CacheStatus = 'fresh' | 'stale' | 'absent' | 'unreadable'

export interface CacheRead {
  status: CacheStatus
  cache: CacheFile | null
  /** Human-readable explanation for `stale` and `unreadable`, so neither is silent. */
  detail: string
  path: string
}

/**
 * Cache directory for the current environment.
 *
 * `ANVIL_CONFIG_HOME` is honoured for the same reason `globalConfigPath` honours it: it is
 * how the tests get a temporary home instead of the developer's real one, and a test that
 * writes to a real home directory is a test that fails on a machine with a real cache.
 */
export function discoveryCacheDir(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.ANVIL_CONFIG_HOME
  const home = override !== undefined && override !== '' ? resolve(override) : homedir()
  return join(home, CONFIG_DIR_NAME, 'cache', CACHE_DIR_NAME)
}

export function cachePathFor(playbookId: string, env: NodeJS.ProcessEnv = process.env): string {
  return join(discoveryCacheDir(env), `${playbookId}.json`)
}

/**
 * Read one playbook's cached entries.
 *
 * Never throws. Four outcomes, all of which a caller can act on, and none of which is the
 * silent-empty-list that would make a run look like it found nothing when it looked nothing up.
 */
export function loadCache(playbookId: string, env: NodeJS.ProcessEnv = process.env): CacheRead {
  const path = cachePathFor(playbookId, env)
  let text: string
  try {
    text = readFileSync(path, 'utf8')
  } catch {
    return { status: 'absent', cache: null, detail: 'no cache yet', path }
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch (err) {
    return {
      status: 'unreadable',
      cache: null,
      detail: `cache is not valid JSON (${err instanceof Error ? err.message : String(err)})`,
      path,
    }
  }

  const record = parsed as Partial<CacheFile>
  if (record === null || typeof record !== 'object' || !Array.isArray(record.entries)) {
    return { status: 'unreadable', cache: null, detail: 'cache is not a discovery record', path }
  }
  if (typeof record.fetchedAt !== 'string' || record.fetchedAt === '') {
    return { status: 'unreadable', cache: null, detail: 'cache has no fetch timestamp', path }
  }
  const age = Date.now() - Date.parse(record.fetchedAt)
  if (!Number.isFinite(age)) {
    return { status: 'unreadable', cache: null, detail: `cache timestamp is not a date: ${record.fetchedAt}`, path }
  }

  const cache: CacheFile = {
    schemaVersion: 1,
    playbookId,
    fetchedAt: record.fetchedAt,
    entries: record.entries,
  }
  if (age > TTL_MS) {
    const days = Math.round(age / (24 * 60 * 60 * 1000))
    return {
      status: 'stale',
      cache,
      detail: `cached ${String(days)} day(s) ago; run \`anvil playbook discover ${playbookId} --refresh\``,
      path,
    }
  }
  return { status: 'fresh', cache, detail: `cached ${record.fetchedAt}`, path }
}

/**
 * Write one playbook's entries.
 *
 * Written to a sibling temp file and renamed, because a cache that can be read while it is
 * half-written is a cache that produces a corrupt record the next time the process is
 * killed. Rename is atomic within a filesystem, so a reader sees the old file or the new
 * one and never a fragment.
 */
export function saveCache(file: CacheFile, env: NodeJS.ProcessEnv = process.env): string {
  const path = cachePathFor(file.playbookId, env)
  mkdirSync(dirname(path), { recursive: true })
  const tmp = `${path}.tmp`
  writeFileSync(tmp, `${JSON.stringify(file, null, 2)}\n`, 'utf8')
  renameSync(tmp, path)
  return path
}

/** Entries from a cache read, dropping any that fail the shape check. */
export function usableEntries(read: CacheRead): DiscoveryEntry[] {
  if (read.cache === null) return []
  return read.cache.entries.filter(isEntry)
}

/**
 * The timestamp of the oldest entry, which is the age of the cache.
 *
 * Falls back to now when no entry carries a usable timestamp, because a cache that cannot
 * be aged must not read as brand new.
 */
export function oldestEntryTimestamp(entries: readonly DiscoveryEntry[]): string {
  let oldest = Number.POSITIVE_INFINITY
  for (const entry of entries) {
    const parsed = Date.parse(entry.fetchedAt)
    if (Number.isFinite(parsed) && parsed < oldest) oldest = parsed
  }
  return new Date(Number.isFinite(oldest) ? oldest : Date.now()).toISOString()
}

/**
 * A cache is a file on disk that any process may have written, so it is validated like any
 * other untrusted input rather than trusted because it is in the user's own home directory.
 *
 * The URL rule is deliberately narrower than "must be https": a `local-scan` entry has no
 * URL at all, because what it points at is a `SKILL.md` path on this machine rather than
 * something to open. Dropping those would silently delete the only source that works
 * offline, so the rule is "https, or empty only when the source is a local scan".
 */
export function isEntry(value: unknown): value is DiscoveryEntry {
  if (value === null || typeof value !== 'object') return false
  const e = value as Partial<DiscoveryEntry>
  if (typeof e.label !== 'string' || e.label === '') return false
  if (typeof e.why !== 'string' || e.why.trim() === '') return false
  if (e.tier !== 'official' && e.tier !== 'community') return false
  if (typeof e.url !== 'string') return false
  if (e.url === '') return e.source === 'local-scan' && typeof e.install === 'string'
  return e.url.startsWith('https://')
}
