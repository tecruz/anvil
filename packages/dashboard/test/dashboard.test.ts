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

function authedPost(
  server: DashboardServerHandle,
  path: string,
  body: unknown,
  contentType = 'application/json',
): Promise<Response> {
  return fetch(new URL(path, server.url), {
    method: 'POST',
    headers: { cookie: `${server.cookieName}=${TOKEN}`, 'content-type': contentType },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  })
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

  test('a brief needs an existing snapshot and never starts a CLI load', async () => {
    await withServer(async (server, _invoke, calls) => {
      // The page has not loaded yet: no POST may warm the cache by spawning commands.
      const cold = await authedPost(server, '/api/brief', { text: 'Update README.md' })
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
        assert.equal(response.status, 400)
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
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text: 'x' }),
      })
      assert.equal(anonymous.status, 401)
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

    listeners: Record<string, Array<() => void>> = {}

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
    }
    runInContext(JS.replace('load(false);', ''), context)
    runInContext(
      'renderTask(document, __snapshot); renderRepository(document, __snapshot); renderContext(document, __snapshot); renderWork(document, __snapshot); renderBrief(document.querySelector("#task-brief"), __brief);',
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
        'repository',
        'context',
        'work',
        'refresh',
        'scope',
        'stamp',
        'notes',
      ].map((id) => [`#${id}`, new FakeElement('section')]),
    ) // The draft a reader already typed; a failed refresh must not delete it.
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
    const nodes = new Map<string, FakeElement>(
      ['task', 'task-text', 'task-submit', 'task-error', 'task-suggestions', 'task-brief', 'refresh'].map((id) => [
        `#${id}`,
        new FakeElement('section'),
      ]),
    )
    const document = {
      createElement: (tag: string) => new FakeElement(tag),
      querySelector: (id: string) => nodes.get(id),
      querySelectorAll: () => [],
    }
    const context = createContext({ document })
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
    const failed = nodes.get('#task-brief')?.text() ?? ''
    assert.match(failed, /anvil ready failed, so blockers and tool availability are unknown/)
    assert.doesNotMatch(failed, /No blocked requirement is reported/)

    // Unprobed is not failed, and not a clean report either.
    ;(context as Record<string, unknown>).__unprobed = {
      ...((context as Record<string, unknown>).__failed as Record<string, unknown>),
      readiness: { ok: true, checked: false, status: 'unknown' },
    }
    runInContext('renderBrief(document.querySelector("#task-brief"), __unprobed)', context)
    const unprobed = nodes.get('#task-brief')?.text() ?? ''
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
    runInContext("state.mapSelection = 'edge:0'; renderTaskMap(__target, __brief)", context)
    const text = target.text()
    assert.match(text, /edge-evidence/)
    assert.match(text, /file:a → module:x/)
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
