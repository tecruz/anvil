/**
 * Canonical JSON and content digests.
 *
 * Setup plans are compared as data, not as text: object key order must not matter, array
 * order must, and a non-JSON value (including `undefined`) must be refused rather than
 * silently serialized. The digest is a change detector, never an authorization token.
 */
import { createHash } from 'node:crypto'

/** Canonical JSON: object insertion order is irrelevant; array order remains significant. */
export function canonicalJson(value: unknown, depth = 0): string {
  if (depth > 50) throw new Error('Plan is too deeply nested')
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value)
  if (typeof value === 'number' && Number.isFinite(value)) return JSON.stringify(value)
  if (Array.isArray(value)) return `[${Array.from(value, (entry) => canonicalJson(entry, depth + 1)).join(',')}]`
  if (typeof value !== 'object' || value === null || Object.getPrototypeOf(value) !== Object.prototype) {
    throw new Error('Expected JSON data')
  }
  const record = value as Record<string, unknown>
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key], depth + 1)}`)
    .join(',')}}`
}

/** SHA-256 of the canonical JSON form of `value`. */
export function digestJson(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value)).digest('hex')
}
