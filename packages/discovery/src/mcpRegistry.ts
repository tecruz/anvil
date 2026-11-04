/**
 * The official MCP registry.
 *
 * A separate source from GitHub search because it answers a different question. Search
 * finds repositories a maintainer *mentions*; the registry lists servers that were
 * *published* to it, which is a stronger claim and the only reason a hit here is worth
 * preferring over an equally-starred GitHub result.
 *
 * The endpoint is injected and defaults to the public registry. That is not configurability
 * for its own sake: the next thing this needs is an enterprise registry, and the seam that
 * makes that a one-line change is the one that makes the unit tests able to avoid the
 * network. Response shapes are treated defensively -- parsing never throws. `parseServers`
 * degrades an unrecognizable payload to an empty list; `fetchMcpServers` keeps "not a registry
 * response" apart from "the registry has no servers", so a shape change becomes a warned
 * failed query rather than an answered empty result.
 */

import { type FetchImpl, requestJson } from './transport.ts'

export const DEFAULT_MCP_REGISTRY = 'https://registry.modelcontextprotocol.io'

export interface McpEntry {
  name: string
  url: string
  description: string | null
}

export interface McpOptions {
  registry?: string
  fetchImpl: FetchImpl
  timeoutMs?: number
  /** Caps the result count, so a broad query cannot flood the cache. */
  limit?: number
}

const DEFAULT_LIMIT = 10

/**
 * The shortest `search` term the registry will accept.
 *
 * The public registry rejects a shorter term with HTTP 422 ("search must contain at least 3
 * characters after trimming surrounding whitespace"). A term below that is not a query that
 * can ever be answered, so asking it would count as a failed query on every run and keep the
 * cache permanently incomplete. The playbook schema rejects such a seed too; the filter in
 * `fetchMcpServers` keeps any other caller from poisoning completeness the same way.
 */
const MIN_SEARCH_CHARS = 3

/** A non-array object, or null. Response shapes are read defensively, never assumed. */
function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

/**
 * The first non-empty string in `values`, or the empty string.
 *
 * Takes an iterable rather than a rest array: a registry record can carry a huge `remotes`
 * list, and spreading it into an argument list overflows the call stack.
 */
function firstString(values: Iterable<unknown>): string {
  for (const value of values) if (typeof value === 'string' && value !== '') return value
  return ''
}

/**
 * A usable, cache-safe URL: absolute, https, and with a host.
 *
 * The original string is returned unchanged -- evidence should be what the registry published,
 * not a normalized rewrite. The value must already start with `https://`, because the cache's
 * own check is exactly that prefix, and a hostless `https://` must be rejected even though a
 * naive prefix test would accept it.
 */
function httpsUrl(value: unknown): string | null {
  if (typeof value !== 'string' || !value.startsWith('https://')) return null
  let parsed: URL
  try {
    parsed = new URL(value)
  } catch {
    return null
  }
  if (parsed.protocol !== 'https:' || parsed.hostname === '') return null
  return value
}

/** The first usable https URL in `values`, or the empty string. */
function firstHttps(values: Iterable<unknown>): string {
  for (const value of values) {
    const url = httpsUrl(value)
    if (url !== null) return url
  }
  return ''
}

/** The first usable https URL among a server's `remotes`, or the empty string. */
function firstRemoteUrl(remotes: readonly unknown[]): string {
  for (const remote of remotes) {
    const url = httpsUrl(asRecord(remote)?.url)
    if (url !== null) return url
  }
  return ''
}

/** The page a server should link to, preferring its repository, then site, then endpoint. */
function serverUrl(record: Record<string, unknown>): string {
  const repository = asRecord(record.repository)
  const remotes = Array.isArray(record.remotes) ? record.remotes : []
  return firstHttps([record.url, repository?.url, record.websiteUrl]) || firstRemoteUrl(remotes)
}

/** Where a record sits in its server's history, as far as the registry says. */
type VersionStatus = 'latest' | 'historical' | 'unknown'

/**
 * Read a record's version status from the registry's own metadata.
 *
 * `latest` and `historical` are stated facts; `unknown` is a record that carries no metadata,
 * which is how a hand-written or older payload looks. The three are kept apart on purpose: a
 * stated `historical` record must not be presented as current, while an unmarked record is all
 * a legacy payload has and is still the best answer available.
 */
function versionStatus(wrapper: Record<string, unknown>): VersionStatus {
  const meta = asRecord(wrapper._meta)
  const entry = meta === null ? null : asRecord(meta['io.modelcontextprotocol.registry/official'])
  if (entry?.isLatest === true) return 'latest'
  if (entry?.isLatest === false) return 'historical'
  return 'unknown'
}

/**
 * Pull server records out of a registry response.
 *
 * Exported because the shape is the thing most likely to change, and a test that pins the
 * parser to a recorded payload is what turns a registry-side change into a failing test
 * rather than an empty plan.
 *
 * The v0 API wraps each record in a `{ server, _meta }` envelope, with the server's own
 * fields -- including `repository` and `remotes` -- nested under `server`. Older payloads
 * put those fields at the top level, so both are read. A server with a repository is
 * preferred over one that only has a connection endpoint, because the repository is the
 * canonical page and the only URL the official-org check can be applied to.
 *
 * Only an https URL is returned. A non-https URL would be dropped by the cache's own check,
 * so keeping it here would make a server appear in one plan and vanish from the next.
 */
export function parseServers(body: string): McpEntry[] {
  return registryEntries(body)?.entries ?? []
}

/**
 * A parsed registry response: the usable servers, and whether the list also held records
 * that are not servers.
 *
 * `malformed` is kept apart from the entries so a body that mixes real servers with junk is
 * neither discarded whole (losing the real ones) nor accepted as a complete answer (silently
 * dropping the rest). A caller marks such a query partial: the fresh entries are kept, the
 * cached ones survive, and the next run asks again.
 */
interface RegistryParse {
  entries: McpEntry[]
  malformed: boolean
}

/**
 * The same parse, with "this is not a registry response" kept apart from "the registry has
 * no servers".
 *
 * `null` is the first case: a proxy login page, an error object, a truncated body, or a list
 * whose every record is junk. Returning an empty array for those -- which `parseServers`
 * must, because it has one return type -- made an HTTP 200 from the wrong server look exactly
 * like an answered, empty registry. The caller uses this form so a bad payload is a failed
 * query rather than a fresh answer. A list that holds at least one real server is parsed
 * instead, with `malformed` recording the records that were not servers.
 */
function registryEntries(body: string): RegistryParse | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(body)
  } catch {
    return null
  }
  // The registry has published under both a bare list and a `{ servers: [...] }` envelope.
  // Both are accepted rather than one, because picking one and asserting on it is how this
  // function ends up returning [] on a registry that did not change anything about itself.
  // Anything else -- an error object, a JSON primitive -- is not a registry response at all.
  const envelope = Array.isArray(parsed) ? parsed : asRecord(parsed)?.servers
  if (!Array.isArray(envelope)) return null
  const raw = envelope
  // One server appears once per published version. The version is resolved *before* the URL is
  // read: a superseded record is never current, and among records that could be current the one
  // with a usable URL wins, so a URL-less legacy duplicate cannot hide a good sibling.
  const chosen = new Map<string, { record: Record<string, unknown>; status: VersionStatus; url: string }>()
  let servers = 0
  let malformed = 0
  for (const item of raw) {
    const wrapper = asRecord(item)
    if (wrapper === null) {
      malformed++
      continue
    }
    const record = asRecord(wrapper.server) ?? wrapper
    const name = firstString([record.name])
    if (name === '') {
      malformed++
      continue
    }
    servers++
    const status = versionStatus(wrapper)
    if (status === 'historical') continue
    const url = serverUrl(record)
    const existing = chosen.get(name)
    if (existing === undefined) {
      chosen.set(name, { record, status, url })
      continue
    }
    const wins =
      (status === 'latest' && existing.status !== 'latest') ||
      (status === existing.status && url !== '' && existing.url === '')
    if (wins) chosen.set(name, { record, status, url })
  }
  // A non-empty list with not one recognizable server is not a registry response. An error
  // record, or a payload whose `name` field moved, is a body from something other than the
  // registry -- and reading it as an answered, empty search erased the cached MCP entries and
  // marked the cache complete. A genuinely empty list still is an answer, and so is a list
  // whose servers were all filtered out for being historical or having no usable https URL:
  // those carried names, which is what tells a real record apart from junk.
  if (raw.length > 0 && servers === 0) return null
  const out: McpEntry[] = []
  for (const [name, { record, url }] of chosen) {
    if (url === '') continue
    out.push({
      name,
      url,
      description: typeof record.description === 'string' ? record.description : null,
    })
  }
  return { entries: out, malformed: malformed > 0 }
}

/**
 * Query the registry for servers matching any of a playbook's terms.
 *
 * Returns `{ entries, detail, answered }` rather than throwing: an unreachable registry is
 * a warning and nothing else. A run that cannot reach one of three sources still returns the
 * other two.
 *
 * `answered` is the part that matters. "The registry answered and no server matched" and
 * "the registry could not be reached" are different facts, and the detail string alone
 * cannot carry the difference safely -- a report that says "answered" when nothing was
 * asked is a report that lies in the reassuring direction. `complete` is the second question:
 * every query answered *and* every answered body was a registry response, so a mixed or
 * partially failed body is not reused as a finished answer. `skipped` is set when no request
 * was made because every term was too short to search: a configuration error, not an answer,
 * so the caller can say so instead of reporting an unreachable registry.
 */
export async function fetchMcpServers(
  terms: readonly string[],
  options: McpOptions,
): Promise<{ entries: McpEntry[]; detail: string; answered: boolean; complete: boolean; skipped: boolean }> {
  // A term the registry cannot search is not a query. Dropping it before the request is what
  // stops a bad seed from marking the cache incomplete forever: there is no answer to wait
  // for, so there is nothing to retry, and a list that still has searchable terms is complete.
  const searchable = terms.map((term) => term.trim()).filter((term) => term.length >= MIN_SEARCH_CHARS)
  if (searchable.length === 0) {
    // Two different situations, and only one of them is an answer. No terms at all is a
    // complete "nothing to ask". Every term being unsearchable is a configuration error: no
    // request was made, so calling it an answered empty registry would let a merge erase the
    // cached servers on a run that asked nothing. It is marked unanswered, and the skip is
    // reported separately so the warning does not claim the registry was unreachable. The
    // playbook schema rejects such a seed before this point; this keeps a direct caller safe.
    const seeded = terms.length > 0
    return {
      entries: [],
      detail: seeded
        ? 'no mcp term is long enough for the registry to search, so nothing was asked'
        : 'no mcp terms seeded',
      answered: !seeded,
      complete: !seeded,
      skipped: seeded,
    }
  }
  const registry = (options.registry ?? DEFAULT_MCP_REGISTRY).replace(/\/+$/, '')
  const limit = options.limit ?? DEFAULT_LIMIT
  const seen = new Map<string, McpEntry>()
  let asked = 0
  let failed = 0
  let invalid = 0
  let malformed = 0

  for (const term of searchable) {
    // `version=latest` is the registry's own filter for "one record per server, the current
    // one". Without it a widely-published server contributes its whole version history.
    const url = `${registry}/v0/servers?search=${encodeURIComponent(term)}&limit=${String(limit)}&version=latest`
    const res = await requestJson(url, {
      fetchImpl: options.fetchImpl,
      ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
    })
    if (res.transportError !== undefined) {
      failed++
      continue
    }
    if (res.status !== 200) {
      failed++
      continue
    }
    // A 200 is not automatically an answer. A proxy login page, an error object, or a body
    // from a registry that changed its shape parses to `null`, and counting it as "the
    // registry answered and found nothing" would erase the cached MCP entries and mark the
    // cache complete. Treat it as a failed query instead.
    const parsed = registryEntries(res.body)
    if (parsed === null) {
      invalid++
      continue
    }
    asked++
    // A list that held real servers *and* records that are not servers is answered but not
    // complete: the good records are kept, the query is remembered as unfinished, and the
    // next run asks again rather than trusting a body that half-made sense.
    if (parsed.malformed) malformed++
    for (const entry of parsed.entries) {
      if (!seen.has(entry.name)) seen.set(entry.name, entry)
    }
  }

  const unanswered = failed + invalid
  const entries = [...seen.values()].slice(0, limit)
  const detail =
    asked === 0
      ? invalid > 0 && failed === 0
        ? 'the registry answered, but not with a registry response'
        : 'the registry could not be reached'
      : unanswered > 0
        ? `registry: ${String(entries.length)} server(s), ${String(unanswered)} of ${String(searchable.length)} query(s) did not answer`
        : malformed > 0
          ? `registry: ${String(entries.length)} server(s), ${String(malformed)} of ${String(searchable.length)} query(s) returned malformed records`
          : entries.length === 0
            ? 'registry answered, no servers matched'
            : `registry: ${String(entries.length)} server(s)`
  return { entries, detail, answered: asked > 0, complete: unanswered === 0 && malformed === 0, skipped: false }
}
