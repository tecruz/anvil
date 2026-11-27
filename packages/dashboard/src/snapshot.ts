/**
 * The dashboard's data layer.
 *
 * Every value comes from an existing `anvil ... --json` envelope, or from a caller-supplied
 * read-only view of the staging bundle. Nothing here runs a build, starts an agent, fetches
 * guidance from the network, or writes to the repository. A failing source is recorded as an
 * error beside the other sources: one broken command must not make the whole overview look
 * empty or make the remaining views disappear.
 */

/** One staged artifact, as a diff against the repository's current copy. */
export interface StagedFileView {
  path: string
  diff: string
  /** True when the staged bytes no longer match what `init` produced. */
  edited: boolean
  /** Non-null when the staged bytes could not be read, so `diff` must not be shown. */
  error: string | null
}

/** A read-only view of `.anvil/staging/`, supplied by the CLI, which owns that format. */
export interface StagedView {
  exists: boolean
  createdAt: string | null
  inputHash: string | null
  files: StagedFileView[]
  summary: { files: number; added: number; removed: number }
}

export interface DashboardSource<T> {
  /** False exactly when this source failed; the other sources remain usable. */
  ok: boolean
  data: T | null
  error: string | null
  fetchedAt: string
  /** The CLI invocation behind the value, so a reader can reproduce it by hand. */
  command: string
}

/** A verification verdict. Absence is never a pass; only a clean, current, observed check is. */
export type VerificationVerdict = 'current' | 'stale' | 'failed' | 'incomplete' | 'legacy'

/** A verification fact recorded elsewhere, never inferred by the dashboard. */
export interface VerificationEvidence {
  command: string
  revision: string | null
  exitCode: number | null
  timestamp: string | null
  /** Whether this record's commit equals the one sampled at dashboard startup; null if unknown. */
  matchesCurrent: boolean | null
  /** 1 rows cannot prove an immutable tree; only format 2 can be current. */
  format: 1 | 2
  verdict: VerificationVerdict
  /** Repo-relative directory the check ran from, when the record binds one. */
  cwd: string | null
  /** Digest of the exact commands and directory, when the record binds one. */
  planDigest: string | null
  /** Claim the check ran for, when the record binds one. */
  claim: string | null
  /** False when the worktree was dirty or moved during the check. */
  clean: boolean | null
}

export interface DashboardSnapshot {
  schemaVersion: 1
  fetchedAt: string
  repository: {
    doctor: DashboardSource<unknown>
    ready: DashboardSource<unknown>
    plan: DashboardSource<unknown>
    /** The detected file index and commands behind a task brief. */
    profile: DashboardSource<unknown>
  }
  context: {
    brief: DashboardSource<unknown>
    staged: DashboardSource<StagedView>
  }
  work: {
    crew: DashboardSource<unknown>
  }
  /**
   * An explicit absence, never a green result inferred from "no output". When a bounded baseline
   * verification was explicitly run, its recorded facts appear in `evidence`; this page still does
   * not execute anything.
   */
  verification: {
    status: 'unavailable' | 'recorded'
    /** Best verdict across bounded records; 'none' means there was nothing to judge. */
    verdict: VerificationVerdict | 'none'
    reason: string
    /** Revision sampled once by the CLI when the dashboard started, never on a page load. */
    currentRevision: string | null
    /** Records present in the store but too incomplete to display as facts. */
    incompleteCount: number
    evidence: VerificationEvidence[]
  }
  notes: string[]
}

/** A CLI process result. The same shape the MCP transport already produces. */
export interface DashboardInvokeResult {
  exitCode: number
  stdout: string
  stderr: string
}

export type DashboardInvoke = (args: string[], cwd: string) => Promise<DashboardInvokeResult>

export interface LoadSnapshotOptions {
  invoke: DashboardInvoke
  cwd: string
  readStaged: () => StagedView
  /** Optional, opt-in source of bounded verification facts; the dashboard never runs commands. */
  readVerification?: () => unknown[] | Promise<unknown[]>
  /** Sampled once by the CLI at startup so a page load never launches git. */
  currentRevision?: string | null
  now?: () => Date
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function envelopeError(value: unknown, exitCode: number, stderr: string): string {
  const record = value !== null && typeof value === 'object' ? (value as Record<string, unknown>) : null
  const error =
    record?.error !== null && typeof record?.error === 'object' ? (record.error as Record<string, unknown>) : null
  const parts: string[] = []
  if (error !== null) {
    if (typeof error.message === 'string' && error.message !== '') parts.push(error.message)
    if (typeof error.hint === 'string' && error.hint !== '') parts.push(error.hint)
  }
  if (parts.length === 0 && record?.ok === false) parts.push(`anvil exited with code ${String(exitCode)}`)
  if (parts.length === 0 && stderr.trim() !== '') parts.push(stderr.trim().slice(0, 400))
  return parts.join(' — ') || `anvil exited with code ${String(exitCode)} without a readable error`
}

async function callSource(
  args: string[],
  options: LoadSnapshotOptions,
  fetchedAt: string,
): Promise<DashboardSource<unknown>> {
  const command = `anvil ${args.join(' ')}`
  try {
    const result = await options.invoke(args, options.cwd)
    let envelope: unknown
    try {
      envelope = JSON.parse(result.stdout.trim())
    } catch {
      return {
        ok: false,
        data: null,
        error: `No JSON from ${command}: ${(result.stderr.trim() || result.stdout.trim()).slice(0, 400)}`,
        fetchedAt,
        command,
      }
    }
    const record = envelope !== null && typeof envelope === 'object' ? (envelope as Record<string, unknown>) : null
    if (result.exitCode !== 0 || record === null || record.ok !== true) {
      return {
        ok: false,
        data: null,
        error: envelopeError(envelope, result.exitCode, result.stderr),
        fetchedAt,
        command,
      }
    }
    return { ok: true, data: record.data ?? null, error: null, fetchedAt, command }
  } catch (thrown) {
    return {
      ok: false,
      data: null,
      error: describeError(thrown),
      fetchedAt,
      command,
    }
  }
}

function stagedSource(options: LoadSnapshotOptions, fetchedAt: string): DashboardSource<StagedView> {
  const command = 'anvil init staging (read-only)'
  try {
    return { ok: true, data: options.readStaged(), error: null, fetchedAt, command }
  } catch (thrown) {
    return { ok: false, data: null, error: describeError(thrown), fetchedAt, command }
  }
}

function validTimestamp(value: unknown): value is string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) return false
  try {
    return new Date(value).toISOString() === value
  } catch {
    return false
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function validHex(value: unknown, min: number, max: number): value is string {
  return typeof value === 'string' && new RegExp(`^[0-9a-f]{${min},${max}}$`, 'i').test(value)
}

function validBoundedText(value: unknown, max: number): value is string {
  return typeof value === 'string' && value.trim() !== '' && value.length <= max
}

function validCwd(value: unknown): value is string {
  if (typeof value !== 'string' || value.length > 240) return false
  if (value === '') return true
  if (/^[/\\]|^[A-Za-z]:/.test(value)) return false
  return value.split(/[/\\]/).every((part) => part !== '' && part !== '..' && part !== '.')
}

/** Read a legacy row as history. It can never be described as current verification. */
function parseLegacy(value: unknown, currentCommit: string | null): VerificationEvidence | null {
  if (!isRecord(value) || 'schemaVersion' in value) return null
  if (!validBoundedText(value.command, 200)) return null
  if (typeof value.revision !== 'string') return null
  if (!validHex(value.revision.replace(/-dirty$/i, ''), 7, 64)) return null
  if (!Number.isSafeInteger(value.exitCode) || (value.exitCode as number) < 0) return null
  if (!validTimestamp(value.timestamp)) return null
  const commit = value.revision.replace(/-dirty$/i, '').toLowerCase()
  return {
    command: value.command,
    revision: value.revision,
    exitCode: value.exitCode as number,
    timestamp: value.timestamp,
    matchesCurrent: currentCommit === null ? null : commit === currentCommit,
    format: 1,
    verdict: 'legacy',
    cwd: null,
    planDigest: null,
    claim: null,
    clean: null,
  }
}

/** Read a version 2 record, applying the same contract the CLI used when it wrote it. */
function parseCurrent(value: unknown, currentCommit: string | null): VerificationEvidence | null {
  if (!isRecord(value) || value.schemaVersion !== 2) return null
  if (!validBoundedText(value.claim, 120) || !validHex(value.repository, 16, 16)) return null
  if (value.commit !== null && !validHex(value.commit, 7, 64)) return null
  if (typeof value.clean !== 'boolean' || !validCwd(value.cwd)) return null
  if (!Array.isArray(value.commands) || value.commands.length < 1 || value.commands.length > 20) return null
  if (!validHex(value.planDigest, 64, 64)) return null
  if (!validTimestamp(value.startedAt) || !validTimestamp(value.completedAt)) return null
  if (value.outcome !== 'passed' && value.outcome !== 'failed') return null
  const commands: Array<{ command: string; exitCode: number | null; exitObserved: boolean }> = []
  for (const entry of value.commands) {
    if (!isRecord(entry) || !validBoundedText(entry.command, 200) || typeof entry.exitObserved !== 'boolean')
      return null
    const exitValid =
      entry.exitCode === null
        ? entry.exitObserved === false
        : Number.isSafeInteger(entry.exitCode) &&
          (entry.exitCode as number) >= 0 &&
          (entry.exitCode as number) <= 0x7fffffff
    if (!exitValid) return null
    commands.push({
      command: entry.command,
      exitCode: entry.exitCode as number | null,
      exitObserved: entry.exitObserved,
    })
  }
  const commit = typeof value.commit === 'string' ? value.commit.toLowerCase() : null
  const observed = commands.every((command) => command.exitObserved && command.exitCode !== null)
  let verdict: VerificationVerdict
  if (commit === null || !value.clean || (currentCommit !== null && commit !== currentCommit)) verdict = 'stale'
  else if (!observed) verdict = 'incomplete'
  else if (value.outcome === 'failed' || commands.some((command) => (command.exitCode as number) !== 0))
    verdict = 'failed'
  else verdict = 'current'
  const failedCode = commands.find((command) => command.exitCode !== null && command.exitCode !== 0)?.exitCode ?? null
  return {
    command: commands
      .map((command) => command.command)
      .join('; ')
      .slice(0, 200),
    revision: typeof value.commit === 'string' ? value.commit : null,
    exitCode: observed ? (failedCode ?? 0) : null,
    timestamp: value.completedAt,
    matchesCurrent: currentCommit === null || commit === null ? null : commit === currentCommit,
    format: 2,
    verdict,
    cwd: value.cwd,
    planDigest: value.planDigest,
    claim: value.claim,
    clean: value.clean,
  }
}

function bestVerdict(evidence: readonly VerificationEvidence[]): VerificationVerdict | 'none' {
  for (const verdict of ['current', 'failed', 'incomplete', 'stale', 'legacy'] as const) {
    if (evidence.some((item) => item.verdict === verdict)) return verdict
  }
  return 'none'
}

const VERDICT_REASON: Record<VerificationVerdict | 'none', string> = {
  none: 'No bounded verification evidence has been recorded for this repository.',
  current:
    'A clean check passed against the current commit and its recorded command and directory. The dashboard does not execute commands and cannot independently prove their origin.',
  failed: 'A recorded check against the current commit failed. The dashboard does not execute commands.',
  incomplete: 'A check was recorded, but no process exit was observed, so no verdict can be claimed.',
  stale: 'No current verification: the recorded checks name a different commit or an unclean tree.',
  legacy:
    'Only legacy verification rows exist. They describe a worktree, not an immutable tree, so none can be current.',
}

/** Bound and validate opt-in verification records; never infer a result from their absence. */
async function verificationSource(options: LoadSnapshotOptions): Promise<DashboardSnapshot['verification']> {
  const unavailable = (
    reason: string,
    incompleteCount = 0,
    verdict: VerificationVerdict | 'none' = 'none',
  ): DashboardSnapshot['verification'] => ({
    status: 'unavailable',
    verdict,
    reason,
    currentRevision: options.currentRevision ?? null,
    incompleteCount,
    evidence: [],
  })
  if (options.readVerification === undefined) {
    return unavailable('anvil does not persist verification results. Run `anvil crew verify --record` for a verdict.')
  }
  try {
    const records: unknown = await options.readVerification()
    if (!Array.isArray(records)) return unavailable('The verification evidence source returned no readable records.')
    const currentRevision = options.currentRevision ?? null
    // `headRevision` samples a commit only. A `-dirty` suffix describes a worktree and can name
    // two different trees, so it is never treated as the current commit.
    const currentCommit = currentRevision === null ? null : currentRevision.replace(/-dirty$/i, '').toLowerCase()
    const parsed = records.map((value) => parseCurrent(value, currentCommit) ?? parseLegacy(value, currentCommit))
    const evidence = parsed.filter((item): item is VerificationEvidence => item !== null).slice(-20)
    const incompleteCount = records.length - evidence.length
    if (evidence.length === 0) {
      const reason =
        incompleteCount > 0
          ? `${incompleteCount} verification record(s) exist but are incomplete; none can be shown as a fact.`
          : VERDICT_REASON.none
      return unavailable(reason, incompleteCount)
    }
    const verdict = bestVerdict(evidence)
    return {
      status: 'recorded',
      verdict,
      reason: `${VERDICT_REASON[verdict]} Records found in the CLI-owned evidence file.`,
      currentRevision,
      incompleteCount,
      evidence,
    }
  } catch {
    return unavailable('The verification evidence source could not be read.')
  }
}

/**
 * Read all sources once. `--offline` is deliberate: a page load must not spend a network
 * request or refresh the discovery cache. An explicit refresh button calls this again.
 */
export async function loadSnapshot(options: LoadSnapshotOptions): Promise<DashboardSnapshot> {
  const now = options.now ?? (() => new Date())
  const fetchedAt = now().toISOString()
  const [doctor, ready, plan, profile, brief, crew] = await Promise.all([
    callSource(['doctor', '--json'], options, fetchedAt),
    callSource(['ready', '--json'], options, fetchedAt),
    callSource(['plan', '--offline', '--json'], options, fetchedAt),
    callSource(['profile', '--json'], options, fetchedAt),
    callSource(['brief', '--offline', '--json'], options, fetchedAt),
    callSource(['crew', 'status', '--json'], options, fetchedAt),
  ])

  return {
    schemaVersion: 1,
    fetchedAt,
    repository: { doctor, ready, plan, profile },
    context: { brief, staged: stagedSource(options, fetchedAt) },
    work: { crew },
    verification: await verificationSource(options),
    notes: [
      'Read-only: refresh re-reads the CLI JSON contracts; it never runs setup, tests, or ship.',
      'Values are a snapshot, not a live view of an agent or a tracker.',
    ],
  }
}
