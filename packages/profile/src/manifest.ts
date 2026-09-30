/**
 * Small readers for the manifest formats detectors need.
 *
 * Deliberately not a JSON5/TOML/YAML library: a malformed manifest must not crash the
 * profile, and these readers return `null` rather than throwing. `packages/audit` needs
 * precise messages, and it re-reads the file with a stricter parser where that matters.
 */

import { join } from 'node:path'
import { readText } from './walk.ts'

export interface JsonObject {
  [key: string]: unknown
}

export function readJson(
  ctx: { root: string; maxFileBytes: number; resolve?: (rel: string) => string },
  relPath: string,
): JsonObject | null {
  const { text, bytes } = readText(join(ctx.root, ctx.resolve?.(relPath) ?? relPath))
  if (text === null || bytes > ctx.maxFileBytes) return null
  try {
    const parsed: unknown = JSON.parse(text)
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null
    return parsed as JsonObject
  } catch {
    return null
  }
}

export function readJsonc(
  ctx: { root: string; maxFileBytes: number; resolve?: (rel: string) => string },
  relPath: string,
): JsonObject | null {
  const { text, bytes } = readText(join(ctx.root, ctx.resolve?.(relPath) ?? relPath))
  if (text === null || bytes > ctx.maxFileBytes) return null
  return parseJsonc(text)
}

/**
 * Parse JSON with comments and trailing commas -- what `tsconfig.json` and friends
 * actually contain. Strips comments outside strings, then removes trailing commas.
 */
export function parseJsonc(text: string): JsonObject | null {
  let out = ''
  let inString = false
  let escaped = false
  let inLine = false
  let inBlock = false

  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    const next = text[i + 1]

    if (inLine) {
      if (ch === '\n') {
        inLine = false
        out += ch
      }
      continue
    }
    if (inBlock) {
      if (ch === '*' && next === '/') {
        inBlock = false
        i++
      }
      continue
    }
    if (inString) {
      out += ch
      if (escaped) escaped = false
      else if (ch === '\\') escaped = true
      else if (ch === '"') inString = false
      continue
    }
    if (ch === '"') {
      inString = true
      out += ch
      continue
    }
    if (ch === '/' && next === '/') {
      inLine = true
      i++
      continue
    }
    if (ch === '/' && next === '*') {
      inBlock = true
      i++
      continue
    }
    out += ch
  }

  // Trailing commas before } or ].
  out = out.replace(/,(\s*[}\]])/g, '$1')

  try {
    const parsed: unknown = JSON.parse(out)
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null
    return parsed as JsonObject
  } catch {
    return null
  }
}

/** Find the first line matching `pattern`; returns 1-based line or null. */
export function findLine(text: string, pattern: RegExp): number | null {
  const lines = text.split('\n')
  for (let i = 0; i < lines.length; i++) {
    if (pattern.test(lines[i] ?? '')) return i + 1
  }
  return null
}

/** Compose a `file:line` evidence string. */
export function evidence(file: string, line: number | null): string {
  return line === null ? file : `${file}:${line}`
}

export function asString(v: unknown): string | null {
  return typeof v === 'string' && v !== '' ? v : null
}

export function asStringArray(v: unknown): string[] {
  if (!Array.isArray(v)) return []
  return v.filter((x): x is string => typeof x === 'string')
}

export function asObject(v: unknown): JsonObject | null {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return null
  return v as JsonObject
}

/** Semver-ish first version in a string, e.g. "v4.2.0" or "^1.2" -> "4.2.0". */
export function looseVersion(v: string | null): string | null {
  if (v === null) return null
  const m = /(\d+)\.(\d+)(?:\.(\d+))?/.exec(v)
  return m === null ? null : m[0]
}
