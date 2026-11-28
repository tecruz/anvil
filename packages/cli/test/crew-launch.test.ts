/**
 * `anvil crew up --launch` and OpenCode v2.
 *
 * The launcher and the plugin are separate. A v2 runner can launch an agent without the
 * V1 `opencode-anvil` plugin, so the CLI warns once on stderr and still launches. The
 * version comes from the claim, which `claimTicket` already recorded -- these tests use a
 * stub `opencode` on PATH so no real agent, model or config is touched.
 */

import assert from 'node:assert/strict'
import { execFileSync, type SpawnSyncReturns, spawnSync } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { after, describe, test } from 'node:test'

/** The source entrypoint, so the tests run the same code a user does. */
const CLI_MAIN = join(import.meta.dirname, '..', 'src', 'main.ts')

const temps: string[] = []
after(() => {
  for (const dir of temps) rmSync(dir, { recursive: true, force: true })
})

function temp(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  temps.push(dir)
  return dir
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: 'pipe' })
}

function makeRepo(): string {
  const dir = temp('anvil-crew-launch-repo-')
  git(dir, 'init', '--initial-branch=main')
  git(dir, 'config', 'user.email', 't@e.com')
  git(dir, 'config', 'user.name', 'T')
  writeFileSync(join(dir, 'README.md'), '# repo\n', 'utf8')
  git(dir, 'add', '.')
  git(dir, 'commit', '-m', 'init')
  return dir
}

function writeLocalTicket(repo: string): void {
  const dir = join(repo, '.anvil', 'tickets')
  mkdirSync(dir, { recursive: true })
  writeFileSync(
    join(dir, '1.md'),
    ['---', 'title: "Launch an agent"', 'state: todo', '---', '', '# Launch an agent', '', 'Do the work.', ''].join(
      '\n',
    ),
    'utf8',
  )
}

/**
 * An `opencode` on PATH whose `--version` output is the only thing that varies.
 *
 * The `run` invocation is a no-op: the point is the launch decision and its warning, not
 * a model session. On Windows it is a `.cmd` shim, which is the shape the launcher already
 * handles.
 */
function stubOpencode(versionOutput: string): { dir: string; path: string } {
  const dir = temp('anvil-crew-launch-stub-')
  writeFileSync(
    join(dir, 'opencode.cjs'),
    [
      'const args = process.argv.slice(2)',
      "if (args.includes('--version')) {",
      `  process.stdout.write(${JSON.stringify(`${versionOutput}\n`)})`,
      '  process.exit(0)',
      '}',
      'process.exit(0)',
      '',
    ].join('\n'),
    'utf8',
  )
  if (process.platform === 'win32') {
    const shim = join(dir, 'opencode.cmd')
    writeFileSync(shim, '@echo off\r\nnode "%~dp0opencode.cjs" %*\r\n', 'utf8')
    return { dir, path: shim }
  }
  const stub = join(dir, 'opencode')
  writeFileSync(stub, '#!/bin/sh\nexec node "$(dirname "$0")/opencode.cjs" "$@"\n', 'utf8')
  chmodSync(stub, 0o755)
  return { dir, path: stub }
}

function configHomeFor(repo: string): string {
  const home = temp('anvil-crew-launch-config-')
  writeFileSync(
    join(home, 'anvil.config.json'),
    JSON.stringify({ schemaVersion: 1, git: { worktreeRoot: `${repo}-worktrees` } }),
    'utf8',
  )
  return home
}

function runCrew(repo: string, stubDir: string, configHome: string, args: string[]): SpawnSyncReturns<string> {
  return spawnSync(process.execPath, [CLI_MAIN, 'crew', 'up', '--tickets', 'local-1', ...args], {
    cwd: repo,
    encoding: 'utf8',
    stdio: 'pipe',
    timeout: 120_000,
    env: {
      ...process.env,
      NO_COLOR: '1',
      ANVIL_CONFIG_HOME: configHome,
      PATH: `${stubDir}${delimiter}${process.env.PATH ?? ''}`,
    },
  })
}

interface CrewEnvelope {
  ok: boolean
  data: {
    claims: Array<{ key: string; worktree: string }>
    launches: Array<{ key: string; launched: boolean; pid: number | null; detail: string }>
    failures: unknown[]
  }
}

describe('crew up --launch with OpenCode v2', () => {
  test('warns once on stderr for a recorded v2 runner, and still launches', () => {
    const repo = makeRepo()
    writeLocalTicket(repo)
    const stub = stubOpencode('2.3.0')
    const result = runCrew(repo, stub.dir, configHomeFor(repo), ['--launch', '--json'])

    assert.equal(result.status, 0, result.stderr)
    const envelope = JSON.parse(result.stdout) as CrewEnvelope
    assert.equal(envelope.ok, true)
    assert.deepEqual(envelope.data.failures, [])
    assert.equal(envelope.data.launches.length, 1)
    assert.equal(envelope.data.launches[0]?.launched, true, 'the warning must not block the launch')

    const warning = result.stderr as string
    assert.match(warning, /warning/)
    assert.match(warning, /opencode-anvil/)
    assert.match(warning, /v2\.3\.0/)
    assert.equal(warning.match(/opencode-anvil/g)?.length, 1, 'one warning, not one per claim')
  })

  test('does not warn for a recorded v1 runner', () => {
    const repo = makeRepo()
    writeLocalTicket(repo)
    const stub = stubOpencode('1.18.0')
    const result = runCrew(repo, stub.dir, configHomeFor(repo), ['--launch', '--json'])

    assert.equal(result.status, 0, result.stderr)
    const envelope = JSON.parse(result.stdout) as CrewEnvelope
    assert.equal(envelope.data.launches[0]?.launched, true)
    assert.doesNotMatch(result.stderr as string, /opencode-anvil/)
  })

  test('does not warn when the version is unknown', () => {
    const repo = makeRepo()
    writeLocalTicket(repo)
    const stub = stubOpencode('nightly build')
    const result = runCrew(repo, stub.dir, configHomeFor(repo), ['--launch', '--json'])

    assert.equal(result.status, 0, result.stderr)
    const envelope = JSON.parse(result.stdout) as CrewEnvelope
    assert.equal(envelope.data.launches[0]?.launched, true)
    assert.doesNotMatch(result.stderr as string, /opencode-anvil/)
  })

  test('does not warn for a custom runner path, even when it records v2', () => {
    const repo = makeRepo()
    writeLocalTicket(repo)
    const stub = stubOpencode('2.3.0')
    const result = runCrew(repo, stub.dir, configHomeFor(repo), ['--launch', '--runner', stub.path, '--json'])

    assert.equal(result.status, 0, result.stderr)
    const envelope = JSON.parse(result.stdout) as CrewEnvelope
    assert.equal(envelope.data.launches[0]?.launched, true)

    // The custom path is still probed (its basename is `opencode`), so this pins the guard
    // to the default runner rather than to any binary that happens to share the name.
    const registry = JSON.parse(readFileSync(join(repo, '.anvil', 'claims.json'), 'utf8')) as {
      claims: Array<{ agent?: { version?: string } }>
    }
    assert.equal(registry.claims[0]?.agent?.version, '2.3.0')
    assert.doesNotMatch(result.stderr as string, /opencode-anvil/)
  })

  test('does not warn without --launch', () => {
    const repo = makeRepo()
    writeLocalTicket(repo)
    const stub = stubOpencode('2.3.0')
    const result = runCrew(repo, stub.dir, configHomeFor(repo), ['--json'])

    assert.equal(result.status, 0, result.stderr)
    const envelope = JSON.parse(result.stdout) as CrewEnvelope
    assert.deepEqual(envelope.data.launches, [])
    assert.doesNotMatch(result.stderr as string, /opencode-anvil/)
  })

  test('keeps JSON stdout free of the warning text', () => {
    const repo = makeRepo()
    writeLocalTicket(repo)
    const stub = stubOpencode('2.3.0')
    const result = runCrew(repo, stub.dir, configHomeFor(repo), ['--launch', '--json'])

    assert.equal(result.status, 0, result.stderr)
    assert.doesNotMatch(result.stdout as string, /opencode-anvil/)
    // The stdout is still exactly one parseable envelope.
    assert.equal((JSON.parse(result.stdout) as CrewEnvelope).ok, true)
  })
})
