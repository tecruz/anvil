/**
 * Golden-snapshot tests over the fixture repos.
 *
 * Every fixture is a deliberately small repository that exercises one detection path.
 * The snapshots are the regression net: when a detector changes, the diff in a snapshot
 * is the reviewable record of what it now believes, rather than a silent behaviour shift.
 *
 * Fixtures live in `fixtures/<name>` as real files on disk, not as in-memory stubs, so the
 * walk, the manifest readers and the git-derived fields are all exercised for real.
 */

import { test, describe, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync, readFileSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildProfile, type ProjectProfile } from '@anvil/profile'
import { audit, type ReadinessReport } from '@anvil/audit'

const here = dirname(fileURLToPath(import.meta.url))
const FIXTURES_DIR = resolve(here, '..', '..', '..', 'fixtures')

/** Build a throwaway copy of a fixture, so tests can rely on a real directory tree. */
function materialize(fixture: string): string {
  const dir = mkdtempSync(join(tmpdir(), `anvil-fix-${fixture}-`))
  const src = join(FIXTURES_DIR, fixture)
  copyTree(src, dir)
  return dir
}

function copyTree(src: string, dest: string): void {
  mkdirSync(dest, { recursive: true })
  for (const entry of readdirSync(src, { withFileTypes: true })) {
    const from = join(src, entry.name)
    const to = join(dest, entry.name)
    if (entry.isDirectory()) copyTree(from, to)
    else writeFileSync(to, readFileSync(from))
  }
}

const VCS = { root: '', host: 'github' as const, remote: 'git@github.com:acme/fixture.git', defaultBranch: 'main' }

/**
 * Materialize a fixture, run `fn` against it, then clean up.
 *
 * The cleanup has to happen *after* `fn` returns: `audit` reads the CI workflow bodies
 * and the instruction files off disk, so a profile audited after its directory was
 * removed would silently degrade every file-content rule to `na`.
 */
function withProfile<T>(fixture: string, fn: (profile: ProjectProfile) => T): T {
  const dir = materialize(fixture)
  try {
    return fn(buildProfile(dir, { ...VCS, root: dir }).profile)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

/** A ProjectProfile is self-contained, so it is safe to return after cleanup. */
function profileOf(fixture: string): ProjectProfile {
  return withProfile(fixture, (profile) => profile)
}

function reportOf(fixture: string): ReadinessReport {
  return withProfile(fixture, (profile) => audit(profile))
}

/** The parts of a profile worth snapshotting: volatile paths stripped. */
function snapshot(profile: ProjectProfile): unknown {
  return {
    languages: profile.languages,
    stacks: profile.stacks.map((s) => ({ id: s.id, version: s.version, evidence: s.evidence })),
    monorepo: profile.monorepo,
    modules: profile.modules,
    commands: profile.commands,
    tooling: profile.tooling,
    docs: profile.docs,
    risk: profile.risk,
    instructions: profile.instructions.map((i) => ({ path: i.path, category: i.category })),
  }
}

function findingIds(report: ReadinessReport, status?: string): string[] {
  return report.findings
    .filter((f) => status === undefined || f.status === status)
    .map((f) => f.id)
    .sort()
}

function findFinding(report: ReadinessReport, id: string) {
  const found = report.findings.find((f) => f.id === id)
  assert.ok(found !== undefined, `expected a finding for ${id}`)
  return found
}

before(() => {
  assert.ok(existsSync(FIXTURES_DIR), `fixtures directory missing: ${FIXTURES_DIR}`)
})

after(() => {
  // temp dirs are removed per-test; nothing to clean globally
})

describe('fixtures are present', () => {
  const REQUIRED = [
    'node-npm',
    'node-workspace',
    'python-django',
    'go-module',
    'rust-crate',
    'jvm-gradle',
    'dotnet-sln',
    'cold-empty',
    'documented-commands',
    'multi-lockfile',
  ]

  for (const name of REQUIRED) {
    test(`fixture ${name} exists`, () => {
      assert.ok(existsSync(join(FIXTURES_DIR, name)), `missing fixture: ${name}`)
    })
  }
})

describe('node-npm', () => {
  const p = profileOf('node-npm')

  test('detects the stack with evidence', () => {
    const node = p.stacks.find((s) => s.id === 'node')
    assert.ok(node)
    assert.match(node.evidence[0] ?? '', /^package\.json:\d+$/)
  })

  test('labels commands as detected, not documented', () => {
    const test = p.commands.test?.[0]
    assert.ok(test)
    assert.equal(test.source, 'detected')
    assert.match(test.evidence ?? '', /^package\.json:\d+$/)
  })

  test('classifies test:fast as testFast, not test', () => {
    assert.equal(p.commands.testFast?.[0]?.cmd, 'npm run test:fast')
  })

  test('does not treat a watch script as a fast subset', () => {
    // A watch process never exits, so it cannot be what `crew verify` runs.
    const fast = p.commands.testFast ?? []
    assert.ok(!fast.some((c) => c.cmd.includes('watch')))
  })

  test('detects tooling from dependencies', () => {
    assert.ok(p.tooling.lint.includes('eslint'))
    assert.ok(p.tooling.formatter.includes('prettier'))
  })

  test('single package yields one module at the repo root', () => {
    assert.equal(p.modules.length, 1)
    assert.equal(p.modules[0]?.path, '.')
  })

  test('snapshot is stable', () => {
    assert.deepEqual(snapshot(profileOf('node-npm')), snapshot(p))
  })
})

describe('node-workspace', () => {
  const p = profileOf('node-workspace')

  test('detects npm workspaces', () => {
    assert.equal(p.monorepo?.tool, 'npm')
  })

  test('resolves internal dependency edges by package name', () => {
    // The point of the two-pass walk: an edge to a member declared *later* in the list
    // must still be found.
    const web = p.modules.find((m) => m.id === '@acme/web')
    assert.ok(web)
    assert.deepEqual(web.deps.sort(), ['@acme/core', '@acme/ui'])
  })

  test('does not treat external dependencies as internal edges', () => {
    const core = p.modules.find((m) => m.id === '@acme/core')
    assert.deepEqual(core?.deps, [])
  })

  test('resolves every workspace member', () => {
    assert.equal(p.monorepo?.members.length, 3)
  })
})

describe('python-django', () => {
  const p = profileOf('python-django')

  test('detects python and django', () => {
    assert.ok(p.stacks.some((s) => s.id === 'python'))
    assert.ok(p.stacks.some((s) => s.id === 'django'))
  })

  test('reads pytest config as a test command with evidence', () => {
    const test = p.commands.test?.[0]
    assert.equal(test?.cmd, 'pytest')
    assert.equal(test?.source, 'detected')
  })

  test('flags migrations as high risk', () => {
    const risk = p.risk.filter((r) => r.level === 'high')
    assert.ok(risk.some((r) => r.glob.includes('migrations')))
  })
})

describe('go-module', () => {
  const p = profileOf('go-module')

  test('detects go with the language version from the go directive', () => {
    const go = p.stacks.find((s) => s.id === 'go')
    assert.equal(go?.version, '1.22')
  })

  test('detects a changed-files subset only when testing.Short() is used', () => {
    assert.equal(p.commands.testFast?.[0]?.cmd, 'go test -short ./...')
  })
})

describe('rust-crate', () => {
  const p = profileOf('rust-crate')

  test('marks conventional cargo commands as inferred, not detected', () => {
    // Nothing in the repo defines them; claiming `detected` would be a lie an agent
    // would act on.
    assert.equal(p.commands.test?.[0]?.source, 'inferred')
    assert.equal(p.commands.build?.[0]?.source, 'inferred')
  })

  test('prefers nextest when the project declares it', () => {
    assert.equal(p.commands.testFast?.[0]?.cmd, 'cargo nextest run')
    assert.equal(p.commands.testFast?.[0]?.source, 'detected')
  })
})

describe('jvm-gradle', () => {
  const p = profileOf('jvm-gradle')

  test('uses ./gradlew only when the wrapper is committed', () => {
    assert.match(p.commands.test?.[0]?.cmd ?? '', /^\.\/gradlew test/)
    assert.equal(p.commands.test?.[0]?.source, 'detected')
  })

  test('enumerates subprojects from settings.gradle include()', () => {
    const ids = p.modules.map((m) => m.id)
    assert.ok(ids.includes(':app'), `expected :app in ${ids.join(', ')}`)
    assert.ok(ids.includes(':core'))
  })
})

describe('dotnet-sln', () => {
  const p = profileOf('dotnet-sln')

  test('finds csproj projects anywhere in the tree', () => {
    assert.ok(p.modules.length >= 2, `expected >=2 projects, got ${p.modules.length}`)
  })
})

describe('cold-empty', () => {
  const p = profileOf('cold-empty')
  const r = reportOf('cold-empty')

  test('scores badly but does not invent a stack', () => {
    assert.equal(p.stacks.length, 0)
    assert.ok(r.score < 50, `expected a low score, got ${r.score}`)
  })

  test('AGENTS_COMMANDS is the blocker', () => {
    const f = findFinding(r, 'AGENTS_COMMANDS')
    assert.equal(f.status, 'fail')
    assert.equal(f.severity, 'blocker')
  })

  test('code-shaped rules report na rather than fail on an empty repo', () => {
    // This is the invariant that keeps the report free of false positives.
    for (const id of ['BUILD', 'TEST', 'LINT', 'PRECOMMIT']) {
      assert.equal(findFinding(r, id).status, 'na', `${id} should be na`)
    }
  })

  test('every failing finding carries a fix or is informational', () => {
    for (const f of r.findings.filter((x) => x.status === 'fail')) {
      assert.ok(f.fix !== null, `${f.id} failed with no fix artifact`)
    }
  })
})

describe('documented-commands', () => {
  const p = profileOf('documented-commands')

  test('prose commands are labeled documented', () => {
    const test = p.commands.test?.[0]
    assert.equal(test?.source, 'documented')
    assert.match(test?.evidence ?? '', /README\.md:\d+/)
  })

  test('documented outranks the script-name detection', () => {
    // The fixture has both a `test` script and prose. Documented must win.
    const entries = p.commands.test ?? []
    assert.equal(entries[0]?.source, 'documented')
  })

  test('picks up a changed-files subset from prose', () => {
    assert.equal(p.commands.testFast?.[0]?.source, 'documented')
  })
})

describe('multi-lockfile', () => {
  const r = reportOf('multi-lockfile')

  test('fails LOCKFILE and names both lockfiles', () => {
    const f = findFinding(r, 'LOCKFILE')
    assert.equal(f.status, 'fail')
    assert.match(f.detail, /package-lock\.json/)
    assert.match(f.detail, /pnpm-lock\.yaml/)
  })
})

describe('CI_PARITY', () => {
  test('passes when CI runs the documented commands', () => {
    const r = reportOf('node-npm')
    assert.equal(findFinding(r, 'CI_PARITY').status, 'pass')
  })

  test('warns when CI omits a documented command', () => {
    // node-workspace has a `lint` script but its CI never runs lint.
    const r = reportOf('node-workspace')
    const f = findFinding(r, 'CI_PARITY')
    assert.equal(f.status, 'warn')
    assert.match(f.detail, /lint/)
  })
})

describe('SECRET_SCAN', () => {
  test('passes on a repo with no secret-shaped files', () => {
    const r = reportOf('cold-empty')
    assert.equal(findFinding(r, 'SECRET_SCAN').status, 'pass')
  })
})

describe('report shape', () => {
  const r = reportOf('node-npm')

  test('every rule appears exactly once', () => {
    const ids = r.findings.map((f) => f.id)
    assert.equal(new Set(ids).size, ids.length)
  })

  test('every finding names its layer', () => {
    for (const f of r.findings) {
      assert.ok(['orientability', 'operability', 'context', 'governance'].includes(f.layer))
    }
  })

  test('score is a 0..100 integer and matches the grade band', () => {
    assert.ok(Number.isInteger(r.score))
    assert.ok(r.score >= 0 && r.score <= 100)
    const expected = r.score >= 85 ? 'A' : r.score >= 70 ? 'B' : r.score >= 55 ? 'C' : r.score >= 35 ? 'D' : 'F'
    assert.equal(r.grade, expected)
  })

  test('a warm repo scores materially better than a cold one', () => {
    const warm = reportOf('node-npm').score
    const cold = reportOf('cold-empty').score
    assert.ok(warm > cold, `expected warm (${warm}) > cold (${cold})`)
  })

  test('findings with a fix expose a confidence and an origin', () => {
    for (const f of r.findings) {
      if (f.fix === null) continue
      assert.ok(f.fix.confidence >= 0 && f.fix.confidence <= 1, `${f.id} confidence out of range`)
      assert.ok(['derived', 'official', 'community'].includes(f.fix.origin))
    }
  })

  test('na rules are listed and excluded from findings', () => {
    assert.ok(r.notApplicable.length > 0)
    const naCount = r.findings.filter((f) => f.status === 'na').length
    assert.equal(naCount, r.notApplicable.length)
  })
})
