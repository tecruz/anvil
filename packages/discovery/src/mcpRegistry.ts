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
 * network. Response shapes are treated defensively -- `parseServers` returns an empty array
 * rather than throwing, so a registry that changes its payload degrades to "found nothing"
 * and says so in the source note, instead of failing the whole run.
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
 * Pull server records out of a registry response.
 *
 * Exported because the shape is the thing most likely to change, and a test that pins the
 * parser to a recorded payload is what turns a registry-side change into a failing test
 * rather than an empty plan.
 */
export function parseServers(body: string): McpEntry[] {
  let parsed: unknown
  try {
    parsed = JSON.parse(body)
  } catch {
    return []
  }
  // The registry has published under both a bare list and a `{ servers: [...] }` envelope.
  // Both are accepted rather than one, because picking one and asserting on it is how this
  // function ends up returning [] on a registry that did not change anything about itself.
  const raw = Array.isArray(parsed)
    ? parsed
    : Array.isArray((parsed as { servers?: unknown }).servers)
      ? (parsed as { servers: unknown[] }).servers
      : []
  const out: McpEntry[] = []
  for (const item of raw) {
    const record = item as {
      name?: unknown
      description?: unknown
      url?: unknown
      repository?: { url?: unknown }
    }
    const name = typeof record.name === 'string' ? record.name : ''
    if (name === '') continue
    const direct = typeof record.url === 'string' ? record.url : ''
    const repoUrl = typeof record.repository?.url === 'string' ? record.repository.url : ''
    const url = direct !== '' ? direct : repoUrl
    if (url === '') continue
    out.push({
      name,
      url,
      description: typeof record.description === 'string' ? record.description : null,
    })
  }
  return out
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
 * asked is a report that lies in the reassuring direction.
 */
export async function fetchMcpServers(
  terms: readonly string[],
  options: McpOptions,
): Promise<{ entries: McpEntry[]; detail: string; answered: boolean }> {
  if (terms.length === 0) return { entries: [], detail: 'no mcp terms seeded', answered: true }
  const registry = (options.registry ?? DEFAULT_MCP_REGISTRY).replace(/\/+$/, '')
  const limit = options.limit ?? DEFAULT_LIMIT
  const seen = new Map<string, McpEntry>()
  let asked = 0
  let failed = 0

  for (const term of terms) {
    const url = `${registry}/v0/servers?search=${encodeURIComponent(term)}&limit=${String(limit)}`
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
    asked++
    for (const entry of parseServers(res.body)) {
      if (!seen.has(entry.name)) seen.set(entry.name, entry)
    }
  }

  const entries = [...seen.values()].slice(0, limit)
  const detail =
    asked === 0
      ? 'the registry could not be reached'
      : failed > 0
        ? `registry: ${String(entries.length)} server(s), ${String(failed)} of ${String(terms.length)} query(s) failed`
        : entries.length === 0
          ? 'registry answered, no servers matched'
          : `registry: ${String(entries.length)} server(s)`
  return { entries, detail, answered: asked > 0 }
}
