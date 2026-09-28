/**
 * Exit codes and structured errors.
 *
 * Every failure path in anvil is an `AnvilError`. That gives three things for free:
 * a stable machine-readable `code` in `--json` mode, a stable process exit code for
 * scripts and CI, and a `hint` that tells the user what to actually do next.
 *
 * Exit codes are part of the public contract (M0). Do not renumber them.
 */

export const ExitCode = {
  /** Command completed successfully. */
  Ok: 0,
  /** Unclassified failure. */
  Failure: 1,
  /** Bad flags, unknown command, missing required argument. */
  Usage: 2,
  /** Config file missing, unparseable, or schema-invalid. */
  Config: 3,
  /** Auth missing/expired, or the transport cannot reach the host. */
  Auth: 4,
  /** Not a git repo, or a repo preflight check failed. */
  NotARepo: 5,
  /** Readiness threshold not met (`--fail-on`). */
  Threshold: 6,
  /** A required external tool is missing. */
  ToolMissing: 7,
  /** Staging bundle is stale relative to current repo inputs. */
  StaleStaging: 8,
  /** Bug in anvil. Report it. */
  Internal: 70,
} as const

export type ExitCodeValue = (typeof ExitCode)[keyof typeof ExitCode]

/**
 * Stable error codes. These appear in `error.code` in `--json` output and are safe to
 * branch on from scripts and the opencode plugin.
 */
export const ErrorCode = {
  Usage: 'USAGE',
  UnknownCommand: 'UNKNOWN_COMMAND',
  ConfigInvalid: 'CONFIG_INVALID',
  ConfigUnreadable: 'CONFIG_UNREADABLE',
  NotAGitRepo: 'NOT_A_GIT_REPO',
  PreflightFailed: 'PREFLIGHT_FAILED',
  AuthFailed: 'AUTH_FAILED',
  ToolMissing: 'TOOL_MISSING',
  UnsupportedHost: 'UNSUPPORTED_HOST',
  ThresholdNotMet: 'THRESHOLD_NOT_MET',
  StaleStaging: 'STALE_STAGING',
  Internal: 'INTERNAL',
} as const

export type ErrorCodeValue = (typeof ErrorCode)[keyof typeof ErrorCode]

const CODE_TO_EXIT: Record<ErrorCodeValue, ExitCodeValue> = {
  [ErrorCode.Usage]: ExitCode.Usage,
  [ErrorCode.UnknownCommand]: ExitCode.Usage,
  [ErrorCode.ConfigInvalid]: ExitCode.Config,
  [ErrorCode.ConfigUnreadable]: ExitCode.Config,
  [ErrorCode.NotAGitRepo]: ExitCode.NotARepo,
  [ErrorCode.PreflightFailed]: ExitCode.NotARepo,
  [ErrorCode.AuthFailed]: ExitCode.Auth,
  [ErrorCode.ToolMissing]: ExitCode.ToolMissing,
  [ErrorCode.UnsupportedHost]: ExitCode.Auth,
  [ErrorCode.ThresholdNotMet]: ExitCode.Threshold,
  [ErrorCode.StaleStaging]: ExitCode.StaleStaging,
  [ErrorCode.Internal]: ExitCode.Internal,
}

export interface AnvilErrorOptions {
  /** What the user should do about it. Actionable, never "try again". */
  hint?: string
  /** Underlying cause, kept for humans in text mode. */
  cause?: unknown
  /** Extra structured context surfaced in `--json`. */
  details?: Record<string, unknown>
}

export class AnvilError extends Error {
  readonly code: ErrorCodeValue
  readonly exitCode: ExitCodeValue
  readonly hint: string | undefined
  readonly details: Record<string, unknown> | undefined

  constructor(code: ErrorCodeValue, message: string, options: AnvilErrorOptions = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause })
    this.name = 'AnvilError'
    this.code = code
    this.exitCode = CODE_TO_EXIT[code]
    this.hint = options.hint
    this.details = options.details
  }

  toJSON(): {
    code: ErrorCodeValue
    message: string
    hint?: string
    details?: Record<string, unknown>
  } {
    return {
      code: this.code,
      message: this.message,
      ...(this.hint === undefined ? {} : { hint: this.hint }),
      ...(this.details === undefined ? {} : { details: this.details }),
    }
  }
}

export function isAnvilError(value: unknown): value is AnvilError {
  return value instanceof AnvilError
}

/** Normalize anything thrown into an AnvilError so the top level has one shape to handle. */
export function toAnvilError(err: unknown): AnvilError {
  if (isAnvilError(err)) return err
  if (err instanceof Error) {
    return new AnvilError(ErrorCode.Internal, err.message, { cause: err })
  }
  return new AnvilError(ErrorCode.Internal, String(err), { cause: err })
}
