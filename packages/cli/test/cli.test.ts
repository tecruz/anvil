import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, describe, test } from 'node:test'
import { type DiscoveryEntry, loadCache, saveCache } from '@anvil/discovery'
import { playbookCommand } from '../src/commands/playbook.ts'
import { PLANNED_COMMANDS } from '../src/commands/types.ts'

/**
 * End-to-end tests that spawn the real CLI.
 *
 * These run the source entrypoint via node's native TS execution, so they exercise
 * argument handling, the exit-code funnel, and the JSON envelope exactly as a user or
 * the opencode plugin would see them -- without needing a build first.
 */

const CLI = join(import.meta.dirname, '..', 'src', 'main.ts')

/**
 * Scratch directories that outlive a single test.
 *
 * Registered rather than cleaned inline, because a test that fails between the `mkdtemp` and
 * its `rmSync` otherwise leaks, and a suite that leaves directories behind in the system temp
 * grows quietly until it is someone's problem. There were already 76 of them.
 */
const temps: string[] = []
after(() => {
  for (const t of temps) rmSync(t, { recursive: true, force: true })
})

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  temps.push(dir)
  return dir
}

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
      execFileSync('git', ['init', '--initial-branch=main'], {
        cwd,
        stdio: 'pipe',
      })
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
        // Everything else the caller asked for. Previously only ANVIL_CONFIG_HOME was
        // honoured, so a test that passed, say, ANVIL_PLAYBOOKS was silently running with the
        // developer's own value instead.
        ...opts.env,
      },
    })
    return { code: 0, stdout: res, stderr: '' }
  } catch (err) {
    const e = err as { status?: number; stdout?: string; stderr?: string }
    return {
      code: e.status ?? -1,
      stdout: e.stdout ?? '',
      stderr: e.stderr ?? '',
    }
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

  test('the planned surface is only what is genuinely unimplemented', () => {
    const res = runAnvil([])
    assert.match(res.stdout, /PLANNED/)
    assert.match(res.stdout, /anvil doctor\s+Audit AI-readiness/) // implemented, not planned
    assert.doesNotMatch(res.stdout, /anvil doctor.*M1/) // M1 is done

    // `anvil playbook` is listed under COMMANDS now that `check` exists, so it must not
    // also appear in PLANNED. An entry that graduated out of the roadmap list but stayed
    // in it would be help output that lies about what runs.
    assert.match(res.stdout, /anvil playbook\s+Inspect the playbook registry/)
  })

  test('no planned command is a shipped command', () => {
    // Asserted by comparing the constant against the COMMANDS section of the help, rather
    // than by slicing the text after the PLANNED heading. That slice is now a fixed "(none)",
    // so the old assertion passed for *any* value of PLANNED_COMMANDS -- it could not catch
    // the drift it was written for, and would keep passing if a shipped command were
    // re-added to the roadmap list.
    const res = runAnvil([])
    const commands = res.stdout.slice(res.stdout.indexOf('COMMANDS'), res.stdout.indexOf('PLANNED'))
    const shipped = new Set(
      commands
        .split('\n')
        .map((line) => {
          const tokens = line.trim().split(/\s+/)
          // Table rows are `anvil <name>  <summary>`, so the name is the second token.
          return tokens[0] === 'anvil' ? (tokens[1] ?? '') : ''
        })
        .filter((name) => name !== ''),
    )
    assert.ok(shipped.size > 0, 'the COMMANDS section should not be empty')
    for (const planned of PLANNED_COMMANDS) {
      const name = planned.usage.split(/\s+/)[1] ?? ''
      assert.ok(!shipped.has(name), `${planned.usage} is listed as planned but ships today`)
    }
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

describe('repo discovery is best-effort', () => {
  // The bug: `discoverRepo` threw above the try/funnel in `run`, so with git missing *every*
  // command escaped as an unhandled rejection -- a raw stack trace and exit 1, where the
  // contract says an envelope and the documented exit code. The fix is that main's discovery
  // is always best-effort: commands that need a repo re-discover inside their own `run`.
  test('no git binary, no envelope, but no stack trace either', () => {
    // PATH with node but no git. The command still answers `version`; the ones that need a
    // repository report their own precise error instead of a crash here.
    const nodeDir = execFileSync(process.execPath, ['-e', 'require("node:path").dirname(process.execPath)'], {
      encoding: 'utf8',
    }).trim()
    const res = runAnvil(['version', '--json'], { env: { PATH: nodeDir } })
    assert.equal(res.code, 0)
    const body = jsonOf(res)
    assert.equal(body.ok, true)
    assert.equal(typeof (body.data as { version: string }).version, 'string')
    assert.ok(!/node:internal|spawn git ENOENT/.test(res.stderr), res.stderr)
  })

  test('a repo-needing command outside a repo reports NotAGitRepo, not a crash', () => {
    const dir = tempDir('anvil-notrepo-')
    const res = runAnvil(['ship', 'local-1'], { cwd: dir, inRepo: false })
    assert.equal(res.code, 5, `documented exit code: ${res.stderr}`)
    assert.match(res.stderr, /NOT_A_GIT_REPO/)
    assert.ok(!/node:internal/.test(res.stderr), res.stderr)
  })
})

describe('unknown command', () => {
  test('exits 2 in text mode', () => {
    const res = runAnvil(['bogus'])
    assert.equal(res.code, 2)
    assert.match(res.stderr, /Unknown command: bogus/)
    assert.match(res.stderr, /code {2}UNKNOWN_COMMAND/)
  })

  test('exits 2 and emits a failure envelope in json mode', () => {
    const res = runAnvil(['bogus', '--json'])
    assert.equal(res.code, 2)
    const body = jsonOf(res)
    assert.equal(body.ok, false)
    const error = body.error as {
      code: string
      message: string
      hint?: string
    }
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

describe('anvil playbook', () => {
  test('list names the registry and every playbook in it', () => {
    const res = runAnvil(['playbook', 'list'])
    assert.equal(res.code, 0)
    assert.match(res.stdout, /Playbooks \d+/)
    // Every id the built-in registry carries. A count alone would pass if the table were
    // empty, which is the failure mode a smoke assertion always has.
    for (const id of ['android', 'node', 'terraform', 'ci']) {
      assert.match(res.stdout, new RegExp(`\\b${id}\\b`), `${id} missing from playbook list`)
    }
  })

  test('show takes the id positionally', () => {
    // The bug this pins: `show` accepted only `--id`, so the documented `show <id>` failed
    // with a usage error while the flag was never mentioned in the usage line.
    const res = runAnvil(['playbook', 'show', 'terraform'])
    assert.equal(res.code, 0)
    assert.match(res.stdout, /terraform, priority/)
    assert.match(res.stdout, /High-risk paths/)
  })

  test('show prints the discovery seeds, so what discover searches is inspectable', () => {
    // `show` claims to render one playbook "in full" but left out the half of the file that
    // governs `discover` -- and JSON printed it, so the text and JSON views disagreed about
    // the same playbook.
    const res = runAnvil(['playbook', 'show', 'terraform'])
    assert.equal(res.code, 0)
    assert.match(res.stdout, /Discovery seeds/)
    assert.match(res.stdout, /orgs {6}hashicorp/)
    assert.match(res.stdout, /keywords {2}terraform mcp server/)
    assert.match(res.stdout, /mcp {7}terraform, opentofu/)
  })

  test('show also accepts --id, and says so when the id is unknown', () => {
    assert.equal(runAnvil(['playbook', 'show', '--id', 'node']).code, 0)
    const missing = runAnvil(['playbook', 'show', 'nope'])
    assert.equal(missing.code, 2)
    assert.match(missing.stderr, /No playbook "nope"/)
  })

  test('check --offline needs no network and passes on the shipped registry', () => {
    // A rot check that fails on the registry it ships with is a check nobody runs, so this
    // is asserted against the real built-ins rather than a fixture.
    const res = runAnvil(['playbook', 'check', '--offline'])
    assert.equal(res.code, 0, res.stdout + res.stderr)
    assert.match(res.stdout, /playbook check clean/)
    assert.match(res.stdout, /not probed \(offline\)/)
  })

  test('the shipped registry has no errors, and --warnings reports the contested globs', () => {
    // The accurate invariant, and the one the plan states: **zero structural errors** on the
    // registry this project ships. Warnings are the check telling a human to confirm that the
    // higher-priority claimant of a contested risk glob really is the more specific playbook
    // -- android (85) over jvm (60) is a deliberate overlap, so `--warnings` is *meant* to
    // exit 6 here. Asserting it exits 0 would be asserting the check is disabled.
    const clean = runAnvil(['playbook', 'check', '--offline'])
    assert.equal(clean.code, 0, clean.stdout + clean.stderr)

    const strict = runAnvil(['playbook', 'check', '--offline', '--warnings'])
    assert.equal(strict.code, 6, strict.stdout + strict.stderr)
    // A failure prints its report on the failure stream, which is stderr.
    assert.match(strict.stdout + strict.stderr, /android wins/, 'a priority-resolved overlap should name the winner')
  })

  test('a contested glob with no priority winner is a note, not an arbitrary verdict', () => {
    // `**/Dockerfile*` is claimed by seven playbooks that mostly tie, so naming one
    // alphabetically is advice nobody can act on. It is reported as a tie instead.
    const res = runAnvil(['playbook', 'check', '--offline'])
    const text = res.stdout + res.stderr
    const at = text.indexOf('**/Dockerfile*')
    assert.ok(at > 0, 'the Dockerfile glob should be reported')
    // The fix text for that one problem is the three lines after the message.
    const fix = text.slice(at, at + 400)
    assert.match(fix, /tie at priority/)
    assert.ok(!/docker wins/.test(fix), fix)
  })

  test('check declares the --probe flag the help documents', () => {
    // The option was described in the command's own details and in the plan, and was not
    // declared in the flag table -- so the documented invocation was a usage error.
    //
    // Asserted on the command's flags directly rather than by spawning a probed run, because
    // a real `check --probe` queries every URL in the registry, and a test that needs the
    // network is a test that fails in a locked-down CI job. The probe behaviour itself is
    // covered by `check.test.ts`, which injects the fetch.
    assert.equal(playbookCommand.flags.probe?.type, 'boolean')
    assert.match(playbookCommand.details ?? '', /--probe/)
    assert.equal(playbookCommand.usage.includes('add'), true, 'the usage line should name the add subcommand')
  })

  test('a structural error fails the check, on the failure envelope, with exit 6', () => {
    // The exit code is the whole point of a gate: "a rot check that always exits 0 is a
    // report, not a check". Nothing asserted that wiring, so changing it to `return undefined`
    // would have left every test green and CI permanently green.
    const dir = tempDir('anvil-pb-bad-')
    writeFileSync(
      join(dir, 'acme.yaml'),
      [
        'id: acme',
        'title: ACME',
        'match:',
        "  files: ['a.txt']",
        'official:',
        '  docs:',
        "    - { label: 'x', url: 'http://169.254.169.254/latest', why: 'y' }",
        '',
      ].join('\n'),
    )
    const res = runAnvil(['playbook', 'check', '--offline', '--json'], { env: { ANVIL_PLAYBOOKS: dir } })
    assert.equal(res.code, 6, res.stdout + res.stderr)
    const body = jsonOf(res)
    assert.equal(body.ok, false)
    const error = body.error as { code: string }
    assert.equal(error.code, 'THRESHOLD_NOT_MET')
    const data = body.data as { problems: Array<{ message: string }> }
    assert.ok(
      data.problems.some((p) => /absolute https/.test(p.message)),
      JSON.stringify(data.problems),
    )
  })

  test('two files claiming one id fail the check, because the merge drops one', () => {
    const dir = tempDir('anvil-pb-dupe-')
    writeFileSync(join(dir, 'one.yaml'), 'id: acme\ntitle: One\nmatch:\n  files: ["a.txt"]\n')
    writeFileSync(join(dir, 'two.yaml'), 'id: acme\ntitle: Two\nmatch:\n  files: ["a.txt"]\n')
    const res = runAnvil(['playbook', 'check', '--offline'], { env: { ANVIL_PLAYBOOKS: dir } })
    assert.equal(res.code, 6, res.stdout + res.stderr)
    assert.match(res.stdout + res.stderr, /duplicate playbook id "acme"/)
  })

  test('check --offline --json reports ok on a failure envelope shape', () => {
    const res = runAnvil(['playbook', 'check', '--offline', '--json'])
    const body = jsonOf(res)
    assert.equal(body.ok, true)
    assert.equal(body.schemaVersion, 1)
    const data = body.data as { probed: boolean; playbooks: number; counts: { error: number } }
    assert.equal(data.probed, false)
    assert.ok(data.playbooks >= 15)
    assert.equal(data.counts.error, 0)
  })

  test('add installs a playbook into the home directory and it is active immediately', () => {
    const home = tempDir('anvil-pb-home-')
    const source = join(home, 'acme.yaml')
    writeFileSync(
      source,
      [
        'id: acme',
        'title: ACME internal platform',
        'priority: 65',
        'match:',
        "  files: ['**/acme.config.yaml']",
        'verify:',
        "  test: ['make verify']",
        '',
      ].join('\n'),
    )
    const installed = runAnvil(['playbook', 'add', source], { env: { ANVIL_CONFIG_HOME: home } })
    assert.equal(installed.code, 0, installed.stderr)
    assert.match(installed.stdout, /installed acme/)
    assert.ok(existsSync(join(home, '.anvil', 'playbooks', 'acme.yaml')), 'the file should exist')

    // And it is loaded with no environment variable pointing at it -- the whole point of
    // putting it in the home directory rather than the current repository.
    const listed = runAnvil(['playbook', 'list'], { env: { ANVIL_CONFIG_HOME: home } })
    assert.match(listed.stdout, /\bacme\b/)
    // ...without dropping the built-ins on the floor.
    assert.match(listed.stdout, /\bterraform\b/)
  })

  test('add refuses to replace an existing playbook unless forced', () => {
    const home = tempDir('anvil-pb-home-')
    const source = join(home, 'acme.yaml')
    writeFileSync(source, 'id: acme\ntitle: ACME\nmatch:\n  files: ["a.yaml"]\n')
    assert.equal(runAnvil(['playbook', 'add', source], { env: { ANVIL_CONFIG_HOME: home } }).code, 0)

    writeFileSync(source, 'id: acme\ntitle: ACME v2\nmatch:\n  files: ["a.yaml"]\n')
    const clash = runAnvil(['playbook', 'add', source], { env: { ANVIL_CONFIG_HOME: home } })
    assert.equal(clash.code, 2)
    assert.match(clash.stderr, /already installed/)

    const forced = runAnvil(['playbook', 'add', source, '--force'], { env: { ANVIL_CONFIG_HOME: home } })
    assert.equal(forced.code, 0)
    assert.match(forced.stdout, /replaced acme/)
  })

  test('add validates before it writes, so a broken playbook installs nothing', () => {
    // A playbook is executable configuration: its globs decide which files count as high
    // risk. Writing an unvalidated one is installing untested behaviour.
    const home = tempDir('anvil-pb-home-')
    const source = join(home, 'broken.yaml')
    writeFileSync(source, 'id: Broken\ntitle: no\nmatch:\n  files: []\n') // uppercase id, no match
    const res = runAnvil(['playbook', 'add', source], { env: { ANVIL_CONFIG_HOME: home } })
    assert.notEqual(res.code, 0)
    assert.ok(!existsSync(join(home, '.anvil', 'playbooks', 'broken.yaml')), 'nothing should be written')
  })

  test('add refuses an http url', () => {
    const res = runAnvil(['playbook', 'add', 'http://example.com/acme.yaml'])
    assert.equal(res.code, 2)
    assert.match(res.stderr, /Refusing to fetch a playbook over http/)
  })

  test('add refuses a playbook the structural check rejects, so install and check agree', () => {
    // `add` used to install playbooks that `check` immediately called errors -- a resource
    // URL over http, or a `file://` path. Worse than a mismatch: probing is on by default, so
    // the next `check` fires an outbound request at whatever host the playbook named. Here
    // that is a link-local metadata endpoint.
    const home = tempDir('anvil-pb-home-')
    const source = join(home, 'http-url.yaml')
    writeFileSync(
      source,
      [
        'id: acme',
        'title: ACME',
        'match:',
        "  files: ['a.txt']",
        'official:',
        '  docs:',
        "    - { label: 'meta', url: 'http://169.254.169.254/latest/meta-data', why: 'y' }",
        '',
      ].join('\n'),
    )
    const res = runAnvil(['playbook', 'add', source], { env: { ANVIL_CONFIG_HOME: home } })
    assert.equal(res.code, 2, res.stdout + res.stderr)
    assert.match(res.stderr, /absolute https/)
    assert.ok(!existsSync(join(home, '.anvil', 'playbooks', 'acme.yaml')), 'nothing should be written')
  })

  test('add refuses a directory with a usage error, not a crash', () => {
    // `existsSync` passes for a directory, and the raw EISDIR escaped as INTERNAL exit 70 --
    // "Bug in anvil. Report it" -- for what is a user typo.
    const dir = tempDir('anvil-pb-dir-')
    const home = tempDir('anvil-pb-home-')
    const res = runAnvil(['playbook', 'add', dir], { env: { ANVIL_CONFIG_HOME: home } })
    assert.equal(res.code, 2, res.stdout + res.stderr)
    assert.match(res.stderr, /Cannot read/)
    assert.ok(!/code {2}INTERNAL/.test(res.stderr), res.stderr)
  })

  test('add refuses an id owned by a higher layer, because the file would never be read', () => {
    // Precedence is built-ins -> user directory -> $ANVIL_PLAYBOOKS. Installing into the user
    // directory while ANVIL_PLAYBOOKS owns the id writes a file the loader skips, and the old
    // message claimed it was "active immediately" while suggesting --force, which could not
    // help.
    const company = tempDir('anvil-pb-company-')
    const home = tempDir('anvil-pb-home-')
    const source = join(home, 'acme.yaml')
    writeFileSync(source, 'id: acme\ntitle: Mine\nmatch:\n  files: ["a.txt"]\n')
    writeFileSync(join(company, 'acme.yaml'), 'id: acme\ntitle: Company\nmatch:\n  files: ["a.txt"]\n')
    mkdirSync(join(home, '.anvil', 'playbooks'), { recursive: true })

    const res = runAnvil(['playbook', 'add', source], {
      env: { ANVIL_CONFIG_HOME: home, ANVIL_PLAYBOOKS: company },
    })
    assert.equal(res.code, 2, res.stdout + res.stderr)
    assert.match(res.stderr, /takes precedence/)
    assert.ok(!existsSync(join(home, '.anvil', 'playbooks', 'acme.yaml')), 'nothing should be written')

    // Even forced: there is no configuration of --force that makes the loader read it.
    const forced = runAnvil(['playbook', 'add', source, '--force'], {
      env: { ANVIL_CONFIG_HOME: home, ANVIL_PLAYBOOKS: company },
    })
    assert.equal(forced.code, 2, forced.stdout + forced.stderr)
  })

  test('an unknown subcommand is a usage error naming the real ones', () => {
    const res = runAnvil(['playbook', 'frobnicate'])
    assert.equal(res.code, 2)
    assert.match(res.stderr, /list, show, check, add/)
  })
  test('--offline and --refresh contradict each other, and say so', () => {
    // Both flags ask for the opposite of the other: one says "no network at all", the other
    // says "fetch now". Guessing which one the user meant would be worse than refusing.
    const res = runAnvil(['plan', '--offline', '--refresh'])
    assert.equal(res.code, 2)
    assert.match(res.stderr, /contradict/)
  })
})

describe('playbook discover cache', () => {
  interface DiscoverData {
    playbooks: Array<{
      id: string
      entries: number
      kept: number
      sources: Array<{ source: string; detail: string; entries: number }>
      sample: Array<{ label: string; tier: string; section: string; source: string }>
    }>
    cacheWritten: number
    cacheSkipped: string[]
    warnings: string[]
  }

  function cachedEntry(label: string): DiscoveryEntry {
    return {
      label,
      url: `https://github.com/${label}`,
      why: 'Fetched by an earlier run.',
      tier: 'community',
      section: 'community',
      source: 'github-search',
      fetchedAt: new Date(Date.now() - 60_000).toISOString(),
      stars: 1000,
      install: null,
      repo: label,
      owner: label.slice(0, label.indexOf('/')),
    }
  }

  test('a fresh cache answers without fetching, and says so', () => {
    // Every rerun used to spend a rate limit to rediscover what was fetched an hour ago.
    // `--refresh` is the request for a new answer; the absence of it is the request for the
    // cached one.
    const home = tempDir('anvil-discover-home-')
    saveCache(
      {
        schemaVersion: 1,
        playbookId: 'android',
        fetchedAt: new Date(Date.now() - 60_000).toISOString(),
        entries: [cachedEntry('android/androidify')],
      },
      { ANVIL_CONFIG_HOME: home },
    )

    const res = runAnvil(['playbook', 'discover', 'android', '--json'], { env: { ANVIL_CONFIG_HOME: home } })
    assert.equal(res.code, 0, res.stdout + res.stderr)
    const data = jsonOf(res).data as DiscoverData
    const row = data.playbooks[0]
    assert.ok(row !== undefined)
    assert.equal(row.entries, 1)
    assert.equal(row.kept, 1)
    assert.equal(row.sources[0]?.source, 'cache')
    assert.match(row.sources[0]?.detail ?? '', /--refresh/)
    assert.equal(data.cacheWritten, 0, 'reusing a cache must not rewrite it')
    assert.deepEqual(data.warnings, [])
  })

  test('--local-only scans the configured home and merges rather than replaces the cache', () => {
    // Two defects pinned here. The scan used to read the developer's real home because the
    // CLI never passed `ANVIL_CONFIG_HOME` through to the package, so a test could pass while
    // a user's cache came from somewhere else. And the local-only run used to overwrite the
    // cache with local entries only, silently dropping everything the network had found.
    const home = tempDir('anvil-discover-home-')
    const fetchedAt = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString()
    saveCache(
      { schemaVersion: 1, playbookId: 'android', fetchedAt, entries: [cachedEntry('android/androidify')] },
      { ANVIL_CONFIG_HOME: home },
    )
    const skillDir = join(home, '.agents', 'skills', 'zz-anvil-test-android')
    mkdirSync(skillDir, { recursive: true })
    writeFileSync(
      join(skillDir, 'SKILL.md'),
      '---\nname: zz-anvil-test-android\ndescription: A fixture skill for Android discovery tests.\n---\n\nBody.\n',
    )

    const res = runAnvil(['playbook', 'discover', 'android', '--local-only', '--json'], {
      env: { ANVIL_CONFIG_HOME: home },
    })
    assert.equal(res.code, 0, res.stdout + res.stderr)
    const data = jsonOf(res).data as DiscoverData
    const row = data.playbooks[0]
    assert.ok(row !== undefined)
    assert.equal(row.entries, 1, 'this run found only the local skill')
    assert.equal(row.kept, 1, 'the fetched half should be preserved from the cache')
    assert.equal(row.sample[0]?.label, 'zz-anvil-test-android')
    assert.equal(row.sources.find((s) => s.source === 'local-scan')?.entries, 1)

    const after = loadCache('android', { ANVIL_CONFIG_HOME: home })
    assert.equal(after.status, 'fresh')
    assert.equal(after.cache?.entries.length, 2, 'both halves should be in the cache')
    assert.equal(after.cache?.fetchedAt, fetchedAt, 'the network half should keep its original age')
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
    const data = jsonOf(res).data as {
      paths: Array<{ kind: string; present: boolean }>
    }
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
      execFileSync('git', ['init', '--initial-branch=main'], {
        cwd: dir,
        stdio: 'pipe',
      })
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
      execFileSync('git', ['init', '--initial-branch=main'], {
        cwd: dir,
        stdio: 'pipe',
      })
      const configHome = join(home, 'cfg')
      runAnvil(['config', 'init'], {
        cwd: dir,
        env: { ANVIL_CONFIG_HOME: configHome },
      })
      writeFileSync(join(dir, 'anvil.config.json'), JSON.stringify({ provider: { default: 'github' } }))

      const res = runAnvil(['config', 'show', '--json'], {
        cwd: dir,
        env: { ANVIL_CONFIG_HOME: configHome },
      })
      const data = jsonOf(res).data as {
        config: { provider: { default: string } }
        sources: Array<{ kind: string; present: boolean }>
      }
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
    assert.ok(data.root.toLowerCase().includes('node-workspace'), `expected the fixture root, got ${data.root}`)
    assert.equal(data.modules.length, 3, 'the workspace fixture has three members')
    assert.ok(!data.stacks.some((s) => s.id === 'dotnet'), 'must not pick up sibling fixtures')
  })

  test('doctor --profile reports the fixture, not the parent', () => {
    const fixtures = join(import.meta.dirname, '..', '..', '..', 'fixtures', 'node-workspace')
    const fixtureScore = jsonOf(runAnvil(['doctor', '--profile', fixtures, '--json'])).data as { score: number }
    const repoScore = jsonOf(runAnvil(['doctor', '--json'])).data as {
      score: number
    }
    assert.notEqual(
      fixtureScore.score,
      repoScore.score,
      'scoring the fixture must differ from scoring the enclosing repository',
    )
  })
})

describe('a threshold failure is reported as a failure', () => {
  // `doctor --fail-on` emitted `ok: true` with the report as the payload, then returned exit
  // 6. A consumer branching on `ok` -- which is the documented contract, and what the
  // opencode plugin does -- read a failed audit as a successful one. The M6 review fixed this
  // in five other commands and missed this one, and nothing tested `--fail-on` at all.
  test('doctor --strict --json emits ok:false and exit 6', () => {
    const fixtures = join(import.meta.dirname, '..', '..', '..', 'fixtures', 'cold-empty')
    const res = runAnvil(['doctor', '--strict', '--json', '--profile', fixtures])
    assert.equal(res.code, 6, res.stdout + res.stderr)
    const body = jsonOf(res)
    assert.equal(body.ok, false)
    const error = body.error as { code: string; message: string }
    assert.equal(error.code, 'THRESHOLD_NOT_MET')
    // The report still travels, as the failure's payload, so nothing is lost.
    const data = body.data as { score: number; findings: unknown[] }
    assert.equal(typeof data.score, 'number')
    assert.ok(Array.isArray(data.findings) && data.findings.length > 0)
  })

  test('doctor --fail-on high in json mode is also a failure envelope', () => {
    const fixtures = join(import.meta.dirname, '..', '..', '..', 'fixtures', 'cold-empty')
    const res = runAnvil(['doctor', '--fail-on', 'high', '--json', '--profile', fixtures])
    assert.equal(res.code, 6, res.stdout + res.stderr)
    assert.equal(jsonOf(res).ok, false)
  })

  test('without the flag the same report is a success', () => {
    const fixtures = join(import.meta.dirname, '..', '..', '..', 'fixtures', 'cold-empty')
    const res = runAnvil(['doctor', '--json', '--profile', fixtures])
    assert.equal(res.code, 0, res.stdout + res.stderr)
    assert.equal(jsonOf(res).ok, true)
  })
})

describe('global flags work on every command', () => {
  // `--no-color` is documented as a global flag and consumed by `run` for every stream, but
  // each command declared its own `noColor` flag, which parseArgs exposes as `--noColor` --
  // so the documented spelling was rejected as an unknown option by every command. Help
  // advertised two spellings and neither was the usable one.
  test('--no-color is accepted and strips colour', () => {
    const res = runAnvil(['version', '--no-color'])
    assert.equal(res.code, 0, res.stdout + res.stderr)
    // eslint-disable-next-line no-control-regex
    assert.ok(!/\[/.test(res.stdout), `expected no ANSI escapes: ${JSON.stringify(res.stdout)}`)
  })

  test('--no-color is accepted by a command that takes its own flags', () => {
    const res = runAnvil([
      'doctor',
      '--no-color',
      '--profile',
      join(import.meta.dirname, '..', '..', '..', 'fixtures', 'cold-empty'),
    ])
    assert.equal(res.code, 0, res.stdout + res.stderr)
    assert.ok(!/Unknown option/.test(res.stderr), res.stderr)
  })

  test('help advertises --no-color once, as a global, and not as a per-command flag', () => {
    // It used to appear in two places: the root help's GLOBAL FLAGS (where it works) and every
    // command's flag table as `--noColor` (where it did not).
    const root = runAnvil([])
    assert.match(root.stdout, /--no-color/)
    assert.ok(!/--noColor\b/.test(root.stdout), 'the dead per-command spelling should be gone')

    const command = runAnvil(['doctor', '--help'])
    assert.ok(!/--noColor\b/.test(command.stdout), 'a command must not advertise a flag it ignores')
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
