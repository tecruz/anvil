/**
 * The one HTTP path in this package.
 *
 * `fetch` is injected rather than called directly, for the reason `check.ts` records: a
 * test that reaches the network reads whatever the developer's network happens to return
 * and reports it as a pass. Every caller takes a `FetchImpl` and the tests supply one.
 *
 * The two limits are not politeness. The cap stops a misbehaving endpoint from filling
 * memory (the same reasoning as `playbook add`'s byte cap, and the same failure it guards
 * against -- an unbounded read is how a redirect turns into an outage), and the timeout
 * stops a hung socket from turning a discovery run into a hang, which is worse than no
 * answer because the user cannot tell it apart from thinking.
 */

export type FetchImpl = (
  url: string,
  init: { headers: Record<string, string>; signal: AbortSignal },
) => Promise<{ status: number; text(): Promise<string> }>

export const defaultTimeoutMs = 15_000

/**
 * Cap on a response body. Generous for a JSON API response, and far below the point where
 * a wrong response could do damage.
 */
const MAX_BYTES = 4 * 1024 * 1024

const USER_AGENT = 'anvil-discover'

export interface HttpResult {
  status: number
  body: string
  /** Set when the request itself failed rather than the server answering. */
  transportError?: string
}

/**
 * GET a URL, returning the status and a size-capped body.
 *
 * Never throws for a network problem: the caller decides what an unreachable source means,
 * and for a discovery pass that is a warning rather than a failed command. A thrown error
 * here would take down the run for the sources that did answer.
 */
export async function requestJson(
  url: string,
  options: { fetchImpl: FetchImpl; timeoutMs?: number; headers?: Record<string, string> },
): Promise<HttpResult> {
  const timeoutMs = options.timeoutMs ?? defaultTimeoutMs
  let response: { status: number; text(): Promise<string> }
  try {
    response = await options.fetchImpl(url, {
      headers: { 'user-agent': USER_AGENT, accept: 'application/json', ...options.headers },
      signal: AbortSignal.timeout(timeoutMs),
    })
  } catch (err) {
    // The network, not the source. Reported as a transport error so the caller can tell
    // "did not answer" from "answered 404", which are very different verdicts about whether
    // the resource exists.
    return {
      status: 0,
      body: '',
      transportError: err instanceof Error ? err.message : String(err),
    }
  }
  if (response.status !== 200) return { status: response.status, body: '' }
  try {
    const body = await response.text()
    // Counted after the fact rather than streamed, unlike `playbook add`. The difference is
    // deliberate and worth stating: that one installs a file that becomes trusted
    // configuration, so it caps while reading. This one reads JSON from endpoints the
    // playbook seeds name, and the bounded-concurrency call sites below keep the total
    // well under the cap even if every request answered at the maximum.
    if (body.length > MAX_BYTES) {
      return { status: response.status, body: '', transportError: `response over ${MAX_BYTES} bytes` }
    }
    return { status: response.status, body }
  } catch (err) {
    return {
      status: response.status,
      body: '',
      transportError: err instanceof Error ? err.message : String(err),
    }
  }
}
