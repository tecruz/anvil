import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'

/**
 * End-to-end tests that spawn the real CLI.
 *
 * These run the source entrypoint via node's native TS execution, so they exercise
 * argument handling, the exit-code funnel, and the JSON envelope exactly as a user or
 * the opencode plugin would see them -- without needing a build first.
 */

const CLI = join(import.meta.dirname, '..', 'src', 'main.ts')

interface RunResult {
  code: number
  stdout: string
  stderr: string
}

interface RunOptions {
  cwd?: string
  env?: NodeJS.ProcessEnv
  /**
   * Make the default cwd a real git repository (default). Set false for the one test
   * that needs to exercise behavior outside a repo.
   */
  inRepo?: boolean
}

function runAnvil(args: string[], opts: RunOptions = {}): RunResult {
  const scratch = mkdtempSync(join(tmpdir(), 'anvil-cli-'))
  const cwd = opts.cwd ?? scratch
  const configHome = opts.env?.ANVIL_CONFIG_HOME ?? join(scratch, 'config-home')
  try {
    if (opts.cwd === undefined && opts.inRepo !== false) {
      execFileSync('git', ['init', '--initial-branch=main'], { cwd, stdio: 'pipe' })
    }
    const res = execFileSync(process.execPath, [CLI, ...args], {
      cwd,
      encoding: 'utf8',
      stdio: 'pipe',
      env: {
        ...process.env,
        NO_COLOR: '1',
        // Point config at a scratch dir so a developer's real ~/.anvil cannot
        // influence the result.
        ANVIL_CONFIG_HOME: configHome,
      },
    })
    return { code: 0, stdout: res, stderr: '' }
  } catch (err) {
    const e = err as { status?: number; stdout?: string; stderr?: string }
    return { code: e.status ?? -1, stdout: e.stdout ?? '', stderr: e.stderr ?? '' }
  } finally {
    rmSync(scratch, { recursive: true, force: true })
  }
}

function jsonOf(result: RunResult): Record<string, unknown> {
  return JSON.parse(result.stdout) as Record<string, unknown>
}

describe('anvil (no args)', () => {
  test('prints help and exits 0', () => {
    const res = runAnvil([])
    assert.equal(res.code, 0)
    assert.match(res.stdout, /USAGE/)
    assert.match(res.stdout, /COMMANDS/)
  })

  test('lists the planned surface, tagged with its milestone', () => {
    const res = runAnvil([])
    assert.match(res.stdout, /PLANNED/)
    assert.match(res.stdout, /anvil doctor\s+Audit AI-readiness/)  // implemented, not planned
    assert.doesNotMatch(res.stdout, /anvil doctor.*M1/)               // M1 is done
    assert.match(res.stdout, /anvil plan/)                            // still planned
    assert.match(res.stdout, /M2a/)                                   // with its milestone
  })

  test('--json with no command emits an envelope, not a help page', () => {
    const res = runAnvil(['--json'])
    assert.equal(res.code, 0)
    const body = jsonOf(res)
    assert.equal(body.ok, true)
    assert.equal(body.schemaVersion, 1)
    assert.ok(Array.isArray((body.data as { commands: unknown[] }).commands))
  })
})

describe('unknown command', () => {
  test('exits 2 in text mode', () => {
    const res = runAnvil(['bogus'])
    assert.equal(res.code, 2)
    assert.match(res.stderr, /Unknown command: bogus/)
    assert.match(res.stderr, /code  UNKNOWN_COMMAND/)
  })

  test('exits 2 and emits a failure envelope in json mode', () => {
    const res = runAnvil(['bogus', '--json'])
    assert.equal(res.code, 2)
    const body = jsonOf(res)
    assert.equal(body.ok, false)
    const error = body.error as { code: string; message: string; hint?: string }
    assert.equal(error.code, 'UNKNOWN_COMMAND')
    assert.match(error.message, /Unknown command/)
    assert.match(error.hint ?? '', /anvil --help/)
  })
})

describe('anvil version', () => {
  test('prints a human line', () => {
    const res = runAnvil(['version'])
    assert.equal(res.code, 0)
    assert.match(res.stdout, /^anvil \S+ \(schema v1, node /)
  })

  test('json mode reports the schema version the plugin depends on', () => {
    const res = runAnvil(['version', '--json'])
    assert.equal(res.code, 0)
    const data = jsonOf(res).data as Record<string, unknown>
    assert.equal(data.schemaVersion, 1)
    assert.equal(typeof data.version, 'string')
    assert.equal(typeof data.node, 'string')
  })
})

describe('anvil config', () => {
  test('show defaults when nothing is configured', () => {
    const res = runAnvil(['config', 'show'])
    assert.equal(res.code, 0)
    assert.match(res.stdout, /provider\.default\s+local/)
    assert.match(res.stdout, /absent/)
  })

  test('show --json returns config plus sources', () => {
    const res = runAnvil(['config', 'show', '--json'])
    assert.equal(res.code, 0)
    const data = jsonOf(res).data as {
      config: Record<string, unknown>
      sources: Array<{ kind: string; present: boolean }>
    }
    assert.equal(data.config.schemaVersion, 1)
    assert.deepEqual(
      data.sources.map((s) => s.kind),
      ['global', 'repo', 'default'],
    )
  })

  test('path lists only real files, in both output modes', () => {
    const res = runAnvil(['config', 'path', '--json'])
    assert.equal(res.code, 0)
    const data = jsonOf(res).data as { paths: Array<{ kind: string; present: boolean }> }
    assert.deepEqual(
      data.paths.map((p) => p.kind),
      ['global', 'repo'],
      'the synthetic default layer is excluded',
    )

    const text = runAnvil(['config', 'path'])
    assert.equal(text.code, 0)
    assert.doesNotMatch(text.stdout, /built-in defaults/)
  })

  test('init outside a repo fails with a usage error and a hint', () => {
    const res = runAnvil(['config', 'init'], { inRepo: false })
    assert.equal(res.code, 2)
    assert.match(res.stderr, /needs a repository/)
  })

  test('show says why the repo layer was skipped outside a repo', () => {
    // Silently omitting the repo layer is confusing after a misplaced `config init`.
    const res = runAnvil(['config', 'show'], { inRepo: false })
    assert.equal(res.code, 0)
    assert.match(res.stdout, /not inside a git repository/)
  })

  test('rejects an unknown subcommand', () => {
    const res = runAnvil(['config', 'nope', '--json'])
    assert.equal(res.code, 2)
    const error = jsonOf(res).error as { code: string }
    assert.equal(error.code, 'USAGE')
  })

  test('rejects unknown flags', () => {
    const res = runAnvil(['config', 'show', '--colour'])
    assert.equal(res.code, 2)
    assert.match(res.stderr, /USAGE|colour/)
  })
})

describe('anvil config init inside a repo', () => {
  test('writes a starter file, then refuses to overwrite it', () => {
    const dir = mkdtempSync(join(tmpdir(), 'anvil-cli-repo-'))
    const home = mkdtempSync(join(tmpdir(), 'anvil-cli-home2-'))
    try {
      execFileSync('git', ['init', '--initial-branch=main'], { cwd: dir, stdio: 'pipe' })
      const env = { ANVIL_CONFIG_HOME: join(home, 'cfg') }

      const first = runAnvil(['config', 'init'], { cwd: dir, env })
      assert.equal(first.code, 0)
      assert.ok(existsSync(join(dir, 'anvil.config.json')), 'starter config should exist')

      const second = runAnvil(['config', 'init', '--json'], { cwd: dir, env })
      assert.equal(second.code, 3, 'refusing to overwrite is a config error')
      const error = jsonOf(second).error as { code: string; hint?: string }
      assert.equal(error.code, 'CONFIG_INVALID')
      assert.match(error.hint ?? '', /already exists|Edit it directly/)
    } finally {
      rmSync(dir, { recursive: true, force: true })
      rmSync(home, { recursive: true, force: true })
    }
  })

  test('a repo-local config overrides the global layer', () => {
    const dir = mkdtempSync(join(tmpdir(), 'anvil-cli-repo2-'))
    const home = mkdtempSync(join(tmpdir(), 'anvil-cli-home3-'))
    try {
      execFileSync('git', ['init', '--initial-branch=main'], { cwd: dir, stdio: 'pipe' })
      const configHome = join(home, 'cfg')
      runAnvil(['config', 'init'], { cwd: dir, env: { ANVIL_CONFIG_HOME: configHome } })
      writeFileSync(join(dir, 'anvil.config.json'), JSON.stringify({ provider: { default: 'github' } }))

      const res = runAnvil(['config', 'show', '--json'], { cwd: dir, env: { ANVIL_CONFIG_HOME: configHome } })
      const data = jsonOf(res).data as { config: { provider: { default: string } }; sources: Array<{ kind: string; present: boolean }> }
      assert.equal(data.config.provider.default, 'github')
      assert.equal(data.sources.find((s) => s.kind === 'repo')?.present, true)
    } finally {
      rmSync(dir, { recursive: true, force: true })
      rmSync(home, { recursive: true, force: true })
    }
  })
})

describe('anvil profile / doctor with --profile', () => {
  // Regression: `--profile <dir>` used to hoist to the enclosing git repo root, so
  // pointing it at a nested fixture silently audited the parent project instead.
  test('analyses the given directory, not the enclosing repo', () => {
    const fixtures = join(import.meta.dirname, '..', '..', '..', 'fixtures', 'node-workspace')
    const res = runAnvil(['profile', '--profile', fixtures, '--json', '--no-files'])
    assert.equal(res.code, 0)
    const data = jsonOf(res).data as {
      root: string
      modules: Array<{ id: string }>
      stacks: Array<{ id: string }>
    }
    assert.ok(
      data.root.toLowerCase().includes('node-workspace'),
      `expected the fixture root, got ${data.root}`,
    )
    assert.equal(data.modules.length, 3, 'the workspace fixture has three members')
    assert.ok(!data.stacks.some((s) => s.id === 'dotnet'), 'must not pick up sibling fixtures')
  })

  test('doctor --profile reports the fixture, not the parent', () => {
    const fixtures = join(import.meta.dirname, '..', '..', '..', 'fixtures', 'node-workspace')
    const fixtureScore = jsonOf(runAnvil(['doctor', '--profile', fixtures, '--json'])).data as { score: number }
    const repoScore = jsonOf(runAnvil(['doctor', '--json'])).data as { score: number }
    assert.notEqual(
      fixtureScore.score,
      repoScore.score,
      'scoring the fixture must differ from scoring the enclosing repository',
    )
  })
})

describe('per-command help', () => {
  test('--help shows usage and flags for a command', () => {
    const res = runAnvil(['config', '--help'])
    assert.equal(res.code, 0)
    assert.match(res.stdout, /USAGE/)
    assert.match(res.stdout, /anvil config <show\|path\|init>/)
    assert.match(res.stdout, /--json/)
  })
})
