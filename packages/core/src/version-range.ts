/**
 * A deliberately small semantic-version range evaluator.
 *
 * `anvil ready` has to answer one question: does the version a tool reported satisfy the
 * range the project declared? It does not need to resolve dependencies, and it must not
 * pretend to be npm's resolver. This implements the subset an owner can reasonably write
 * down and anvil can explain:
 *
 *   - exact versions: `1.2.3`
 *   - comparators: `>=18`, `<21`, `>=18 <21`, `>=18, <21`
 *   - partial versions: `18` (the `18.x` line), `18.2` (the `18.2.x` line)
 *   - wildcards: `*`, `18.x`, `18.2.x`
 *   - caret and tilde ranges: `^20.11`, `~1.2.3`
 *   - alternatives: `^18 || ^20`
 *
 * Anything outside that subset is rejected when the config is loaded, rather than silently
 * treated as "any version": a range anvil cannot understand must not become a pass.
 *
 * Comparison is numeric on major/minor/patch. Build metadata is ignored. A prerelease sorts
 * before its release, and prerelease identifiers compare with the usual numeric-before-text
 * rule. Ranges do not implement npm's special prerelease opt-in rule; this is a compatibility
 * check, not a package installer.
 */

/** A comparable version. Missing components are normalised to zero. */
export interface Version {
  major: number
  minor: number
  patch: number
  prerelease: readonly (string | number)[]
}

interface PartialVersion {
  /** `null` means the component was absent or written as a wildcard. */
  major: number | null
  minor: number | null
  patch: number | null
  prerelease: readonly (string | number)[]
  /** True when a component was written as `x`, `X` or `*`. */
  wildcard: boolean
}

type Operator = '>=' | '>' | '<=' | '<' | '=' | '^' | '~'

interface Comparator {
  /** `*` matches every version. */
  op: Operator | '*'
  version: PartialVersion
}

const PART = String.raw`(\d+|[xX*])`
const PARTIAL = new RegExp(
  String.raw`^v?${PART}(?:\.${PART})?(?:\.${PART})?(?:-([0-9A-Za-z.-]+))?(?:\+([0-9A-Za-z.-]+))?$`,
)

/** A numeric identifier beyond the safe-integer range cannot be compared exactly. */
function parseIdentifier(value: string): string | number | null {
  if (!/^\d+$/.test(value)) return value
  const number = Number(value)
  return Number.isSafeInteger(number) ? number : null
}

/**
 * Split a prerelease string into identifiers.
 *
 * An empty identifier (`-rc..1`) is malformed, not a version anvil may compare: npm rejects
 * it, and treating it as a valid tag would let a typo become a pass. Numeric identifiers
 * must be safe to compare, because a prerelease decides ordering.
 */
function parseIdentifiers(text: string): (string | number)[] | null {
  const parts = text.split('.')
  const out: (string | number)[] = []
  for (const part of parts) {
    if (part === '') return null
    const identifier = parseIdentifier(part)
    if (identifier === null) return null
    out.push(identifier)
  }
  return out
}

/**
 * Whether a build-metadata string is well-formed: no empty identifiers (`+.`).
 *
 * Build metadata is ignored during comparison, so unlike a prerelease it is not converted
 * to numbers and a long numeric identifier (`1.2.3+20261105094537688000`) is valid.
 */
function isWellFormedIdentifiers(text: string): boolean {
  return text.split('.').every((part) => part !== '')
}

function parsePartial(value: string): PartialVersion | null {
  const match = PARTIAL.exec(value.trim())
  if (match === null) return null

  const parts = [match[1], match[2], match[3]] as const
  const wildcard = parts.some((part) => part === 'x' || part === 'X' || part === '*')
  const numbers: (number | null)[] = []
  for (const part of parts) {
    if (part === undefined || part === 'x' || part === 'X' || part === '*') {
      numbers.push(null)
      continue
    }
    const value = Number(part)
    // A component beyond Number.MAX_SAFE_INTEGER cannot be compared exactly; rounding it
    // would let two different versions look equal. Treat it as unreadable instead.
    if (!Number.isSafeInteger(value)) return null
    numbers.push(value)
  }

  const prereleaseText = match[4]
  if (prereleaseText !== undefined && numbers.includes(null)) return null
  const prerelease = prereleaseText === undefined ? [] : parseIdentifiers(prereleaseText)
  if (prerelease === null) return null
  // Build metadata is ignored for comparison, but it still has to be well-formed.
  if (match[5] !== undefined && !isWellFormedIdentifiers(match[5])) return null

  return {
    major: numbers[0] ?? null,
    minor: numbers[1] ?? null,
    patch: numbers[2] ?? null,
    prerelease,
    wildcard,
  }
}

/**
 * Parse a concrete version. Missing minor/patch components are treated as zero; wildcards and
 * malformed input return `null`.
 */
export function parseVersion(value: string): Version | null {
  const partial = parsePartial(value)
  if (partial === null || partial.wildcard || partial.major === null) return null
  return normalise(partial)
}

function normalise(partial: PartialVersion): Version {
  return {
    major: partial.major ?? 0,
    minor: partial.minor ?? 0,
    patch: partial.patch ?? 0,
    prerelease: partial.prerelease,
  }
}

function compareIdentifier(a: string | number, b: string | number): number {
  if (typeof a === 'number' && typeof b === 'number') return a === b ? 0 : a < b ? -1 : 1
  // Numeric identifiers sort before alphanumeric ones.
  if (typeof a === 'number') return -1
  if (typeof b === 'number') return 1
  return a === b ? 0 : a < b ? -1 : 1
}

/** Compare two versions. Negative, zero or positive as `a` sorts before, with, or after `b`. */
export function compareVersions(a: Version, b: Version): number {
  for (const key of ['major', 'minor', 'patch'] as const) {
    if (a[key] !== b[key]) return a[key] < b[key] ? -1 : 1
  }
  // A release sorts after its prereleases.
  if (a.prerelease.length === 0 && b.prerelease.length === 0) return 0
  if (a.prerelease.length === 0) return 1
  if (b.prerelease.length === 0) return -1
  for (let i = 0; i < Math.max(a.prerelease.length, b.prerelease.length); i++) {
    const left = a.prerelease[i]
    const right = b.prerelease[i]
    if (left === undefined) return -1
    if (right === undefined) return 1
    const compared = compareIdentifier(left, right)
    if (compared !== 0) return compared
  }
  return 0
}

/** The first version after the line a partial names: `18` -> `19.0.0`, `18.2` -> `18.3.0`. */
function nextBoundary(partial: PartialVersion): Version {
  if (partial.major === null) return { major: 0, minor: 0, patch: 0, prerelease: [] }
  if (partial.minor === null) return { major: partial.major + 1, minor: 0, patch: 0, prerelease: [] }
  return { major: partial.major, minor: partial.minor + 1, patch: 0, prerelease: [] }
}

function caretUpper(partial: PartialVersion): Version {
  const major = partial.major ?? 0
  const minor = partial.minor ?? 0
  const patch = partial.patch ?? 0
  // A missing component is a wildcard, so the range covers that whole line.
  if (partial.minor === null) return { major: major + 1, minor: 0, patch: 0, prerelease: [] }
  if (partial.patch === null) {
    return major === 0
      ? { major: 0, minor: minor + 1, patch: 0, prerelease: [] }
      : { major: major + 1, minor: 0, patch: 0, prerelease: [] }
  }
  if (major > 0) return { major: major + 1, minor: 0, patch: 0, prerelease: [] }
  if (minor > 0) return { major: 0, minor: minor + 1, patch: 0, prerelease: [] }
  return { major: 0, minor: 0, patch: patch + 1, prerelease: [] }
}

function tildeUpper(partial: PartialVersion): Version {
  const major = partial.major ?? 0
  const minor = partial.minor ?? 0
  if (partial.minor === null) return { major: major + 1, minor: 0, patch: 0, prerelease: [] }
  return { major, minor: minor + 1, patch: 0, prerelease: [] }
}

function isPartial(partial: PartialVersion): boolean {
  return partial.major === null || partial.minor === null || partial.patch === null
}

function satisfiesComparator(version: Version, comparator: Comparator): boolean {
  if (comparator.op === '*') return true
  const lower = normalise(comparator.version)
  switch (comparator.op) {
    case '>=':
      return compareVersions(version, lower) >= 0
    case '>':
      // `>18.2` means "after the 18.2 line", not "after 18.2.0".
      return isPartial(comparator.version)
        ? compareVersions(version, nextBoundary(comparator.version)) >= 0
        : compareVersions(version, lower) > 0
    case '<':
      return compareVersions(version, lower) < 0
    case '<=':
      // `<=18.2` includes the whole 18.2 line.
      return isPartial(comparator.version)
        ? compareVersions(version, nextBoundary(comparator.version)) < 0
        : compareVersions(version, lower) <= 0
    case '=':
      return isPartial(comparator.version)
        ? compareVersions(version, lower) >= 0 && compareVersions(version, nextBoundary(comparator.version)) < 0
        : compareVersions(version, lower) === 0
    case '^':
      return compareVersions(version, lower) >= 0 && compareVersions(version, caretUpper(comparator.version)) < 0
    case '~':
      return compareVersions(version, lower) >= 0 && compareVersions(version, tildeUpper(comparator.version)) < 0
  }
}

function parseComparator(token: string): Comparator | null {
  const match = /^(>=|<=|>|<|=|\^|~)?(.+)$/.exec(token)
  if (match === null) return null
  const op = (match[1] ?? '=') as Operator
  const version = parsePartial(match[2] ?? '')
  if (version === null) return null
  if (version.major === null) {
    // A bare wildcard is "any version". `^x` and `>=x` are not ranges anvil can explain.
    if (op === '=') return { op: '*', version }
    return null
  }
  return { op, version }
}

function parseRange(range: string): Comparator[][] | null {
  const trimmed = range.trim()
  if (trimmed === '') return null
  // `>= 18` is the same requirement as `>=18`; join an operator to its version before
  // splitting on whitespace. Commas are an AND separator some owners write.
  const normalised = trimmed.replace(/(>=|<=|>|<|=|\^|~)\s+/g, '$1')
  const alternatives: Comparator[][] = []
  for (const alternative of normalised.split('||')) {
    const tokens = alternative
      .trim()
      .replace(/,/g, ' ')
      .split(/\s+/)
      .filter((t) => t !== '')
    if (tokens.length === 0) return null
    const comparators: Comparator[] = []
    for (const token of tokens) {
      const comparator = parseComparator(token)
      if (comparator === null) return null
      comparators.push(comparator)
    }
    alternatives.push(comparators)
  }
  return alternatives
}

/**
 * True when `range` is a range anvil understands. Used by config validation so an
 * unparseable requirement is a load error, never a silent "any version".
 */
export function isValidVersionRange(range: string): boolean {
  return parseRange(range) !== null
}

/**
 * True when `version` satisfies `range`.
 *
 * A malformed version or range returns `false`; callers that need to distinguish "does not
 * match" from "cannot compare" should parse first with {@link parseVersion}. Config loading
 * rejects malformed ranges, so a caller holding a validated declaration only sees the
 * version side fail.
 */
export function satisfiesVersionRange(version: string, range: string): boolean {
  const parsed = parseVersion(version)
  const alternatives = parseRange(range)
  if (parsed === null || alternatives === null) return false
  return alternatives.some((comparators) => comparators.every((c) => satisfiesComparator(parsed, c)))
}
