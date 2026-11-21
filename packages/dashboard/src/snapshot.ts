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

/** A verification fact recorded elsewhere, never inferred by the dashboard. */
export interface VerificationEvidence {
  command: string
  revision: string | null
  exitCode: number | null
  timestamp: string | null
  /** Whether this record was captured at the repository revision sampled by the CLI; null if unknown. */
  matchesCurrent: boolean | null
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

function validEvidence(value: unknown): value is VerificationEvidence {
  if (value === null || typeof value !== 'object') return false
  const record = value as Record<string, unknown>
  return (
    typeof record.command === 'string' &&
    record.command.trim() !== '' &&
    record.command.length <= 200 &&
    typeof record.revision === 'string' &&
    /^[0-9a-f]{7,64}(?:-dirty)?$/i.test(record.revision) &&
    typeof record.exitCode === 'number' &&
    Number.isSafeInteger(record.exitCode) &&
    record.exitCode >= 0 &&
    record.exitCode <= 0x7fffffff &&
    validTimestamp(record.timestamp)
  )
}

/** Bound and validate opt-in verification records; never infer a result from their absence. */
async function verificationSource(options: LoadSnapshotOptions): Promise<DashboardSnapshot['verification']> {
  const unavailable = (reason: string, incompleteCount = 0): DashboardSnapshot['verification'] => ({
    status: 'unavailable',
    reason,
    currentRevision: options.currentRevision ?? null,
    incompleteCount,
    evidence: [],
  })
  if (options.readVerification === undefined) {
    return unavailable('anvil does not persist verification results. Run `anvil crew verify` for a current verdict.')
  }
  try {
    const records: unknown = await options.readVerification()
    if (!Array.isArray(records)) return unavailable('The verification evidence source returned no readable records.')
    const incompleteCount = records.length - records.filter(validEvidence).length
    const currentRevision = options.currentRevision ?? null
    const evidence: VerificationEvidence[] = records
      .filter(validEvidence)
      .slice(-20)
      .map((record) => ({
        ...record,
        matchesCurrent: currentRevision === null ? null : record.revision === currentRevision,
      }))
    if (evidence.length === 0) {
      const reason =
        incompleteCount > 0
          ? `${incompleteCount} verification record(s) exist but are incomplete; none can be shown as a fact.`
          : 'No bounded verification evidence has been recorded for this repository.'
      return unavailable(reason, incompleteCount)
    }
    const stale = currentRevision !== null && evidence.some((item) => item.matchesCurrent === false)
    return {
      status: 'recorded',
      reason: stale
        ? 'Recorded by an explicit, bounded verification run; at least one record is from a different revision than this checkout.'
        : 'Recorded by an explicit, bounded verification run; this page only displays the facts.',
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
