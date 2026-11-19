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

import type { DashboardSnapshot } from './snapshot.ts'

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
  howToCheck: TaskCheck[]
  blockers: TaskBlocker[]
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

/** Paths explicitly named in the task, matched case-insensitively against the profile. */
function explicitMatches(text: string, files: Set<string>): { items: TaskStartItem[]; unmatched: string[] } {
  const items: TaskStartItem[] = []
  const unmatched: string[] = []
  const seen = new Set<string>()
  const references = (text.replace(/https?:\/\/\S+/g, ' ').match(FILE_REFERENCE) ?? []).slice(0, 20)
  for (const reference of references) {
    const normalized = normalizeReference(reference).toLowerCase()
    if (normalized === '' || normalized.includes('..')) continue
    let found = false
    for (const path of files) {
      const lower = path.toLowerCase()
      if (lower !== normalized && !lower.endsWith(`/${normalized}`)) continue
      found = true
      if (seen.has(path)) continue
      seen.add(path)
      items.push({ path, reason: 'named in the task text', kind: isTestPath(path) ? 'test' : 'source' })
      if (items.length >= MAX_START_ITEMS) return { items, unmatched }
    }
    if (!found && !unmatched.includes(reference) && unmatched.length < 3) unmatched.push(reference)
  }
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
  const add = (label: string, status: string, reason: string): void => {
    if (found.length >= 6) return
    if (found.some((item) => item.label === label && item.status === status)) return
    found.push({ label, status, reason })
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
      add(asString(record.id) ?? asString(record.kind) ?? key, status, reasonOf(record))
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
    add('environment', 'blocked', 'anvil ready reports blocked, but no individual need named a cause.')
  }
  return found
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

  if (suggestion !== null) {
    unknowns.push(
      'This is an engineering improvement from `anvil plan`, not a confirmed team priority, owner or deadline.',
    )
  } else {
    unknowns.push('The pasted task text was not validated against a tracker, an owner or the product requirements.')
  }
  unknowns.push(
    'Approval gates and ownership cannot be inferred from repository files. Check the ticket before editing.',
  )
  unknowns.push('This page is read-only: the verification commands were not run and the repository was not changed.')
  unknowns.push('Verification history is unavailable; run a command in a worktree to produce evidence.')
  for (const reference of unmatched) {
    unknowns.push(`The task names ${reference}, which is not in the file index; it may be a new or renamed file.`)
  }
  if (ready !== null && ready.checked !== true) {
    unknowns.push(
      'The environment was not probed (`anvil ready --check`), so tool and service availability is unknown.',
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
  return {
    schemaVersion: 1,
    generatedAt: snapshot.fetchedAt,
    source: { suggestionId: suggestionId === '' ? null : suggestionId, text: text === '' ? null : text },
    title: suggestion !== null ? (asString(suggestion.title) ?? 'Suggested contribution') : (pasted?.title ?? ''),
    objective:
      suggestion !== null
        ? (asString(suggestion.detail) ?? asString(suggestion.title) ?? '')
        : (pasted?.objective ?? ''),
    startHere,
    howToCheck: checks,
    blockers: found,
    unknowns,
  }
}
