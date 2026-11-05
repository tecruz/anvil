import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, describe, test } from 'node:test'

/**
 * End-to-end tests for `anvil ready`.
 *
 * These spawn the real CLI, because the report is assembled from four things a unit test
 * cannot see at once: repo discovery, the detected profile, the declared config layer, and
 * the environment probe. The unit tests in `@anvil/derive` cover the logic; these cover the
 * wiring and the exit code.
 */

const CLI = join(import.meta.dirname, '..', 'src', 'main.ts')
const temps: string[] = []
after(() => {
  for (const t of temps) rmSync(t, { recursive: true, force: true })
})

function repo(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'anvil-ready-'))
  temps.push(dir)
  execFileSync('git', ['init', '--initial-branch=main'], { cwd: dir, stdio: 'pipe' })
  for (const [name, content] of Object.entries(files)) writeFileSync(join(dir, name), content)
  return dir
}

interface RunResult {
  code: number
  stdout: string
  stderr: string
}

function runReady(cwd: string, args: string[], extraEnv: Record<string, string> = {}): RunResult {
  try {
    const stdout = execFileSync(process.execPath, [CLI, 'ready', ...args], {
      cwd,
      encoding: 'utf8',
      stdio: 'pipe',
      env: { ...process.env, NO_COLOR: '1', ANVIL_CONFIG_HOME: join(cwd, '.config-home'), ...extraEnv },
    })
    return { code: 0, stdout, stderr: '' }
  } catch (err) {
    const e = err as { status?: number; stdout?: string; stderr?: string }
    return { code: e.status ?? -1, stdout: e.stdout ?? '', stderr: e.stderr ?? '' }
  }
}

function dataOf(result: RunResult): Record<string, unknown> {
  const envelope = JSON.parse(result.stdout) as { ok: boolean; data: Record<string, unknown> }
  return envelope.data
}

describe('anvil ready', () => {
  test('a detected command is wired through, and an unchecked runner stays unknown', () => {
    const dir = repo({
      'AGENTS.md': '# Notes\n\nRun the tests before committing.\n',
      'package.json': JSON.stringify({ name: 'ready-fixture', scripts: { test: 'node -e "process.exit(0)"' } }),
    })
    const result = runReady(dir, ['--json'])
    assert.equal(result.code, 0, result.stderr)
    const data = dataOf(result)
    const commands = data.commands as Array<{ kind: string; source: string; status: string }>
    assert.ok(commands.some((c) => c.kind === 'test' && c.source === 'detected' && c.status === 'verified'))
    // No --check means no runner was verified, and the install command is inferred.
    assert.equal(data.status, 'unknown')
  })

  test('a declared tool is unknown without --check and blocked with it', () => {
    const dir = repo({
      'AGENTS.md': '# Notes\n\nNothing to run yet.\n',
      'anvil.config.json': JSON.stringify({
        schemaVersion: 1,
        project: { tools: [{ id: 'anvil-definitely-absent-tool', reason: 'the build', required: true }] },
      }),
    })

    const unchecked = runReady(dir, ['--json'])
    const before = dataOf(unchecked)
    assert.equal(before.status, 'unknown')
    assert.equal((before.tools as Array<{ status: string }>)[0]?.status, 'unknown')

    const checked = runReady(dir, ['--json', '--check'])
    assert.equal(checked.code, 0, checked.stderr)
    const after = dataOf(checked)
    assert.equal(after.status, 'blocked')
    assert.equal((after.tools as Array<{ status: string }>)[0]?.status, 'missing')
    const action = (after.actions as Array<{ id: string; command: string | null }>).find(
      (a) => a.id === 'provide:anvil-definitely-absent-tool',
    )
    assert.equal(action?.command, null, 'no install line is fabricated')
  })

  test('--fail-on-blocked exits 6 with the report on an ok:false envelope', () => {
    const dir = repo({
      'AGENTS.md': '# Notes\n\nNothing to run yet.\n',
      'anvil.config.json': JSON.stringify({
        project: { tools: [{ id: 'anvil-definitely-absent-tool' }] },
      }),
    })
    const result = runReady(dir, ['--json', '--check', '--fail-on-blocked'])
    assert.equal(result.code, 6, result.stderr)
    const envelope = JSON.parse(result.stdout) as { ok: boolean; data: { status: string } }
    assert.equal(envelope.ok, false)
    assert.equal(envelope.data.status, 'blocked')
  })

  test('a declared version range blocks when the installed tool is too old', () => {
    const dir = repo({
      'AGENTS.md': '# Notes\n\nNothing to run yet.\n',
      'anvil.config.json': JSON.stringify({
        project: { tools: [{ id: 'node', version: '>=999', reason: 'the runtime' }] },
      }),
    })
    const result = runReady(dir, ['--json', '--check'])
    assert.equal(result.code, 0, result.stderr)
    const data = dataOf(result)
    assert.equal(data.status, 'blocked')
    const tool = (data.tools as Array<{ status: string; versionRange: string; version: string }>)[0]
    assert.equal(tool?.status, 'incompatible')
    assert.equal(tool?.versionRange, '>=999')
    assert.match(tool?.version ?? '', /^\d+\.\d+\.\d+/)
    const action = (data.actions as Array<{ id: string; command: string | null }>).find((a) => a.id === 'upgrade:node')
    assert.equal(action?.command, null, 'no install line is fabricated')
  })

  test('a declared environment variable is checked by name, and its value never appears', () => {
    const dir = repo({
      'AGENTS.md': '# Notes\n\nNothing to run yet.\n',
      'anvil.config.json': JSON.stringify({
        project: { env: [{ name: 'ANVIL_TEST_SECRET', reason: 'the API' }] },
      }),
    })

    const missing = runReady(dir, ['--json', '--check'])
    assert.equal(missing.code, 0, missing.stderr)
    const missingData = dataOf(missing)
    assert.equal(missingData.status, 'blocked')
    const missingVar = (missingData.env as Array<{ name: string; status: string }>)[0]
    assert.equal(missingVar?.status, 'missing')
    const setAction = (missingData.actions as Array<{ id: string; command: string | null }>).find(
      (a) => a.id === 'set:ANVIL_TEST_SECRET',
    )
    assert.equal(setAction?.command, null, 'no export line is fabricated')

    const present = runReady(dir, ['--json', '--check'], { ANVIL_TEST_SECRET: 'do-not-print-me' })
    const presentData = dataOf(present)
    assert.equal((presentData.env as Array<{ status: string }>)[0]?.status, 'present')
    assert.ok(!present.stdout.includes('do-not-print-me'), 'the value must not be copied into the report')

    const gated = runReady(dir, ['--json', '--check', '--fail-on-blocked'])
    assert.equal(gated.code, 6, 'a missing required variable gates CI')

    const unchecked = runReady(dir, ['--json'])
    assert.equal((dataOf(unchecked).env as Array<{ status: string }>)[0]?.status, 'unknown')
  })

  test('a declared service is checked with a loopback connect, and a refused one blocks', async () => {
    const dir = repo({
      'AGENTS.md': '# Notes\n\nNothing to run yet.\n',
      'anvil.config.json': JSON.stringify({ project: { services: [] } }),
    })

    // A real listener: bound to an ephemeral loopback port, then declared in the config.
    const server = createServer()
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    const port = typeof address === 'object' && address !== null ? address.port : 0
    assert.ok(port > 0)
    try {
      const config = JSON.stringify({ project: { services: [{ id: 'app', port, reason: 'the app' }] } })
      writeFileSync(join(dir, 'anvil.config.json'), config)

      const up = runReady(dir, ['--json', '--check'])
      assert.equal(up.code, 0, up.stderr)
      const upData = dataOf(up)
      assert.equal((upData.services as Array<{ status: string }>)[0]?.status, 'reachable')
      assert.equal(upData.status, 'verified')
    } finally {
      await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())))
    }

    // The same port with nothing listening: refused, blocked, and no startup command guessed.
    const down = runReady(dir, ['--json', '--check'])
    const downData = dataOf(down)
    assert.equal((downData.services as Array<{ status: string }>)[0]?.status, 'unreachable')
    assert.equal(downData.status, 'blocked')
    const action = (downData.actions as Array<{ id: string; command: string | null }>).find((a) => a.id === 'start:app')
    assert.equal(action?.command, null, 'no startup line is fabricated')

    const unchecked = runReady(dir, ['--json'])
    assert.equal((dataOf(unchecked).services as Array<{ status: string }>)[0]?.status, 'unknown')
  })

  test('a declared reference is checked by path only, and a missing one blocks', () => {
    const dir = repo({
      'AGENTS.md': '# Notes\n\nNothing to run yet.\n',
      'anvil.config.json': JSON.stringify({
        project: { references: [{ id: 'adr', path: 'docs/adr/0001.md', scope: 'architecture' }] },
      }),
    })
    mkdirSync(join(dir, 'docs', 'adr'), { recursive: true })
    writeFileSync(join(dir, 'docs', 'adr', '0001.md'), 'SENTINEL-DOCUMENT-CONTENT')

    const present = runReady(dir, ['--json'])
    assert.equal(present.code, 0, present.stderr)
    const data = dataOf(present)
    const reference = (data.references as Array<{ path: string; scope: string; status: string }>)[0]
    assert.equal(reference?.status, 'present')
    assert.equal(reference?.scope, 'architecture')
    assert.equal(data.status, 'verified')
    assert.ok(!present.stdout.includes('SENTINEL-DOCUMENT-CONTENT'), 'the document is never read into the report')

    writeFileSync(
      join(dir, 'anvil.config.json'),
      JSON.stringify({ project: { references: [{ id: 'adr', path: 'docs/adr/missing.md' }] } }),
    )
    const missing = runReady(dir, ['--json', '--fail-on-blocked'])
    assert.equal(missing.code, 6, 'a missing required reference gates CI without --check')
    const missingData = dataOf(missing)
    assert.equal((missingData.references as Array<{ status: string }>)[0]?.status, 'missing')
    const action = (missingData.actions as Array<{ id: string; command: string | null }>).find(
      (a) => a.id === 'restore:adr',
    )
    assert.equal(action?.command, null, 'no restore command is fabricated')
  })

  test('a declared install command is proposed, never run', () => {
    const dir = repo({
      'AGENTS.md': '# Notes\n\nNothing to run yet.\n',
      'anvil.config.json': JSON.stringify({
        project: { tools: [{ id: 'anvil-definitely-absent-tool', install: 'echo install-it-yourself' }] },
      }),
    })
    const result = runReady(dir, ['--json', '--check'])
    const data = dataOf(result)
    const action = (data.actions as Array<{ id: string; command: string | null; requiresApproval: boolean }>).find(
      (a) => a.id === 'install:anvil-definitely-absent-tool',
    )
    assert.equal(action?.command, 'echo install-it-yourself')
    assert.equal(action?.requiresApproval, true)
  })
})
