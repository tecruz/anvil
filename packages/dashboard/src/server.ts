/**
 * A loopback-only, read-only HTTP surface for the dashboard.
 *
 * The threat model is a local user's browser visiting a URL they did not intend: the server
 * binds to 127.0.0.1, rejects unknown Host headers (DNS rebinding), requires a random
 * session token delivered once in the start URL and kept in an HttpOnly cookie, serves a
 * strict content security policy, and exposes three fixed GET endpoints. There is no route
 * that takes a command, a path, or a repository from a request, so a dashboard page cannot
 * become an arbitrary command-execution endpoint.
 */

import { randomBytes, timingSafeEqual } from 'node:crypto'
import type { ServerResponse } from 'node:http'
import { createServer, type Server } from 'node:http'
import { actionArgv, actionResult, parseAction } from './actions.ts'
import { CSS, HTML, JS } from './assets.ts'
import {
  type DashboardInvoke,
  type DashboardInvokeResult,
  type DashboardSnapshot,
  type LoadSnapshotOptions,
  loadSnapshot,
} from './snapshot.ts'

const COOKIE_PREFIX = 'anvil_dashboard'
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

/** POSTs must come from this dashboard's own page, never from another origin or a form. */
function originAllowed(origin: string | undefined, expectedHost: string, port: number): boolean {
  if (origin === undefined) return false
  const allowed = new Set([`http://${expectedHost}:${String(port)}`, `http://localhost:${String(port)}`])
  return allowed.has(origin.toLowerCase())
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
  let pending: Promise<DashboardSnapshot> | null = null

  const snapshot = (refresh: boolean): Promise<DashboardSnapshot> => {
    if (!refresh && cache !== null) return Promise.resolve(cache)
    if (pending === null) {
      pending = loadSnapshot(options)
        .then((value) => {
          cache = value
          return value
        })
        .finally(() => {
          pending = null
        })
    }
    return pending
  }

  const server: Server = createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url ?? '/', `http://${host}`)
      if (!hostAllowed(req.headers.host, host, boundPort)) {
        send(res, 403, 'Forbidden host\n', 'text/plain; charset=utf-8')
        return
      }
      if (req.method !== 'GET' && req.method !== 'HEAD' && req.method !== 'POST') {
        res.setHeader('allow', 'GET, HEAD, POST')
        send(res, 405, 'Method not allowed\n', 'text/plain; charset=utf-8')
        return
      }

      const cookie = cookieValue(req.headers.cookie, cookieName)

      if (req.method === 'POST') {
        if (url.pathname !== '/api/action') {
          res.setHeader('allow', 'GET, HEAD')
          send(res, 405, 'Method not allowed\n', 'text/plain; charset=utf-8')
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
          const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'))
          if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('bad body')
          body = parsed as Record<string, unknown>
        } catch {
          send(res, 400, 'Expected a JSON object\n', 'text/plain; charset=utf-8')
          return
        }
        // The token stays HttpOnly: the browser proves the session with its cookie, and the
        // Origin + JSON content type prove this came from the dashboard page, not a form or
        // another site. No token is exposed to page JavaScript.
        if (cookie === null || !sameToken(cookie, token)) {
          send(res, 401, 'Unauthorized\n', 'text/plain; charset=utf-8')
          return
        }
        if (!originAllowed(req.headers.origin, host, boundPort)) {
          send(res, 403, 'Forbidden origin\n', 'text/plain; charset=utf-8')
          return
        }
        if (!String(req.headers['content-type'] ?? '').startsWith('application/json')) {
          send(res, 415, 'Expected application/json\n', 'text/plain; charset=utf-8')
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
        send(res, 200, JSON.stringify(value), 'application/json; charset=utf-8')
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
