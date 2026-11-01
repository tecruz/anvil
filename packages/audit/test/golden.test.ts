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

describe('a Gradle module that configures its own tooling', () => {
  // Found by auditing an Android repository that applies detekt and spotless in
  // `app/build.gradle.kts` and documents `./gradlew detekt` / `./gradlew spotlessApply`.
  // It was still told "No linter configured" and "No formatter configured": the probe only
  // looked for root-level config files, which neither plugin uses.
  function ciYaml(runs: readonly string[]): string {
    return [
      'name: CI',
      'on: [push]',
      'jobs:',
      '  build:',
      '    runs-on: ubuntu-latest',
      '    steps:',
      ...runs.map((r) => `      - run: ${r}`),
      '',
    ].join('\n')
  }

  function gradleModule(runs: readonly string[]): string {
    const dir = mkdtempSync(join(tmpdir(), 'anvil-gradle-tools-'))
    writeFileSync(join(dir, 'settings.gradle.kts'), 'rootProject.name = "app"\ninclude(":app")\n')
    writeFileSync(
      join(dir, 'build.gradle.kts'),
      [
        'plugins {',
        '    alias(libs.plugins.detekt) apply false',
        '    alias(libs.plugins.spotless) apply false',
        '}',
        '',
      ].join('\n'),
    )
    mkdirSync(join(dir, 'app', 'src', 'main', 'java', 'com', 'acme'), { recursive: true })
    writeFileSync(
      join(dir, 'app', 'build.gradle.kts'),
      [
        'plugins {',
        '    alias(libs.plugins.detekt)',
        '    alias(libs.plugins.spotless)',
        '}',
        '',
        'detekt {',
        '    buildUponDefaultConfig = true',
        '}',
        '',
        'spotless {',
        '    kotlin {',
        '        ktlint("1.5.0")',
        '    }',
        '}',
        '',
      ].join('\n'),
    )
    writeFileSync(join(dir, 'app', 'src', 'main', 'java', 'com', 'acme', 'Main.kt'), 'fun main() {}\n')
    writeFileSync(join(dir, 'gradlew'), '#!/bin/sh\nexec gradle "$@"\n')
    mkdirSync(join(dir, '.github', 'workflows'), { recursive: true })
    writeFileSync(join(dir, '.github', 'workflows', 'ci.yml'), ciYaml(runs))
    return dir
  }

  test('detects the plugins and the tasks they contribute', () => {
    const dir = gradleModule([])
    try {
      const p = buildProfile(dir, { ...VCS, root: dir }).profile
      assert.ok(p.tooling.lint.includes('detekt'), `lint: ${p.tooling.lint.join(', ')}`)
      assert.ok(p.tooling.formatter.includes('spotless'), `formatter: ${p.tooling.formatter.join(', ')}`)
      assert.equal(p.commands.lint?.find((c) => c.source === 'detected')?.cmd, './gradlew detekt')
      assert.equal(p.commands.format?.find((c) => c.source === 'detected')?.cmd, './gradlew spotlessCheck')
      // `ktlint(...)` inside Spotless is the formatter's engine, not the ktlint Gradle
      // plugin. Reporting it separately would name `./gradlew ktlintCheck`, a task that
      // does not exist in this build.
      assert.ok(!p.tooling.lint.includes('ktlint'), `unexpected ktlint: ${p.tooling.lint.join(', ')}`)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('CI that assembles, runs kover and detekt satisfies build, test and lint', () => {
    // Gradle's CI commands do not spell the documented task: `assembleDebug` is a build,
    // `koverXmlReport` runs the tests, and neither contained the old `gradlew build` /
    // `gradlew test` tokens. That produced "CI does not appear to run: test, build".
    const dir = gradleModule(['./gradlew assembleDebug', './gradlew koverXmlReport', './gradlew detekt'])
    const f = findFinding(auditDir(dir), 'CI_PARITY')
    assert.equal(f.status, 'pass', f.detail)
    assert.match(f.detail, /test \(gradlew kover\)/)
    assert.match(f.detail, /build \(gradlew assemble\)/)
    assert.match(f.detail, /lint \(gradlew detekt\)/)
  })

  test('CI that never runs the detected linter is still a real gap', () => {
    const dir = gradleModule(['./gradlew assembleDebug', './gradlew koverXmlReport'])
    const f = findFinding(auditDir(dir), 'CI_PARITY')
    assert.equal(f.status, 'warn', f.detail)
    assert.match(f.detail, /lint/)
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

  /**
   * The bug, found by auditing android/nowinandroid: its AGENTS.md documents the build,
   * the formatter and the test tasks, and every one of them is written `./gradlew ...`.
   * `AGENTS_COMMANDS` failed as a *blocker* with "Instructions exist but name no runnable
   * command" -- because the character before `gradlew` is a `/` that the leading class did
   * not include. The sentence was about a punctuation detail, and it was raised against the
   * best agent instructions in the batch.
   */
  test('a command invoked through a path counts as a command', () => {
    const dir = mkdtempSync(join(tmpdir(), 'anvil-agents-cmd-'))
    try {
      writeFileSync(
        join(dir, 'AGENTS.md'),
        [
          '# Now In Android',
          '',
          'A third of the modules are Gradle modules and the rest are libraries.',
          '',
          '- Build: `./gradlew assemble{Variant}`. Typically `assembleDemoDebug`.',
          '- Fix linting: `./gradlew spotlessApply`',
          '- Run local tests: `./gradlew testDemoDebug`',
          '',
          'The architecture is described in docs/ArchitectureLearningJourney.md.',
          '',
        ].join('\n'),
      )
      writeFileSync(join(dir, 'build.gradle.kts'), 'plugins { id("com.android.application") }\n')
      writeFileSync(join(dir, 'gradlew'), '#!/bin/sh\nexec gradle "$@"\n')
      mkdirSync(join(dir, 'app', 'src', 'main', 'java'), { recursive: true })
      writeFileSync(join(dir, 'app', 'src', 'main', 'java', 'Main.kt'), 'fun main() {}\n')
      mkdirSync(join(dir, 'app', 'src', 'test', 'java'), { recursive: true })
      writeFileSync(join(dir, 'app', 'src', 'test', 'java', 'MainTest.kt'), 'class MainTest\n')
      const f = findFinding(auditDir(dir), 'AGENTS_COMMANDS')
      assert.equal(f.status, 'pass', f.detail)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  /**
   * The gap, recorded after the third audit: the runner list was a snapshot of the six
   * original detectors, so an AGENTS.md documenting only `mix test` -- or `rake test`, or
   * `swift test` -- would have drawn the same false blocker nowinandroid did for `./gradlew`.
   * Nothing in the batch exhibited it, which is why it stayed a note rather than a fix; the
   * fix is constrained subcommands, because three of those names are ordinary English words.
   */
  test('an Elixir repo documenting only mix commands names a command', () => {
    const dir = mkdtempSync(join(tmpdir(), 'anvil-agents-mix-'))
    try {
      writeFileSync(
        join(dir, 'AGENTS.md'),
        ['# App', '', '## Commands', '', '```bash', 'mix deps.get', 'mix test', 'mix credo --strict', '```', ''].join(
          '\n',
        ),
      )
      writeFileSync(join(dir, 'mix.exs'), 'defmodule App.MixProject do\n  use Mix.Project\nend\n')
      mkdirSync(join(dir, 'lib'), { recursive: true })
      writeFileSync(join(dir, 'lib', 'app.ex'), 'defmodule App do\nend\n')
      mkdirSync(join(dir, 'test'), { recursive: true })
      writeFileSync(join(dir, 'test', 'app_test.exs'), 'defmodule AppTest do\n  use ExUnit.Case\nend\n')
      assert.equal(findFinding(auditDir(dir), 'AGENTS_COMMANDS').status, 'pass')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('runner names used as ordinary English are not commands', () => {
    // The constrained tier is the reason the fix is safe to add: none of `mix`, `rake`,
    // `bundle` or `swift` appears here with a subcommand, because none of it is a command.
    // An unconstrained match on any of them would turn a blocker into a false pass, which is
    // the most reassuring -- and therefore the most dangerous -- error this rule can make.
    const dir = mkdtempSync(join(tmpdir(), 'anvil-agents-prose-'))
    try {
      writeFileSync(
        join(dir, 'AGENTS.md'),
        [
          '# Notes',
          '',
          'The codebase is a mix of styles; we write idiomatic Swift and bundle the assets',
          'by hand. Careful work will rake in good reviews.',
          '',
        ].join('\n'),
      )
      writeFileSync(join(dir, 'mix.exs'), 'defmodule App.MixProject do\n  use Mix.Project\nend\n')
      mkdirSync(join(dir, 'lib'), { recursive: true })
      writeFileSync(join(dir, 'lib', 'app.ex'), 'defmodule App do\nend\n')
      mkdirSync(join(dir, 'test'), { recursive: true })
      writeFileSync(join(dir, 'test', 'app_test.exs'), 'defmodule AppTest do\n  use ExUnit.Case\nend\n')
      const f = findFinding(auditDir(dir), 'AGENTS_COMMANDS')
      assert.equal(f.status, 'fail', f.detail)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('a path that merely contains a runner name is not a command', () => {
    // The other direction, and the reason every alternative requires a following space: the
    // Gradle distribution lives at /opt/gradlew/bin/gradle, and a wrapper path in a doc must
    // not satisfy a blocker.
    const dir = mkdtempSync(join(tmpdir(), 'anvil-agents-cmd2-'))
    try {
      writeFileSync(
        join(dir, 'AGENTS.md'),
        '# Wrapper\n\nGradle was unpacked to /opt/gradlew/bin and added to the PATH.\n',
      )
      writeFileSync(join(dir, 'build.gradle.kts'), 'plugins { java }\n')
      writeFileSync(join(dir, 'gradlew'), '#!/bin/sh\nexec gradle "$@"\n')
      mkdirSync(join(dir, 'src', 'main', 'java'), { recursive: true })
      writeFileSync(join(dir, 'src', 'main', 'java', 'Main.java'), 'public class Main {}\n')
      const f = findFinding(auditDir(dir), 'AGENTS_COMMANDS')
      assert.equal(f.status, 'fail', f.detail)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

/**
 * The instruction budget.
 *
 * An agent loads its instructions on every request, so their size is paid for on every
 * request. A study of AGENTS.md files in real repositories (arXiv:2602.11988) found the
 * files did not generally raise task success and raised inference cost by more than 20%;
 * the guidance that paid for itself was the part a model could not infer from the repo.
 * The rule below is that finding, made mechanical.
 */
describe('INSTRUCTION_BUDGET', () => {
  /** A repo whose instructions are `bytes` long, with a runnable command at the top. */
  function repoWithInstructions(bytes: number, opts: { commandAtTop?: boolean } = {}): string {
    const dir = mkdtempSync(join(tmpdir(), 'anvil-budget-'))
    const head = opts.commandAtTop === false ? '' : '# Repo\n\n- Test: `npm test`\n\n'
    const filler = 'x'.repeat(Math.max(0, bytes - head.length))
    writeFileSync(join(dir, 'AGENTS.md'), `${head}${filler}\n`)
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'budget', scripts: { test: 'node --test' } }))
    mkdirSync(join(dir, 'src'), { recursive: true })
    writeFileSync(join(dir, 'src', 'index.js'), 'export const a = 1\n')
    return dir
  }

  test('is na when the repo ships no instructions', () => {
    // AGENTS_FILE already reports the absence; saying it twice is noise.
    assert.equal(findFinding(reportOf('node-npm'), 'INSTRUCTION_BUDGET').status, 'na')
  })

  test('passes for an instruction file inside the budget', () => {
    const dir = repoWithInstructions(4_000)
    try {
      const f = findFinding(auditDir(dir), 'INSTRUCTION_BUDGET')
      assert.equal(f.status, 'pass', f.detail)
      assert.match(f.detail, /tokens/)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('warns past the warning threshold and fails past the failing one', () => {
    const warnDir = repoWithInstructions(20_000)
    const failDir = repoWithInstructions(50_000)
    try {
      const warned = findFinding(auditDir(warnDir), 'INSTRUCTION_BUDGET')
      assert.equal(warned.status, 'warn', warned.detail)
      assert.equal(warned.severity, 'medium')
      // The file puts `npm test` at the top, so only the size half of the rule applies.
      assert.doesNotMatch(warned.detail, /runnable command/)

      const failed = findFinding(auditDir(failDir), 'INSTRUCTION_BUDGET')
      assert.equal(failed.status, 'fail', failed.detail)
      assert.ok(failed.fix !== null, 'a failing finding must carry a fix')
    } finally {
      rmSync(warnDir, { recursive: true, force: true })
      rmSync(failDir, { recursive: true, force: true })
    }
  })

  test('measures the largest instruction file, not the sum', () => {
    // Two tools, two files, and no agent loads both: axios ships 14.7 kB of AGENTS.md
    // and 6.0 kB of Copilot instructions, and the sum warned on a repository whose
    // guidance is under the line. The budget is what one tool reads.
    const dir = mkdtempSync(join(tmpdir(), 'anvil-budget-two-'))
    try {
      const body = 'x'.repeat(12_000)
      writeFileSync(join(dir, 'AGENTS.md'), body)
      writeFileSync(join(dir, 'CLAUDE.md'), body)
      writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'budget', scripts: { test: 'node --test' } }))
      mkdirSync(join(dir, 'src'), { recursive: true })
      writeFileSync(join(dir, 'src', 'index.js'), 'export const a = 1\n')
      const f = findFinding(auditDir(dir), 'INSTRUCTION_BUDGET')
      assert.equal(f.status, 'pass', f.detail)
      assert.match(f.detail, /Largest of 2/)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('says when the commands are not at the top', () => {
    // The half of the rule that decides whether the guidance works: the commands are the
    // part a model cannot infer, so burying them under prose spends the budget on the
    // part that did not help (arXiv:2602.11988).
    const dir = repoWithInstructions(20_000, { commandAtTop: false })
    try {
      const f = findFinding(auditDir(dir), 'INSTRUCTION_BUDGET')
      assert.equal(f.status, 'warn', f.detail)
      assert.match(f.detail, /runnable command/)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('the fix names the instruction file the repository actually ships', () => {
    // A repo whose guidance lives in CLAUDE.md is not helped by a suggestion to edit an
    // AGENTS.md it does not have.
    const dir = mkdtempSync(join(tmpdir(), 'anvil-budget-claude-'))
    try {
      writeFileSync(join(dir, 'CLAUDE.md'), 'x'.repeat(50_000))
      writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'budget', scripts: { test: 'node --test' } }))
      mkdirSync(join(dir, 'src'), { recursive: true })
      writeFileSync(join(dir, 'src', 'index.js'), 'export const a = 1\n')
      const f = findFinding(auditDir(dir), 'INSTRUCTION_BUDGET')
      assert.equal(f.status, 'fail', f.detail)
      assert.equal(f.fix?.target, 'CLAUDE.md')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('measures a rules directory by the files inside it', () => {
    // `.cursor/rules` is a directory, and the profile used to report it as zero bytes.
    // The budget then said there was nothing to measure in a repo whose entire guidance
    // lived there, which is the one answer a budget rule must not get wrong.
    const dir = mkdtempSync(join(tmpdir(), 'anvil-budget-cursor-'))
    try {
      mkdirSync(join(dir, '.cursor', 'rules'), { recursive: true })
      writeFileSync(join(dir, '.cursor', 'rules', 'style.mdc'), 'x'.repeat(50_000))
      writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'budget', scripts: { test: 'node --test' } }))
      mkdirSync(join(dir, 'src'), { recursive: true })
      writeFileSync(join(dir, 'src', 'index.js'), 'export const a = 1\n')
      const f = findFinding(auditDir(dir), 'INSTRUCTION_BUDGET')
      assert.equal(f.status, 'fail', f.detail)
      // A directory has no "first 80 lines", so the placement half must stay silent.
      assert.doesNotMatch(f.detail, /runnable command/)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('does not complain about command placement in a small file', () => {
    // The check only runs once the file is over the threshold. A short file that lists
    // its commands late is not a problem worth a finding.
    const dir = repoWithInstructions(2_000, { commandAtTop: false })
    try {
      const f = findFinding(auditDir(dir), 'INSTRUCTION_BUDGET')
      assert.equal(f.status, 'pass', f.detail)
      assert.doesNotMatch(f.detail, /runnable command/)
    } finally {
      rmSync(dir, { recursive: true, force: true })
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
    writeFileSync(
      join(dir, 'config', 'production.pem'),
      '-----BEGIN RSA PRIVATE KEY-----\nMIIEow...\n-----END RSA PRIVATE KEY-----\n',
    )
    const f = findFinding(auditDir(dir), 'SECRET_SCAN')
    assert.equal(f.status, 'fail')
    assert.match(f.detail, /production\.pem/)
  })

  test('a committed public key is not a committed secret', () => {
    // Found by auditing plausible/analytics, failed on `priv/paddle.pem` and
    // `priv/paddle_sandbox.pem`. Both hold one `PUBLIC KEY` block and nothing else: they are
    // Paddle's webhook signing keys, and a webhook receiver *verifies* with the sender's
    // public key, so publishing it is the entire point of committing it. A rule that reports
    // them teaches its reader to ignore it, and the real leak it might have caught is cheaper.
    const dir = materialize('cold-empty')
    mkdirSync(join(dir, 'priv'), { recursive: true })
    writeFileSync(
      join(dir, 'priv', 'paddle.pem'),
      '-----BEGIN PUBLIC KEY-----\nMIICIjANBgkq...\n-----END PUBLIC KEY-----\n',
    )
    const f = findFinding(auditDir(dir), 'SECRET_SCAN')
    assert.equal(f.status, 'pass', f.detail)
    // The exclusion is stated, not silent: a reader has to be able to check it.
    assert.match(f.detail, /public key/)
    assert.match(f.detail, /paddle\.pem/)
  })

  test('a certificate bundling a private key is still a secret', () => {
    // The order inside the classifier is the point: a bundle is the normal way to ship a
    // server cert, and it usually carries the key next to it.
    const dir = materialize('cold-empty')
    mkdirSync(join(dir, 'etc'), { recursive: true })
    writeFileSync(
      join(dir, 'etc', 'fullchain.pem'),
      [
        '-----BEGIN CERTIFICATE-----',
        'MIIDdzCCAlOgAwIBAgIU...',
        '-----END CERTIFICATE-----',
        '-----BEGIN PRIVATE KEY-----',
        'MIIEvQIBADANBgkqhkiG9w0...',
        '-----END PRIVATE KEY-----',
        '',
      ].join('\n'),
    )
    const f = findFinding(auditDir(dir), 'SECRET_SCAN')
    assert.equal(f.status, 'fail', f.detail)
    assert.match(f.detail, /fullchain\.pem/)
  })

  test('a .pem whose body proves nothing is still flagged', () => {
    // DER-encoded, encrypted, or a format this tool does not recognise: nothing proved it
    // publishable, so nothing clears it. Narrowing the false side only.
    const dir = materialize('cold-empty')
    mkdirSync(join(dir, 'certs'), { recursive: true })
    writeFileSync(join(dir, 'certs', 'store.pem'), Buffer.from([0x30, 0x82, 0x01, 0x0a, 0x02]))
    const f = findFinding(auditDir(dir), 'SECRET_SCAN')
    assert.equal(f.status, 'fail', f.detail)
  })

  test('a real credential under a test path is still reported in the detail', () => {
    // Fixtures are not failures, but they are also not invisible: the names are listed so a
    // human can confirm they really are fixtures. The path deliberately has no
    // `fixtures` segment, because the walker skips those directories outright -- so this
    // covers the case that actually reaches the rule, like `tests/certs/expired/server.key`
    // in requests. The detail says these were *not* content-inspected, because they were not.
    const dir = materialize('cold-empty')
    mkdirSync(join(dir, 'tests', 'certs'), { recursive: true })
    writeFileSync(join(dir, 'tests', 'certs', 'expired.key'), '-----BEGIN PRIVATE KEY-----\n')
    const f = findFinding(auditDir(dir), 'SECRET_SCAN')
    assert.equal(f.status, 'pass', f.detail)
    assert.match(f.detail, /test\/sample path/)
    assert.match(f.detail, /not content-inspected/)
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

  test('always-auth alone is not a credential', () => {
    // `always-auth` is a boolean. Older CI configurations set it with no token in sight, and
    // treating it as a secret failed a file that contained nothing sensitive.
    const dir = materialize('cold-empty')
    writeFileSync(join(dir, '.npmrc'), 'registry=https://registry.npmjs.org/\nalways-auth=true\n')
    const f = findFinding(auditDir(dir), 'SECRET_SCAN')
    assert.equal(f.status, 'pass', f.detail)
    assert.match(f.detail, /no auth token/)
  })

  test('a live token in a test path is a leak, because the file is read first', () => {
    // The bug this pins: the path exemption ran *before* the content check, so a real
    // `_authToken` in `examples/app/.npmrc` was dismissed as a fixture and the rule reported
    // "no committed secrets" about a file nobody opened. Deciding by path first is only safe
    // for files whose content cannot change the answer -- and `.npmrc`'s does.
    const dir = materialize('cold-empty')
    mkdirSync(join(dir, 'examples', 'app'), { recursive: true })
    writeFileSync(join(dir, 'examples', 'app', '.npmrc'), '//registry.npmjs.org/:_authToken=npm_live\n')
    const f = findFinding(auditDir(dir), 'SECRET_SCAN')
    assert.equal(f.status, 'fail', f.detail)
    assert.match(f.detail, /examples\/app\/\.npmrc/)
  })

  test('a token-free .npmrc under a test path is still only a fixture', () => {
    // The mirror of the case above, so the fix cannot be "read nothing under a test path".
    const dir = materialize('cold-empty')
    mkdirSync(join(dir, 'examples'), { recursive: true })
    writeFileSync(join(dir, 'examples', '.npmrc'), 'registry=https://registry.npmjs.org/\n')
    assert.equal(findFinding(auditDir(dir), 'SECRET_SCAN').status, 'pass')
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

  test('evidence names the files the claim is about', () => {
    // `Finding.evidence` is a published contract of paths. A pass that says "no committed
    // secrets" while its evidence is empty is a claim with nothing behind it.
    const dir = materialize('cold-empty')
    mkdirSync(join(dir, 'tests', 'certs'), { recursive: true })
    writeFileSync(join(dir, 'tests', 'certs', 'expired.key'), '-----BEGIN PRIVATE KEY-----\n')
    const f = findFinding(auditDir(dir), 'SECRET_SCAN')
    assert.deepEqual(f.evidence, ['tests/certs/expired.key'])
  })
})

describe('TEST_FAST', () => {
  // The bug: "is there a test runner" was answered from the tooling list alone, which is
  // silent about plenty of runners. A project whose runner the detectors do not name was
  // reported as having none and failed a high-severity rule -- the exact false failure the
  // plan's "no false blockers" criterion forbids.
  test('a detected runner is named by the command it was detected from', () => {
    const dir = mkdtempSync(join(tmpdir(), 'anvil-tf-'))
    try {
      writeFileSync(
        join(dir, 'package.json'),
        JSON.stringify({ name: 'x', version: '1.0.0', scripts: { test: 'node --test' } }, null, 2),
      )
      mkdirSync(join(dir, 'src'), { recursive: true })
      writeFileSync(join(dir, 'src', 'index.js'), 'export const x = 1\n')
      writeFileSync(join(dir, 'src', 'index.test.js'), "import { test } from 'node:test'\n")
      const f = findFinding(auditDir(dir), 'TEST_FAST')
      assert.equal(f.status, 'warn', f.detail)
      assert.match(f.detail, /npm run test/, f.detail)
      // `npm` is a package manager. Reading a runner name off the first token of a command
      // produced "A test runner is configured (npm)", which is a confidently-wrong claim in a
      // high-severity finding.
      assert.ok(!/runner is configured \(npm\)/.test(f.detail), f.detail)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('an inferred-only test command warns without claiming a runner', () => {
    // Built inline rather than from the `rust-crate` fixture, because that fixture mentions
    // `cargo-nextest` in its Cargo.toml and therefore reaches `pass` long before the code this
    // test is about -- a test that passes with the feature reverted is a test that proves
    // nothing. Here `cargo test` is inferred, so no runner can honestly be named.
    const dir = mkdtempSync(join(tmpdir(), 'anvil-tf-'))
    try {
      writeFileSync(
        join(dir, 'Cargo.toml'),
        '[package]\nname = "x"\nversion = "0.1.0"\nedition = "2021"\n\n[dev-dependencies]\n',
      )
      mkdirSync(join(dir, 'src'), { recursive: true })
      mkdirSync(join(dir, 'tests'), { recursive: true })
      writeFileSync(join(dir, 'src', 'lib.rs'), 'pub fn go() {}\n')
      writeFileSync(join(dir, 'tests', 'it.rs'), '#[test]\nfn t() {}\n')
      const f = findFinding(auditDir(dir), 'TEST_FAST')
      assert.equal(f.status, 'warn', f.detail)
      assert.match(f.detail, /nothing here is proven missing/)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('evidence names a file, never a tool name and never an empty string', () => {
    // `Finding.evidence` is a published contract: file:line or a path. An inferred command
    // carries no evidence by design, so this is where a naive implementation emits "".
    const dir = mkdtempSync(join(tmpdir(), 'anvil-tf-'))
    try {
      writeFileSync(
        join(dir, 'Cargo.toml'),
        '[package]\nname = "x"\nversion = "0.1.0"\nedition = "2021"\n\n[dev-dependencies]\n',
      )
      mkdirSync(join(dir, 'src'), { recursive: true })
      mkdirSync(join(dir, 'tests'), { recursive: true })
      writeFileSync(join(dir, 'src', 'lib.rs'), 'pub fn go() {}\n')
      writeFileSync(join(dir, 'tests', 'it.rs'), '#[test]\nfn t() {}\n')
      const f = findFinding(auditDir(dir), 'TEST_FAST')
      assert.ok(f.evidence.length > 0, 'a finding with no evidence is a to-do, not a finding')
      for (const e of f.evidence) {
        assert.notEqual(e, '', 'empty evidence is not evidence')
        assert.ok(e.includes('.'), `expected a path with an extension, got ${JSON.stringify(e)}`)
      }
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('a capable toolchain with no documented subset is never a failure', () => {
    // Per the plan's detection spec, verbatim: "a repo with pytest but no documented subset
    // must not fail TEST_FAST". Asserted against the exact status rather than `notEqual`,
    // which `na` and `pass` would both satisfy.
    for (const fixture of ['python-django', 'go-module', 'rust-crate', 'node-npm']) {
      const f = findFinding(reportOf(fixture), 'TEST_FAST')
      assert.ok(f.status === 'warn' || f.status === 'pass', `${fixture}: ${f.status} -- ${f.detail}`)
    }
  })

  test('a documented fast subset still passes', () => {
    assert.equal(findFinding(reportOf('go-module'), 'TEST_FAST').status, 'pass')
  })

  /**
   * The bug, found by auditing three real Gradle repositories (okhttp, spring-petclinic,
   * nowinandroid): all three were reported as having a documented changed-files test
   * subset, and the command in the finding was `./gradlew test --tests '*Changed'`.
   *
   * None of the three defines a `*Changed` task, so the command selects zero tests and
   * Gradle fails it. The rule was checking that *a* fast-subset command existed, not that
   * the command was evidence -- and a command anvil invented from its own playbook is the
   * weakest evidence there is. A fabricated `pass` on the rule the plan calls "the one that
   * makes agents usable" is the most expensive output this tool can produce, because the
   * reader stops looking for the fast path.
   *
   * The entry is injected rather than produced by a fixture on purpose: pinning this to a
   * detector means the test goes quiet the moment the detector changes, and a test that
   * passes with the rule reverted is a test that proves nothing.
   */
  test('an inferred fast-subset command is not a documented one', () => {
    const dir = mkdtempSync(join(tmpdir(), 'anvil-tf-inferred-'))
    try {
      writeFileSync(
        join(dir, 'package.json'),
        JSON.stringify({ name: 'x', version: '1.0.0', scripts: { test: 'vitest run' } }, null, 2),
      )
      mkdirSync(join(dir, 'src'), { recursive: true })
      writeFileSync(join(dir, 'src', 'index.js'), 'export const x = 1\n')
      writeFileSync(join(dir, 'src', 'index.test.js'), "import { test } from 'vitest'\n")
      const profile = buildProfile(dir, { ...VCS, root: dir }).profile
      profile.commands.testFast = [{ cmd: './gradlew test --tests "*Changed*"', source: 'inferred' }]
      const f = findFinding(audit(profile), 'TEST_FAST')
      assert.equal(f.status, 'warn', `expected a warning, got ${f.status}: ${f.detail}`)
      assert.ok(!/Changed/.test(f.detail), `a fabricated subset reached the report: ${f.detail}`)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('a documented fast subset the project defines is still reported', () => {
    // The positive half of the same contract: dropping inferred commands must not lose a
    // real one. A Gradle project that defines its own `testChanged` task has documented a
    // fast subset, and naming that task is evidence rather than a guess.
    const dir = mkdtempSync(join(tmpdir(), 'anvil-tf-real-'))
    try {
      writeFileSync(join(dir, 'settings.gradle.kts'), 'rootProject.name = "x"\n')
      writeFileSync(
        join(dir, 'build.gradle.kts'),
        [
          'plugins { java }',
          'tasks.register("testChanged", Test) {',
          '  filter { includeTestsMatching("*Changed*") }',
          '}',
          '',
        ].join('\n'),
      )
      writeFileSync(join(dir, 'gradlew'), '#!/bin/sh\nexec gradle "$@"\n')
      mkdirSync(join(dir, 'src', 'main', 'java'), { recursive: true })
      writeFileSync(join(dir, 'src', 'main', 'java', 'Main.java'), 'public class Main {}\n')
      mkdirSync(join(dir, 'src', 'test', 'java'), { recursive: true })
      writeFileSync(join(dir, 'src', 'test', 'java', 'MainTest.java'), 'class MainTest {}\n')
      const profile = buildProfile(dir, { ...VCS, root: dir }).profile
      const f = findFinding(audit(profile), 'TEST_FAST')
      assert.equal(f.status, 'pass', f.detail)
      assert.match(f.detail, /testChanged/, f.detail)
      assert.match(f.detail, /\[detected\]/, f.detail)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('a repository anvil cannot read at all is not reported as broken', () => {
  // The motivating case was a Rust crate under `engine/`, which failed `TEST` as a *blocker*
  // claiming "test files exist but no runnable test command was found" -- a sentence about
  // the repository that was really a sentence about anvil. That case is now fixed at the
  // source, by resolving the project directory before any detector runs, so it is pinned
  // here as a *detected* project rather than as an `na`.
  test('a crate in a subdirectory is detected, not excused', () => {
    const dir = mkdtempSync(join(tmpdir(), 'anvil-subdir-crate-'))
    try {
      mkdirSync(join(dir, 'engine', 'src'), { recursive: true })
      mkdirSync(join(dir, 'engine', 'tests'), { recursive: true })
      writeFileSync(join(dir, 'README.md'), '# host\nA thin host around the engine.\n')
      writeFileSync(
        join(dir, 'engine', 'Cargo.toml'),
        '[package]\nname = "engine"\nversion = "0.1.0"\nedition = "2021"\n',
      )
      writeFileSync(join(dir, 'engine', 'src', 'lib.rs'), 'pub fn go() {}\n')
      writeFileSync(join(dir, 'engine', 'tests', 'it.rs'), '#[test]\nfn t() {}\n')
      const f = findFinding(auditDir(dir), 'TEST')
      assert.notEqual(f.status, 'na', f.detail)
      assert.notEqual(f.status, 'fail', f.detail)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  // Source files, no manifest, and nothing on disk that names a build system. There is
  // nothing true anvil can say about how to build or test this, so `na` is the honest answer
  // -- and it says so plainly. C source files are used because the language table knows them
  // while no detector claims the ecosystem, which is precisely the situation.
  function shapelessRepo(): string {
    const dir = mkdtempSync(join(tmpdir(), 'anvil-unidentified-'))
    mkdirSync(join(dir, 'src'), { recursive: true })
    mkdirSync(join(dir, 'tests'), { recursive: true })
    writeFileSync(join(dir, 'README.md'), '# notes\nSource with no build system anywhere.\n')
    writeFileSync(join(dir, 'src', 'main.c'), 'int main(void) { return 0; }\n')
    writeFileSync(join(dir, 'tests', 'main_test.c'), 'int main(void) { return 0; }\n')
    return dir
  }

  for (const id of ['TEST', 'BUILD', 'LINT']) {
    test(`${id} reports unknown rather than failure on a tree with no build system`, () => {
      const dir = shapelessRepo()
      try {
        const f = findFinding(auditDir(dir), id)
        assert.equal(f.status, 'na', f.detail)
        assert.match(f.detail, /No ecosystem or build system identified/)
      } finally {
        rmSync(dir, { recursive: true, force: true })
      }
    })
  }

  // The over-reach this guard was guilty of: `Makefile` and `CMakeLists.txt` trees have no
  // detector, so `stacks` is empty -- but anvil plainly understands them at the file level, it
  // found the sources, the build file and the tests. Silencing three rules on every C, C++
  // and shell repository is a lost finding, which is the direction this project has been
  // fixing everywhere else.
  test('a Makefile tree is still judged, because a build file is not the same as no build system', () => {
    const dir = mkdtempSync(join(tmpdir(), 'anvil-makefile-'))
    try {
      writeFileSync(join(dir, 'Makefile'), 'all:\n\tcc -o app main.c\ntest:\n\t./test.sh\n')
      writeFileSync(join(dir, 'main.c'), 'int main(void) { return 0; }\n')
      writeFileSync(join(dir, 'test.c'), '#include <assert.h>\nint main(void) { assert(1); return 0; }\n')
      const f = findFinding(auditDir(dir), 'TEST')
      assert.notEqual(f.status, 'na', f.detail)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('a CMakeLists tree is still judged, for the same reason', () => {
    const dir = mkdtempSync(join(tmpdir(), 'anvil-cmake-'))
    try {
      writeFileSync(join(dir, 'CMakeLists.txt'), 'cmake_minimum_required(VERSION 3.20)\nproject(x)\n')
      writeFileSync(join(dir, 'main.cpp'), 'int main() { return 0; }\n')
      writeFileSync(join(dir, 'test.cpp'), 'int main() { return 0; }\n')
      const f = findFinding(auditDir(dir), 'BUILD')
      assert.notEqual(f.status, 'na', f.detail)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('the guard stays narrow: a missing test command is still a blocker when a stack was found', () => {
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

describe('a governance file full of placeholders is not governance', () => {
  // Both of these rules checked only that the file *existed*. So a template of placeholders
  // scored as configured -- the most reassuring kind of wrong -- and this repository was
  // congratulating itself for two files that route and receive nothing.
  function repoWith(files: Record<string, string>): string {
    const dir = mkdtempSync(join(tmpdir(), 'anvil-gov-'))
    for (const [rel, content] of Object.entries(files)) {
      const target = join(dir, ...rel.split('/'))
      mkdirSync(dirname(target), { recursive: true })
      writeFileSync(target, content, 'utf8')
    }
    return dir
  }

  function findingOf(files: Record<string, string>, id: string) {
    const dir = repoWith(files)
    try {
      return findFinding(auditDir(dir), id)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }

  test('a CODEOWNERS of placeholders warns, and names them', () => {
    const f = findingOf({ CODEOWNERS: '*  @TODO-OWNER-default\n' }, 'CODEOWNERS')
    assert.equal(f.status, 'warn')
    assert.match(f.detail, /placeholder/)
    assert.match(f.detail, /@TODO-OWNER-default/)
  })

  test('a CODEOWNERS of real handles passes, and says who they are', () => {
    const f = findingOf({ CODEOWNERS: '*  @acme/owners\npackages/core/  @alice\n' }, 'CODEOWNERS')
    assert.equal(f.status, 'pass')
    assert.match(f.detail, /@acme\/owners/)
  })

  test('a partly-placeholder CODEOWNERS warns about only the placeholders', () => {
    const f = findingOf({ CODEOWNERS: '*  @acme/owners\npackages/core/  @FIXME-core\n' }, 'CODEOWNERS')
    assert.equal(f.status, 'warn')
    assert.match(f.detail, /@FIXME-core/)
    assert.ok(!f.detail.includes('@acme/owners'), 'a real owner must not be named as a problem')
  })

  test('a CODEOWNERS with no handles at all says it routes nothing', () => {
    const f = findingOf({ CODEOWNERS: '# owners go here\n\n' }, 'CODEOWNERS')
    assert.equal(f.status, 'warn')
    assert.match(f.detail, /routes nothing/)
  })

  test('a bare owner is reported as unresolvable, not as a comment', () => {
    // GitHub accepts @user, @org/team-name or an email. A bare `org/team` routes nothing --
    // but it is a line with an owner on it, so "every line is a comment or blank" was a false
    // sentence about a real file.
    const f = findingOf({ CODEOWNERS: '*  acme/platform-team\n' }, 'CODEOWNERS')
    assert.equal(f.status, 'warn')
    assert.match(f.detail, /cannot resolve/)
    assert.match(f.detail, /acme\/platform-team/)
    assert.ok(!/comment or blank/.test(f.detail))
  })

  test('an email address is a real owner, not an invisible one', () => {
    const f = findingOf({ CODEOWNERS: '*  security@acme.io\n' }, 'CODEOWNERS')
    assert.equal(f.status, 'pass', f.detail)
    assert.match(f.detail, /security@acme\.io/)
  })

  test('the pass detail counts distinct owners, not assignments', () => {
    // Five rules naming the same team is one owner, and "5 owner handle(s): @acme/owners" is
    // two numbers describing different things.
    const f = findingOf({ CODEOWNERS: '*.ts  @acme/owners\n*.js  @acme/owners\n*.md  @acme/owners\n' }, 'CODEOWNERS')
    assert.equal(f.status, 'pass', f.detail)
    assert.match(f.detail, /1 distinct owner\(s\) across 3 rule\(s\)/)
  })

  test('a real handle is not mistaken for a placeholder', () => {
    // The expensive error here is flagging a real owner, because it teaches people to ignore
    // the rule. Matching is per hyphen/slash segment for exactly this reason: a substring test
    // flagged `@todoist-team` and `@XXXcorp`, which are real handles.
    for (const handle of [
      '@acme/platform-team',
      '@myorg/core',
      '@the-owner',
      '@nodejs',
      '@todoist-team',
      '@XXXcorp',
      '@acme/replace-service',
    ]) {
      const f = findingOf({ CODEOWNERS: `*  ${handle}\n` }, 'CODEOWNERS')
      assert.equal(f.status, 'pass', `${handle} was flagged: ${f.detail}`)
    }
  })

  test('a SECURITY.md with a placeholder address warns', () => {
    const f = findingOf({ 'SECURITY.md': 'Report to security@example.invalid\n' }, 'SECURITY_MD')
    // `.invalid` is reserved by RFC 2606 precisely so it can never be a real mailbox.
    assert.equal(f.status, 'warn')
    assert.match(f.detail, /example\.invalid/)
  })

  test('a SECURITY.md with no address at all warns', () => {
    const f = findingOf({ 'SECURITY.md': '# Security policy\n\nOpen an issue.\n' }, 'SECURITY_MD')
    assert.equal(f.status, 'warn')
    assert.match(f.detail, /no contact address/)
  })

  test('a SECURITY.md with a real address passes', () => {
    const f = findingOf({ 'SECURITY.md': 'Email security@acme.io\n' }, 'SECURITY_MD')
    assert.equal(f.status, 'pass')
    assert.match(f.detail, /security@acme\.io/)
  })

  test('a private reporting channel counts, because it is a monitored channel', () => {
    // GitHub's own SECURITY.md template points at the private advisories page, and that page
    // is monitored by construction. Calling that "nowhere to report a vulnerability" is a
    // claim about the world that no regex can support.
    const f = findingOf(
      {
        'SECURITY.md':
          '# Security policy\n\nReport a vulnerability privately through the repository Security Advisories page:\nhttps://github.com/acme/x/security/advisories/new\n',
      },
      'SECURITY_MD',
    )
    assert.equal(f.status, 'pass', f.detail)
    assert.match(f.detail, /private reporting channel/)
  })

  test('a placeholder word in a real address domain is not a finding', () => {
    // Placeholder matching is on the local part only; a company that happens to be called
    // "Replace Me Inc" is not a placeholder contact.
    const f = findingOf({ 'SECURITY.md': 'Report to security@replace-me.example.com\n' }, 'SECURITY_MD')
    assert.equal(f.status, 'pass', f.detail)
  })
})

describe('a bzlmod Bazel tree is a known ecosystem, not an unknown one', () => {
  test('a MODULE.bazel repository is offered Bazel commands, and no fake fast subset', () => {
    const dir = mkdtempSync(join(tmpdir(), 'anvil-bazel-'))
    try {
      writeFileSync(join(dir, 'MODULE.bazel'), 'module(name = "rules", version = "1.0")\n')
      writeFileSync(join(dir, 'BUILD.bazel'), '\n')
      const p = buildProfile(dir, { ...VCS, root: dir }).profile
      assert.ok(p.stacks.some((s) => s.id === 'bazel'))
      assert.equal(p.commands.test?.[0]?.cmd, 'bazel test //...')
      // `bazel query` lists test targets without running one, so a verify command that cannot
      // fail on broken code must not be offered as the fast path. Bazel's own test cache is
      // what makes the full suite cheap, and `TEST_FAST` warns about the absence.
      assert.equal(p.commands.testFast, undefined)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('a declared dependency is detected wherever it is declared', () => {
  // Two bugs in one place, both invisible until a dependency was not on line 1.
  //
  // The framework table was anchored with `^` and no `m` flag, which means "the file begins
  // with django" -- so `dependencies = ["django>=4.2.7"]` on line 4 of a pyproject.toml
  // detected no framework at all. And the version regex was written with single backslashes
  // inside a template literal, where `\s` cooks to the letter `s` and `\]` cooks to `]`, so
  // the character class excluded `s` and then demanded a literal `]`: every real version
  // failed to capture, and `looseVersion` then discarded the truncated remainder.
  function profileOfFiles(files: Record<string, string>) {
    const dir = mkdtempSync(join(tmpdir(), 'anvil-deps-'))
    try {
      for (const [rel, content] of Object.entries(files)) {
        const target = join(dir, ...rel.split('/'))
        mkdirSync(dirname(target), { recursive: true })
        writeFileSync(target, content, 'utf8')
      }
      return buildProfile(dir, { ...VCS, root: dir }).profile
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }

  test('a PEP 621 dependency array is read, with its version', () => {
    const p = profileOfFiles({
      'pyproject.toml': '[project]\nname = "x"\ndependencies = ["django>=4.2.7", "requests"]\n',
      'app/main.py': 'x = 1\n',
      'tests/test_x.py': 'def test_x():\n    pass\n',
    })
    const django = p.stacks.find((s) => s.id === 'django')
    assert.ok(django !== undefined, `expected a django stack, got ${p.stacks.map((s) => s.id).join(', ')}`)
    assert.equal(django.version, '4.2.7')
  })

  test('a requirements file is read, with its version', () => {
    const p = profileOfFiles({
      'requirements.txt': 'flask==3.0.2\nrequests>=2.31.0\n',
      'app.py': 'x = 1\n',
      'test_app.py': 'def test_x():\n    pass\n',
    })
    assert.equal(p.stacks.find((s) => s.id === 'flask')?.version, '3.0.2')
  })

  test('the evidence names the line the dependency is on', () => {
    const p = profileOfFiles({
      'pyproject.toml': '[project]\nname = "x"\ndependencies = ["django>=4.2.7"]\n',
      'app/main.py': 'x = 1\n',
    })
    assert.deepEqual(p.stacks.find((s) => s.id === 'django')?.evidence, ['pyproject.toml:3'])
  })
})

describe('an install command is one that can be run', () => {
  function profileOfFiles(files: Record<string, string>) {
    const dir = mkdtempSync(join(tmpdir(), 'anvil-install-'))
    try {
      for (const [rel, content] of Object.entries(files)) {
        const target = join(dir, ...rel.split('/'))
        mkdirSync(dirname(target), { recursive: true })
        writeFileSync(target, content, 'utf8')
      }
      return buildProfile(dir, { ...VCS, root: dir }).profile
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }

  test('Gradle gets no install command, because there is no install step', () => {
    // The one command that looks like an install rewrites `gradle.lockfile`, and it was being
    // emitted as the install step of a real repository, labelled `detected`.
    const p = profileOfFiles({
      'build.gradle.kts': 'plugins { kotlin("jvm") version "2.0.0" }\n',
      'gradle.lockfile': 'x=1\n',
      'src/main/kotlin/A.kt': 'class A\n',
    })
    assert.equal(p.commands.install, undefined)
  })

  test('Yarn Berry gets --immutable, not the Yarn 1 flag it rejects', () => {
    const berry = profileOfFiles({
      'package.json': '{"name":"x","version":"1.0.0","packageManager":"yarn@4.1.0"}\n',
      'yarn.lock': '__metadata:\n  version: 8\n  cacheKey: 10\n',
      'index.js': 'export const x = 1\n',
    })
    assert.equal(berry.commands.install?.[0]?.cmd, 'yarn install --immutable')

    const classic = profileOfFiles({
      'package.json': '{"name":"x","version":"1.0.0"}\n',
      'yarn.lock': '# yarn lockfile v1\n',
      'index.js': 'export const x = 1\n',
    })
    assert.equal(classic.commands.install?.[0]?.cmd, 'yarn install --frozen-lockfile')
  })

  test('npm ci is only claimed where a lockfile exists', () => {
    const withLock = profileOfFiles({
      'package.json': '{"name":"x","version":"1.0.0"}\n',
      'package-lock.json': '{"lockfileVersion":3}\n',
      'index.js': 'export const x = 1\n',
    })
    assert.equal(withLock.commands.install?.[0]?.cmd, 'npm ci')
    assert.equal(withLock.commands.install?.[0]?.source, 'detected')

    const without = profileOfFiles({
      'package.json': '{"name":"x","version":"1.0.0"}\n',
      'index.js': 'export const x = 1\n',
    })
    assert.equal(without.commands.install?.[0]?.cmd, 'npm install')
    assert.equal(without.commands.install?.[0]?.source, 'inferred')
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

  /**
   * The bug, found by auditing terraform-aws-modules/terraform-aws-vpc: a Terraform module
   * reported *no commands at all*, so the generated AGENTS.md had nothing to verify a change
   * with. There is no build and no test suite in Terraform, which is true, and it is also
   * true that `terraform fmt -check` answers the question an agent actually has.
   *
   * `terraform validate` is deliberately absent from this assertion's neighbourhood: on a
   * module that has not been `init`ed it fails with "Module not installed", and choosing
   * providers and a backend belongs to whoever owns the account.
   */
  test('a Terraform repo gets the check that runs without an init', () => {
    const p = profileOf('terraform-infra')
    assert.equal(p.commands.format?.[0]?.cmd, 'terraform fmt -check -recursive')
    assert.equal(p.commands.format?.[0]?.source, 'inferred')
    // No invented suite: an agent must not be handed a `terraform test` that does not exist.
    assert.equal(p.commands.test, undefined)
    assert.equal(p.commands.build, undefined)
  })

  test('tflint is only offered where the repository configures it', () => {
    const bare = profileOf('terraform-infra')
    assert.equal(bare.commands.lint, undefined)

    const dir = mkdtempSync(join(tmpdir(), 'anvil-tflint-'))
    try {
      writeFileSync(join(dir, 'main.tf'), 'terraform {\n  required_version = ">= 1.7"\n}\n')
      writeFileSync(join(dir, '.tflint.hcl'), 'config {\n  call_module_type = "local"\n}\n')
      const p = buildProfile(dir, { ...VCS, root: dir }).profile
      assert.equal(p.commands.lint?.[0]?.cmd, 'tflint')
      assert.equal(p.commands.lint?.[0]?.source, 'detected')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
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

  test('a Playwright config is a runner even when a package script is primary', () => {
    const dir = mkdtempSync(join(tmpdir(), 'anvil-browser-'))
    try {
      writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'polyglot', scripts: { test: 'node --test' } }))
      writeFileSync(join(dir, 'playwright.config.ts'), 'export default {}\n')
      mkdirSync(join(dir, 'src'), { recursive: true })
      writeFileSync(join(dir, 'src', 'app.ts'), 'export const app = 1\n')

      const profile = buildProfile(dir, { ...VCS, root: dir }).profile
      const tests = profile.commands.test ?? []
      assert.equal(tests[0]?.cmd, 'npm run test', 'the repository script stays primary')
      assert.ok(
        tests.some((c) => c.cmd === 'npx playwright test' && c.evidence === 'playwright.config.ts'),
        'the browser suite must be visible as a candidate',
      )
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('detector count reaches twenty-two', () => {
    // Thirteen, plus the browser-test detector, plus Android and Kotlin Multiplatform, plus the
    // three mobile frameworks (Flutter, React Native/Expo, .NET MAUI), plus C/C++, plus Shell and
    // PowerShell. The `Set` also asserts every id is unique: two detectors sharing an id would
    // silently shadow one another.
    const ids = new Set([...ecosystemDetectors, ...additionalDetectors].map((d) => d.id))
    assert.equal(ids.size, 22)
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
