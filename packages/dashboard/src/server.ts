/**
 * A loopback-only, read-only HTTP surface for the dashboard.
 *
 * The threat model is a local user's browser visiting a URL they did not intend: the server
 * binds to 127.0.0.1, rejects unknown Host headers (DNS rebinding), requires a random
 * session token delivered once in the start URL and kept in an HttpOnly cookie, serves a
 * strict content security policy, and exposes a small fixed API. There is no route that
 * takes a command, a path, or a repository from a request, so a dashboard page cannot
 * become an arbitrary command-execution endpoint.
 *
 * `POST /api/brief` accepts bounded task text or a plan suggestion id and derives a brief
 * from the cached snapshot. It stores nothing, starts no CLI process, and has no effect
 * beyond its response.
 */

import { randomBytes, timingSafeEqual } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { createServer, type Server } from 'node:http'
import { TextDecoder } from 'node:util'
import { actionArgv, actionResult, parseAction } from './actions.ts'
import { CSS, HTML, JS } from './assets.ts'
import {
  type DashboardInvoke,
  type DashboardInvokeResult,
  type DashboardSnapshot,
  type LoadSnapshotOptions,
  loadSnapshot,
} from './snapshot.ts'
import { buildTaskBrief, type TaskBriefInput, TaskInputError } from './task.ts'

const COOKIE_PREFIX = 'anvil_dashboard'
/** Enough for a 4,000-character task plus JSON escaping; never an unbounded upload. */
const MAX_BODY_BYTES = 32 * 1024
/**
 * Strict JSON media type: `application/json` with optional, well-formed parameters.
 *
 * The old `/^application\/json(?:;|$)/i` accepted any garbage after a semicolon, so
 * `application/json;not-a-parameter` reached the route — and, on `/api/action`, the runner.
 * A parameter is `tchar "=" (tchar / quoted-string)`: optional whitespace is allowed around a
 * semicolon, but never around `=`. Anything else (a missing `=`, a value with whitespace before
 * the `=`, an empty value, a second media type, `application/jsonp`) is refused with 415.
 */
const JSON_CONTENT_TYPE =
  /^application\/json(?:\s*;\s*[!#$%&'*+\-.^_`|~0-9A-Za-z]+=(?:[!#$%&'*+\-.^_`|~0-9A-Za-z]+|"(?:[^"\\]|\\.)*"))*\s*$/i
const CSP = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self'",
  "connect-src 'self'",
  "img-src 'none'",
  "base-uri 'none'",
  "frame-ancestors 'none'",
].join('; ')

export interface DashboardServerOptions extends Omit<LoadSnapshotOptions, 'now'> {
  /** Loopback address to bind. Never a wildcard. */
  host?: string
  /** 0 asks the OS for a free port. */
  port?: number
  /** Injected for deterministic tests. */
  token?: string
  /**
   * Long-running runner for the three gated actions. Snapshot reads keep `invoke` (short
   * timeout); ship verification may need ten minutes per check, so actions get their own.
   */
  invokeAction?: DashboardInvoke
}

export interface DashboardServerHandle {
  url: string
  token: string
  port: number
  /**
   * The session cookie name. It is unique per server because cookies are scoped by name,
   * not by port: two dashboards on different ports must not overwrite each other's tokens.
   */
  cookieName: string
  close(): Promise<void>
}

function send(res: ServerResponse, status: number, body: string, contentType: string): void {
  res.writeHead(status, {
    'content-type': contentType,
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
    'content-security-policy': CSP,
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer',
  })
  res.end(body)
}

function sendJson(res: ServerResponse, status: number, value: unknown): void {
  send(res, status, JSON.stringify(value), 'application/json; charset=utf-8')
}

type BodyRead = { ok: true; value: unknown } | { ok: false; status: number; message: string }

/** Read a bounded JSON body. An oversize upload is consumed and then refused, never stored. */
function readJsonBody(req: IncomingMessage, limit: number): Promise<BodyRead> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = []
    let size = 0
    let tooLarge = false
    req.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size > limit) {
        tooLarge = true
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      if (tooLarge) {
        resolve({ ok: false, status: 413, message: `Request body is limited to ${String(limit)} bytes.` })
        return
      }
      try {
        resolve({ ok: true, value: parseStrictJson(Buffer.concat(chunks)) })
      } catch {
        resolve({ ok: false, status: 400, message: 'Request body must be a JSON object.' })
      }
    })
    req.on('error', (error: Error) => {
      resolve({ ok: false, status: 400, message: `Could not read the request body: ${error.message}` })
    })
  })
}

/** The brief route's whole input contract. Unknown fields are refused, not ignored. */
function briefInput(value: unknown): TaskBriefInput {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new TaskInputError('Request body must be a JSON object.')
  }
  const record = value as Record<string, unknown>
  for (const key of Object.keys(record)) {
    if (key !== 'text' && key !== 'suggestionId' && key !== 'snapshotId') {
      throw new TaskInputError(`Unknown field: ${key}`)
    }
  }
  if (record.text !== undefined && typeof record.text !== 'string') {
    throw new TaskInputError('`text` must be a string.')
  }
  if (record.suggestionId !== undefined && typeof record.suggestionId !== 'string') {
    throw new TaskInputError('`suggestionId` must be a string.')
  }
  if (record.snapshotId !== undefined && (typeof record.snapshotId !== 'string' || record.snapshotId.length > 64)) {
    throw new TaskInputError('`snapshotId` must be a short string.')
  }
  const input: TaskBriefInput = {}
  if (record.text !== undefined) input.text = record.text as string
  if (record.suggestionId !== undefined) input.suggestionId = record.suggestionId as string
  if (record.snapshotId !== undefined) input.snapshotId = record.snapshotId as string
  return input
}

/**
 * Read a header exactly once. Two fields with the same name are ambiguous: a proxy or a
 * forged request could put a valid value first and a different one second, so both POST
 * routes refuse the request instead of picking one.
 */
function singleHeader(req: IncomingMessage, name: string): string | undefined {
  let value: string | undefined
  let count = 0
  const wanted = name.toLowerCase()
  for (let i = 0; i < req.rawHeaders.length; i += 2) {
    if ((req.rawHeaders[i] ?? '').toLowerCase() !== wanted) continue
    count++
    value = req.rawHeaders[i + 1]
  }
  return count === 1 ? value : undefined
}

/** Strict UTF-8: an invalid byte must be a bad request, never a replacement character in JSON. */
function parseStrictJson(bytes: Buffer): unknown {
  const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  return JSON.parse(text)
}

function cookieValue(header: string | undefined, name: string): string | null {
  if (header === undefined) return null
  for (const part of header.split(';')) {
    const [key, ...rest] = part.trim().split('=')
    if (key === name) return rest.join('=')
  }
  return null
}

function sameToken(a: string, b: string): boolean {
  const left = Buffer.from(a)
  const right = Buffer.from(b)
  return left.length === right.length && timingSafeEqual(left, right)
}

function hostAllowed(host: string | undefined, expectedHost: string, port: number): boolean {
  if (host === undefined) return false
  const allowed = new Set([`${expectedHost}:${String(port)}`, `localhost:${String(port)}`])
  return allowed.has(host.toLowerCase())
}

/**
 * POSTs must come from this dashboard's own page, never from another origin or a form.
 *
 * The Origin must match the Host header the request actually arrived on: a browser derives both
 * from the same URL, so any mismatch is a forgery. `hostAllowed` above already rejects rebound
 * Host values, so binding Origin to the request's own Host cannot widen the set of accepted
 * hosts — it only stops a POST sent to `127.0.0.1` from claiming `localhost` as its origin (or
 * the reverse), which is the cross-loopback-name bypass this check exists to prevent.
 */
function originAllowed(origin: string | undefined, host: string | undefined): boolean {
  if (origin === undefined || host === undefined) return false
  return origin.toLowerCase() === `http://${host.toLowerCase()}`
}

export async function createDashboardServer(options: DashboardServerOptions): Promise<DashboardServerHandle> {
  const host = options.host ?? '127.0.0.1'
  const port = options.port ?? 0
  const token = options.token ?? randomBytes(24).toString('base64url')
  const actionInvoke = options.invokeAction ?? options.invoke
  // Cookies are keyed by name and path, not by port, so every dashboard needs its own name.
  // A fixed `anvil_dashboard` cookie would let a second dashboard overwrite the first one's
  // token and lock the first browser session out on its next refresh.
  const cookieName = `${COOKIE_PREFIX}_${randomBytes(6).toString('base64url')}`
  // Port 0 is resolved by the OS. The Host check must use the bound port, not the request.
  let boundPort = port
  let cache: DashboardSnapshot | null = null
  let cacheId = 0
  let pending: Promise<DashboardSnapshot> | null = null

  const snapshot = (refresh: boolean): Promise<DashboardSnapshot> => {
    if (!refresh && cache !== null) return Promise.resolve(cache)
    if (pending === null) {
      pending = loadSnapshot(options)
        .then((value) => {
          cache = value
          // A server-issued generation, not a wall-clock timestamp: two loads in the same
          // millisecond still get different ids, so a tab can never mistake B's brief for A's.
          cacheId += 1
          return value
        })
        .finally(() => {
          pending = null
        })
    }
    return pending
  }

  /**
   * The brief's read path: the cache, or nothing.
   *
   * It never starts a load and does not wait on one. A brief is a view over facts the page
   * already has, so building one cannot become a way to spawn CLI processes on demand — not
   * even a first load triggered by a POST that races the page.
   */
  const cachedSnapshot = (): DashboardSnapshot | null => cache

  const server: Server = createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url ?? '/', `http://${host}`)
      // Read the request's Host once. Both the DNS-rebinding check and the Origin binding
      // below must use the same single value, never re-read the raw header.
      const requestHost = singleHeader(req, 'host')
      if (!hostAllowed(requestHost, host, boundPort)) {
        send(res, 403, 'Forbidden host\n', 'text/plain; charset=utf-8')
        return
      }
      if (req.method !== 'GET' && req.method !== 'HEAD' && req.method !== 'POST') {
        res.setHeader('allow', 'GET, HEAD, POST')
        send(res, 405, 'Method not allowed\n', 'text/plain; charset=utf-8')
        return
      }

      const cookie = cookieValue(singleHeader(req, 'cookie'), cookieName)

      if (url.pathname === '/api/brief') {
        if (req.method !== 'POST') {
          res.setHeader('allow', 'POST')
          send(res, 405, 'Method not allowed\n', 'text/plain; charset=utf-8')
          return
        }
        // Same session and CSRF checks as the action route: the cookie proves the session,
        // the Origin header proves the request came from this page, not a form or another site.
        if (cookie === null || !sameToken(cookie, token)) {
          sendJson(res, 401, { error: 'Unauthorized' })
          return
        }
        if (!originAllowed(singleHeader(req, 'origin'), requestHost)) {
          sendJson(res, 403, { error: 'Forbidden origin' })
          return
        }
        const contentType = singleHeader(req, 'content-type')
        if (contentType === undefined || !JSON_CONTENT_TYPE.test(contentType)) {
          sendJson(res, 415, { error: 'Use Content-Type: application/json.' })
          return
        }
        const body = await readJsonBody(req, MAX_BODY_BYTES)
        if (!body.ok) {
          sendJson(res, body.status, { error: body.message })
          return
        }
        try {
          const input = briefInput(body.value)
          const current = cachedSnapshot()
          if (current === null) {
            sendJson(res, 409, { error: 'No snapshot yet. Reload the page, then build the brief.' })
            return
          }
          // The page's generation is required, not optional: without it, a tab left on an older
          // snapshot would accept a brief built from a newer one cached after another tab
          // refreshed — correct data shown under the wrong snapshot. A counter, unlike a
          // timestamp, changes even when two loads happen in the same millisecond.
          if (input.snapshotId === undefined || input.snapshotId !== String(cacheId)) {
            sendJson(res, 409, { error: 'The snapshot changed. Refresh the page before building a brief.' })
            return
          }
          sendJson(res, 200, buildTaskBrief(current, input))
        } catch (thrown) {
          if (!(thrown instanceof TaskInputError)) throw thrown
          sendJson(res, 400, { error: thrown.message })
        }
        return
      }

      if (req.method === 'POST') {
        if (url.pathname !== '/api/action') {
          res.setHeader('allow', 'GET, HEAD')
          send(res, 405, 'Method not allowed\n', 'text/plain; charset=utf-8')
          return
        }
        // Check every header before touching the body. A rejected POST must never parse
        // attacker-controlled text, and a wrong media type must be answered with 415 rather
        // than a 400 from a body that happened not to be JSON. The token stays HttpOnly: the
        // browser proves the session with its cookie, and Origin + JSON content type prove this
        // came from the dashboard page, not a form or another site.
        if (cookie === null || !sameToken(cookie, token)) {
          send(res, 401, 'Unauthorized\n', 'text/plain; charset=utf-8')
          return
        }
        if (!originAllowed(singleHeader(req, 'origin'), requestHost)) {
          send(res, 403, 'Forbidden origin\n', 'text/plain; charset=utf-8')
          return
        }
        const contentType = singleHeader(req, 'content-type')
        if (contentType === undefined || !JSON_CONTENT_TYPE.test(contentType)) {
          send(res, 415, 'Expected application/json\n', 'text/plain; charset=utf-8')
          return
        }
        const chunks: Buffer[] = []
        let size = 0
        for await (const chunk of req) {
          const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk))
          size += buf.length
          if (size > 4096) {
            send(res, 413, 'Request too large\n', 'text/plain; charset=utf-8')
            return
          }
          chunks.push(buf)
        }
        let body: Record<string, unknown>
        try {
          const parsed: unknown = parseStrictJson(Buffer.concat(chunks))
          if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('bad body')
          body = parsed as Record<string, unknown>
        } catch {
          send(res, 400, 'Expected a JSON object\n', 'text/plain; charset=utf-8')
          return
        }
        const parsedAction = parseAction(body.action, body.ref)
        if (parsedAction === null) {
          send(res, 400, 'Unknown action or unsafe argument\n', 'text/plain; charset=utf-8')
          return
        }
        const argv = actionArgv(parsedAction.action, parsedAction.ref)
        let result: DashboardInvokeResult
        try {
          result = await actionInvoke(argv, options.cwd)
        } catch (thrown) {
          // A timeout or spawn failure is an action outcome, not a server crash. Return the
          // same JSON shape so the page can display the CLI runner's error beside the snapshot
          // instead of replacing it with a JSON parse error from a plain-text 500.
          result = {
            exitCode: -1,
            stdout: '',
            stderr: thrown instanceof Error ? thrown.message : String(thrown),
          }
        }
        send(
          res,
          200,
          JSON.stringify(actionResult(parsedAction.action, argv, result)),
          'application/json; charset=utf-8',
        )
        return
      }

      const supplied = url.searchParams.get('token')
      const authorized =
        (supplied !== null && sameToken(supplied, token)) || (cookie !== null && sameToken(cookie, token))

      if (url.pathname === '/') {
        if (supplied !== null && sameToken(supplied, token)) {
          res.writeHead(302, {
            location: '/',
            'set-cookie': `${cookieName}=${token}; Path=/; HttpOnly; SameSite=Strict`,
            'cache-control': 'no-store',
            'referrer-policy': 'no-referrer',
            'content-security-policy': CSP,
          })
          res.end()
          return
        }
        if (!authorized) {
          send(
            res,
            401,
            'This dashboard needs the session URL printed by `anvil dashboard`.\n',
            'text/plain; charset=utf-8',
          )
          return
        }
        send(res, 200, HTML, 'text/html; charset=utf-8')
        return
      }

      if (!authorized) {
        send(res, 401, 'Unauthorized\n', 'text/plain; charset=utf-8')
        return
      }

      if (url.pathname === '/app.js') {
        send(res, 200, JS, 'text/javascript; charset=utf-8')
        return
      }
      if (url.pathname === '/app.css') {
        send(res, 200, CSS, 'text/css; charset=utf-8')
        return
      }
      if (url.pathname === '/api/snapshot') {
        const value = await snapshot(url.searchParams.get('refresh') === '1')
        send(res, 200, JSON.stringify({ ...value, snapshotId: String(cacheId) }), 'application/json; charset=utf-8')
        return
      }
      send(res, 404, 'Not found\n', 'text/plain; charset=utf-8')
    })().catch((thrown: unknown) => {
      const message = thrown instanceof Error ? thrown.message : String(thrown)
      if (!res.headersSent) send(res, 500, `snapshot failed: ${message}\n`, 'text/plain; charset=utf-8')
      else res.end()
    })
  })

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, host, () => {
      server.off('error', reject)
      resolve()
    })
  })

  const address = server.address()
  boundPort = address !== null && typeof address === 'object' ? address.port : port
  return {
    url: `http://${host}:${String(boundPort)}/?token=${token}`,
    token,
    port: boundPort,
    cookieName,
    close() {
      return new Promise<void>((resolve, reject) => {
        server.close((error) => (error === undefined ? resolve() : reject(error)))
      })
    },
  }
}
