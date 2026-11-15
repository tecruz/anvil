import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, relative, sep } from 'node:path'
import { after, describe, test } from 'node:test'
import {
  cachePathFor,
  type DiscoverSeeds,
  type DiscoveryEntry,
  type FetchImpl,
  type GhRun,
  loadCache,
  refreshLive,
  saveCache,
} from '@anvil/discovery'
import { loadPlaybooks } from '@anvil/playbooks'
import { liveEntriesForPlan } from '../src/commands/discover.ts'

/**
 * Discovery is a source of suggestions, never authority.
 *
 * These tests seed a discovery cache whose entry carries an install command that would write
 * a marker if anything executed it, then drive the real CLI (and, for the network path, the
 * real refresh code behind a fake transport). Around every command the repository, the
 * isolated home and the anvil config home are snapshotted: the only file allowed to change
 * is the discovery cache. No network, no real install and no approval store is used.
 */

const CLI = join(import.meta.dirname, '..', 'src', 'main.ts')
const roots: string[] = []
const MARKER_ENV = 'ANVIL_TEST_MARKER_PATH'

after(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
})

function scratch(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix))
  roots.push(root)
  return root
}

interface Fixture {
  repo: string
  home: string
  configHome: string
  approvalHome: string
  marker: string
  /** The one file a discovery command may write. */
  cachePath: string
  env: NodeJS.ProcessEnv
}

/**
 * An environment with no inherited Git or playbook configuration.
 *
 * A developer's global Git config (commit signing, hooks, templates) or `ANVIL_PLAYBOOKS`
 * pointing at extra playbooks must not decide whether this suite can even build its fixture,
 * or widen what the CLI matches and fetches.
 */
function isolatedEnv(home: string, gitConfig: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env }
  for (const name of Object.keys(env)) {
    if (name.startsWith('GIT_') || name.startsWith('ANVIL_')) delete env[name]
  }
  delete env.XDG_CONFIG_HOME
  return {
    ...env,
    HOME: home,
    USERPROFILE: home,
    GIT_CONFIG_GLOBAL: gitConfig,
    GIT_CONFIG_NOSYSTEM: '1',
    NO_COLOR: '1',
  }
}

function git(cwd: string, env: NodeJS.ProcessEnv, ...args: string[]): string {
  return execFileSync('git', ['-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=.no-hooks', ...args], {
    cwd,
    env,
    encoding: 'utf8',
    stdio: 'pipe',
  })
}

/** A committed Node/TypeScript repository whose `node` playbook matches. */
function fixture(project: Record<string, unknown> = {}): Fixture {
  const repo = scratch('anvil-discovery-authority-')
  const home = scratch('anvil-discovery-user-')
  const configHome = scratch('anvil-discovery-home-')
  const approvalParent = scratch('anvil-discovery-approvals-')
  const marker = join(scratch('anvil-discovery-marker-'), 'EXECUTED')
  const gitConfig = join(scratch('anvil-discovery-gitconfig-'), 'gitconfig')
  writeFileSync(gitConfig, '')
  const base = isolatedEnv(home, gitConfig)

  writeFileSync(
    join(repo, 'package.json'),
    JSON.stringify({
      name: 'discovery-authority-fixture',
      private: true,
      devDependencies: { typescript: '^5.9.0' },
    }),
  )
  writeFileSync(join(repo, 'src.ts'), 'export const answer = 42\n')
  writeFileSync(join(repo, 'anvil.config.json'), JSON.stringify({ project }))
  git(repo, base, 'init', '--initial-branch=main')
  git(repo, base, 'add', '.')
  git(repo, base, '-c', 'user.name=Anvil Test', '-c', 'user.email=anvil@example.invalid', 'commit', '-m', 'fixture')

  return {
    repo,
    home,
    configHome,
    approvalHome: join(approvalParent, 'store'),
    marker,
    cachePath: cachePathFor('node', { ANVIL_CONFIG_HOME: configHome }),
    env: {
      ...base,
      ANVIL_CONFIG_HOME: configHome,
      ANVIL_APPROVAL_HOME: join(approvalParent, 'store'),
      [MARKER_ENV]: marker,
    },
  }
}

interface RunResult {
  code: number
  stdout: string
  stderr: string
}

function runAnvil(cwd: string, args: string[], env: NodeJS.ProcessEnv): RunResult {
  try {
    return {
      code: 0,
      stdout: execFileSync(process.execPath, [CLI, ...args], {
        cwd,
        encoding: 'utf8',
        stdio: 'pipe',
        env,
      }),
      stderr: '',
    }
  } catch (cause) {
    const failure = cause as { status?: number; stdout?: string; stderr?: string }
    return { code: failure.status ?? -1, stdout: failure.stdout ?? '', stderr: failure.stderr ?? '' }
  }
}

function dataOf(result: RunResult): Record<string, unknown> {
  return (JSON.parse(result.stdout) as { data: Record<string, unknown> }).data
}

const dangerousInstall = `node -e "require('fs').writeFileSync(process.env.${MARKER_ENV},'executed')"`
const DISCOVERED_LABEL = 'node/synthetic-discovered-skill'

function dangerousEntry(source: DiscoveryEntry['source'] = 'github-search'): DiscoveryEntry {
  return {
    label: DISCOVERED_LABEL,
    url: 'https://example.invalid/anvil/discovered-skill',
    why: 'A synthetic discovery result whose install command must never run.',
    tier: 'community',
    section: 'community',
    source,
    fetchedAt: new Date().toISOString(),
    stars: 100,
    install: dangerousInstall,
    repo: DISCOVERED_LABEL,
    owner: 'node',
  }
}

/** A cache holding the dangerous entry. Complete and fresh by default, so the CLI reuses it. */
function seedCache(fx: Fixture, options: { source?: DiscoveryEntry['source']; remoteAnswered?: boolean } = {}): void {
  saveCache(
    {
      schemaVersion: 1,
      playbookId: 'node',
      fetchedAt: new Date().toISOString(),
      entries: [dangerousEntry(options.source)],
      remoteAnswered: options.remoteAnswered ?? true,
    },
    { ANVIL_CONFIG_HOME: fx.configHome },
  )
}

/** An installed skill so a local-only discovery run has something new to merge and write. */
function seedLocalSkill(fx: Fixture): void {
  const dir = join(fx.configHome, '.agents', 'skills', 'zz-anvil-test-node')
  mkdirSync(dir, { recursive: true })
  writeFileSync(
    join(dir, 'SKILL.md'),
    '---\nname: zz-anvil-test-node\ndescription: A fixture TypeScript skill for discovery tests.\n---\n\nBody.\n',
  )
}

// --- snapshots -----------------------------------------------------------------------------

type Tree = Map<string, string>

/** Every entry under `root`, keyed by its slash-separated relative path. */
function treeOf(root: string): Tree {
  const tree: Tree = new Map()
  if (!existsSync(root)) return tree
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir).sort()) {
      const path = join(dir, name)
      const key = relative(root, path).split(sep).join('/')
      const stat = lstatSync(path)
      if (stat.isSymbolicLink()) tree.set(key, `link:${readlinkSync(path)}`)
      else if (stat.isDirectory()) {
        tree.set(key, 'dir')
        walk(path)
      } else tree.set(key, `file:${createHash('sha256').update(readFileSync(path)).digest('hex')}`)
    }
  }
  walk(root)
  return tree
}

interface Snapshot {
  status: string
  trees: Record<string, Tree>
}

/** The roots a discovery command must leave alone, apart from its own cache file. */
function watchedRoots(fx: Fixture): Record<string, string> {
  return {
    repo: fx.repo,
    home: fx.home,
    configHome: fx.configHome,
    approvals: dirname(fx.approvalHome),
    marker: dirname(fx.marker),
  }
}

function snapshot(fx: Fixture): Snapshot {
  const trees: Record<string, Tree> = {}
  for (const [name, root] of Object.entries(watchedRoots(fx))) trees[name] = treeOf(root)
  return { status: git(fx.repo, fx.env, 'status', '--porcelain', '--ignored', '--untracked-files=all'), trees }
}

/**
 * Assert that only the discovery cache file (and directories leading to it) changed.
 *
 * `git status` must stay clean, nothing may appear in, vanish from or change in the
 * repository, the user home, the approval parent or the marker directory, and the config home
 * may differ only at the cache path.
 */
function assertOnlyCacheChanged(fx: Fixture, before: Snapshot, label: string): void {
  const after = snapshot(fx)
  assert.equal(after.status, '', `${label}: the repository must stay clean`)
  assert.equal(after.status, before.status, `${label}: git status changed`)
  const cacheKey = relative(fx.configHome, fx.cachePath).split(sep).join('/')
  const allowed = new Set<string>([cacheKey])
  for (let key = cacheKey; key.includes('/'); ) {
    key = key.slice(0, key.lastIndexOf('/'))
    allowed.add(key)
  }
  for (const name of Object.keys(before.trees)) {
    const was = before.trees[name]!
    const now = after.trees[name]!
    const changed: string[] = []
    for (const key of new Set([...was.keys(), ...now.keys()])) {
      if (was.get(key) === now.get(key)) continue
      if (name === 'configHome' && allowed.has(key) && now.has(key)) continue
      changed.push(`${key} (${was.get(key) ?? 'absent'} -> ${now.get(key) ?? 'absent'})`)
    }
    assert.deepEqual(changed, [], `${label}: ${name} changed outside the discovery cache`)
  }
  assertNothingExecutedOrApproved(fx)
}

function assertNothingExecutedOrApproved(fx: Fixture): void {
  assert.equal(existsSync(fx.marker), false, 'a discovered install command must not run')
  assert.equal(existsSync(fx.approvalHome), false, 'discovery must not create or grant approval')
}

/** Run one CLI command, asserting it succeeded and changed nothing but the cache. */
function runChecked(fx: Fixture, args: string[]): RunResult {
  const before = snapshot(fx)
  const result = runAnvil(fx.repo, args, fx.env)
  assert.equal(result.code, 0, `${args.join(' ')}\n${result.stdout}${result.stderr}`)
  assertOnlyCacheChanged(fx, before, args.join(' '))
  return result
}

/** The brief with every playbook's guidance removed: what is left must not carry discovery. */
function briefOutsideGuidance(data: Record<string, unknown>): string {
  const copy = JSON.parse(JSON.stringify(data)) as { playbooks?: Array<Record<string, unknown>> }
  for (const playbook of copy.playbooks ?? []) delete playbook.guidance
  return JSON.stringify(copy)
}

describe('discovery cannot install, execute or grant approval', () => {
  test('discover only writes its cache, and plan and brief only display the install text', () => {
    const fx = fixture()
    seedCache(fx)
    seedLocalSkill(fx)
    assertNothingExecutedOrApproved(fx)

    const discovered = runChecked(fx, ['playbook', 'discover', 'node', '--local-only', '--json'])
    const discoverData = dataOf(discovered)
    assert.equal(discoverData.cacheWritten, 1, 'the local scan merges into the cache')
    // The install string is cached as text; caching is not execution.
    const cached = loadCache('node', { ANVIL_CONFIG_HOME: fx.configHome })
    assert.ok(cached.cache?.entries.some((entry) => entry.install === dangerousInstall))

    const plan = runChecked(fx, ['plan', '--json'])
    const suggestions = dataOf(plan).suggestions as Array<{
      provenance: string
      install?: string
      external?: boolean
    }>
    const planned = suggestions.find((suggestion) => suggestion.install === dangerousInstall)
    assert.ok(planned !== undefined, 'the live entry is shown as a suggestion')
    assert.equal(planned.provenance, 'live')
    assert.equal(planned.external, true)

    const brief = runChecked(fx, ['brief', '--json'])
    const briefData = dataOf(brief)
    const playbooks = briefData.playbooks as Array<{
      verify: Record<string, string[]>
      guidance: Array<{ install?: string; provenance: string }>
    }>
    const guided = playbooks.flatMap((playbook) => playbook.guidance).find((g) => g.install === dangerousInstall)
    assert.ok(guided !== undefined, 'the brief carries the install text as guidance')
    assert.equal(guided.provenance, 'live')
    // Guidance only: not a repository command, not a verification step, nowhere else.
    const commands = briefData.commands as Array<{ cmd: string }>
    assert.equal(
      commands.some((command) => command.cmd.includes('writeFileSync')),
      false,
      'a discovered install is not a command',
    )
    const verification = playbooks.flatMap((playbook) => Object.values(playbook.verify).flat())
    assert.equal(
      verification.some((step) => step.includes('writeFileSync')),
      false,
      'a discovered install is not a verification step',
    )
    const outside = briefOutsideGuidance(briefData)
    assert.equal(outside.includes('writeFileSync'), false, 'the install text appears only in guidance')
    assert.equal(outside.includes(DISCOVERED_LABEL), false, 'the discovered entry appears only in guidance')
  })

  test('a live refresh through a fake transport fetches and caches, but runs and installs nothing', async () => {
    const fx = fixture()
    // A cache the remote half of which is incomplete, so the default plan enrichment fetches.
    // The dangerous entry is credited to the MCP registry, which the fake transport refuses,
    // so the per-source merge keeps it and it flows through the whole refresh path.
    seedCache(fx, { source: 'mcp-registry', remoteAnswered: false })
    seedLocalSkill(fx)
    const node = loadPlaybooks({}).playbooks.find((playbook) => playbook.id === 'node')
    assert.ok(node !== undefined)
    const playbooks: Array<{ id: string; discover: DiscoverSeeds }> = [{ id: node.id, discover: node.discover }]

    const requested: string[] = []
    const fetchImpl: FetchImpl = async (url) => {
      requested.push(url)
      if (url.startsWith('https://api.github.com/')) {
        return {
          status: 200,
          text: async () =>
            JSON.stringify({
              incomplete_results: false,
              items: [
                {
                  full_name: 'nodejs/agent-skills',
                  html_url: 'https://github.com/nodejs/agent-skills',
                  description: 'Official Node.js agent skills for typescript agent workflows.',
                  stargazers_count: 900,
                  owner: { login: 'nodejs', type: 'Organization' },
                },
              ],
            }),
        }
      }
      return { status: 503, text: async () => 'unavailable' }
    }
    const gh: GhRun = async () => ({ stdout: '', stderr: 'gh is not used in this test', exitCode: 1 })
    let refreshes = 0
    const fakeRefresh: typeof refreshLive = (pbs, options) => {
      refreshes += 1
      return refreshLive(pbs, { ...options, fetchImpl, gh })
    }

    // The process environment carries the marker path, as the CLI's would, so a regression
    // that executes the install command in-process is caught here too.
    const previousMarker = process.env[MARKER_ENV]
    process.env[MARKER_ENV] = fx.marker
    try {
      // Direct refresh, then both plan/brief enrichment modes: default (incomplete cache) and
      // an explicit --refresh.
      let before = snapshot(fx)
      const direct = await refreshLive(playbooks, { cwd: fx.repo, online: true, env: fx.env, fetchImpl, gh })
      assert.ok(direct.cached.length > 0, 'the refresh wrote the cache')
      assert.ok(direct.live.get('node')?.some((entry) => entry.install === dangerousInstall))
      assert.ok(direct.live.get('node')?.some((entry) => entry.label === 'nodejs/agent-skills'))
      assertOnlyCacheChanged(fx, before, 'refreshLive')

      seedCache(fx, { source: 'mcp-registry', remoteAnswered: false })
      for (const refresh of [false, true]) {
        before = snapshot(fx)
        const enriched = await liveEntriesForPlan(playbooks, {
          offline: false,
          refresh,
          cwd: fx.repo,
          env: fx.env,
          refreshLive: fakeRefresh,
        })
        const entries = enriched.live.get('node') ?? []
        assert.ok(
          entries.some((entry) => entry.install === dangerousInstall),
          `the discovered entry is still only text (refresh: ${String(refresh)})`,
        )
        assertOnlyCacheChanged(fx, before, `liveEntriesForPlan (refresh: ${String(refresh)})`)
      }
    } finally {
      if (previousMarker === undefined) delete process.env[MARKER_ENV]
      else process.env[MARKER_ENV] = previousMarker
    }
    assert.equal(refreshes, 2, 'both enrichment modes went through the refresh path')
    assert.ok(requested.length > 0, 'the remote sources were asked through the fake transport')
    assert.ok(
      requested.every((url) => url.startsWith('https://api.github.com/') || url.startsWith('https://registry.')),
      `only the discovery endpoints were asked:\n${requested.join('\n')}`,
    )
    assertNothingExecutedOrApproved(fx)
  })

  test('setup plan and validate use only owner declarations, never a discovered install', () => {
    const fx = fixture({
      tools: [
        {
          id: 'node',
          reason: 'The fixture needs Node.',
          required: true,
          install: 'echo owner-declared-tool-install',
        },
      ],
      commands: [{ kind: 'install', cmd: 'echo owner-declared-repository-install' }],
    })
    seedCache(fx)
    seedLocalSkill(fx)

    const planned = runChecked(fx, ['setup', 'plan', '--json'])
    const plan = dataOf(planned) as {
      executed: boolean
      approval: string
      executionSupported: boolean
      actions: Array<{
        source: string
        command: string
        requiresApproval: boolean
        verification: string
      }>
    }
    assert.deepEqual(
      plan.actions.map((action) => action.command),
      ['echo owner-declared-repository-install', 'echo owner-declared-tool-install'],
      'only the owner declarations become actions',
    )
    assert.equal(plan.executed, false)
    assert.equal(plan.approval, 'not-granted')
    assert.equal(plan.executionSupported, false)
    for (const action of plan.actions) {
      assert.equal(action.requiresApproval, true)
      assert.equal(action.verification, 'not-run')
      assert.match(action.source, /^project\./)
    }
    assert.doesNotMatch(planned.stdout, /synthetic-discovered-skill/, 'discovery is not an input to setup')
    assert.doesNotMatch(planned.stdout, /example\.invalid/)

    // Save the data object where the real command expects it, then validate it against the
    // same clean repository. Validation may say `current`; it still grants nothing.
    const planPath = join(scratch('anvil-discovery-plan-'), 'plan.json')
    writeFileSync(planPath, JSON.stringify(plan))
    const validated = runChecked(fx, ['setup', 'validate', '--plan', planPath, '--json'])
    const validation = dataOf(validated) as { status: string; approval: string; executed: boolean }
    assert.equal(validation.status, 'current')
    assert.equal(validation.approval, 'not-granted')
    assert.equal(validation.executed, false)

    // An owner-command proposal cannot be applied at all: only a reviewed local-skill plan
    // is an application input, so a discovered install has no route through apply either.
    const before = snapshot(fx)
    const applied = runAnvil(
      fx.repo,
      ['setup', 'apply', '--plan', planPath, '--grant', '11111111-2222-4333-8444-555555555555', '--json'],
      fx.env,
    )
    assert.notEqual(applied.code, 0)
    assert.match(`${applied.stdout}\n${applied.stderr}`, /Only a local-skill execution plan can be applied/)
    assertOnlyCacheChanged(fx, before, 'setup apply')
  })

  test('with no owner declarations, setup plan proposes nothing even when discovery has an install', () => {
    const fx = fixture()
    seedCache(fx)
    seedLocalSkill(fx)

    const planned = runChecked(fx, ['setup', 'plan', '--json'])
    const plan = dataOf(planned) as { actions: unknown[]; approval: string; executed: boolean }
    assert.deepEqual(plan.actions, [], 'discovery is not a fallback for missing declarations')
    assert.equal(plan.approval, 'not-granted')
    assert.equal(plan.executed, false)
    assert.doesNotMatch(planned.stdout, /synthetic-discovered-skill|writeFileSync/)

    const planPath = join(scratch('anvil-discovery-plan-'), 'plan.json')
    writeFileSync(planPath, JSON.stringify(plan))
    const validated = runChecked(fx, ['setup', 'validate', '--plan', planPath, '--json'])
    const validation = dataOf(validated) as { status: string; approval: string; executed: boolean }
    assert.equal(validation.approval, 'not-granted')
    assert.equal(validation.executed, false)
  })
})
