/**
 * Python detector.
 *
 * Python's verification story is the messiest of the six: the test runner, the linter and
 * the type checker are all optional and all differently named, and the dominant failure
 * mode is a project with a `tests/` directory and no way to run it. So this detector
 * stays conservative -- it reports a command only when it can point at the definition.
 */

import { join, posix } from 'node:path'
import {
  addCommand,
  addStack,
  addTool,
  type Detector,
  type DetectorContext,
  hasFile,
  hasFileUnder,
  hookFramework,
  markDepsAnalysed,
  type ProfileDraft,
  setMonorepo,
} from '../detector.ts'
import { matchesGlob } from '../general.ts'
import { evidence, findLine, looseVersion } from '../manifest.ts'
import { readText } from '../walk.ts'

function hasBlockComment(raw: string): boolean {
  let quote: string | null = null
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i]
    if (quote !== null) {
      if (ch === quote) quote = null
      continue
    }
    if (ch === '"' || ch === "'") {
      quote = ch
      continue
    }
    if (ch === '/' && raw[i + 1] === '*') return true
    if (ch === '*' && raw[i + 1] === '/') return true
  }
  return false
}

function linesWithin(text: string, allowed: readonly RegExp[]): boolean {
  for (const raw of text.split('\n')) {
    if (hasBlockComment(raw)) return false
    const line = raw.replace(/#.*$/, '').trimEnd()
    if (line === '' || allowed.some((pattern: RegExp) => pattern.test(line))) continue
    return false
  }
  return true
}
const UV_SAFE = [
  /^\[(?:project|tool\.uv\.workspace|tool\.uv\.sources)\]$/,
  /^(?:name|version)\s*=\s*["'][^"']+["']$/,
  /^dependencies\s*=\s*\[\s*(?:["'][^"'[\]@;\\]+["']\s*,?\s*)*\]$/,
  /^(?:members|exclude)\s*=\s*\[\s*(?:["'][^"'[\]\\]+["']\s*,?\s*)*\]$/,
  /^[\w-]+\s*=\s*\{\s*workspace\s*=\s*true\s*\}$/,
  /^[\w-]+\s*=\s*\{\s*path\s*=\s*["'][^"']+["']\s*\}$/,
]

/** Line-based readers for the flat formats Python uses. */
function readTomlish(ctx: DetectorContext, relPath: string): string | null {
  const { text } = readText(join(ctx.root, ctx.resolve(relPath)))
  return text
}

function depVersion(text: string, dep: string): string | null {
  // Match both PEP 621 `[project] dependencies = ["fastapi>=0.1"]` and requirement lines.
  //
  // The character class is written with **doubled** backslashes, and that is load-bearing.
  // In a template literal `\s` cooks to the letter `s` and `\]` cooks to `]`, so the
  // single-backslash spelling produced the regex `[^"'s,]]` -- which excludes the letter `s`
  // from the version and then requires a literal `]` after it. Every real version therefore
  // failed to capture (`4.2` gave `4.`, which `looseVersion` then rejected), so Python stack
  // versions were silently always null. The doubled spelling is what the regex engine needs.
  const escaped = dep.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const re = new RegExp(`["'\\[]?${escaped}\\s*(?:[<>=!~]=?\\s*([0-9][^"'\\s,\\]]*))?`)
  const m = re.exec(text)
  return looseVersion(m?.[1] ?? null)
}

/** The body of one TOML table, without the header, or null when absent. */
function tomlSection(text: string, header: RegExp): string | null {
  const lines = text.split('\n')
  let active = false
  const out: string[] = []
  for (const line of lines) {
    if (/^\s*\[/.test(line)) {
      if (active) return out.join('\n')
      active = header.test(line)
      continue
    }
    if (active) out.push(line)
  }
  return active ? out.join('\n') : null
}

/** The string items of a TOML array assigned to `key` in `section`. */
function tomlArray(section: string, key: string): string[] {
  const match = new RegExp(`^\\s*${key}\\s*=\\s*\\[`, 'm').exec(section)
  if (match === null) return []
  // A plain `[\s\S]*?\]` stops at a `]` inside a quoted string, so a dependency such as
  // `"worker[cli]>=0.1"` would be truncated before it can be recognized as unsupported.
  // Scan to the bracket that closes the array while respecting quotes.
  let depth = 1
  let quote: string | null = null
  let body = ''
  for (let i = match.index + match[0].length; i < section.length; i++) {
    const ch = section[i] as string
    if (quote !== null) {
      body += ch
      if (ch === '\\' && i + 1 < section.length) {
        body += section[i + 1]
        i++
      } else if (ch === quote) quote = null
      continue
    }
    // Comments are skipped in the same pass that tracks quotes. An apostrophe inside a comment
    // (`# Don't ...`) must not start a quoted string, which would hide the rest of the array.
    if (ch === '#') {
      while (i < section.length && section[i] !== '\n') i++
      if (i < section.length) body += '\n'
      continue
    }
    if (ch === '"' || ch === "'") {
      quote = ch
      body += ch
      continue
    }
    if (ch === '[') depth++
    if (ch === ']') {
      depth--
      if (depth === 0) break
    }
    body += ch
  }
  return [...body.matchAll(/["']((?:[^"'\\]|\\.)*)["']/g)].map((item) => item[1] as string)
}

/** PEP 503 normalisation: dependency names are case- and separator-insensitive. */
function pythonName(name: string): string {
  return name.toLowerCase().replace(/[-_.]+/g, '-')
}

/** The directories a uv workspace declares, after its `exclude` globs. */
function uvMembers(ctx: DetectorContext, text: string, base: string): string[] {
  const section = tomlSection(text, /^\s*\[\s*["']?tool["']?\s*\.\s*["']?uv["']?\s*\.\s*["']?workspace["']?\s*\]/m)
  if (section === null) return []
  const declared = tomlArray(section, 'members')
  const excluded = tomlArray(section, 'exclude')
  const projects = [...ctx.files]
    .filter((file) => file === 'pyproject.toml' || file.endsWith('/pyproject.toml'))
    .map((file) => (file === 'pyproject.toml' ? '.' : file.slice(0, -'/pyproject.toml'.length)))
    .filter((dir) => dir === '.' || base === '.' || dir === base || dir.startsWith(`${base}/`))
    .map((dir) => (base === '.' || dir === '.' ? dir : dir === base ? '.' : dir.slice(base.length + 1)))
  const out = new Set<string>()
  // uv's root project is always a workspace member, even when no glob names it.
  if (tomlSection(text, /^\[project\]/) !== null) out.add('.')
  for (const pattern of declared) {
    for (const dir of projects) {
      if (dir !== '.' && matchesGlob(dir, pattern)) out.add(dir)
    }
  }
  for (const pattern of excluded) {
    for (const dir of [...out]) {
      if (dir !== '.' && matchesGlob(dir, pattern)) out.delete(dir)
    }
  }
  return [...out].sort()
}

interface UvSource {
  workspace: boolean | string | null
  path: string | null
  /** Sentinel for source syntax this reader cannot decide safely. */
  unsupported?: boolean
}

/** `[tool.uv.sources]`: only `workspace = true` or a path names a local dependency. */
function uvSources(manifest: string): Map<string, UvSource> {
  const section = tomlSection(manifest, /^\[tool\.uv\.sources\]/)
  const out = new Map<string, UvSource>()
  if (section === null) return out
  const entry = /(?:^|\n)\s*(?:"([^"]+)"|'([^']+)'|([\w.-]+))\s*=\s*\{([\s\S]*?)\}/g
  for (const match of section.matchAll(entry)) {
    const key = match[1] ?? match[2] ?? match[3]
    const body = match[4] ?? ''
    if (key === undefined) continue
    const workspace = /workspace\s*=\s*(?:true|"([^"]+)"|'([^']+)')/.exec(body)
    const path = /path\s*=\s*["']([^"']+)["']/.exec(body)
    out.set(pythonName(key), {
      workspace: workspace === null ? null : (workspace[1] ?? workspace[2] ?? true),
      path: path?.[1] ?? null,
    })
  }
  // A list of tables or a marker changes which source applies; reading it as absent would report
  // a confident empty graph. Mark the whole manifest's sources as undecidable instead.
  const undecidable = [...section.matchAll(/(?:^|\n)\s*(?:"[^"]+"|'[^']+'|[\w.-]+)\s*=\s*([^\n]+)/g)].some((match) => {
    // A trailing TOML comment is inert: `# old marker = "..."` must not invalidate the source.
    const value = (match[1] ?? '').replace(/\s+#.*$/, '')
    // workspace = "other-workspace" selects a different workspace, not the local boolean case.
    return /^\s*\[/.test(value) || /["']?\bmarker\b["']?\s*=/.test(value) || /\bworkspace\s*=\s*["']/.test(value)
  })
  // A [tool.uv.sources.NAME] sub-table can carry a marker or a different workspace selector.
  const subTables =
    /^\s*\[tool\.uv\.["']?sources["']?\.[^\]]+\]/m.test(manifest) ||
    /^\s*sources\.[\w.-]+\s*=\s*\{[^}]*\bmarker\b/m.test(manifest)
  if (undecidable || subTables) out.set('__unsupported__', { workspace: null, path: null, unsupported: true })
  return out
}

interface UvDependencies {
  deps: string[]
  /** True when the manifest uses syntax this reader cannot decide safely. */
  unsupported: boolean
}

/**
 * Internal edges from uv sources. A name that merely matches a workspace member is not an
 * edge: uv only resolves a dependency locally when `tool.uv.sources` says so. Member sources
 * override root sources, matching uv's own precedence.
 */
function uvDependencies(
  manifest: string,
  names: ReadonlyMap<string, string>,
  idsByPath: ReadonlyMap<string, string>,
  self: string,
  memberPath: string,
  rootSources: ReadonlyMap<string, UvSource>,
  workspaceBase = '.',
): UvDependencies {
  const project = tomlSection(manifest, /^\[project\]/)
  if (project === null) return { deps: [], unsupported: false }
  // An extra selects additional dependencies at install time; reading only the base list would
  // claim a complete graph for a dependency set that can change. Fail closed.
  if (
    /^\s*\[\s*project\.optional-dependencies\s*\]/m.test(manifest) ||
    /^\s*\[\s*dependency-groups\s*\]/m.test(manifest) ||
    /^\s*optional-dependencies\s*=\s*\{/m.test(project)
  )
    return { deps: [], unsupported: true }
  if (tomlArray(project, 'dynamic').some((field) => pythonName(field) === 'dependencies')) {
    return { deps: [], unsupported: true }
  }
  const raw = tomlArray(project, 'dependencies')
  // Extras, direct URLs and environment markers change what a dependency resolves to. Do not
  // silently read them as a plain package name; leave coverage unknown instead.
  if (raw.some((entry) => /[[{@;]/.test(entry))) return { deps: [], unsupported: true }
  const memberSources = uvSources(manifest)
  if (
    memberSources.get('__unsupported__')?.unsupported === true ||
    rootSources.get('__unsupported__')?.unsupported === true
  )
    return { deps: [], unsupported: true }
  const out = new Set<string>()
  for (const dep of raw) {
    const name = /^\s*([A-Za-z0-9][A-Za-z0-9_.-]*)/.exec(dep)?.[1]
    if (name === undefined) continue
    const key = pythonName(name)
    const source = memberSources.get(key) ?? rootSources.get(key)
    if (source === undefined) continue
    if (source.workspace !== null) {
      const id = names.get(key)
      if (id !== undefined && id !== self) out.add(id)
      continue
    }
    if (source.path !== null) {
      const base = memberSources.has(key) ? memberPath : workspaceBase
      const target = posix.normalize(posix.join(base, source.path)).replace(/\/+$/, '')
      const id = idsByPath.get(target)
      if (id !== undefined && id !== self) out.add(id)
    }
  }
  return { deps: [...out].sort(), unsupported: false }
}

export const pythonDetector: Detector = {
  id: 'python',
  title: 'Python',
  priority: 50,

  matches(ctx) {
    return (
      hasFile(ctx, 'pyproject.toml') ||
      hasFile(ctx, 'requirements.txt') ||
      hasFile(ctx, 'setup.py') ||
      hasFile(ctx, 'setup.cfg') ||
      hasFile(ctx, 'Pipfile')
    )
  },

  detect(ctx, draft) {
    const pyproject = hasFile(ctx, 'pyproject.toml') ? readTomlish(ctx, 'pyproject.toml') : null

    if (pyproject !== null) {
      addStack(draft, {
        id: 'python',
        version: null,
        evidence: [evidence('pyproject.toml', findLine(pyproject, /^\s*requires-python/))],
      })

      // PEP 621 build backend is a strong project-shape signal.
      if (/\[\s*project\s*\]/.test(pyproject) || /\[project\]/.test(pyproject)) {
        addStack(draft, {
          id: 'pep621',
          version: null,
          evidence: [evidence('pyproject.toml', findLine(pyproject, /\[project\]/))],
        })
      }
      if (/\[tool\.(uv|poetry|hatch|flit|setuptools)\]/.test(pyproject)) {
        const line = findLine(pyproject, /\[tool\.(uv|poetry|hatch|flit|setuptools)\]/)
        addStack(draft, {
          id: 'uv-or-poetry',
          version: null,
          evidence: [evidence('pyproject.toml', line)],
        })
      }
      if (/\[tool\.pytest/.test(pyproject)) {
        addTool(draft, 'test', 'pytest')
        addCommand(draft, 'test', {
          cmd: 'pytest',
          source: 'detected',
          evidence: evidence('pyproject.toml', findLine(pyproject, /\[tool\.pytest/)),
        })
      }
      if (/\[tool\.ruff/.test(pyproject)) {
        addTool(draft, 'lint', 'ruff')
        addCommand(draft, 'lint', {
          cmd: 'ruff check .',
          source: 'detected',
          evidence: evidence('pyproject.toml', findLine(pyproject, /\[tool\.ruff/)),
        })
        addCommand(draft, 'format', {
          cmd: 'ruff format .',
          source: 'detected',
          evidence: evidence('pyproject.toml', findLine(pyproject, /\[tool\.ruff/)),
        })
      }
      if (/\[tool\.mypy/.test(pyproject)) {
        addTool(draft, 'typecheck', 'mypy')
        addCommand(draft, 'typecheck', {
          cmd: 'mypy .',
          source: 'detected',
          evidence: evidence('pyproject.toml', findLine(pyproject, /\[tool\.mypy/)),
        })
      }
      if (/\[tool\.black/.test(pyproject)) {
        addTool(draft, 'formatter', 'black')
        addCommand(draft, 'format', {
          cmd: 'black .',
          source: 'detected',
          evidence: evidence('pyproject.toml', findLine(pyproject, /\[tool\.black/)),
        })
      }
      // Build backends imply a build step.
      if (/\[build-system\]/.test(pyproject) && /requires\s*=/.test(pyproject)) {
        addCommand(draft, 'build', {
          cmd: 'python -m build',
          source: 'inferred',
        })
      }
    }

    if (hasFile(ctx, 'uv.lock')) {
      addStack(draft, { id: 'uv', version: null, evidence: ['uv.lock'] })
      setMonorepo(draft, { tool: 'uv', evidence: 'uv.lock', members: [] })
    }

    // Dependencies from the flat formats, so the stack list is comparable across ecosystems.
    const sources: Array<{ text: string; file: string }> = []
    for (const f of ['requirements.txt', 'requirements-dev.txt', 'setup.py', 'Pipfile', 'pyproject.toml']) {
      if (!hasFile(ctx, f)) continue
      const t = readTomlish(ctx, f)
      if (t !== null) sources.push({ text: t, file: f })
    }
    // Match the dependency wherever it is *declared*, which is mid-line in a PEP 621
    // `dependencies = ["django>=4.2"]` array and at the line start in a `requirements.txt`.
    // The old `^django` with no `m` flag meant "the file begins with django", so a framework
    // declared anywhere but the first line was never detected at all.
    //
    // Each pattern is the same shape `depVersion` parses, so the detection and the version
    // cannot disagree about whether the dependency is there.
    const KNOWN: Array<[string, RegExp]> = [
      ['django', /["']?django\b/i],
      ['flask', /["']?flask\b/i],
      ['fastapi', /["']?fastapi\b/i],
      ['pytest', /["']?pytest\b/i],
      ['ruff', /["']?ruff\b/i],
      ['mypy', /["']?mypy\b/i],
      ['black', /["']?black\b/i],
      ['poetry', /["']?poetry\b/i],
    ]
    for (const [id, re] of KNOWN) {
      for (const { text, file } of sources) {
        if (!re.test(text)) continue
        addStack(draft, {
          id,
          version: depVersion(text, id),
          evidence: [evidence(file, findLine(text, re))],
        })
        break
      }
    }

    // A test layout with no runnable command is the dominant Python readiness gap, so
    // only offer a command when something in the repo actually implies one. Marked
    // `inferred` -- nothing defines it -- so `ship` will not execute it unprobed.
    const hasTestLayout = hasFileUnder(ctx, 'tests') || hasFile(ctx, 'test') || hasFile(ctx, 'tests.py')
    if (hasTestLayout && draft.commands.test === undefined) {
      addCommand(draft, 'test', { cmd: 'pytest', source: 'inferred' })
    }

    if (hasFile(ctx, 'Dockerfile')) addTool(draft, 'container', 'docker')
    const hook = hookFramework(ctx)
    if (hook !== null) addTool(draft, 'hooks', hook)
    for (const f of ctx.files) {
      if (f.startsWith('.github/workflows/') && f.endsWith('.yml')) addTool(draft, 'ci', f)
    }

    // uv workspaces: only directories named by `members` are modules. A pyproject.toml in
    // an unrelated example directory must not silently enter the graph.
    const workspaceFile = [...ctx.files].find((file) => {
      if (file !== 'pyproject.toml' && !file.endsWith('/pyproject.toml')) return false
      const text = readTomlish(ctx, file)
      return text !== null && /^\s*\[\s*["']?tool["']?\s*\.\s*["']?uv["']?\s*\.\s*["']?workspace["']?\s*\]/m.test(text)
    })
    const oddUvHeader = [...ctx.files].some((file) => {
      if (file !== 'pyproject.toml' && !file.endsWith('/pyproject.toml')) return false
      const text = readTomlish(ctx, file)
      return text !== null && /\[\s*tool\s*\.\s*uv\s*\.\s*["']workspace["']\s*\]/.test(text)
    })
    if (oddUvHeader) {
      for (const file of ctx.files) {
        if (file !== 'pyproject.toml' && !file.endsWith('/pyproject.toml')) return
        const text = readTomlish(ctx, file)
        if (text === null || !/\[\s*tool\s*\.\s*uv\s*\.\s*["']workspace["']\s*\]/.test(text)) continue
        draft.depsUnknownReasons.set(
          file === 'pyproject.toml' ? '.' : file.slice(0, -'/pyproject.toml'.length),
          'unsupported dependency syntax; dependencies left unknown',
        )
      }
    }
    if (workspaceFile !== undefined) {
      const workspaceBase = workspaceFile === 'pyproject.toml' ? '.' : workspaceFile.slice(0, -'/pyproject.toml'.length)
      const workspaceText = readTomlish(ctx, workspaceFile) ?? ''
      setMonorepo(draft, {
        tool: 'uv',
        evidence: evidence(workspaceFile, findLine(workspaceText, /^\[tool\.uv\.workspace\]/)),
        members: [],
      })
      const members: Array<{ id: string; path: string; manifest: string | null }> = []
      for (const path of uvMembers(ctx, workspaceText, workspaceBase)) {
        const relativePath = workspaceBase === '.' ? path : path === '.' ? workspaceBase : `${workspaceBase}/${path}`
        const manifest = relativePath === '.' ? 'pyproject.toml' : `${relativePath}/pyproject.toml`
        if (!ctx.files.has(ctx.resolve(manifest))) continue
        const inner = readTomlish(ctx, manifest)
        const name = inner === null ? null : (/^\s*name\s*=\s*["']([^"']+)["']/m.exec(inner)?.[1] ?? null)
        const id = name ?? relativePath
        addModulePy(draft, id, relativePath)
        members.push({ id, path: relativePath, manifest: inner })
      }
      // A dependency is internal only when tool.uv.sources marks it local. Root sources
      // apply to every member; a member's own sources override them. An unreadable manifest
      // or unsupported dependency syntax stays unknown rather than analysed-empty.
      const names = new Map<string, string>()
      const idsByPath = new Map<string, string>()
      for (const member of members) {
        names.set(pythonName(member.id), member.id)
        idsByPath.set(member.path, member.id)
      }
      const uvSafe =
        !oddUvHeader &&
        linesWithin(workspaceText, UV_SAFE) &&
        members.every((member) => (member.manifest === null ? false : linesWithin(member.manifest, UV_SAFE)))
      const rootSources = uvSources(workspaceText)
      for (const member of members) {
        if (member.manifest === null) continue
        const resolved = uvDependencies(
          member.manifest,
          names,
          idsByPath,
          member.id,
          member.path,
          rootSources,
          workspaceBase,
        )
        if (!uvSafe || resolved.unsupported) {
          draft.depsUnknownReasons.set(member.id, 'unsupported dependency syntax; dependencies left unknown')
          const memberModule = draft.modules.find((module) => module.id === member.id)
          if (memberModule !== undefined) memberModule.deps = []
          continue
        }
        const existing = draft.modules.find((module) => module.id === member.id)
        if (existing !== undefined) existing.deps = resolved.deps
        markDepsAnalysed(draft, member.id)
      }
      if (draft.monorepo !== null) draft.monorepo.members = members.map((member) => member.id)
    }
  },
}

function addModulePy(draft: ProfileDraft, id: string, path: string): void {
  if (!draft.modules.some((m) => m.id === id)) {
    draft.modules.push({ id, path, kind: 'package', deps: [] })
  }
}
