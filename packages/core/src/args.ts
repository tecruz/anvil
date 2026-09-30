/**
 * Argument parsing.
 *
 * A thin, typed wrapper over `node:util` parseArgs. Every command declares its flags;
 * unknown flags are a usage error (parseArgs is strict by default, and we keep it that
 * way -- a silently ignored `--jso` that produces human output is a nasty trap when
 * something else is consuming your stdout).
 */

import { type ParseArgsConfig, parseArgs } from 'node:util'
import { AnvilError, ErrorCode } from './errors.ts'

export interface FlagSpec {
  type: 'string' | 'boolean'
  short?: string
  /** Allow repeated occurrences; collected into an array. */
  multiple?: boolean
  default?: string | boolean | string[]
}

export type FlagSpecs = Record<string, FlagSpec>

export interface ParsedArgs {
  /** Flag values by long name. Defaults are pre-applied. */
  values: Record<string, string | boolean | string[] | undefined>
  positionals: string[]
}

function toParseArgsConfig(
  specs: FlagSpecs,
  args: string[],
): {
  config: ParseArgsConfig
  parsed: ReturnType<typeof parseArgs>
} {
  const options: NonNullable<ParseArgsConfig['options']> = {}
  for (const [name, spec] of Object.entries(specs)) {
    options[name] = {
      type: spec.type,
      ...(spec.short === undefined ? {} : { short: spec.short }),
      ...(spec.multiple === true ? { multiple: true } : {}),
      ...(spec.default === undefined ? {} : { default: spec.default }),
    }
  }
  const config: ParseArgsConfig = {
    args,
    options,
    allowPositionals: true,
    strict: true,
  }
  return { config, parsed: parseArgs(config) }
}

export function parseCliArgs(args: string[], specs: FlagSpecs): ParsedArgs {
  let parsed: ReturnType<typeof parseArgs>
  try {
    parsed = toParseArgsConfig(specs, args).parsed
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause)
    throw new AnvilError(ErrorCode.Usage, message, {
      hint: 'Run the command with --help to see the accepted flags.',
      cause,
    })
  }
  return {
    values: parsed.values as ParsedArgs['values'],
    positionals: parsed.positionals,
  }
}

/** Narrowing helpers so command bodies do not deal in `string | boolean | string[] | undefined`. */

export function getString(args: ParsedArgs, name: string): string | undefined {
  const v = args.values[name]
  return typeof v === 'string' ? v : undefined
}

export function getBool(args: ParsedArgs, name: string): boolean {
  return args.values[name] === true
}

export function getList(args: ParsedArgs, name: string): string[] {
  const v = args.values[name]
  if (Array.isArray(v)) return v
  if (typeof v === 'string')
    return v
      .split(',')
      .map((s) => s.trim())
      .filter((s) => s.length > 0)
  return []
}

/**
 * Split a command string into argv, honouring quotes.
 *
 * A verify command is stored and rendered as one string (detectors find
 * `./gradlew test --tests "*Changed*"` in a manifest, and it is printed the same way in
 * the PR body), but it has to reach the process as an argument array. Splitting on
 * whitespace passes `--tests` the literal `"*Changed*"` including the quotes, which makes
 * a filtered Gradle test run match nothing and looks like a green build. This is a small
 * POSIX-ish tokenizer: single and double quotes group, and a backslash escapes the next
 * character inside double quotes. It is not a shell -- it performs no expansion, no
 * substitution and no globbing.
 */
export function tokenizeCommand(command: string): string[] {
  const out: string[] = []
  let current = ''
  let quote: '"' | "'" | null = null
  let hasToken = false

  for (let i = 0; i < command.length; i++) {
    const ch = command[i] as string
    if (quote !== null) {
      if (ch === '\\' && quote === '"' && i + 1 < command.length) {
        current += command[i + 1]
        i++
        continue
      }
      if (ch === quote) {
        quote = null
        continue
      }
      current += ch
      continue
    }
    if (ch === '"' || ch === "'") {
      quote = ch
      hasToken = true
      continue
    }
    if (/\s/.test(ch)) {
      if (hasToken) {
        out.push(current)
        current = ''
        hasToken = false
      }
      continue
    }
    current += ch
    hasToken = true
  }
  if (hasToken) out.push(current)
  return out
}
