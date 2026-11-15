import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, describe, test } from 'node:test'
import { type DiscoveryEntry, saveCache } from '@anvil/discovery'

/**
 * Discovery is a source of suggestions, never authority.
 *
 * These tests seed a fresh discovery cache whose entry carries an install command that would
 * write a marker if anything executed it, then drive the real CLI. `playbook discover` may
 * only write its cache, `plan` and `brief` may only display the entry, and `setup plan`/
 * `validate` must ignore it. No network, no real install and no approval store is used.
 */

const CLI = join(import.meta.dirname, '..', 'src', 'main.ts')
const roots: string[] = []
const MARKER_ENV = 'ANVIL_TEST_MARKER_PATH'

after(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true })
})

function scratch(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix))
  roots.push(root)
  return root
}

function git(cwd: string, ...args: string[]): void {
  execFileSync('git', args, { cwd, stdio: 'pipe' })
}

interface Fixture {
  repo: string
  configHome: string
  approvalHome: string
  marker: string
  env: NodeJS.ProcessEnv
}

/** A committed Node/TypeScript repository whose `node` playbook matches. */
function fixture(project: Record<string, unknown> = {}): Fixture {
  const repo = scratch('anvil-discovery-authority-')
  const configHome = scratch('anvil-discovery-home-')
  const approvalHome = scratch('anvil-discovery-approvals-')
  const marker = join(scratch('anvil-discovery-marker-'), 'EXECUTED')
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
  git(repo, 'init', '--initial-branch=main')
  git(repo, 'add', '.')
  git(
    repo,
    '-c',
    'user.name=Anvil Test',
    '-c',
    'user.email=anvil@example.invalid',
    '-c',
    'core.hooksPath=.no-hooks',
    'commit',
    '-m',
    'fixture',
  )
  return {
    repo,
    configHome,
    approvalHome: join(approvalHome, 'store'),
    marker,
    env: {
      ...process.env,
      NO_COLOR: '1',
      ANVIL_CONFIG_HOME: configHome,
      ANVIL_APPROVAL_HOME: join(approvalHome, 'store'),
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

function dangerousEntry(): DiscoveryEntry {
  return {
    label: 'node/synthetic-discovered-skill',
    url: 'https://example.invalid/anvil/discovered-skill',
    why: 'A synthetic discovery result whose install command must never run.',
    tier: 'community',
    section: 'community',
    source: 'github-search',
    fetchedAt: new Date().toISOString(),
    stars: 100,
    install: dangerousInstall,
    repo: 'node/synthetic-discovered-skill',
    owner: 'node',
  }
}

/** A fresh cache, so `plan` and `brief` reuse it instead of fetching. */
function seedCache(fx: Fixture): void {
  saveCache(
    {
      schemaVersion: 1,
      playbookId: 'node',
      fetchedAt: new Date().toISOString(),
      entries: [dangerousEntry()],
      remoteAnswered: true,
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

function assertNothingExecutedOrApproved(fx: Fixture): void {
  assert.equal(existsSync(fx.marker), false, 'a discovered install command must not run')
  assert.equal(existsSync(fx.approvalHome), false, 'discovery must not create or grant approval')
  assert.equal(existsSync(join(fx.repo, '.agents')), false, 'discovery must not install into the repository')
}

describe('discovery cannot install, execute or grant approval', () => {
  test('discover only writes its cache, and plan and brief only display the install text', () => {
    const fx = fixture()
    seedCache(fx)
    seedLocalSkill(fx)
    assertNothingExecutedOrApproved(fx)

    const discovered = runAnvil(fx.repo, ['playbook', 'discover', 'node', '--local-only', '--json'], fx.env)
    assert.equal(discovered.code, 0, discovered.stdout + discovered.stderr)
    const discoverData = dataOf(discovered)
    assert.equal(discoverData.cacheWritten, 1, 'the local scan merges into the cache')
    // The install string is cached as text; caching is not execution.
    assertNothingExecutedOrApproved(fx)

    const plan = runAnvil(fx.repo, ['plan', '--json'], fx.env)
    assert.equal(plan.code, 0, plan.stdout + plan.stderr)
    const suggestions = dataOf(plan).suggestions as Array<{
      provenance: string
      install?: string
      external?: boolean
    }>
    const planned = suggestions.find((suggestion) => suggestion.install === dangerousInstall)
    assert.ok(planned !== undefined, 'the live entry is shown as a suggestion')
    assert.equal(planned.provenance, 'live')
    assert.equal(planned.external, true)
    assertNothingExecutedOrApproved(fx)

    const brief = runAnvil(fx.repo, ['brief', '--json'], fx.env)
    assert.equal(brief.code, 0, brief.stdout + brief.stderr)
    const playbooks = dataOf(brief).playbooks as Array<{
      guidance: Array<{ install?: string; provenance: string }>
    }>
    const guided = playbooks.flatMap((playbook) => playbook.guidance).find((g) => g.install === dangerousInstall)
    assert.ok(guided !== undefined, 'the brief carries the install text as guidance')
    assert.equal(guided.provenance, 'live')
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

    const planned = runAnvil(fx.repo, ['setup', 'plan', '--json'], fx.env)
    assert.equal(planned.code, 0, planned.stdout + planned.stderr)
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
    assertNothingExecutedOrApproved(fx)

    // Save the data object where the real command expects it, then validate it against the
    // same clean repository. Validation may say `current`; it still grants nothing.
    const planPath = join(scratch('anvil-discovery-plan-'), 'plan.json')
    writeFileSync(planPath, JSON.stringify(plan))
    const validated = runAnvil(fx.repo, ['setup', 'validate', '--plan', planPath, '--json'], fx.env)
    assert.equal(validated.code, 0, validated.stdout + validated.stderr)
    const validation = dataOf(validated) as { status: string; approval: string; executed: boolean }
    assert.equal(validation.status, 'current')
    assert.equal(validation.approval, 'not-granted')
    assert.equal(validation.executed, false)
    assertNothingExecutedOrApproved(fx)

    // An owner-command proposal cannot be applied at all: only a reviewed local-skill plan
    // is an application input, so a discovered install has no route through apply either.
    const applied = runAnvil(
      fx.repo,
      ['setup', 'apply', '--plan', planPath, '--grant', '11111111-2222-4333-8444-555555555555', '--json'],
      fx.env,
    )
    assert.notEqual(applied.code, 0)
    assert.match(`${applied.stdout}\n${applied.stderr}`, /Only a local-skill execution plan can be applied/)
    assertNothingExecutedOrApproved(fx)
  })
})
