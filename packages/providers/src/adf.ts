/**
 * Atlassian Document Format <-> markdown.
 *
 * Jira Cloud does not store markdown: descriptions and comments are ADF documents. The
 * provider contract keeps `Ticket.body` markdown, so the conversion belongs at the
 * transport boundary. It is deliberately a *documented subset* rather than an attempt to
 * round-trip every ADF node: text, marks, headings, lists, checklists, quotes, code and
 * rules are the shapes a ticket actually uses. An unknown node keeps its text instead of
 * disappearing, because a lossy read is recoverable and a silent deletion is not.
 *
 * The conversion is pure and has no dependency. It is tested on representative documents
 * in `packages/providers/test/adf.test.ts`.
 */

export interface AdfMark {
  type: string
  attrs?: Record<string, unknown>
}

export interface AdfNode {
  type: string
  text?: string
  content?: AdfNode[]
  attrs?: Record<string, unknown>
  marks?: AdfMark[]
}

export interface AdfDoc {
  type: 'doc'
  version: 1
  content: AdfNode[]
}

function asNode(value: unknown): AdfNode | null {
  if (value === null || typeof value !== 'object') return null
  const node = value as { type?: unknown; text?: unknown; content?: unknown; attrs?: unknown; marks?: unknown }
  if (typeof node.type !== 'string') return null
  return {
    type: node.type,
    ...(typeof node.text === 'string' ? { text: node.text } : {}),
    ...(Array.isArray(node.content)
      ? { content: node.content.map(asNode).filter((n): n is AdfNode => n !== null) }
      : {}),
    ...(node.attrs !== null && typeof node.attrs === 'object' ? { attrs: node.attrs as Record<string, unknown> } : {}),
    ...(Array.isArray(node.marks) ? { marks: node.marks as AdfMark[] } : {}),
  }
}

/** Render an ADF document (or one node) as normalized markdown. */
export function adfToMarkdown(value: unknown): string {
  if (typeof value === 'string') return value
  const node = asNode(value)
  if (node === null) return ''
  if (node.type === 'doc') return renderBlocks(node.content ?? [])
  return renderBlock(node)
}

function renderBlocks(nodes: readonly AdfNode[]): string {
  return nodes
    .map((node) => renderBlock(node).trimEnd())
    .filter((text) => text.trim() !== '')
    .join('\n\n')
}

function renderBlock(node: AdfNode): string {
  switch (node.type) {
    case 'doc':
      return renderBlocks(node.content ?? [])
    case 'paragraph':
      return renderInline(node.content ?? []).trim()
    case 'heading': {
      const level = typeof node.attrs?.level === 'number' ? Math.min(Math.max(node.attrs.level, 1), 6) : 1
      return `${'#'.repeat(level)} ${renderInline(node.content ?? []).trim()}`
    }
    case 'bulletList':
      return (node.content ?? [])
        .map((item) => renderListItem(item, '-'))
        .filter((text) => text !== '')
        .join('\n')
    case 'orderedList':
      return (node.content ?? [])
        .map((item, index) => renderListItem(item, `${index + 1}.`))
        .filter((text) => text !== '')
        .join('\n')
    case 'taskList':
      return (node.content ?? [])
        .map((item) => renderTaskItem(item))
        .filter((text) => text !== '')
        .join('\n')
    case 'listItem':
      return renderListItem(node, '-')
    case 'taskItem':
      return renderTaskItem(node)
    case 'blockquote':
      return renderBlocks(node.content ?? [])
        .split('\n')
        .map((line) => `> ${line}`)
        .join('\n')
    case 'codeBlock': {
      const language = typeof node.attrs?.language === 'string' ? node.attrs.language : ''
      const body = textOf(node.content ?? [])
      return `\`\`\`${language}\n${body}\n\`\`\``
    }
    case 'rule':
      return '---'
    case 'hardBreak':
      return '  \n'
    case 'mediaSingle':
    case 'mediaGroup':
      return renderBlocks(node.content ?? [])
    case 'media': {
      const alt = typeof node.attrs?.alt === 'string' && node.attrs.alt !== '' ? node.attrs.alt : 'media'
      return `[${alt}]`
    }
    case 'panel':
    case 'expand':
    case 'nestedExpand':
      return renderBlocks(node.content ?? [])
    case 'table':
      return (node.content ?? [])
        .map((row) =>
          (row.content ?? [])
            .map((cell) =>
              renderBlocks(cell.content ?? [])
                .replace(/\n+/g, ' ')
                .trim(),
            )
            .join(' | '),
        )
        .map((row) => `| ${row} |`)
        .join('\n')
    case 'tableRow':
      return (node.content ?? []).map((cell) => renderBlocks(cell.content ?? [])).join(' | ')
    case 'tableCell':
    case 'tableHeader':
      return renderBlocks(node.content ?? [])
    case 'text':
      return applyMarks(node.text ?? '', node.marks ?? [])
    default:
      return node.content === undefined ? (node.text ?? '') : renderBlocks(node.content)
  }
}

function renderListItem(node: AdfNode, prefix: string): string {
  const body = renderBlocks(node.content ?? []).trim()
  if (body === '') return ''
  const [first, ...rest] = body.split('\n')
  const indented = rest.map((line) => (line === '' ? '' : `  ${line}`)).join('\n')
  return `${prefix} ${first ?? ''}${indented === '' ? '' : `\n${indented}`}`
}

/** ADF block nodes. A task item holds inline nodes, but older payloads may wrap them. */
const BLOCK_NODE_TYPES: ReadonlySet<string> = new Set([
  'paragraph',
  'bulletList',
  'orderedList',
  'taskList',
  'blockquote',
  'codeBlock',
  'mediaSingle',
  'mediaGroup',
  'panel',
  'expand',
  'nestedExpand',
  'table',
  'rule',
])

function renderTaskItem(node: AdfNode): string {
  const state = typeof node.attrs?.state === 'string' && node.attrs.state.toLowerCase() === 'done' ? 'x' : ' '
  const content = node.content ?? []
  // A task item is inline in ADF. Every child goes through the inline renderer, so an
  // unrecognised inline node (a media attachment, an extension) cannot force the whole
  // item through the block renderer and take its links and dates down with it. Payloads
  // that really do wrap text in a paragraph are still handled as blocks.
  const blocks = content.some((child) => BLOCK_NODE_TYPES.has(child.type))
  const body = (blocks ? renderBlocks(content) : renderInline(content)).replace(/\n+/g, ' ').trim()
  return `- [${state}] ${body}`
}

function renderInline(nodes: readonly AdfNode[]): string {
  return nodes.map(renderInlineNode).join('')
}

function renderInlineNode(node: AdfNode): string {
  switch (node.type) {
    case 'text':
      return applyMarks(node.text ?? '', node.marks ?? [])
    case 'hardBreak':
      return '  \n'
    case 'mention': {
      const label = node.attrs?.text
      return `@${typeof label === 'string' && label !== '' ? label : String(node.attrs?.id ?? 'unknown')}`
    }
    case 'emoji': {
      const text = node.attrs?.text
      if (typeof text === 'string' && text !== '') return text
      const shortName = node.attrs?.shortName
      return typeof shortName === 'string' && shortName !== '' ? `:${shortName}:` : ''
    }
    case 'inlineCard': {
      const url = node.attrs?.url
      return typeof url === 'string' ? url : ''
    }
    case 'mediaInline': {
      const alt = typeof node.attrs?.alt === 'string' && node.attrs.alt !== '' ? node.attrs.alt : 'media'
      return `[${alt}]`
    }
    case 'placeholder':
    case 'inlineExtension': {
      const text = node.attrs?.text
      return typeof text === 'string' ? text : ''
    }
    case 'status': {
      const text = node.attrs?.text
      return typeof text === 'string' ? text : ''
    }
    case 'date': {
      // ADF types `timestamp` as a string of epoch milliseconds; older payloads use a
      // number. Dropping the string form left a sentence like "Due 2026-11-17" as "Due".
      const timestamp = node.attrs?.timestamp
      if (typeof timestamp !== 'number' && typeof timestamp !== 'string') return ''
      if (typeof timestamp === 'string' && timestamp.trim() === '') return ''
      const millis = typeof timestamp === 'number' ? timestamp : Number(timestamp.trim())
      if (!Number.isFinite(millis)) return ''
      const date = new Date(millis)
      // A finite number can still be outside Date's range; toISOString would throw.
      if (Number.isNaN(date.getTime())) return ''
      return date.toISOString().slice(0, 10)
    }
    default:
      return node.content === undefined ? (node.text ?? '') : renderInline(node.content)
  }
}

function applyMarks(text: string, marks: readonly AdfMark[]): string {
  const kinds = new Set(marks.map((mark) => mark.type))
  if (kinds.has('code')) return `\`${text.replace(/`/g, '\\`')}\``
  let out = text
  if (kinds.has('strong')) out = `**${out}**`
  if (kinds.has('em')) out = `*${out}*`
  if (kinds.has('strike')) out = `~~${out}~~`
  const link = marks.find((mark) => mark.type === 'link')
  const href = link?.attrs?.href
  if (typeof href === 'string' && href !== '') out = `[${out}](${href})`
  return out
}

function textOf(nodes: readonly AdfNode[]): string {
  return nodes.map((node) => (node.type === 'text' ? (node.text ?? '') : textOf(node.content ?? []))).join('')
}

// ---------------------------------------------------------------------------
// markdown -> ADF
// ---------------------------------------------------------------------------

const INLINE =
  /(`[^`\n]+`)|(\*\*[^*\n]+\*\*)|(__[^_\n]+__)|(~~[^~\n]+~~)|(\*[^*\n]+\*)|(_[^_\n]+_)|(\[[^\]\n]+\]\([^)\n]+\))/g

const FENCE = /^\s*```([^`]*)$/
const HEADING = /^(#{1,6})\s+(.*)$/
const BULLET = /^\s*[-*+]\s+(.*)$/
const ORDERED = /^\s*\d+[.)]\s+(.*)$/
const QUOTE = /^\s*>\s?(.*)$/
const RULE = /^\s*(?:---|\*\*\*|___)\s*$/
const CHECKLIST = /^\[([ xX])\]\s*(.*)$/

/** Convert the markdown a ticket holds into the ADF document Jira expects. */
export function markdownToAdf(markdown: string): AdfDoc {
  const lines = markdown.replace(/^﻿/, '').replace(/\r\n/g, '\n').split('\n')
  const content: AdfNode[] = []
  let i = 0

  while (i < lines.length) {
    const line = lines[i] as string
    if (line.trim() === '') {
      i++
      continue
    }

    const fence = FENCE.exec(line)
    if (fence !== null) {
      const language = (fence[1] ?? '').trim()
      const body: string[] = []
      i++
      while (i < lines.length && !/^\s*```\s*$/.test(lines[i] as string)) {
        body.push(lines[i] as string)
        i++
      }
      if (i < lines.length) i++
      content.push({
        type: 'codeBlock',
        ...(language === '' ? {} : { attrs: { language } }),
        content: body.length === 0 ? [] : [{ type: 'text', text: body.join('\n') }],
      })
      continue
    }

    const heading = HEADING.exec(line)
    if (heading !== null) {
      content.push({
        type: 'heading',
        attrs: { level: (heading[1] as string).length },
        content: inline((heading[2] ?? '').trim()),
      })
      i++
      continue
    }

    if (RULE.test(line)) {
      content.push({ type: 'rule' })
      i++
      continue
    }

    if (QUOTE.test(line)) {
      const quoted: string[] = []
      while (i < lines.length && QUOTE.test(lines[i] as string)) {
        quoted.push((QUOTE.exec(lines[i] as string)?.[1] ?? '').trimEnd())
        i++
      }
      const inner = markdownToAdf(quoted.join('\n'))
      content.push({ type: 'blockquote', content: inner.content })
      continue
    }

    if (BULLET.test(line)) {
      const items: AdfNode[] = []
      while (i < lines.length && BULLET.test(lines[i] as string)) {
        const text = (BULLET.exec(lines[i] as string)?.[1] ?? '').trimEnd()
        items.push({ type: 'listItem', content: [{ type: 'paragraph', content: listItemInline(text) }] })
        i++
      }
      content.push({ type: 'bulletList', content: items })
      continue
    }

    if (ORDERED.test(line)) {
      const items: AdfNode[] = []
      while (i < lines.length && ORDERED.test(lines[i] as string)) {
        const text = (ORDERED.exec(lines[i] as string)?.[1] ?? '').trimEnd()
        items.push({ type: 'listItem', content: [{ type: 'paragraph', content: listItemInline(text) }] })
        i++
      }
      content.push({ type: 'orderedList', content: items })
      continue
    }

    // A paragraph runs until a blank line or the start of another block construct.
    const paragraph: string[] = []
    while (i < lines.length && !isBlockStart(lines[i] as string)) {
      paragraph.push(lines[i] as string)
      i++
    }
    if (paragraph.length === 0) {
      // Defensive: a line that looked like a block start but was not consumed above must
      // still make progress rather than looping forever.
      paragraph.push(line)
      i++
    }
    content.push({ type: 'paragraph', content: paragraphInline(paragraph) })
  }

  return { type: 'doc', version: 1, content }
}

function isBlockStart(line: string): boolean {
  return (
    line.trim() === '' ||
    FENCE.test(line) ||
    HEADING.test(line) ||
    RULE.test(line) ||
    QUOTE.test(line) ||
    BULLET.test(line) ||
    ORDERED.test(line)
  )
}

/**
 * A checklist entry is kept as literal `[ ]`/`[x]` text inside a normal bullet.
 *
 * Jira's ADF has task lists, but their `localId` and state schema varies between
 * deployments. A literal checklist survives every Jira renderer, and the shared
 * acceptance extractor reads it back exactly as it reads a GitHub or local ticket.
 */
function listItemInline(text: string): AdfNode[] {
  const check = CHECKLIST.exec(text)
  if (check === null) return inline(text)
  const state = (check[1] ?? ' ').toLowerCase() === 'x' ? 'x' : ' '
  const rest = (check[2] ?? '').trim()
  return inline(`[${state}]${rest === '' ? '' : ` ${rest}`}`)
}

function paragraphInline(lines: readonly string[]): AdfNode[] {
  const content: AdfNode[] = []
  lines.forEach((line, index) => {
    if (index > 0) content.push({ type: 'hardBreak' })
    content.push(...inline(line))
  })
  return content
}

function inline(text: string): AdfNode[] {
  const nodes: AdfNode[] = []
  let last = 0
  for (const match of text.matchAll(INLINE)) {
    const index = match.index ?? 0
    if (index > last) nodes.push({ type: 'text', text: text.slice(last, index) })
    const token = match[0]
    nodes.push(...inlineToken(token))
    last = index + token.length
  }
  if (last < text.length) nodes.push({ type: 'text', text: text.slice(last) })
  return nodes
}

function inlineToken(token: string): AdfNode[] {
  if (token.startsWith('`') && token.endsWith('`')) {
    return [{ type: 'text', text: token.slice(1, -1), marks: [{ type: 'code' }] }]
  }
  if (token.startsWith('**') && token.endsWith('**')) {
    return withMark(inline(token.slice(2, -2)), { type: 'strong' })
  }
  if (token.startsWith('__') && token.endsWith('__')) {
    return withMark(inline(token.slice(2, -2)), { type: 'strong' })
  }
  if (token.startsWith('~~') && token.endsWith('~~')) {
    return withMark(inline(token.slice(2, -2)), { type: 'strike' })
  }
  if (token.startsWith('*') && token.endsWith('*')) {
    return withMark(inline(token.slice(1, -1)), { type: 'em' })
  }
  if (token.startsWith('_') && token.endsWith('_')) {
    return withMark(inline(token.slice(1, -1)), { type: 'em' })
  }
  const link = /^\[([^\]]+)\]\(([^)]+)\)$/.exec(token)
  if (link !== null) {
    return withMark(inline(link[1] ?? ''), { type: 'link', attrs: { href: link[2] ?? '' } })
  }
  return [{ type: 'text', text: token }]
}

function withMark(nodes: AdfNode[], mark: AdfMark): AdfNode[] {
  return nodes.map((node) => {
    if (node.type === 'text') return { ...node, marks: [...(node.marks ?? []), mark] }
    return node
  })
}
