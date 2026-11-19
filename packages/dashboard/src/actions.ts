/**
 * The dashboard's closed action set.
 *
 * ADR-0025 made the dashboard a read-only view. This is the deliberately small exception for
 * #88: three actions, each mapped to the exact argv a human would type. The browser never
 * supplies a command, a path, a flag or a repository. It supplies an action name from a closed
 * list and one bounded reference (`claim` takes a ticket, `ship` takes an existing claim key).
 * Ship always passes `--probe`, so verification runs through the CLI rather than being
 * silently skipped. The CLI owns provider resolution, ship verification and every approval
 * boundary.
 */

export type DashboardAction = 'claim' | 'verify' | 'ship'

export const DASHBOARD_ACTIONS: readonly DashboardAction[] = ['claim', 'verify', 'ship']

/** A ticket reference is data, never shell text: no spaces, leading dash or control characters. */
const TICKET_REFERENCE = /^[A-Za-z0-9_./:@#-]{1,200}$/

export type ParsedAction = { action: DashboardAction; ref: string | null }

export function parseAction(value: unknown, ref: unknown): ParsedAction | null {
  if (typeof value !== 'string' || !DASHBOARD_ACTIONS.includes(value as DashboardAction)) return null
  const action = value as DashboardAction
  const needsRef = action === 'claim' || action === 'ship'
  if (!needsRef) {
    // Extra data for an action that takes none is a client bug, not an argument to forward.
    return ref === undefined || ref === null ? { action, ref: null } : null
  }
  if (typeof ref !== 'string' || !TICKET_REFERENCE.test(ref) || ref.startsWith('-') || ref.includes('..')) return null
  return { action, ref }
}

/** The exact argv the CLI receives. No element comes from an unbounded request field. */
export function actionArgv(action: DashboardAction, ref: string | null): string[] {
  switch (action) {
    case 'claim':
      return ref === null ? [] : ['claim', ref]
    case 'verify':
      return ['crew', 'verify']
    case 'ship':
      // A bare `anvil ship` is a usage error, and without --probe the CLI records "not run".
      // Both are refused here so the button cannot ship an unverified change.
      return ref === null ? [] : ['ship', ref, '--probe']
  }
}

export interface ActionResult {
  schemaVersion: 1
  action: DashboardAction
  command: string
  exitCode: number
  ok: boolean
  /** The CLI's own error, shown beside the snapshot. Never a synthetic green result. */
  error: string | null
}

export function actionResult(
  action: DashboardAction,
  argv: string[],
  result: { exitCode: number; stdout: string; stderr: string },
): ActionResult {
  let error: string | null = null
  try {
    const envelope = JSON.parse(result.stdout.trim()) as Record<string, unknown>
    if (envelope.ok === false) {
      const detail = envelope.error
      if (detail !== null && typeof detail === 'object') {
        const e = detail as Record<string, unknown>
        error = [e.message, e.hint].filter((v): v is string => typeof v === 'string' && v !== '').join(' — ')
      }
    }
  } catch {
    error = null
  }
  if (error === null && result.exitCode !== 0) error = (result.stderr.trim() || result.stdout.trim()).slice(0, 400)
  return {
    schemaVersion: 1,
    action,
    command: `anvil ${argv.join(' ')}`,
    exitCode: result.exitCode,
    ok: result.exitCode === 0,
    error: error || null,
  }
}
