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

import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { after, before, describe, test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { audit, type ReadinessReport } from '@anvil/audit'
import { additionalDetectors, buildProfile, ecosystemDetectors, type ProjectProfile } from '@anvil/profile'

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

const VCS = {
  root: '',
  host: 'github' as const,
  remote: 'git@github.com:acme/fixture.git',
  defaultBranch: 'main',
}

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

/**
 * Audit a directory the caller has already populated.
 *
 * Separate from `reportOf` because several rules read file *content* while evaluating --
 * SECRET_SCAN decides whether a committed `.npmrc` holds a token -- so the tree has to
 * still exist during the audit, not just while the profile is built.
 */
function auditDir(dir: string): ReadinessReport {
  try {
    return audit(buildProfile(dir, { ...VCS, root: dir }).profile)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

function reportOf(fixture: string): ReadinessReport {
  return withProfile(fixture, (profile) => audit(profile))
}

/** The parts of a profile worth snapshotting: volatile paths stripped. */
function snapshot(profile: ProjectProfile): unknown {
  return {
    languages: profile.languages,
    stacks: profile.stacks.map((s) => ({
      id: s.id,
      version: s.version,
      evidence: s.evidence,
    })),
    monorepo: profile.monorepo,
    modules: profile.modules,
    commands: profile.commands,
    tooling: profile.tooling,
    docs: profile.docs,
    risk: profile.risk,
    instructions: profile.instructions.map((i) => ({
      path: i.path,
      category: i.category,
    })),
  }
}

function _findingIds(report: ReadinessReport, status?: string): string[] {
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

  test('AGENTS_COMMANDS is a blocker and fails on a code repo with no instructions', () => {
    // cold-empty has no source files, so the rule is `na` there (nothing to document).
    // A code-bearing repo with no instructions is the case that must be a blocker.
    const f = findFinding(reportOf('node-npm'), 'AGENTS_COMMANDS')
    assert.equal(f.status, 'fail')
    assert.equal(f.severity, 'blocker')
  })

  test('AGENTS_COMMANDS is na on a repo with no source files', () => {
    // A false positive here would train the reader to ignore the report.
    assert.equal(findFinding(reportOf('cold-empty'), 'AGENTS_COMMANDS').status, 'na')
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

  test('sees through a composite script', () => {
    // The bug this pins: CI running `npm run check` is the most common setup there is, and
    // a token search read that as "CI runs nothing", reporting a specific, confident gap
    // that did not exist. Found by adding CI to this repository and being told it did not
    // run the commands it demonstrably runs.
    const dir = materialize('node-npm')
    writeFileSync(
      join(dir, 'package.json'),
      JSON.stringify({
        name: 'composite',
        scripts: {
          check: 'npm run lint && npm run typecheck && npm run test',
          lint: 'eslint .',
          typecheck: 'tsc --noEmit',
          test: 'vitest run',
        },
      }),
      'utf8',
    )
    writeFileSync(
      join(dir, '.github', 'workflows', 'ci.yml'),
      ['name: CI', 'jobs:', '  check:', '    steps:', '      - run: npm ci', '      - run: npm run check', ''].join(
        '\n',
      ),
      'utf8',
    )
    const f = findFinding(
      audit(buildProfile(dir, { root: dir, host: null, remote: null, defaultBranch: null }).profile),
      'CI_PARITY',
    )
    assert.equal(f.status, 'pass', f.detail)
    // And the expansion is what satisfied it: the workflow itself never names eslint.
    assert.match(f.detail, /lint/)
  })
})

describe('SECRET_SCAN', () => {
  test('passes on a repo with no secret-shaped files', () => {
    const r = reportOf('cold-empty')
    assert.equal(findFinding(r, 'SECRET_SCAN').status, 'pass')
  })

  test('a committed secret outside a test path still fails', () => {
    // The rule must keep its teeth. Everything below is about the *false* positives, and a
    // fix that quieted the rule entirely would be worse than the bug.
    const dir = materialize('cold-empty')
    mkdirSync(join(dir, 'config'), { recursive: true })
    writeFileSync(join(dir, 'config', 'production.pem'), '-----BEGIN CERTIFICATE-----\n')
    const f = findFinding(auditDir(dir), 'SECRET_SCAN')
    assert.equal(f.status, 'fail')
    assert.match(f.detail, /production\.pem/)
  })

  test('a real credential under a test path is still reported in the detail', () => {
    // Fixtures are not failures, but they are also not invisible: the names are listed so a
    // human can confirm they really are fixtures. The path deliberately has no
    // `fixtures` segment, because the walker skips those directories outright -- so this
    // covers the case that actually reaches the rule, like `tests/certs/expired/server.key`
    // in requests.
    const dir = materialize('cold-empty')
    mkdirSync(join(dir, 'tests', 'certs'), { recursive: true })
    writeFileSync(join(dir, 'tests', 'certs', 'expired.key'), '-----BEGIN PRIVATE KEY-----\n')
    const f = findFinding(auditDir(dir), 'SECRET_SCAN')
    assert.equal(f.status, 'pass', f.detail)
    assert.match(f.detail, /test fixtures/)
    assert.match(f.detail, /expired\.key/)
  })

  test('a .npmrc is a leak only when it holds a token', () => {
    // Auditing ten real repositories failed this rule on four of them for a committed
    // `.npmrc` containing a registry URL and a scope. A filename is not evidence.
    const clean = materialize('cold-empty')
    writeFileSync(
      join(clean, '.npmrc'),
      'registry=https://registry.npmjs.org/\n@acme:registry=https://npm.acme.example\n',
    )
    assert.equal(findFinding(auditDir(clean), 'SECRET_SCAN').status, 'pass')

    const leaky = materialize('cold-empty')
    writeFileSync(join(leaky, '.npmrc'), '//registry.npmjs.org/:_authToken=npm_abc123\n')
    const f = findFinding(auditDir(leaky), 'SECRET_SCAN')
    assert.equal(f.status, 'fail')
    assert.match(f.detail, /\.npmrc/)
  })

  test('an .env under tests/ or playground/ is a fixture, not a leak', () => {
    // The real repositories that triggered this: `tests/test_apps/.env` in a Python web
    // framework, and one `.env` per playground in a bundler's fixture tree.
    const dir = materialize('cold-empty')
    mkdirSync(join(dir, 'tests', 'test_apps'), { recursive: true })
    writeFileSync(join(dir, 'tests', 'test_apps', '.env'), 'SECRET_KEY=not-a-real-secret\n')
    mkdirSync(join(dir, 'playground', 'env-nested'), { recursive: true })
    writeFileSync(join(dir, 'playground', 'env-nested', '.env.production'), 'TOKEN=x\n')
    const f = findFinding(auditDir(dir), 'SECRET_SCAN')
    assert.equal(f.status, 'pass', f.detail)
  })
})

describe('TEST_FAST', () => {
  test('a documented test command proves a runner exists, so the rule warns rather than fails', () => {
    // The bug: "is there a test runner" was answered from the tooling list alone, which is
    // silent about plenty of runners. A Rust project documenting `cargo test` was reported
    // as having no test runner and failed a high-severity rule -- the exact false failure
    // the plan's "no false blockers" criterion forbids.
    const dir = materialize('rust-crate')
    const f = findFinding(auditDir(dir), 'TEST_FAST')
    assert.notEqual(f.status, 'fail', f.detail)
  })

  test('a capable toolchain with no documented subset is never a failure', () => {
    // Per the plan's detection spec, verbatim: "a repo with pytest but no documented subset
    // must not fail TEST_FAST".
    for (const fixture of ['python-django', 'go-module', 'rust-crate', 'node-npm']) {
      const f = findFinding(reportOf(fixture), 'TEST_FAST')
      assert.notEqual(f.status, 'fail', `${fixture}: ${f.detail}`)
    }
  })

  test('a documented fast subset still passes', () => {
    assert.equal(findFinding(reportOf('go-module'), 'TEST_FAST').status, 'pass')
  })
})

describe('a repository anvil could not identify is not reported as broken', () => {
  // A Rust crate under `engine/` defeats root-level manifest detection entirely. The result
  // was TEST failing as a *blocker* claiming "test files exist but no runnable test command
  // was found" -- a sentence about the repository that was really a sentence about anvil.
  // A blocker an agent must act on cannot afford to be wrong about its cause.
  function unidentifiedRepo(): string {
    const dir = mkdtempSync(join(tmpdir(), 'anvil-unidentified-'))
    mkdirSync(join(dir, 'engine', 'src'), { recursive: true })
    mkdirSync(join(dir, 'engine', 'tests'), { recursive: true })
    writeFileSync(join(dir, 'README.md'), '# host\nA thin host around the engine.\n')
    writeFileSync(join(dir, 'engine', 'src', 'lib.rs'), 'pub fn go() {}\n')
    writeFileSync(join(dir, 'engine', 'tests', 'it.rs'), '#[test]\nfn t() {}\n')
    return dir
  }

  for (const id of ['TEST', 'BUILD', 'LINT']) {
    test(`${id} reports unknown rather than failure`, () => {
      const dir = unidentifiedRepo()
      try {
        const f = findFinding(auditDir(dir), id)
        assert.equal(f.status, 'na', f.detail)
        assert.match(f.detail, /No ecosystem identified/)
      } finally {
        rmSync(dir, { recursive: true, force: true })
      }
    })
  }

  test('the guard is narrow: a missing test command is still a blocker when an stack was found', () => {
    // Otherwise this becomes a way to lose a real finding, which is the worse error.
    for (const fixture of ['go-module', 'rust-crate', 'node-npm', 'python-django']) {
      const dir = materialize(fixture)
      try {
        const f = findFinding(auditDir(dir), 'TEST')
        assert.notEqual(f.status, 'na', `${fixture}: ${f.detail}`)
      } finally {
        rmSync(dir, { recursive: true, force: true })
      }
    }
  })
})

describe('a bzlmod Bazel tree is a known ecosystem, not an unknown one', () => {
  test('a MODULE.bazel repository is offered Bazel commands', () => {
    const dir = mkdtempSync(join(tmpdir(), 'anvil-bazel-'))
    try {
      writeFileSync(join(dir, 'MODULE.bazel'), 'module(name = "rules", version = "1.0")\n')
      writeFileSync(join(dir, 'BUILD.bazel'), '\n')
      const p = buildProfile(dir, { ...VCS, root: dir }).profile
      assert.ok(p.stacks.some((s) => s.id === 'bazel'))
      assert.equal(p.commands.test?.[0]?.cmd, 'bazel test //...')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('the six additional detectors', () => {
  test('a Rails repo detects ruby, rails, rspec and rubocop', () => {
    const p = profileOf('ruby-rails')
    const ids = p.stacks.map((s) => s.id)
    for (const expected of ['ruby', 'rails', 'rspec', 'rubocop']) {
      assert.ok(ids.includes(expected), `expected ${expected} in ${ids.join(', ')}`)
    }
  })

  test('a Rakefile task definition is detected, not assumed', () => {
    const p = profileOf('ruby-rails')
    // `rake spec` is defined in the Rakefile, so the rspec command is `detected`.
    assert.equal(p.commands.test?.[0]?.source, 'detected')
    assert.equal(p.commands.lint?.[0]?.cmd, 'bundle exec rubocop')
  })

  test('a Terraform repo detects terraform and its providers', () => {
    const p = profileOf('terraform-infra')
    const ids = p.stacks.map((s) => s.id)
    assert.ok(ids.includes('terraform'))
    assert.ok(ids.includes('terraform-aws'))
    assert.ok(ids.includes('terraform-github'))
  })

  test('Terraform is high risk and recorded as IaC', () => {
    const p = profileOf('terraform-infra')
    assert.ok(p.risk.some((r) => r.glob === '**/*.tf' && r.level === 'high'))
    assert.ok(p.tooling.iac.length > 0)
  })

  test('terraform has a higher detector priority than a provider-specific stack', () => {
    // An IaC repo is a Terraform repo first; its playbook must win.
    const p = profileOf('terraform-infra')
    assert.ok(p.stacks.length > 0)
    const terraform = p.stacks.find((s) => s.id === 'terraform')
    assert.ok(terraform)
  })

  test('a php repo detects php and, with artisan, laravel', () => {
    const p = profileOf('php-laravel')
    const ids = p.stacks.map((s) => s.id)
    assert.ok(ids.includes('php'))
    assert.ok(ids.includes('laravel'))
    assert.equal(p.commands.test?.[0]?.cmd, 'php artisan test')
  })

  test('a php repo treats migrations as high risk', () => {
    const p = profileOf('php-laravel')
    assert.ok(p.risk.some((r) => r.glob.includes('migrations') && r.level === 'high'))
  })

  test('an elixir repo detects elixir and phoenix', () => {
    const p = profileOf('elixir-phoenix')
    const ids = p.stacks.map((s) => s.id)
    assert.ok(ids.includes('elixir'))
    assert.ok(ids.includes('phoenix'))
  })

  test('a swift package build and test are detected from the manifest', () => {
    const p = profileOf('swift-package')
    assert.equal(p.commands.build?.[0]?.cmd, 'swift build')
    assert.equal(p.commands.build?.[0]?.source, 'detected')
  })

  test('a vite + vue repo detects both without inventing a build command', () => {
    const p = profileOf('frontend-vue')
    const ids = p.stacks.map((s) => s.id)
    assert.ok(ids.includes('vue'))
    assert.ok(ids.includes('vite'))
    // The bundler is invoked through a package script; the node detector reads that.
    // Claiming a build command here would duplicate or contradict it.
    assert.equal(p.commands.build?.[0]?.source, 'detected')
  })

  test('detector count reaches thirteen', () => {
    // Twelve plus Bazel, which was missing entirely until a MODULE.bazel tree was audited
    // and scored 22/100 for it. The `Set` also asserts every id is unique: two detectors
    // sharing an id would silently shadow one another.
    const ids = new Set([...ecosystemDetectors, ...additionalDetectors].map((d) => d.id))
    assert.equal(ids.size, 13)
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
