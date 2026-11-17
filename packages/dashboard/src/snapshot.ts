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

export interface DashboardSnapshot {
  schemaVersion: 1
  fetchedAt: string
  repository: {
    doctor: DashboardSource<unknown>
    ready: DashboardSource<unknown>
    plan: DashboardSource<unknown>
  }
  context: {
    brief: DashboardSource<unknown>
    staged: DashboardSource<StagedView>
  }
  work: {
    crew: DashboardSource<unknown>
  }
  /** An explicit absence, never a green result inferred from "no output". */
  verification: {
    status: 'unavailable'
    reason: string
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

/**
 * Read all sources once. `--offline` is deliberate: a page load must not spend a network
 * request or refresh the discovery cache. An explicit refresh button calls this again.
 */
export async function loadSnapshot(options: LoadSnapshotOptions): Promise<DashboardSnapshot> {
  const now = options.now ?? (() => new Date())
  const fetchedAt = now().toISOString()
  const [doctor, ready, plan, brief, crew] = await Promise.all([
    callSource(['doctor', '--json'], options, fetchedAt),
    callSource(['ready', '--json'], options, fetchedAt),
    callSource(['plan', '--offline', '--json'], options, fetchedAt),
    callSource(['brief', '--offline', '--json'], options, fetchedAt),
    callSource(['crew', 'status', '--json'], options, fetchedAt),
  ])

  return {
    schemaVersion: 1,
    fetchedAt,
    repository: { doctor, ready, plan },
    context: { brief, staged: stagedSource(options, fetchedAt) },
    work: { crew },
    verification: {
      status: 'unavailable',
      reason: 'anvil does not persist verification results. Run `anvil crew verify` for a current verdict.',
    },
    notes: [
      'Read-only: refresh re-reads the CLI JSON contracts; it never runs setup, tests, or ship.',
      'Values are a snapshot, not a live view of an agent or a tracker.',
    ],
  }
}
