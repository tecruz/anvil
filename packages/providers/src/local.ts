/**
 * The `local` ticket provider: markdown files in a directory.
 *
 * This is not a test stub. It is the **escape hatch** for the situation the whole tool is
 * built around: you walk into a company whose network blocks API egress, or whose tracker
 * needs an account you do not have, and anvil must still work. A crew of three worktrees
 * with no API access is the case this provider exists for.
 *
 * Tickets are one markdown file per ticket, with a small frontmatter block. Bodies stay
 * markdown, so there is no format conversion and nothing to get wrong.
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { AnvilError, ErrorCode } from '@anvil/core'
import type {
  AuthStatus,
  NormalizedState,
  ProviderCapabilities,
  ProviderId,
  Ticket,
  TicketComment,
  TicketDraft,
  TicketProvider,
  TicketQuery,
  TicketRef,
  Transition,
} from '@anvil/tickets'

export const DEFAULT_TICKETS_DIR = '.anvil/tickets'

/** Frontmatter the local provider understands. Deliberately tiny. */
const STATES: NormalizedState[] = ['todo', 'in_progress', 'in_review', 'done', 'wontfix', 'unknown']

export interface LocalProviderOptions {
  /** Directory holding the ticket files, absolute. */
  dir: string
  id?: ProviderId
}

export class LocalTicketProvider implements TicketProvider {
  readonly id: ProviderId
  readonly capabilities: ProviderCapabilities = {
    create: true,
    comment: true,
    transition: true,
    link: true,
    list: true,
    rawBodies: false,
  }

  private readonly dir: string

  constructor(options: LocalProviderOptions) {
    this.id = options.id ?? 'local'
    this.dir = options.dir
  }

  /** Always available: it is a directory on disk. */
  async authStatus(): Promise<AuthStatus> {
    if (!existsSync(this.dir)) {
      return {
        ok: false,
        detail: `Ticket directory does not exist: ${this.dir}`,
        remediation: `Create it, or run \`anvil issue create\` to make the first ticket.`,
      }
    }
    return { ok: true, identity: `local files in ${this.dir}` }
  }

  private pathFor(id: string): string {
    // The id comes from user input (`anvil issue show ../../etc/passwd`), so it must
    // never be allowed to escape the tickets directory.
    if (id !== '' && (id.includes('/') || id.includes('\\') || id.includes('..'))) {
      throw new AnvilError(ErrorCode.Usage, `Invalid ticket id: ${id}`, {
        hint: 'A local ticket id is a bare identifier, not a path.',
      })
    }
    return join(this.dir, `${id}.md`)
  }

  async fetch(ref: TicketRef): Promise<LocalTicket> {
    const path = this.pathFor(ref.id)
    if (!existsSync(path)) {
      throw new AnvilError(ErrorCode.Usage, `No local ticket "${ref.id}"`, {
        hint: `Looked in ${path}. Run \`anvil issue list\` to see what is there.`,
      })
    }
    return parseTicketFile(readFileSync(path, 'utf8'), ref, path)
  }

  async list(query: TicketQuery = {}): Promise<TicketRef[]> {
    if (!existsSync(this.dir)) return []
    const refs: TicketRef[] = []
    for (const file of readdirSync(this.dir)) {
      if (!file.endsWith('.md')) continue
      const id = file.slice(0, -'.md'.length)
      const ref: TicketRef = {
        provider: this.id,
        id,
        key: keyFor(this.id, id),
      }
      if (query.state !== undefined) {
        const state = peekState(readFileSync(join(this.dir, file), 'utf8'))
        if (state !== query.state) continue
      }
      if (query.label !== undefined) {
        const labels = peekLabels(readFileSync(join(this.dir, file), 'utf8'))
        if (!labels.includes(query.label)) continue
      }
      refs.push(ref)
      if (query.limit !== undefined && refs.length >= query.limit) break
    }
    return refs
  }

  async create(draft: TicketDraft): Promise<TicketRef> {
    mkdirSync(this.dir, { recursive: true })
    const id = nextNumericId(this.dir)
    const path = this.pathFor(id)
    const content = renderTicketFile({
      title: draft.title,
      body: draft.body ?? '',
      state: 'todo',
      labels: draft.labels ?? [],
      baseBranch: draft.baseBranch ?? null,
    })
    writeFileSync(path, content, 'utf8')
    return { provider: this.id, id, key: keyFor(this.id, id) }
  }

  async comment(ref: TicketRef, body: string): Promise<void> {
    const ticket = await this.fetch(ref)
    const stamp = new Date().toISOString()
    const entry = `\n## Comment (local, ${stamp})\n\n${body}\n`
    const path = this.pathFor(ref.id)
    writeFileSync(path, ticket.rawText + entry, 'utf8')
  }

  async transitions(_ref: TicketRef): Promise<Transition[]> {
    return STATES.filter((s) => s !== 'unknown').map((to) => ({
      to,
      name: to,
    }))
  }

  async transition(ref: TicketRef, to: NormalizedState): Promise<void> {
    if (!STATES.includes(to)) {
      throw new AnvilError(ErrorCode.Usage, `Unknown state: ${to}`, {
        hint: `Expected one of: ${STATES.filter((s) => s !== 'unknown').join(', ')}`,
      })
    }
    const ticket = await this.fetch(ref)
    writeFileSync(this.pathFor(ref.id), replaceState(ticket.rawText, to), 'utf8')
  }

  async link(ref: TicketRef, url: string, title?: string): Promise<void> {
    const ticket = await this.fetch(ref)
    const label = title ?? url
    const entry = `\n- [${label}](${url})\n`
    const marker = '## Links'
    const withLinks = ticket.rawText.includes(marker)
      ? ticket.rawText.replace(marker, `${marker}\n${entry}`)
      : `${ticket.rawText}\n## Links\n${entry}`
    writeFileSync(this.pathFor(ref.id), withLinks, 'utf8')
  }
}

function keyFor(provider: string, id: string): string {
  return `${provider}-${id}`
}

function nextNumericId(dir: string): string {
  if (!existsSync(dir)) return '1'
  let max = 0
  for (const file of readdirSync(dir)) {
    if (!file.endsWith('.md')) continue
    const n = Number.parseInt(file.slice(0, -'.md'.length), 10)
    if (Number.isFinite(n) && n > max) max = n
  }
  return String(max + 1)
}

// ---------------------------------------------------------------------------
// File format
// ---------------------------------------------------------------------------

export interface TicketFileInput {
  title: string
  body: string
  state: NormalizedState
  labels: string[]
  baseBranch: string | null
  priority?: string
  assignee?: string
}

export function renderTicketFile(input: TicketFileInput): string {
  const out: string[] = []
  out.push('---')
  out.push(`title: ${JSON.stringify(input.title)}`)
  out.push(`state: ${input.state}`)
  if (input.labels.length > 0) out.push(`labels: [${input.labels.join(', ')}]`)
  if (input.priority !== undefined) out.push(`priority: ${input.priority}`)
  if (input.assignee !== undefined) out.push(`assignee: ${input.assignee}`)
  if (input.baseBranch !== null) out.push(`baseBranch: ${input.baseBranch}`)
  out.push('---')
  out.push('')
  out.push(`# ${input.title}`)
  out.push('')
  out.push(input.body.trim())
  out.push('')
  return out.join('\n')
}

interface Frontmatter {
  [key: string]: string
}

function splitFrontmatter(text: string): { fm: Frontmatter; body: string } {
  const normalized = text.replace(/^﻿/, '').replace(/\r\n/g, '\n')
  if (!normalized.startsWith('---')) return { fm: {}, body: normalized }

  const end = normalized.indexOf('\n---', 3)
  if (end === -1) return { fm: {}, body: normalized }

  const block = normalized.slice(3, end)
  const body = normalized.slice(end + 4).replace(/^\n/, '')
  const fm: Frontmatter = {}
  for (const line of block.split('\n')) {
    const m = /^([A-Za-z_][\w-]*)\s*:\s*(.*)$/.exec(line)
    if (m === null) continue
    let value = (m[2] ?? '').trim()
    if (value.startsWith('"') && value.endsWith('"') && value.length >= 2) value = value.slice(1, -1)
    fm[m[1] as string] = value
  }
  return { fm, body }
}

function parseState(value: string | undefined): NormalizedState {
  if (value === undefined) return 'unknown'
  return STATES.includes(value as NormalizedState) ? (value as NormalizedState) : 'unknown'
}

function parseLabels(value: string | undefined): string[] {
  if (value === undefined || value === '') return []
  const inner = value.replace(/^\[|\]$/g, '')
  return inner
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s !== '')
}

/**
 * A ticket read from disk, plus the exact bytes it was read from.
 *
 * `rawText` is separate from `Ticket.raw` because a write-back must not re-serialize:
 * rewriting a file anvil only partially understands would quietly delete anything it
 * failed to parse.
 */
export interface LocalTicket extends Ticket {
  rawText: string
}

/** Parse a ticket file, preserving the raw text so a write-back cannot lose anything. */
export function parseTicketFile(text: string, ref: TicketRef, path: string): LocalTicket {
  const { fm, body } = splitFrontmatter(text)
  const title = fm.title ?? firstHeading(body) ?? ref.key
  const acceptance = [...body.matchAll(/^\s*[-*]\s*\[ \]\s*(.+)$/gm)].map((m) => (m[1] ?? '').trim())
  const comments: TicketComment[] = [...body.matchAll(/^## Comment[^\n]*\n\n([\s\S]*?)(?=\n## |\n*$)/gm)].map((m) => ({
    author: 'local',
    body: (m[1] ?? '').trim(),
    at: '',
  }))

  return {
    ref: { ...ref, url: ref.url ?? `file://${path.split('\\').join('/')}` },
    title,
    body: body.trim(),
    ...(fm.state === undefined ? {} : { state: fm.state }),
    normalizedState: parseState(fm.state),
    ...(fm.priority === undefined ? {} : { priority: fm.priority }),
    ...(fm.assignee === undefined ? {} : { assignee: fm.assignee }),
    labels: parseLabels(fm.labels),
    baseBranch: fm.baseBranch ?? null,
    acceptance,
    comments,
    raw: text,
    rawText: text,
  }
}

function firstHeading(body: string): string | null {
  const m = /^#\s+(.+)$/m.exec(body)
  return m === null ? null : (m[1] as string).trim()
}

function replaceState(text: string, to: NormalizedState): string {
  if (/^state:/m.test(text)) return text.replace(/^state:.*$/m, `state: ${to}`)
  return text.replace(/^---$/m, (m, offset: number) => (offset === 0 ? `---\nstate: ${to}` : m))
}

function peekState(text: string): NormalizedState {
  return parseState(splitFrontmatter(text).fm.state)
}

function peekLabels(text: string): string[] {
  return parseLabels(splitFrontmatter(text).fm.labels)
}
