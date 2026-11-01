/**
 * The `package.json` files that can declare an application's dependencies.
 *
 * A workspace root's own manifest describes orchestration and tooling; the frameworks live in
 * the member manifests. Reading only the root therefore reports `pnpm`, `typescript` and
 * `prettier` for a repository whose `apps/web` is React and whose `apps/mobile` is React Native.
 *
 * The selection is deliberately not "every package.json anywhere":
 *
 *  - the root manifest (or the resolved project manifest) always counts;
 *  - npm/yarn/bun `workspaces`, `pnpm-workspace.yaml` and `lerna.json` name the members, so
 *    their manifests count with their real paths as evidence;
 *  - a repository with no root manifest at all is a collection of independent applications
 *    (`expo/examples` is the canonical case), so every manifest counts.
 *
 * A nested manifest that no workspace declaration points at is not selected. That is what keeps
 * a fixture or an example tree from claiming the repository's stacks.
 */

import { join } from 'node:path'
import { type DetectorContext, filesUnder } from './detector.ts'
import { globToRegExp } from './general.ts'
import { asObject, type JsonObject, readJson } from './manifest.ts'
import { readText } from './walk.ts'

export interface PackageManifest {
  /** Repo-relative POSIX path, e.g. `apps/web/package.json`. */
  path: string
  manifest: JsonObject
  text: string
  /** Runtime and development dependencies, merged. */
  deps: Record<string, string>
}

function isPackageManifest(file: string): boolean {
  return file === 'package.json' || file.endsWith('/package.json')
}

function dirOf(file: string): string {
  const slash = file.lastIndexOf('/')
  return slash < 0 ? '.' : file.slice(0, slash)
}

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((x): x is string => typeof x === 'string') : []
}

/** npm, yarn and bun all use the `workspaces` field, in either supported shape. */
function workspacePatterns(manifest: JsonObject): string[] {
  if (Array.isArray(manifest.workspaces)) return strings(manifest.workspaces)
  const nested = asObject(manifest.workspaces)
  return nested === null ? [] : strings(nested.packages)
}

/** `pnpm-workspace.yaml`'s `packages:` list, without taking a YAML dependency. */
function pnpmWorkspacePatterns(ctx: DetectorContext): string[] {
  const rel = ctx.resolve('pnpm-workspace.yaml')
  if (!ctx.files.has(rel)) return []
  const text = readText(join(ctx.root, rel)).text
  if (text === null) return []

  const out: string[] = []
  let inPackages = false
  for (const line of text.split('\n')) {
    const trimmed = line.trim()
    if (trimmed === '' || trimmed.startsWith('#')) continue
    if (/^packages\s*:/.test(trimmed)) {
      inPackages = true
      continue
    }
    if (!inPackages) continue
    if (!trimmed.startsWith('-')) {
      // The next top-level key ends the list (`catalog:`, `overrides:` and so on).
      inPackages = false
      continue
    }
    const value = /^-\s*(['"]?)(.*?)\1\s*(?:#.*)?$/.exec(trimmed)
    if (value?.[2] !== undefined && value[2] !== '') out.push(value[2])
  }
  return out
}

/** Lerna's `packages` list, for a workspace that predates the package manager's own field. */
function lernaPatterns(ctx: DetectorContext): string[] {
  const rel = ctx.resolve('lerna.json')
  if (!ctx.files.has(rel)) return []
  const manifest = readJson(ctx, rel)
  return manifest === null ? [] : strings(manifest.packages)
}

/**
 * Whether a directory is a declared workspace member.
 *
 * Patterns are ordered and a `!` entry removes an earlier match, which is how pnpm documents
 * its own negation. A plain `dir` and the common `dir/*` both work because the pattern is
 * matched against the member's directory, not against a filename.
 */
function isWorkspaceMember(dir: string, patterns: readonly string[]): boolean {
  let matched = false
  for (const raw of patterns) {
    const pattern = raw.trim()
    if (pattern === '') continue
    const negated = pattern.startsWith('!')
    const glob = negated ? pattern.slice(1) : pattern
    if (!globToRegExp(glob).test(dir)) continue
    matched = !negated
  }
  return matched
}

/** The manifests that can contribute framework stacks, with their evidence paths. */
export function applicationManifests(ctx: DetectorContext): PackageManifest[] {
  const all = filesUnder(ctx, '').filter(isPackageManifest)
  const rootPath = ctx.resolve('package.json')
  const hasRoot = ctx.files.has(rootPath)
  const selected = new Set<string>()

  if (hasRoot) {
    selected.add(rootPath)
    const root = readJson(ctx, rootPath)
    const patterns =
      root === null ? [] : [...workspacePatterns(root), ...pnpmWorkspacePatterns(ctx), ...lernaPatterns(ctx)]
    for (const file of all) {
      if (file === rootPath) continue
      if (isWorkspaceMember(dirOf(file), patterns)) selected.add(file)
    }
  } else {
    // No root manifest: independent applications rather than a workspace with one owner.
    for (const file of all) selected.add(file)
  }

  const out: PackageManifest[] = []
  for (const path of selected) {
    const manifest = readJson(ctx, path)
    if (manifest === null) continue
    const text = readText(join(ctx.root, ctx.resolve(path))).text
    if (text === null) continue
    const deps: Record<string, string> = {}
    for (const field of ['dependencies', 'devDependencies'] as const) {
      const values = asObject(manifest[field])
      if (values === null) continue
      for (const [name, range] of Object.entries(values)) {
        if (typeof range === 'string') deps[name] = range
      }
    }
    out.push({ path, manifest, text, deps })
  }
  return out
}

/** The first file anywhere in the tree whose basename is one of `names`. */
export function firstNamedFile(ctx: DetectorContext, names: readonly string[]): string | null {
  return (
    filesUnder(ctx, '').find((file) => {
      const base = file.slice(file.lastIndexOf('/') + 1)
      return names.includes(base)
    }) ?? null
  )
}
