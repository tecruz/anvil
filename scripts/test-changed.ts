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
 *   - **A suite under `scripts/test/` has no package to hang off.** Its trigger is derived
 *     from what it depends on: static imports, workspace packages, and the paths it names
 *     as strings when it spawns or copies something. A full run enumerates the directory,
 *     so a suite added later is not left out of a run that claims to be everything.
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
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import ts from 'typescript'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
// NO_COLOR is spec'd as "set to any non-empty value", not to the single value `1`.
const noColor = process.env.NO_COLOR !== undefined && process.env.NO_COLOR !== ''
const color = noColor ? (s: string): string => s : (s: string): string => `\u001b[36m${s}\u001b[0m`

/** Run git, returning trimmed stdout, or null when git declines (missing ref, no repo). */
function git(args: readonly string[], root: string): string | null {
  const out = gitRaw(args, root)
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
function gitRaw(args: readonly string[], root: string): string | null {
  try {
    return execFileSync('git', args, { cwd: root, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 })
  } catch {
    return null
  }
}

/** The ref to diff against: the merge base with the default branch, when there is one. */
function baseRef(root: string = repoRoot): string | null {
  const override = process.env.ANVIL_TEST_BASE
  if (override !== undefined && override !== '') return override
  for (const candidate of ['origin/main', 'main', 'origin/master', 'master']) {
    if (git(['rev-parse', '--verify', '--quiet', candidate], root) === null) continue
    // The merge base, not the branch tip: work that landed on main after this branch
    // started is not this branch's to verify.
    return git(['merge-base', candidate, 'HEAD'], root) ?? candidate
  }
  return null
}

/**
 * The paths a `--porcelain -z` status stream names.
 *
 * A rename is the one record that is not self-delimiting. With `-z`, git emits
 * `XY <new-path>\0<old-path>\0`: the second path has *no* status columns of its own, so
 * slicing three characters off it (as an earlier comment claimed it should) produced a
 * truncated phantom path. Both paths are wanted -- a rename touches a file that may be
 * deleted -- so a record that does not look like `XY ` is taken whole.
 *
 * `T` is a type change (regular file <-> symlink), and omitting it stored the whole record
 * including its status columns, so the real file was never selected.
 */
export function porcelainPaths(output: string): string[] {
  const paths: string[] = []
  for (const record of output.split('\0')) {
    if (record === '') continue
    const path = /^[ MADRCU?!T]{2} /.test(record) ? record.slice(3) : record
    const trimmed = path.trim()
    if (trimmed !== '') paths.push(trimmed)
  }
  return paths
}

/** Repo-relative paths changed since the base, including uncommitted work. */
export function changedFiles(base: string | null, root: string = repoRoot): string[] {
  const out = new Set<string>()
  if (base !== null) {
    // `--no-renames` because `git diff` reports a rename as the new path alone. A suite that
    // still imports or spawns the old file would then not be selected, even though the
    // rename deleted it.
    for (const path of (gitRaw(['diff', '--name-only', '--no-renames', '-z', `${base}...HEAD`], root) ?? '').split(
      '\0',
    )) {
      if (path.trim() !== '') out.add(path.trim())
    }
  }
  // Uncommitted work is the common case inside a worktree, and the case a crew hits.
  //
  // `--untracked-files=all` because the default collapses a new directory into one record
  // (`?? scripts/test/new/`). No suite is named `scripts/test/new/`, so a suite added in a
  // new subdirectory -- the exact case `allRootTests` enumerates recursively -- would be
  // discovered and then never selected.
  for (const path of porcelainPaths(gitRaw(['status', '--porcelain', '-z', '--untracked-files=all'], root) ?? '')) {
    out.add(path)
  }
  return [...out]
}

/** One workspace package, its internal dependencies, and where its tests live. */
export interface WorkspacePackage {
  dirName: string
  name: string
  internal: string[]
}

export interface WorkspaceGraph {
  packages: WorkspacePackage[]
  /** The package's test directory, or null when the workspace directory is absent. */
  dirOf: (dirName: string) => string | null
}

/** Workspace packages, their internal dependencies, and where their tests live. */
export function readGraph(root: string): WorkspaceGraph {
  const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as { workspaces?: string[] }
  const globs = manifest.workspaces ?? ['packages/*']
  const base = (globs[0] ?? 'packages/*').replace(/\/\*$/, '')
  const dir = join(root, base)
  const packages: WorkspacePackage[] = []
  if (!existsSync(dir)) return { packages, dirOf: () => null }

  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const manifestPath = join(dir, entry.name, 'package.json')
    if (!existsSync(manifestPath)) continue
    const member = JSON.parse(readFileSync(manifestPath, 'utf8')) as {
      name: string
      dependencies?: Record<string, string>
      devDependencies?: Record<string, string>
      peerDependencies?: Record<string, string>
    }
    const internal = [
      ...Object.keys(member.dependencies ?? {}),
      ...Object.keys(member.devDependencies ?? {}),
      ...Object.keys(member.peerDependencies ?? {}),
    ].filter((dependency) => dependency.startsWith('@anvil/') || dependency === 'anvil')
    packages.push({ dirName: entry.name, name: member.name, internal })
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
  // The packaging test imports the MCP handshake checker the release workflow runs, so a
  // change to it is a change to the tests that exercise it.
  'scripts/check-mcp-handshake.ts',
])

/**
 * Data the `eval-*` suites read by path rather than import.
 *
 * `eval-extended-scenarios` does `readFileSync(join(source, 'eval/scenarios.json'))`, so no
 * import edge exists for the closure to follow. The directory is named instead.
 */
const EVAL_DATA_DIRS = ['eval/']

const EVAL_SUITE = /^scripts\/test\/eval-.*\.test\.ts$/

/**
 * Calls that run or copy something, and whose arguments name a runtime dependency.
 *
 * This is the difference between a suite that spawns `scripts/eval.ts` and a suite that
 * merely asserts a change to it selects something: only the former lists it as a call
 * argument.
 */
const RUNTIME_CALLS = new Set([
  'spawn',
  'spawnSync',
  'exec',
  'execFile',
  'execFileSync',
  'execSync',
  'cpSync',
  'copyFileSync',
])

/** Module specifiers that expose the runtime calls above. */
const CHILD_PROCESS_MODULES = new Set(['node:child_process', 'child_process'])

/**
 * Product entry points a module runs only as a subprocess, which no literal names.
 *
 * `scripts/eval.ts` runs the CLI it is evaluating: `anvilCli()` resolves the built bundle, or
 * `packages/cli/src/main.ts` when there is no build. That path is assembled from segments
 * inside the harness, so no string literal names the entry point and the import graph has no
 * edge to the command surface -- yet a change to a command is exactly what a suite that
 * drives the harness exercises end to end. Declaring the edge on the module gives it to
 * every suite that depends on the harness, including the ones that only spawn it.
 *
 * Naming the entry point is the smallest true statement; listing every module the CLI
 * imports would be the hand-maintained list this file exists to avoid.
 */
const MODULE_SPAWNED_ENTRYPOINTS: ReadonlyMap<string, readonly string[]> = new Map([
  ['scripts/eval.ts', ['packages/cli/src/main.ts']],
])

/** A repo-relative file an import or a spawned argument names. */
function dependencyPath(literal: string): string | null {
  const rel = literal.replace(/\\/g, '/').replace(/^\.\//, '')
  if (rel === '' || rel.startsWith('/') || rel.includes('..')) return null
  return rel
}

/** The repo-relative files a module depends on. */
function dependenciesOf(path: string, root: string, cache: Map<string, string[]>): string[] {
  const cached = cache.get(path)
  if (cached !== undefined) return cached

  let source: string
  try {
    source = readFileSync(path, 'utf8')
  } catch {
    // Not cached: a later change could create the file, and an empty answer is cheap.
    return []
  }

  // A real parse, not a scan. A RegExp literal such as `/[/*]/` looks like a block comment to
  // a hand-written lexer, and a `spawnSync(...)` inside a string literal is not a call; both
  // were wrong before. The parser distinguishes all three, so no heuristic is needed.
  const file = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, false)
  const files = new Set<string>()

  // A module that runs the product as a subprocess gives that edge to every suite that
  // depends on it; the suite's own source names nothing the parser can see.
  for (const entry of MODULE_SPAWNED_ENTRYPOINTS.get(relative(root, path).replace(/\\/g, '/')) ?? []) {
    files.add(entry)
  }

  const addSpecifier = (specifier: string): void => {
    if (specifier.startsWith('.')) {
      // A path that does not exist yet is still an edge: a deleted module has to keep its
      // dependants, or deleting `scripts/eval.ts` would silently stop selecting the suites
      // that spawn it.
      for (const candidate of resolveRelative(specifier, path, root)) files.add(candidate)
    } else if (specifier.startsWith('@anvil/')) {
      // A bare `@anvil/*` specifier is a workspace package, not an external dependency.
      for (const candidate of resolveWorkspace(specifier, root)) files.add(candidate)
    }
  }

  const addSpawnedLiterals = (node: ts.Node): void => {
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
      const rel = dependencyPath(node.text)
      // Only a top-level script: `spawnSync(node, ['scripts/eval.ts'])`. A literal that names
      // `scripts/test/x.test.ts` or `docs/USAGE.md` is not what is being run.
      if (rel !== null && /^scripts\/[^/]+\.(?:ts|mjs|js)$/.test(rel)) files.add(rel)
      return
    }
    ts.forEachChild(node, addSpawnedLiterals)
  }

  // A callee is not always a bare name. `import * as cp from 'node:child_process'` calls
  // `cp.spawnSync(...)`, a default import does the same, and a named import can be aliased.
  // Accepting only bare identifiers dropped all three, so a change to a script they spawn
  // selected no suite at all.
  const runtimeNamespaces = new Set<string>()
  const runtimeCallees = new Set<string>()
  const collectRuntimeBindings = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node)) {
      const specifier = node.moduleSpecifier
      const clause = node.importClause
      if (clause !== undefined && ts.isStringLiteral(specifier) && CHILD_PROCESS_MODULES.has(specifier.text)) {
        // A default import of a CommonJS builtin is the module object, so its methods are
        // reached through the binding just like a namespace import's.
        if (clause.name !== undefined) runtimeNamespaces.add(clause.name.text)
        const bindings = clause.namedBindings
        if (bindings !== undefined) {
          if (ts.isNamespaceImport(bindings)) {
            runtimeNamespaces.add(bindings.name.text)
          } else {
            for (const element of bindings.elements) {
              const imported = (element.propertyName ?? element.name).text
              if (RUNTIME_CALLS.has(imported)) runtimeCallees.add(element.name.text)
            }
          }
        }
      }
    }
    ts.forEachChild(node, collectRuntimeBindings)
  }
  collectRuntimeBindings(file)

  const isRuntimeCall = (callee: ts.Expression): boolean => {
    if (ts.isIdentifier(callee)) return RUNTIME_CALLS.has(callee.text) || runtimeCallees.has(callee.text)
    return (
      ts.isPropertyAccessExpression(callee) &&
      ts.isIdentifier(callee.expression) &&
      runtimeNamespaces.has(callee.expression.text) &&
      RUNTIME_CALLS.has(callee.name.text)
    )
  }

  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
      const specifier = node.moduleSpecifier
      if (specifier !== undefined && ts.isStringLiteral(specifier)) addSpecifier(specifier.text)
    } else if (ts.isCallExpression(node)) {
      // `import('...')` has no declarative form.
      if (node.expression.kind === ts.SyntaxKind.ImportKeyword) {
        for (const argument of node.arguments) {
          if (ts.isStringLiteralLike(argument)) addSpecifier(argument.text)
        }
      } else if (isRuntimeCall(node.expression)) {
        for (const argument of node.arguments) addSpawnedLiterals(argument)
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(file)

  const result = [...files]
  // Parsing is the expensive part and the suites share most of the graph, so the resolved
  // edge list is what gets cached, not the source it came from.
  cache.set(path, result)
  return result
}

/** Every plausible file a relative specifier names, whether or not it currently exists. */
function resolveRelative(specifier: string, from: string, root: string): string[] {
  const resolved = resolve(dirname(from), specifier)
  // TypeScript allows a `./x.js` specifier to mean `./x.ts`, which is how the suites import
  // package sources. Try the rewritten spelling too, or the edge disappears.
  const typeStripped = /\.(m?)js$/.test(resolved) ? resolved.replace(/\.(m?)js$/, '.$1ts') : null
  const candidates = [
    resolved,
    ...(typeStripped === null ? [] : [typeStripped]),
    `${resolved}.ts`,
    `${resolved}.mjs`,
    `${resolved}.js`,
    join(resolved, 'index.ts'),
  ]
  const out: string[] = []
  for (const candidate of candidates) {
    const rel = relative(root, candidate).replace(/\\/g, '/')
    if (rel.startsWith('..')) continue
    out.push(rel)
  }
  return out
}

/**
 * Resolve `@anvil/<pkg>[/<subpath>]` through that workspace package's `exports`.
 *
 * The manifest itself is a dependency, not just its target: editing `exports` changes which
 * file the specifier resolves to, so the suites that import the package are affected even
 * though no module they list changed name.
 */
function resolveWorkspace(specifier: string, root: string): string[] {
  const match = /^@anvil\/([^/]+)(?:\/(.+))?$/.exec(specifier)
  if (match === null) return []
  const dirName = match[1] as string
  const subpath = match[2]
  const manifest = `packages/${dirName}/package.json`
  const fallback = `packages/${dirName}/src/index.ts`
  const manifestPath = join(root, 'packages', dirName, 'package.json')
  if (!existsSync(manifestPath)) return [fallback]
  let exports: unknown
  try {
    exports = (JSON.parse(readFileSync(manifestPath, 'utf8')) as { exports?: unknown }).exports
  } catch {
    return [manifest]
  }
  const key = subpath === undefined ? '.' : `./${subpath}`
  const target =
    typeof exports === 'string'
      ? subpath === undefined
        ? exports
        : undefined
      : typeof exports === 'object' && exports !== null && !Array.isArray(exports)
        ? (exports as Record<string, unknown>)[key]
        : undefined
  if (typeof target !== 'string') return [manifest, fallback]
  return [manifest, `packages/${dirName}/${target.replace(/^\.\//, '')}`]
}

/**
 * Whether a change set touches anything this file depends on, transitively.
 *
 * The walk is breadth-first over the dependency graph and stops at the first hit. Depth is
 * bounded by a visited set rather than a counter: the graph has cycles, and a counter would
 * either cut a real chain short or never terminate.
 */
function touchesImportClosure(
  changed: ReadonlySet<string>,
  entry: string,
  root: string,
  cache: Map<string, string[]>,
): boolean {
  const visited = new Set<string>()
  const queue = [entry]
  while (queue.length > 0) {
    const current = queue.pop()
    if (current === undefined) continue
    const rel = relative(root, current).replace(/\\/g, '/')
    if (visited.has(rel)) continue
    visited.add(rel)
    if (changed.has(rel)) return true
    for (const dependency of dependenciesOf(current, root, cache)) {
      if (!visited.has(dependency)) queue.push(join(root, ...dependency.split('/')))
    }
  }
  return false
}

/**
 * Every suite under `scripts/test/`, which is exactly what `npm test` runs there.
 *
 * A full selection must use this rather than `ROOT_TESTS`: the trigger map only names the
 * suites worth running for a targeted change, and using it for a full run silently left
 * the eval suites out of a run that claimed to be the whole thing.
 */
export function allRootTests(root: string): string[] {
  const dir = join(root, 'scripts', 'test')
  if (!existsSync(dir)) return []
  // Recursive, because `npm test` globs `scripts/test/**/*.test.ts`; a suite in a
  // subdirectory must not fall out of a full run.
  return readdirSync(dir, { recursive: true, encoding: 'utf8' })
    .filter((file) => file.endsWith('.test.ts'))
    .sort()
    .map((file) => `scripts/test/${file.replace(/\\/g, '/')}`)
}

function affectsEveryPackage(file: string): boolean {
  const top = file.split(/[/\\]/)[0] ?? file
  return ROOT_CHANGES_WIDEN.has(file) || ROOT_CHANGES_WIDEN.has(top)
}

/** Packages a change set touches, widened to everything that depends on them. */
export function affectedPackages(files: readonly string[], graph: WorkspaceGraph, root: string): WorkspacePackage[] {
  const direct = new Set<string>()
  for (const file of files) {
    if (affectsEveryPackage(file)) return graph.packages
    const parts = file.split(/[/\\]/)
    if (parts[0] === 'packages' && parts[1] !== undefined) {
      // A deleted or renamed manifest removes the package from the graph, so the change would
      // silently run *nothing* -- and a package whose manifest just vanished is exactly the
      // structural change `npm ci` fails on. Treat it as every package needing a run.
      if (parts[2] === 'package.json' && !existsSync(join(root, ...parts))) {
        return graph.packages
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
  const dirOfName = new Map(graph.packages.map((pkg) => [pkg.name, pkg.dirName]))
  const dependents = new Map<string, WorkspacePackage[]>()
  for (const pkg of graph.packages) {
    for (const dependency of pkg.internal) {
      const dependencyDir = dirOfName.get(dependency)
      if (dependencyDir === undefined) continue // a dependency outside this workspace
      const existing = dependents.get(dependencyDir) ?? []
      existing.push(pkg)
      dependents.set(dependencyDir, existing)
    }
  }

  const out = new Set<string>()
  const queue = [...direct]
  while (queue.length > 0) {
    const dirName = queue.pop()
    if (dirName === undefined || out.has(dirName)) continue
    out.add(dirName)
    for (const dependent of dependents.get(dirName) ?? []) {
      if (!out.has(dependent.dirName)) queue.push(dependent.dirName)
    }
  }
  return graph.packages.filter((pkg) => {
    const testDir = out.has(pkg.dirName) ? graph.dirOf(pkg.dirName) : null
    return testDir !== null && existsSync(testDir)
  })
}

/** Test files for the selected packages. */
export function testFilesFor(packages: readonly WorkspacePackage[], graph: WorkspaceGraph): string[] {
  return packages.flatMap((pkg) => {
    const dir = graph.dirOf(pkg.dirName)
    // Not every package has tests: the plugin is typed by the typechecker and covered by
    // the packaging suite, so `packages/plugin-opencode` has no test directory at all.
    if (dir === null || !existsSync(dir)) return []
    return readdirSync(dir)
      .filter((file) => file.endsWith('.test.ts'))
      .sort()
      .map((file) => join(dir, file))
  })
}

/**
 * Root-level suites that a change set touches.
 *
 * A changed suite runs itself. For the rest, the trigger is derived from what the suite
 * depends on, not from a list: static imports, `@anvil/*` workspace packages resolved through
 * their exports, and the string literals naming a script the suite spawns or a tree it copies.
 * A hand-maintained list was wrong twice -- it missed the suites entirely, then missed the
 * package modules they import -- and a list that has to be edited whenever a dependency is
 * added is a list that will be wrong again. The one edge the AST cannot see -- a product
 * entry point a module runs through a subprocess -- is declared in
 * `MODULE_SPAWNED_ENTRYPOINTS` and resolved through the same import closure.
 *
 * Two things are deliberately outside static imports: a suite that is deleted is not run
 * (there is nothing to open), and data a suite reads by path at runtime is handled below.
 */
export function rootTestsFor(files: readonly string[], root: string = repoRoot): string[] {
  const changed = new Set(files.map((file) => file.replace(/\\/g, '/')))
  const selected = new Set<string>()
  // The suites share most of the same dependency graph; reading each file once keeps a
  // selection in the low hundreds of milliseconds instead of seconds.
  const cache = new Map<string, string[]>()

  for (const suite of allRootTests(root)) {
    const path = join(root, ...suite.split('/'))
    if (!existsSync(path)) continue
    if (changed.has(suite) || touchesImportClosure(changed, path, root, cache)) selected.add(suite)
  }

  // Data the eval suites read by path (`readFileSync(join(source, 'eval/scenarios.json'))`)
  // is named as a literal and caught above. This covers the case where the literal names a
  // directory whose contents changed in a way a prefix match handles more directly.
  const evalDataTouched = [...changed].some((file) => EVAL_DATA_DIRS.some((dir) => file.startsWith(dir)))
  if (evalDataTouched) {
    for (const suite of allRootTests(root)) if (EVAL_SUITE.test(suite)) selected.add(suite)
  }

  return [...selected].sort()
}

/**
 * The files `node --test` should run for a selection: package suites plus triggered root
 * suites. Kept in one place so `main` and the selection tests cannot disagree about whether
 * root suites are included.
 */
export function testFilesForSelection(
  targets: readonly WorkspacePackage[],
  rootTests: readonly string[],
  graph: WorkspaceGraph,
  root: string,
): string[] {
  return [...testFilesFor(targets, graph), ...rootTests.map((test) => join(root, test))]
}

export function main(): number {
  const wantsFull = process.env.ANVIL_TEST_FULL === '1' || process.argv.includes('--full')
  const graph = readGraph(repoRoot)
  if (graph.packages.length === 0) {
    console.error('test:changed: no workspace packages found')
    return 1
  }

  let targets = graph.packages
  let rootTests = wantsFull ? allRootTests(repoRoot) : []
  let reason = 'full suite'

  if (!wantsFull) {
    const base = baseRef()
    const changed = changedFiles(base)
    if (base === null) {
      reason = 'no base ref to compare against; full suite'
      rootTests = allRootTests(repoRoot)
    } else if (changed.length === 0) {
      console.log(`${color('test:changed:')} no changes since ${base}; nothing to run`)
      return 0
    } else {
      const affected = affectedPackages(changed, graph, repoRoot)
      rootTests = rootTestsFor(changed, repoRoot)
      if (affected.length === 0 && rootTests.length === 0) {
        console.log(
          `${color('test:changed:')} ${changed.length} changed file(s), none in a package with tests; nothing to run`,
        )
        return 0
      }
      if (affected.length === graph.packages.length) {
        reason = `changes touch every package (${changed.length} file(s)); full suite`
        rootTests = allRootTests(repoRoot)
      } else if (affected.length === 0) {
        targets = []
        reason = `${rootTests.length} root test file(s) touched by ${changed.length} changed file(s)`
      } else {
        targets = affected
        reason = `${affected.length}/${graph.packages.length} packages touched by ${changed.length} changed file(s)`
      }
    }
  }

  const files = testFilesForSelection(targets, rootTests, graph, repoRoot)
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

// Only run when executed directly; importing the selectors must not start a suite.
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(main())
}
