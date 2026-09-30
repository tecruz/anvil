/**
 * Repo walking.
 *
 * The walk is what every detector sees, so what it skips is as load-bearing as what it
 * finds. Both skip lists were once derived from a bug found by pointing anvil at itself:
 * it reported `vue`, `dotnet` and `terraform` for a TypeScript CLI, because its own
 * `fixtures/` tree is a set of miniature repositories that exist to be detected.
 */

import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { after, describe, test } from 'node:test'

import { buildProfile, SKIP_DIRS, SKIP_TEST_DATA_DIRS, walkFiles } from '@anvil/profile'

const temps: string[] = []
after(() => {
  for (const t of temps) rmSync(t, { recursive: true, force: true })
})

function repo(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'anvil-walk-'))
  temps.push(dir)
  for (const [rel, content] of Object.entries(files)) {
    const target = join(dir, ...rel.split('/'))
    mkdirSync(dirname(target), { recursive: true })
    writeFileSync(target, content, 'utf8')
  }
  return dir
}

const VCS = { root: '', host: null, remote: null, defaultBranch: null }

describe('walkFiles', () => {
  test('skips build output', () => {
    const dir = repo({
      'package.json': '{}',
      'dist/app.js': 'x',
      'node_modules/dep/index.js': 'x',
      'target/classes/A.class': 'x',
    })
    const { files } = walkFiles(dir)
    assert.ok(files.includes('package.json'))
    assert.ok(!files.some((f) => f.startsWith('dist/')))
    assert.ok(!files.some((f) => f.startsWith('node_modules/')))
    assert.ok(!files.some((f) => f.startsWith('target/')))
  })

  test('skips test-data directories, so their stacks are not attributed to the repo', () => {
    // The bug, reduced: a fixtures tree containing a Vue app must not make the host repo
    // a Vue project. A fabricated stack is worse than a missing one, because the reader
    // has no reason to check.
    const dir = repo({
      'package.json': '{"name":"host"}',
      'fixtures/frontend-vue/src/App.vue': '<template></template>',
      'fixtures/dotnet-sln/src/Api/Api.csproj': '<Project />',
      'fixtures/terraform-infra/main.tf': 'provider "aws" {}',
    })
    const { files } = walkFiles(dir)
    assert.ok(files.includes('package.json'))
    assert.equal(files.filter((f) => f.startsWith('fixtures/')).length, 0, 'fixture files must not be walked')
  })

  test('skips the conventional spellings of test data', () => {
    for (const name of SKIP_TEST_DATA_DIRS) {
      const dir = repo({
        'package.json': '{}',
        [`${name}/thing.csproj`]: '<Project />',
      })
      const { files } = walkFiles(dir)
      assert.ok(!files.some((f) => f.startsWith(`${name}/`)), `${name}/ should not be walked`)
    }
  })

  test('still walks hidden directories a detector needs', () => {
    const dir = repo({
      '.github/workflows/ci.yml': 'on: push',
      'package.json': '{}',
    })
    const { files } = walkFiles(dir)
    assert.ok(files.includes('.github/workflows/ci.yml'), 'CI workflows are evidence for CI_PARITY')
  })

  test('followDirs overrides the skip lists, for source kept in a skipped name', () => {
    const dir = repo({ 'package.json': '{}', 'dist/src/app.ts': 'export {}' })
    assert.ok(!walkFiles(dir).files.some((f) => f.startsWith('dist/')))
    const followed = walkFiles(dir, { followDirs: new Set(['dist']) })
    assert.ok(followed.files.some((f) => f.startsWith('dist/')))
  })

  test('extraSkipDirs removes a directory the defaults keep', () => {
    const dir = repo({
      'package.json': '{}',
      'tools/thing.csproj': '<Project />',
    })
    assert.ok(walkFiles(dir).files.some((f) => f.startsWith('tools/')))
    const skipped = walkFiles(dir, { extraSkipDirs: new Set(['tools']) })
    assert.ok(!skipped.files.some((f) => f.startsWith('tools/')))
  })
})

describe('buildProfile does not detect stacks that only exist in fixtures', () => {
  test('a host repo is not a Vue, .NET or Terraform project because its fixtures are', () => {
    // Found by running anvil on its own repository: it claimed three stacks it does not
    // have, and offered `dotnet test` as a verify command to run.
    const dir = repo({
      'package.json': JSON.stringify({
        name: 'host',
        devDependencies: { typescript: '^5.9.0' },
      }),
      'packages/app/src/index.ts': 'export const x = 1\n',
      'fixtures/frontend-vue/src/App.vue': '<template></template>',
      'fixtures/frontend-vue/package.json': '{"dependencies":{"vue":"^3"}}',
      'fixtures/dotnet-sln/src/Api/Api.csproj': '<Project Sdk="Microsoft.NET.Sdk" />',
      'fixtures/terraform-infra/main.tf': 'provider "aws" {\n  region = "us-east-1"\n}\n',
    })
    const { profile } = buildProfile(dir, { ...VCS, root: dir })
    const ids = profile.stacks.map((s) => s.id)
    assert.deepEqual(ids.sort(), ['node', 'typescript'], `unexpected stacks: ${ids.join(', ')}`)

    // And the consequence that actually misled a reader: no .NET verify command.
    const cmds = Object.values(profile.commands)
      .flat()
      .map((c) => c.cmd)
      .join(' ')
    assert.ok(!/dotnet/.test(cmds), `no dotnet command should be offered, got: ${cmds}`)
  })
})

describe('a workspace member can supply the command the root has no script for', () => {
  // Found by auditing shaped repositories: a workspace whose tests live only in its
  // members reported no test command and failed TEST as a *blocker* on a repository whose
  // tests run perfectly well.
  const commandsOf = (files: Record<string, string>) => {
    const dir = repo(files)
    return buildProfile(dir, { root: dir, host: null, remote: null, defaultBranch: null }).profile.commands
  }

  test('a member script becomes a runnable command from the repository root', () => {
    const member = ['{', '  "name": "@platform/api",', '  "scripts": { "test": "vitest run" }', '}'].join('\n')
    const c = commandsOf({
      'package.json': '{ "name": "platform", "workspaces": ["services/*"] }',
      'services/api/package.json': member,
      'services/api/src/a.test.ts': "test('a', () => {})\n",
    })
    const test = c.test?.[0]
    // Not `vitest run`: the runner is hoisted to the root's node_modules and is only on
    // PATH inside a package-manager script, so the bare form does not resolve.
    assert.equal(test?.cmd, 'npm run test --workspace @platform/api')
    // The line matters: it is what makes the evidence checkable rather than decorative.
    assert.equal(test?.evidence, 'services/api/package.json:3')
  })

  test('a lockfile picks the manager whose workspace syntax is correct', () => {
    const pnpm = commandsOf({
      'package.json': '{ "name": "platform", "workspaces": ["packages/*"] }',
      'pnpm-lock.yaml': "lockfileVersion: '9.0'\n",
      'packages/core/package.json': '{ "name": "@p/core", "scripts": { "test": "vitest run" } }',
    })
    assert.equal(pnpm.test?.[0]?.cmd, 'pnpm --filter @p/core run test')
    assert.equal(pnpm.test?.[0]?.source, 'detected')

    const yarn = commandsOf({
      'package.json': '{ "name": "platform", "workspaces": ["packages/*"] }',
      'yarn.lock': '\n',
      'packages/core/package.json': '{ "name": "@p/core", "scripts": { "test": "vitest run" } }',
    })
    assert.equal(yarn.test?.[0]?.cmd, 'yarn workspace @p/core run test')
  })

  test('the root script wins, and the member form is not offered as well', () => {
    // Two commands for `test` would read as "run both", which is not true.
    const c = commandsOf({
      'package.json': '{ "name": "platform", "scripts": { "test": "vitest run" }, "workspaces": ["services/*"] }',
      'services/api/package.json': '{ "name": "@platform/api", "scripts": { "test": "jest" } }',
    })
    assert.deepEqual(
      c.test?.map((e) => e.cmd),
      ['npm run test'],
    )
  })

  test('a member with no manager hint is inferred, not claimed', () => {
    // `workspaces` is npm's own field and yarn and pnpm both require a lockfile that the
    // lockfile check would have found, so this is npm -- and the command says `inferred`
    // rather than pretending it was read off a lockfile.
    const c = commandsOf({
      'package.json': '{ "name": "platform", "workspaces": ["packages/*"] }',
      'packages/core/package.json': '{ "name": "@p/core", "scripts": { "test": "vitest run" } }',
    })
    assert.equal(c.test?.[0]?.cmd, 'npm run test --workspace @p/core')
    assert.equal(c.test?.[0]?.source, 'inferred')
  })
})

describe('a bzlmod Bazel tree is understood', () => {
  // A MODULE.bazel tree with no WORKSPACE scored 22/100 and failed TEST as a blocker,
  // because Bazel was simply not a stack anvil knew about.
  const profileOf = (files: Record<string, string>) => {
    const dir = repo(files)
    return buildProfile(dir, { root: dir, host: null, remote: null, defaultBranch: null }).profile
  }

  test('MODULE.bazel alone identifies Bazel', () => {
    const p = profileOf({ 'MODULE.bazel': 'module(name = "rules", version = "1.0")\n', 'BUILD.bazel': '\n' })
    assert.ok(p.stacks.some((s) => s.id === 'bazel'))
    assert.equal(p.commands.build?.[0]?.cmd, 'bazel build //...')
    assert.equal(p.commands.test?.[0]?.cmd, 'bazel test //...')
    assert.equal(p.commands.build?.[0]?.evidence, 'MODULE.bazel')
  })

  test('a BUILD file in a subdirectory is still evidence of Bazel', () => {
    const p = profileOf({ 'tests/BUILD.bazel': 'my_test(name = "smoke")\n' })
    assert.ok(p.stacks.some((s) => s.id === 'bazel'))
    assert.equal(p.commands.build?.[0]?.evidence, 'tests/BUILD.bazel')
  })

  test('no install command, because Bazel fetches its own dependencies', () => {
    const p = profileOf({ 'MODULE.bazel': 'module(name = "rules")\n' })
    assert.equal(p.commands.install, undefined)
  })
})

describe('a project that does not live at the repository root is found', () => {
  // A Rust crate under `engine/` -- manifest, sources and tests all in the subdirectory --
  // produced no stack, no commands, and a TEST blocker claiming the tests could not be run.
  // They run `cargo test`. The reason it was left broken rather than patched is worth
  // recording: every detector's evidence is a root-relative path, so detecting the crate
  // while citing `Cargo.toml` would produce evidence pointing at a file that is not there.
  // Detection and evidence had to be resolved by the same rule, or neither could be trusted.
  const crate = {
    'README.md': '# host\n',
    'engine/Cargo.toml': '[package]\nname = "engine"\nversion = "0.1.0"\n',
    'engine/Cargo.lock': 'version = 3\n',
    'engine/src/lib.rs': 'pub fn go() {}\n',
    'engine/tests/it.rs': '#[test]\nfn t() {}\n',
  }
  const profileOf = (files: Record<string, string>) => {
    const dir = repo(files)
    return buildProfile(dir, { root: dir, host: null, remote: null, defaultBranch: null }).profile
  }

  test('the stack is detected, and the evidence names the file that exists', () => {
    const p = profileOf(crate)
    const rust = p.stacks.find((s) => s.id === 'rust')
    assert.ok(rust, 'rust should be detected from engine/Cargo.toml')
    // Not `Cargo.toml`: that file does not exist in this repository, and an evidence path
    // that names a missing file cannot be checked by whoever reads the finding.
    assert.equal(rust.evidence[0], 'engine/Cargo.toml:1')
  })

  test('the commands come with resolved evidence too', () => {
    const p = profileOf(crate)
    assert.equal(p.commands.test?.[0]?.cmd, 'cargo test')
    assert.equal(p.commands.install?.[0]?.cmd, 'cargo fetch --locked')
    assert.equal(p.commands.install?.[0]?.evidence, 'engine/Cargo.lock')
  })

  test('evidence that already names a root file is left alone', () => {
    // The project is in `engine/`, but the README is still at the root, and rewriting it to
    // `engine/README.md` would be a new wrong answer.
    assert.equal(profileOf(crate).docs.readme, 'README.md')
  })

  test('a repository whose manifest is at the root resolves to itself', () => {
    // The identity case, and the reason the ten audited repositories are unaffected.
    const p = profileOf({ 'Cargo.toml': '[package]\nname = "x"\n', 'src/lib.rs': 'pub fn go() {}\n' })
    assert.equal(p.stacks.find((s) => s.id === 'rust')?.evidence[0], 'Cargo.toml:1')
  })

  test('two projects in two subdirectories resolve to neither', () => {
    // A tree with `svc/go.mod` and `web/package.json` has two projects. Reporting either
    // one would be confidently wrong about the other, so nothing is resolved -- which is
    // the previous behaviour, and the honest one.
    const p = profileOf({
      'svc/go.mod': 'module example.com/svc\ngo 1.22\n',
      'svc/main.go': 'package main\n',
      'web/package.json': '{ "name": "web" }',
      'web/src/main.ts': 'export const w = 1\n',
    })
    assert.equal(p.stacks.length, 0)
  })

  test('a single package in a subdirectory is the project', () => {
    // The root holds no manifest and exactly one directory does, so the project is
    // `services/api`. The command is written the way npm writes it -- relative to the
    // project, not to wherever the reader is standing -- which is why the profile also
    // records `projectDir` for whoever consumes the command.
    const p = profileOf({
      'services/api/package.json': '{ "name": "@platform/api", "scripts": { "test": "vitest run" } }',
      'services/api/src/a.test.ts': "test('a', () => {})\n",
    })
    assert.equal(p.projectDir, 'services/api')
    assert.equal(p.commands.test?.[0]?.cmd, 'npm run test')
    assert.equal(p.commands.test?.[0]?.evidence, 'services/api/package.json:1')
  })

  test('a lockfile alone does not make a directory the project', () => {
    // `engine/Cargo.lock` is not a manifest. Treating one as a project descriptor would let
    // a vendored lockfile in a fixture decide where the project is.
    const p = profileOf({
      'README.md': '# host\n',
      'engine/Cargo.lock': 'version = 3\n',
      'engine/src/lib.rs': 'pub fn go() {}\n',
    })
    assert.equal(p.stacks.length, 0)
  })

  test('a project at the root records no project directory', () => {
    assert.equal(profileOf({ 'Cargo.toml': '[package]\nname = "x"\n' }).projectDir, '')
  })
})

describe('the install command is derived from the lockfile', () => {
  // Ten real repositories, every one of which reported "no documented dependency-install
  // command": nothing ever emitted an `install` command, even though the kind existed in
  // the type and the generated AGENTS.md had a row for it.
  const installOf = (files: Record<string, string>) => {
    const dir = repo(files)
    return buildProfile(dir, { root: dir, host: null, remote: null, defaultBranch: null }).profile.commands.install?.[0]
  }

  test('a lockfile names the manager and is labelled detected', () => {
    const npm = installOf({ 'package.json': '{}', 'package-lock.json': '{}' })
    assert.equal(npm?.cmd, 'npm ci')
    assert.equal(npm?.source, 'detected')
    assert.equal(npm?.evidence, 'package-lock.json')

    assert.equal(installOf({ 'pnpm-lock.yaml': '', 'package.json': '{}' })?.cmd, 'pnpm install --frozen-lockfile')
    assert.equal(installOf({ 'uv.lock': '', 'pyproject.toml': '' })?.cmd, 'uv sync --frozen')
    assert.equal(installOf({ 'Cargo.lock': '', 'Cargo.toml': '' })?.cmd, 'cargo fetch --locked')
  })

  test('a lockfile wins over the manifest it belongs to', () => {
    const entry = installOf({ 'package.json': '{}', 'package-lock.json': '{}', 'composer.json': '{}' })
    assert.equal(entry?.cmd, 'npm ci')
  })

  test('without a lockfile the install is the non-reproducible form, and inferred', () => {
    // `npm ci` requires a lockfile and fails without one. Recommending it anyway would be
    // the first command a new contributor types, and it would fail.
    const npm = installOf({ 'package.json': '{}' })
    assert.equal(npm?.cmd, 'npm install')
    assert.equal(npm?.source, 'inferred')
  })

  test('a Go project has no install step, and is not given one', () => {
    // `go.sum` proves the module graph, not a command a newcomer should type.
    const go = installOf({ 'go.mod': 'module x', 'go.sum': '' })
    assert.equal(go, undefined)
  })
})

describe('the skip lists do not overlap', () => {
  test('a name is either build output or test data, not both', () => {
    for (const name of SKIP_TEST_DATA_DIRS) {
      assert.ok(!SKIP_DIRS.has(name), `${name} appears in both skip lists`)
    }
  })
})
