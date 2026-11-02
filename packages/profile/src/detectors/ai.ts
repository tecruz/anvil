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

interface ArrayScan {
  /** Brackets open, counting the array itself. */
  bracketDepth: number
  /** Braces open inside the array, for inline tables such as `{include-group = "dev"}`. */
  braceDepth: number
}

/**
 * Collect requirement strings at the top level of a TOML array.
 *
 * Strings inside an inline table are references (a dependency-group name, a table field),
 * not requirements: `dev = [{include-group = "torch"}]` does not depend on a package called
 * `torch`. Only a bare string element is a declaration.
 */
function collectArrayStrings(line: string, lineNo: number, out: Declaration[], scan: ArrayScan): void {
  let i = 0
  while (i < line.length) {
    const ch = line[i] as string
    if (ch === '"' || ch === "'") {
      i++
      let value = ''
      while (i < line.length) {
        const c = line[i] as string
        if (c === '\\' && ch === '"') {
          value += line[i + 1] ?? ''
          i += 2
          continue
        }
        if (c === ch) break
        value += c
        i++
      }
      if (i < line.length) i++
      if (scan.bracketDepth === 1 && scan.braceDepth === 0) {
        const name = requirementName(value)
        if (name !== null) out.push({ name, line: lineNo })
      }
      continue
    }
    if (ch === '[') scan.bracketDepth++
    else if (ch === ']') scan.bracketDepth--
    else if (ch === '{') scan.braceDepth++
    else if (ch === '}') scan.braceDepth--
    i++
  }
}

/** A TOML assignment's key, quoted or bare, and the value after `=`. */
function tomlAssignment(line: string): { key: string; value: string } | null {
  const m = /^(?:"([^"]+)"|'([^']+)'|([A-Za-z0-9_.-]+))\s*=\s*(.*)$/.exec(line)
  if (m === null) return null
  return { key: m[1] ?? m[2] ?? (m[3] as string), value: m[4] ?? '' }
}

/** Strip the quotes from a TOML key such as `"torch"`. */
function unquoteTomlKey(key: string): string {
  const trimmed = key.trim()
  if (trimmed.length < 2) return trimmed
  const first = trimmed[0]
  const last = trimmed[trimmed.length - 1]
  return (first === '"' && last === '"') || (first === "'" && last === "'") ? trimmed.slice(1, -1) : trimmed
}

/** Sections whose keys are dependencies in Poetry's table form. */
function isPoetryTable(section: string): boolean {
  return (
    section === 'tool.poetry.dependencies' ||
    section === 'tool.poetry.dev-dependencies' ||
    /^tool\.poetry\.group\..+?\.dependencies$/.test(section)
  )
}

/** The package a Poetry dependency subtable (`[tool.poetry.dependencies.torch]`) declares. */
function poetrySubtable(section: string): string | null {
  const m = /^tool\.poetry\.(?:dependencies|dev-dependencies|group\..+?\.dependencies)\.(.+)$/.exec(section)
  return m?.[1] === undefined ? null : unquoteTomlKey(m[1])
}

/** Arrays whose entries are requirements. */
function isDependencyArray(section: string, key: string): boolean {
  if (section === 'project') return key === 'dependencies'
  if (section === 'project.optional-dependencies') return true
  if (section === 'dependency-groups') return true
  if (section === 'build-system') return key === 'requires'
  if (section === 'tool.pdm.dev-dependencies') return true
  // uv's development dependencies are a key in `[tool.uv]`, not a table of their own.
  if (section === 'tool.uv') return key === 'dev-dependencies'
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
  const scan: ArrayScan = { bracketDepth: 0, braceDepth: 0 }
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
      scan.bracketDepth = 0
      scan.braceDepth = 0
      continue
    }

    if (inDepsArray) {
      collectArrayStrings(line, lineNo, out, scan)
      if (scan.bracketDepth <= 0) {
        inDepsArray = false
        scan.bracketDepth = 0
        scan.braceDepth = 0
      }
      continue
    }

    if (isPoetryTable(section)) {
      const assignment = tomlAssignment(trimmed)
      if (assignment !== null) out.push({ name: normalizePackage(unquoteTomlKey(assignment.key)), line: lineNo })
      continue
    }

    const sub = poetrySubtable(section)
    if (sub !== null) {
      out.push({ name: normalizePackage(sub), line: lineNo })
      continue
    }

    const assignment = tomlAssignment(trimmed)
    if (assignment === null) continue
    const key = unquoteTomlKey(assignment.key)
    if (!isDependencyArray(section, key)) continue
    const value = assignment.value.trimStart()
    if (!value.startsWith('[')) continue

    scan.bracketDepth = 0
    scan.braceDepth = 0
    collectArrayStrings(value, lineNo, out, scan)
    if (scan.bracketDepth > 0) inDepsArray = true
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

interface Range {
  start: number
  end: number
}

interface StringToken {
  /** Offset of the opening quote. */
  start: number
  /** Offset just past the closing quote. */
  end: number
  value: string
}

interface PythonMask {
  /** Comments and string contents blanked; quotes and newlines preserved. */
  structural: string
  /** Comments blanked; string literals preserved. */
  nocomment: string
  strings: StringToken[]
}

interface RequirementToken {
  spec: string
  /** Offset of the string literal that declared it. */
  offset: number
}

/**
 * Blank Python comments and string contents without moving anything.
 *
 * `setup.py` is Python, not a data file: `#` starts a comment and brackets inside a string are
 * text. Parsing the raw file lets a comment such as `# keep the ] below` close a requirement
 * list early, or a docstring's example dependency become a declaration. Both masks preserve
 * offsets so evidence still points at the original line.
 */
function maskPython(text: string): PythonMask {
  const structural = text.split('')
  const nocomment = text.split('')
  const strings: StringToken[] = []
  const blank = (from: number, to: number): void => {
    for (let j = from; j < to; j++) structural[j] = ' '
  }
  let i = 0
  while (i < text.length) {
    const ch = text[i] as string
    if (ch === '#') {
      while (i < text.length && text[i] !== '\n') {
        structural[i] = ' '
        nocomment[i] = ' '
        i++
      }
      continue
    }
    if (ch === '"' || ch === "'") {
      const quote = ch
      const triple = quote.repeat(3)
      if (text.slice(i, i + 3) === triple) {
        const start = i
        const contentStart = i + 3
        i += 3
        let value = ''
        while (i < text.length && text.slice(i, i + 3) !== triple) {
          if (text[i] === '\\') {
            value += text[i + 1] ?? ''
            i += 2
            continue
          }
          value += text[i]
          i++
        }
        const contentEnd = i
        if (i < text.length) i += 3
        blank(contentStart, contentEnd)
        strings.push({ start, end: i, value })
        continue
      }
      const start = i
      i++
      let value = ''
      while (i < text.length) {
        const c = text[i] as string
        if (c === '\\') {
          value += text[i + 1] ?? ''
          i += 2
          continue
        }
        if (c === quote || c === '\n') break
        value += c
        i++
      }
      const contentEnd = i
      if (text[i] === quote) i++
      blank(start + 1, contentEnd)
      strings.push({ start, end: i, value })
      continue
    }
    i++
  }
  return { structural: structural.join(''), nocomment: nocomment.join(''), strings }
}

function trimRange(text: string, range: Range): Range {
  let start = range.start
  let end = range.end
  while (start < end && /\s/.test(text[start] as string)) start++
  while (end > start && /\s/.test(text[end - 1] as string)) end--
  return { start, end }
}

/** The index of the bracket that closes the one at `start`, or -1. */
function matchingBracket(text: string, start: number): number {
  const open = text[start]
  const close = open === '[' ? ']' : open === '{' ? '}' : open === '(' ? ')' : null
  if (close === null) return -1
  let depth = 0
  for (let i = start; i < text.length; i++) {
    const ch = text[i] as string
    if (ch === open) depth++
    else if (ch === close) {
      depth--
      if (depth === 0) return i
    }
  }
  return -1
}

/** Split a range on `separator`, ignoring separators inside brackets. */
function splitTopLevel(text: string, range: Range, separator: string): Range[] {
  const out: Range[] = []
  let depth = 0
  let start = range.start
  for (let i = range.start; i < range.end; i++) {
    const ch = text[i] as string
    if (ch === '(' || ch === '[' || ch === '{') depth++
    else if (ch === ')' || ch === ']' || ch === '}') depth = Math.max(0, depth - 1)
    else if (ch === separator && depth === 0) {
      out.push({ start, end: i })
      start = i + 1
    }
  }
  if (start < range.end) out.push({ start, end: range.end })
  return out
}

/** The first `target` at bracket depth zero, or -1. */
function topLevelIndex(text: string, range: Range, target: string): number {
  let depth = 0
  for (let i = range.start; i < range.end; i++) {
    const ch = text[i] as string
    if (ch === '(' || ch === '[' || ch === '{') depth++
    else if (ch === ')' || ch === ']' || ch === '}') depth = Math.max(0, depth - 1)
    else if (depth === 0 && ch === target) {
      if (target === '=' && (text[i + 1] === '=' || '=!<>'.includes(text[i - 1] as string))) continue
      return i
    }
  }
  return -1
}

/** The string literal a range consists of, allowing a Python `r`/`f`/`b` prefix. */
function stringTokenFor(mask: PythonMask, range: Range): StringToken | null {
  const trimmed = trimRange(mask.structural, range)
  for (const token of mask.strings) {
    if (token.start < trimmed.start || token.end > trimmed.end) continue
    if (mask.nocomment.slice(token.end, trimmed.end).trim() !== '') continue
    const prefix = mask.nocomment.slice(trimmed.start, token.start).trim()
    if (prefix === '' || /^[rRbBuUfF]{1,2}$/.test(prefix)) return token
  }
  return null
}

interface Statement {
  start: number
  end: number
  /** Comment-free source text for the statement. */
  text: string
}

function pythonStatements(mask: PythonMask): Statement[] {
  const { structural, nocomment } = mask
  const out: Statement[] = []
  let start = 0
  let depth = 0
  const push = (end: number): void => {
    const text = nocomment.slice(start, end)
    if (text.trim() !== '') out.push({ start, end, text })
  }
  for (let i = 0; i < structural.length; i++) {
    const ch = structural[i] as string
    if (ch === '(' || ch === '[' || ch === '{') depth++
    else if (ch === ')' || ch === ']' || ch === '}') depth = Math.max(0, depth - 1)
    else if (ch === '\\' && structural[i + 1] === '\n') {
      i++
    } else if ((ch === '\n' || ch === ';') && depth === 0) {
      push(i)
      start = i + 1
    }
  }
  push(structural.length)
  return out
}

interface Binding {
  /** The assigned name. */
  base: string
  /** The string key for `base["key"] = ...`, or null for a simple assignment. */
  key: string | null
  range: Range
  /** Offset of the statement, so a reference resolves against source order. */
  order: number
}

/** The leading whitespace before the line an offset sits on. */
function indentationAt(text: string, index: number): number {
  const lineStart = text.lastIndexOf('\n', index - 1) + 1
  let n = 0
  while (lineStart + n < text.length && (text[lineStart + n] === ' ' || text[lineStart + n] === '\t')) n++
  return n
}

/**
 * Module-level assignments in source order, skipping function and class bodies.
 *
 * `setup.py` runs top to bottom, and a name bound inside an uncalled helper is not the value
 * `setup()` receives. The statement offset is kept so a reference resolves against the bindings
 * that exist where the call is written, not the last binding anywhere in the file.
 */
function collectAssignments(mask: PythonMask, statements: Statement[]): Binding[] {
  const out: Binding[] = []
  let bodyIndent: number | null = null
  for (const stmt of statements) {
    const indent = indentationAt(mask.nocomment, stmt.start)
    if (bodyIndent !== null && indent > bodyIndent) continue
    bodyIndent = null

    if (/^(?:async\s+)?(?:def|class)\b/.test(stmt.text.trimStart())) {
      bodyIndent = indent
      continue
    }

    const structural = mask.structural.slice(stmt.start, stmt.end)
    const eq = topLevelIndex(structural, { start: 0, end: structural.length }, '=')
    if (eq < 0) continue
    const left = stmt.text.slice(0, eq).trim()
    const range = { start: stmt.start + eq + 1, end: stmt.end }
    const subscript = /^([A-Za-z_][A-Za-z0-9_]*)\s*\[\s*(?:"([^"]*)"|'([^']*)')\s*\]$/.exec(left)
    if (subscript !== null) {
      out.push({ base: subscript[1] as string, key: subscript[2] ?? subscript[3] ?? '', range, order: stmt.start })
      continue
    }
    const name = /^([A-Za-z_][A-Za-z0-9_]*)(?:\s*:[^=]+)?$/.exec(left)?.[1]
    if (name !== undefined) out.push({ base: name, key: null, range, order: stmt.start })
  }
  return out
}

interface FunctionDef {
  /** Positional parameter names. */
  params: string[]
  /** The `*args` parameter name, if the function takes one. */
  varargs: string | null
  /** The range of the expression after the function's single `return`. */
  body: Range
}

/**
 * Local function definitions whose body is a single `return`.
 *
 * These are the lookup helpers a `setup.py` builds its requirement lists with. A body with more
 * steps is not a plain projection and is left unresolved, so an unrelated helper that happens to
 * share a name cannot claim its call arguments as distributions.
 */
function collectFunctions(mask: PythonMask, statements: Statement[]): Map<string, FunctionDef> {
  const { structural } = mask
  const out = new Map<string, FunctionDef>()
  for (let i = 0; i < statements.length; i++) {
    const stmt = statements[i] as Statement
    const indent = indentationAt(mask.nocomment, stmt.start)
    const header = /^(?:async\s+)?def\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(([^)]*)\)/.exec(
      structural.slice(stmt.start, stmt.end).trim(),
    )
    if (header === null) continue
    const params: string[] = []
    let varargs: string | null = null
    const raw = header[2] ?? ''
    for (const part of splitTopLevel(raw, { start: 0, end: raw.length }, ',')) {
      const token = raw.slice(part.start, part.end).trim()
      const name = /^(\*\*\s*|\*\s*)?([A-Za-z_][A-Za-z0-9_]*)/.exec(token)
      if (name === null) continue
      if (name[1]?.trim() === '*') varargs = name[2] as string
      else if (name[1] === undefined) params.push(name[2] as string)
    }
    if (varargs === null) continue

    for (let j = i + 1; j < statements.length; j++) {
      const body = statements[j] as Statement
      if (indentationAt(mask.nocomment, body.start) <= indent) break
      const text = structural.slice(body.start, body.end)
      if (!/^return\s+/.test(text.trim())) continue
      const offset = body.start + text.indexOf('return') + 'return'.length
      out.set(header[1] as string, { params, varargs, body: { start: offset, end: body.end } })
      break
    }
  }
  return out
}

interface EvalContext {
  mask: PythonMask
  bindings: Binding[]
  functions: Map<string, FunctionDef>
  /** Offset of the `setup(...)` call being evaluated; only earlier bindings count. */
  callOffset: number
  seen: Set<string>
}

const SETUP_DEPENDENCY_KEYS: ReadonlySet<string> = new Set([
  'install_requires',
  'tests_require',
  'setup_requires',
  'extras_require',
])

/** The bindings for a name that are in scope where the call is written. */
function bindingsFor(ctx: EvalContext, base: string): Binding[] {
  return ctx.bindings.filter((b) => b.base === base && b.order < ctx.callOffset)
}

/** The last simple assignment to a name before the call, if any. */
function lastSimple(ctx: EvalContext, name: string): Binding | null {
  let out: Binding | null = null
  for (const b of ctx.bindings) {
    if (b.key === null && b.base === name && b.order < ctx.callOffset) out = b
  }
  return out
}

/** True for a dict-comprehension literal such as `{name: name for name in deps}`. */
function isDictComprehension(mask: PythonMask, range: Range): boolean {
  const { structural } = mask
  const trimmed = trimRange(structural, range)
  if (structural[trimmed.start] !== '{') return false
  const close = matchingBracket(structural, trimmed.start)
  if (close !== trimmed.end - 1) return false
  return /\bfor\b/.test(structural.slice(trimmed.start + 1, trimmed.end - 1))
}

/**
 * The string-keyed entries of a dict literal, or null when the value is not a literal dict.
 *
 * A comprehension is a lookup table, not a declaration, so it is not a literal here.
 */
function literalDictEntries(mask: PythonMask, range: Range): Map<string, Range> | null {
  const { structural } = mask
  const trimmed = trimRange(structural, range)
  if (structural[trimmed.start] !== '{') return null
  const close = matchingBracket(structural, trimmed.start)
  if (close !== trimmed.end - 1) return null
  const inner = { start: trimmed.start + 1, end: trimmed.end - 1 }
  if (/\bfor\b/.test(structural.slice(inner.start, inner.end))) return null
  const out = new Map<string, Range>()
  for (const entry of splitTopLevel(structural, inner, ',')) {
    const colon = topLevelIndex(structural, entry, ':')
    if (colon < 0) continue
    const entryKey = stringTokenFor(mask, trimRange(structural, { start: entry.start, end: colon }))
    if (entryKey === null) continue
    out.set(entryKey.value, { start: colon + 1, end: entry.end })
  }
  return out
}

/** Evaluate a Python expression to the requirement strings it statically contains. */
function evalRange(range: Range, ctx: EvalContext, depth = 0): RequirementToken[] {
  if (depth > 32) return []
  const { structural } = ctx.mask
  const trimmed = trimRange(structural, range)
  if (trimmed.start >= trimmed.end) return []

  const token = stringTokenFor(ctx.mask, trimmed)
  if (token !== null) return [{ spec: token.value, offset: token.start }]

  const first = structural[trimmed.start] as string
  if (first === '[' || first === '(' || first === '{') {
    const close = matchingBracket(structural, trimmed.start)
    if (close === trimmed.end - 1) {
      if (first === '{') {
        const entries = literalDictEntries(ctx.mask, trimmed)
        if (entries === null) return []
        const out: RequirementToken[] = []
        for (const value of entries.values()) out.push(...evalRange(value, ctx, depth + 1))
        return out
      }
      const inner = { start: trimmed.start + 1, end: trimmed.end - 1 }
      const out: RequirementToken[] = []
      for (const part of splitTopLevel(structural, inner, ',')) {
        out.push(...evalRange(part, ctx, depth + 1))
      }
      return out
    }
  }

  // Concatenation binds loosest, so it is split before a single call or subscript is read. This
  // is what lets `extras["base"] + ["torch"]` resolve both of its operands.
  const plus = topLevelIndex(structural, trimmed, '+')
  if (plus >= 0) {
    const left = { start: trimmed.start, end: plus }
    const right = { start: plus + 1, end: trimmed.end }
    const leftString = stringTokenFor(ctx.mask, trimRange(structural, left))
    const rightString = stringTokenFor(ctx.mask, trimRange(structural, right))
    // Two adjacent string literals are one requirement, not two: `"torch" + "vision"`.
    if (leftString !== null && rightString !== null) {
      return [{ spec: leftString.value + rightString.value, offset: leftString.start }]
    }
    return [...evalRange(left, ctx, depth + 1), ...evalRange(right, ctx, depth + 1)]
  }

  const call = /^([A-Za-z_][A-Za-z0-9_]*)\s*\(/.exec(structural.slice(trimmed.start, trimmed.end))
  if (call !== null) {
    const name = call[1] as string
    const open = trimmed.start + call[0].length - 1
    const close = matchingBracket(structural, open)
    if (close === trimmed.end - 1) {
      const args = splitTopLevel(structural, { start: open + 1, end: close }, ',')
      if (name === 'list' || name === 'tuple' || name === 'set') {
        return args.flatMap((arg) => evalRange(arg, ctx, depth + 1))
      }
      return resolveHelperCall(name, args, ctx, depth + 1)
    }
  }

  const subscript = /^([A-Za-z_][A-Za-z0-9_]*)\s*\[/.exec(structural.slice(trimmed.start, trimmed.end))
  if (subscript !== null) {
    const base = subscript[1] as string
    const open = trimmed.start + subscript[0].length - 1
    const close = matchingBracket(structural, open)
    if (close === trimmed.end - 1) {
      const key = stringTokenFor(ctx.mask, trimRange(structural, { start: open + 1, end: close }))
      if (key !== null) return evalSubscript(base, key.value, ctx, depth + 1)
    }
    return []
  }

  const identifier = structural.slice(trimmed.start, trimmed.end)
  if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(identifier)) {
    return evalName(identifier, ctx, depth + 1)
  }

  return []
}

/**
 * A local helper that projects its arguments through a lookup table.
 *
 * `def deps_list(*pkgs): return [deps[pkg] for pkg in pkgs]` is how a real project maps a package
 * name to its pinned requirement. The arguments are distributions only when the body is exactly
 * this shape: a single `return` of a one-clause comprehension over the varargs parameter. The
 * name alone is not evidence, so a helper with any other body resolves to nothing.
 */
function resolveHelperCall(name: string, args: readonly Range[], ctx: EvalContext, depth: number): RequirementToken[] {
  const fn = ctx.functions.get(name)
  if (fn === undefined || fn.varargs === null) return []
  const { structural } = ctx.mask
  const trimmed = trimRange(structural, fn.body)
  if (structural[trimmed.start] !== '[') return []
  const close = matchingBracket(structural, trimmed.start)
  if (close !== trimmed.end - 1) return []
  const inner = structural.slice(trimmed.start + 1, trimmed.end - 1)
  const comprehension = /^([\s\S]*?)\s+for\s+([A-Za-z_][A-Za-z0-9_]*)\s+in\s+([A-Za-z_][A-Za-z0-9_]*)$/.exec(
    inner.trim(),
  )
  if (comprehension === null) return []
  const element = (comprehension[1] as string).trim()
  const loopVar = comprehension[2] as string
  if (comprehension[3] !== fn.varargs) return []
  const projection = /^([A-Za-z_][A-Za-z0-9_]*)\s*\[\s*([A-Za-z_][A-Za-z0-9_]*)\s*\]$/.exec(element)
  if (projection === null && element !== loopVar) return []

  const out: RequirementToken[] = []
  for (const arg of args) {
    const trimmedArg = trimRange(structural, arg)
    // A trailing comma leaves an empty final argument; it declares nothing.
    if (trimmedArg.start >= trimmedArg.end) continue
    const token = stringTokenFor(ctx.mask, trimmedArg)
    if (token === null) return [] // a computed argument cannot be read statically
    if (projection === null) {
      out.push({ spec: token.value, offset: token.start })
      continue
    }
    if ((projection[2] as string) !== loopVar) return []
    const mapping = projection[1] as string
    const simple = lastSimple(ctx, mapping)
    const dict = simple === null ? null : literalDictEntries(ctx.mask, simple.range)
    if (dict !== null) {
      const value = dict.get(token.value)
      if (value !== undefined) out.push(...evalRange(value, ctx, depth + 1))
      continue
    }
    // An unresolvable lookup table is trusted only when it is a comprehension, the shape real
    // projects use to alias a pinned requirement back to its own name.
    if (simple !== null && isDictComprehension(ctx.mask, simple.range)) {
      out.push({ spec: token.value, offset: token.start })
      continue
    }
    return []
  }
  return out
}

function evalName(name: string, ctx: EvalContext, depth: number): RequirementToken[] {
  if (ctx.seen.has(name)) return []
  ctx.seen.add(name)
  try {
    const simple = lastSimple(ctx, name)
    const subs = bindingsFor(ctx, name).filter((b) => b.key !== null)
    if (simple !== null) {
      const dict = literalDictEntries(ctx.mask, simple.range)
      if (dict !== null) {
        // The literal defines the base value; later subscript assignments overwrite keys, and
        // earlier ones are stale because the dict was rebuilt since.
        for (const b of subs) {
          if (b.order > simple.order) dict.set(b.key as string, b.range)
        }
        const out: RequirementToken[] = []
        for (const value of dict.values()) out.push(...evalRange(value, ctx, depth + 1))
        return out
      }
    }
    const out: RequirementToken[] = []
    if (simple !== null) out.push(...evalRange(simple.range, ctx, depth + 1))
    // A dict populated only by `name["key"] = ...` has no single literal value; every key is
    // part of the declaration, which is how `extras_require=extras` carries its extras.
    for (const b of subs) out.push(...evalRange(b.range, ctx, depth + 1))
    return out
  } finally {
    ctx.seen.delete(name)
  }
}

function evalSubscript(base: string, key: string, ctx: EvalContext, depth: number): RequirementToken[] {
  let sub: Binding | null = null
  for (const b of bindingsFor(ctx, base)) {
    if (b.key === key) sub = b
  }
  const simple = lastSimple(ctx, base)
  // A dict rebuilt after the subscript assignment replaces it entirely.
  if (simple !== null && (sub === null || simple.order > sub.order)) {
    const dict = literalDictEntries(ctx.mask, simple.range)
    if (dict === null) return []
    const value = dict.get(key)
    return value === undefined ? [] : evalRange(value, ctx, depth + 1)
  }
  if (sub !== null) return evalRange(sub.range, ctx, depth + 1)
  return []
}

interface SetupKeyword {
  key: string
  range: Range
}

interface SetupCall {
  /** Offset of the callee, so bindings are read as of the call. */
  offset: number
  keywords: SetupKeyword[]
  /** Ranges of the `**mapping` arguments. */
  stars: Range[]
}

/**
 * The local names bound to setuptools' `setup`, and aliases of the `setuptools` module.
 *
 * `from setuptools import setup as configure` binds the function under another name; reading only
 * the literal spelling loses every dependency the call declares.
 */
function setupAliases(mask: PythonMask, statements: Statement[]): { funcs: Set<string>; modules: Set<string> } {
  const funcs = new Set<string>(['setup'])
  const modules = new Set<string>(['setuptools'])
  for (const stmt of statements) {
    const text = mask.structural.slice(stmt.start, stmt.end).trim()
    const from = /^from\s+setuptools\s+import\s+\(?([\s\S]*?)\)?$/.exec(text)
    if (from !== null) {
      for (const part of (from[1] as string).split(',')) {
        const entry = part.trim()
        const alias = /^setup\s+as\s+([A-Za-z_][A-Za-z0-9_]*)$/.exec(entry)
        if (alias !== null) funcs.add(alias[1] as string)
        else if (entry === 'setup') funcs.add('setup')
      }
      continue
    }
    const imported = /^import\s+setuptools\s+as\s+([A-Za-z_][A-Za-z0-9_]*)$/.exec(text)
    if (imported !== null) modules.add(imported[1] as string)
  }
  return { funcs, modules }
}

/** Every `setup(...)` call, with its keyword and `**` arguments. */
function setupCalls(mask: PythonMask, aliases: { funcs: Set<string>; modules: Set<string> }): SetupCall[] {
  const { structural } = mask
  const out: SetupCall[] = []
  for (const match of structural.matchAll(/([A-Za-z_][A-Za-z0-9_]*)(?:\s*\.\s*([A-Za-z_][A-Za-z0-9_]*))?\s*\(/g)) {
    const first = match[1] as string
    const second = match[2]
    const matched = second === undefined ? aliases.funcs.has(first) : aliases.modules.has(first) && second === 'setup'
    if (!matched) continue
    const index = match.index as number
    // A `def setup(...)` wrapper is a definition, not a call; its parameter defaults are not
    // dependency declarations.
    const lineStart = structural.lastIndexOf('\n', index - 1) + 1
    if (/\bdef\s+$/.test(structural.slice(lineStart, index))) continue
    const open = index + match[0].length - 1
    const close = matchingBracket(structural, open)
    if (close < 0) continue
    const keywords: SetupKeyword[] = []
    const stars: Range[] = []
    for (const arg of splitTopLevel(structural, { start: open + 1, end: close }, ',')) {
      const start = trimRange(structural, arg).start
      if (structural[start] === '*' && structural[start + 1] === '*') {
        stars.push({ start: start + 2, end: arg.end })
        continue
      }
      const eq = topLevelIndex(structural, arg, '=')
      if (eq < 0) continue
      const key = structural.slice(arg.start, eq).trim()
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue
      keywords.push({ key, range: { start: eq + 1, end: arg.end } })
    }
    out.push({ offset: index, keywords, stars })
  }
  return out
}

/** The keyword entries of a mapping passed as `**name`, following a variable to its dict. */
function keywordDictEntries(ctx: EvalContext, range: Range, depth = 0): Map<string, Range> | null {
  if (depth > 8) return null
  const { structural } = ctx.mask
  const trimmed = trimRange(structural, range)
  const text = structural.slice(trimmed.start, trimmed.end)
  if (structural[trimmed.start] === '{') return literalDictEntries(ctx.mask, trimmed)
  if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(text)) {
    const simple = lastSimple(ctx, text)
    return simple === null ? null : keywordDictEntries(ctx, simple.range, depth + 1)
  }
  const call = /^dict\s*\(/.exec(text)
  if (call !== null) {
    const open = trimmed.start + call[0].length - 1
    const close = matchingBracket(structural, open)
    if (close !== trimmed.end - 1) return null
    const out = new Map<string, Range>()
    for (const arg of splitTopLevel(structural, { start: open + 1, end: close }, ',')) {
      const eq = topLevelIndex(structural, arg, '=')
      if (eq < 0) continue
      const key = structural.slice(arg.start, eq).trim()
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue
      out.set(key, { start: eq + 1, end: arg.end })
    }
    return out
  }
  return null
}

function lineAt(text: string, index: number): number {
  let line = 1
  for (let i = 0; i < index && i < text.length; i++) if (text[i] === '\n') line++
  return line
}

/**
 * `setup.py`: the dependency values passed to `setup(...)`, resolved statically.
 *
 * Real projects build the lists in variables (`install_requires = [...]`,
 * `extras["torch"] = deps_list("torch", ...)`, `install_requires=list(install_requires)`, and
 * `setup(**kwargs)`), often under an aliased import. Reading only inline literals loses those
 * declarations; executing the file is not an option. This resolves literal assignments, tuples,
 * concatenation and projection helpers relative to the call, and stops at anything it cannot
 * evaluate. Comments and strings are masked first so neither can change the structure.
 */
function setupPyDeclarations(text: string): Declaration[] {
  const mask = maskPython(text)
  const statements = pythonStatements(mask)
  const bindings = collectAssignments(mask, statements)
  const functions = collectFunctions(mask, statements)
  const aliases = setupAliases(mask, statements)
  const out: Declaration[] = []
  const add = (requirement: RequirementToken): void => {
    const name = requirementName(requirement.spec)
    if (name !== null) out.push({ name, line: lineAt(text, requirement.offset) })
  }
  for (const call of setupCalls(mask, aliases)) {
    const ctx: EvalContext = { mask, bindings, functions, callOffset: call.offset, seen: new Set() }
    for (const { key, range } of call.keywords) {
      if (!SETUP_DEPENDENCY_KEYS.has(key)) continue
      for (const requirement of evalRange(range, ctx)) add(requirement)
    }
    for (const star of call.stars) {
      const entries = keywordDictEntries(ctx, star)
      if (entries === null) continue
      for (const [key, range] of entries) {
        if (!SETUP_DEPENDENCY_KEYS.has(key)) continue
        for (const requirement of evalRange(range, ctx)) add(requirement)
      }
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
