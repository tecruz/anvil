/**
 * Node / TypeScript / JavaScript detector.
 *
 * `package.json` is the richest single source of verifiable commands in the JS
 * ecosystem, so this detector does the most work: it maps script names to command kinds,
 * detects the toolchain from dependency names rather than config files (a project can
 * have eslint in devDependencies and no config, which is a real finding), and builds
 * workspace members into a module graph.
 */

import { join } from 'node:path'
import {
  addCommand,
  addLanguage,
  addModule,
  addStack,
  addTool,
  filesUnder,
  hasFile,
  setMonorepo,
  type Detector,
  type DetectorContext,
  type ProfileDraft,
} from '../detector.ts'
import { asObject, asString, evidence, findLine, looseVersion, readJson } from '../manifest.ts'
import { readText } from '../walk.ts'
import type { CommandKind } from '../types.ts'

interface Manifest {
  name: string | null
  scripts: Record<string, string>
  deps: Record<string, string>
  workspaces: string[] | null
  packageManager: string | null
  engines: Record<string, string>
}

function stringMap(v: unknown): Record<string, string> {
  const obj = asObject(v)
  if (obj === null) return {}
  const out: Record<string, string> = {}
  for (const [k, val] of Object.entries(obj)) {
    if (typeof val === 'string') out[k] = val
  }
  return out
}

function readManifest(ctx: DetectorContext, relPath: string): { manifest: Manifest; text: string } | null {
  const { text } = readText(join(ctx.root, relPath))
  if (text === null) return null
  const raw = readJson(ctx, relPath)
  if (raw === null) return null

  let workspaces: string[] | null = null
  if (Array.isArray(raw.workspaces)) {
    workspaces = raw.workspaces.filter((x): x is string => typeof x === 'string')
  } else {
    const ws = asObject(raw.workspaces)
    if (ws !== null && Array.isArray(ws.packages)) {
      workspaces = ws.packages.filter((x): x is string => typeof x === 'string')
    }
  }

  return {
    manifest: {
      name: asString(raw.name),
      scripts: stringMap(raw.scripts),
      deps: { ...stringMap(raw.dependencies), ...stringMap(raw.devDependencies) },
      workspaces,
      packageManager: asString(raw.packageManager),
      engines: stringMap(raw.engines),
    },
    text,
  }
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** Line number of a `"key":` occurrence, for evidence. */
function lineOfKey(text: string, key: string): number | null {
  return findLine(text, new RegExp(`"${escapeRe(key)}"\\s*:`))
}

/**
 * Script-name patterns per command kind.
 *
 * `testFast` is matched before `test` on purpose: `test:fast` must not be captured as a
 * full suite. A match is recorded as `detected`, never `documented` -- a script named
 * `test` can do anything, and only prose counts as documentation.
 */
const SCRIPT_PATTERNS: ReadonlyArray<{ kind: CommandKind; re: RegExp }> = [
  // `watch` is deliberately excluded: a watch process never exits, so it is a
  // developer-loop command, not a fast subset that `crew verify` could run.
  { kind: 'testFast', re: /^(test|it)[-:]?(fast|changed|quick|sharded?|affected)$/i },
  { kind: 'test', re: /^(test|it)[-:]?(spec|ci|all|unit|e2e|integration|coverage|jest|vitest|mocha|run)?$/i },
  { kind: 'build', re: /^(build|compile|bundle|prepack|release)$/i },
  { kind: 'lint', re: /^(lint|style:check|eslint|biome:check)$/i },
  { kind: 'format', re: /^(fmt|format|pretty|prettier|write)$/i },
  { kind: 'typecheck', re: /^(typecheck|type-check|tsc:check|type)$/i },
  { kind: 'run', re: /^(start|serve|dev|watch)$/i },
]

/** Dev-dependency names that prove a tool is in use. */
const TOOL_DEPS: ReadonlyArray<{ match: RegExp; field: 'lint' | 'formatter' | 'typecheck' | 'test'; name: string }> = [
  { match: /^eslint$|^eslint-/, field: 'lint', name: 'eslint' },
  { match: /^@biomejs\/biome$/, field: 'lint', name: 'biome' },
  { match: /^oxlint$/, field: 'lint', name: 'oxlint' },
  { match: /^prettier$/, field: 'formatter', name: 'prettier' },
  { match: /^dprint$/, field: 'formatter', name: 'dprint' },
  { match: /^typescript$/, field: 'typecheck', name: 'typescript' },
  { match: /^jest$|^@jest\//, field: 'test', name: 'jest' },
  { match: /^vitest$|^@vitest\//, field: 'test', name: 'vitest' },
  { match: /^mocha$|^ava$|^tap$/, field: 'test', name: 'mocha/ava' },
  { match: /^playwright$|^@playwright\//, field: 'test', name: 'playwright' },
  { match: /^cypress$/, field: 'test', name: 'cypress' },
]

/** Expand a workspace pattern. Only `dir` and `dir/*` are supported, which covers practice. */
function expandWorkspaceGlobs(ctx: DetectorContext, pattern: string): string[] {
  if (pattern.endsWith('/*')) {
    const base = pattern.slice(0, -2)
    return filesUnder(ctx, base)
      .filter((f) => f.endsWith('/package.json'))
      .map((f) => f.slice(0, -'/package.json'.length))
  }
  return hasFile(ctx, `${pattern}/package.json`) ? [pattern] : []
}

export const nodeDetector: Detector = {
  id: 'node',
  title: 'Node / TypeScript / JavaScript',
  priority: 50,

  matches(ctx) {
    return hasFile(ctx, 'package.json')
  },

  detect(ctx, draft) {
    const root = readManifest(ctx, 'package.json')
    if (root === null) return
    const { manifest, text } = root

    addStack(draft, {
      id: 'node',
      version: manifest.engines['node'] ? looseVersion(manifest.engines['node']) : null,
      evidence: [evidence('package.json', lineOfKey(text, 'engines'))],
    })

    if (manifest.deps['typescript'] !== undefined || hasFile(ctx, 'tsconfig.json') || hasFile(ctx, 'tsconfig.base.json')) {
      addStack(draft, {
        id: 'typescript',
        version: looseVersion(manifest.deps['typescript'] ?? null),
        evidence: [evidence('package.json', lineOfKey(text, 'typescript'))],
      })
    }

    if (manifest.packageManager !== null) {
      const tool = manifest.packageManager.split('@')[0] ?? ''
      if (tool === 'pnpm' || tool === 'yarn' || tool === 'bun') {
        addStack(draft, {
          id: tool,
          version: null,
          evidence: [evidence('package.json', lineOfKey(text, 'packageManager'))],
        })
      }
    }

    if (manifest.workspaces !== null && manifest.workspaces.length > 0) {
      setMonorepo(draft, {
        tool: 'npm',
        evidence: evidence('package.json', lineOfKey(text, 'workspaces')),
        members: [],
      })
    }

    for (const [name] of Object.entries(manifest.scripts)) {
      for (const pattern of SCRIPT_PATTERNS) {
        if (!pattern.re.test(name)) continue
        addCommand(draft, pattern.kind, {
          cmd: `npm run ${name}`,
          source: 'detected',
          evidence: evidence('package.json', lineOfKey(text, name)),
        })
        break
      }
    }

    for (const tool of TOOL_DEPS) {
      for (const [dep, range] of Object.entries(manifest.deps)) {
        if (!tool.match.test(dep)) continue
        addTool(draft, tool.field, tool.name)
        addStack(draft, {
          id: tool.name,
          version: looseVersion(range),
          evidence: [evidence('package.json', lineOfKey(text, dep))],
        })
        break
      }
    }

    if (hasFile(ctx, 'tsconfig.json') || hasFile(ctx, 'tsconfig.base.json')) addTool(draft, 'typecheck', 'typescript')
    if (hasFile(ctx, 'biome.json') || hasFile(ctx, 'biome.jsonc')) {
      addTool(draft, 'lint', 'biome')
      addTool(draft, 'formatter', 'biome')
    } else if (
      hasFile(ctx, 'eslint.config.js') ||
      hasFile(ctx, 'eslint.config.mjs') ||
      hasFile(ctx, '.eslintrc') ||
      hasFile(ctx, '.eslintrc.js') ||
      hasFile(ctx, '.eslintrc.cjs') ||
      hasFile(ctx, '.eslintrc.json')
    ) {
      addTool(draft, 'lint', 'eslint')
    }
    if (
      hasFile(ctx, '.prettierrc') ||
      hasFile(ctx, '.prettierrc.json') ||
      hasFile(ctx, '.prettierrc.js') ||
      hasFile(ctx, 'prettier.config.js')
    ) {
      addTool(draft, 'formatter', 'prettier')
    }
    if (hasFile(ctx, 'Dockerfile') || hasFile(ctx, 'docker-compose.yml') || hasFile(ctx, 'compose.yaml')) {
      addTool(draft, 'container', 'docker')
    }
    if (hasFile(ctx, '.husky/pre-commit') || hasFile(ctx, '.husky/commit-msg') || hasFile(ctx, '.pre-commit-config.yaml')) {
      addTool(draft, 'hooks', 'pre-commit')
    }
    for (const f of ctx.files) {
      if (f.startsWith('.github/workflows/') && f.endsWith('.yml')) addTool(draft, 'ci', f)
      if (f.endsWith('.tf')) addTool(draft, 'iac', f.split('/').slice(0, -1).join('/') || '.')
    }

    if (manifest.workspaces === null) {
      // A single-package project is still a module, and having it in the graph means the
      // module-map rule can describe the whole repo rather than saying "no modules".
      addModule(draft, { id: manifest.name ?? '.', path: '.', kind: 'package', deps: [] })
      return
    }

    // Two passes: collect member names, then resolve internal deps against that name set.
    // Resolving in one pass would miss edges to members declared later.
    const members: Array<{ id: string; path: string; deps: string[] }> = []
    for (const pattern of manifest.workspaces) {
      for (const dir of expandWorkspaceGlobs(ctx, pattern)) {
        const read = readManifest(ctx, `${dir}/package.json`)
        if (read === null) continue
        members.push({
          id: read.manifest.name ?? dir,
          path: dir,
          deps: Object.keys(read.manifest.deps),
        })
      }
    }
    const ids = new Set(members.map((m) => m.id))
    for (const member of members) {
      addModule(draft, {
        id: member.id,
        path: member.path,
        kind: 'package',
        // An internal edge is a dep whose name is a workspace member. Scoped packages
        // are not assumed internal -- the name set is the only reliable test.
        deps: member.deps.filter((d) => ids.has(d) && d !== member.id),
      })
    }
    if (draft.monorepo !== null) {
      draft.monorepo.members = members.map((m) => m.id)
    }
  },
}

/** Node projects report their language from the script detector, not extensions. */
export function nodeLanguage(draft: ProfileDraft, primary = true): void {
  addLanguage(draft, { id: 'javascript', files: 0, primary })
}
