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
 * The one route that accepts user content is `POST /api/brief`: it takes bounded task text
 * or a plan suggestion id, returns a brief derived from the cached snapshot, and stores
 * nothing. It cannot name a command or a path, and its only effect is the response.
 */

import { randomBytes, timingSafeEqual } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { createServer, type Server } from 'node:http'
import { CSS, HTML, JS } from './assets.ts'
import { type DashboardSnapshot, type LoadSnapshotOptions, loadSnapshot } from './snapshot.ts'
import { buildTaskBrief, type TaskBriefInput, TaskInputError } from './task.ts'

const COOKIE_PREFIX = 'anvil_dashboard'
/** Enough for a 4,000-character task plus JSON escaping; never an unbounded upload. */
const MAX_BODY_BYTES = 32 * 1024
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
        resolve({ ok: true, value: JSON.parse(Buffer.concat(chunks).toString('utf8')) })
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
    if (key !== 'text' && key !== 'suggestionId') throw new TaskInputError(`Unknown field: ${key}`)
  }
  if (record.text !== undefined && typeof record.text !== 'string') {
    throw new TaskInputError('`text` must be a string.')
  }
  if (record.suggestionId !== undefined && typeof record.suggestionId !== 'string') {
    throw new TaskInputError('`suggestionId` must be a string.')
  }
  const input: TaskBriefInput = {}
  if (record.text !== undefined) input.text = record.text as string
  if (record.suggestionId !== undefined) input.suggestionId = record.suggestionId as string
  return input
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

      const supplied = url.searchParams.get('token')
      const cookie = cookieValue(req.headers.cookie, cookieName)
      const authorized =
        (supplied !== null && sameToken(supplied, token)) || (cookie !== null && sameToken(cookie, token))

      if (url.pathname === '/') {
        if (req.method !== 'GET' && req.method !== 'HEAD') {
          res.setHeader('allow', 'GET, HEAD')
          send(res, 405, 'Method not allowed\n', 'text/plain; charset=utf-8')
          return
        }
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

      if (url.pathname === '/api/brief') {
        if (req.method !== 'POST') {
          res.setHeader('allow', 'POST')
          send(res, 405, 'Method not allowed\n', 'text/plain; charset=utf-8')
          return
        }
        const contentType = req.headers['content-type'] ?? ''
        if (!/^application\/json(?:;|$)/i.test(contentType)) {
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
          sendJson(res, 200, buildTaskBrief(await snapshot(false), input))
        } catch (thrown) {
          if (!(thrown instanceof TaskInputError)) throw thrown
          sendJson(res, 400, { error: thrown.message })
        }
        return
      }

      if (req.method !== 'GET' && req.method !== 'HEAD') {
        res.setHeader('allow', 'GET, HEAD')
        send(res, 405, 'Method not allowed\n', 'text/plain; charset=utf-8')
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
        sendJson(res, 200, value)
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
