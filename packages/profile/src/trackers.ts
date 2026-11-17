/**
 * Tracker-candidate detection.
 *
 * The honest half of "which ticket tracker does this repository use": a clone can offer
 * textual evidence, never a verdict. GitHub Issues being enabled is a server-side fact, and
 * a Jira project key is real only on the Jira instance. This module therefore returns a
 * ranked set of candidates with `file:line` evidence, and says `na` rather than defaulting
 * to the code host's tracker.
 *
 * Everything here is a local file read. There is no network call, no child process and no
 * write. Detection never changes configuration and grants no authority: the user confirms a
 * tracker with `provider.default`, and only that value (or a flag/reference) is what
 * packages/providers resolves at call time.
 */

import { lstatSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import type { CommandSource } from './types.ts'
import { readText } from './walk.ts'

/** The tracker kinds the candidate contract names. */
export type TrackerKind = 'github' | 'gitlab' | 'jira' | 'linear' | 'unknown'

/**
 * How much a piece of evidence supports the candidate.
 *
 * Reuses the profile's command vocabulary deliberately: `documented` is a human naming the
 * tracker, `detected` is a file that exists for that tracker, and `inferred` is a convention
 * that is a guess. A code host is never more than `inferred`, and never a candidate alone.
 */
export type TrackerConfidence = CommandSource

/** A `file:line` citation plus a short, bounded excerpt. */
export interface TrackerEvidence {
  /** Repo-relative POSIX path. `.git/config` for a cited remote; `line: 0` means the configured remote string. */
  file: string
  /** 1-based line, or 0 when the evidence is the configured remote rather than a line. */
  line: number
  excerpt: string
}

export interface TrackerCandidate {
  kind: TrackerKind
  confidence: TrackerConfidence
  evidence: TrackerEvidence[]
}

export type TrackerState = 'candidates' | 'unconfirmed' | 'na'

export interface TrackerDetection {
  state: TrackerState
  /** Why this state was reached, in one sentence a reader can act on. */
  reason: string
  /** Stable kind order. An empty list is `na`, never a default. */
  candidates: TrackerCandidate[]
}

/** Bounds, exported so a test can prove the detector stays bounded. */
export const TRACKER_LIMITS = {
  /** Template files listed per tracker directory. */
  maxTemplateFiles: 20,
  /** Bytes read from any one evidence file; larger files are skipped, not truncated. */
  maxFileBytes: 128 * 1024,
  /** Evidence entries emitted per candidate, after sorting. */
  maxEvidencePerCandidate: 6,
  /** Evidence entries kept per file, so one document cannot crowd out the others. */
  maxEvidencePerFile: 3,
  /** Characters in an excerpt, including any guess marker. */
  maxExcerptChars: 180,
} as const

const KIND_ORDER: readonly TrackerKind[] = ['github', 'gitlab', 'jira', 'linear', 'unknown']

const CONFIDENCE_RANK: Record<TrackerConfidence, number> = {
  inferred: 0,
  documented: 1,
  detected: 2,
}

/** The providers anvil can actually run, so the advice never suggests an unsupported one. */
const SUPPORTED_KINDS: ReadonlySet<TrackerKind> = new Set(['github', 'jira'])

/**
 * Key prefixes that look like an issue key but are ordinary standards.
 *
 * `UTF-8`, `ISO-8601`, `RFC-2119` and `SHA-256` all match an issue-key shape. Naming Jira
 * for them would be the confident-and-wrong output this project refuses. The list is a
 * heuristic, which is one more reason a key is only ever an `inferred`, labelled guess.
 */
const NON_ISSUE_KEY_PREFIXES: ReadonlySet<string> = new Set([
  'AES',
  'ANSI',
  'API',
  'BLAKE2',
  'CVE',
  'CSS',
  'CWE',
  'DNS',
  'DSS',
  'ECMA',
  'GDPR',
  'GHSA',
  'HTML',
  'HTTP',
  'HTTPS',
  'IEEE',
  'IP',
  'ISO',
  'JSON',
  'MD',
  'NIST',
  'OASIS',
  'PCI',
  'PKCS',
  'RFC',
  'RS',
  'SHA',
  'SOC',
  'SQL',
  'SSL',
  'TCP',
  'TLS',
  'TS',
  'UDP',
  'URI',
  'URL',
  'UTF',
  'UUID',
  'X',
  'XML',
  'YAML',
])

const ISSUE_KEY_RE = /\b([A-Z][A-Z0-9]{1,9})-(\d{1,6})\b/g

const GUESS_SUFFIX = ' (issue-key guess, not proof)'
const MENTION_SUFFIX = ' (a mention, not proof of use)'

/**
 * Documentation evidence.
 *
 * Only an address that *is* a tracker's issue page is `documented`: a link to a GitHub or
 * GitLab issues page, a Jira `browse`/`jira` URL, or a Linear workspace URL. A bare product
 * name ("we do not use Jira", "a Jira client library") is only a mention, so it is
 * `inferred` and labelled as such, and a Confluence `/wiki` link on an Atlassian host is not
 * Jira evidence at all.
 */
const DOC_PATTERNS: ReadonlyArray<{ kind: TrackerKind; re: RegExp; confidence: TrackerConfidence; suffix: string }> = [
  { kind: 'github', re: /\bgithub\.com\/[^\s/)>\]]+\/[^\s/)>\]]+\/issues\b/i, confidence: 'documented', suffix: '' },
  { kind: 'gitlab', re: /\bgitlab[^\s/)>\]]*\/[^\s)>\]]+\/-\/issues\b/i, confidence: 'documented', suffix: '' },
  {
    kind: 'jira',
    re: /\b[a-z0-9-]+\.atlassian\.net\/(?:browse|jira|projects)\b/i,
    confidence: 'documented',
    suffix: '',
  },
  {
    kind: 'jira',
    re: /\bhttps?:\/\/[^\s/]+\/(?:browse\/[A-Z][A-Z0-9]+-\d+|secure\/RapidBoard|jira\/software)\b/,
    confidence: 'documented',
    suffix: '',
  },
  { kind: 'linear', re: /\blinear\.app\/[^\s/)>\]]+/i, confidence: 'documented', suffix: '' },
  { kind: 'jira', re: /\bjira\b/i, confidence: 'inferred', suffix: MENTION_SUFFIX },
]

interface DraftEvidence extends TrackerEvidence {
  confidence: TrackerConfidence
}

interface Accumulator {
  kind: TrackerKind
  confidence: TrackerConfidence
  evidence: DraftEvidence[]
  perFile: Map<string, number>
  seen: Set<string>
}

interface DetectionDraft {
  candidates: Map<TrackerKind, Accumulator>
  /** True when at least one issue-key convention or bare mention contributed. */
  guessed: boolean
  /** Files that exist but were not read: oversized, binary, linked or unreadable. */
  skipped: string[]
  /** Template directories that held more files than the bound. */
  truncated: string[]
  /** Host patterns for the repository's own code host, e.g. a GitHub Enterprise host. */
  remoteHost: { host: string; kind: TrackerKind } | null
}

function safeSegments(relPath: string): string[] | null {
  if (relPath === '' || relPath.startsWith('/') || relPath.startsWith('\\') || /^[A-Za-z]:/.test(relPath)) {
    return null
  }
  if (relPath.includes('\\') || relPath.includes('\0')) return null
  const segments = relPath.split('/')
  if (segments.some((segment) => segment === '' || segment === '.' || segment === '..')) return null
  return segments
}

type SafePath = { path: string } | { skipped: true } | null

/**
 * Resolve a repo-relative path only when no component is a symlink.
 *
 * A repository can commit `CONTRIBUTING.md -> /etc/...`; detection must not follow it. A
 * file with more than one hard link is refused for the same reason (it may be another
 * name for a file outside the tree), as is a file over the size bound. Those return
 * `skipped`, so the result can say a file was not read; a missing path returns null.
 * This is a static check, not a race-safe containment guarantee against a tree that is
 * being changed while doctor runs.
 */
function safePath(root: string, relPath: string, want: 'file' | 'directory'): SafePath {
  const segments = safeSegments(relPath)
  if (segments === null) return null
  let current = root
  for (const [index, segment] of segments.entries()) {
    current = join(current, segment)
    let stat: ReturnType<typeof lstatSync>
    try {
      stat = lstatSync(current)
    } catch (err) {
      // Missing is "not there"; anything else (EACCES, EPERM, ...) is a file that exists
      // but could not be checked, which the result must disclose as a partial scan.
      const code = (err as NodeJS.ErrnoException).code
      return code === 'ENOENT' || code === 'ENOTDIR' ? null : { skipped: true }
    }
    if (stat.isSymbolicLink()) return { skipped: true }
    const last = index === segments.length - 1
    if (last) {
      if (want === 'directory') return stat.isDirectory() ? { path: current } : null
      if (!stat.isFile()) return null
      if (stat.nlink > 1 || stat.size > TRACKER_LIMITS.maxFileBytes) return { skipped: true }
    } else if (!stat.isDirectory()) {
      return null
    }
  }
  return { path: current }
}

/** Read a repo-relative text file without following a link and without exceeding the bound. */
function readRepoText(root: string, relPath: string, draft: DetectionDraft): string | null {
  const resolved = safePath(root, relPath, 'file')
  if (resolved === null) return null
  if ('skipped' in resolved) {
    draft.skipped.push(relPath)
    return null
  }
  const text = readText(resolved.path).text
  if (text === null) draft.skipped.push(relPath)
  return text
}

/**
 * Hide URL userinfo before any text is quoted.
 *
 * A remote or a documented link can carry a token (`https://user:token@host/...`);
 * evidence is printed and put in JSON, so the credential part is replaced, never repeated.
 */
export function redactRemoteUserinfo(text: string): string {
  // Scheme-relative `//user@host` too, and up to the *last* `@` before the host, so a
  // password that itself contains `@` is not half-quoted.
  return text.replace(/((?:[a-z][a-z0-9+.-]*:)?\/\/)[^/\s]*@/gi, '$1***@')
}

function shortExcerpt(line: string, suffix = '', prefix = ''): string {
  const room = Math.max(0, TRACKER_LIMITS.maxExcerptChars - suffix.length - prefix.length)
  const trimmed = redactRemoteUserinfo(line).trim().replace(/\s+/g, ' ')
  const body = trimmed.length > room ? `${trimmed.slice(0, Math.max(0, room - 3))}...` : trimmed
  return `${prefix}${body}${suffix}`
}

function accumulator(draft: DetectionDraft, kind: TrackerKind): Accumulator {
  const existing = draft.candidates.get(kind)
  if (existing !== undefined) return existing
  const created: Accumulator = {
    kind,
    confidence: 'inferred',
    evidence: [],
    perFile: new Map(),
    seen: new Set(),
  }
  draft.candidates.set(kind, created)
  return created
}

function addEvidence(
  draft: DetectionDraft,
  kind: TrackerKind,
  confidence: TrackerConfidence,
  evidence: TrackerEvidence,
): void {
  const candidate = accumulator(draft, kind)
  const key = `${evidence.file}:${evidence.line}:${evidence.excerpt}`
  if (candidate.seen.has(key)) return
  const perFile = candidate.perFile.get(evidence.file) ?? 0
  if (perFile >= TRACKER_LIMITS.maxEvidencePerFile) {
    // The file's allowance is spent: a stronger citation replaces its weakest one, so three
    // early key guesses cannot crowd out an explicit tracker URL further down.
    let weakest = -1
    for (const [index, kept] of candidate.evidence.entries()) {
      if (kept.file !== evidence.file) continue
      if (CONFIDENCE_RANK[kept.confidence] >= CONFIDENCE_RANK[confidence]) continue
      const current = candidate.evidence[weakest]
      if (
        weakest < 0 ||
        (current !== undefined && CONFIDENCE_RANK[kept.confidence] < CONFIDENCE_RANK[current.confidence])
      ) {
        weakest = index
      }
    }
    if (weakest < 0) return
    const [dropped] = candidate.evidence.splice(weakest, 1)
    if (dropped !== undefined) candidate.seen.delete(`${dropped.file}:${dropped.line}:${dropped.excerpt}`)
  } else {
    candidate.perFile.set(evidence.file, perFile + 1)
  }
  candidate.seen.add(key)
  candidate.evidence.push({ ...evidence, confidence })
  // Confidence only rises with a citation that is actually kept, so a published
  // confidence always has at least one citation of that strength behind it.
  if (CONFIDENCE_RANK[confidence] > CONFIDENCE_RANK[candidate.confidence]) {
    candidate.confidence = confidence
  }
}

/** Scan text for tracker addresses, mentions and issue keys. */
function scanText(text: string, relPath: string, draft: DetectionDraft): void {
  const lines = text.split('\n')
  for (const [index, line] of lines.entries()) {
    for (const pattern of DOC_PATTERNS) {
      if (!pattern.re.test(line)) continue
      if (pattern.confidence === 'inferred') draft.guessed = true
      addEvidence(draft, pattern.kind, pattern.confidence, {
        file: relPath,
        line: index + 1,
        excerpt: shortExcerpt(line, pattern.suffix),
      })
    }
    const own = draft.remoteHost
    if (own !== null && own.kind === 'github' && issuesLinkOn(line, own.host, false)) {
      addEvidence(draft, 'github', 'documented', { file: relPath, line: index + 1, excerpt: shortExcerpt(line) })
    }
    if (own !== null && own.kind === 'gitlab' && issuesLinkOn(line, own.host, true)) {
      addEvidence(draft, 'gitlab', 'documented', { file: relPath, line: index + 1, excerpt: shortExcerpt(line) })
    }
    ISSUE_KEY_RE.lastIndex = 0
    for (let match = ISSUE_KEY_RE.exec(line); match !== null; match = ISSUE_KEY_RE.exec(line)) {
      const prefix = match[1] as string
      if (NON_ISSUE_KEY_PREFIXES.has(prefix)) continue
      addEvidence(draft, 'jira', 'inferred', {
        file: relPath,
        line: index + 1,
        excerpt: shortExcerpt(line, GUESS_SUFFIX),
      })
      draft.guessed = true
      break // One citation per line is enough to point at the convention.
    }
  }
}

/** Whether a line links to an issues page on the repository's own (e.g. Enterprise) host. */
function issuesLinkOn(line: string, host: string, gitlab: boolean): boolean {
  const escaped = host.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const path = gitlab ? '[^\\s)>\\]]+\\/-\\/issues' : '[^\\s/)>\\]]+\\/[^\\s/)>\\]]+\\/issues'
  return new RegExp(`https?:\\/\\/(?:[^@/\\s]+@)?${escaped}(?::\\d+)?\\/${path}\\b`, 'i').test(line)
}

/**
 * A template: the file existing is `detected` evidence for its host, and its text is
 * scanned like a document, so a `config.yml` whose contact links send issues to another
 * tracker produces that tracker too, and the result is `unconfirmed` rather than GitHub.
 */
function scanTemplate(root: string, relPath: string, kind: TrackerKind, draft: DetectionDraft): void {
  const text = readRepoText(root, relPath, draft)
  if (text === null) return
  const lines = text.split('\n')
  const index = lines.findIndex((line) => line.trim() !== '')
  addEvidence(draft, kind, 'detected', {
    file: relPath,
    line: index < 0 ? 1 : index + 1,
    excerpt: shortExcerpt(index < 0 ? relPath : (lines[index] as string)),
  })
  scanText(text, relPath, draft)
}

/**
 * The files directly in a template directory, sorted, then bounded.
 *
 * Sorting before the bound keeps the result independent of directory enumeration order,
 * and a directory over the bound is reported, so a reader knows the scan was partial.
 */
function templateFiles(root: string, dir: string, draft: DetectionDraft): string[] {
  const resolved = safePath(root, dir, 'directory')
  if (resolved === null) return []
  if ('skipped' in resolved) {
    draft.skipped.push(dir)
    return []
  }
  let names: string[]
  try {
    names = readdirSync(resolved.path, { withFileTypes: true })
      .filter((entry) => entry.isFile() || entry.isSymbolicLink())
      .map((entry) => entry.name)
      .sort()
  } catch {
    draft.skipped.push(dir)
    return []
  }
  if (names.length > TRACKER_LIMITS.maxTemplateFiles) draft.truncated.push(dir)
  return names.slice(0, TRACKER_LIMITS.maxTemplateFiles).map((name) => `${dir}/${name}`)
}

/** The host of a remote URL or scp-style address, without scheme, userinfo or port. */
export function remoteHostOf(remote: string): string | null {
  const trimmed = remote.trim()
  const url = /^[a-z][a-z0-9+.-]*:\/\/(?:[^@/\s]+@)?([^/:\s]+)/i.exec(trimmed)
  if (url !== null) return (url[1] as string).toLowerCase()
  const scp = /^(?:[^@/\s]+@)?([^/:\s]+):(?!\/)/.exec(trimmed)
  if (scp !== null) return (scp[1] as string).toLowerCase()
  return null
}

/** The tracker kind a remote's *host* implies, or null for a code host with no tracker kind. */
function hostKindOf(remote: string): TrackerKind | null {
  const host = remoteHostOf(remote)
  if (host === null) return null
  if (host === 'github.com' || host.split('.').some((label) => label === 'github' || label.startsWith('github-'))) {
    return 'github'
  }
  if (host === 'gitlab.com' || host.split('.').some((label) => label === 'gitlab' || label.startsWith('gitlab-'))) {
    return 'gitlab'
  }
  return null
}

/**
 * Cite the configured remote when it corroborates a candidate already found in a file.
 *
 * A remote alone never creates a candidate: a code host is evidence that code lives there,
 * not that its issue tracker is used. This is why a bare GitHub remote produces `na`.
 */
function scanRemote(root: string, remote: string | null, draft: DetectionDraft): void {
  if (remote === null || remote.trim() === '') return
  const kind = hostKindOf(remote)
  if (kind === null) return
  if (!draft.candidates.has(kind)) return

  const config = safePath(root, '.git/config', 'file')
  const text = config !== null && 'path' in config ? readText(config.path).text : null
  if (text !== null) {
    const lines = text.split('\n')
    const index = lines.findIndex((line) => line.includes(remote.trim()))
    if (index >= 0) {
      addEvidence(draft, kind, 'inferred', {
        file: '.git/config',
        line: index + 1,
        excerpt: shortExcerpt(lines[index] ?? ''),
      })
      return
    }
  }
  // A worktree's `.git` is a file, and a caller may supply the remote without it being
  // readable here. Line 0 marks a citation of that supplied remote rather than a file line.
  addEvidence(draft, kind, 'inferred', {
    file: '.git/config',
    line: 0,
    excerpt: shortExcerpt(remote, '', 'remote: '),
  })
}

/**
 * Keep the strongest citations when a candidate has more than the bound, then present them
 * in file order. Selecting by confidence first means a `documented` candidate always shows
 * the citation that made it `documented`, not six guesses that happened to sort earlier.
 */
function selectEvidence(evidence: readonly DraftEvidence[]): TrackerEvidence[] {
  const byFile = (a: DraftEvidence, b: DraftEvidence): number =>
    a.file === b.file ? a.line - b.line : a.file < b.file ? -1 : 1
  return [...evidence]
    .sort((a, b) => CONFIDENCE_RANK[b.confidence] - CONFIDENCE_RANK[a.confidence] || byFile(a, b))
    .slice(0, TRACKER_LIMITS.maxEvidencePerCandidate)
    .sort(byFile)
    .map(({ file, line, excerpt }) => ({ file, line, excerpt }))
}

function confirmAdvice(kind: TrackerKind): string {
  if (!SUPPORTED_KINDS.has(kind)) {
    return `anvil has no ${kind} provider, so there is nothing to confirm; provider.default stays as it is.`
  }
  if (kind === 'jira') {
    return 'If that is right, confirm it with provider.default: "jira", then set provider.jira.site (credentials stay in JIRA_EMAIL and JIRA_API_TOKEN).'
  }
  return `If that is right, confirm it with provider.default: "${kind}".`
}

function finalize(draft: DetectionDraft, remote: string | null): TrackerDetection {
  const candidates: TrackerCandidate[] = []
  for (const kind of KIND_ORDER) {
    const candidate = draft.candidates.get(kind)
    if (candidate === undefined || candidate.evidence.length === 0) continue
    candidates.push({ kind, confidence: candidate.confidence, evidence: selectEvidence(candidate.evidence) })
  }

  const guess = draft.guessed
    ? ' Issue-key and bare-name evidence (PROJ-123, "Jira") is a guess, not proof that a tracker is used.'
    : ''
  const partial: string[] = []
  if (draft.truncated.length > 0) {
    partial.push(
      `only the first ${String(TRACKER_LIMITS.maxTemplateFiles)} files of ${draft.truncated.join(', ')} were read`,
    )
  }
  if (draft.skipped.length > 0) {
    const shown = draft.skipped.slice(0, 5).join(', ')
    const more = draft.skipped.length > 5 ? ` and ${String(draft.skipped.length - 5)} more` : ''
    partial.push(`not read (linked, oversized, binary or unreadable): ${shown}${more}`)
  }
  const scan = partial.length === 0 ? '' : ` The scan was partial: ${partial.join('; ')}.`
  const never = ' Detection is advisory and never writes configuration.'

  if (candidates.length === 0) {
    const host = remote === null ? null : hostKindOf(remote)
    const note = host === null ? '' : ` The ${host} remote is a code host, not proof that its issues are used.`
    return {
      state: 'na',
      reason: `No local evidence of a ticket tracker.${note}${scan}`,
      candidates: [],
    }
  }

  if (candidates.length === 1) {
    const only = candidates[0] as TrackerCandidate
    return {
      state: 'candidates',
      reason: `One tracker candidate: ${only.kind} (${only.confidence}).${guess}${scan} ${confirmAdvice(only.kind)}${never}`,
      candidates,
    }
  }

  const labels = candidates.map((candidate) => `${candidate.kind} (${candidate.confidence})`).join(', ')
  return {
    state: 'unconfirmed',
    reason: `Unconfirmed: ${String(candidates.length)} tracker candidates (${labels}).${guess}${scan} No winner is chosen; only a provider anvil supports (local, github, jira) can be confirmed in provider.default.${never}`,
    candidates,
  }
}

/**
 * The documents scanned, in the same preference order as the profile's own doc detection.
 *
 * Probed through {@link safePath} rather than `existsSync`, because `existsSync` reports a
 * permission error as "missing": an unreadable `docs/` would then hide its documents with
 * no partial-scan notice.
 */
const DOC_CANDIDATES: readonly (readonly string[])[] = [
  ['README.md', 'README.rst', 'README.txt', 'README', 'readme.md', 'docs/README.md'],
  ['CONTRIBUTING.md', 'CONTRIBUTING', 'docs/CONTRIBUTING.md', '.github/CONTRIBUTING.md'],
  ['SECURITY.md', 'docs/SECURITY.md', '.github/SECURITY.md'],
  [
    'ARCHITECTURE.md',
    'docs/ARCHITECTURE.md',
    'docs/architecture.md',
    'architecture.md',
    'docs/architecture/README.md',
    'doc/architecture.md',
  ],
]

/** The first document of a group that exists; an inaccessible one is recorded and skipped. */
function firstDoc(root: string, candidates: readonly string[], draft: DetectionDraft): string | null {
  for (const rel of candidates) {
    const resolved = safePath(root, rel, 'file')
    if (resolved === null) continue
    if ('skipped' in resolved) {
      if (!draft.skipped.includes(rel)) draft.skipped.push(rel)
      continue
    }
    return rel
  }
  return null
}

/**
 * Detect ticket-tracker candidates from local files.
 *
 * `remote` is the repository's `origin` URL when the caller already has it; it is only a
 * corroborating citation for a kind found in a file, and lets a documented issues link on
 * the same (e.g. GitHub Enterprise) host count. The function is synchronous and read-only,
 * which is what makes it safe to run inside `doctor`.
 */
export function detectTrackerCandidates(root: string, remote: string | null): TrackerDetection {
  const host = remote === null ? null : remoteHostOf(remote)
  const hostKind = remote === null ? null : hostKindOf(remote)
  const draft: DetectionDraft = {
    candidates: new Map(),
    guessed: false,
    skipped: [],
    truncated: [],
    remoteHost: host !== null && hostKind !== null ? { host, kind: hostKind } : null,
  }
  try {
    for (const rel of templateFiles(root, '.github/ISSUE_TEMPLATE', draft)) {
      scanTemplate(root, rel, 'github', draft)
    }
    if (safePath(root, '.github/ISSUE_TEMPLATE.md', 'file') !== null) {
      scanTemplate(root, '.github/ISSUE_TEMPLATE.md', 'github', draft)
    }

    for (const rel of templateFiles(root, '.gitlab/issue_templates', draft)) {
      scanTemplate(root, rel, 'gitlab', draft)
    }

    for (const group of DOC_CANDIDATES) {
      const rel = firstDoc(root, group, draft)
      if (rel === null) continue
      const text = readRepoText(root, rel, draft)
      if (text !== null) scanText(text, rel, draft)
    }

    scanRemote(root, remote, draft)
  } catch {
    // Detection is advisory. An unreadable tree is "no evidence", not a command failure.
    return {
      state: 'na',
      reason: 'No local evidence of a ticket tracker could be read.',
      candidates: [],
    }
  }

  return finalize(draft, remote)
}
