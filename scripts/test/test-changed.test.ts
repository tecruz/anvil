/**
 * Regression tests for `npm run test:changed` selection.
 *
 * The command is what an agent runs while iterating, so a change that silently selects
 * nothing is a green result that verified nothing. These cases pin the two ways that can
 * happen: a suite under `scripts/test/` has no package to hang off, and a change to the
 * module it covers must still run it.
 */

import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { after, describe, test } from 'node:test'
import { fileURLToPath } from 'node:url'

import { affectedPackages, allRootTests, readGraph, rootTestsFor, testFilesForSelection } from '../test-changed.ts'

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
