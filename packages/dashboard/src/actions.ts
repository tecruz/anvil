/**
 * The dashboard's closed action set.
 *
 * ADR-0025 made the dashboard a read-only view. This is the deliberately small exception for
 * #88: three actions, each mapped to the exact argv a human would type. The browser never
 * supplies a command, a path, a flag or a repository. It supplies an action name from a closed
 * list and one bounded reference (`claim` takes a ticket, `ship` takes an existing claim key).
 * Ship always passes `--probe`, so verification runs through the CLI rather than being
 * silently skipped. Every action passes `--json`, so the page reads the CLI's own stage
 * report instead of guessing a verdict from the exit code. The CLI owns provider resolution,
 * ship verification and every approval boundary.
 */

export type DashboardAction = 'claim' | 'verify' | 'ship'

export const DASHBOARD_ACTIONS: readonly DashboardAction[] = ['claim', 'verify', 'ship']

/** A plain ticket reference is data, never shell text: no spaces, leading dash or control characters. */
const TICKET_REFERENCE = /^[A-Za-z0-9_./:@#-]{1,200}$/
/**
 * A pasted ticket URL stays a single argv value. Bounded, http(s) only, and limited to the
 * characters ordinary links use — whitespace, quotes, backticks and backslashes are refused.
 * Query strings (`?notification_referrer_id=1`) and fragments are valid ticket links: the
 * CLI's own `parseRef` resolves them (to `gh-88`), not this validator.
 */
const TICKET_URL = /^https?:\/\/[A-Za-z0-9.-]{1,253}(?::\d{1,5})?(?:\/[A-Za-z0-9._~%+&=?:/@#,-]*)?$/i
const MAX_TICKET_URL_LENGTH = 500

export type ParsedAction = { action: DashboardAction; ref: string | null }

function safeReference(ref: string): boolean {
  if (TICKET_REFERENCE.test(ref) && !ref.startsWith('-') && !ref.includes('..')) return true
  if (ref.length > MAX_TICKET_URL_LENGTH) return false
  return TICKET_URL.test(ref)
}

export function parseAction(value: unknown, ref: unknown): ParsedAction | null {
  if (typeof value !== 'string' || !DASHBOARD_ACTIONS.includes(value as DashboardAction)) return null
  const action = value as DashboardAction
  const needsRef = action === 'claim' || action === 'ship'
  if (!needsRef) {
    // Extra data for an action that takes none is a client bug, not an argument to forward.
    return ref === undefined || ref === null ? { action, ref: null } : null
  }
  if (typeof ref !== 'string' || !safeReference(ref)) return null
  return { action, ref }
}

/** The exact argv the CLI receives. No element comes from an unbounded request field. */
export function actionArgv(action: DashboardAction, ref: string | null): string[] {
  switch (action) {
    case 'claim':
      return ref === null ? [] : ['claim', ref, '--json']
    case 'verify':
      return ['crew', 'verify', '--json']
    case 'ship':
      // A bare `anvil ship` is a usage error, and without --probe the CLI records "not run".
      // Both are refused here so the button cannot ship an unverified change.
      return ref === null ? [] : ['ship', ref, '--probe', '--json']
  }
}

/** One CLI stage, shown even when the command exits zero. */
export interface ActionStage {
  name: string
  ok: boolean
  detail: string
}

export interface ActionResult {
  schemaVersion: 1
  action: DashboardAction
  command: string
  exitCode: number
  ok: boolean
  /** The CLI's own error, shown beside the snapshot. Never a synthetic green result. */
  error: string | null
  stages: ActionStage[]
  /** Verification that the CLI did not run, with its reason. */
  skipped: string[]
  /** Non-fatal caveats worth showing (inferred checks, high-risk paths). */
  warnings: string[]
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function errorText(error: unknown): string | null {
  if (!isRecord(error)) return null
  const text = [error.message, error.hint].filter((v): v is string => typeof v === 'string' && v !== '').join(' — ')
  return text === '' ? null : text
}

/** Both ship (`stages`) and crew verify (`results`) report per-stage outcomes in --json. */
function stagesFrom(data: unknown): ActionStage[] {
  if (!isRecord(data)) return []
  const stages: ActionStage[] = []
  if (Array.isArray(data.stages)) {
    for (const entry of data.stages) {
      if (!isRecord(entry)) continue
      stages.push({
        name: typeof entry.name === 'string' ? entry.name : 'stage',
        ok: entry.ok === true,
        detail: typeof entry.detail === 'string' ? entry.detail : '',
      })
    }
  }
  if (Array.isArray(data.results)) {
    for (const entry of data.results) {
      if (!isRecord(entry)) continue
      const commands = Array.isArray(entry.commands)
        ? entry.commands.flatMap((c) =>
            isRecord(c) && typeof c.command === 'string' && c.command !== '' ? [c.command] : [],
          )
        : []
      const detail = typeof entry.error === 'string' && entry.error !== '' ? entry.error : commands.join(', ')
      stages.push({
        name: typeof entry.key === 'string' ? entry.key : 'worktree',
        ok: entry.ok === true,
        detail,
      })
    }
  }
  return stages
}

function skippedFrom(data: unknown, stages: ActionStage[]): string[] {
  const skipped: string[] = []
  if (isRecord(data) && Array.isArray(data.skipped)) {
    for (const entry of data.skipped) {
      if (isRecord(entry)) {
        const key = typeof entry.key === 'string' ? entry.key : ''
        const reason = typeof entry.reason === 'string' ? entry.reason : ''
        skipped.push(`${key}: ${reason}`.trim())
      } else if (typeof entry === 'string') {
        skipped.push(entry)
      }
    }
  }
  for (const stage of stages) {
    if (/^(?:skipped|not run)\b/i.test(stage.detail)) skipped.push(`${stage.name}: ${stage.detail}`)
  }
  return skipped
}

function warningsFrom(data: unknown, stages: ActionStage[]): string[] {
  const warnings: string[] = []
  if (isRecord(data) && isRecord(data.risk) && data.risk.level === 'high') {
    const high = Array.isArray(data.risk.highPaths) ? data.risk.highPaths.length : 0
    const medium = Array.isArray(data.risk.mediumPaths) ? data.risk.mediumPaths.length : 0
    warnings.push(`high risk detected (${String(high)} high, ${String(medium)} medium paths)`)
  }
  for (const stage of stages) {
    if (/inferred/i.test(stage.detail)) warnings.push(`${stage.name}: ${stage.detail}`)
  }
  return warnings
}

export function actionResult(
  action: DashboardAction,
  argv: string[],
  result: { exitCode: number; stdout: string; stderr: string },
): ActionResult {
  let envelope: Record<string, unknown> | null = null
  try {
    const parsed: unknown = JSON.parse(result.stdout.trim())
    if (isRecord(parsed)) envelope = parsed
  } catch {
    // A CLI that did not emit JSON is still a result; the exit code and stderr speak for it.
    envelope = null
  }

  const data = envelope?.data
  const stages = stagesFrom(data)
  const skipped = skippedFrom(data, stages)
  const warnings = warningsFrom(data, stages)
  const failed = stages.filter((stage) => !stage.ok)

  let error: string | null = null
  if (envelope?.ok === false) error = errorText(envelope.error)
  if (error === null && result.exitCode !== 0) error = (result.stderr.trim() || result.stdout.trim()).slice(0, 400)
  if (failed.length > 0) {
    // A ship can exit zero with a FAIL ticket stage. That partial outcome must not look green.
    const detail = failed.map((stage) => `${stage.name}: ${stage.detail}`).join('; ')
    error = error === null ? detail : `${error} — ${detail}`
  }

  return {
    schemaVersion: 1,
    action,
    command: `anvil ${argv.join(' ')}`,
    exitCode: result.exitCode,
    ok: result.exitCode === 0 && envelope?.ok === true && failed.length === 0,
    error,
    stages,
    skipped,
    warnings,
  }
}
