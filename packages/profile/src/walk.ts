/**
 * Repo file walking.
 *
 * Detection is signature-based: we read filenames and a small number of config files,
 * never execute the build. That is what makes `anvil profile` safe to run against a repo
 * you have never seen and cannot modify.
 *
 * The walk skips vendored, generated and VCS directories. This is not only a speed
 * concern -- `node_modules` and `target` contain millions of files whose *extensions*
 * would otherwise dominate a naive language count and make the primary-language
 * determination confidently wrong.
 */

import { type Dirent, existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { normalizeRelPath, toPosix } from './types.ts'

/** Directories never descended into. */
export const SKIP_DIRS: ReadonlySet<string> = new Set([
  '.git',
  '.hg',
  '.svn',
  '.anvil',
  'node_modules',
  'bower_components',
  'vendor',
  'target',
  'build',
  'out',
  'dist',
  '.next',
  '.nuxt',
  '.svelte-kit',
  '.turbo',
  '.parcel-cache',
  '.gradle',
  '.venv',
  'venv',
  'env',
  '__pycache__',
  '.pytest_cache',
  '.mypy_cache',
  '.ruff_cache',
  '.tox',
  '.idea',
  '.vscode',
  '.cache',
  '.terraform',
  'coverage',
  'Pods',
  'DerivedData',
  'bin',
  'obj',
])

/**
 * Directories that hold *test data* rather than the product.
 *
 * Distinct from {@link SKIP_DIRS}, which is all about build output. A `fixtures/` tree is
 * a set of miniature repositories that exist to be detected, so walking one makes the
 * parent repo claim stacks it does not have: anvil pointed at itself reported `vue`,
 * `dotnet` and `terraform`, and offered `dotnet test` as a verify command, purely from
 * its own fixtures. Confident-and-wrong is the outcome this tool exists to prevent, and
 * this is the one place it produced exactly that.
 *
 * These names are the conventional spelling of "sample data" across ecosystems, and they
 * are skipped on the same reasoning as `node_modules`: contents there are not the code an
 * agent will be asked to change. A repository whose real source lives under one of these
 * names is rare, and the direction of the error is the safe one -- a missing stack is
 * recoverable, a fabricated one is not.
 */
export const SKIP_TEST_DATA_DIRS: ReadonlySet<string> = new Set([
  'fixtures',
  'fixture',
  '__fixtures__',
  'test-fixtures',
  'testdata',
  'test-data',
  'test_data',
])

export interface WalkOptions {
  /** Hard cap on files returned, to keep a pathological repo bounded. */
  maxFiles?: number
  /** Maximum directory depth. */
  maxDepth?: number
  /** File extensions to collect. Empty means every file. */
  extensions?: ReadonlySet<string>
  /** Extra directory names to skip, on top of SKIP_DIRS. */
  extraSkipDirs?: ReadonlySet<string>
  /**
   * Names that are not build output but share a build-output name. `dist` is output in
   * JS projects and source in some others; a project can legitimately commit it.
   */
  followDirs?: ReadonlySet<string>
}

export interface WalkResult {
  /** Repo-relative POSIX paths, sorted. */
  files: string[]
  /** True when the walk stopped early at maxFiles. */
  truncated: boolean
}

export const DEFAULT_MAX_FILES = 20_000
const DEFAULT_MAX_DEPTH = 12

/**
 * Files a detector needs even when their directory is skipped.
 *
 * `.vscode` is in `SKIP_DIRS` because editor state is usually noise, but `.vscode/mcp.json`
 * is project configuration. A full `.vscode` walk would trade one known file for every
 * settings file in every repository, so the one file is probed directly instead.
 */
const PROBED_FILES: readonly string[] = ['.vscode/mcp.json']

/**
 * Hidden directories are almost always tooling rather than source, so they are skipped
 * by default. These are the ones a detector may legitimately need to read.
 *
 * `.githooks` and `.husky` are here for the same reason `.github` is: they are where a
 * repository's own git hooks live, and "does this repository run a hook on commit" is
 * unanswerable while the directory containing the answer is skipped. Skipping them meant
 * this repository reported "no pre-commit hooks" about itself while shipping one, and meant
 * every husky project in the world was reported as having no hooks at all.
 */
export const HIDDEN_DIR_ALLOW: ReadonlySet<string> = new Set([
  '.github',
  '.githooks',
  '.husky',
  // CircleCI's config is CI evidence, and `detectGenericTooling` already looks for it.
  // Skipping the hidden directory made that check unreachable.
  '.circleci',
  // The documented home of Maestro's flows. Skipping it made the `maestro` and `qa`
  // playbooks unmatchable, because the only file that identifies a Maestro project was
  // inside a directory the walk refused to enter.
  '.maestro',
  '.config',
  '.devcontainer',
  '.claude',
  '.cursor',
  '.agents',
])

export function walkFiles(root: string, options: WalkOptions = {}): WalkResult {
  const maxFiles = options.maxFiles ?? DEFAULT_MAX_FILES
  const maxDepth = options.maxDepth ?? DEFAULT_MAX_DEPTH
  const extensions = options.extensions
  const extraSkip = options.extraSkipDirs
  const follow = options.followDirs
  const files: string[] = []
  let truncated = false

  const skipDir = (name: string): boolean => {
    if (follow?.has(name)) return false
    if (SKIP_DIRS.has(name)) return true
    if (SKIP_TEST_DATA_DIRS.has(name)) return true
    if (extraSkip?.has(name)) return true
    if (name.startsWith('.') && !HIDDEN_DIR_ALLOW.has(name)) return true
    return false
  }

  const walk = (dir: string, rel: string, depth: number): void => {
    if (truncated || depth > maxDepth) return

    let entries: Dirent[]
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      // Unreadable directory (permissions, or a race with a running build): skip it
      // rather than fail the whole profile. A partial profile is still useful.
      return
    }

    for (const entry of entries) {
      if (truncated) return
      const childRel = rel === '' ? entry.name : `${rel}/${entry.name}`

      if (entry.isDirectory()) {
        if (skipDir(entry.name)) continue
        walk(join(dir, entry.name), childRel, depth + 1)
        continue
      }

      if (!entry.isFile()) continue

      if (extensions && extensions.size > 0) {
        const ext = extensionOf(entry.name)
        if (ext !== null && !extensions.has(ext)) continue
      }

      files.push(childRel)
      if (files.length >= maxFiles) {
        truncated = true
        return
      }
    }
  }

  walk(root, '', 0)

  for (const rel of PROBED_FILES) {
    if (files.includes(rel)) continue
    if (extensions && extensions.size > 0) {
      const ext = extensionOf(rel)
      if (ext !== null && !extensions.has(ext)) continue
    }
    try {
      if (statSync(join(root, rel)).isFile()) files.push(rel)
    } catch {
      // Absent or unreadable: the same answer every caller already handles.
    }
  }

  files.sort()
  return { files, truncated }
}

/** Lowercased extension including the dot, or null for dotfiles with no extension. */
export function extensionOf(name: string): string | null {
  const idx = name.lastIndexOf('.')
  if (idx <= 0) return null
  return name.slice(idx).toLowerCase()
}

export interface ReadTextResult {
  text: string | null
  bytes: number
}

/** Read a text file, tolerating absence, permission errors and binary content. */
export function readText(path: string): ReadTextResult {
  try {
    const stat = statSync(path)
    if (!stat.isFile()) return { text: null, bytes: 0 }
    const text = readFileSync(path, 'utf8')
    // A NUL in the first block means binary; a manifest that is binary is not a manifest.
    if (text.includes('\0')) return { text: null, bytes: 0 }
    return { text, bytes: Buffer.byteLength(text) }
  } catch {
    return { text: null, bytes: 0 }
  }
}

/** Find the first existing path from a list, as a repo-relative POSIX path. */
export function firstExisting(root: string, candidates: readonly string[]): string | null {
  for (const candidate of candidates) {
    if (existsSync(join(root, candidate))) return normalizeRelPath(candidate)
  }
  return null
}

// ---------------------------------------------------------------------------
// Project directory
// ---------------------------------------------------------------------------

/**
 * Files that identify a project, used *only* to choose the project directory below.
 *
 * Deliberately not the whole set of files a detector probes: a linter's config is not a
 * statement of where the project lives. A name missing from this list costs a resolution,
 * which degrades to the previous behaviour (project not detected) rather than to a wrong
 * directory.
 */
const PROJECT_MANIFESTS: ReadonlySet<string> = new Set([
  'Cargo.toml',
  'go.mod',
  'go.work',
  'package.json',
  'pyproject.toml',
  'setup.py',
  'setup.cfg',
  'requirements.txt',
  'Pipfile',
  'Gemfile',
  'composer.json',
  'mix.exs',
  'pubspec.yaml',
  'Package.swift',
  'pom.xml',
  'build.gradle',
  'build.gradle.kts',
  'settings.gradle',
  'settings.gradle.kts',
  'build.sbt',
  'Project.toml',
  'MODULE.bazel',
  'WORKSPACE',
  'WORKSPACE.bazel',
  'BUILD.bazel',
  'deno.json',
  'deno.jsonc',
  'CMakeLists.txt',
])

/** Manifests whose name is not fixed: one per project, matched by extension. */
const PROJECT_MANIFEST_EXTENSIONS: ReadonlySet<string> = new Set(['.csproj', '.fsproj', '.vbproj', '.sln'])

function isProjectManifest(relPath: string): boolean {
  const name = relPath.slice(relPath.lastIndexOf('/') + 1)
  if (PROJECT_MANIFESTS.has(name)) return true
  const dot = name.lastIndexOf('.')
  return dot > 0 && PROJECT_MANIFEST_EXTENSIONS.has(name.slice(dot))
}

/**
 * The directory holding the project, when it is not the repository root.
 *
 * A Rust crate under `engine/` -- `engine/Cargo.toml`, `engine/src/lib.rs`,
 * `engine/tests/it.rs`, and nothing at the root but a README -- is a real and ordinary
 * layout, and it defeated root-level detection completely: no stack, no commands, and a
 * `TEST` blocker claiming the tests could not be run. They run `cargo test`.
 *
 * Two conditions, both required, because the failure mode of guessing is worse than not
 * guessing:
 *
 * 1. The root holds no manifest. If it does, the root *is* the project, and every existing
 *    behaviour is preserved exactly -- this is why the ten audited repositories are
 *    unaffected.
 * 2. Exactly one directory at the shallowest manifest depth holds one. A tree with
 *    `svc/go.mod` and `web/package.json` is two projects, and choosing either would mean
 *    confidently reporting a stack for a repository that has two.
 *
 * Returns `''` for the ordinary case, which makes every call site a no-op.
 */
export function projectDirOf(files: ReadonlySet<string>): string {
  let shallowest = Number.POSITIVE_INFINITY
  let candidate = ''
  let ambiguous = false
  for (const f of files) {
    if (!isProjectManifest(f)) continue
    const slash = f.lastIndexOf('/')
    if (slash < 0) return '' // the root holds a manifest: it is the project
    const dir = f.slice(0, slash)
    const depth = dir.split('/').length
    if (depth < shallowest) {
      shallowest = depth
      candidate = dir
      ambiguous = false
    } else if (depth === shallowest && dir !== candidate) {
      ambiguous = true
    }
  }
  if (ambiguous || candidate === '') return ''
  return candidate
}

/**
 * Resolve a probed root-relative name to the file that actually exists.
 *
 * Root first, then the project directory, then the name unchanged. Returning the name
 * unchanged when nothing matches is what keeps this safe: every caller was already
 * handling "absent" for that name, so an unresolved probe behaves exactly as it did before.
 *
 * Resolution is confined to the single chosen project directory, so a probe cannot pick up
 * a same-named file in an unrelated `examples/` tree.
 */
export function makeResolver(files: ReadonlySet<string>, projectDir: string): (rel: string) => string {
  if (projectDir === '') return (rel) => rel
  const prefix = `${projectDir}/`
  return (rel) => {
    if (files.has(rel)) return rel
    const nested = prefix + rel
    return files.has(nested) ? nested : rel
  }
}

export { toPosix }
