/**
 * Versioned verification evidence: a fact about a check that ran, not a claim about a commit.
 *
 * The original evidence file was a flat array of `{ command, revision, exitCode, timestamp }`
 * rows. Those rows carry a `-dirty` suffix that describes a worktree, not an immutable tree, so
 * two different dirty states of the same commit cannot be told apart. We keep reading them as
 * legacy history, but only a version 2 record with a clean commit and a bound check plan can be
 * described as *current* verification.
 *
 * This module is pure: no process spawning, no file access, and no clock. The CLI owns the I/O
 * and the dashboard owns its own bounded reader; the contract and the verdict live here so the
 * wording cannot drift between them.
 */

import { createHash } from 'node:crypto'

export const VERIFICATION_EVIDENCE_SCHEMA = 2
export const VERIFICATION_EVIDENCE_MAX_BYTES = 64 * 1024
export const VERIFICATION_EVIDENCE_MAX_RECORDS = 20

export type LegacyEvidenceRecord = {
  command: string
  revision: string | null
  exitCode: number | null
  timestamp: string
}

export type EvidenceCommand = {
  command: string
  /** Null is an honest "no exit was observed", never a zero. */
  exitCode: number | null
  exitObserved: boolean
  /** Repo-relative directory this command ran in. Present on records that bind a mixed plan. */
  dir?: string
}

export type CurrentEvidenceRecord = {
  schemaVersion: 2
  /** Claim key the check ran for; never inferred from a file name. */
  claim: string
  /** Stable key derived from the repository's Git metadata directory. */
  repository: string
  /** Commit the check ran against, or null when it could not be sampled. */
  commit: string | null
  /** True only when the worktree was clean before the first command started. */
  clean: boolean
  /** Repo-relative working directory shared by every command in the check plan. */
  cwd: string
  commands: EvidenceCommand[]
  /** Digest of cwd and the exact commands, so a changed plan cannot inherit a result. */
  planDigest: string
  startedAt: string
  completedAt: string
  outcome: 'passed' | 'failed'
}

export type EvidenceRecord = LegacyEvidenceRecord | CurrentEvidenceRecord
export type VerificationVerdict = 'current' | 'stale' | 'failed' | 'incomplete' | 'legacy'

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function validTimestamp(value: unknown): value is string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) return false
  try {
    return new Date(value).toISOString() === value
  } catch {
    return false
  }
}

function validHex(value: unknown, min: number, max: number): value is string {
  return typeof value === 'string' && new RegExp(`^[0-9a-f]{${min},${max}}$`, 'i').test(value)
}

function validBoundedText(value: unknown, max: number): value is string {
  return typeof value === 'string' && value.trim() !== '' && value.length <= max
}

/** Repo-relative, contained directories only; an absolute path or `..` cannot be a plan cwd. */
export function validCwd(value: unknown): value is string {
  if (typeof value !== 'string' || value.length > 240) return false
  if (value === '') return true
  if (/^[/\\]|^[A-Za-z]:/.test(value)) return false
  return value.split(/[/\\]/).every((part) => part !== '' && part !== '..' && part !== '.')
}

function validCommand(value: unknown): value is EvidenceCommand {
  if (!isRecord(value)) return false
  const exitValid =
    value.exitCode === null
      ? value.exitObserved === false
      : Number.isSafeInteger(value.exitCode) &&
        (value.exitCode as number) >= 0 &&
        (value.exitCode as number) <= 0x7fffffff
  return (
    validBoundedText(value.command, 200) &&
    exitValid &&
    typeof value.exitObserved === 'boolean' &&
    (value.dir === undefined || validCwd(value.dir))
  )
}

export function isCurrentEvidenceRecord(value: unknown): value is CurrentEvidenceRecord {
  if (!isRecord(value) || value.schemaVersion !== VERIFICATION_EVIDENCE_SCHEMA) return false
  return (
    validBoundedText(value.claim, 120) &&
    validHex(value.repository, 16, 16) &&
    (value.commit === null || validHex(value.commit, 7, 64)) &&
    typeof value.clean === 'boolean' &&
    validCwd(value.cwd) &&
    Array.isArray(value.commands) &&
    value.commands.length >= 1 &&
    value.commands.length <= 20 &&
    value.commands.every(validCommand) &&
    validHex(value.planDigest, 64, 64) &&
    validTimestamp(value.startedAt) &&
    validTimestamp(value.completedAt) &&
    (value.outcome === 'passed' || value.outcome === 'failed')
  )
}

export function isLegacyEvidenceRecord(value: unknown): value is LegacyEvidenceRecord {
  if (!isRecord(value) || 'schemaVersion' in value) return false
  return (
    validBoundedText(value.command, 200) &&
    (value.revision === null ||
      (typeof value.revision === 'string' && validHex(value.revision.replace(/-dirty$/i, ''), 7, 64))) &&
    Number.isSafeInteger(value.exitCode) &&
    (value.exitCode as number) >= 0 &&
    (value.exitCode as number) <= 0x7fffffff &&
    validTimestamp(value.timestamp)
  )
}

/** A digest over the exact commands and directory, so a changed plan is a different plan. */
export function planDigestFor(cwd: string, commands: readonly string[]): string {
  return createHash('sha256').update(JSON.stringify({ cwd, commands })).digest('hex')
}

/**
 * Digest for a plan whose commands can live in different directories.
 *
 * The single-`cwd` digest above cannot distinguish `npm test` in `ci` from the same command in
 * `packages/api`, so a mixed-directory plan needs the directory bound per command. The record
 * still carries a top-level `cwd` for older readers, but this digest is the identity the CLI
 * checks before shipping.
 */
export function planDigestForEntries(entries: readonly { cmd: string; dir: string }[]): string {
  return createHash('sha256')
    .update(JSON.stringify({ commands: entries.map((entry) => ({ cmd: entry.cmd, dir: entry.dir })) }))
    .digest('hex')
}

/**
 * Whether a record describes the given plan, ignoring the commit.
 *
 * Both the original single-directory digest and the per-directory digest are accepted, so
 * evidence written before mixed-directory plans were supported stays readable. A record that
 * names per-command directories must match every one of them, not just the first.
 */
export function evidencePlanMatches(record: EvidenceRecord, plan: readonly { cmd: string; dir: string }[]): boolean {
  if (!isCurrentEvidenceRecord(record)) return false
  const entries = plan.map((entry) => ({ cmd: entry.cmd, dir: entry.dir.replaceAll('\\', '/') }))
  const expectedCwd = entries[0]?.dir ?? ''
  const digests = new Set([
    planDigestForEntries(entries),
    planDigestFor(
      expectedCwd,
      entries.map((entry) => entry.cmd),
    ),
  ])
  if (!digests.has(record.planDigest)) return false
  if (!record.commands.some((command) => command.dir !== undefined)) return true
  return (
    record.commands.length === entries.length &&
    record.commands.every((command, index) => (command.dir ?? '') === entries[index]?.dir)
  )
}

/** A record satisfies the plan *and* is current for the independently sampled commit. */
export function evidenceMatchesPlan(
  record: EvidenceRecord,
  plan: readonly { cmd: string; dir: string }[],
  currentCommit: string | null,
): boolean {
  return evidencePlanMatches(record, plan) && verdictFor(record, currentCommit) === 'current'
}

/**
 * The verdict is a function of the record and the commit sampled independently by the CLI.
 *
 * Absence is never a pass: a record that cannot prove a clean tree, a known commit, an observed
 * exit and the same plan is stale. A legacy row can never be current, whatever its commit says.
 */
export function verdictFor(record: EvidenceRecord, currentCommit: string | null): VerificationVerdict {
  if (!isCurrentEvidenceRecord(record)) return 'legacy'
  if (record.commit === null || !record.clean) return 'stale'
  if (currentCommit === null || record.commit.toLowerCase() !== currentCommit.toLowerCase()) return 'stale'
  if (record.commands.some((command) => !command.exitObserved || command.exitCode === null)) return 'incomplete'
  const failed = record.outcome === 'failed' || record.commands.some((command) => command.exitCode !== 0)
  return failed ? 'failed' : 'current'
}

function byteLength(records: readonly EvidenceRecord[]): number {
  return Buffer.byteLength(`${JSON.stringify(records, null, 2)}\n`)
}

/**
 * Keep the bounded tail, prefer displayable records and real facts over rejected rows.
 *
 * Completion order wins over claim order: a record written later describes a later check. A
 * same-millisecond tie keeps the failure so a capped tail cannot hide the interesting outcome.
 */
export function selectVerificationRecords(all: readonly EvidenceRecord[]): EvidenceRecord[] {
  const displayable = (record: EvidenceRecord): boolean =>
    isCurrentEvidenceRecord(record) || isLegacyEvidenceRecord(record)
  const order = (record: EvidenceRecord): string =>
    isCurrentEvidenceRecord(record) ? record.completedAt : (record as LegacyEvidenceRecord).timestamp
  const isFailure = (record: EvidenceRecord): boolean => {
    if (isCurrentEvidenceRecord(record)) {
      return (
        record.outcome === 'failed' ||
        record.commands.some((command) => !command.exitObserved || command.exitCode === null || command.exitCode !== 0)
      )
    }
    const legacy = record as LegacyEvidenceRecord
    return legacy.exitCode !== null && legacy.exitCode !== 0
  }
  const ordered = [...all].sort((left, right) => {
    const a = order(left)
    const b = order(right)
    if (a !== b) return a < b ? -1 : 1
    return Number(isFailure(right)) - Number(isFailure(left))
  })
  const valid = ordered.filter(displayable)
  const incomplete = ordered.filter((record) => !displayable(record))
  const validKept = valid.slice(-VERIFICATION_EVIDENCE_MAX_RECORDS)
  const quota = VERIFICATION_EVIDENCE_MAX_RECORDS - validKept.length
  const incompleteKept = quota > 0 ? incomplete.slice(-quota) : []
  let records = [...validKept, ...incompleteKept].sort((left, right) => {
    const a = order(left)
    const b = order(right)
    return a < b ? -1 : a > b ? 1 : 0
  })
  while (byteLength(records) > VERIFICATION_EVIDENCE_MAX_BYTES && records.length > 0) {
    const rejected = records.findIndex((record) => !displayable(record))
    records = rejected >= 0 ? records.filter((_, index) => index !== rejected) : records.slice(1)
  }
  return records
}
