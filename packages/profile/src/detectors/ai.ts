/**
 * AI / machine learning: notebooks, and the framework a Python project declares.
 *
 * Python dominates AI repositories on GitHub, and the two things an agent needs that the generic
 * Python playbook cannot give are the notebook environment (a `.ipynb` is not a `.py`) and the
 * framework (PyTorch, TensorFlow, Transformers), whose API changes on its own schedule.
 *
 * The framework is read from a dependency declaration, never from an `import` and never from
 * arbitrary manifest text: a repository is a PyTorch project when it depends on `torch`, which
 * is what `pip install` acts on. A comment saying it does not use torch, or a linter's
 * `known-third-party` list, is not a declaration.
 */

import { join } from 'node:path'
import { addStack, type Detector, type DetectorContext, filesUnder, hasFile } from '../detector.ts'
import { evidence } from '../manifest.ts'
import { readText } from '../walk.ts'

function read(ctx: DetectorContext, rel: string): string | null {
  return readText(join(ctx.root, ctx.resolve(rel))).text
}

const ML_PACKAGES: ReadonlyArray<{ stack: string; packages: readonly string[] }> = [
  { stack: 'pytorch', packages: ['torch'] },
  { stack: 'tensorflow', packages: ['tensorflow'] },
  { stack: 'huggingface', packages: ['transformers'] },
]

/** Manifests a Python project states its dependencies in. */
const PYTHON_MANIFESTS = ['pyproject.toml', 'requirements.txt', 'setup.py', 'Pipfile'] as const

interface Declaration {
  /** Normalized distribution name. */
  name: string
  /** 1-based line the declaration is on. */
  line: number
}

/** PEP 503: distribution names compare case-insensitively, with `_` and `.` equal to `-`. */
function normalizePackage(name: string): string {
  return name.trim().toLowerCase().replace(/[_.]+/g, '-')
}

/** The distribution name at the start of a PEP 508 requirement: `torch>=2`, `transformers[torch]`. */
function requirementName(spec: string): string | null {
  const m = /^\s*([A-Za-z0-9][A-Za-z0-9._-]*)/.exec(spec)
  return m === null ? null : normalizePackage(m[1] as string)
}

/** Remove a TOML comment, respecting quoted strings. */
function stripTomlComment(line: string): string {
  let out = ''
  let quote: '"' | "'" | null = null
  let escaped = false
  for (let i = 0; i < line.length; i++) {
    const ch = line[i] as string
    if (quote !== null) {
      out += ch
      if (escaped) escaped = false
      else if (ch === '\\' && quote === '"') escaped = true
      else if (ch === quote) quote = null
      continue
    }
    if (ch === '"' || ch === "'") {
      quote = ch
      out += ch
      continue
    }
    if (ch === '#') break
    out += ch
  }
  return out
}

/** Net array depth added by a line, ignoring brackets inside strings. */
function bracketDelta(line: string): number {
  let depth = 0
  let quote: '"' | "'" | null = null
  let escaped = false
  for (let i = 0; i < line.length; i++) {
    const ch = line[i] as string
    if (quote !== null) {
      if (escaped) escaped = false
      else if (ch === '\\' && quote === '"') escaped = true
      else if (ch === quote) quote = null
      continue
    }
    if (ch === '"' || ch === "'") {
      quote = ch
      continue
    }
    if (ch === '[') depth++
    else if (ch === ']') depth--
  }
  return depth
}

/** Collect the requirement strings on a line of a TOML dependency array. */
function collectQuoted(line: string, lineNo: number, out: Declaration[]): void {
  for (const match of line.matchAll(/"([^"\\]*(?:\\.[^"\\]*)*)"|'([^']*)'/g)) {
    const spec = match[1] ?? match[2] ?? ''
    const name = requirementName(spec)
    if (name !== null) out.push({ name, line: lineNo })
  }
}

/** Sections whose keys are dependencies in Poetry's table form. */
function isPoetryTable(section: string): boolean {
  return (
    section === 'tool.poetry.dependencies' ||
    section === 'tool.poetry.dev-dependencies' ||
    /^tool\.poetry\.group\.[^.]+\.dependencies$/.test(section)
  )
}

/** The package a Poetry dependency subtable (`[tool.poetry.dependencies.torch]`) declares. */
function poetrySubtable(section: string): string | null {
  const m = /^tool\.poetry\.(?:dependencies|dev-dependencies|group\.[^.]+\.dependencies)\.([^.]+)$/.exec(section)
  return m?.[1] ?? null
}

/** Arrays whose entries are requirements. */
function isDependencyArray(section: string, key: string): boolean {
  if (section === 'project') return key === 'dependencies'
  if (section === 'project.optional-dependencies') return true
  if (section === 'dependency-groups') return true
  if (section === 'build-system') return key === 'requires'
  if (section === 'tool.pdm.dev-dependencies') return true
  if (section === 'tool.uv.dev-dependencies') return true
  return false
}

/**
 * Dependency declarations in a `pyproject.toml`.
 *
 * Only dependency-bearing sections are read: `[project]`'s `dependencies`, its optional extras,
 * PEP 735 dependency groups, the build requirements, and Poetry's dependency tables. A
 * `[tool.ruff.lint.isort]` list of third-party names is metadata about the linter, not a
 * dependency, and comments are stripped before anything is parsed.
 */
function tomlDeclarations(text: string): Declaration[] {
  const out: Declaration[] = []
  let section = ''
  let inDepsArray = false
  let depth = 0
  const lines = text.split('\n')

  for (let i = 0; i < lines.length; i++) {
    const lineNo = i + 1
    const line = stripTomlComment(lines[i] ?? '')
    const trimmed = line.trim()
    if (trimmed === '') continue

    const header = /^\[([^\]]+)\]$/.exec(trimmed)
    if (header !== null) {
      section = (header[1] as string).trim().toLowerCase()
      inDepsArray = false
      depth = 0
      continue
    }

    if (inDepsArray) {
      collectQuoted(line, lineNo, out)
      depth += bracketDelta(line)
      if (depth <= 0) {
        inDepsArray = false
        depth = 0
      }
      continue
    }

    if (isPoetryTable(section)) {
      const key = /^([A-Za-z0-9_.-]+)\s*=/.exec(trimmed)?.[1]
      if (key !== undefined) out.push({ name: normalizePackage(key), line: lineNo })
      continue
    }

    const sub = poetrySubtable(section)
    if (sub !== null) {
      out.push({ name: normalizePackage(sub), line: lineNo })
      continue
    }

    const assignment = /^([A-Za-z0-9_.-]+)\s*=\s*\[/.exec(trimmed)
    if (assignment === null) continue
    if (!isDependencyArray(section, assignment[1] as string)) continue

    collectQuoted(line, lineNo, out)
    depth = bracketDelta(line)
    if (depth > 0) inDepsArray = true
  }

  return out
}

/** `requirements.txt`: one requirement per line, with comments and options excluded. */
function requirementsDeclarations(text: string): Declaration[] {
  const out: Declaration[] = []
  const lines = text.split('\n')
  for (let i = 0; i < lines.length; i++) {
    const comment = /(^|\s)#/.exec(lines[i] ?? '')
    const line = (comment === null ? (lines[i] ?? '') : (lines[i] ?? '').slice(0, comment.index)).trim()
    if (line === '' || line.startsWith('-')) continue
    const name = requirementName(line)
    if (name !== null) out.push({ name, line: i + 1 })
  }
  return out
}

/** `Pipfile`: only the `[packages]` and `[dev-packages]` tables. */
function pipfileDeclarations(text: string): Declaration[] {
  const out: Declaration[] = []
  let section = ''
  const lines = text.split('\n')
  for (let i = 0; i < lines.length; i++) {
    const trimmed = (lines[i] ?? '').trim()
    if (trimmed === '' || trimmed.startsWith('#')) continue
    const header = /^\[([^\]]+)\]$/.exec(trimmed)
    if (header !== null) {
      section = (header[1] as string).trim().toLowerCase()
      continue
    }
    if (section !== 'packages' && section !== 'dev-packages') continue
    const key = /^(["']?)([A-Za-z0-9_.-]+)\1\s*=/.exec(trimmed)?.[2]
    if (key !== undefined) out.push({ name: normalizePackage(key), line: i + 1 })
  }
  return out
}

/** The index of the bracket that closes `open` at `start`, or -1. */
function matchingClose(text: string, start: number, open: '[' | '{'): number {
  const close = open === '[' ? ']' : '}'
  let depth = 0
  let quote: '"' | "'" | null = null
  let escaped = false
  for (let i = start; i < text.length; i++) {
    const ch = text[i] as string
    if (quote !== null) {
      if (escaped) escaped = false
      else if (ch === '\\' && quote === '"') escaped = true
      else if (ch === quote) quote = null
      continue
    }
    if (ch === '"' || ch === "'") {
      quote = ch
      continue
    }
    if (ch === open) depth++
    else if (ch === close) {
      depth--
      if (depth === 0) return i
    }
  }
  return -1
}

function lineAt(text: string, index: number): number {
  let line = 1
  for (let i = 0; i < index && i < text.length; i++) if (text[i] === '\n') line++
  return line
}

/** `setup.py`: only the literal requirement lists, not every string in the file. */
function setupPyDeclarations(text: string): Declaration[] {
  const out: Declaration[] = []
  const assignment = /\b(?:install_requires|tests_require|setup_requires|extras_require)\s*=\s*([[{])/g
  for (const match of text.matchAll(assignment)) {
    const open = match[1] as '[' | '{'
    const start = (match.index as number) + match[0].length - 1
    const end = matchingClose(text, start, open)
    if (end < 0) continue
    const block = text.slice(start, end + 1)
    for (const quoted of block.matchAll(/"([^"\\]*(?:\\.[^"\\]*)*)"|'([^']*)'/g)) {
      const spec = quoted[1] ?? quoted[2] ?? ''
      const name = requirementName(spec)
      if (name === null) continue
      out.push({ name, line: lineAt(text, start + (quoted.index as number)) })
    }
  }
  return out
}

function declarationsFor(rel: string, text: string): Declaration[] {
  const base = rel.slice(rel.lastIndexOf('/') + 1)
  switch (base) {
    case 'pyproject.toml':
      return tomlDeclarations(text)
    case 'requirements.txt':
      return requirementsDeclarations(text)
    case 'Pipfile':
      return pipfileDeclarations(text)
    case 'setup.py':
      return setupPyDeclarations(text)
    default:
      return []
  }
}

export const aiDetector: Detector = {
  id: 'ai',
  title: 'AI / machine learning',
  priority: 44,
  matches: (ctx) =>
    filesUnder(ctx, '').some((f) => f.endsWith('.ipynb')) || PYTHON_MANIFESTS.some((f) => hasFile(ctx, f)),
  detect(ctx, draft) {
    const notebooks = filesUnder(ctx, '').filter((f) => f.endsWith('.ipynb'))
    if (notebooks.length > 0) {
      addStack(draft, { id: 'jupyter', version: null, evidence: [notebooks[0] as string] })
    }

    for (const rel of PYTHON_MANIFESTS) {
      if (!hasFile(ctx, rel)) continue
      const text = read(ctx, rel)
      if (text === null) continue
      const declarations = declarationsFor(rel, text)
      for (const { stack, packages } of ML_PACKAGES) {
        const hit = declarations.find((d) => packages.some((p) => normalizePackage(p) === d.name))
        if (hit === undefined) continue
        addStack(draft, { id: stack, version: null, evidence: [evidence(rel, hit.line)] })
      }
    }
  },
}
