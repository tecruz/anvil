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

describe('the skip lists do not overlap', () => {
  test('a name is either build output or test data, not both', () => {
    for (const name of SKIP_TEST_DATA_DIRS) {
      assert.ok(!SKIP_DIRS.has(name), `${name} appears in both skip lists`)
    }
  })
})
