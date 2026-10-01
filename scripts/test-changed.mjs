/**
 * `npm run test:changed` -- run the tests of the packages whose source changed.
 *
 * This is the documented changed-files subset that `anvil doctor`'s `TEST_FAST` rule looks
 * for, and it exists for the reason the rule gives: full-suite feedback on every iteration
 * makes agents unusable. A crew verifying four worktrees should not run every test in the
 * repository four times over to check a one-line change in `packages/core`.
 *
 * Design decisions, each of which is a way the obvious implementation is wrong:
 *
 *   - **Packages, not files.** `node --test` takes files, and a package's tests exercise
 *     its neighbours (the audit tests import the profile; the ship pipeline imports git, pr
 *     and providers). Selecting whole workspaces keeps cross-package contracts honest, and
 *     a workspace whose source moved is a unit of work, not a file.
 *
 *   - **A change to shared code widens the blast radius.** `packages/core` is imported by
 *     nearly everything, so changing it runs everything. A package that depends on a
 *     changed package runs too: the same reachability argument as a module graph,
 *     computed from the real workspace dependency edges rather than guessed.
 *
 *   - **A change outside `packages/` means everything.** A root config, a workflow or a
 *     registry change can affect any package, so the honest answer is the full suite
 *     rather than a confident guess about which package cares.
 *
 *   - **Nothing changed means nothing runs, and it says so.** The alternative -- silently
 *     running the full suite -- makes the command slow exactly when it is least useful.
 *
 *   - **Every git call is an argv array**, never a shell string, for the same reason as the
 *     rest of anvil: branch names and paths are not always trustworthy. It also has to work
 *     on Windows, where this file is the only thing standing between an agent and four
 *     minutes of tests it did not need to run.
 *
 * Env:
 *   ANVIL_TEST_BASE=ref   compare against this ref instead of the merge base with main
 *   ANVIL_TEST_FULL=1     always run the whole suite, whatever changed
 */

import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
// NO_COLOR is spec'd as "set to any non-empty value", not to the single value `1`.
const noColor = process.env.NO_COLOR !== undefined && process.env.NO_COLOR !== ''
const color = noColor ? (s) => s : (s) => `[36m${s}[0m`

/** Run git, returning trimmed stdout, or null when git declines (missing ref, no repo). */
function git(args) {
  const out = gitRaw(args)
  return out === null ? null : out.trim()
}

/**
 * Run git, returning stdout exactly as produced.
 *
 * `-z` output has to come through untouched: `git status --porcelain` pads each record to
 * two status columns plus a space, and trimming the leading space of the first record
 * silently shifts every path by one character. `-z` also removes git's path quoting, so a
 * filename containing a space or a quote needs no unescaping.
 */
function gitRaw(args) {
  try {
    return execFileSync('git', args, { cwd: repoRoot, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 })
  } catch {
    return null
  }
}

/** The ref to diff against: the merge base with the default branch, when there is one. */
function baseRef() {
  const override = process.env.ANVIL_TEST_BASE
  if (override !== undefined && override !== '') return override
  for (const candidate of ['origin/main', 'main', 'origin/master', 'master']) {
    if (git(['rev-parse', '--verify', '--quiet', candidate]) === null) continue
    // The merge base, not the branch tip: work that landed on main after this branch
    // started is not this branch's to verify.
    return git(['merge-base', candidate, 'HEAD']) ?? candidate
  }
  return null
}

/** Repo-relative paths changed since the base, including uncommitted work. */
function changedFiles(base) {
  const out = new Set()
  if (base !== null) {
    for (const path of (gitRaw(['diff', '--name-only', '-z', `${base}...HEAD`]) ?? '').split('\0')) {
      if (path.trim() !== '') out.add(path.trim())
    }
  }
  // Uncommitted work is the common case inside a worktree, and the case a crew hits.
  // A porcelain record is two status columns and a space, then the path.
  //
  // A **rename** is the one record that is not self-delimiting. With `-z`, git emits
  // `XY <new-path>\0<old-path>\0`: the second path has *no* status columns of its own, so
  // slicing three characters off it (as the old comment claimed it should) produced a
  // truncated phantom path. Both paths are wanted -- a rename touches a file that may be
  // deleted -- so a record that does not look like `XY ` is taken whole.
  for (const record of (gitRaw(['status', '--porcelain', '-z']) ?? '').split('\0')) {
    if (record === '') continue
    const path = /^[ MADRCU?!]{2} /.test(record) ? record.slice(3) : record
    if (path.trim() !== '') out.add(path.trim())
  }
  return [...out]
}

/** Workspace packages, their internal dependencies, and where their tests live. */
function readGraph() {
  const root = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8'))
  const globs = root.workspaces ?? ['packages/*']
  const base = globs[0].replace(/\/\*$/, '')
  const dir = join(repoRoot, base)
  const packages = []
  if (!existsSync(dir)) return { packages, dirOf: () => null }

  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const manifestPath = join(dir, entry.name, 'package.json')
    if (!existsSync(manifestPath)) continue
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
    const internal = [
      ...Object.keys(manifest.dependencies ?? {}),
      ...Object.keys(manifest.devDependencies ?? {}),
      ...Object.keys(manifest.peerDependencies ?? {}),
    ].filter((d) => d.startsWith('@anvil/') || d === 'anvil')
    packages.push({ dirName: entry.name, name: manifest.name, internal })
  }
  return {
    packages,
    dirOf: (dirName) => join(dir, dirName, 'test'),
  }
}

/**
 * A change outside `packages/` that genuinely widens the run to every package.
 *
 * `fixtures/` and the two build scripts are here for a specific reason, both found by asking
 * "which test reads this file?": the audit's golden tests read `fixtures/` directly, and the
 * packaging test in `packages/cli` runs the *built* bundle that `scripts/build.mjs` and
 * `scripts/gen-playbooks.ts` produce. Treating either as documentation-only would mean editing
 * a fixture and running no tests that care, or changing the bundler and running none of the
 * tests that install the tarball.
 */
const ROOT_CHANGES_WIDEN = new Set([
  'package.json',
  'package-lock.json',
  'tsconfig.json',
  'tsconfig.base.json',
  'biome.jsonc',
  '.gitattributes',
  '.github',
  'registry',
  'fixtures',
  'scripts/build.mjs',
  'scripts/gen-playbooks.ts',
])

function affectsEveryPackage(file) {
  const top = file.split(/[/\\]/)[0]
  return ROOT_CHANGES_WIDEN.has(file) || ROOT_CHANGES_WIDEN.has(top)
}

/** Packages a change set touches, widened to everything that depends on them. */
function affectedPackages(files, graph) {
  const direct = new Set()
  for (const file of files) {
    if (affectsEveryPackage(file)) return graph.packages.map((p) => p)
    const parts = file.split(/[/\\]/)
    if (parts[0] === 'packages' && parts[1] !== undefined) {
      // A deleted or renamed manifest removes the package from the graph, so the change would
      // silently run *nothing* -- and a package whose manifest just vanished is exactly the
      // structural change `npm ci` fails on. Treat it as every package needing a run.
      if (parts[2] === 'package.json' && !existsSync(join(repoRoot, ...parts))) {
        return graph.packages.map((p) => p)
      }
      direct.add(parts[1])
    }
    // Anything else that is not in ROOT_CHANGES_WIDEN (docs, scripts, README) is not package
    // source, and nothing in the suite reads it: ignored.
  }

  // Reverse the dependency edges, keyed by *directory* name rather than manifest name:
  // the change set speaks in paths (`packages/tickets/...`) and `tickets` is not
  // `@anvil/tickets`. Keying by manifest name silently finds no dependents, which makes
  // the blast radius collapse to "just the package I edited" -- exactly the bug this
  // widening exists to prevent.
  const dirOfName = new Map(graph.packages.map((p) => [p.name, p.dirName]))
  const dependents = new Map()
  for (const pkg of graph.packages) {
    for (const dep of pkg.internal) {
      const depDir = dirOfName.get(dep)
      if (depDir === undefined) continue // a dependency outside this workspace
      if (!dependents.has(depDir)) dependents.set(depDir, [])
      dependents.get(depDir).push(pkg)
    }
  }

  const out = new Set()
  const queue = [...direct]
  while (queue.length > 0) {
    const dirName = queue.pop()
    if (out.has(dirName)) continue
    out.add(dirName)
    for (const dependent of dependents.get(dirName) ?? []) {
      if (!out.has(dependent.dirName)) queue.push(dependent.dirName)
    }
  }
  return graph.packages.filter((p) => out.has(p.dirName) && existsSync(graph.dirOf(p.dirName)))
}

function testFilesFor(packages, graph) {
  return packages.flatMap((pkg) => {
    const dir = graph.dirOf(pkg.dirName)
    // Not every package has tests: the plugin is typed by the typechecker and covered by
    // the packaging suite, so `packages/plugin-opencode` has no test directory at all.
    if (!existsSync(dir)) return []
    return readdirSync(dir)
      .filter((f) => f.endsWith('.test.ts'))
      .sort()
      .map((f) => join(dir, f))
  })
}

function main() {
  const wantsFull = process.env.ANVIL_TEST_FULL === '1' || process.argv.includes('--full')
  const graph = readGraph()
  if (graph.packages.length === 0) {
    console.error('test:changed: no workspace packages found')
    return 1
  }

  let targets = graph.packages
  let reason = 'full suite'

  if (!wantsFull) {
    const base = baseRef()
    const files = changedFiles(base)
    if (base === null) {
      reason = 'no base ref to compare against; full suite'
    } else if (files.length === 0) {
      console.log(`${color('test:changed:')} no changes since ${base}; nothing to run`)
      return 0
    } else {
      const affected = affectedPackages(files, graph)
      if (affected.length === 0) {
        console.log(
          `${color('test:changed:')} ${files.length} changed file(s), none in a package with tests; nothing to run`,
        )
        return 0
      }
      if (affected.length === graph.packages.length) {
        reason = `changes touch every package (${files.length} file(s)); full suite`
      } else {
        targets = affected
        reason = `${affected.length}/${graph.packages.length} packages touched by ${files.length} changed file(s)`
      }
    }
  }

  const files = testFilesFor(targets, graph)
  if (files.length === 0) {
    console.log(`${color('test:changed:')} no test files for the selected packages`)
    return 0
  }

  console.log(`${color('test:changed:')} ${reason}`)
  for (const pkg of targets) console.log(`  ${pkg.dirName}`)
  console.log(`  ${files.length} test file(s)\n`)

  const started = Date.now()
  // `spawnSync` rather than `execFileSync`: a failing suite should be a pass-through exit
  // code, not an exception carrying the whole report in `err.stdout`.
  const result = spawnSync(process.execPath, ['--test', '--test-reporter=spec', ...files], {
    cwd: repoRoot,
    stdio: 'inherit',
    windowsHide: true,
  })
  if (result.status !== 0) return typeof result.status === 'number' ? result.status : 1
  console.log(`\n${color('test:changed:')} done in ${Math.round((Date.now() - started) / 1000)}s`)
  return 0
}

process.exit(main())
