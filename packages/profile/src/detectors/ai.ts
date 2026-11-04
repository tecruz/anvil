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
  /** Offset of the innermost function or class body that runs the assignment, or null at module level. */
  scope: number | null
}

interface Scope {
  /** Offset of the `def`/`class` statement. */
  start: number
  /** Offset just past the last statement in its body. */
  end: number
}

/** The leading whitespace before the line an offset sits on. */
function indentationAt(text: string, index: number): number {
  const lineStart = text.lastIndexOf('\n', index - 1) + 1
  let n = 0
  while (lineStart + n < text.length && (text[lineStart + n] === ' ' || text[lineStart + n] === '\t')) n++
  return n
}

/** Every function and class body, so an assignment can be attributed to the scope that runs it. */
function collectScopes(mask: PythonMask, statements: Statement[]): Scope[] {
  const out: Scope[] = []
  for (let i = 0; i < statements.length; i++) {
    const stmt = statements[i] as Statement
    if (!/^(?:async\s+)?(?:def|class)\b/.test(stmt.text.trimStart())) continue
    const indent = indentationAt(mask.nocomment, stmt.start)
    let end = stmt.end
    for (let j = i + 1; j < statements.length; j++) {
      const body = statements[j] as Statement
      if (indentationAt(mask.nocomment, body.start) <= indent) break
      end = body.end
    }
    out.push({ start: stmt.start, end })
  }
  return out
}

/** The innermost scope containing `offset`, or null at module level. */
function scopeAt(scopes: readonly Scope[], offset: number): number | null {
  let out: number | null = null
  for (const scope of scopes) {
    if (scope.start >= offset || scope.end <= offset) continue
    if (out === null || scope.start > out) out = scope.start
  }
  return out
}

/**
 * Assignments in source order, each attributed to the scope that runs it.
 *
 * `setup.py` runs top to bottom, and a name bound inside an uncalled helper is not the value
 * `setup()` receives. The scope is kept so a call inside `main()` sees the locals of `main()`
 * without also seeing the locals of an unrelated helper.
 */
function collectAssignments(mask: PythonMask, statements: Statement[], scopes: readonly Scope[]): Binding[] {
  const out: Binding[] = []
  for (const stmt of statements) {
    if (/^(?:async\s+)?(?:def|class)\b/.test(stmt.text.trimStart())) continue

    const structural = mask.structural.slice(stmt.start, stmt.end)
    const eq = topLevelIndex(structural, { start: 0, end: structural.length }, '=')
    if (eq < 0) continue
    const left = stmt.text.slice(0, eq).trim()
    const range = { start: stmt.start + eq + 1, end: stmt.end }
    const scope = scopeAt(scopes, stmt.start)
    const subscript = /^([A-Za-z_][A-Za-z0-9_]*)\s*\[\s*(?:"([^"]*)"|'([^']*)')\s*\]$/.exec(left)
    if (subscript !== null) {
      out.push({
        base: subscript[1] as string,
        key: subscript[2] ?? subscript[3] ?? '',
        range,
        order: stmt.start,
        scope,
      })
      continue
    }
    const name = /^([A-Za-z_][A-Za-z0-9_]*)(?:\s*:[^=]+)?$/.exec(left)?.[1]
    if (name !== undefined) out.push({ base: name, key: null, range, order: stmt.start, scope })
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
  /** Scope the `def` itself sits in, so a free name resolves in the helper's lexical scope. */
  scope: number | null
}

/**
 * Local function definitions whose body is a single `return`.
 *
 * These are the lookup helpers a `setup.py` builds its requirement lists with. A body with more
 * steps is not a plain projection and is left unresolved, so an unrelated helper that happens to
 * share a name cannot claim its call arguments as distributions.
 */
function collectFunctions(
  mask: PythonMask,
  statements: Statement[],
  scopes: readonly Scope[],
): Map<string, FunctionDef> {
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
    let keywordOnly = false
    const raw = header[2] ?? ''
    for (const part of splitTopLevel(raw, { start: 0, end: raw.length }, ',')) {
      const token = raw.slice(part.start, part.end).trim()
      const name = /^(\*\*\s*|\*\s*)?([A-Za-z_][A-Za-z0-9_]*)/.exec(token)
      if (name === null) continue
      const prefix = name[1]?.trim()
      if (prefix === '*') {
        varargs = name[2] as string
        keywordOnly = true
      } else if (prefix === '**') {
        keywordOnly = true
      } else if (!keywordOnly) {
        params.push(name[2] as string)
      }
    }
    if (varargs === null) continue

    const bodyStatements: Statement[] = []
    let bodyIndent: number | null = null
    for (let j = i + 1; j < statements.length; j++) {
      const body = statements[j] as Statement
      const bodyIndentation = indentationAt(mask.nocomment, body.start)
      if (bodyIndentation <= indent) break
      if (bodyIndent === null) bodyIndent = bodyIndentation
      if (bodyIndentation === bodyIndent) bodyStatements.push(body)
    }
    // A docstring documents the helper; any other statement before the return means the body
    // does more than project its arguments, so the call is not evidence of a distribution.
    if (bodyStatements.length > 0) {
      const first = bodyStatements[0] as Statement
      if (stringTokenFor(mask, { start: first.start, end: first.end }) !== null) bodyStatements.shift()
    }
    if (bodyStatements.length !== 1) continue
    const body = bodyStatements[0] as Statement
    const text = structural.slice(body.start, body.end)
    if (!/^return\s+/.test(text.trim())) continue
    const offset = body.start + text.indexOf('return') + 'return'.length
    out.set(header[1] as string, {
      params,
      varargs,
      body: { start: offset, end: body.end },
      scope: scopeAt(scopes, stmt.start),
    })
  }
  return out
}

interface EvalContext {
  mask: PythonMask
  bindings: Binding[]
  functions: Map<string, FunctionDef>
  /** Offset of the `setup(...)` call being evaluated; only earlier bindings count. */
  callOffset: number
  /** Scope the call sits in, so only its own locals and module bindings are visible. */
  callScope: number | null
  seen: Set<string>
}

const SETUP_DEPENDENCY_KEYS: ReadonlySet<string> = new Set([
  'install_requires',
  'tests_require',
  'setup_requires',
  'extras_require',
])

/**
 * The bindings for a name that are visible at `refOffset`.
 *
 * Module bindings are always visible; a function's locals only where the call is written in
 * that same function. `refOffset` is the point the reference is read at, so an alias captures
 * the value it was assigned, not a later rebinding of the name it names.
 */
function bindingsFor(ctx: EvalContext, base: string, refOffset: number): Binding[] {
  return ctx.bindings.filter(
    (b) => b.base === base && b.order < refOffset && (b.scope === null || b.scope === ctx.callScope),
  )
}

/** The last simple assignment to a name before `refOffset`, if any. */
function lastSimple(ctx: EvalContext, name: string, refOffset: number): Binding | null {
  let out: Binding | null = null
  for (const b of ctx.bindings) {
    if (b.key === null && b.base === name && b.order < refOffset && (b.scope === null || b.scope === ctx.callScope))
      out = b
  }
  return out
}

/** The identifier a bare-name range names, or null for any other expression. */
function bareIdentifier(mask: PythonMask, range: Range): string | null {
  const trimmed = trimRange(mask.structural, range)
  const text = mask.structural.slice(trimmed.start, trimmed.end)
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(text) ? text : null
}

/**
 * The next assignment to `name` that can change the object it refers to, after `afterOrder` and
 * before `limit`. A self-assignment (`x = x`) keeps the same object, so it does not end the
 * object's lifetime; treating it as a rebinding would drop the mutations that follow it.
 */
function nextRebinding(ctx: EvalContext, name: string, afterOrder: number, limit: number): Binding | null {
  let out: Binding | null = null
  for (const b of ctx.bindings) {
    if (b.key !== null || b.base !== name) continue
    if (b.order <= afterOrder || b.order >= limit) continue
    if (b.scope !== null && b.scope !== ctx.callScope) continue
    if (bareIdentifier(ctx.mask, b.range) === name) continue
    if (out === null || b.order < out.order) out = b
  }
  return out
}

/** The last subscript assignment to each key, so a later write replaces an earlier one. */
function latestByKey(bindings: Iterable<Binding>): Map<string, Binding> {
  const out = new Map<string, Binding>()
  for (const b of bindings) {
    if (b.key === null) continue
    const prior = out.get(b.key)
    if (prior === undefined || b.order > prior.order) out.set(b.key, b)
  }
  return out
}

/** A name that refers to the object during `[start, limit)`. */
interface AliasSegment {
  name: string
  start: number
  limit: number
}

/** Guard so an object reached through a pathological web of aliases cannot cost more than the
 * finding is worth. Exceeding it makes the object unresolvable rather than approximated. */
const MAX_ALIAS_SEGMENTS = 256

/**
 * Subscript assignments that mutate the object bound to `name` at `bindingOrder`, written through
 * any name assigned it (`alias = obj`, and aliases of those) before `readOffset`.
 *
 * `alias = obj` gives one object two names, so `alias["k"] = v` changes what `obj["k"]` holds.
 * A name refers to the object only between one of its assignments and its next rebinding, so each
 * assignment contributes the writes made in that window -- and a name reassigned the object later
 * refers to it again. Every such window is walked, which is what lets an alias be reused.
 *
 * Returns null when the object has more alias windows than the budget allows: the writes cannot be
 * enumerated, and reporting the literal entries as if nothing had overwritten them would be a
 * confident guess, which is the one outcome this detector exists to avoid.
 */
function aliasSubscripts(ctx: EvalContext, name: string, bindingOrder: number, readOffset: number): Binding[] | null {
  if (bindingOrder < 0) return []
  const out: Binding[] = []
  const segments: AliasSegment[] = []
  const seen = new Set<string>()
  const push = (segment: AliasSegment): boolean => {
    const id = `${segment.name}@${segment.start}`
    if (seen.has(id)) return true
    if (seen.size >= MAX_ALIAS_SEGMENTS) return false
    seen.add(id)
    segments.push(segment)
    out.push(...bindingsFor(ctx, segment.name, segment.limit).filter((s) => s.key !== null && s.order > segment.start))
    return true
  }
  const firstRebinding = nextRebinding(ctx, name, bindingOrder, readOffset)
  if (!push({ name, start: bindingOrder, limit: firstRebinding?.order ?? readOffset })) return null
  for (let i = 0; i < segments.length; i++) {
    const segment = segments[i] as AliasSegment
    for (const b of ctx.bindings) {
      if (b.key !== null || b.order <= segment.start || b.order >= segment.limit) continue
      if (b.scope !== null && b.scope !== ctx.callScope) continue
      if (bareIdentifier(ctx.mask, b.range) !== segment.name) continue
      const limit = nextRebinding(ctx, b.base, b.order, readOffset)?.order ?? readOffset
      if (!push({ name: b.base, start: b.order, limit })) return null
    }
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

/**
 * Evaluate a Python expression to the requirement strings it statically contains.
 *
 * `refOffset` is where the expression is read: the `setup()` call for an argument, or the
 * assignment's own offset for a value bound in a variable. Passing it down is what keeps
 * `install_requires = requirements` from seeing a later rebinding of `requirements`.
 */
function evalRange(range: Range, ctx: EvalContext, depth = 0, refOffset?: number): RequirementToken[] {
  if (depth > 32) return []
  const { structural } = ctx.mask
  const trimmed = trimRange(structural, range)
  if (trimmed.start >= trimmed.end) return []
  const ref = refOffset ?? trimmed.start

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
        for (const value of entries.values()) out.push(...evalRange(value, ctx, depth + 1, ref))
        return out
      }
      const inner = { start: trimmed.start + 1, end: trimmed.end - 1 }
      const out: RequirementToken[] = []
      for (const part of splitTopLevel(structural, inner, ',')) {
        out.push(...evalRange(part, ctx, depth + 1, ref))
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
    return [...evalRange(left, ctx, depth + 1, ref), ...evalRange(right, ctx, depth + 1, ref)]
  }

  const call = /^([A-Za-z_][A-Za-z0-9_]*)\s*\(/.exec(structural.slice(trimmed.start, trimmed.end))
  if (call !== null) {
    const name = call[1] as string
    const open = trimmed.start + call[0].length - 1
    const close = matchingBracket(structural, open)
    if (close === trimmed.end - 1) {
      const args = splitTopLevel(structural, { start: open + 1, end: close }, ',')
      if (name === 'list' || name === 'tuple' || name === 'set') {
        return args.flatMap((arg) => evalRange(arg, ctx, depth + 1, ref))
      }
      return resolveHelperCall(name, args, ctx, depth + 1, ref)
    }
  }

  const subscript = /^([A-Za-z_][A-Za-z0-9_]*)\s*\[/.exec(structural.slice(trimmed.start, trimmed.end))
  if (subscript !== null) {
    const base = subscript[1] as string
    const open = trimmed.start + subscript[0].length - 1
    const close = matchingBracket(structural, open)
    if (close === trimmed.end - 1) {
      const key = stringTokenFor(ctx.mask, trimRange(structural, { start: open + 1, end: close }))
      if (key !== null) return evalSubscript(base, key.value, ctx, depth + 1, ref)
    }
    return []
  }

  const identifier = structural.slice(trimmed.start, trimmed.end)
  if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(identifier)) {
    return evalName(identifier, ctx, depth + 1, ref)
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
function resolveHelperCall(
  name: string,
  args: readonly Range[],
  ctx: EvalContext,
  depth: number,
  refOffset: number,
): RequirementToken[] {
  const fn = ctx.functions.get(name)
  if (fn === undefined || fn.varargs === null) return []
  // The helper body resolves its free names where the helper is defined, not where it is called.
  // A caller-local name of the same spelling must not shadow the module-level lookup table.
  const helperCtx: EvalContext = fn.scope === ctx.callScope ? ctx : { ...ctx, callScope: fn.scope }
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

  // Only the arguments the varargs parameter actually receives are projected. A required
  // parameter consumes its positional argument, and a keyword argument never reaches `*pkgs`.
  const positional: Range[] = []
  for (const arg of args) {
    const trimmedArg = trimRange(structural, arg)
    // A trailing comma leaves an empty final argument; it declares nothing.
    if (trimmedArg.start >= trimmedArg.end) continue
    if (topLevelIndex(structural, trimmedArg, '=') >= 0) return []
    positional.push(trimmedArg)
  }
  if (positional.length < fn.params.length) return []

  const out: RequirementToken[] = []
  for (const trimmedArg of positional.slice(fn.params.length)) {
    const token = stringTokenFor(ctx.mask, trimmedArg)
    if (token === null) return [] // a computed argument cannot be read statically
    if (projection === null) {
      out.push({ spec: token.value, offset: token.start })
      continue
    }
    if ((projection[2] as string) !== loopVar) return []
    const mapping = projection[1] as string
    // A parameter of the helper is the caller's argument, not a module-level name that happens
    // to share its spelling. Resolve it where the call is written; a same-named global is not
    // evidence for what the parameter received.
    let mappingCtx = helperCtx
    let mappingRange: Range | null = null
    let mappingOrder = refOffset
    let mappingName: string | null = null
    if (fn.params.includes(mapping)) {
      const arg = positional[fn.params.indexOf(mapping)]
      if (arg === undefined) return []
      const argumentName = bareIdentifier(ctx.mask, arg)
      const argument = argumentName === null ? null : lastSimple(ctx, argumentName, refOffset)
      if (argument !== null) {
        mappingRange = argument.range
        mappingOrder = argument.order
        mappingName = argumentName
      } else {
        mappingRange = arg
      }
      mappingCtx = ctx
    } else {
      if (mapping === fn.varargs) return []
      const simple = lastSimple(helperCtx, mapping, refOffset)
      if (simple !== null) {
        mappingRange = simple.range
        mappingOrder = simple.order
        mappingName = mapping
      }
    }
    const dict = mappingRange === null ? null : literalDictEntries(ctx.mask, mappingRange)
    // A subscript assignment replaces a key of the table, whether it is written through the
    // table's own name or an alias of the same dict, and it is what the projection reads.
    const aliasWrites = mappingName === null ? [] : aliasSubscripts(mappingCtx, mappingName, mappingOrder, refOffset)
    if (aliasWrites === null) return []
    const overrides =
      mappingName === null
        ? new Map<string, Binding>()
        : latestByKey([
            ...bindingsFor(mappingCtx, mappingName, refOffset).filter((b) => b.order > mappingOrder),
            ...aliasWrites,
          ])
    const override = overrides.get(token.value)
    if (dict !== null && mappingRange !== null) {
      if (override !== undefined) {
        out.push(...evalRange(override.range, mappingCtx, depth + 1, override.order))
        continue
      }
      const value = dict.get(token.value)
      if (value !== undefined) out.push(...evalRange(value, mappingCtx, depth + 1, mappingOrder))
      continue
    }
    // An unresolvable lookup table is trusted only when it is a comprehension, the shape real
    // projects use to alias a pinned requirement back to its own name. An override still wins.
    if (mappingRange !== null && isDictComprehension(ctx.mask, mappingRange)) {
      if (override !== undefined) {
        out.push(...evalRange(override.range, mappingCtx, depth + 1, override.order))
        continue
      }
      out.push({ spec: token.value, offset: token.start })
      continue
    }
    return []
  }
  return out
}

function evalName(name: string, ctx: EvalContext, depth: number, refOffset: number): RequirementToken[] {
  // The same name read at an earlier offset is a different value: `x = list(x)` is legitimate.
  // Bindings only ever resolve to an earlier statement, so this also keeps the recursion finite.
  const key = `${name}@${refOffset}`
  if (ctx.seen.has(key)) return []
  ctx.seen.add(key)
  try {
    const simple = lastSimple(ctx, name, refOffset)
    const subs = bindingsFor(ctx, name, refOffset).filter((b) => b.key !== null)
    if (simple !== null) {
      const dict = literalDictEntries(ctx.mask, simple.range)
      if (dict !== null) {
        // The literal defines the base value; a later subscript assignment overwrites a key,
        // whether it is written through this name or through an alias of the same dict.
        const aliasWrites = aliasSubscripts(ctx, name, simple.order, refOffset)
        if (aliasWrites === null) return []
        const overrides = latestByKey([...subs.filter((b) => b.order > simple.order), ...aliasWrites])
        const out: RequirementToken[] = []
        for (const [entryKey, value] of dict) {
          if (overrides.has(entryKey)) continue
          out.push(...evalRange(value, ctx, depth + 1, simple.order))
        }
        const ordered = [...overrides.values()].sort((a, b) => a.order - b.order)
        for (const b of ordered) out.push(...evalRange(b.range, ctx, depth + 1, b.order))
        return out
      }
    }
    if (simple !== null) {
      const alias = bareIdentifier(ctx.mask, simple.range)
      // A subscript assignment reaches the object, not the name. When `simple` is another name
      // for that object, the alias owns the keys written through any of its names, so an
      // override written through either spelling replaces the base entry once, not twice.
      const aliasWrites = aliasSubscripts(ctx, name, simple.order, refOffset)
      if (aliasWrites === null) return []
      const applied = [...subs, ...aliasWrites]
      if (alias !== null) return evalAlias(alias, ctx, depth + 1, simple.order, refOffset, applied)
      const out = evalRange(simple.range, ctx, depth + 1, simple.order)
      for (const b of applied) out.push(...evalRange(b.range, ctx, depth + 1, b.order))
      return out
    }
    const out: RequirementToken[] = []
    // A dict populated only by `name["key"] = ...` has no single literal value; every key is
    // part of the declaration, which is how `extras_require=extras` carries its extras.
    for (const b of subs) out.push(...evalRange(b.range, ctx, depth + 1, b.order))
    return out
  } finally {
    ctx.seen.delete(key)
  }
}

/**
 * A name assigned another name aliases the same object in Python.
 *
 * `install_requires = extras` followed by `extras["torch"] = ...` still passes the dict with
 * `torch`: both names point at one object, so the alias captures which binding it saw -- a later
 * `extras = {}` rebinds the name -- but not the dict's contents. Subscript assignments made to
 * the base up to the reference point therefore still count, while a later rebinding does not.
 */
function evalAlias(
  name: string,
  ctx: EvalContext,
  depth: number,
  bindingOffset: number,
  mutationOffset: number,
  inherited: readonly Binding[] = [],
): RequirementToken[] {
  if (depth > 32) return []
  const key = `${name}@${bindingOffset}>${mutationOffset}`
  if (ctx.seen.has(key)) return []
  ctx.seen.add(key)
  try {
    const simple = lastSimple(ctx, name, bindingOffset)
    const rebinding = nextRebinding(ctx, name, simple?.order ?? -1, mutationOffset)
    const limit = rebinding?.order ?? mutationOffset
    const subs = bindingsFor(ctx, name, limit).filter(
      (b) => b.key !== null && (simple === null || b.order > simple.order),
    )
    // Subscript assignments made through any name for the object reach the same dict; a later
    // write replaces an earlier one, whichever spelling made it. An alias that captured the
    // object keeps mutating it even after the original name is rebound, so the alias walk runs to
    // the read point, not to `name`'s rebinding.
    const aliasWrites = simple === null ? [] : aliasSubscripts(ctx, name, simple.order, mutationOffset)
    if (aliasWrites === null) return []
    const overrides = latestByKey([...inherited, ...subs, ...aliasWrites])
    const ordered = [...overrides.values()].sort((a, b) => a.order - b.order)
    if (simple !== null) {
      const dict = literalDictEntries(ctx.mask, simple.range)
      if (dict !== null) {
        const out: RequirementToken[] = []
        for (const [entryKey, value] of dict) {
          if (overrides.has(entryKey)) continue
          out.push(...evalRange(value, ctx, depth + 1, simple.order))
        }
        for (const b of ordered) out.push(...evalRange(b.range, ctx, depth + 1, b.order))
        return out
      }
      const alias = bareIdentifier(ctx.mask, simple.range)
      if (alias !== null) return evalAlias(alias, ctx, depth + 1, simple.order, mutationOffset, ordered)
      const out = evalRange(simple.range, ctx, depth + 1, simple.order)
      for (const b of ordered) out.push(...evalRange(b.range, ctx, depth + 1, b.order))
      return out
    }
    return ordered.flatMap((b) => evalRange(b.range, ctx, depth + 1, b.order))
  } finally {
    ctx.seen.delete(key)
  }
}

/**
 * Evaluate a value that was captured in a mapping and is observed when it is unpacked.
 *
 * `writeOffset` is where the value was written; the call is where it is read. A bare name is
 * bound where it was written, but the object it names is read at the call, so a subscript
 * mutation made after the capture still counts while a later rebinding of the name does not --
 * the alias rule, seen from the captured value. Every other expression is constructed at the
 * write, so evaluating it there is already correct.
 */
function evalCapturedValue(range: Range, ctx: EvalContext, depth: number, writeOffset: number): RequirementToken[] {
  const name = bareIdentifier(ctx.mask, range)
  if (name === null) return evalRange(range, ctx, depth + 1, writeOffset)
  return evalAlias(name, ctx, depth + 1, writeOffset, ctx.callOffset)
}

function evalSubscript(
  base: string,
  key: string,
  ctx: EvalContext,
  depth: number,
  refOffset: number,
): RequirementToken[] {
  let sub: Binding | null = null
  for (const b of bindingsFor(ctx, base, refOffset)) {
    if (b.key === key) sub = b
  }
  const simple = lastSimple(ctx, base, refOffset)
  // A dict rebuilt after the subscript assignment replaces it entirely.
  if (simple !== null && (sub === null || simple.order > sub.order)) {
    const dict = literalDictEntries(ctx.mask, simple.range)
    if (dict === null) return []
    const value = dict.get(key)
    return value === undefined ? [] : evalRange(value, ctx, depth + 1, simple.order)
  }
  if (sub !== null) return evalRange(sub.range, ctx, depth + 1, sub.order)
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

interface MappingEntry {
  range: Range
  /** Where the value is read: the assignment that wrote it, not the `setup` call. */
  refOffset: number
}

/**
 * Returned when a `**mapping` is recognised but its entries cannot all be enumerated -- too many
 * aliases to follow, or nested deeper than the recursion bound. Distinct from `null`, which means
 * the expression is simply not a mapping. An unavailable mapping must be dropped rather than
 * rebuilt from the writes that happened to be found, because an entry it might still hold could
 * have been overwritten.
 */
const UNAVAILABLE = Symbol('mapping-unavailable')

type MappingEntries = Map<string, MappingEntry> | null

/**
 * The keyword entries of a mapping passed as `**name`, following a variable to its dict.
 *
 * Subscript assignments made before the call mutate that dict, so they are part of the mapping
 * and override an entry of the same key. Each value remembers where it was written, which is
 * what keeps a name inside an early entry from resolving to a later rebinding.
 */
function keywordDictEntries(
  ctx: EvalContext,
  range: Range,
  depth = 0,
  refOffset?: number,
): MappingEntries | typeof UNAVAILABLE {
  if (depth > 8) return UNAVAILABLE
  const { structural } = ctx.mask
  const trimmed = trimRange(structural, range)
  const ref = refOffset ?? trimmed.start
  const text = structural.slice(trimmed.start, trimmed.end)
  if (structural[trimmed.start] === '{') {
    const entries = literalDictEntries(ctx.mask, trimmed)
    if (entries === null) return null
    const out = new Map<string, MappingEntry>()
    for (const [key, value] of entries) out.set(key, { range: value, refOffset: ref })
    return out
  }
  if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(text)) {
    const simple = lastSimple(ctx, text, ref)
    const base = simple === null ? null : keywordDictEntries(ctx, simple.range, depth + 1, simple.order)
    if (base === UNAVAILABLE) return UNAVAILABLE
    // The mapping is observed when it is unpacked, so a subscript assignment made after it was
    // captured is still in the dict. A rebinding replaces the name, leaving the captured object
    // untouched, so mutations past it do not count.
    const rebinding = nextRebinding(ctx, text, simple?.order ?? -1, ctx.callOffset)
    const limit = rebinding?.order ?? ctx.callOffset
    // An alias that captured the mapping keeps mutating it after the name is rebound, so the
    // alias walk runs to the call while the name's own writes stop at its rebinding.
    const aliasWrites = simple === null ? [] : aliasSubscripts(ctx, text, simple.order, ctx.callOffset)
    if (aliasWrites === null) return UNAVAILABLE
    const writes = [
      ...bindingsFor(ctx, text, limit).filter((b) => b.key !== null && (simple === null || b.order > simple.order)),
      ...aliasWrites,
    ]
    if (base === null && writes.length === 0) return null
    const out = new Map<string, MappingEntry>()
    if (base !== null) for (const [key, entry] of base) out.set(key, entry)
    // A later write replaces an earlier one, whichever name for the dict made it.
    for (const b of writes) {
      const key = b.key as string
      const prior = out.get(key)
      if (prior === undefined || b.order > prior.refOffset) out.set(key, { range: b.range, refOffset: b.order })
    }
    return out
  }
  const call = /^dict\s*\(/.exec(text)
  if (call !== null) {
    const open = trimmed.start + call[0].length - 1
    const close = matchingBracket(structural, open)
    if (close !== trimmed.end - 1) return null
    const out = new Map<string, MappingEntry>()
    for (const arg of splitTopLevel(structural, { start: open + 1, end: close }, ',')) {
      const eq = topLevelIndex(structural, arg, '=')
      if (eq < 0) continue
      const key = structural.slice(arg.start, eq).trim()
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue
      out.set(key, { range: { start: eq + 1, end: arg.end }, refOffset: ref })
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
  const scopes = collectScopes(mask, statements)
  const bindings = collectAssignments(mask, statements, scopes)
  const functions = collectFunctions(mask, statements, scopes)
  const aliases = setupAliases(mask, statements)
  const out: Declaration[] = []
  const add = (requirement: RequirementToken): void => {
    const name = requirementName(requirement.spec)
    if (name !== null) out.push({ name, line: lineAt(text, requirement.offset) })
  }
  for (const call of setupCalls(mask, aliases)) {
    const ctx: EvalContext = {
      mask,
      bindings,
      functions,
      callOffset: call.offset,
      callScope: scopeAt(scopes, call.offset),
      seen: new Set(),
    }
    for (const { key, range } of call.keywords) {
      if (!SETUP_DEPENDENCY_KEYS.has(key)) continue
      for (const requirement of evalRange(range, ctx, 0, call.offset)) add(requirement)
    }
    for (const star of call.stars) {
      const entries = keywordDictEntries(ctx, star, 0, call.offset)
      if (entries === null || entries === UNAVAILABLE) continue
      for (const [key, entry] of entries) {
        if (!SETUP_DEPENDENCY_KEYS.has(key)) continue
        // The value is bound where it was written, but a subscript mutation to the object it
        // names is still visible at the call.
        for (const requirement of evalCapturedValue(entry.range, ctx, 0, entry.refOffset)) add(requirement)
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
