import assert from 'node:assert/strict'
import { execFileSync, spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, relative, resolve } from 'node:path'
import { describe, test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { actionArgv } from '@anvil/dashboard'
import {
  type EvidenceRecord,
  evidenceStore,
  readVerificationEvidence,
  selectVerificationRecords,
  verificationEvidencePath,
} from '../src/commands/crew.ts'
import { dashboardInvokers, stagedView } from '../src/commands/dashboard.ts'
import { DASHBOARD_ACTION_TIMEOUT_MS } from '../src/mcp.ts'

const TEST_DIR = dirname(fileURLToPath(import.meta.url))

/** A staged manifest whose staged file has disappeared must not look like a deletion. */
describe('the dashboard staging view', () => {
  test('a missing staged file stays an error instead of becoming an empty diff', () => {
    const root = mkdtempSync(join(tmpdir(), 'anvil-dashboard-'))
    try {
      const staging = join(root, '.anvil', 'staging')
      mkdirSync(join(staging, 'files'), { recursive: true })
      writeFileSync(
        join(staging, 'manifest.json'),
        JSON.stringify({
          schemaVersion: 1,
          inputHash: 'test-hash',
          createdAt: '2026-11-17T00:00:00.000Z',
          generator: 'test',
          files: [
            {
              path: 'AGENTS.md',
              stagedPath: 'files/AGENTS.md',
              sha256: 'abc123',
              bytes: 1,
              repoSha256: null,
            },
          ],
        }),
      )
      writeFileSync(join(root, 'AGENTS.md'), 'existing instructions\n')

      const view = stagedView(root)
      assert.equal(view.exists, true)
      const file = view.files[0]
      assert.equal(file?.path, 'AGENTS.md')
      assert.equal(file?.diff, '')
      assert.match(file?.error ?? '', /could not be read/)
      assert.equal(view.summary.files, 0)
      assert.equal(view.summary.removed, 0)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test('recorded verification is read only from the bounded CLI-owned file', () => {
    const root = mkdtempSync(join(tmpdir(), 'anvil-dashboard-verify-'))
    try {
      mkdirSync(join(root, '.git'), { recursive: true })
      const store = evidenceStore(root)
      assert.ok(store)
      assert.deepEqual(readVerificationEvidence(store), [])
      mkdirSync(join(root, '.anvil'), { recursive: true })
      const path = verificationEvidencePath(store)
      writeFileSync(path, 'not json')
      assert.deepEqual(readVerificationEvidence(store), [])
      const record = {
        command: 'npm test',
        revision: 'abcdef1234',
        exitCode: 0,
        timestamp: '2026-11-21T00:00:00.000Z',
      }
      writeFileSync(path, JSON.stringify([record]))
      assert.deepEqual(readVerificationEvidence(store), [record])
      writeFileSync(path, 'x'.repeat(70 * 1024))
      assert.deepEqual(readVerificationEvidence(store), [])
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test('a FIFO at the evidence path is rejected without blocking the reader', {
    skip: process.platform === 'win32',
  }, () => {
    const root = mkdtempSync(join(tmpdir(), 'anvil-evidence-fifo-'))
    try {
      mkdirSync(join(root, '.git'), { recursive: true })
      mkdirSync(join(root, '.anvil'), { recursive: true })
      const store = evidenceStore(root)
      assert.ok(store)
      execFileSync('mkfifo', [verificationEvidencePath(store)])
      assert.deepEqual(readVerificationEvidence(store), [])
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test('evidence retention keeps the newest result by completion time', () => {
    const at = (seconds: number, exitCode: number | null, command = 'npm test'): EvidenceRecord => ({
      command,
      revision: exitCode === null ? null : 'abcdef1234',
      exitCode,
      timestamp: `2026-11-21T00:00:${String(seconds).padStart(2, '0')}.000Z`,
    })
    const failures = Array.from({ length: 20 }, (_, index) => at(index, 0))
    const lastFailure = { ...at(30, 1), command: 'npm run lint' }
    const selected = selectVerificationRecords([lastFailure, ...failures])
    assert.ok(selected.some((record) => record.command === 'npm run lint' && record.exitCode === 1))
    assert.equal(selected.length, 20)
  })

  test('evidence retention keeps incomplete rows so they are distinguishable from no run', () => {
    const row: EvidenceRecord = {
      command: 'npm test',
      revision: null,
      exitCode: null,
      timestamp: '2026-11-21T00:00:00.000Z',
    }
    assert.deepEqual(selectVerificationRecords([row]), [row])
  })

  test('evidence retention does not let rejected rows evict a real failure', () => {
    const rejected = Array.from({ length: 25 }, (_, index) => ({
      command: '',
      revision: null,
      exitCode: null,
      timestamp: `2026-11-21T00:01:${String(index).padStart(2, '0')}.000Z`,
    }))
    const failure: EvidenceRecord = {
      command: 'npm test',
      revision: 'abcdef1234',
      exitCode: 1,
      timestamp: '2026-11-21T00:00:00.000Z',
    }
    const selected = selectVerificationRecords([...rejected, failure])
    assert.ok(selected.some((record) => record.exitCode === 1))
    assert.ok(selected.length <= 20)
  })

  test('evidence retention never exceeds 20 rows or lets rejected rows crowd out facts', () => {
    const stamp = '2026-11-21T00:00:00.000Z'
    const facts = Array.from({ length: 20 }, (_, index) => ({
      command: 'npm test',
      revision: 'a'.repeat(40),
      exitCode: index === 0 ? 1 : 0,
      timestamp: stamp,
    }))
    const rejected = {
      command: '',
      revision: null,
      exitCode: null,
      timestamp: stamp,
    }
    const selected = selectVerificationRecords([...facts, rejected])
    assert.equal(selected.length, 20)
    assert.deepEqual(
      selected.filter((record) => record.command === ''),
      [],
    )
    assert.ok(selected.some((record) => record.exitCode === 1))
  })

  test('evidence retention prefers an oversized rejected row over a real failure', () => {
    const failure = {
      command: 'npm test',
      revision: 'a'.repeat(40),
      exitCode: 1,
      timestamp: '2026-11-21T00:00:00.000Z',
    }
    const oversized = {
      command: 'x'.repeat(64 * 1024),
      revision: null,
      exitCode: null,
      timestamp: '2026-11-21T00:00:01.000Z',
    }
    const selected = selectVerificationRecords([failure, oversized])
    assert.deepEqual(selected, [failure])
  })

  test('the evidence store is resolved from Git metadata', () => {
    const mainRoot = mkdtempSync(join(tmpdir(), 'anvil-evidence-main-'))
    const linkedRoot = mkdtempSync(join(tmpdir(), 'anvil-evidence-linked-'))
    try {
      mkdirSync(join(mainRoot, '.git'), { recursive: true })
      const main = evidenceStore(mainRoot)
      assert.equal(main?.root, realpathSync.native(mainRoot))

      const gitDir = join(linkedRoot, 'admin', 'worktrees', 'claim')
      mkdirSync(gitDir, { recursive: true })
      writeFileSync(join(gitDir, 'commondir'), `${relative(gitDir, join(mainRoot, '.git'))}\n`, 'utf8')
      writeFileSync(join(linkedRoot, '.git'), `gitdir: ${relative(linkedRoot, gitDir)}\n`, 'utf8')
      const linked = evidenceStore(linkedRoot)
      assert.equal(linked?.root, realpathSync.native(mainRoot))
      assert.equal(linked?.key, main?.key)
    } finally {
      rmSync(mainRoot, { recursive: true, force: true })
      rmSync(linkedRoot, { recursive: true, force: true })
    }
  })
})

describe('the dashboard ship action through the real CLI', () => {
  test('a ship for a claim that does not exist is refused by the CLI, not by the page', () => {
    const root = mkdtempSync(join(tmpdir(), 'anvil-dashboard-ship-'))
    try {
      spawnSync('git', ['init', '--initial-branch=main'], { cwd: root, stdio: 'pipe' })
      const argv = actionArgv('ship', 'no-such-claim')
      assert.deepEqual(argv, ['ship', 'no-such-claim', '--probe', '--json'])
      const entry = join(import.meta.dirname, '..', 'src', 'main.ts')
      const result = spawnSync(process.execPath, [entry, ...argv], { cwd: root, encoding: 'utf8' })
      assert.notEqual(result.status, 0, result.stdout + result.stderr)
      const envelope = JSON.parse(result.stdout.trim()) as { ok: boolean; error?: { message?: string } }
      assert.equal(envelope.ok, false)
      assert.match(envelope.error?.message ?? '', /No claim|no-such-claim/i)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})

describe('the dashboard action runner', () => {
  test('the action timeout exceeds the CLI per-check verification limit', () => {
    // crew verify and ship's --probe allow 10 minutes per check (crew.ts, ship.ts). The
    // dashboard action runner must not cut a passing check off before the CLI would.
    assert.ok(DASHBOARD_ACTION_TIMEOUT_MS >= 10 * 60_000)
  })

  test('the action runner outlives a slow check that stops the short snapshot runner', async () => {
    const root = mkdtempSync(join(tmpdir(), 'anvil-dashboard-timeout-'))
    try {
      const slow = join(root, 'slow.mjs')
      writeFileSync(slow, 'setTimeout(() => {}, 400)\n')
      const runners = dashboardInvokers({ entry: slow, snapshotTimeoutMs: 100, actionTimeoutMs: 2000 })
      await assert.rejects(runners.invoke(['doctor'], root), /Failed to run/)
      const result = await runners.invokeAction(['crew', 'verify'], root)
      assert.equal(result.exitCode, 0)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})

interface StartedDashboard {
  child: ReturnType<typeof spawn>
  url: string
  stderr(): string
}

/** Start the real CLI server and read its one-time URL from the JSON envelope on stdout. */
function startDashboard(entry: string, cwd: string, env: NodeJS.ProcessEnv = process.env): Promise<StartedDashboard> {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(process.execPath, [entry, 'dashboard', '--repo', cwd, '--port', '0', '--json'], {
      cwd,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    })
    let stdout = ''
    let stderr = ''
    let settled = false
    const timer = setTimeout(() => {
      finish(new Error(`dashboard did not print a URL in 30s: ${stderr}\n${stdout}`))
      child.kill()
    }, 30_000)
    const finish = (error?: Error): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (error !== undefined) rejectPromise(error)
    }
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => {
      stdout += chunk
      const match = /http:\/\/127\.0\.0\.1:\d+\/\?token=[^\s"']+/.exec(stdout)
      if (match !== null && !settled) {
        settled = true
        clearTimeout(timer)
        resolvePromise({ child, url: match[0], stderr: () => stderr })
      }
    })
    child.stderr.on('data', (chunk: string) => {
      stderr += chunk
    })
    child.on('error', (error) => finish(error))
    child.on('exit', (code, signal) => {
      if (!settled) finish(new Error(`dashboard exited (${signal ?? code}): ${stderr}\n${stdout}`))
    })
  })
}

async function stopDashboard(started: StartedDashboard): Promise<void> {
  const child = started.child
  if (child.exitCode !== null || child.signalCode !== null) return
  await new Promise<void>((resolveDone) => {
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      resolveDone()
    }, 3000)
    child.once('exit', () => {
      clearTimeout(timer)
      resolveDone()
    })
    child.kill()
  })
}

describe('the dashboard through the real CLI', () => {
  test('the bundled CLI serves the Task brief page, a read-only brief and a reachable action route', {
    timeout: 120_000,
  }, async () => {
    // The bundle is the product users install. From a checkout without a build, fall back to
    // the source entry and say so, rather than silently testing something else.
    const bundle = resolve(TEST_DIR, '..', 'dist', 'cli.js')
    const entry = existsSync(bundle) ? bundle : resolve(TEST_DIR, '..', 'src', 'main.ts')
    if (!existsSync(bundle)) {
      process.stderr.write('note: packages/cli/dist/cli.js is absent; the dashboard regression used src/main.ts\n')
    }
    const root = mkdtempSync(join(tmpdir(), 'anvil-dashboard-bundled-'))
    try {
      spawnSync('git', ['init', '-q', '-b', 'main'], { cwd: root, stdio: 'pipe' })
      const started = await startDashboard(entry, root)
      try {
        const boot = await fetch(started.url, { redirect: 'manual' })
        assert.equal(boot.status, 302, await boot.text())
        const setCookie = boot.headers.get('set-cookie') ?? ''
        assert.match(setCookie, /HttpOnly/)
        assert.match(setCookie, /SameSite=Strict/)
        const cookie = setCookie.split(';')[0] ?? ''
        assert.notEqual(cookie, '')

        const page = await fetch(new URL('/', started.url), { headers: { cookie } })
        assert.equal(page.status, 200, await page.clone().text())
        const html = await page.text()
        assert.match(html, /class="tab active" data-view="task"[^>]*>Task brief</)
        assert.match(html, /id="task-text"/)
        assert.match(html, /id="task-submit"/)
        assert.match(html, /id="task-suggestions"/)
        assert.match(html, /id="task-brief"/)
        assert.match(html, /id="task-map"/)

        // Warm the cache exactly as the page does; a POST alone must not build a snapshot.
        const snapshot = await fetch(new URL('/api/snapshot', started.url), { headers: { cookie } })
        assert.equal(snapshot.status, 200, await snapshot.clone().text())
        const snapshotId = ((await snapshot.json()) as { snapshotId?: string }).snapshotId
        assert.equal(typeof snapshotId, 'string')

        const briefUrl = new URL('/api/brief', started.url)
        const briefResponse = await fetch(briefUrl, {
          method: 'POST',
          headers: { cookie, 'content-type': 'application/json', origin: briefUrl.origin },
          body: JSON.stringify({
            text: 'The audit and proposal are approved before implementation. Update README.md.',
            snapshotId,
          }),
        })
        assert.equal(briefResponse.status, 200, await briefResponse.clone().text())
        const brief = (await briefResponse.json()) as {
          title: string
          gates: Array<{ kind: string; startNow: string | null; waitFor: string | null; evidence: string }>
          map: { nodes: unknown[]; edges: unknown[] } | null
          howToCheck: unknown[]
        }
        assert.match(brief.title, /audit and proposal/)
        assert.equal(brief.gates.length, 1)
        assert.equal(brief.gates[0]?.kind, 'approval')
        assert.match(brief.gates[0]?.startNow ?? '', /audit and proposal/)
        assert.match(brief.gates[0]?.waitFor ?? '', /implementation/)
        assert.match(brief.gates[0]?.evidence ?? '', /approved before implementation/)
        assert.ok(brief.map, 'the brief must carry a 2D task map')
        assert.ok(Array.isArray(brief.map.nodes))
        assert.ok(Array.isArray(brief.map.edges))
        assert.ok(Array.isArray(brief.howToCheck))

        // The gated action route is still wired. A claim that does not exist is refused by the
        // CLI before any write, so this proves reachability without calling a live write action.
        const actionUrl = new URL('/api/action', started.url)
        const action = await fetch(actionUrl, {
          method: 'POST',
          headers: { cookie, 'content-type': 'application/json', origin: actionUrl.origin },
          body: JSON.stringify({ action: 'ship', ref: 'no-such-claim' }),
        })
        assert.equal(action.status, 200, await action.clone().text())
        const result = (await action.json()) as { ok: boolean; command: string; error: string | null }
        assert.equal(result.command, 'anvil ship no-such-claim --probe --json')
        assert.equal(result.ok, false)
        assert.match(result.error ?? '', /claim/i)
      } finally {
        await stopDashboard(started)
      }
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test('a startup revision probe that cannot find Git still leaves the dashboard listening', async () => {
    const bundle = resolve(TEST_DIR, '..', 'dist', 'cli.js')
    const entry = existsSync(bundle) ? bundle : resolve(TEST_DIR, '..', 'src', 'main.ts')
    const root = mkdtempSync(join(tmpdir(), 'anvil-dashboard-no-git-'))
    const emptyPath = mkdtempSync(join(tmpdir(), 'anvil-no-git-path-'))
    try {
      spawnSync('git', ['init', '-q', '-b', 'main'], { cwd: root, stdio: 'pipe' })
      // A PATH with no Git on it makes the startup rev-parse probe throw TOOL_MISSING. The
      // read-only dashboard must still listen and report the revision as explicitly unknown.
      const env: NodeJS.ProcessEnv = { ...process.env, PATH: emptyPath, Path: emptyPath }
      const started = await startDashboard(entry, root, env)
      try {
        const boot = await fetch(started.url, { redirect: 'manual' })
        assert.equal(boot.status, 302)
        const cookie = (boot.headers.get('set-cookie') ?? '').split(';')[0] ?? ''
        assert.notEqual(cookie, '')

        const snapshot = await fetch(new URL('/api/snapshot', started.url), { headers: { cookie } })
        assert.equal(snapshot.status, 200, await snapshot.clone().text())
        const data = (await snapshot.json()) as {
          verification: { status: string; currentRevision: string | null }
        }
        assert.equal(data.verification.status, 'unavailable')
        assert.equal(data.verification.currentRevision, null)
        assert.doesNotMatch(started.stderr(), /TOOL_MISSING/)
      } finally {
        await stopDashboard(started)
      }
    } finally {
      rmSync(root, { recursive: true, force: true })
      rmSync(emptyPath, { recursive: true, force: true })
    }
  })
})
