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
      if (key === 'ready') return envelope({ status: 'unknown', root: '/repo', checked: false, tools: [] })
      if (key === 'plan') return envelope({ score: 94, suggestions: [], satisfied: 2 })
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

  test('a snapshot combines every source and labels verification unavailable', async () => {
    await withServer(async (server) => {
      const snapshot = await snapshotOf(await authed(server, '/api/snapshot'))
      assert.equal(snapshot.schemaVersion, 1)
      const doctor = snapshot.repository.doctor.data as { score: number }
      const ready = snapshot.repository.ready.data as { root: string }
      const plan = snapshot.repository.plan.data as { satisfied: number }
      const brief = snapshot.context.brief.data as { target: string }
      const stagedData = snapshot.context.staged.data as StagedView
      const crew = snapshot.work.crew.data as { active: number }
      assert.equal(doctor.score, 94)
      assert.equal(ready.root, '/repo')
      assert.equal(plan.satisfied, 2)
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
      assert.equal(calls.length, 5)
      await snapshotOf(await authed(server, '/api/snapshot?refresh=1'))
      assert.equal(calls.length, 10)
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
    classList = { toggle() {} }

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

    addEventListener(): void {}

    text(): string {
      return [this.textContent, ...this.children.map((child) => child.text())].filter(Boolean).join('\n')
    }
  }

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
      ['repository', 'context', 'work', 'refresh', 'scope', 'stamp', 'notes'].map((id) => [
        `#${id}`,
        new FakeElement('section'),
      ]),
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
      verification: { status: 'unavailable', reason: 'not persisted' },
      notes: [],
    }

    const context = createContext({ document })
    ;(context as Record<string, unknown>).__snapshot = snapshot
    runInContext(JS.replace('load(false);', ''), context)
    runInContext(
      'renderRepository(document, __snapshot); renderContext(document, __snapshot); renderWork(document, __snapshot);',
      context,
    )

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
})
