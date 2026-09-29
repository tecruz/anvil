/**
 * A strict, bounded YAML-subset parser.
 *
 * Playbooks are hand-authored data files, and YAML with comments is the right thing to
 * write them in. But anvil ships as a single file with zero runtime dependencies, and a
 * misparse here would be worse than no parse at all: a silently wrong playbook points an
 * agent at the wrong technology guidance with full confidence.
 *
 * So this parser accepts an explicitly documented subset and **throws on anything
 * outside it**. It supports exactly what playbook authoring needs:
 *
 *   - comments (`#`), including full-line and trailing
 *   - nested block mappings, by indentation (2 spaces or a tab, consistently)
 *   - block sequences (`- item`), including maps as sequence items
 *   - flow collections on one line: `[a, b]` and `{a: b, c: d}`
 *   - scalars: plain, 'single', "double", `true`/`false`/`null`, numbers
 *   - block scalars for prose: `|` (literal) and `>` (folded)
 *
 * Explicitly NOT supported, and rejected rather than approximated: anchors/aliases, tags,
 * multiple documents, complex keys, merge keys, tabs for indentation.
 */

export class YamlError extends Error {
  readonly line: number
  constructor(message: string, line: number) {
    super(`${message} (line ${line})`)
    this.name = 'YamlError'
    this.line = line
  }
}

export type YamlValue = string | number | boolean | null | YamlValue[] | { [key: string]: YamlValue }

interface Line {
  /** Indent width in columns; tabs are rejected. */
  indent: number
  text: string
  lineNo: number
}

export function parseYamlSubset(input: string): YamlValue {
  const lines = splitLines(input)
  if (lines.length === 0) return null
  const [value, consumed] = parseBlock(lines, 0, lines[0]!.indent)
  if (consumed !== lines.length) {
    const leftover = lines[consumed]
    throw new YamlError(`unexpected content "${leftover?.text ?? ''}"`, leftover?.lineNo ?? 0)
  }
  return value
}

/** Strip comments and blank lines, recording indentation. Rejects tab indentation. */
function splitLines(input: string): Line[] {
  const out: Line[] = []
  const raw = input.split(/\r\n|\r|\n/)

  for (let i = 0; i < raw.length; i++) {
    const original = raw[i] ?? ''
    const leading = original.slice(0, original.length - original.trimStart().length)
    if (leading.includes('\t')) {
      throw new YamlError('tab characters are not allowed for indentation', i + 1)
    }

    const indent = leading.length
    const text = stripComment(original.slice(indent)).trimEnd()
    if (text === '' || text.startsWith('#')) continue
    out.push({ indent, text: text.trimStart(), lineNo: i + 1 })
  }
  return out
}

/** Remove a trailing `# comment`, respecting quotes. */
function stripComment(s: string): string {
  let inSingle = false
  let inDouble = false
  for (let i = 0; i < s.length; i++) {
    const ch = s[i]
    if (ch === "'" && !inDouble) inSingle = !inSingle
    else if (ch === '"' && !inSingle) inDouble = !inDouble
    else if (ch === '#' && !inSingle && !inDouble) {
      // Only a comment when preceded by whitespace or at the start.
      if (i === 0 || /\s/.test(s[i - 1] ?? ' ')) return s.slice(0, i)
    }
  }
  return s
}

/**
 * Parse a block at `indent`, starting at `index`. Returns the value and the index of the
 * first unconsumed line.
 */
function parseBlock(lines: Line[], index: number, indent: number): [YamlValue, number] {
  if (index >= lines.length) return [null, index]
  const first = lines[index]!
  if (first.indent !== indent) {
    throw new YamlError(`unexpected indentation (expected ${indent}, got ${first.indent})`, first.lineNo)
  }
  if (first.text.startsWith('- ') || first.text === '-') return parseSequence(lines, index, indent)
  return parseMapping(lines, index, indent)
}

function parseMapping(lines: Line[], index: number, indent: number): [Record<string, YamlValue>, number] {
  const out: Record<string, YamlValue> = {}
  let i = index

  while (i < lines.length) {
    const line = lines[i]!
    if (line.indent < indent) break
    if (line.indent > indent) {
      throw new YamlError(`unexpected indentation inside a mapping`, line.lineNo)
    }
    if (line.text.startsWith('- ')) break

    const split = splitKey(line.text, line.lineNo)
    const key = split.key
    const rest = split.rest

    if (Object.prototype.hasOwnProperty.call(out, key)) {
      throw new YamlError(`duplicate key "${key}"`, line.lineNo)
    }

    if (rest === '') {
      // A nested block, a block scalar, or an explicit null.
      const next = lines[i + 1]
      if (next !== undefined && next.indent > indent) {
        const [value, consumed] = parseBlock(lines, i + 1, next.indent)
        out[key] = value
        i = consumed
        continue
      }
      out[key] = null
      i++
      continue
    }

    if (rest === '|' || rest === '>' || rest === '|-' || rest === '>-') {
      const [value, consumed] = parseBlockScalar(lines, i + 1, indent, rest)
      out[key] = value
      i = consumed
      continue
    }

    out[key] = parseScalarOrFlow(rest, line.lineNo)
    i++
  }

  return [out, i]
}

function parseSequence(lines: Line[], index: number, indent: number): [YamlValue[], number] {
  const out: YamlValue[] = []
  let i = index

  while (i < lines.length) {
    const line = lines[i]!
    if (line.indent < indent) break
    if (line.indent > indent) throw new YamlError('unexpected indentation inside a sequence', line.lineNo)
    if (!line.text.startsWith('- ') && line.text !== '-') break

    const itemText = line.text === '-' ? '' : line.text.slice(2).trim()
    const itemIndent = indent + 2

    if (itemText === '') {
      const next = lines[i + 1]
      if (next !== undefined && next.indent > indent) {
        const [value, consumed] = parseBlock(lines, i + 1, next.indent)
        out.push(value)
        i = consumed
        continue
      }
      out.push(null)
      i++
      continue
    }

    // `- key: value` starts a mapping whose first key sits on the dash line. Its
    // continuation keys are indented to align just past the dash.
    if (isMappingStart(itemText)) {
      const synthetic: Line = { indent: itemIndent, text: itemText, lineNo: line.lineNo }
      const collected: Line[] = [synthetic]
      let j = i + 1
      while (j < lines.length && lines[j]!.indent >= itemIndent) {
        collected.push(lines[j]!)
        j++
      }
      const [value] = parseMapping(collected, 0, itemIndent)
      out.push(value)
      i = j
      continue
    }

    out.push(parseScalarOrFlow(itemText, line.lineNo))
    i++
  }

  return [out, i]
}

function isMappingStart(text: string): boolean {
  return splitKeySafe(text) !== null
}

function splitKeySafe(text: string): { key: string; rest: string } | null {
  try {
    return splitKey(text, 0)
  } catch {
    return null
  }
}

/** Split `key: value`, respecting quotes and flow collections. */
function splitKey(text: string, lineNo: number): { key: string; rest: string } {
  let inSingle = false
  let inDouble = false
  let depth = 0
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (ch === "'" && !inDouble) inSingle = !inSingle
    else if (ch === '"' && !inSingle) inDouble = !inDouble
    else if (!inSingle && !inDouble) {
      if (ch === '[' || ch === '{') depth++
      else if (ch === ']' || ch === '}') depth--
      else if (ch === ':' && depth === 0) {
        const after = text[i + 1]
        if (after === undefined || after === ' ') {
          const key = unquote(text.slice(0, i).trim(), lineNo)
          if (key === '') throw new YamlError('empty mapping key', lineNo)
          return { key, rest: text.slice(i + 1).trim() }
        }
      }
    }
  }
  throw new YamlError(`expected "key: value" but found "${text}"`, lineNo)
}

function parseBlockScalar(lines: Line[], index: number, parentIndent: number, marker: string): [string, number] {
  const collected: string[] = []
  let i = index
  let blockIndent: number | null = null

  while (i < lines.length) {
    const line = lines[i]!
    if (line.indent <= parentIndent) break
    if (blockIndent === null) blockIndent = line.indent
    collected.push(' '.repeat(Math.max(0, line.indent - (blockIndent ?? line.indent))) + line.text)
    i++
  }

  const folded = marker.startsWith('>')
  let value: string
  if (folded) {
    // Folded: blank-line-free runs join with spaces. The subset has no blank lines
    // inside a block scalar, since they are stripped during lexing.
    value = collected.join(' ')
  } else {
    value = collected.join('\n')
  }
  if (marker.endsWith('-')) value = value.replace(/\n+$/, '')
  else value += '\n'
  return [value, i]
}

/** Parse a scalar or an inline flow collection. */
function parseScalarOrFlow(text: string, lineNo: number): YamlValue {
  if (text.startsWith('[')) return parseFlowSeq(text, lineNo)
  if (text.startsWith('{')) return parseFlowMap(text, lineNo)
  return parseScalar(text, lineNo)
}

function parseFlowSeq(text: string, lineNo: number): YamlValue[] {
  if (!text.endsWith(']')) throw new YamlError('unterminated flow sequence', lineNo)
  const inner = text.slice(1, -1).trim()
  if (inner === '') return []
  return splitFlowItems(inner, lineNo).map((item) => parseScalarOrFlow(item, lineNo))
}

function parseFlowMap(text: string, lineNo: number): Record<string, YamlValue> {
  if (!text.endsWith('}')) throw new YamlError('unterminated flow mapping', lineNo)
  const inner = text.slice(1, -1).trim()
  const out: Record<string, YamlValue> = {}
  if (inner === '') return out
  for (const item of splitFlowItems(inner, lineNo)) {
    const { key, rest } = splitKey(item, lineNo)
    out[key] = parseScalarOrFlow(rest, lineNo)
  }
  return out
}

/** Split flow-collection items on commas that are not inside quotes or nesting. */
function splitFlowItems(text: string, lineNo: number): string[] {
  const out: string[] = []
  let current = ''
  let inSingle = false
  let inDouble = false
  let depth = 0

  for (let i = 0; i < text.length; i++) {
    const ch = text[i] ?? ''
    if (ch === "'" && !inDouble) inSingle = !inSingle
    else if (ch === '"' && !inSingle) inDouble = !inDouble
    else if (!inSingle && !inDouble) {
      if (ch === '[' || ch === '{') depth++
      else if (ch === ']' || ch === '}') depth--
      else if (ch === ',' && depth === 0) {
        out.push(current.trim())
        current = ''
        continue
      }
    }
    current += ch
  }
  if (inSingle || inDouble) throw new YamlError('unterminated quote in flow collection', lineNo)
  const tail = current.trim()
  if (tail !== '') out.push(tail)
  return out
}

function parseScalar(text: string, lineNo: number): YamlValue {
  const t = text.trim()
  if (t === '' || t === '~' || t === 'null' || t === 'Null' || t === 'NULL') return null
  if (t === 'true' || t === 'True' || t === 'TRUE') return true
  if (t === 'false' || t === 'False' || t === 'FALSE') return false
  if (t.startsWith("'")) return unquote(t, lineNo)
  if (t.startsWith('"')) return unquote(t, lineNo)
  if (/^[-+]?\d+$/.test(t)) return Number.parseInt(t, 10)
  if (/^[-+]?\d*\.\d+$/.test(t)) return Number.parseFloat(t)
  if (t.startsWith('&') || t.startsWith('*') || t.startsWith('!')) {
    throw new YamlError('anchors, aliases and tags are not supported', lineNo)
  }
  return t
}

function unquote(text: string, lineNo: number): string {
  const t = text.trim()
  if (t.startsWith("'") && t.endsWith("'") && t.length >= 2) {
    return t.slice(1, -1).replace(/''/g, "'")
  }
  if (t.startsWith('"') && t.endsWith('"') && t.length >= 2) {
    try {
      return JSON.parse(t) as string
    } catch (cause) {
      throw new YamlError(`invalid double-quoted string: ${(cause as Error).message}`, lineNo)
    }
  }
  if (t.startsWith("'") || t.startsWith('"')) {
    throw new YamlError('unterminated quoted string', lineNo)
  }
  return t
}
