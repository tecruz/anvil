/**
 * Regression tests for `npm run test:changed` selection.
 *
 * The command is what an agent runs while iterating, so a change that silently selects
 * nothing is a green result that verified nothing. These cases pin the two ways that can
 * happen: a suite under `scripts/test/` has no package to hang off, and a change to the
 * module it covers must still run it.
 */

import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { after, describe, test } from 'node:test'
import { fileURLToPath } from 'node:url'

import {
  affectedPackages,
  allRootTests,
  changedFiles,
  porcelainPaths,
  readGraph,
  rootTestsFor,
  testFilesForSelection,
} from '../test-changed.ts'

const ROOT = resolve(fileURLToPath(new URL('../../', import.meta.url)))
const graph = readGraph(ROOT)
const CHECKER_SUITE = join(ROOT, 'scripts', 'test', 'check-mcp-handshake.test.ts')
const SELECTOR_SUITE = join(ROOT, 'scripts', 'test', 'test-changed.test.ts')
const EVAL_SUITE = join(ROOT, 'scripts', 'test', 'eval-run.test.ts')
const EVAL_EVIDENCE_SUITE = join(ROOT, 'scripts', 'test', 'eval-execution-evidence.test.ts')
const EVAL_RESUME_SUITE = join(ROOT, 'scripts', 'test', 'eval-resume.test.ts')

const temps: string[] = []
after(() => {
  for (const dir of temps) rmSync(dir, { recursive: true, force: true })
})

/** A throwaway repository with exactly the files a selection test needs. */
function fixtureRoot(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'anvil-selector-test-'))
  temps.push(root)
  for (const [path, content] of Object.entries(files)) {
    const absolute = join(root, ...path.split('/'))
    mkdirSync(dirname(absolute), { recursive: true })
    writeFileSync(absolute, content, 'utf8')
  }
  return root
}

function selection(files: string[]): string[] {
  return testFilesForSelection(affectedPackages(files, graph, ROOT), rootTestsFor(files, ROOT), graph, ROOT)
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync(
    'git',
    ['-c', 'user.email=selector@anvil.test', '-c', 'user.name=anvil selector', '-c', 'commit.gpgsign=false', ...args],
    { cwd, encoding: 'utf8' },
  )
}

/** A throwaway repository with one commit, so `changedFiles` has a real history to read. */
function gitFixture(files: Record<string, string>): string {
  const root = fixtureRoot(files)
  git(root, 'init', '--initial-branch=main')
  git(root, 'add', '--all')
  git(root, 'commit', '-m', 'initial')
  return root
}

describe('changed-file parsing', () => {
  test('a rename keeps the path it deleted', () => {
    // `--porcelain -z` emits `XY <new-path>\0<old-path>\0`, and the old path has no status
    // columns of its own. Slicing three characters off it produced a phantom path.
    assert.deepEqual(porcelainPaths('R  scripts/new.ts\0scripts/old.ts\0'), ['scripts/new.ts', 'scripts/old.ts'])
  })

  test('a type change is a path, not the whole record', () => {
    // `T` (regular file <-> symlink) was missing from the status class, so the stored path
    // was literally `T  scripts/a.ts` and the file was never selected.
    assert.deepEqual(porcelainPaths('T  scripts/a.ts\0'), ['scripts/a.ts'])
  })

  test('a committed rename still selects the suite that imports the old path', () => {
    // `git diff --name-only` reports only the new path of a rename, so the deleted path
    // never reached the selector and the suite that still imports it did not run.
    const root = gitFixture({
      'scripts/old.ts': 'export const value = 1\n',
      'scripts/test/uses-old.test.ts': "import { value } from '../old.ts'\nexport const x = value\n",
    })
    git(root, 'mv', 'scripts/old.ts', 'scripts/new.ts')
    git(root, 'commit', '-m', 'rename')

    const changed = changedFiles('HEAD~1', root)
    assert.ok(changed.includes('scripts/old.ts'), 'the path the rename deleted is part of the change')
    assert.ok(changed.includes('scripts/new.ts'))
    assert.deepEqual(rootTestsFor(changed, root), ['scripts/test/uses-old.test.ts'])
  })

  test('an untracked directory is expanded to the suites inside it', () => {
    // `git status --porcelain` collapses a new directory to one record, `?? scripts/test/new/`,
    // and no suite is named that. A suite added in a new subdirectory -- which `allRootTests`
    // enumerates recursively -- was discovered and then never selected.
    const root = gitFixture({ 'scripts/test/existing.test.ts': 'export const x = 1\n' })
    mkdirSync(join(root, 'scripts', 'test', 'nested'), { recursive: true })
    writeFileSync(join(root, 'scripts', 'test', 'nested', 'new.test.ts'), 'export const y = 1\n')

    const changed = changedFiles(null, root)
    assert.ok(
      changed.includes('scripts/test/nested/new.test.ts'),
      `expected the file, not the directory, in ${JSON.stringify(changed)}`,
    )
    assert.deepEqual(rootTestsFor(changed, root), ['scripts/test/nested/new.test.ts'])
  })
})

describe('test:changed selection', () => {
  test('a change to the selector runs the suite that covers it', () => {
    assert.deepEqual(selection(['scripts/test-changed.ts']), [SELECTOR_SUITE])
  })

  test('a change to the selector suite itself runs it', () => {
    assert.deepEqual(selection(['scripts/test/test-changed.test.ts']), [SELECTOR_SUITE])
  })

  test('a full selection runs every suite under scripts/test', () => {
    const onDisk = readdirSync(join(ROOT, 'scripts', 'test'), { recursive: true, encoding: 'utf8' }).filter((file) =>
      file.endsWith('.test.ts'),
    )
    const full = testFilesForSelection(graph.packages, allRootTests(ROOT), graph, ROOT)
    for (const file of onDisk) assert.ok(full.includes(join(ROOT, 'scripts', 'test', file)), file)
  })

  test('a change to the handshake checker runs the suite that covers it', () => {
    assert.ok(selection(['scripts/check-mcp-handshake.ts']).includes(CHECKER_SUITE))
  })

  test('a change to an eval suite runs that suite', () => {
    assert.deepEqual(selection(['scripts/test/eval-run.test.ts']), [EVAL_SUITE])
  })

  test('a change to the eval harness runs every suite that imports or spawns it', () => {
    const files = selection(['scripts/eval.ts'])
    assert.ok(files.includes(EVAL_SUITE), 'the eval suites import the harness')
    assert.ok(files.includes(join(ROOT, 'scripts', 'test', 'eval-transcript.test.ts')))
    // These two run the harness as a subprocess and import nothing from it. A static scan
    // alone reported they were unaffected by a change to the file they execute.
    assert.ok(files.includes(EVAL_EVIDENCE_SUITE), 'a suite that spawns the harness depends on it')
    assert.ok(files.includes(EVAL_RESUME_SUITE), 'a suite that spawns the harness depends on it')
    assert.ok(!files.includes(CHECKER_SUITE), 'and nothing that does not')
  })

  test('a workspace package imported by name is resolved, including a subpath', () => {
    // `eval.ts` imports worktrees, which imports `@anvil/tickets/context`. A bare specifier
    // is not an external dependency; it points at `packages/tickets/src/context.ts`.
    assert.ok(selection(['packages/tickets/src/context.ts']).includes(EVAL_SUITE))
  })

  test('a change to a package module the eval suites import runs them too', () => {
    // These are the edges a hand-maintained trigger list missed: the suites import package
    // sources by path, so a change there selects the package's own tests but no root suite.
    for (const source of [
      'packages/core/src/exec.ts',
      'packages/core/src/args.ts',
      'packages/profile/src/index.ts',
      'packages/cli/src/eval-gate.ts',
    ]) {
      const files = selection([source])
      assert.ok(
        files.some((file) => file.endsWith('eval-extended-scenarios.test.ts')),
        `${source} must reach the eval suites`,
      )
    }
  })

  test('a module that nothing imports selects no root suite', () => {
    // The closure must not degrade into "any file under scripts/ runs every suite". A
    // throwaway repository is used so the assertion is about the algorithm, not about which
    // modules happen to be reachable in this checkout today.
    const root = fixtureRoot({
      'scripts/test/dependent.test.ts': "import { b } from '../b.ts'\nexport const value = b\n",
      'scripts/b.ts': 'export const b = 1\n',
      'scripts/c.ts': 'export const c = 2\n',
    })
    assert.deepEqual(rootTestsFor(['scripts/c.ts'], root), [])
  })

  test('a deleted module keeps the suites that depend on it', () => {
    // The file cannot be read, so its imports cannot be followed -- but the suites naming it
    // still have to run, or deleting a module silently verifies nothing.
    const root = fixtureRoot({
      'scripts/test/imported.test.ts': "import { x } from '../gone.ts'\nexport const y = x\n",
      'scripts/test/spawned.test.ts':
        "import { spawnSync } from 'node:child_process'\nspawnSync(process.execPath, ['scripts/harness.ts'])\n",
    })
    assert.deepEqual(rootTestsFor(['scripts/gone.ts'], root), ['scripts/test/imported.test.ts'])
    assert.deepEqual(rootTestsFor(['scripts/harness.ts'], root), ['scripts/test/spawned.test.ts'])
  })

  test('a comment that mentions a script is not a dependency', () => {
    // A doc comment explaining `spawnSync(node, ['scripts/eval.ts'])` is prose. Reading it as
    // code made this suite depend on the harness and run for every package change.
    const root = fixtureRoot({
      'scripts/test/commented.test.ts': "// spawnSync(node, ['scripts/other.ts'])\nexport const value = 1\n",
      'scripts/other.ts': 'export const other = 1\n',
    })
    assert.deepEqual(rootTestsFor(['scripts/other.ts'], root), [])
  })

  test('a regex literal is not mistaken for a comment', () => {
    // `/[/*]/` contains the characters that open a block comment. A hand-written scanner
    // swallowed the rest of the file and found no dependencies at all.
    const root = fixtureRoot({
      'scripts/test/regex.test.ts':
        "import { spawnSync } from 'node:child_process'\nconst globChars = /[/*]/\nspawnSync(process.execPath, ['scripts/harness.ts'])\n",
      'scripts/harness.ts': 'export const value = 1\n',
    })
    assert.deepEqual(rootTestsFor(['scripts/harness.ts'], root), ['scripts/test/regex.test.ts'])
  })

  test('a spawn call inside a string is not a dependency', () => {
    // A help message or a fixture that quotes the call is text, not execution.
    const root = fixtureRoot({
      'scripts/test/quoted.test.ts': 'export const help = "spawnSync(process.execPath, [\'scripts/harness.ts\'])"\n',
      'scripts/harness.ts': 'export const value = 1\n',
    })
    assert.deepEqual(rootTestsFor(['scripts/harness.ts'], root), [])
  })

  test('a subprocess call through an imported binding is a dependency', () => {
    // `cp.spawnSync(...)` runs the script just as a bare `spawnSync(...)` does. Recognizing
    // only bare identifier callees dropped namespace imports, default imports and aliased
    // named imports, and each selected no suite at all.
    const forms = [
      "import * as cp from 'node:child_process'\ncp.spawnSync(process.execPath, ['scripts/harness.ts'])\n",
      "import cp from 'node:child_process'\ncp.spawnSync(process.execPath, ['scripts/harness.ts'])\n",
      "import { spawnSync as run } from 'node:child_process'\nrun(process.execPath, ['scripts/harness.ts'])\n",
    ]
    for (const source of forms) {
      const root = fixtureRoot({
        'scripts/test/spawned.test.ts': source,
        'scripts/harness.ts': 'export const value = 1\n',
      })
      assert.deepEqual(rootTestsFor(['scripts/harness.ts'], root), ['scripts/test/spawned.test.ts'], source)
    }
  })

  test('a same-named method on another object is not a subprocess call', () => {
    // Only a binding imported from `node:child_process` is read as the builtin, so a helper
    // object with an `exec` method does not create a dependency on a script it names.
    const root = fixtureRoot({
      'scripts/test/runner.test.ts':
        "const runner = { exec: (_command: string): void => {} }\nrunner.exec('scripts/harness.ts')\nexport const value = 1\n",
      'scripts/harness.ts': 'export const value = 1\n',
    })
    assert.deepEqual(rootTestsFor(['scripts/harness.ts'], root), [])
  })

  test('a workspace manifest change reaches the suites that import the package', () => {
    // `exports` decides which file the specifier resolves to, so editing the manifest is a
    // change to every suite that imports the package -- not only to the resolved module.
    const root = fixtureRoot({
      'scripts/test/uses-package.test.ts': "import { value } from '@anvil/lib'\nexport const x = value\n",
      'packages/lib/package.json': JSON.stringify({ name: '@anvil/lib', exports: { '.': './src/entry.ts' } }),
      'packages/lib/src/entry.ts': 'export const value = 1\n',
    })
    assert.deepEqual(rootTestsFor(['packages/lib/package.json'], root), ['scripts/test/uses-package.test.ts'])
  })

  test('an import chain is followed transitively, not one level deep', () => {
    // `scripts/eval.ts` imports `eval-check-broker.ts`, and a suite imports the harness, so a
    // change to the broker must still reach that suite.
    assert.ok(selection(['scripts/eval-check-broker.ts']).includes(EVAL_SUITE))
  })

  test('a change to the scenario matrix runs the suites that read it', () => {
    assert.ok(selection(['eval/scenarios.json']).includes(EVAL_SUITE))
  })

  test('a deleted suite is not selected, because there is nothing to run', () => {
    assert.deepEqual(selection(['scripts/test/eval-removed.test.ts']), [])
  })

  test('a change to the root suite itself runs it', () => {
    assert.deepEqual(selection(['scripts/test/check-mcp-handshake.test.ts']), [CHECKER_SUITE])
  })

  test('a change to the Windows path form still matches', () => {
    assert.ok(selection(['scripts\\check-mcp-handshake.ts']).includes(CHECKER_SUITE))
  })

  test('a change to a CLI command selects every suite that drives the CLI end to end', () => {
    // The harness runs the CLI it is evaluating -- `anvil setup plan` and `anvil setup apply`
    // through `installScenarioSkill`, and `anvil init` for the derived context -- by spawning
    // `packages/cli/src/main.ts`. It assembles that path from segments, so no literal names
    // it and the import graph has no edge to the command surface. Declaring the edge on
    // `scripts/eval.ts` gives it to every suite that depends on the harness: one that imports
    // it, and the two that only spawn it as a subprocess.
    for (const source of ['packages/cli/src/commands/setup.ts', 'packages/cli/src/commands/init.ts']) {
      const files = selection([source])
      for (const suite of ['eval-skill-install.test.ts', 'eval-resume.test.ts', 'eval-execution-evidence.test.ts']) {
        assert.ok(files.includes(join(ROOT, 'scripts', 'test', suite)), `${source} must select ${suite}`)
      }
      assert.ok(files.includes(join(ROOT, 'packages', 'cli', 'test', 'setup.test.ts')), 'and the package suite')
    }
  })

  test('an unrelated root suite is not widened by the CLI entry point', () => {
    // The edge belongs to the harness and the suites that depend on it, not to every suite
    // in the tree.
    const files = selection(['packages/cli/src/commands/setup.ts'])
    assert.ok(!files.includes(CHECKER_SUITE), 'a suite that never runs the CLI does not depend on it')
    assert.ok(
      !files.includes(join(ROOT, 'scripts', 'test', 'eval-fixtures.test.ts')),
      'nor does one that reads only fixtures',
    )
  })

  test('a docs-only change selects nothing, and says so by returning nothing', () => {
    assert.deepEqual(selection(['docs/USAGE.md']), [])
  })

  test('a package change selects its tests and not the root suite', () => {
    const files = selection(['packages/core/src/output.ts'])
    assert.ok(files.length > 0, 'a changed package must select tests')
    assert.ok(files.every((file) => !file.endsWith('check-mcp-handshake.test.ts')))
  })

  test('a workflow change still widens to every package', () => {
    const packages = affectedPackages(['.github/workflows/ci.yml'], graph, ROOT)
    assert.equal(packages.length, graph.packages.length)
    assert.ok(selection(['.github/workflows/ci.yml']).length > packages.length, 'and includes their test files')
  })
})
