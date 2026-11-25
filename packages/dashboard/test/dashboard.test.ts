/**
 * The local dashboard's contract tests.
 *
 * They run a real loopback server with a fake CLI invoker: no process is spawned, no model
 * is called and no repository is modified. The cases here are the ones that decide whether
 * the page can be trusted as a read-only overview — source failures, an explicit refresh,
 * loopback/session boundaries, and the difference between "no evidence" and "verified".
 */

import assert from 'node:assert/strict'
import { request as httpRequest } from 'node:http'
import { describe, test } from 'node:test'
import { createContext, runInContext } from 'node:vm'
import {
  actionArgv,
  createDashboardServer,
  type DashboardInvoke,
  type DashboardInvokeResult,
  type DashboardServerHandle,
  type DashboardSnapshot,
  JS,
  loadSnapshot,
  type StagedView,
} from '@anvil/dashboard'

const TOKEN = 'unit-test-token'

function snapshotOf(response: Response): Promise<DashboardSnapshot> {
  return response.json() as Promise<DashboardSnapshot>
}

const staged: StagedView = {
  exists: true,
  createdAt: '2026-11-17T10:00:00.000Z',
  inputHash: 'abc123',
  summary: { files: 1, added: 2, removed: 0 },
  files: [{ path: '.anvil/AGENTS.md', diff: '+ a line', edited: false, error: null }],
}

function envelope(data: unknown): DashboardInvokeResult {
  return { exitCode: 0, stdout: JSON.stringify({ schemaVersion: 1, ok: true, command: 'fake', data }), stderr: '' }
}

function fakeInvoke(overrides: Partial<Record<string, DashboardInvokeResult>> = {}): {
  invoke: DashboardInvoke
  calls: string[][]
} {
  const calls: string[][] = []
  return {
    calls,
    invoke: async (args) => {
      calls.push(args)
      const key = args[0] ?? ''
      if (key in overrides) return overrides[key] as DashboardInvokeResult
      if (key === 'doctor') return envelope({ score: 94, grade: 'A', findings: [], degraded: [] })
      if (key === 'ready') {
        return envelope({
          status: 'unknown',
          root: '/repo',
          projectDir: '',
          checked: false,
          tools: [],
          commands: [{ kind: 'test', cmd: 'npm test', source: 'documented', evidence: 'README.md:3', dir: '' }],
        })
      }
      if (key === 'plan') return envelope({ score: 94, suggestions: [], satisfied: 2 })
      if (key === 'profile') {
        return envelope({
          root: '/repo',
          projectDir: '',
          files: ['README.md', 'AGENTS.md'],
          commands: { test: [{ cmd: 'npm test', source: 'documented', evidence: 'README.md:3' }] },
          diagnostics: { truncated: false, fileLimit: 20000, failedDetectors: [] },
        })
      }
      if (key === 'brief') return envelope({ target: 'all', gaps: ['No AGENTS.md'] })
      if (key === 'crew') return envelope({ crew: [], active: 0 })
      return envelope({})
    },
  }
}

async function withServer<T>(
  fn: (server: DashboardServerHandle, invoke: DashboardInvoke, calls: string[][]) => Promise<T>,
  overrides: Partial<Record<string, DashboardInvokeResult>> = {},
  readStaged: () => StagedView = () => staged,
): Promise<T> {
  const { invoke, calls } = fakeInvoke(overrides)
  const server = await createDashboardServer({ cwd: '/repo', invoke, readStaged, token: TOKEN })
  try {
    return await fn(server, invoke, calls)
  } finally {
    await server.close()
  }
}

function authed(server: DashboardServerHandle, path: string): Promise<Response> {
  return fetch(new URL(path, server.url), { headers: { cookie: `${server.cookieName}=${TOKEN}` } })
}

async function authedPost(
  server: DashboardServerHandle,
  path: string,
  body: unknown,
  contentType = 'application/json',
  origin?: string,
  bindSnapshot = true,
): Promise<Response> {
  const url = new URL(path, server.url)
  const headers: Record<string, string> = {
    cookie: `${server.cookieName}=${TOKEN}`,
    'content-type': contentType,
    origin: origin ?? url.origin,
  }
  let payload = typeof body === 'string' ? body : JSON.stringify(body)
  if (path === '/api/brief' && bindSnapshot && body !== null && typeof body === 'object' && !Array.isArray(body)) {
    const snapshot = (await snapshotOf(await authed(server, '/api/snapshot'))) as DashboardSnapshot & {
      snapshotId: string
    }
    payload = JSON.stringify({ ...body, snapshotId: snapshot.snapshotId })
  }
  return fetch(url, { method: 'POST', headers, body: payload })
}

function rawGet(
  server: DashboardServerHandle,
  path: string,
  host: string,
): Promise<{ status: number | undefined; body: string }> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      {
        host: '127.0.0.1',
        port: server.port,
        path,
        headers: { host, cookie: `${server.cookieName}=${TOKEN}` },
      },
      (res) => {
        let body = ''
        res.setEncoding('utf8')
        res.on('data', (chunk) => {
          body += chunk
        })
        res.on('end', () => resolve({ status: res.statusCode, body }))
      },
    )
    req.on('error', reject)
    req.end()
  })
}

/** A POST with an explicit Host and Origin, so cross-loopback-name forgery can be reproduced. */
function rawPost(
  server: DashboardServerHandle,
  path: string,
  body: unknown,
  options: { host: string; origin?: string | undefined; contentType?: string | undefined },
): Promise<{ status: number | undefined; body: string }> {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body)
    const headers: Record<string, string> = {
      host: options.host,
      cookie: `${server.cookieName}=${TOKEN}`,
      'content-type': options.contentType ?? 'application/json',
      'content-length': String(Buffer.byteLength(payload)),
    }
    if (options.origin !== undefined) headers.origin = options.origin
    const req = httpRequest(
      {
        host: '127.0.0.1',
        port: server.port,
        method: 'POST',
        path,
        headers,
      },
      (res) => {
        let text = ''
        res.setEncoding('utf8')
        res.on('data', (chunk) => {
          text += chunk
        })
        res.on('end', () => resolve({ status: res.statusCode, body: text }))
      },
    )
    req.on('error', reject)
    req.end(payload)
  })
}

describe('the dashboard server', () => {
  test('the one-time URL sets an HttpOnly cookie and serves local assets', async () => {
    await withServer(async (server) => {
      const boot = await fetch(server.url, { redirect: 'manual' })
      assert.equal(boot.status, 302)
      assert.equal(boot.headers.get('location'), '/')
      assert.match(boot.headers.get('set-cookie') ?? '', /HttpOnly/)
      assert.match(boot.headers.get('set-cookie') ?? '', /SameSite=Strict/)

      const page = await authed(server, '/')
      assert.equal(page.status, 200)
      assert.match(page.headers.get('content-security-policy') ?? '', /default-src 'none'/)
      assert.match(await page.text(), /<script src="\/app.js" defer><\/script>/)

      for (const [path, type] of [
        ['/app.js', 'text/javascript'],
        ['/app.css', 'text/css'],
      ] as const) {
        const asset = await authed(server, path)
        assert.equal(asset.status, 200)
        assert.match(asset.headers.get('content-type') ?? '', new RegExp(type))
      }
    })
  })

  test('concurrent dashboards keep separate session cookies', async () => {
    const { invoke } = fakeInvoke()
    const readStaged = () => staged
    const first = await createDashboardServer({ cwd: '/repo', invoke, readStaged, token: TOKEN })
    let second: DashboardServerHandle | undefined
    try {
      second = await createDashboardServer({ cwd: '/repo', invoke, readStaged, token: 'another-token' })
      assert.notEqual(first.cookieName, second.cookieName)

      const bootFirst = await fetch(first.url, { redirect: 'manual' })
      const firstCookie = bootFirst.headers.get('set-cookie')?.split(';')[0] ?? ''
      const bootSecond = await fetch(second.url, { redirect: 'manual' })
      assert.match(bootSecond.headers.get('set-cookie') ?? '', new RegExp(second.cookieName))

      const stillValid = await fetch(new URL('/api/snapshot', first.url), { headers: { cookie: firstCookie } })
      assert.equal(stillValid.status, 200)
    } finally {
      await first.close()
      if (second !== undefined) await second.close()
    }
  })

  test('the API requires the session token', async () => {
    await withServer(async (server) => {
      const anonymous = await fetch(new URL('/api/snapshot', server.url))
      assert.equal(anonymous.status, 401)
      const wrong = await fetch(new URL('/api/snapshot', server.url), {
        headers: { cookie: `${server.cookieName}=not-the-token` },
      })
      assert.equal(wrong.status, 401)
      const right = await authed(server, '/api/snapshot')
      assert.equal(right.status, 200)
    })
  })

  test('it rejects a foreign Host header and any write method', async () => {
    await withServer(async (server) => {
      const rebound = await rawGet(server, '/api/snapshot', 'dashboard.example.com')
      assert.equal(rebound.status, 403)

      const post = await fetch(new URL('/api/snapshot', server.url), {
        method: 'POST',
        headers: { cookie: `${server.cookieName}=${TOKEN}` },
      })
      assert.equal(post.status, 405)
      assert.equal(post.headers.get('allow'), 'GET, HEAD')

      const missing = await authed(server, '/api/run?command=rm')
      assert.equal(missing.status, 404)
    })
  })

  test('a brief needs an existing snapshot and never starts a CLI load', async () => {
    await withServer(async (server, _invoke, calls) => {
      // The page has not loaded yet: no POST may warm the cache by spawning commands.
      const cold = await authedPost(
        server,
        '/api/brief',
        { text: 'Update README.md' },
        'application/json',
        undefined,
        false,
      )
      assert.equal(cold.status, 409)
      assert.match(((await cold.json()) as { error: string }).error, /No snapshot yet/)
      assert.equal(calls.length, 0)

      await snapshotOf(await authed(server, '/api/snapshot'))
      const afterLoad = calls.length
      assert.equal(afterLoad, 6)

      const warm = await authedPost(server, '/api/brief', { text: 'Update README.md' })
      assert.equal(warm.status, 200)
      assert.equal(calls.length, afterLoad)
    })
  })

  test('a brief is built from the snapshot and never runs a command', async () => {
    await withServer(async (server, _invoke, calls) => {
      await snapshotOf(await authed(server, '/api/snapshot'))
      const text = 'Update README.md to document the test command.'
      const response = await authedPost(server, '/api/brief', { text })
      assert.equal(response.status, 200)
      const brief = (await response.json()) as {
        title: string
        startHere: Array<{ path: string }>
        howToCheck: Array<{ cmd: string }>
        gates: unknown[]
        unknowns: string[]
      }
      assert.equal(brief.title, text)
      assert.equal(brief.startHere[0]?.path, 'README.md')
      assert.equal(brief.howToCheck[0]?.cmd, 'npm test')
      assert.match(brief.unknowns.join(' '), /read-only/)

      const before = calls.length
      const again = await authedPost(server, '/api/brief', { text })
      assert.equal(again.status, 200)
      assert.equal(calls.length, before)
    })
  })

  test('a brief bound to an older snapshot is refused after another tab refreshes', async () => {
    await withServer(async (server) => {
      const first = await snapshotOf(await authed(server, '/api/snapshot'))
      await new Promise((resolve) => setTimeout(resolve, 15))
      const refreshed = await snapshotOf(await authed(server, '/api/snapshot?refresh=1'))
      assert.notEqual(
        (refreshed as DashboardSnapshot & { snapshotId: string }).snapshotId,
        (first as DashboardSnapshot & { snapshotId: string }).snapshotId,
      )

      const stale = await authedPost(
        server,
        '/api/brief',
        {
          text: 'Update README.md',
          snapshotId: (first as DashboardSnapshot & { snapshotId: string }).snapshotId,
        },
        'application/json',
        undefined,
        false,
      )
      assert.equal(stale.status, 409)
      assert.match(((await stale.json()) as { error: string }).error, /snapshot changed/)

      const fresh = await authedPost(
        server,
        '/api/brief',
        {
          text: 'Update README.md',
          snapshotId: (refreshed as DashboardSnapshot & { snapshotId: string }).snapshotId,
        },
        'application/json',
        undefined,
        false,
      )
      assert.equal(fresh.status, 200, await fresh.clone().text())

      // Identity is required. A caller that omits it, or supplies another tab's id, cannot get
      // a brief from the shared cache.
      const missing = await authedPost(
        server,
        '/api/brief',
        { text: 'Update README.md' },
        'application/json',
        undefined,
        false,
      )
      assert.equal(missing.status, 409)
      const wrong = await authedPost(
        server,
        '/api/brief',
        { text: 'Update README.md', snapshotId: 'stale' },
        'application/json',
        undefined,
        false,
      )
      assert.equal(wrong.status, 409)
    })
  })

  test('a brief quotes a stated approval gate without inferring one from the repository', async () => {
    await withServer(async (server) => {
      await snapshotOf(await authed(server, '/api/snapshot'))
      const response = await authedPost(server, '/api/brief', {
        text: 'The audit and proposal are approved before implementation. Update README.md.',
      })
      assert.equal(response.status, 200)
      const brief = (await response.json()) as {
        gates: Array<{ kind: string; startNow: string | null; waitFor: string | null; evidence: string }>
      }
      assert.equal(brief.gates.length, 1)
      assert.equal(brief.gates[0]?.kind, 'approval')
      assert.match(brief.gates[0]?.startNow ?? '', /audit and proposal/)
      assert.match(brief.gates[0]?.waitFor ?? '', /implementation/)
      assert.match(brief.gates[0]?.evidence ?? '', /approved before implementation/)
    })
  })

  test('a brief can start from a derived plan suggestion', async () => {
    const plan = envelope({
      score: 94,
      satisfied: 0,
      suggestions: [
        {
          id: 'fix:TEST_FAST',
          tier: 'derived',
          title: 'A changed-files test subset is documented',
          detail: 'Document a changed-files test command -- no changed-files subset is documented.',
          evidence: ['README.md:3'],
        },
      ],
    })
    await withServer(
      async (server) => {
        await snapshotOf(await authed(server, '/api/snapshot'))
        const response = await authedPost(server, '/api/brief', { suggestionId: 'fix:TEST_FAST' })
        assert.equal(response.status, 200)
        const brief = (await response.json()) as {
          title: string
          source: { suggestionId: string | null; text: string | null }
          startHere: Array<{ path: string }>
          unknowns: string[]
        }
        assert.equal(brief.title, 'Document a changed-files test command')
        assert.equal(brief.source.suggestionId, 'fix:TEST_FAST')
        assert.equal(brief.source.text, null)
        assert.equal(brief.startHere[0]?.path, 'README.md')
        assert.match(brief.unknowns.join(' '), /engineering improvement/)
      },
      { plan },
    )
  })

  test('the brief route refuses bad input without reading a path or a command', async () => {
    await withServer(async (server) => {
      await snapshotOf(await authed(server, '/api/snapshot'))
      for (const body of [
        {},
        { text: 'x', suggestionId: 'fix:TEST_FAST' },
        { text: 'x', extra: true },
        { text: 42 },
        { suggestionId: 'not-in-the-plan' },
        'not json',
      ]) {
        const response = await authedPost(server, '/api/brief', body)
        assert.equal(response.status, 400, JSON.stringify(body))
      }

      const wrongType = await authedPost(server, '/api/brief', { text: 'x' }, 'text/plain')
      assert.equal(wrongType.status, 415)

      const tooLarge = await authedPost(server, '/api/brief', { text: 'x'.repeat(40_000) })
      assert.equal(tooLarge.status, 413)

      const get = await authed(server, '/api/brief')
      assert.equal(get.status, 405)
      assert.equal(get.headers.get('allow'), 'POST')

      const anonymous = await fetch(new URL('/api/brief', server.url), {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin: new URL(server.url).origin },
        body: JSON.stringify({ text: 'x' }),
      })
      assert.equal(anonymous.status, 401)
    })
  })

  test('the brief route accepts a valid charset but refuses malformed media-type parameters', async () => {
    await withServer(async (server, _invoke, calls) => {
      await snapshotOf(await authed(server, '/api/snapshot'))
      const callsBefore = calls.length
      for (const contentType of [
        'application/json',
        'application/json; charset=utf-8',
        'application/json;charset=UTF-8',
        'application/json; charset="utf-8"',
      ]) {
        const res = await authedPost(server, '/api/brief', { text: 'Update README.md' }, contentType)
        assert.equal(res.status, 200, `${contentType}: ${await res.clone().text()}`)
      }
      for (const contentType of [
        'application/jsonp',
        'application/json;not-a-parameter',
        'application/json; charset',
        'application/json; =utf-8',
        'application/json; charset = utf-8',
        'text/plain',
      ]) {
        const res = await authedPost(server, '/api/brief', { text: 'Update README.md' }, contentType)
        assert.equal(res.status, 415, contentType)
      }
      assert.equal(calls.length, callsBefore, 'a rejected POST must not invoke the CLI')
    })
  })

  test('the brief route needs the session cookie and a same-origin header', async () => {
    await withServer(async (server, _invoke, calls) => {
      await snapshotOf(await authed(server, '/api/snapshot'))
      const url = new URL('/api/brief', server.url)
      const noCookie = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin: url.origin },
        body: JSON.stringify({ text: 'x' }),
      })
      assert.equal(noCookie.status, 401)

      const foreignOrigin = await authedPost(
        server,
        '/api/brief',
        { text: 'x' },
        'application/json',
        'https://evil.example',
      )
      assert.equal(foreignOrigin.status, 403)

      const missingOrigin = await fetch(url, {
        method: 'POST',
        headers: { cookie: `${server.cookieName}=${TOKEN}`, 'content-type': 'application/json' },
        body: JSON.stringify({ text: 'x' }),
      })
      assert.equal(missingOrigin.status, 403)
      assert.equal(calls.length, 6, 'a rejected POST must not invoke the CLI')
    })
  })

  test('the brief route binds Origin to the request Host, not either loopback name', async () => {
    await withServer(async (server, _invoke, calls) => {
      const snapshot = (await snapshotOf(await authed(server, '/api/snapshot'))) as DashboardSnapshot & {
        snapshotId: string
      }
      const bound = { text: 'Update README.md', snapshotId: snapshot.snapshotId }
      const host = `127.0.0.1:${String(server.port)}`
      const opposite = `localhost:${String(server.port)}`

      const matching = await rawPost(server, '/api/brief', bound, {
        host,
        origin: `http://${host}`,
      })
      assert.equal(matching.status, 200, matching.body)

      // A POST that arrives on 127.0.0.1 but claims localhost as its origin (and the mirror
      // case) must be refused: both names are individually allowed as Host, but not swapped.
      const oppositeName = await rawPost(server, '/api/brief', bound, {
        host,
        origin: `http://${opposite}`,
      })
      assert.equal(oppositeName.status, 403, oppositeName.body)
      assert.match(oppositeName.body, /Forbidden origin/)

      const foreign = await rawPost(server, '/api/brief', bound, {
        host,
        origin: 'https://evil.example',
      })
      assert.equal(foreign.status, 403, foreign.body)

      const missing = await rawPost(server, '/api/brief', bound, { host })
      assert.equal(missing.status, 403, missing.body)

      // The brief still reads only the warmed cache; none of these POSTs invoke the CLI.
      assert.equal(calls.length, 6)
    })
  })

  test('a snapshot combines every source and labels verification unavailable', async () => {
    await withServer(async (server) => {
      const snapshot = await snapshotOf(await authed(server, '/api/snapshot'))
      assert.equal(snapshot.schemaVersion, 1)
      const doctor = snapshot.repository.doctor.data as { score: number }
      const ready = snapshot.repository.ready.data as { root: string }
      const plan = snapshot.repository.plan.data as { satisfied: number }
      const profile = snapshot.repository.profile.data as { files: string[] }
      const brief = snapshot.context.brief.data as { target: string }
      const stagedData = snapshot.context.staged.data as StagedView
      const crew = snapshot.work.crew.data as { active: number }
      assert.equal(doctor.score, 94)
      assert.equal(ready.root, '/repo')
      assert.equal(plan.satisfied, 2)
      assert.deepEqual(profile.files, ['README.md', 'AGENTS.md'])
      assert.equal(brief.target, 'all')
      assert.equal(stagedData.files[0]?.path, '.anvil/AGENTS.md')
      assert.equal(crew.active, 0)
      assert.equal(snapshot.verification.status, 'unavailable')
      assert.match(snapshot.verification.reason, /crew verify/)
    })
  })

  test('a failed source is reported beside the others, not as an empty overview', async () => {
    await withServer(
      async (server) => {
        const snapshot = await snapshotOf(await authed(server, '/api/snapshot'))
        assert.equal(snapshot.repository.doctor.ok, false)
        assert.match(snapshot.repository.doctor.error ?? '', /doctor exploded/)
        assert.equal(snapshot.repository.doctor.data, null)
        assert.equal(snapshot.repository.ready.ok, true)
        assert.equal(snapshot.context.staged.ok, true)
      },
      { doctor: { exitCode: 1, stdout: '', stderr: 'doctor exploded' } },
    )
  })

  test('a staged read failure is isolated to the context view', async () => {
    await withServer(
      async (server) => {
        const snapshot = await snapshotOf(await authed(server, '/api/snapshot'))
        assert.equal(snapshot.context.staged.ok, false)
        assert.match(snapshot.context.staged.error ?? '', /staging unreadable/)
        assert.equal(snapshot.repository.doctor.ok, true)
      },
      {},
      () => {
        throw new Error('staging unreadable')
      },
    )
  })

  test('non-JSON and failure envelopes become source errors', async () => {
    await withServer(
      async (server) => {
        const snapshot = await snapshotOf(await authed(server, '/api/snapshot'))
        assert.equal(snapshot.repository.ready.ok, false)
        assert.match(snapshot.repository.ready.error ?? '', /No JSON/)
      },
      { ready: { exitCode: 0, stdout: 'not json', stderr: '' } },
    )
    await withServer(
      async (server) => {
        const snapshot = await snapshotOf(await authed(server, '/api/snapshot'))
        assert.equal(snapshot.repository.plan.ok, false)
        assert.match(snapshot.repository.plan.error ?? '', /plan refused/)
      },
      {
        plan: {
          exitCode: 2,
          stdout: JSON.stringify({ ok: false, error: { message: 'plan refused', hint: 'try again' } }),
          stderr: '',
        },
      },
    )
  })

  test('the snapshot is cached until an explicit refresh', async () => {
    await withServer(async (server, _invoke, calls) => {
      await snapshotOf(await authed(server, '/api/snapshot'))
      await snapshotOf(await authed(server, '/api/snapshot'))
      assert.equal(calls.length, 6)
      await snapshotOf(await authed(server, '/api/snapshot?refresh=1'))
      assert.equal(calls.length, 12)
    })
  })

  test('offline is passed to both guidance commands', async () => {
    await withServer(async (server, _invoke, calls) => {
      await snapshotOf(await authed(server, '/api/snapshot'))
      assert.ok(calls.some((args) => args.join(' ') === 'plan --offline --json'))
      assert.ok(calls.some((args) => args.join(' ') === 'brief --offline --json'))
      assert.equal(
        calls.some((args) => args.includes('--refresh')),
        false,
      )
    })
  })
})

describe('the snapshot reader', () => {
  test('a staged read error survives into the snapshot instead of an empty diff', async () => {
    const { invoke } = fakeInvoke()
    const broken: StagedView = {
      ...staged,
      files: [
        {
          path: '.anvil/AGENTS.md',
          diff: '',
          edited: true,
          error: 'Staged file could not be read: files/AGENTS.md',
        },
      ],
    }
    const snapshot = await loadSnapshot({ cwd: '/repo', invoke, readStaged: () => broken })
    assert.equal(snapshot.context.staged.ok, true)
    const file = snapshot.context.staged.data?.files[0]
    assert.equal(file?.diff, '')
    assert.match(file?.error ?? '', /could not be read/)
  })

  test('opt-in verification evidence is bounded and recorded beside the sources', async () => {
    const { invoke } = fakeInvoke()
    const record = {
      command: 'npm test',
      revision: 'abcdef1234',
      exitCode: 0,
      timestamp: '2026-11-20T10:00:00.000Z',
    }
    const snapshot = await loadSnapshot({
      cwd: '/repo',
      invoke,
      readStaged: () => staged,
      readVerification: () => [
        record,
        { command: '' },
        { note: 'not a command' },
        'ignored',
        { command: ' ', revision: 'bogus', exitCode: 0.5, timestamp: 'not a date' },
        { ...record, revision: 'a'.repeat(40) },
        { ...record, timestamp: '2026-02-31T00:00:00.000Z' },
        { ...record, exitCode: 3010 },
        ...Array.from({ length: 20 }, () => ({ command: '' })),
      ],
    })
    assert.equal(snapshot.verification.status, 'recorded')
    assert.deepEqual(snapshot.verification.evidence, [
      { ...record, matchesCurrent: null },
      { ...record, revision: 'a'.repeat(40), matchesCurrent: null },
      { ...record, exitCode: 3010, matchesCurrent: null },
    ])
    assert.equal(snapshot.verification.currentRevision, null)
    assert.ok(snapshot.verification.incompleteCount > 0)
  })

  test('verification records are bound to the revision sampled by the CLI', async () => {
    const { invoke } = fakeInvoke()
    const current = {
      command: 'npm test',
      revision: 'abcdef1234',
      exitCode: 0,
      timestamp: '2026-11-20T10:00:00.000Z',
    }
    const stale = { ...current, revision: 'fffffffff', command: 'npm run lint' }
    const snapshot = await loadSnapshot({
      cwd: '/repo',
      invoke,
      readStaged: () => staged,
      currentRevision: 'abcdef1234',
      readVerification: () => [stale, current],
    })
    assert.equal(snapshot.verification.status, 'recorded')
    assert.equal(snapshot.verification.currentRevision, 'abcdef1234')
    assert.deepEqual(
      snapshot.verification.evidence.map((item) => item.matchesCurrent),
      [false, true],
    )
    assert.match(snapshot.verification.reason, /different revision/)
  })

  test('verification compares commit ids case-insensitively', async () => {
    const { invoke } = fakeInvoke()
    const snapshot = await loadSnapshot({
      cwd: '/repo',
      invoke,
      readStaged: () => staged,
      currentRevision: 'ABCDEF1234',
      readVerification: () => [
        {
          command: 'npm test',
          revision: 'abcdef1234-dirty',
          exitCode: 0,
          timestamp: '2026-11-20T10:00:00.000Z',
        },
      ],
    })
    assert.deepEqual(
      snapshot.verification.evidence.map((item) => item.matchesCurrent),
      [true],
    )
    assert.doesNotMatch(snapshot.verification.reason, /different revision/)
  })

  test('a store of only incomplete records says so instead of claiming no evidence', async () => {
    const { invoke } = fakeInvoke()
    const snapshot = await loadSnapshot({
      cwd: '/repo',
      invoke,
      readStaged: () => staged,
      readVerification: () => [{ command: 'npm test', revision: null, exitCode: 0, timestamp: null }],
    })
    assert.equal(snapshot.verification.status, 'unavailable')
    assert.equal(snapshot.verification.incompleteCount, 1)
    assert.match(snapshot.verification.reason, /incomplete/)
  })

  test('a thrown invocation becomes one error, not a rejected promise', async () => {
    const { invoke } = fakeInvoke()
    const snapshot = await loadSnapshot({
      cwd: '/repo',
      invoke: async (args) => {
        if (args[0] === 'crew') throw new Error('spawn failed')
        return invoke(args, '/repo')
      },
      readStaged: () => staged,
    })
    assert.equal(snapshot.work.crew.ok, false)
    assert.match(snapshot.work.crew.error ?? '', /spawn failed/)
    assert.equal(snapshot.repository.doctor.ok, true)
  })
})

describe('the dashboard page', () => {
  class FakeElement {
    children: FakeElement[] = []
    textContent = ''
    className = ''
    dataset: Record<string, string> = {}
    hidden = false
    disabled = false
    value = ''
    focused = false
    classList = { toggle() {} }
    listeners: Record<string, Array<() => void>> = {}

    focus(): void {
      this.focused = true
    }

    setSelectionRange(): void {}

    readonly tag: string

    constructor(tag: string) {
      this.tag = tag
    }

    appendChild(node: FakeElement): FakeElement {
      this.children.push(node)
      return node
    }

    replaceChildren(...nodes: FakeElement[]): void {
      this.children = nodes
    }

    querySelectorAll(selector: string): FakeElement[] {
      const found: FakeElement[] = []
      const visit = (node: FakeElement): void => {
        if (selector === 'button' && node.tag === 'button') found.push(node)
        for (const child of node.children) visit(child)
      }
      visit(this)
      return found
    }

    addEventListener(type: string, callback: () => void): void {
      const list = this.listeners[type] ?? []
      list.push(callback)
      this.listeners[type] = list
    }

    setAttribute(): void {}

    select(): void {}

    text(): string {
      return [this.textContent, ...this.children.map((child) => child.text())].filter(Boolean).join('\n')
    }
  }

  test('a build during a pending first snapshot is disabled and a finished load clears the brief error', async () => {
    const nodes = new Map<string, FakeElement>(
      [
        'task',
        'task-text',
        'task-submit',
        'task-error',
        'task-suggestions',
        'task-brief',
        'task-map',
        'snapshot-error',
        'refresh-error',
        'repository',
        'context',
        'work',
        'refresh',
        'scope',
        'stamp',
        'notes',
      ].map((id) => [`#${id}`, new FakeElement('section')]),
    )
    const document = {
      createElement: (tag: string) => new FakeElement(tag),
      querySelector: (id: string) => nodes.get(id),
      querySelectorAll: () => [],
    }
    const source = <T>(data: T) => ({ ok: true, data, error: null, fetchedAt: 'now', command: 'anvil fake' })
    const snapshot = {
      schemaVersion: 1 as const,
      fetchedAt: 'now',
      repository: {
        doctor: source({}),
        ready: source({}),
        plan: source({ suggestions: [] }),
        profile: source({ files: [], modules: [] }),
      },
      context: { brief: source({}), staged: source({}) },
      work: { crew: source({ crew: [] }) },
      verification: {
        status: 'unavailable' as const,
        reason: 'unavailable',
        currentRevision: null,
        incompleteCount: 0,
        evidence: [],
      },
      notes: [],
    }

    // A controllable, delayed invoker: the snapshot fetch resolves only when the test releases it.
    let resolveSnapshot: (() => void) | null = null
    const fetched: string[] = []
    const fetchStub = async (url: string) => {
      fetched.push(url)
      if (url.startsWith('/api/snapshot')) {
        return await new Promise((resolve) => {
          resolveSnapshot = () => resolve({ ok: true, json: async () => snapshot })
        })
      }
      // The brief POST races the still-pending first load and hits the no-snapshot 409.
      return {
        ok: false,
        status: 409,
        json: async () => ({ error: 'No snapshot yet. Reload the page, then build the brief.' }),
      }
    }
    const context = createContext({ document, console, fetch: fetchStub })
    runInContext(JS.replace('load(false);', ''), context)
    runInContext('__state = state', context)
    const stateRef = (context as Record<string, unknown>).__state as {
      taskError: string | null
      loading: boolean
      taskPending: boolean
    }

    const loading = runInContext('load(false)', context) as Promise<void>
    assert.equal(nodes.get('#task-submit')?.disabled, true, 'submit is disabled while the first snapshot loads')
    assert.equal(stateRef.loading, true)

    // Reproduce the racing build: the 409 is recorded as the brief error.
    const building = runInContext('requestBrief({ text: "Update src/server.ts" })', context) as Promise<void>
    await building
    assert.match(stateRef.taskError ?? '', /Reload the page/, 'the racing 409 set the brief error')

    // Release the delayed snapshot load.
    assert.ok(resolveSnapshot !== null, 'the snapshot fetch must still be pending')
    ;(resolveSnapshot as () => void)()
    await loading

    assert.equal(stateRef.taskError, null, 'the arriving snapshot clears the stale brief error')
    assert.equal(nodes.get('#task-error')?.textContent, '', 'the stale error is no longer on screen')
    assert.equal(nodes.get('#task-submit')?.disabled, false, 'submit works once a snapshot exists')
    assert.deepEqual(fetched, ['/api/snapshot', '/api/brief'])
  })

  test('a brief from a superseded snapshot is discarded after a refresh', async () => {
    const nodes = new Map<string, FakeElement>(
      [
        'task',
        'task-text',
        'task-submit',
        'task-error',
        'task-suggestions',
        'task-brief',
        'task-map',
        'snapshot-error',
        'refresh-error',
        'repository',
        'context',
        'work',
        'refresh',
        'scope',
        'stamp',
        'notes',
      ].map((id) => [`#${id}`, new FakeElement('section')]),
    )
    const document = {
      createElement: (tag: string) => new FakeElement(tag),
      querySelector: (id: string) => nodes.get(id),
      querySelectorAll: () => [],
    }
    const source = <T>(data: T) => ({ ok: true, data, error: null, fetchedAt: 'now', command: 'anvil fake' })
    const snapshot = (fetchedAt: string): object => ({
      schemaVersion: 1,
      fetchedAt,
      repository: {
        doctor: source({}),
        ready: source({}),
        plan: source({ suggestions: [{ id: 'fix:A', tier: 'derived', detail: 'Fix A -- because A' }] }),
        profile: source({ files: [], modules: [] }),
      },
      context: { brief: source({}), staged: source({}) },
      work: { crew: source({ crew: [] }) },
      verification: {
        status: 'unavailable',
        reason: 'unavailable',
        currentRevision: null,
        incompleteCount: 0,
        evidence: [],
      },
      notes: [],
    })
    const snapshotA = snapshot('A')
    const snapshotB = snapshot('B')
    const briefA = { title: 'Brief from A', generatedAt: 'A', map: { nodes: [], edges: [] } }

    type Reply = { ok: boolean; json: () => Promise<unknown> }
    const deferred = (): { promise: Promise<Reply>; resolve: (reply: Reply) => void } => {
      let resolve!: (reply: Reply) => void
      const promise = new Promise<Reply>((done) => {
        resolve = done
      })
      return { promise, resolve }
    }
    const delayedSnapshot = deferred()
    const delayedBrief = deferred()
    const fetched: string[] = []
    let snapshotRequests = 0
    const fetchStub = (url: string): Promise<Reply> => {
      fetched.push(url)
      if (url.startsWith('/api/snapshot')) {
        snapshotRequests += 1
        if (snapshotRequests === 1) return Promise.resolve({ ok: true, json: async () => snapshotA })
        return delayedSnapshot.promise
      }
      return delayedBrief.promise
    }
    const context = createContext({ document, console, fetch: fetchStub })
    runInContext(JS.replace('load(false);', ''), context)
    runInContext('__state = state', context)
    const stateRef = (context as Record<string, unknown>).__state as {
      brief: unknown
      snapshot: unknown
      snapshotGeneration: number
      loading: boolean
    }

    await (runInContext('load(false)', context) as Promise<void>)
    const suggestions = nodes.get('#task-suggestions')
    assert.ok(suggestions)
    assert.equal(suggestions.children.length, 1)
    const suggestionButton = suggestions.children[0]?.children[0]
    assert.ok(suggestionButton)
    assert.equal(suggestionButton.disabled, false, 'the suggestion entry point works with a snapshot')
    assert.equal(nodes.get('#task-submit')?.disabled, false)

    const refreshing = runInContext('load(true)', context) as Promise<void>
    assert.equal(stateRef.loading, true)
    assert.equal(nodes.get('#task-submit')?.disabled, true, 'pasted-text build is disabled during a refresh')
    assert.equal(suggestionButton.disabled, true, 'suggestion build is disabled during a refresh')

    // A build already in flight from the old generation still has to be discarded once the
    // refresh delivers a newer snapshot before its answer arrives.
    const building = runInContext('requestBrief({ suggestionId: "fix:A" })', context) as Promise<void>
    assert.deepEqual(fetched, ['/api/snapshot', '/api/snapshot?refresh=1', '/api/brief'])
    delayedSnapshot.resolve({ ok: true, json: async () => snapshotB })
    await refreshing
    assert.equal(stateRef.snapshotGeneration, 2)
    assert.equal(stateRef.brief, null, 'the refresh clears the previous brief')

    delayedBrief.resolve({ ok: true, json: async () => briefA })
    await building
    assert.equal(stateRef.snapshot, snapshotB)
    assert.equal(stateRef.brief, null, 'the stale brief must not be applied to snapshot B')
    assert.equal(nodes.get('#task-brief')?.children.length, 0, 'the stale brief is not rendered')
    assert.equal(nodes.get('#task-map')?.children.length, 0, 'the stale map is not rendered')
  })

  test('a late brief failure is discarded when a refresh has already delivered a newer snapshot', async () => {
    const nodes = new Map<string, FakeElement>(
      [
        'task',
        'task-text',
        'task-submit',
        'task-error',
        'task-suggestions',
        'task-brief',
        'task-map',
        'snapshot-error',
        'refresh-error',
        'repository',
        'context',
        'work',
        'refresh',
        'scope',
        'stamp',
        'notes',
      ].map((id) => [`#${id}`, new FakeElement('section')]),
    )
    const document = {
      createElement: (tag: string) => new FakeElement(tag),
      querySelector: (id: string) => nodes.get(id),
      querySelectorAll: () => [],
    }
    const source = <T>(data: T) => ({ ok: true, data, error: null, fetchedAt: 'now', command: 'anvil fake' })
    const snapshot = (snapshotId: string): object => ({
      schemaVersion: 1,
      snapshotId,
      fetchedAt: 'now',
      repository: {
        doctor: source({}),
        ready: source({}),
        plan: source({ suggestions: [] }),
        profile: source({ files: [], modules: [] }),
      },
      context: { brief: source({}), staged: source({}) },
      work: { crew: source({ crew: [] }) },
      verification: {
        status: 'unavailable',
        reason: 'unavailable',
        currentRevision: null,
        incompleteCount: 0,
        evidence: [],
      },
      notes: [],
    })

    type Reply = { ok: boolean; json: () => Promise<unknown> }
    let rejectBrief!: (error: Error) => void
    let resolveRefresh!: (reply: Reply) => void
    const briefBodies: unknown[] = []
    let snapshotRequests = 0
    const fetchStub = (url: string, init?: { body?: string }): Promise<Reply> => {
      if (url === '/api/brief') {
        briefBodies.push(JSON.parse(init?.body ?? '{}'))
        return new Promise((_resolve, reject) => {
          rejectBrief = reject
        })
      }
      snapshotRequests += 1
      if (snapshotRequests === 1) return Promise.resolve({ ok: true, json: async () => snapshot('A') })
      return new Promise((resolve) => {
        resolveRefresh = resolve
      })
    }
    const context = createContext({ document, console, fetch: fetchStub })
    runInContext(JS.replace('load(false);', ''), context)
    runInContext('__state = state', context)
    const stateRef = (context as Record<string, unknown>).__state as {
      taskError: string | null
      snapshotGeneration: number
    }

    await (runInContext('load(false)', context) as Promise<void>)
    const building = runInContext('requestBrief({ text: "Update README.md" })', context) as Promise<void>
    assert.deepEqual(briefBodies, [{ text: 'Update README.md', snapshotId: 'A' }])

    const refreshing = runInContext('load(true)', context) as Promise<void>
    resolveRefresh({ ok: true, json: async () => snapshot('B') })
    await refreshing
    assert.equal(stateRef.snapshotGeneration, 2)

    rejectBrief(new Error('Failed to fetch (old snapshot)'))
    await building
    assert.equal(stateRef.taskError, null, 'the old failure must not be painted over snapshot B')
    assert.equal(nodes.get('#task-error')?.textContent, '')
  })

  test('the claim input keeps long nested issue URLs instead of truncating them', () => {
    const parent = new FakeElement('div')
    const context = createContext({
      document: {
        createElement: (tag: string) => new FakeElement(tag),
        querySelector: () => ({ addEventListener() {} }),
        querySelectorAll: () => [],
      },
      __parent: parent,
    })
    runInContext(JS.replace('load(false);', ''), context)
    runInContext('renderActions(__parent)', context)
    let claim: FakeElement | undefined
    const walk = (node: FakeElement): void => {
      if ((node as unknown as { placeholder?: string }).placeholder === 'ticket reference') claim = node
      for (const child of node.children) walk(child)
    }
    walk(parent)
    assert.ok(claim, 'the claim input must be rendered')
    // The server accepts ticket URLs up to 500 characters (MAX_TICKET_URL_LENGTH); the UI bound
    // must match or a 233-char GitLab issue URL silently loses its `/-/issues/123` suffix.
    assert.equal((claim as unknown as { maxLength: number }).maxLength, 500)
  })

  test('status badges are matched exactly, not by substring', () => {
    const context = createContext({
      document: {
        createElement: () => ({
          className: '',
          textContent: '',
          appendChild() {},
          replaceChildren() {},
          addEventListener() {},
        }),
        querySelector: () => ({ addEventListener() {} }),
        querySelectorAll: () => [],
      },
    })
    runInContext(JS.replace('load(false);', ''), context)

    const unavailable = runInContext("badge('unavailable')", context)
    assert.equal(unavailable.className, 'badge unknown')
    const available = runInContext("badge('available')", context)
    assert.equal(available.className, 'badge available')
    const incompatible = runInContext("badge('incompatible')", context)
    assert.equal(incompatible.className, 'badge fail')
  })

  test('the views surface blocker causes, read errors, orphaned work and plan details', () => {
    const nodes = new Map<string, FakeElement>(
      [
        'task',
        'task-text',
        'task-submit',
        'task-error',
        'task-suggestions',
        'task-brief',
        'task-map',
        'snapshot-error',
        'repository',
        'context',
        'work',
        'refresh',
        'scope',
        'stamp',
        'notes',
      ].map((id) => [`#${id}`, new FakeElement('section')]),
    )
    const document = {
      createElement: (tag: string) => new FakeElement(tag),
      querySelector: (id: string) => nodes.get(id),
      querySelectorAll: () => [],
    }
    const source = <T>(data: T) => ({
      ok: true,
      data,
      error: null,
      fetchedAt: 'now',
      command: 'anvil test --json',
    })
    const snapshot: DashboardSnapshot = {
      schemaVersion: 1,
      fetchedAt: 'now',
      repository: {
        doctor: source({ score: 90, grade: 'A', findings: [], degraded: [] }),
        ready: source({
          status: 'blocked',
          checked: true,
          root: '/repo',
          tools: [],
          env: [{ name: 'GITHUB_TOKEN', status: 'missing', reason: 'needed for gh' }],
          services: [],
          references: [
            {
              id: 'requirements',
              path: 'docs/requirements.md',
              required: true,
              status: 'missing',
              reason: 'approved context',
            },
            { id: 'optional', path: 'docs/optional.md', required: false, status: 'missing' },
          ],
          credentials: [],
          access: [],
          hardware: [],
          context: [{ id: 'instructions', label: 'Agent instructions', status: 'blocked', detail: 'no context' }],
        }),
        plan: source({
          satisfied: 0,
          suggestions: [
            {
              tier: 'derived',
              id: 'fix:verify',
              title: 'Add test command',
              detail: 'Document npm test in AGENTS.md',
              evidence: ['AGENTS.md:3'],
            },
          ],
        }),
        profile: source({
          root: '/repo',
          projectDir: '',
          files: ['AGENTS.md', 'src/app.ts', 'src/app.test.ts'],
          commands: { test: [{ cmd: 'npm test', source: 'documented', evidence: 'AGENTS.md:3' }] },
          diagnostics: { truncated: false, fileLimit: 20000, failedDetectors: [] },
        }),
      },
      context: {
        brief: source({ target: 'all', gaps: [] }),
        staged: source({
          exists: true,
          createdAt: 'now',
          inputHash: 'test-hash',
          summary: { files: 1, added: 0, removed: 0 },
          files: [
            {
              path: 'AGENTS.md',
              diff: '',
              edited: true,
              error: 'Staged file could not be read: files/AGENTS.md',
            },
          ],
        }),
      },
      work: {
        crew: source({
          crew: [
            {
              key: 'local-1',
              branch: 'feat/one',
              worktree: '/gone',
              present: false,
              uncommitted: 0,
              unpushed: null,
              agentAlive: null,
              state: 'active',
              orphaned: true,
            },
          ],
        }),
      },
      verification: {
        status: 'unavailable',
        reason: 'not persisted',
        currentRevision: null,
        incompleteCount: 0,
        evidence: [],
      },
      notes: [],
    }

    const context = createContext({ document })
    ;(context as Record<string, unknown>).__snapshot = snapshot
    ;(context as Record<string, unknown>).__brief = {
      schemaVersion: 1,
      generatedAt: 'now',
      source: { suggestionId: null, text: 'Remove visit status' },
      title: 'Remove visit status',
      objective: 'Remove visit status; notes and rating are lost.',
      startHere: [
        {
          path: 'app/src/main/kotlin/com/example/UnvisitedConfirmationDialog.kt',
          reason: 'path matches "unvisited"',
          kind: 'source',
        },
        {
          path: 'app/src/test/kotlin/com/example/CountryDetailViewModelTest.kt',
          reason: 'test for the detail screen',
          kind: 'test',
        },
      ],
      howToCheck: [
        {
          kind: 'test',
          cmd: './gradlew testDebugUnitTest',
          source: 'documented',
          evidence: 'README.md:140',
          cwd: '.',
          scope: 'local',
        },
      ],
      blockers: [{ label: 'java', status: 'missing', reason: 'not on PATH' }],
      gates: [
        {
          kind: 'approval',
          startNow: 'audit and proposal',
          waitFor: 'implementation',
          evidence: 'The audit and proposal are approved before implementation.',
        },
      ],
      readiness: { ok: true, checked: true, status: 'blocked' },
      unknowns: ['No approval gate was found in the pasted text.'],
      map: {
        schemaVersion: 1,
        focus: 'Remove visit status',
        nodes: [
          {
            id: 'file:a',
            label: 'UnvisitedConfirmationDialog.kt',
            kind: 'file',
            reason: 'matched',
            evidence: 'anvil profile --json: files[a]',
          },
        ],
        edges: [],
        hasUnknown: false,
      },
    }
    runInContext(JS.replace('load(false);', ''), context)
    runInContext(
      'state.brief = __brief; renderTask(document, __snapshot); renderRepository(document, __snapshot); renderContext(document, __snapshot); renderWork(document, __snapshot);',
      context,
    )

    const suggestions = nodes.get('#task-suggestions')?.text() ?? ''
    assert.match(suggestions, /Add test command/)
    assert.match(suggestions, /Document npm test in AGENTS\.md/)

    const task = nodes.get('#task-brief')?.text() ?? ''
    assert.match(task, /Start here/)
    assert.match(task, /UnvisitedConfirmationDialog\.kt/)
    assert.match(task, /CountryDetailViewModelTest\.kt/)
    assert.match(task, /Start now:\s+audit and proposal/)
    assert.match(task, /Wait for approval:\s+implementation/)
    assert.match(task, /approved before implementation/)
    assert.match(task, /\.\/gradlew testDebugUnitTest/)
    assert.match(task, /Not run/)
    assert.match(task, /java/)
    assert.match(task, /No approval gate was found/)

    const taskMap = nodes.get('#task-map')?.text() ?? ''
    assert.match(taskMap, /Task map/)
    assert.match(taskMap, /UnvisitedConfirmationDialog\.kt/)
    assert.match(taskMap, /Map/)
    assert.match(taskMap, /List/)

    const repository = nodes.get('#repository')?.text() ?? ''
    assert.match(repository, /docs\/requirements\.md/)
    assert.doesNotMatch(repository, /docs\/optional\.md/)
    assert.match(repository, /GITHUB_TOKEN/)
    assert.match(repository, /Agent instructions/)
    assert.match(repository, /Document npm test in AGENTS\.md/)
    assert.match(repository, /AGENTS\.md:3/)

    const contextText = nodes.get('#context')?.text() ?? ''
    assert.match(contextText, /Staged file could not be read/)
    assert.doesNotMatch(contextText, /No changes against the repository copy/)

    const work = nodes.get('#work')?.text() ?? ''
    assert.match(work, /orphaned/)
    assert.doesNotMatch(work, /active/)
  })

  test('the selected-list boundary is stated for complete, truncated and unknown coverage', () => {
    const render = (checkSelection: {
      selected: number
      detectedCiChecks: number
      complete: boolean | null
    }): string => {
      const nodes = new Map<string, FakeElement>(
        [
          'task',
          'task-text',
          'task-submit',
          'task-error',
          'task-suggestions',
          'task-brief',
          'task-map',
          'snapshot-error',
          'refresh',
          'refresh-error',
          'scope',
          'stamp',
          'notes',
        ].map((id) => [`#${id}`, new FakeElement('section')]),
      )
      const document = {
        createElement: (tag: string) => new FakeElement(tag),
        querySelector: (id: string) => nodes.get(id),
        querySelectorAll: () => [],
      }
      const source = <T>(data: T) => ({ ok: true, data, error: null, fetchedAt: 'now', command: 'anvil fake' })
      const snapshot = {
        schemaVersion: 1 as const,
        fetchedAt: 'now',
        repository: {
          doctor: source({}),
          ready: source({ projectDir: '', commands: [] }),
          plan: source({ suggestions: [] }),
          profile: source({ files: [], commands: {} }),
        },
        context: { brief: source({}), staged: source({}) },
        work: { crew: source({ crew: [] }) },
        verification: {
          status: 'unavailable' as const,
          reason: 'unavailable',
          currentRevision: null,
          incompleteCount: 0,
          evidence: [],
        },
        notes: [],
      }
      const brief = {
        schemaVersion: 1,
        generatedAt: 'now',
        source: { suggestionId: null, text: 'Review CI' },
        title: 'Review CI',
        objective: '',
        startHere: [],
        map: { schemaVersion: 1, focus: 'Review CI', nodes: [], edges: [], hasUnknown: false },
        howToCheck: [],
        checkSelection,
        blockers: [],
        gates: [],
        readiness: { ok: true, checked: true, status: 'ok' },
        unknowns: [],
      }
      const context = createContext({ document, console })
      runInContext(JS.replace('load(false);', ''), context)
      ;(context as Record<string, unknown>).__snapshot = snapshot
      ;(context as Record<string, unknown>).__brief = brief
      runInContext('state.brief = __brief; renderTask(document, __snapshot);', context)
      return nodes.get('#task-brief')?.text() ?? ''
    }

    // Complete coverage still says "not a pass claim", never "verified".
    const complete = render({ selected: 3, detectedCiChecks: 2, complete: true })
    assert.match(complete, /How to check \(selected\)/)
    assert.match(complete, /not an exhaustive CI inventory and not a pass claim/)

    // A truncated list names the numbers.
    const truncated = render({ selected: 8, detectedCiChecks: 12, complete: false })
    assert.match(truncated, /Selected 8 check\(s\); the profile detected 12 workflow check\(s\)/)

    // A failed profile is unknown coverage, not "everything detected is shown".
    const unknown = render({ selected: 0, detectedCiChecks: 0, complete: null })
    assert.match(unknown, /coverage is unknown because the profile source failed/)
    assert.doesNotMatch(unknown, /include every workflow check/)
  })

  test('an action result stays visible across a re-render', () => {
    const nodes = new Map<string, FakeElement>([
      ['#work', new FakeElement('section')],
      ['#task-submit', new FakeElement('button')],
      ['#refresh', new FakeElement('button')],
    ])
    const document = {
      createElement: (tag: string) => new FakeElement(tag),
      querySelector: (id: string) => nodes.get(id),
      querySelectorAll: () => [],
    }
    const source = <T>(data: T) => ({ ok: true, data, error: null, fetchedAt: 'now', command: 'anvil fake' })
    const snapshot = {
      schemaVersion: 1 as const,
      fetchedAt: 'now',
      repository: { doctor: source({}), ready: source({}), plan: source({}), profile: source({}) },
      context: { brief: source({}), staged: source({}) },
      work: { crew: source({ crew: [] }) },
      verification: {
        status: 'unavailable' as const,
        reason: 'unavailable',
        currentRevision: null,
        incompleteCount: 0,
        evidence: [],
      },
      notes: [],
    }
    const context = createContext({ document, console })
    runInContext(JS.replace('load(false);', ''), context)
    ;(context as unknown as { __snapshot: DashboardSnapshot }).__snapshot = snapshot as unknown as DashboardSnapshot
    runInContext(
      "state.actionResult = { ok: false, command: 'anvil ship local-1 --probe --json', exitCode: 2, error: 'verify failed', stages: [], skipped: [], warnings: [] }; renderWork(document, __snapshot); renderWork(document, __snapshot);",
      context,
    )
    const work = nodes.get('#work')?.text() ?? ''
    assert.match(work, /anvil ship local-1 --probe --json - verify failed/)
  })

  test('a failed refresh keeps the last snapshot and the refused action result', async () => {
    const nodes = new Map<string, FakeElement>(
      [
        'task',
        'task-text',
        'task-submit',
        'task-error',
        'task-suggestions',
        'task-brief',
        'task-map',
        'snapshot-error',
        'work',
        'repository',
        'context',
        'refresh',
        'refresh-error',
        'scope',
        'stamp',
        'notes',
      ].map((id) => [`#${id}`, new FakeElement('section')]),
    )
    const document = {
      createElement: (tag: string) => new FakeElement(tag),
      querySelector: (id: string) => nodes.get(id),
      querySelectorAll: () => [],
    }
    const source = <T>(data: T) => ({ ok: true, data, error: null, fetchedAt: 'now', command: 'anvil fake' })
    const snapshot = {
      schemaVersion: 1 as const,
      fetchedAt: 'now',
      repository: { doctor: source({}), ready: source({}), plan: source({}), profile: source({}) },
      context: { brief: source({}), staged: source({}) },
      work: { crew: source({ crew: [{ key: 'claim-1' }] }) },
      verification: {
        status: 'unavailable' as const,
        reason: 'unavailable',
        currentRevision: null,
        incompleteCount: 0,
        evidence: [],
      },
      notes: [],
    }
    const context = createContext({
      document,
      console,
      window: { confirm: () => true },
      fetch: async (url: string) => {
        assert.match(url, /\/api\/snapshot\?refresh=1/)
        return { ok: false, status: 500, json: async () => ({}) }
      },
    })
    runInContext(JS.replace('load(false);', ''), context)
    ;(context as unknown as { __snapshot: DashboardSnapshot }).__snapshot = snapshot as unknown as DashboardSnapshot
    runInContext(
      "state.snapshot = __snapshot; state.view = 'work'; state.actionResult = { ok: false, command: 'anvil ship claim-1 --probe --json', exitCode: 2, error: 'Refusing to ship without a passing verify', stages: [], skipped: [], warnings: [] }; render();",
      context,
    )
    assert.match(nodes.get('#work')?.text() ?? '', /Refusing to ship/)

    await runInContext('load(true)', context)

    // The refusal and the last good snapshot survive; the refresh error is shown apart.
    assert.match(nodes.get('#work')?.text() ?? '', /Refusing to ship/)
    assert.match(nodes.get('#work')?.text() ?? '', /claim-1/)
    assert.match(nodes.get('#refresh-error')?.text() ?? '', /snapshot request failed: 500/)
  })

  test('a failed snapshot keeps the entry-point form and says the report is missing', () => {
    const nodes = new Map<string, FakeElement>(
      [
        'task',
        'task-text',
        'task-submit',
        'task-error',
        'task-suggestions',
        'task-brief',
        'snapshot-error',
        'refresh-error',
        'repository',
        'context',
        'work',
        'refresh',
        'scope',
        'stamp',
        'notes',
      ].map((id) => [`#${id}`, new FakeElement('section')]),
    )
    // The draft a reader already typed; a failed refresh must not delete it.
    const draft = nodes.get('#task-text')
    assert.ok(draft !== undefined)
    draft.value = 'A ticket I am still writing'

    const document = {
      createElement: (tag: string) => new FakeElement(tag),
      querySelector: (id: string) => nodes.get(id),
      querySelectorAll: () => [],
    }
    const context = createContext({ document })
    runInContext(JS.replace('load(false);', ''), context)

    runInContext('showSnapshotError("snapshot request failed: 500")', context)
    const banner = nodes.get('#snapshot-error')
    assert.equal(banner?.hidden, false)
    // A first-load failure has no earlier snapshot, so it must not promise one.
    assert.match(banner?.text() ?? '', /Could not read the snapshot: snapshot request failed: 500/)
    assert.match(banner?.text() ?? '', /Nothing is loaded yet/)
    assert.doesNotMatch(banner?.text() ?? '', /last snapshot/)
    assert.equal(draft.value, 'A ticket I am still writing')

    runInContext('showSnapshotError(null)', context)
    assert.equal(banner?.hidden, true)
  })

  test('a brief with failed readiness says so instead of reporting no blockers', () => {
    const target = new FakeElement('div')
    const fakeDocument = {
      createElement: (tag: string) => new FakeElement(tag),
      querySelector: (id: string) => (id === '#task-brief' ? target : new FakeElement('button')),
      querySelectorAll: () => [],
    }
    const context = createContext({ document: fakeDocument })
    runInContext(JS.replace('load(false);', ''), context)

    ;(context as Record<string, unknown>).__failed = {
      title: 'Update README.md',
      startHere: [],
      howToCheck: [],
      blockers: [],
      gates: [],
      readiness: { ok: false, checked: false, status: null },
      unknowns: [],
    }
    runInContext('renderBrief(document.querySelector("#task-brief"), __failed)', context)
    const failed = target.text()
    assert.match(failed, /anvil ready failed, so blockers and tool availability are unknown/)
    assert.doesNotMatch(failed, /No blocked requirement is reported/)

    // Unprobed is not failed, and not a clean report either.
    ;(context as Record<string, unknown>).__unprobed = {
      ...((context as Record<string, unknown>).__failed as Record<string, unknown>),
      readiness: { ok: true, checked: false, status: 'unknown' },
    }
    runInContext('renderBrief(document.querySelector("#task-brief"), __unprobed)', context)
    const unprobed = target.text()
    assert.match(unprobed, /environment was not probed/)
    assert.doesNotMatch(unprobed, /anvil ready failed/)
  })

  test('a selected edge shows the edge evidence, not its destination node', () => {
    const target = new FakeElement('div')
    const brief = {
      title: 'Task',
      map: {
        schemaVersion: 1,
        focus: 'Task',
        nodes: [
          {
            id: 'file:a',
            label: 'a.ts',
            kind: 'file',
            reason: 'matched',
            evidence: 'anvil profile --json: files[a.ts]',
          },
          {
            id: 'module:x',
            label: 'x',
            kind: 'module',
            reason: 'dependency',
            evidence: 'anvil profile --json: modules[x]',
          },
        ],
        edges: [
          { from: 'file:a', to: 'module:x', label: 'located in', evidence: 'anvil profile --json: edge-evidence' },
        ],
        hasUnknown: false,
      },
    }
    const fakeDocument = {
      createElement: (tag: string) => new FakeElement(tag),
      querySelector: () => new FakeElement('button'),
      querySelectorAll: () => [],
    }
    const context = createContext({ document: fakeDocument })
    ;(context as Record<string, unknown>).__target = target
    ;(context as Record<string, unknown>).__brief = brief
    runInContext(JS.replace('load(false);', ''), context)
    runInContext("state.mapSelection = 'edge:file:a::module:x'; renderTaskMap(__target, __brief)", context)
    const text = target.text()
    assert.match(text, /edge-evidence/)
    assert.match(text, /file:a → module:x/)
  })

  test('filtering does not silently switch the selected edge to a different edge', () => {
    const target = new FakeElement('div')
    const brief = {
      title: 'Task',
      map: {
        schemaVersion: 1,
        focus: 'Task',
        nodes: [
          { id: 'file:a', label: 'alpha.ts', kind: 'file', reason: 'alpha file', evidence: 'alpha-node-evidence' },
          { id: 'module:x', label: 'alpha', kind: 'module', reason: 'alpha module', evidence: 'alpha-module-evidence' },
          { id: 'file:b', label: 'beta.ts', kind: 'file', reason: 'beta file', evidence: 'beta-node-evidence' },
          { id: 'module:y', label: 'beta', kind: 'module', reason: 'beta module', evidence: 'beta-module-evidence' },
        ],
        edges: [
          { from: 'file:a', to: 'module:x', label: 'located in', evidence: 'alpha-edge-evidence' },
          { from: 'file:b', to: 'module:y', label: 'located in', evidence: 'beta-edge-evidence' },
        ],
        hasUnknown: false,
      },
    }
    const fakeDocument = {
      createElement: (tag: string) => new FakeElement(tag),
      querySelector: () => new FakeElement('button'),
      querySelectorAll: () => [],
    }
    const context = createContext({ document: fakeDocument })
    ;(context as Record<string, unknown>).__target = target
    ;(context as Record<string, unknown>).__brief = brief
    runInContext(JS.replace('load(false);', ''), context)

    runInContext("state.mapSelection = 'edge:file:a::module:x'; renderTaskMap(__target, __brief)", context)
    assert.match(target.text(), /alpha-edge-evidence/, 'the first edge shows its own evidence')

    // Filtering to beta hides the selected edge. It must not silently become the beta edge,
    // which is what happened when selection was an index into the filtered edge list.
    runInContext("state.mapSearch = 'beta'; renderTaskMap(__target, __brief)", context)
    assert.doesNotMatch(target.text(), /beta-edge-evidence/)
    assert.match(target.text(), /Select a node or edge/)

    // Selecting the still-visible edge explicitly keeps working.
    runInContext("state.mapSelection = 'edge:file:b::module:y'; renderTaskMap(__target, __brief)", context)
    assert.match(target.text(), /beta-edge-evidence/)
  })

  test('filtering restores focus to the search input', () => {
    const target = new FakeElement('div')
    const fakeDocument = {
      createElement: (tag: string) => new FakeElement(tag),
      querySelector: () => new FakeElement('button'),
      querySelectorAll: () => [],
    }
    const context = createContext({ document: fakeDocument })
    ;(context as Record<string, unknown>).__target = target
    ;(context as Record<string, unknown>).__brief = { map: { nodes: [], edges: [], focus: '', hasUnknown: false } }
    runInContext(JS.replace('load(false);', ''), context)
    runInContext('renderTaskMap(__target, __brief, true)', context)
    const inputs: FakeElement[] = []
    const visit = (node: FakeElement): void => {
      if (node.tag === 'input') inputs.push(node)
      for (const child of node.children) visit(child)
    }
    visit(target)
    assert.equal(inputs.length, 1)
    assert.equal(inputs[0]?.focused, true)
  })

  test('the blocker handoff is copyable and keeps its measured text', () => {
    const target = new FakeElement('div')
    const brief = {
      title: 'Blocked task',
      startHere: [],
      howToCheck: [],
      blockers: [{ label: 'java', status: 'missing', reason: 'not on PATH' }],
      readiness: { ok: true, checked: true, status: 'blocked' },
      gates: [],
      unknowns: [],
      handoff: {
        available: true,
        text: 'Blocker handoff: Blocked task\n\n- java (missing): not on PATH',
      },
    }
    const fakeDocument = {
      createElement: (tag: string) => new FakeElement(tag),
      querySelector: () => new FakeElement('button'),
      querySelectorAll: () => [],
    }
    const context = createContext({ document: fakeDocument })
    runInContext(JS.replace('load(false);', ''), context)
    ;(context as Record<string, unknown>).__target = target
    ;(context as Record<string, unknown>).__brief = brief
    runInContext('renderBrief(__target, __brief)', context)
    const all: FakeElement[] = []
    const visit = (node: FakeElement): void => {
      all.push(node)
      for (const child of node.children) visit(child)
    }
    visit(target)
    const area = all.find((node) => node.tag === 'textarea')
    const copy = all.find((node) => node.tag === 'button' && node.textContent === 'Copy handoff')
    assert.ok(area)
    assert.ok(copy)
    assert.match(area?.value ?? '', /java \(missing\): not on PATH/)
    copy?.listeners.click?.[0]?.()
    assert.equal(copy?.textContent, 'Selected — press Ctrl+C')
  })
})

describe('dashboard gated actions', () => {
  function post(
    server: DashboardServerHandle,
    body: unknown,
    options: { cookie?: string | null; origin?: string; contentType?: string } = {},
  ): Promise<Response> {
    const url = new URL('/api/action', server.url)
    const headers: Record<string, string> = {
      'content-type': options.contentType ?? 'application/json',
      origin: options.origin ?? url.origin,
    }
    if (options.cookie !== null) headers.cookie = `${server.cookieName}=${options.cookie ?? TOKEN}`
    return fetch(url, { method: 'POST', headers, body: JSON.stringify(body) })
  }

  test('claim, verify and ship invoke only the fixed CLI argv, with --probe on ship', async () => {
    await withServer(async (server, _invoke, calls) => {
      const claim = await post(server, { action: 'claim', ref: 'anvil-88' })
      const claimText = await claim.text()
      assert.equal(claim.status, 200, claimText)
      assert.equal((JSON.parse(claimText) as { command: string }).command, 'anvil claim anvil-88 --json')

      const verify = await post(server, { action: 'verify' })
      assert.equal(verify.status, 200)
      const ship = await post(server, { action: 'ship', ref: 'claim-1' })
      assert.equal(ship.status, 200)
      assert.deepEqual(calls, [
        ['claim', 'anvil-88', '--json'],
        ['crew', 'verify', '--json'],
        ['ship', 'claim-1', '--probe', '--json'],
      ])
    })
  })

  test('a refused CLI command is shown as a failure, never as green', async () => {
    await withServer(
      async (server) => {
        const res = await post(server, { action: 'ship', ref: 'claim-1' })
        assert.equal(res.status, 200)
        const data = (await res.json()) as { ok: boolean; exitCode: number; error: string | null }
        assert.equal(data.ok, false)
        assert.notEqual(data.exitCode, 0)
        assert.match(data.error ?? '', /verify/)
      },
      {
        ship: {
          exitCode: 2,
          stdout: JSON.stringify({ ok: false, error: { message: 'Refusing to ship without a passing verify' } }),
          stderr: '',
        },
      },
    )
  })

  test('the POST needs the session cookie, a same-origin header and JSON', async () => {
    await withServer(async (server, _invoke, calls) => {
      assert.equal((await post(server, { action: 'verify' }, { cookie: null })).status, 401)
      assert.equal((await post(server, { action: 'verify' }, { cookie: 'wrong' })).status, 401)
      assert.equal((await post(server, { action: 'verify' }, { origin: 'https://evil.example' })).status, 403)
      assert.equal((await post(server, { action: 'verify' }, { contentType: 'text/plain' })).status, 415)
      assert.deepEqual(calls, [])
    })
  })

  test('the action route binds Origin to the request Host, not either loopback name', async () => {
    await withServer(async (server, _invoke, calls) => {
      const host = `127.0.0.1:${String(server.port)}`
      const opposite = `localhost:${String(server.port)}`

      const matching = await rawPost(
        server,
        '/api/action',
        { action: 'verify' },
        {
          host,
          origin: `http://${host}`,
        },
      )
      assert.equal(matching.status, 200, matching.body)

      for (const origin of [`http://${opposite}`, 'https://evil.example', undefined]) {
        const res = await rawPost(server, '/api/action', { action: 'verify' }, { host, origin })
        assert.equal(res.status, 403, res.body)
      }
      assert.deepEqual(calls, [['crew', 'verify', '--json']], 'only the matching-origin POST invokes the runner')
    })
  })

  test('application/jsonp is refused with 415 and never reaches the runner', async () => {
    await withServer(async (server, _invoke, calls) => {
      const res = await post(server, { action: 'verify' }, { contentType: 'application/jsonp' })
      assert.equal(res.status, 415)
      assert.deepEqual(calls, [])
    })
  })

  test('a malformed media-type parameter is refused with 415 and never reaches the runner', async () => {
    await withServer(async (server, _invoke, calls) => {
      for (const contentType of [
        'application/json;not-a-parameter',
        'application/json; charset',
        'application/json; =utf-8',
      ]) {
        const res = await post(server, { action: 'verify' }, { contentType })
        assert.equal(res.status, 415, contentType)
      }
      assert.deepEqual(calls, [], 'a malformed Content-Type must never invoke the runner')

      const valid = await post(server, { action: 'verify' }, { contentType: 'application/json; charset=utf-8' })
      assert.equal(valid.status, 200, await valid.clone().text())
      assert.deepEqual(calls, [['crew', 'verify', '--json']], 'a valid charset parameter reaches the runner')
    })
  })

  test('the action route checks headers before the body, so plain text is 415 with no runner call', async () => {
    await withServer(async (server, _invoke, calls) => {
      const url = new URL('/api/action', server.url)
      const rawPost = (contentType: string, body: string): Promise<Response> =>
        fetch(url, {
          method: 'POST',
          headers: {
            cookie: `${server.cookieName}=${TOKEN}`,
            origin: url.origin,
            'content-type': contentType,
          },
          body,
        })

      for (const contentType of [
        'application/json',
        'application/json; charset=utf-8',
        'application/json; charset="utf-8"',
      ]) {
        const res = await rawPost(contentType, JSON.stringify({ action: 'verify' }))
        assert.equal(res.status, 200, `${contentType}: ${await res.clone().text()}`)
      }
      assert.equal(calls.length, 3, 'a valid media type reaches the runner')

      const before = calls.length
      const rejected: Array<[string, string]> = [
        ['application/json; charset = utf-8', JSON.stringify({ action: 'verify' })],
        ['application/jsonp', JSON.stringify({ action: 'verify' })],
        ['application/json;not-a-parameter', JSON.stringify({ action: 'verify' })],
        ['text/plain', 'this is plain text, not a JSON object'],
      ]
      for (const [contentType, body] of rejected) {
        const res = await rawPost(contentType, body)
        assert.equal(res.status, 415, `${contentType}: ${await res.clone().text()}`)
      }
      assert.equal(calls.length, before, 'a rejected Content-Type must never invoke the runner')
    })
  })

  test('duplicate headers and invalid UTF-8 bytes are refused on both POST routes', async () => {
    await withServer(async (server, _invoke, calls) => {
      const rawPost = (
        path: string,
        headers: Record<string, string | string[]>,
        body: Buffer,
      ): Promise<{ status: number; text: string }> =>
        new Promise((resolve, reject) => {
          const url = new URL(path, server.url)
          const req = httpRequest(
            {
              hostname: '127.0.0.1',
              port: server.port,
              path,
              method: 'POST',
              headers: {
                cookie: `${server.cookieName}=${TOKEN}`,
                origin: url.origin,
                ...headers,
              },
            },
            (res) => {
              let text = ''
              res.setEncoding('utf8')
              res.on('data', (chunk) => {
                text += chunk
              })
              res.on('end', () => resolve({ status: res.statusCode ?? 0, text }))
            },
          )
          req.on('error', reject)
          req.end(body)
        })

      const withByte = (field: string): Buffer =>
        Buffer.concat([Buffer.from(`{"${field}":"`), Buffer.from([0xff]), Buffer.from('"}')])

      for (const path of ['/api/action', '/api/brief']) {
        const field = path === '/api/brief' ? 'text' : 'action'
        const valid = Buffer.from(JSON.stringify({ [field]: path === '/api/brief' ? 'Review' : 'verify' }))

        const duplicate = await rawPost(path, { 'content-type': ['application/json', 'text/plain'] }, valid)
        assert.equal(duplicate.status, 415, `${path}: duplicate Content-Type\n${duplicate.text}`)

        const invalid = await rawPost(path, { 'content-type': 'application/json' }, withByte(field))
        assert.equal(invalid.status, 400, `${path}: invalid UTF-8\n${invalid.text}`)
      }
      assert.deepEqual(calls, [], 'neither rejection may reach the action runner')
    })
  })

  test('a long nested GitLab issue URL is preserved as one bounded argv value', async () => {
    const base = 'https://gitlab.example.com/group/subgroup/project/-/issues/123?notification_referrer_id='
    const url = `${base}${'a'.repeat(233 - base.length)}`
    assert.equal(url.length, 233)
    assert.match(url, /\/-\/issues\/123/)
    assert.deepEqual(actionArgv('claim', url), ['claim', url, '--json'])
    await withServer(async (server, _invoke, calls) => {
      const res = await post(server, { action: 'claim', ref: url })
      assert.equal(res.status, 200, await res.clone().text())
      const data = (await res.json()) as { command: string }
      assert.equal(data.command, `anvil claim ${url} --json`)
      assert.deepEqual(calls, [['claim', url, '--json']])
    })
  })

  test('the request cannot choose a command, a path or extra arguments', async () => {
    await withServer(async (server, _invoke, calls) => {
      for (const body of [
        { action: 'claim', ref: 'x; rm -rf /' },
        { action: 'claim', ref: '../../etc/passwd' },
        { action: 'claim', ref: '-danger' },
        { action: 'ship' },
        { action: 'crew verify' },
        { action: 'verify', ref: 'x' },
      ]) {
        const res = await post(server, body)
        assert.equal(res.status, 400, JSON.stringify(body))
      }
      assert.deepEqual(calls, [])
    })
  })

  test('the page never fetches a session token into JavaScript', async () => {
    await withServer(async (server) => {
      const res = await fetch(new URL('/api/session-token', server.url), {
        headers: { cookie: `${server.cookieName}=${TOKEN}` },
      })
      assert.equal(res.status, 404)
      assert.doesNotMatch(JS, /session-token/)
    })
  })

  test('a full ticket URL with a query string is one argv value; the CLI resolves it', async () => {
    const url = 'https://github.com/tecruz/anvil/issues/88?notification_referrer_id=1'
    // The page never splits the reference: it stays one element, and --json is the only flag.
    assert.deepEqual(actionArgv('claim', url), ['claim', url, '--json'])
    await withServer(async (server, _invoke, calls) => {
      const res = await post(server, { action: 'claim', ref: url })
      assert.equal(res.status, 200, await res.clone().text())
      const data = (await res.json()) as { command: string }
      assert.equal(data.command, `anvil claim ${url} --json`)
      assert.deepEqual(calls, [['claim', url, '--json']])
    })
  })

  test('a zero exit with a failed CLI stage is not reported as a full success', async () => {
    const stdout = JSON.stringify({
      schemaVersion: 1,
      ok: true,
      command: 'ship',
      data: {
        schemaVersion: 1,
        key: 'claim-1',
        ok: true,
        stages: [
          { name: 'pr', ok: true, detail: 'opened #99' },
          { name: 'ticket', ok: false, detail: 'PR opened but the ticket was not updated: gh failed' },
        ],
        skipped: [],
        verification: [],
        risk: { level: 'low', highPaths: [], mediumPaths: [] },
      },
    })
    await withServer(
      async (server) => {
        const res = await post(server, { action: 'ship', ref: 'claim-1' })
        assert.equal(res.status, 200)
        const data = (await res.json()) as {
          ok: boolean
          exitCode: number
          error: string | null
          stages: Array<{ name: string; ok: boolean; detail: string }>
        }
        assert.equal(data.exitCode, 0)
        assert.equal(data.ok, false, 'a FAIL stage must not be green even when the CLI exits zero')
        assert.match(data.error ?? '', /ticket was not updated/)
        assert.deepEqual(data.stages, [
          { name: 'pr', ok: true, detail: 'opened #99' },
          { name: 'ticket', ok: false, detail: 'PR opened but the ticket was not updated: gh failed' },
        ])
      },
      { ship: { exitCode: 0, stdout, stderr: '' } },
    )
  })

  test('skipped checks and warnings from the CLI JSON reach the page result', async () => {
    const stdout = JSON.stringify({
      schemaVersion: 1,
      ok: true,
      command: 'crew verify',
      data: {
        schemaVersion: 1,
        ok: true,
        results: [{ key: 'claim-1', worktree: '/w', ok: true, commands: [] }],
        skipped: [{ key: 'claim-2', reason: 'worktree is gone: /gone' }],
      },
    })
    const shipStdout = JSON.stringify({
      schemaVersion: 1,
      ok: true,
      command: 'ship',
      data: {
        ok: true,
        stages: [
          { name: 'verify', ok: true, detail: '1 command(s) passed (inferred, not documented: npm test)' },
          { name: 'ticket', ok: true, detail: 'skipped (--no-ticket-update)' },
        ],
        risk: { level: 'high', highPaths: ['.github/workflows/ci.yml'], mediumPaths: [] },
      },
    })
    await withServer(
      async (server) => {
        const verify = (await (await post(server, { action: 'verify' })).json()) as { skipped: string[] }
        assert.ok(verify.skipped.some((s) => /claim-2.*worktree is gone/.test(s)))

        const ship = (await (await post(server, { action: 'ship', ref: 'claim-1' })).json()) as {
          skipped: string[]
          warnings: string[]
        }
        assert.ok(ship.skipped.some((s) => /ticket.*skipped/.test(s)))
        assert.ok(ship.warnings.some((w) => /inferred/.test(w)))
        assert.ok(ship.warnings.some((w) => /high risk/i.test(w)))
      },
      {
        crew: { exitCode: 0, stdout, stderr: '' },
        ship: { exitCode: 0, stdout: shipStdout, stderr: '' },
      },
    )
  })

  test('an invoker exception becomes a structured action error, not a plain-text 500', async () => {
    const { invoke } = fakeInvoke()
    const server = await createDashboardServer({
      cwd: '/repo',
      invoke,
      invokeAction: async () => {
        throw new Error('spawn anvil ETIMEDOUT')
      },
      readStaged: () => staged,
      token: TOKEN,
    })
    try {
      const res = await post(server, { action: 'verify' })
      assert.equal(res.status, 200)
      assert.match(res.headers.get('content-type') ?? '', /application\/json/)
      const data = (await res.json()) as { ok: boolean; error: string | null; exitCode: number }
      assert.equal(data.ok, false)
      assert.notEqual(data.exitCode, 0)
      assert.match(data.error ?? '', /ETIMEDOUT/)
    } finally {
      await server.close()
    }
  })

  test('actions use the long-running runner, not the snapshot runner', async () => {
    const { invoke } = fakeInvoke()
    let snapshotCalls = 0
    let actionCalls = 0
    const server = await createDashboardServer({
      cwd: '/repo',
      invoke: async (args, cwd) => {
        snapshotCalls += 1
        return invoke(args, cwd)
      },
      invokeAction: async (args, cwd) => {
        actionCalls += 1
        return invoke(args, cwd)
      },
      readStaged: () => staged,
      token: TOKEN,
    })
    try {
      const res = await post(server, { action: 'verify' })
      assert.equal(res.status, 200)
      assert.equal(snapshotCalls, 0)
      assert.equal(actionCalls, 1)
    } finally {
      await server.close()
    }
  })
})
