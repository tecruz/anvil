/**
 * The `--json` output contract.
 *
 * Every command emits exactly one envelope, success or failure:
 *
 *   { "schemaVersion": 1, "ok": true,  "command": "...", "data":   { ... } }
 *   { "schemaVersion": 1, "ok": false, "command": "...", "error":  { code, message, hint? } }
 *
 * This is what the opencode plugin parses, which is why it is versioned in `version.ts`
 * and must stay stable. Additive fields are fine; renaming or retyping is not.
 */

import { SCHEMA_VERSION } from './version.ts'
import { AnvilError, ExitCode, toAnvilError, type ExitCodeValue } from './errors.ts'

export interface SuccessEnvelope<T = unknown> {
  schemaVersion: typeof SCHEMA_VERSION
  ok: true
  command: string
  data: T
}

export interface FailureEnvelope {
  schemaVersion: typeof SCHEMA_VERSION
  ok: false
  command: string
  error: {
    code: string
    message: string
    hint?: string
    details?: Record<string, unknown>
  }
}

export type Envelope<T = unknown> = SuccessEnvelope<T> | FailureEnvelope

export function success<T>(command: string, data: T): SuccessEnvelope<T> {
  return { schemaVersion: SCHEMA_VERSION, ok: true, command, data }
}

export function failure(command: string, error: AnvilError): FailureEnvelope {
  return { schemaVersion: SCHEMA_VERSION, ok: false, command, error: error.toJSON() }
}

export interface WriteOptions {
  /** Reuse a stream for tests; defaults to stdout/stderr. */
  stdout?: (chunk: string) => void
  stderr?: (chunk: string) => void
}

export function emitJson<T>(command: string, envelope: Envelope<T>, opts: WriteOptions = {}): void {
  const write = opts.stdout ?? ((chunk: string) => process.stdout.write(chunk))
  write(JSON.stringify(envelope, null, 2) + '\n')
}

export function emitFailure(command: string, err: unknown, opts: WriteOptions = {}): ExitCodeValue {
  const write = opts.stderr ?? ((chunk: string) => process.stderr.write(chunk))
  const anvilErr = toAnvilError(err)
  emitJson(command, failure(command, anvilErr), { stdout: write })
  return anvilErr.exitCode
}

// ---------------------------------------------------------------------------
// Text mode rendering
// ---------------------------------------------------------------------------

/** Colorize, honoring the de-facto standards: NO_COLOR, --no-color, and TTY detection. */
export function makeStyle(enabled: boolean) {
  const wrap = (code: string) => (s: string) => (enabled ? `[${code}m${s}[0m` : s)
  return {
    bold: wrap('1'),
    dim: wrap('2'),
    red: wrap('31'),
    green: wrap('32'),
    yellow: wrap('33'),
    blue: wrap('34'),
    cyan: wrap('36'),
  }
}

export type Style = ReturnType<typeof makeStyle>

export function shouldUseColor(opts: {
  noColor: boolean
  stream: NodeJS.WriteStream
  env: NodeJS.ProcessEnv
}): boolean {
  if (opts.noColor) return false
  if (opts.env.NO_COLOR !== undefined && opts.env.NO_COLOR !== '') return false
  // FORCE_COLOR is authoritative when set: '0' (and '') force color off even on a TTY.
  if (opts.env.FORCE_COLOR !== undefined) {
    return opts.env.FORCE_COLOR !== '0' && opts.env.FORCE_COLOR !== ''
  }
  if (opts.env.TERM === 'dumb') return false
  return Boolean(opts.stream.isTTY)
}

/**
 * Minimal fixed-width table. Deliberately dependency-free; column widths are computed
 * from content, and `maxWidth` truncates the widest columns from the right so long
 * paths do not wrap a terminal into unreadability.
 */
export function renderTable(
  headers: string[],
  rows: string[][],
  style: Style,
  maxWidth = 120,
): string {
  if (rows.length === 0) return style.dim('(none)')

  const columns = headers.length
  const widths: number[] = headers.map((h, i) =>
    Math.max(h.length, ...rows.map((r) => (r[i] ?? '').length)),
  )

  // Shrink from the widest column until the table fits.
  let total = widths.reduce((a, b) => a + b, columns * 3 - 1)
  while (total > maxWidth) {
    let widest = 0
    for (let i = 1; i < columns; i++) {
      if ((widths[i] ?? 0) > (widths[widest] ?? 0)) widest = i
    }
    const current = widths[widest] ?? 0
    if (current <= 8) break
    widths[widest] = current - 1
    total -= 1
  }

  const truncate = (s: string, w: number): string => (s.length <= w ? s : s.slice(0, w - 1) + '…')
  const pad = (s: string, w: number): string => s + ' '.repeat(Math.max(0, w - s.length))

  const line = (cells: string[], styler: (s: string) => string = (s) => s): string =>
    cells.map((c, i) => styler(pad(truncate(c, widths[i] ?? 0), widths[i] ?? 0))).join('  ').trimEnd()

  const out: string[] = [line(headers, style.bold), line(widths.map((w) => '─'.repeat(w)), style.dim)]
  for (const row of rows) {
    out.push(line(headers.map((_, i) => row[i] ?? '')))
  }
  return out.join('\n')
}

/** Key/value block used by `config show` and similar. */
export function renderKeyValues(
  entries: Array<[string, string]>,
  style: Style,
  indent = '  ',
): string {
  const width = Math.max(0, ...entries.map(([k]) => k.length))
  return entries
    .map(([k, v]) => `${indent}${style.dim(pad(k, width))}  ${v}`)
    .join('\n')
}

function pad(s: string, w: number): string {
  return s + ' '.repeat(Math.max(0, w - s.length))
}
