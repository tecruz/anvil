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
import { CSS, HTML, JS } from './assets.ts'
import { type DashboardSnapshot, type LoadSnapshotOptions, loadSnapshot } from './snapshot.ts'

const COOKIE = 'anvil_dashboard'
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
}

export interface DashboardServerHandle {
  url: string
  token: string
  port: number
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

export async function createDashboardServer(options: DashboardServerOptions): Promise<DashboardServerHandle> {
  const host = options.host ?? '127.0.0.1'
  const port = options.port ?? 0
  const token = options.token ?? randomBytes(24).toString('base64url')
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
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        res.setHeader('allow', 'GET, HEAD')
        send(res, 405, 'Method not allowed\n', 'text/plain; charset=utf-8')
        return
      }

      const supplied = url.searchParams.get('token')
      const cookie = cookieValue(req.headers.cookie, COOKIE)
      const authorized =
        (supplied !== null && sameToken(supplied, token)) || (cookie !== null && sameToken(cookie, token))

      if (url.pathname === '/') {
        if (supplied !== null && sameToken(supplied, token)) {
          res.writeHead(302, {
            location: '/',
            'set-cookie': `${COOKIE}=${token}; Path=/; HttpOnly; SameSite=Strict`,
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
    close() {
      return new Promise<void>((resolve, reject) => {
        server.close((error) => (error === undefined ? resolve() : reject(error)))
      })
    },
  }
}
