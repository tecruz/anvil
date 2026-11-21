/**
 * Builds a read-only task brief from a dashboard snapshot.
 *
 * The brief answers three questions a newcomer has before touching a repository: where do I
 * start, how do I check the change, and what is missing? Every claim is tied to a profile
 * fact, a CLI value or a `file:line` from `plan`; the builder never guesses a requirement,
 * an owner or an approval gate.
 *
 * It deliberately does not execute anything. `howToCheck` names the command a human would
 * run, with the working directory and the source that established it. The brief records
 * that the command was not run.
 */

import type { DashboardSnapshot, VerificationEvidence } from './snapshot.ts'

export const MAX_TASK_TEXT = 4000
const MAX_START_ITEMS = 5
const MAX_TEST_ITEMS = 3
const MAX_CHECK_ITEMS = 4

export interface TaskBriefInput {
  /** Pasted task or ticket text. Untrusted. Exactly one of `text` and `suggestionId`. */
  text?: string
  /** A `plan` suggestion id, when the user starts from a repository finding. */
  suggestionId?: string
}

export interface TaskStartItem {
  path: string
  reason: string
  kind: 'source' | 'test' | 'evidence' | 'module'
}

export interface TaskCheck {
  kind: string
  cmd: string
  source: string
  evidence: string | null
  cwd: string
}

export interface TaskBlocker {
  label: string
  status: string
  reason: string
  /** A contact the owner declared in the readiness report, never inferred. */
  grantedBy?: string | null
}

/** A copyable handoff for a task that cannot proceed. It names only declared blockers. */
export interface TaskHandoff {
  schemaVersion: 1
  /** False when there is no measured blocker to hand off. */
  available: boolean
  text: string
  sources: string[]
}

export interface TaskMapNode {
  id: string
  label: string
  kind: 'file' | 'module' | 'check' | 'unknown'
  /** Why this node is in the task subgraph. */
  reason: string
  /** The CLI value or `file:line` that proves it; null is displayed as unknown. */
  evidence: string | null
}

export interface TaskMapEdge {
  from: string
  to: string
  label: string
  evidence: string | null
}

/** A task-focused subgraph, never a whole-repository diagram. */
export interface TaskMap {
  schemaVersion: 1
  focus: string
  nodes: TaskMapNode[]
  edges: TaskMapEdge[]
  /** True when the profile did not resolve dependencies for a relevant module. */
  hasUnknown: boolean
}

/**
 * A gate the pasted task states itself.
 *
 * It is quoted, never inferred: `evidence` is the sentence the reader wrote, so a wrong
 * reading is checkable in one line. A suggestions-only brief has no gate, because a
 * repository finding cannot carry one.
 */
export interface TaskGate {
  kind: 'approval'
  /** What the sentence allows before approval, when it names it. */
  startNow: string | null
  /** What the sentence blocks until approval, when it names it. */
  waitFor: string | null
  /** The sentence that stated the gate, as the task wrote it. */
  evidence: string
}

export interface TaskBrief {
  schemaVersion: 1
  generatedAt: string
  source: {
    suggestionId: string | null
    text: string | null
  }
  title: string
  objective: string
  startHere: TaskStartItem[]
  /** The same task, as a reproducible 2D subgraph. */
  map: TaskMap
  howToCheck: TaskCheck[]
  /** Post-change facts from an explicitly run, bounded verification; never a claim of success. */
  verification: {
    status: 'unavailable' | 'recorded'
    reason: string
    currentRevision: string | null
    incompleteCount: number
    evidence: VerificationEvidence[]
  }
  blockers: TaskBlocker[]
  /** Copyable handoff, or an explicit reason why none can be produced. */
  handoff: TaskHandoff
  /** Empty when the task stated no gate; the unknowns then say so. */
  gates: TaskGate[]
  /**
   * Whether the blocker list is a measurement or an absence of one.
   *
   * `ok: false` means `anvil ready` failed, so "no blockers" must not read as a pass.
   */
  readiness: {
    ok: boolean
    checked: boolean
    status: string | null
  }
  unknowns: string[]
}

/** A request the user can correct without retrying the whole page. */
export class TaskInputError extends Error {}

const STOPWORDS = new Set([
  'about',
  'after',
  'again',
  'against',
  'all',
  'also',
  'and',
  'any',
  'are',
  'because',
  'been',
  'before',
  'being',
  'between',
  'both',
  'but',
  'can',
  'could',
  'does',
  'each',
  'for',
  'from',
  'has',
  'have',
  'into',
  'its',
  'may',
  'more',
  'most',
  'must',
  'not',
  'only',
  'other',
  'our',
  'out',
  'over',
  'same',
  'should',
  'some',
  'such',
  'than',
  'that',
  'the',
  'their',
  'then',
  'there',
  'these',
  'they',
  'this',
  'those',
  'through',
  'under',
  'use',
  'used',
  'using',
  'was',
  'were',
  'what',
  'when',
  'where',
  'which',
  'while',
  'will',
  'with',
  'would',
  'you',
  'your',
])

/** Generic path segments that would match almost every file. */
const GENERIC_SEGMENTS = new Set([
  'app',
  'assets',
  'com',
  'core',
  'example',
  'java',
  'kotlin',
  'main',
  'org',
  'res',
  'resources',
  'src',
  'test',
  'tests',
])

/** Basenames often contain these; matching one says nothing about the task. */
const NAME_STOPWORDS = new Set(['app', 'bar', 'common', 'core', 'index', 'main', 'test', 'tests', 'util', 'utils'])

const FILE_REFERENCE =
  /[A-Za-z0-9_./\\-]+\.(?:kts|kt|tsx|ts|jsx|js|cjs|mjs|java|py|go|rs|cs|fs|swift|dart|php|rb|sh|ps1|md|json|ya?ml|xml|gradle|toml|sql|proto)/g

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : []
}

function asString(value: unknown): string | null {
  return typeof value === 'string' ? value : null
}

/** Split an identifier, path segment or prose word into lower-case tokens. */
function splitWords(value: string): string[] {
  return value
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .split(/[^A-Za-z0-9]+/)
    .map((part) => part.toLowerCase())
    .filter((part) => part !== '')
}

/** A crude singular form, enough to match `tests` with `test` and `screens` with `screen`. */
function stem(token: string): string {
  if (
    token.length > 4 &&
    token.endsWith('s') &&
    !token.endsWith('ss') &&
    !token.endsWith('us') &&
    !token.endsWith('is')
  ) {
    return token.slice(0, -1)
  }
  return token
}

function taskTokens(text: string): string[] {
  const seen = new Set<string>()
  const tokens: string[] = []
  for (const raw of text.toLowerCase().split(/[^\p{L}\p{N}]+/u)) {
    if (raw.length < 3 || raw.length > 40) continue
    if (!/^[a-z0-9]+$/.test(raw)) continue
    if (STOPWORDS.has(raw)) continue
    const value = stem(raw)
    if (seen.has(value)) continue
    seen.add(value)
    tokens.push(value)
    if (tokens.length >= 32) break
  }
  return tokens
}

function basename(path: string): string {
  const index = path.lastIndexOf('/')
  return index === -1 ? path : path.slice(index + 1)
}

function withoutExtension(path: string): string {
  const name = basename(path)
  const dot = name.lastIndexOf('.')
  return dot <= 0 ? name : name.slice(0, dot)
}

function isTestPath(path: string): boolean {
  return /(^|\/)(test|tests|androidTest)\//.test(path) || /Test\.(?:kt|java|ts|tsx|js|py)$/.test(path)
}

function fileSet(snapshot: DashboardSnapshot): Set<string> {
  const record = asRecord(snapshot.repository.profile.data)
  const files = asArray(record?.files).filter((file): file is string => typeof file === 'string')
  return new Set(files)
}

function normalizeReference(value: string): string {
  return value.replace(/\\/g, '/').replace(/^\.\//, '').replace(/^\/+/, '')
}

/**
 * Paths explicitly named in the task.
 *
 * An exact repo-relative path outranks a path that merely ends the same way: `src/auth.ts`
 * is a different file from `examples/src/auth.ts`, and presenting the lookalike first is how
 * a brief sends someone to the wrong module. Both are still shown, with a reason that says
 * which one matched exactly.
 */
function explicitMatches(text: string, files: Set<string>): { items: TaskStartItem[]; unmatched: string[] } {
  const unmatched: string[] = []
  const references = (text.replace(/https?:\/\/\S+/g, ' ').match(FILE_REFERENCE) ?? []).slice(0, 20)
  const byPath = new Map<string, { path: string; exact: boolean; order: number }>()
  let order = 0

  for (const reference of references) {
    const normalized = normalizeReference(reference).toLowerCase()
    if (normalized === '' || normalized.includes('..')) continue
    let found = false
    for (const path of files) {
      const lower = path.toLowerCase()
      const exact = lower === normalized
      if (!exact && !lower.endsWith(`/${normalized}`)) continue
      found = true
      const existing = byPath.get(path)
      // The same file can be reached by both spellings; keep the stronger reason and the
      // earliest place the task mentioned it.
      if (existing === undefined) byPath.set(path, { path, exact, order: order++ })
      else if (!existing.exact && exact) byPath.set(path, { ...existing, exact })
    }
    if (!found && !unmatched.includes(reference) && unmatched.length < 3) unmatched.push(reference)
  }

  const items = [...byPath.values()]
    // Exact matches first, then the order the task named them: a reader pasting a ticket
    // expects the brief to follow the ticket's own sequence, not alphabetical noise.
    .sort((a, b) => Number(b.exact) - Number(a.exact) || a.order - b.order)
    .slice(0, MAX_START_ITEMS)
    .map(({ path, exact }) => ({
      path,
      reason: exact ? 'named in the task text' : 'matches the end of a repository path',
      kind: isTestPath(path) ? ('test' as const) : ('source' as const),
    }))
  return { items, unmatched }
}

/** Paths whose name or directory shares a meaningful token with the task. */
function lexicalMatches(text: string, files: Set<string>, exclude: Set<string>): TaskStartItem[] {
  const tokens = taskTokens(text)
  if (tokens.length === 0) return []

  const scored: Array<{ path: string; score: number; test: boolean; matched: string[] }> = []
  for (const path of files) {
    if (exclude.has(path)) continue
    const nameParts = splitWords(withoutExtension(path)).map(stem)
    const directoryParts = path.split('/').slice(0, -1).flatMap(splitWords).map(stem)
    const matched: string[] = []
    let score = 0
    for (const token of tokens) {
      if (NAME_STOPWORDS.has(token)) continue
      if (nameParts.includes(token)) {
        score += 3
        matched.push(token)
      } else if (directoryParts.includes(token) && !GENERIC_SEGMENTS.has(token)) {
        score += 1
        matched.push(token)
      }
    }
    if (score >= 2) {
      scored.push({ path, score, test: isTestPath(path), matched: [...new Set(matched)] })
    }
  }

  scored.sort(
    (a, b) =>
      b.score - a.score ||
      Number(a.test) - Number(b.test) ||
      a.path.length - b.path.length ||
      a.path.localeCompare(b.path),
  )
  return scored.slice(0, MAX_START_ITEMS).map((entry) => ({
    path: entry.path,
    reason: `path matches ${entry.matched.map((token) => `"${token}"`).join(', ')}`,
    kind: entry.test ? 'test' : 'source',
  }))
}

/** Add the test files that name a matched source, so "where to start" includes coverage. */
function testsFor(items: TaskStartItem[], files: Set<string>): TaskStartItem[] {
  const seen = new Set(items.map((item) => item.path))
  const added: TaskStartItem[] = []
  for (const item of items) {
    if (item.kind !== 'source') continue
    const name = withoutExtension(item.path)
    if (name === '') continue
    for (const path of files) {
      if (seen.has(path) || !isTestPath(path)) continue
      if (!withoutExtension(path).toLowerCase().includes(name.toLowerCase())) continue
      seen.add(path)
      added.push({ path, reason: `test for ${item.path}`, kind: 'test' })
      if (added.length >= MAX_TEST_ITEMS) return added
    }
  }
  return added
}

function evidencePaths(evidence: string[], files: Set<string>): TaskStartItem[] {
  const items: TaskStartItem[] = []
  const seen = new Set<string>()
  for (const entry of evidence) {
    const colon = entry.lastIndexOf(':')
    const candidate = colon > 0 && /^\d+$/.test(entry.slice(colon + 1)) ? entry.slice(0, colon) : entry
    const normalized = normalizeReference(candidate)
    if (!files.has(normalized) || seen.has(normalized)) continue
    seen.add(normalized)
    items.push({ path: normalized, reason: 'evidence named by the suggestion', kind: 'evidence' })
    if (items.length >= MAX_START_ITEMS) break
  }
  return items
}

function suggestionFor(snapshot: DashboardSnapshot, suggestionId: string): Record<string, unknown> {
  const plan = asRecord(snapshot.repository.plan.data)
  if (plan === null) throw new TaskInputError('The plan source is unavailable, so a suggestion cannot be opened.')
  for (const entry of asArray(plan.suggestions)) {
    const suggestion = asRecord(entry)
    if (suggestion !== null && asString(suggestion.id) === suggestionId) return suggestion
  }
  throw new TaskInputError('That suggestion is not in the current plan. Refresh the dashboard and try again.')
}

/** One verification command per purpose. `dir` comes from the CLI, never from the text. */
function commandChecks(snapshot: DashboardSnapshot): TaskCheck[] {
  const ready = asRecord(snapshot.repository.ready.data)
  const profile = asRecord(snapshot.repository.profile.data)
  const projectDir = asString(ready?.projectDir) ?? asString(profile?.projectDir) ?? ''
  const checks: TaskCheck[] = []
  const seen = new Set<string>()

  const add = (kind: string, cmd: string, source: string, evidence: string | null, dir: string): void => {
    if (checks.length >= MAX_CHECK_ITEMS || cmd === '' || seen.has(cmd)) return
    seen.add(cmd)
    checks.push({
      kind,
      cmd,
      source,
      evidence,
      cwd: dir === '' ? '.' : dir,
    })
  }

  if (ready !== null) {
    const commands = asArray(ready.commands)
      .map(asRecord)
      .filter((entry) => entry !== null)
    // A changed-files test subset is the fast loop; the full suite is the fallback.
    const wanted = ['testFast', 'test', 'lint', 'typecheck', 'build']
    for (const kind of wanted) {
      const entry = commands.find((candidate) => asString(candidate.kind) === kind)
      if (entry === undefined) continue
      add(
        kind,
        asString(entry.cmd) ?? '',
        asString(entry.source) ?? 'unknown',
        asString(entry.evidence),
        asString(entry.dir) ?? projectDir,
      )
      if (kind === 'testFast') {
        // Keep the full suite visible when the fast subset is present: they answer different questions.
        const full = commands.find((candidate) => asString(candidate.kind) === 'test')
        if (full !== undefined) {
          add(
            'test',
            asString(full.cmd) ?? '',
            asString(full.source) ?? 'unknown',
            asString(full.evidence),
            asString(full.dir) ?? projectDir,
          )
        }
      }
    }
    if (checks.length > 0) return checks
  }

  if (profile === null) return checks
  const commands = asRecord(profile.commands)
  if (commands === null) return checks
  for (const kind of ['testFast', 'test', 'lint', 'typecheck', 'build']) {
    const entry = asRecord(asArray(commands[kind])[0])
    if (entry === null) continue
    add(kind, asString(entry.cmd) ?? '', asString(entry.source) ?? 'unknown', asString(entry.evidence), projectDir)
  }
  return checks
}

function blockers(snapshot: DashboardSnapshot): TaskBlocker[] {
  const ready = asRecord(snapshot.repository.ready.data)
  if (ready === null) return []
  const found: TaskBlocker[] = []
  const add = (label: string, status: string, reason: string, grantedBy: string | null = null): void => {
    if (found.length >= 6) return
    if (found.some((item) => item.label === label && item.status === status)) return
    found.push({ label, status, reason, grantedBy })
  }
  const required = (entry: Record<string, unknown>): boolean => entry.required !== false
  const reasonOf = (entry: Record<string, unknown>): string => asString(entry.reason) ?? asString(entry.detail) ?? ''

  for (const entry of asArray(ready.tools)) {
    const record = asRecord(entry)
    if (record === null || !required(record)) continue
    const status = asString(record.status) ?? 'unknown'
    if (!['missing', 'unavailable', 'incompatible'].includes(status)) continue
    add(asString(record.id) ?? asString(record.bin) ?? 'tool', status, reasonOf(record))
  }
  for (const entry of asArray(ready.env)) {
    const record = asRecord(entry)
    if (record === null || !required(record)) continue
    const status = asString(record.status) ?? 'unknown'
    if (!['missing', 'empty'].includes(status)) continue
    add(asString(record.name) ?? 'environment variable', status, reasonOf(record))
  }
  for (const entry of asArray(ready.services)) {
    const record = asRecord(entry)
    if (record === null || !required(record)) continue
    if (asString(record.status) !== 'unreachable') continue
    add(asString(record.id) ?? 'service', 'unreachable', reasonOf(record))
  }
  for (const entry of asArray(ready.references)) {
    const record = asRecord(entry)
    if (record === null || !required(record)) continue
    if (asString(record.status) !== 'missing') continue
    add(asString(record.path) ?? asString(record.id) ?? 'reference', 'missing', reasonOf(record))
  }
  for (const key of ['credentials', 'access'] as const) {
    for (const entry of asArray(ready[key])) {
      const record = asRecord(entry)
      if (record === null || !required(record)) continue
      const status = asString(record.status) ?? 'unknown'
      if (!['missing', 'empty'].includes(status)) continue
      add(asString(record.id) ?? asString(record.kind) ?? key, status, reasonOf(record), asString(record.grantedBy))
    }
  }
  for (const entry of asArray(ready.hardware)) {
    const record = asRecord(entry)
    if (record === null || !required(record)) continue
    if (asString(record.status) !== 'unsatisfied') continue
    add(asString(record.id) ?? 'hardware', 'unsatisfied', reasonOf(record))
  }
  for (const entry of asArray(ready.context)) {
    const record = asRecord(entry)
    if (record === null || !required(record)) continue
    if (asString(record.status) !== 'blocked') continue
    add(asString(record.label) ?? asString(record.id) ?? 'context', 'blocked', reasonOf(record))
  }
  if (found.length === 0 && asString(ready.status) === 'blocked') {
    add('environment', 'unknown', 'anvil ready reports blocked, but no individual need named a cause.')
  }
  return found
}

/**
 * Build a handoff from the brief's measured blockers.
 *
 * Ownership is never inferred from a task, a file path or a stack. When the snapshot names a
 * CODEOWNERS file it is cited as review routing to open, not as an owner. A failed or unprobed
 * readiness source is an absence of evidence, so the handoff says that instead of inventing a
 * clean answer.
 */
export function buildTaskHandoff(
  snapshot: DashboardSnapshot,
  brief: Pick<TaskBrief, 'title' | 'blockers' | 'readiness'>,
): TaskHandoff {
  const sources = ['anvil ready --json']
  const profile = asRecord(snapshot.repository.profile.data)
  const docs = profile === null ? null : asRecord(profile.docs)
  const codeowners = docs === null ? null : asString(docs.codeowners)
  if (codeowners !== null) sources.push(`anvil profile --json: docs.codeowners (${codeowners})`)
  const contacts = [
    ...new Set(
      brief.blockers
        .map((blocker) => blocker.grantedBy)
        .filter((value): value is string => typeof value === 'string' && value !== ''),
    ),
  ]
  const contactLine =
    contacts.length > 0
      ? `Declared contact: ${contacts.join(', ')} (stated in anvil ready, not inferred).`
      : codeowners === null
        ? 'Owner: unknown — this snapshot declares no owner. Confirm the owner from the ticket or team process.'
        : `Owner: unknown — open the declared review routing at ${codeowners} to identify one.`

  const lines = [`Blocker handoff: ${brief.title}`, '']
  if (brief.readiness.ok === false) {
    lines.push(
      'Cannot identify blockers: anvil ready failed. Re-run `anvil ready --check` before handing this task off.',
      '',
      contactLine,
      '',
      `Sources: ${sources.join('; ')}`,
    )
    return { schemaVersion: 1, available: false, text: lines.join('\n'), sources }
  }

  const measured = brief.blockers.filter((blocker) => blocker.status !== 'unknown')
  if (measured.length === 0) {
    const cause =
      brief.blockers.find((blocker) => blocker.status === 'unknown')?.reason ??
      (brief.readiness.checked
        ? 'No blocker was reported by anvil ready.'
        : 'No blocker can be reported: the environment was not probed. Re-run `anvil ready --check` before handing this task off.')
    lines.push(cause, '', contactLine, '', `Sources: ${sources.join('; ')}`)
    return { schemaVersion: 1, available: false, text: lines.join('\n'), sources }
  }

  lines.push('Missing or blocked capabilities:')
  for (const blocker of measured) {
    lines.push(`- ${blocker.label} (${blocker.status}): ${blocker.reason || 'no reason was reported'}`)
  }
  lines.push('', contactLine, '', 'Next step: provide the capabilities above, then re-run `anvil ready --check`.', '')
  lines.push(`Sources: ${sources.join('; ')}`)
  return { schemaVersion: 1, available: true, text: lines.join('\n'), sources }
}

/**
 * Sentences that state an approval gate in prose.
 *
 * A ticket is where a team writes its own process (`the audit is approved before
 * implementation`), and that sentence is the one thing in the text a repository cannot
 * supply. It is read only when it is explicit about approval, so ordinary prose about
 * reviewing a change does not become a blocker.
 *
 * Reading is deliberately three-valued: a requirement becomes a gate, a waiver becomes a
 * quoted note, and an uncertain mention becomes a note with no gate. The failure direction
 * matters here — treating "no approval required" as a gate would send someone to wait for a
 * permission the ticket explicitly says they do not need.
 */
const APPROVAL_MENTION = /\bapprov\w*\b|\bsign-?off\b/i
const UNCERTAIN_WORDING = /\b(?:if|whether|unless|may|might|could|maybe|possibly|perhaps|potentially)\b/i

/** One of these must be present before any sentence is treated as a requirement. */
const GATE_PATTERNS: RegExp[] = [
  /\b(?:must|has to|needs? to|should)\s+be\s+approved\b/i,
  /\brequires?\s+(?:approval|sign-?off)\b/i,
  /\b(?:approval|sign-?off)\s+(?:(?:is|are)\s+)?required\b/i,
  /\bpending\s+approval\b/i,
  /^(?:please\s+)?wait\s+for\s+(?:approval|sign-?off)\b/i,
]

/** Checked before the requirement patterns: a waiver must never become a gate. */
const NO_APPROVAL_PATTERNS: RegExp[] = [
  /\bno\s+(?:approval|sign-?off)\s+(?:(?:is|are)\s+)?(?:required|needed|necessary)\b/i,
  /\b(?:doesn['’]t|does not|don['’]t|do not|will not|won['’]t|shouldn['’]t|should not|need not|no need to)\s+(?:require|need|wait for|get|seek|obtain)\s+(?:any\s+)?(?:approval|sign-?off)\b/i,
  /\b(?:approval|sign-?off)\s+(?:(?:is|are)\s+)?(?:optional|not required|not needed|waived)\b/i,
]

/**
 * The two halves of a gate phrase, each cleaned up for display.
 *
 * Both are unanchored and bounded to one clause: a ticket often writes the gate inside a
 * longer sentence ("Note that the audit is approved before implementation"), and treating
 * that as "approval required, ordering unknown" would drop information the text does have.
 * A negation is not allowed in `WAIT_FOR` — "should not wait for approval" is a waiver and
 * is caught by `NO_APPROVAL_PATTERNS` before this runs.
 */
const START_NOW =
  /(?<what>[^.;]{1,80}?)\s+(?:is|are|must be|needs to be|should be|has to be)\s+(?:reviewed and\s+)?approved\s+before\s+(?<blocked>[^.;]{1,80})/i

const WAIT_FOR =
  /(?<blocked>[^.;]{1,80}?)\s+(?:must|has to|needs to|should)\s+(?:wait for|be held until|be delayed until)\s+(?:approval|sign-?off)\b/i

/** A negated action is the requirement, not a waiver of approval. */
const NOT_WITHOUT =
  /^(?:please\s+)?(?:do not|don['’]t|never|[^.;]+?\s+(?:must not|cannot|can['’]t))\s+(?<blocked>[^.;]{1,80}?)\s+without\s+(?:prior\s+)?(?:approval|sign-?off)\b/i

/** Fallback for "approval is required before X": it names what waits, not what may start. */
const BLOCKED_BEFORE = /\b(?:approval|sign-?off)\s+(?:(?:(?:is|are)\s+)?required\s+)?before\s+(?<blocked>[^.;]{1,80})/i

/** Split prose into sentences without breaking on a filename or an abbreviation. */
function sentences(text: string): string[] {
  return text
    .replace(/\r\n/g, '\n')
    .split(/(?<=[.!?])\s+|\n+/)
    .map((part) => part.trim())
    .filter((part) => part !== '')
}

/** Strip bullets, checkboxes and emphasis so a quoted gate reads as a sentence. */
function cleanSentence(value: string): string {
  return value
    .replace(/^\s*(?:[-*+]|\d+[.)])\s+/, '')
    .replace(/^\s*\[[ xX]\]\s*/, '')
    .replace(/[*_`]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

/** A short noun phrase, not a paragraph, or the display becomes a second copy of the task. */
function phrase(value: string | undefined): string | null {
  const cleaned = (value ?? '')
    // A gate is often introduced mid-sentence; the phrase a reader needs starts after it.
    .replace(/^(?:note|nb|fyi|caveat|important|reminder)\b[:,]?\s+(?:that\s+)?/i, '')
    .replace(/^(?:please\s+)?(?:ensure|make sure|remember)\s+(?:that\s+)?/i, '')
    .replace(/^(?:the|a|an)\s+/i, '')
    // Keep the clause that names the gate; a following clause is a different statement.
    .replace(/,\s+(?:so|and|but|then|which|whilst|while)\b[\s\S]*$/i, '')
    .replace(/\s+/g, ' ')
    .replace(/^[^A-Za-z0-9]+|[^A-Za-z0-9]+$/g, '')
    .trim()
  if (cleaned === '' || cleaned.length > 80) return null
  return cleaned
}

interface ApprovalReading {
  /** Explicit requirements only. Never populated by a waiver or an uncertain mention. */
  gates: TaskGate[]
  /** Quoted sentences the reader should check, without applying them as gates. */
  notes: string[]
}

/**
 * Read approval statements in the task.
 *
 * The reader is conservative on purpose. A sentence becomes a gate only when it clearly
 * requires approval; "no approval required" and "should not wait for approval" become
 * notes, and "approval may be needed" becomes a note too. A wrong gate would send someone
 * to wait for permission the ticket says they do not need.
 */
function readApproval(text: string): ApprovalReading {
  const gates: TaskGate[] = []
  const notes: string[] = []
  for (const raw of sentences(text)) {
    const sentence = cleanSentence(raw)
    if (sentence.length > 300 || !APPROVAL_MENTION.test(sentence)) continue

    // Classify each clause independently; a waiver of one step doesn't waive another.
    for (const part of sentence.split(';')) {
      const clause = part.trim()
      if (!APPROVAL_MENTION.test(clause)) continue
      const uncertain = sentence.endsWith('?') || UNCERTAIN_WORDING.test(clause)
      if (!uncertain && NO_APPROVAL_PATTERNS.some((pattern) => pattern.test(clause))) {
        if (notes.length < 3) {
          notes.push(`The task says approval is not required: “${clause}” Confirm with the owner if that is current.`)
        }
        continue
      }

      const order = START_NOW.exec(clause)?.groups
      const blocked = NOT_WITHOUT.exec(clause)?.groups ?? WAIT_FOR.exec(clause)?.groups
      if (uncertain || (!order && !blocked && !GATE_PATTERNS.some((pattern) => pattern.test(clause)))) {
        if (notes.length < 3) notes.push(`Approval is mentioned but not stated as a requirement: “${clause}”`)
        continue
      }

      if (gates.length >= 2) continue
      gates.push({
        kind: 'approval',
        startNow: phrase(order?.what),
        waitFor: phrase(order?.blocked ?? blocked?.blocked ?? BLOCKED_BEFORE.exec(clause)?.groups?.blocked),
        evidence: sentence,
      })
    }
  }
  return { gates, notes }
}

/**
 * A derived fix reads as `<action> -- <why it is needed>`.
 *
 * Its `title` is the finding as an observed state ("Issue template present"), which is the
 * wrong headline for a task: a brief should name what the reader is about to do.
 */
function splitDetail(detail: string): { action: string | null; reason: string } {
  const marker = detail.indexOf(' -- ')
  if (marker <= 0) return { action: null, reason: detail }
  const action = detail.slice(0, marker).trim()
  const reason = detail.slice(marker + 4).trim()
  return { action: action === '' ? null : action, reason: reason === '' ? detail : reason }
}

function titleAndObjective(text: string): { title: string; objective: string } {
  const lines = text.split(/\r?\n/)
  const headIndex = lines.findIndex((line) => line.trim() !== '')
  const head = headIndex === -1 ? '' : (lines[headIndex] ?? '').trim()
  const body =
    headIndex === -1
      ? ''
      : lines
          .slice(headIndex + 1)
          .join('\n')
          .trim()
  const title = head.length > 100 ? `${head.slice(0, 97)}...` : head
  // A short one-line task is the title; repeating it as the objective adds nothing.
  const objective = body !== '' ? body : head.length > 100 ? text : ''
  return { title: title || 'Pasted task', objective }
}

/**
 * Build a task-centred 2D map from the same snapshot as the brief.
 *
 * Nodes are files the task matched, modules whose paths contain them, their declared
 * one-hop dependencies and the verify commands. Every node and edge names the CLI value it
 * came from; an unanalysed dependency is a visible unknown node, never an absent edge.
 */
export function buildTaskMap(
  snapshot: DashboardSnapshot,
  brief: Pick<TaskBrief, 'title' | 'startHere' | 'howToCheck'>,
): TaskMap {
  const profile = asRecord(snapshot.repository.profile.data)
  const modules = (profile === null ? [] : asArray(profile.modules))
    .map((value) => asRecord(value))
    .filter((value): value is Record<string, unknown> => value !== null)
  const diagnostics = profile === null ? null : asRecord(profile.diagnostics)
  const unanalysed = (diagnostics === null ? [] : asArray(diagnostics.unanalysedDeps))
    .map((value) => asRecord(value))
    .filter((value): value is Record<string, unknown> => value !== null)
    .map((value) => asString(value.id))
    .filter((value): value is string => value !== null)
  const unanalysedIds = new Set(unanalysed)
  // An older profile has no coverage field at all. Absence of a field is not evidence that
  // every module was analysed, so the map must say coverage is unknown.
  const coverageUnknown =
    snapshot.repository.profile.ok === false ||
    profile === null ||
    diagnostics === null ||
    !Object.hasOwn(diagnostics, 'unanalysedDeps')

  const moduleId = (value: Record<string, unknown>): string => asString(value.id) ?? asString(value.path) ?? 'unknown'
  const modulePath = (value: Record<string, unknown>): string => asString(value.path) ?? 'unknown'
  const relevance = (value: Record<string, unknown>): string | null => {
    const path = modulePath(value)
    for (const item of brief.startHere) {
      if (path !== '.' && (item.path === path || item.path.startsWith(`${path}/`))) {
        return `path matches task file ${item.path}`
      }
      if (path === '.' && !item.path.includes('/')) return `root module contains task file ${item.path}`
    }
    return null
  }

  const nodes = new Map<string, TaskMapNode>()
  const edges: TaskMapEdge[] = []
  const addNode = (node: TaskMapNode): void => {
    if (!nodes.has(node.id)) nodes.set(node.id, node)
  }

  for (const item of brief.startHere) {
    addNode({
      id: `file:${item.path}`,
      label: item.path,
      kind: 'file',
      reason: item.reason,
      evidence: `anvil profile --json: files[${item.path}]`,
    })
  }

  const relevant = modules.filter((module) => relevance(module) !== null)
  const byId = new Map(modules.map((module) => [moduleId(module), module]))
  const included = new Set<string>()
  for (const module of relevant) included.add(moduleId(module))

  for (const module of relevant) {
    const id = moduleId(module)
    addNode({
      id: `module:${id}`,
      label: modulePath(module),
      kind: 'module',
      reason: relevance(module) ?? 'module in the task subgraph',
      evidence: `anvil profile --json: modules[${id}]`,
    })
    for (const item of brief.startHere) {
      const path = modulePath(module)
      if (path === '.' ? item.path.includes('/') : !(item.path === path || item.path.startsWith(`${path}/`))) continue
      edges.push({
        from: `file:${item.path}`,
        to: `module:${id}`,
        label: 'located in',
        evidence: `anvil profile --json: files[${item.path}], modules[${id}].path`,
      })
    }

    for (const dep of asArray(module.deps)) {
      const depId = typeof dep === 'string' ? dep : null
      if (depId === null || depId === id) continue
      included.add(depId)
      addNode({
        id: `module:${depId}`,
        label: modulePath(byId.get(depId) ?? { id: depId }),
        kind: 'module',
        reason: `declared dependency of ${id}`,
        evidence: `anvil profile --json: modules[${id}].deps`,
      })
      edges.push({
        from: `module:${id}`,
        to: `module:${depId}`,
        label: 'depends on',
        evidence: `anvil profile --json: modules[${id}].deps`,
      })
    }

    if (unanalysedIds.has(id)) {
      addNode({
        id: `unknown:${id}`,
        label: `unknown dependencies for ${modulePath(module)}`,
        kind: 'unknown',
        reason: 'no dependency resolver ran for this module',
        evidence: `anvil profile --json: diagnostics.unanalysedDeps[${id}]`,
      })
      edges.push({
        from: `module:${id}`,
        to: `unknown:${id}`,
        label: 'dependencies unknown',
        evidence: `anvil profile --json: diagnostics.unanalysedDeps[${id}]`,
      })
    }
  }

  // A dep can name a module the profile did not record; that is an edge to an unknown node,
  // not an invented module. Keep it after the known nodes so the list reads predictably.
  for (const depId of included) {
    if (byId.has(depId)) continue
    addNode({
      id: `module:${depId}`,
      label: depId,
      kind: 'unknown',
      reason: 'declared dependency with no module record in the profile',
      evidence: null,
    })
  }

  if (coverageUnknown) {
    addNode({
      id: 'unknown:coverage',
      label: 'unknown dependency coverage',
      kind: 'unknown',
      reason: 'the profile does not say which modules had their dependencies analysed',
      evidence: null,
    })
  }

  for (const [index, check] of brief.howToCheck.entries()) {
    addNode({
      id: `check:${String(index)}`,
      label: `${check.kind}: ${check.cmd}`,
      kind: 'check',
      reason: `${check.source}${check.cwd === '' ? '' : ` from ${check.cwd}`}`,
      evidence: check.evidence ?? `anvil ready --json: commands[${String(index)}]`,
    })
  }

  return {
    schemaVersion: 1,
    focus: brief.title,
    nodes: [...nodes.values()],
    edges,
    hasUnknown: [...nodes.values()].some((node) => node.kind === 'unknown'),
  }
}

/**
 * Build the brief. Missing input, both entry points or an unknown suggestion is a
 * `TaskInputError`; every other absence is represented in `unknowns` rather than turned
 * into a fact.
 */
export function buildTaskBrief(snapshot: DashboardSnapshot, input: TaskBriefInput): TaskBrief {
  const text = (input.text ?? '').trim()
  const suggestionId = (input.suggestionId ?? '').trim()
  if (text === '' && suggestionId === '') {
    throw new TaskInputError('Pick a suggestion or paste a task first.')
  }
  if (text !== '' && suggestionId !== '') {
    throw new TaskInputError('Choose one entry point: a suggestion or pasted task text.')
  }
  if (text.length > MAX_TASK_TEXT) {
    throw new TaskInputError(`Task text is limited to ${String(MAX_TASK_TEXT)} characters.`)
  }
  if (suggestionId !== '' && !/^[A-Za-z0-9:_-]{1,200}$/.test(suggestionId)) {
    throw new TaskInputError('That suggestion id is not valid.')
  }

  const files = fileSet(snapshot)
  const profile = asRecord(snapshot.repository.profile.data)
  const suggestion = suggestionId === '' ? null : suggestionFor(snapshot, suggestionId)
  const evidence =
    suggestion === null
      ? []
      : asArray(suggestion.evidence).filter((entry): entry is string => typeof entry === 'string')

  const unknowns: string[] = []
  let startHere: TaskStartItem[] = []
  let unmatched: string[] = []

  if (suggestion !== null) {
    startHere = evidencePaths(evidence, files)
    if (startHere.length === 0) {
      unknowns.push('The suggestion names no existing file in this repository, so it probably creates a new one.')
    }
  } else {
    const explicit = explicitMatches(text, files)
    startHere = explicit.items
    unmatched = explicit.unmatched
    const seen = new Set(startHere.map((item) => item.path))
    for (const item of lexicalMatches(text, files, seen)) {
      if (startHere.length >= MAX_START_ITEMS) break
      startHere.push(item)
    }
  }
  if (startHere.length < MAX_START_ITEMS + MAX_TEST_ITEMS) {
    const seen = new Set(startHere.map((item) => item.path))
    for (const item of testsFor(startHere, files)) {
      if (seen.has(item.path) || startHere.length >= MAX_START_ITEMS + MAX_TEST_ITEMS) continue
      seen.add(item.path)
      startHere.push(item)
    }
  }

  const checks = commandChecks(snapshot)
  const found = blockers(snapshot)
  const ready = asRecord(snapshot.repository.ready.data)
  const readyOk = snapshot.repository.ready.ok !== false
  const approval = suggestion === null ? readApproval(text) : { gates: [] as TaskGate[], notes: [] as string[] }
  const gates = approval.gates

  if (suggestion !== null) {
    unknowns.push(
      'This is an engineering improvement from `anvil plan`, not a confirmed team priority, owner or deadline.',
    )
  } else {
    unknowns.push('The pasted task text was not validated against a tracker, an owner or the product requirements.')
  }
  if (gates.length > 0) {
    unknowns.push('The approval gate above is quoted from the pasted text; confirm it with the owner or ticket.')
  } else if (suggestion !== null) {
    unknowns.push(
      'A repository suggestion carries no approval gate or owner: confirm both with the team before implementing.',
    )
  } else if (approval.notes.length === 0) {
    unknowns.push(
      'No approval gate was found in the pasted text. Approval gates and ownership are not inferable from repository files, so check the ticket.',
    )
  }
  unknowns.push(...approval.notes)
  unknowns.push('This page is read-only: the verification commands were not run and the repository was not changed.')
  if (snapshot.verification.status !== 'recorded') {
    unknowns.push(`Verification history is unavailable: ${snapshot.verification.reason}`)
  } else {
    unknowns.push(
      'Recorded verification is a snapshot of an explicitly bounded run; it is not a claim that the current worktree passes.',
    )
    if (snapshot.verification.evidence.some((item) => item.matchesCurrent === false)) {
      unknowns.push(
        'At least one verification record was captured at a different revision than the revision sampled when this dashboard started.',
      )
    }
    if (snapshot.verification.incompleteCount > 0) {
      unknowns.push(
        `${snapshot.verification.incompleteCount} verification record(s) are incomplete and are not shown as facts.`,
      )
    }
  }
  for (const reference of unmatched) {
    unknowns.push(`The task names ${reference}, which is not in the file index; it may be a new or renamed file.`)
  }
  if (!readyOk) {
    unknowns.push(
      '`anvil ready` failed, so blockers and tool availability are unknown — this is not a clean readiness report.',
    )
  }
  if (snapshot.repository.profile.ok === false) {
    unknowns.push('The profile source failed, so start-here files and the working directory may be incomplete.')
  } else if (profile !== null) {
    const diagnostics = asRecord(profile.diagnostics)
    if (diagnostics?.truncated === true) {
      unknowns.push('The profile walk reached its file limit, so the file index may be incomplete.')
    }
    const failed = asArray(diagnostics?.failedDetectors)
    if (failed.length > 0) {
      unknowns.push(`${String(failed.length)} profile detector(s) failed, so the file index may be incomplete.`)
    }
  }
  if (startHere.length === 0 && text !== '' && snapshot.repository.profile.ok !== false) {
    unknowns.push('No file in the profile matched the task text.')
  }
  if (checks.length === 0) {
    unknowns.push('No verification command was detected or declared for this repository.')
  }

  const pasted = suggestion === null ? titleAndObjective(text) : null
  const suggested =
    suggestion === null ? null : splitDetail(asString(suggestion.detail) ?? asString(suggestion.title) ?? '')
  const title =
    suggestion !== null
      ? (suggested?.action ?? asString(suggestion.title) ?? 'Suggested contribution')
      : (pasted?.title ?? '')
  const objective = suggestion !== null ? (suggested?.reason ?? '') : (pasted?.objective ?? '')
  const map = buildTaskMap(snapshot, { title, startHere, howToCheck: checks })
  const handoff = buildTaskHandoff(snapshot, {
    title,
    blockers: found,
    readiness: {
      ok: readyOk,
      checked: ready !== null && ready.checked === true,
      status: ready === null ? null : asString(ready.status),
    },
  })
  return {
    schemaVersion: 1,
    generatedAt: snapshot.fetchedAt,
    source: { suggestionId: suggestionId === '' ? null : suggestionId, text: text === '' ? null : text },
    title,
    // The action is already the title; repeating it in the objective adds nothing.
    objective,
    startHere,
    map,
    howToCheck: checks,
    verification: {
      status: snapshot.verification.status,
      reason: snapshot.verification.reason,
      currentRevision: snapshot.verification.currentRevision,
      incompleteCount: snapshot.verification.incompleteCount,
      evidence: snapshot.verification.evidence,
    },
    blockers: found,
    handoff,
    gates,
    readiness: {
      ok: readyOk,
      checked: ready !== null && ready.checked === true,
      status: ready === null ? null : asString(ready.status),
    },
    unknowns,
  }
}
