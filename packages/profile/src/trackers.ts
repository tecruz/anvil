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

import { lstatSync } from 'node:fs'
import { join } from 'node:path'
import { detectDocs } from './general.ts'
import type { CommandSource } from './types.ts'
import { readText, walkFiles } from './walk.ts'

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

/**
 * Key prefixes that look like an issue key but are ordinary standards.
 *
 * `UTF-8`, `ISO-8601`, `RFC-2119` and `SHA-256` all match an issue-key shape. Naming Jira
 * for them would be the confident-and-wrong output this project refuses, and a `PROJ-123`
 * candidate is already labelled a guess.
 */
const NON_ISSUE_KEY_PREFIXES: ReadonlySet<string> = new Set([
  'AES',
  'ANSI',
  'API',
  'CVE',
  'CSS',
  'DNS',
  'DSS',
  'ECMA',
  'GDPR',
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
  'OAuth',
  'PCI',
  'RFC',
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
  'XML',
  'YAML',
])

const ISSUE_KEY_RE = /\b([A-Z][A-Z0-9]{1,9})-(\d{1,6})\b/g

const GUESS_SUFFIX = ' (issue-key guess, not proof)'

/** Documentation evidence: a human wrote a tracker name or an issues-page link down. */
const DOC_PATTERNS: ReadonlyArray<{ kind: TrackerKind; re: RegExp }> = [
  // A code-host issues page, not just a homepage or clone URL.
  { kind: 'github', re: /\bgithub\.com\/[^\s)>\]]+\/issues\b/i },
  { kind: 'gitlab', re: /\bgitlab[^\s)>\]]*\/-\/issues\b/i },
  // Jira is named either by its own host or by its product name.
  { kind: 'jira', re: /\b[a-z0-9-]+\.atlassian\.net\b/i },
  { kind: 'jira', re: /\bjira\b/i },
  // `linear` is an ordinary word; only its own host is evidence.
  { kind: 'linear', re: /\blinear\.app\b/i },
]

interface Accumulator {
  kind: TrackerKind
  confidence: TrackerConfidence
  evidence: TrackerEvidence[]
  perFile: Map<string, number>
  seen: Set<string>
}

interface DetectionDraft {
  candidates: Map<TrackerKind, Accumulator>
  /** True when at least one issue-key convention contributed. */
  guessed: boolean
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

/**
 * Resolve a repo-relative path only when no component is a symlink.
 *
 * The walk already refuses symlinked files, but the docs probes resolve a known name, so
 * this closes the same gap explicitly: a repository can commit `CONTRIBUTING.md -> /etc/...`
 * and detection must not follow it. Missing, dangling, symlinked and unreadable paths all
 * return null.
 */
function safePath(root: string, relPath: string, want: 'file' | 'directory'): string | null {
  const segments = safeSegments(relPath)
  if (segments === null) return null
  try {
    let current = root
    for (const [index, segment] of segments.entries()) {
      current = join(current, segment)
      const stat = lstatSync(current)
      if (stat.isSymbolicLink()) return null
      const last = index === segments.length - 1
      if (last) {
        if (want === 'file' ? !stat.isFile() : !stat.isDirectory()) return null
        if (want === 'file' && stat.size > TRACKER_LIMITS.maxFileBytes) return null
      } else if (!stat.isDirectory()) {
        return null
      }
    }
    return current
  } catch {
    return null
  }
}

/** Read a repo-relative text file without following a symlink and without exceeding the bound. */
function readRepoText(root: string, relPath: string): string | null {
  const path = safePath(root, relPath, 'file')
  if (path === null) return null
  return readText(path).text
}

function shortExcerpt(line: string, suffix = ''): string {
  const room = Math.max(0, TRACKER_LIMITS.maxExcerptChars - suffix.length)
  const trimmed = line.trim().replace(/\s+/g, ' ')
  const body = trimmed.length > room ? `${trimmed.slice(0, Math.max(0, room - 3))}...` : trimmed
  return `${body}${suffix}`
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
  if (CONFIDENCE_RANK[confidence] > CONFIDENCE_RANK[candidate.confidence]) {
    candidate.confidence = confidence
  }
  const perFile = candidate.perFile.get(evidence.file) ?? 0
  if (perFile >= TRACKER_LIMITS.maxEvidencePerFile) return
  const key = `${evidence.file}:${evidence.line}:${evidence.excerpt}`
  if (candidate.seen.has(key)) return
  candidate.seen.add(key)
  candidate.perFile.set(evidence.file, perFile + 1)
  candidate.evidence.push(evidence)
}

/** Add the host for a template that exists, and scan that template for issue keys. */
function scanTemplate(root: string, relPath: string, kind: TrackerKind, draft: DetectionDraft): void {
  const text = readRepoText(root, relPath)
  if (text === null) return
  const lines = text.split('\n')
  const index = lines.findIndex((line) => line.trim() !== '')
  addEvidence(draft, kind, 'detected', {
    file: relPath,
    line: index < 0 ? 1 : index + 1,
    excerpt: shortExcerpt(index < 0 ? relPath : (lines[index] as string)),
  })
  scanIssueKeys(text, relPath, draft)
}

/** List a template directory through the existing walk, refusing symlinked ancestors. */
function templateFiles(root: string, dir: string): string[] {
  if (safePath(root, dir, 'directory') === null) return []
  const { files } = walkFiles(join(root, ...dir.split('/')), {
    maxFiles: TRACKER_LIMITS.maxTemplateFiles,
    maxDepth: 2,
  })
  return files.map((file) => `${dir}/${file}`)
}

/**
 * Add a Jira-like candidate for `PROJ-123` conventions.
 *
 * The marker in the excerpt and the top-level reason both say this is a guess. A repeated
 * key shape is a convention, not proof that a Jira instance exists, which is why the
 * confidence is `inferred` and the candidate is never a verdict.
 */
function scanIssueKeys(text: string, relPath: string, draft: DetectionDraft): void {
  const lines = text.split('\n')
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index] ?? ''
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

/** Add documented candidates for tracker names and issues-page links in a doc. */
function scanDoc(root: string, relPath: string | null, draft: DetectionDraft): void {
  if (relPath === null) return
  const text = readRepoText(root, relPath)
  if (text === null) return
  const lines = text.split('\n')
  for (const [index, line] of lines.entries()) {
    for (const pattern of DOC_PATTERNS) {
      if (!pattern.re.test(line)) continue
      addEvidence(draft, pattern.kind, 'documented', {
        file: relPath,
        line: index + 1,
        excerpt: shortExcerpt(line),
      })
    }
  }
  scanIssueKeys(text, relPath, draft)
}

/**
 * Hide URL userinfo before a remote is quoted.
 *
 * A remote can carry a token (`https://user:token@host/...`); evidence is printed and put in
 * JSON, so the credential part is replaced rather than repeated.
 */
export function redactRemoteUserinfo(text: string): string {
  return text.replace(/([a-z][a-z0-9+.-]*:\/\/)[^@/\s]+@/gi, '$1***@')
}

/** The tracker kind a remote host implies, or null for a code host with no tracker kind. */
function hostKindOf(remote: string): TrackerKind | null {
  if (/github\.com|github\./i.test(remote)) return 'github'
  if (/gitlab/i.test(remote)) return 'gitlab'
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

  const text = readRepoText(root, '.git/config')
  if (text !== null) {
    const lines = text.split('\n')
    const index = lines.findIndex((line) => line.includes(remote.trim()))
    if (index >= 0) {
      addEvidence(draft, kind, 'inferred', {
        file: '.git/config',
        line: index + 1,
        excerpt: shortExcerpt(redactRemoteUserinfo(lines[index] ?? '')),
      })
      return
    }
  }
  // A worktree's `.git` is a file, and a caller may supply the remote without it being
  // readable here. Line 0 marks a citation of that supplied remote rather than a file line.
  addEvidence(draft, kind, 'inferred', {
    file: '.git/config',
    line: 0,
    excerpt: `remote: ${shortExcerpt(redactRemoteUserinfo(remote.trim()))}`,
  })
}

function finalize(draft: DetectionDraft, remote: string | null): TrackerDetection {
  const candidates: TrackerCandidate[] = []
  for (const kind of KIND_ORDER) {
    const candidate = draft.candidates.get(kind)
    if (candidate === undefined || candidate.evidence.length === 0) continue
    const evidence = [...candidate.evidence]
      .sort((a, b) => (a.file === b.file ? a.line - b.line : a.file < b.file ? -1 : 1))
      .slice(0, TRACKER_LIMITS.maxEvidencePerCandidate)
    candidates.push({ kind, confidence: candidate.confidence, evidence })
  }

  const guess = draft.guessed
    ? ' Issue-key evidence such as PROJ-123 is a guess, not proof that a Jira project exists.'
    : ''

  if (candidates.length === 0) {
    const host = remote === null ? null : hostKindOf(remote)
    const note = host === null ? '' : ` The ${host} remote is a code host, not proof that its issues are used.`
    return {
      state: 'na',
      reason: `No local evidence of a ticket tracker.${note}`,
      candidates: [],
    }
  }

  if (candidates.length === 1) {
    const only = candidates[0] as TrackerCandidate
    return {
      state: 'candidates',
      reason: `One tracker candidate: ${only.kind} (${only.confidence}).${guess} Confirm it in provider.default; detection is advisory and never writes configuration.`,
      candidates,
    }
  }

  const labels = candidates.map((candidate) => `${candidate.kind} (${candidate.confidence})`).join(', ')
  return {
    state: 'unconfirmed',
    reason: `Unconfirmed: ${String(candidates.length)} tracker candidates (${labels}).${guess} No winner is chosen; confirm one in provider.default.`,
    candidates,
  }
}

/**
 * Detect ticket-tracker candidates from local files.
 *
 * `remote` is the repository's `origin` URL when the caller already has it; it is only a
 * corroborating citation for a kind found in a file. The function is synchronous and
 * read-only, which is what makes it safe to run inside `doctor`.
 */
export function detectTrackerCandidates(root: string, remote: string | null): TrackerDetection {
  const draft: DetectionDraft = { candidates: new Map(), guessed: false }
  try {
    for (const rel of templateFiles(root, '.github/ISSUE_TEMPLATE')) {
      scanTemplate(root, rel, 'github', draft)
    }
    if (safePath(root, '.github/ISSUE_TEMPLATE.md', 'file') !== null) {
      scanTemplate(root, '.github/ISSUE_TEMPLATE.md', 'github', draft)
    }

    for (const rel of templateFiles(root, '.gitlab/issue_templates')) {
      scanTemplate(root, rel, 'gitlab', draft)
    }

    const docs = detectDocs(root)
    for (const rel of [docs.readme, docs.contributing, docs.security, docs.architecture]) {
      scanDoc(root, rel, draft)
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
