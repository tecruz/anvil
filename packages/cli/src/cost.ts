/**
 * Cost, read from the host's usage ledger.
 *
 * Anvil does not know what a token costs and does not try to find out: pricing changes
 * per model and per provider, and a tool that guesses is a tool that reports wrong
 * numbers with confidence. `ccusage` already reads the local usage logs of the coding
 * agents on this machine and prices them, so anvil asks it.
 *
 * Two properties this module keeps:
 *
 *  - **Nothing is uploaded.** ccusage reads local files; anvil runs it locally and prints
 *    what it says. Anvil's promise is no telemetry, and a cost feature that phoned home
 *    would break it.
 *  - **A missing tool is a note, not a failure.** `ccusage` is optional. If it is not
 *    installed, the cost column says so and the rest of the status report is unaffected.
 *    A command that fails because a third-party CLI is absent teaches the reader to run
 *    commands without it.
 */

import { runProcess } from '@anvil/core'

/** One session's cost, as the ledger reports it. */
export interface SessionCost {
  sessionId: string
  /** Estimated cost in US dollars. Null when the ledger did not price the session. */
  costUsd: number | null
  /** Total tokens, including cache reads and writes when the ledger counts them. */
  tokens: number | null
  /** The models the session used. */
  models: string[]
}

export interface CostReport {
  /** False when no cost data could be obtained at all. */
  available: boolean
  /** Why there is no data, when there is none. */
  reason?: string
  /** Cost per session id. */
  sessions: Map<string, SessionCost>
}

/** Runs a command and returns its output. Injected so tests never shell out. */
export type CostRunner = (argv: readonly string[]) => Promise<{ ok: boolean; stdout: string; stderr: string }>

/**
 * The commands tried, in order.
 *
 * `ccusage opencode session` is the precise one: it reads only the opencode ledger. The
 * generic `ccusage session` reads every detected source, and is what an older ccusage
 * offers. Both produce the same report shape.
 */
const CCUSAGE_COMMANDS: readonly (readonly string[])[] = [
  ['opencode', 'session', '--json'],
  ['session', '--json'],
]

/**
 * Look up the cost of a set of sessions.
 *
 * Only the requested sessions are reported back, because the ledger holds every session
 * on the machine and a crew cares about its own.
 */
export async function lookupSessionCosts(
  sessionIds: readonly string[],
  run: CostRunner = defaultRunner,
): Promise<CostReport> {
  if (sessionIds.length === 0) {
    return { available: false, reason: 'no agent session is recorded for these claims', sessions: new Map() }
  }

  const wanted = new Set(sessionIds)
  let lastError = 'ccusage is not installed'
  for (const argv of CCUSAGE_COMMANDS) {
    const result = await run(['ccusage', ...argv])
    if (!result.ok) {
      lastError = result.stderr.trim() === '' ? `ccusage ${argv.join(' ')} failed` : result.stderr.trim()
      continue
    }
    const parsed = parseCcusageSessions(result.stdout)
    if (parsed === null) {
      lastError = `ccusage ${argv.join(' ')} returned a report anvil does not understand`
      continue
    }
    const sessions = new Map<string, SessionCost>()
    for (const id of wanted) {
      const cost = parsed.get(id)
      if (cost !== undefined) sessions.set(id, cost)
    }
    return { available: true, sessions }
  }

  return { available: false, reason: lastError, sessions: new Map() }
}

/**
 * Parse a ccusage session report.
 *
 * Null when the payload is not a ccusage report at all, which is different from a report
 * with no sessions in it: an empty report is an answer, and an unreadable one is not.
 *
 * Every field is optional. ccusage has changed its report shape before, and a cost
 * feature that breaks when it does is a cost feature nobody enables.
 */
export function parseCcusageSessions(stdout: string): Map<string, SessionCost> | null {
  let payload: unknown
  try {
    payload = JSON.parse(stdout)
  } catch {
    return null
  }
  if (typeof payload !== 'object' || payload === null) return null
  const sessions = (payload as { sessions?: unknown }).sessions
  if (!Array.isArray(sessions)) return null

  const out = new Map<string, SessionCost>()
  for (const entry of sessions) {
    if (typeof entry !== 'object' || entry === null) continue
    const record = entry as {
      sessionId?: unknown
      totalCost?: unknown
      totalTokens?: unknown
      modelsUsed?: unknown
    }
    if (typeof record.sessionId !== 'string' || record.sessionId === '') continue
    out.set(record.sessionId, {
      sessionId: record.sessionId,
      costUsd: typeof record.totalCost === 'number' && Number.isFinite(record.totalCost) ? record.totalCost : null,
      tokens: typeof record.totalTokens === 'number' && Number.isFinite(record.totalTokens) ? record.totalTokens : null,
      models: Array.isArray(record.modelsUsed)
        ? record.modelsUsed.filter((m): m is string => typeof m === 'string')
        : [],
    })
  }
  return out
}

/**
 * Run ccusage.
 *
 * `runProcess` rather than `execFile`, for the same reason the rest of the tool uses it:
 * on Windows the npm-installed `ccusage` is a `.cmd` shim, and Node does not resolve
 * PATHEXT.
 */
const defaultRunner: CostRunner = async (argv) => {
  const [bin, ...args] = argv
  if (bin === undefined) return { ok: false, stdout: '', stderr: 'empty command' }
  try {
    const result = await runProcess(bin, args, { timeoutMs: 60_000 })
    return {
      ok: result.exitCode === 0,
      stdout: result.stdout,
      stderr: result.stderr,
    }
  } catch (err) {
    return { ok: false, stdout: '', stderr: err instanceof Error ? err.message : String(err) }
  }
}

/** A cost as a short string for a table cell. */
export function formatCost(cost: SessionCost | undefined): string {
  if (cost === undefined || cost.costUsd === null) return '-'
  if (cost.costUsd === 0) return '$0.00'
  if (cost.costUsd < 0.01) return `$${cost.costUsd.toFixed(4)}`
  return `$${cost.costUsd.toFixed(2)}`
}
