/**
 * `anvil playbook check` -- the rot check.
 *
 * The plan's risk table names playbook rot as a real failure mode and states the
 * mitigation: "anvil playbook check validates every URL and version range and runs in CI".
 * This module is that mitigation, with one honest narrowing: **the schema has no
 * version-range field.** There is nothing in `Resource`, `PlaybookVerify` or `Playbook`
 * that expresses a version constraint, so there is nothing to validate. What is here
 * instead is the set of checks the data can actually support, and the narrowing is
 * recorded in the plan rather than papered over with a fake field.
 *
 * Two layers, deliberately separated:
 *
 *   - **Structural checks** are pure and offline. They answer questions that have a right
 *     answer on the developer's machine: is every URL absolute https, does every resource
 *     say why it is worth reading, which risk globs are claimed by two playbooks, does any
 *     URL appear in two playbooks at once. They are deterministic, so they belong in the
 *     normal test suite and in the CI matrix.
 *
 *   - **Reachability** needs the network, so it is injected (`fetch`), bounded in
 *     concurrency, given a per-request timeout, and skipped entirely by `--offline`. The
 *     classification is the delicate part, and it is biased hard toward *not* crying wolf:
 *     only 404 and 410 count as rot. A 403 from a bot-blocking CDN, a 429 rate limit, a
 *     timeout and a 5xx are all reported as "unconfirmed", because a check that fails on a
 *     flaky network gets disabled, and a disabled rot check is worse than none -- it looks
 *     like coverage.
 *
 * Everything here is pure logic with injected I/O, so the whole thing is unit-testable
 * without a socket. That is the same discipline the gh transport follows, and it is the
 * reason the `--hostname` bug could not be caught by tests: the seam has to be injectable
 * *and* someone has to use the real thing. The live suite covers that half.
 */

import type { Playbook, Resource } from './schema.ts'

/**
 * Severity of a structural problem.
 *
 * `error` means rot or a defect: a dead link, a duplicate id, a URL that cannot be opened.
 * `warn` means something a human should look at but that has a defensible reason to exist
 * (a glob claimed twice on purpose, a resource with no explanation). `info` is a note, such
 * as advice that only works when a wrapper is committed.
 */
export type ProblemLevel = 'error' | 'warn' | 'info'

export interface Problem {
  level: ProblemLevel
  /** Where the problem is, as `playbookId.section[index]` or a bare playbook id. */
  where: string
  message: string
  /** The fix, when there is an obvious one. A problem without a fix is a to-do. */
  fix?: string
}

export interface UrlStatus {
  url: string
  /** Which playbooks cite it. */
  citedBy: string[]
  outcome: 'ok' | 'gone' | 'unconfirmed'
  /** HTTP status or transport error, for the report. */
  detail: string
}

export interface CheckReport {
  problems: Problem[]
  urls: UrlStatus[]
  counts: Record<ProblemLevel, number>
  /** False when nothing is wrong, so the CLI can pick an exit code. */
  ok: boolean
}

// ---------------------------------------------------------------------------
// Structural checks (offline, pure)
// ---------------------------------------------------------------------------

/** Every URL a playbook cites, with which section it came from. */
export function collectUrls(playbooks: readonly Playbook[]): Array<{ url: string; where: string }> {
  const out: Array<{ url: string; where: string }> = []
  for (const playbook of playbooks) {
    const groups: Array<[string, Resource[]]> = [
      ['docs', playbook.official.docs],
      ['skills', playbook.official.skills],
      ['agents', playbook.official.agents],
      ['mcp', playbook.official.mcp],
      ['styleGuides', playbook.official.styleGuides],
      ['migrationGuides', playbook.official.migrationGuides],
      ['community', playbook.community],
    ]
    for (const [section, resources] of groups) {
      resources.forEach((r, i) => {
        if (r.url !== '') out.push({ url: r.url, where: `${playbook.id}.${section}[${i}]` })
      })
    }
  }
  return out
}

function isAbsoluteHttps(url: string): boolean {
  return /^https:\/\/[^\s]+$/.test(url)
}

/**
 * Structural problems, computed from the loaded playbooks.
 *
 * Deliberately narrow. Every rule here has a case where being wrong produces a false alarm,
 * and a false alarm in a rot check is how the check gets turned off.
 */
export function checkStructure(playbooks: readonly Playbook[]): Problem[] {
  const problems: Problem[] = []
  const byId = new Map(playbooks.map((p) => [p.id, p]))

  for (const playbook of playbooks) {
    // A duplicate id is silent data loss: the merge in `loadPlaybooksFromDirectory` is
    // keyed by id, so two files claiming one id means one of them is never used.
    if (playbooks.filter((p) => p.id === playbook.id).length > 1) {
      problems.push({
        level: 'error',
        where: playbook.id,
        message: `duplicate playbook id: ${playbook.id}`,
        fix: 'Playbook ids are the merge key. Two files claiming one id means one is silently unused.',
      })
    }

    if (playbook.title.trim() === '') {
      problems.push({
        level: 'error',
        where: playbook.id,
        message: 'empty title',
        fix: 'Give it a title a reader can scan.',
      })
    }

    const groups: Array<[string, Resource[]]> = [
      ['docs', playbook.official.docs],
      ['skills', playbook.official.skills],
      ['agents', playbook.official.agents],
      ['mcp', playbook.official.mcp],
      ['styleGuides', playbook.official.styleGuides],
      ['migrationGuides', playbook.official.migrationGuides],
      ['community', playbook.community],
    ]
    let resources = 0
    for (const [section, list] of groups) {
      list.forEach((r, i) => {
        resources++
        const where = `${playbook.id}.${section}[${i}]`
        if (!isAbsoluteHttps(r.url)) {
          problems.push({
            level: 'error',
            where,
            message: `url is not an absolute https URL: ${JSON.stringify(r.url)}`,
            fix: 'Use a full https:// URL. A relative or http URL cannot be opened by a reader or probed by `playbook check`.',
          })
        }
        // An empty `why` is the thing the plan forbids most explicitly: a list of links
        // with no reason to read them is browsing, not guidance.
        if (r.why.trim() === '') {
          problems.push({
            level: 'warn',
            where,
            message: 'resource has no `why`',
            fix: 'Say what the reader gets from it. An unexplained link is not guidance.',
          })
        }
        if (r.label.trim() === '') {
          problems.push({ level: 'warn', where, message: 'resource has no `label`' })
        }
      })
    }
    if (resources === 0) {
      problems.push({
        level: 'warn',
        where: playbook.id,
        message: 'playbook offers no resources at all',
        fix: 'A playbook with no docs, skills or MCP servers cannot help anybody; it only adds a match.',
      })
    }

    // A `verify` command that names a wrapper the ecosystem does not ship is advice that
    // cannot be run. `./gradlew` and `./mvnw` are the two that matter, because they only
    // work when the wrapper is committed.
    for (const [kind, commands] of Object.entries(playbook.verify)) {
      for (const command of commands) {
        if (/^\s*(\.\/)?(gradlew|mvnw)\b/.test(command) && !command.includes('wrapper')) {
          problems.push({
            level: 'info',
            where: `${playbook.id}.verify.${kind}`,
            message: `verify command assumes a committed wrapper: ${JSON.stringify(command)}`,
            fix: 'Fine as advice, but it only runs when the wrapper is committed. The plan suggests telling the reader that.',
          })
        }
      }
    }
  }

  // Risk globs claimed by more than one playbook. This is not automatically wrong -- the
  // android/jvm overlap is intentional, resolved by priority at plan time -- so it is
  // reported so a human can confirm the winner is the specific one.
  const globOwners = new Map<string, string[]>()
  for (const playbook of playbooks) {
    for (const glob of playbook.riskGlobs) {
      if (!globOwners.has(glob)) globOwners.set(glob, [])
      ;(globOwners.get(glob) as string[]).push(playbook.id)
    }
  }
  for (const [glob, owners] of [...globOwners.entries()].sort()) {
    if (owners.length < 2) continue
    const ids = [...owners].sort()
    const highest = ids
      .map((id) => byId.get(id))
      .filter((p): p is Playbook => p !== undefined)
      .sort((a, b) => b.priority - a.priority)[0]
    problems.push({
      level: 'warn',
      where: ids.join(', '),
      message: `risk glob ${JSON.stringify(glob)} is claimed by ${owners.length} playbooks (${ids.join(', ')})`,
      fix: `Resolved at plan time by priority; ${highest?.id ?? 'unknown'} wins. Confirm that is the more specific playbook.`,
    })
  }

  // The same URL in two playbooks prints twice for a reader who matches both. The plan
  // calls this out for the android Compose docs, so it is worth surfacing.
  const urlOwners = new Map<string, string[]>()
  for (const { url, where } of collectUrls(playbooks)) {
    const owner = where.split('.')[0] as string
    if (!urlOwners.has(url)) urlOwners.set(url, [])
    ;(urlOwners.get(url) as string[]).push(owner)
  }
  for (const [url, owners] of [...urlOwners.entries()].sort()) {
    if (owners.length < 2) continue
    problems.push({
      level: 'warn',
      where: [...new Set(owners)].sort().join(', '),
      message: `${url} is cited by ${owners.length} playbooks (${[...new Set(owners)].sort().join(', ')})`,
      fix: 'A reader matching both sees it twice. Keep it in the more specific playbook.',
    })
  }

  return problems
}

// ---------------------------------------------------------------------------
// Reachability (network, injected)
// ---------------------------------------------------------------------------

/** The subset of `fetch` this module uses, so a test can supply its own. */
export type ProbeFetch = (
  url: string,
  init: { method: string; redirect: 'follow'; signal: AbortSignal },
) => Promise<{ status: number }>

export interface ProbeOptions {
  fetchImpl?: ProbeFetch
  concurrency?: number
  timeoutMs?: number
}

/**
 * Classify one HTTP status.
 *
 * The whole design of this function is "do not cry wolf". Only a status that means *this
 * resource is not there any more* is rot:
 *
 *   - 404, 410: gone. Real rot, and the reason this command exists.
 *   - 401, 403: exists, or is behind a bot wall. `unconfirmed`, never an error: a great
 *     many documentation sites answer HEAD with 403 and serve the page fine to a browser.
 *   - 405: the server dislikes the method. Fall back to GET.
 *   - 429, 5xx: transient. Unconfirmed.
 *   - 2xx, 3xx: fine.
 *
 * A rot check that fails on a rate limit or a CDN hiccup is a rot check that gets disabled,
 * and a disabled check reads as coverage in every dashboard that counts green runs.
 */
export function classifyStatus(status: number): 'ok' | 'gone' | 'unconfirmed' {
  if (status >= 200 && status < 400) return 'ok'
  if (status === 404 || status === 410) return 'gone'
  return 'unconfirmed'
}

/** Probe one URL: HEAD, falling back to GET when the method itself is refused. */
async function probeOne(
  url: string,
  options: Required<ProbeOptions>,
): Promise<{ outcome: UrlStatus['outcome']; detail: string }> {
  const doFetch = options.fetchImpl
  const attempt = async (method: string) =>
    doFetch(url, { method, redirect: 'follow', signal: AbortSignal.timeout(options.timeoutMs) })

  try {
    const head = await attempt('HEAD')
    if (head.status === 405) {
      const get = await attempt('GET')
      return { outcome: classifyStatus(get.status), detail: `GET ${get.status}` }
    }
    return { outcome: classifyStatus(head.status), detail: `HEAD ${head.status}` }
  } catch (err) {
    // A timeout, a DNS failure, a refused connection: the network, not the link.
    const message = err instanceof Error ? err.message : String(err)
    return { outcome: 'unconfirmed', detail: message.length > 80 ? `${message.slice(0, 77)}...` : message }
  }
}

/**
 * Probe every distinct URL, at bounded concurrency.
 *
 * Bounded because a rot check that fires 58 simultaneous requests at 30 hosts is a small
 * denial-of-service, and gets its own URLs rate-limited into `unconfirmed`, which makes the
 * check useless precisely when it is needed.
 */
export async function probeUrls(
  urls: readonly string[],
  options: ProbeOptions = {},
): Promise<Map<string, { outcome: UrlStatus['outcome']; detail: string }>> {
  const resolved: Required<ProbeOptions> = {
    fetchImpl:
      options.fetchImpl ??
      ((url, init) =>
        fetch(url, {
          method: init.method,
          redirect: init.redirect,
          signal: init.signal,
          headers: { 'user-agent': 'anvil-playbook-check', accept: '*/*' },
        })),
    concurrency: Math.max(1, options.concurrency ?? 6),
    timeoutMs: Math.max(1000, options.timeoutMs ?? 15_000),
  }

  const out = new Map<string, { outcome: UrlStatus['outcome']; detail: string }>()
  const queue = [...new Set(urls)]
  const workers = Array.from({ length: Math.min(resolved.concurrency, queue.length) }, async () => {
    for (;;) {
      const url = queue.shift()
      if (url === undefined) return
      out.set(url, await probeOne(url, resolved))
    }
  })
  await Promise.all(workers)
  return out
}

/** The full check: structure always, reachability when `probe` is on. */
export async function checkPlaybooks(
  playbooks: readonly Playbook[],
  options: ProbeOptions & { probe?: boolean } = {},
): Promise<CheckReport> {
  const problems = checkStructure(playbooks)
  const citations = collectUrls(playbooks)

  const citedBy = new Map<string, string[]>()
  for (const { url, where } of citations) {
    const owner = where.split('.')[0] as string
    if (!citedBy.has(url)) citedBy.set(url, [])
    ;(citedBy.get(url) as string[]).push(owner)
  }

  let urls: UrlStatus[] = []
  if (options.probe === true) {
    const probed = await probeUrls([...citedBy.keys()], options)
    urls = [...citedBy.entries()]
      .map(([url, owners]) => {
        const result = probed.get(url) ?? { outcome: 'unconfirmed' as const, detail: 'not probed' }
        return { url, citedBy: [...new Set(owners)].sort(), outcome: result.outcome, detail: result.detail }
      })
      .sort((a, b) => a.url.localeCompare(b.url))
    for (const u of urls) {
      if (u.outcome === 'gone') {
        problems.push({
          level: 'error',
          where: u.citedBy.join(', '),
          message: `dead link (${u.detail}): ${u.url}`,
          fix: 'Find the current URL, or drop the resource. A link that 404s teaches a reader the registry is unmaintained.',
        })
      }
    }
  } else {
    urls = [...citedBy.entries()]
      .map(([url, owners]) => ({
        url,
        citedBy: [...new Set(owners)].sort(),
        outcome: 'ok' as const,
        detail: 'not probed (--offline)',
      }))
      .sort((a, b) => a.url.localeCompare(b.url))
  }

  const counts: Record<ProblemLevel, number> = { error: 0, warn: 0, info: 0 }
  for (const p of problems) counts[p.level]++
  return { problems, urls, counts, ok: counts.error === 0 }
}
