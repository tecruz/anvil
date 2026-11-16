/**
 * Apply one approved execution plan from a registered adapter, exactly once.
 *
 * Approval and application are separate authority. This module consumes the grant's single
 * attempt before its first repository mutation, writes the reviewed bytes with no-replace
 * semantics, records a journal beside the grant, and independently verifies the installed
 * artifact. A crash, a partial write or a failed verification is recorded and reported as
 * such; nothing is retried automatically and nothing is deleted.
 *
 * `local-skill/v1` keeps journal v1 and its shipped failure classification. Every other
 * adapter uses journal v2, which records the artifact as `subject` and marks each operation
 * `attempting` before its syscall, so an exception after a possible mutation is `partial`,
 * never `failed`.
 *
 * The digest is still not authority. Application revalidates the saved plan, the repository,
 * the source and the grant immediately before writing, but filesystem checks are not an
 * operating-system sandbox against another process changing paths concurrently.
 */
import { createHash, randomUUID } from 'node:crypto'
import {
  closeSync,
  constants,
  fstatSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { AnvilError, ErrorCode } from '@anvil/core'
import { canonicalJson, digestJson } from './canonical.ts'
import type { SetupRepositoryState } from './setup.ts'
import { findSetupAdapterById, resolveSetupPlan, type SetupPlanSubject } from './setup-adapters.ts'
import {
  consumeSetupApproval,
  gradeSetupApprovalGrant,
  inspectSetupApproval,
  inspectSetupApprovalTransition,
  readGrantRecord,
  readSetupApprovalGrant,
  readSetupApprovalTransition,
  replaceGrantRecord,
  type SetupApprovalGrant,
  type SetupApprovalStoreOptions,
  writeGrantRecordOnce,
} from './setup-approval.ts'
import {
  isSafeSetupExecutionPath,
  LOCAL_SKILL_ADAPTER,
  MAX_SOURCE_BYTES,
  SETUP_EXECUTION_PLAN_KIND,
  type SetupExecutionPlan,
} from './setup-execution.ts'
import { validateArtifact } from './validate.ts'

export const SETUP_APPLICATION_KIND = 'setup-application'
export const SETUP_APPLICATION_JOURNAL_KIND = 'setup-application-journal'
/** The journal lives beside the grant, inside the protected user-owned store. */
export const SETUP_APPLICATION_JOURNAL_FILE = 'application.json'

const DEFAULT_VERIFICATION_ID = 'local-skill-installed/v1'
const DEFAULT_VERIFICATION_PROVES =
  'Only that the reviewed SKILL.md bytes are present at the destination with valid skill metadata. It does not prove that an agent loaded, followed, trusted or successfully used the skill.'

/**
 * What the whole command reports. `applied` means the reviewed bytes are installed and the
 * independent verifier passed; `executed` means this call changed the repository, so a
 * re-read of an earlier success is `applied` with `executed: false` and `alreadyApplied: true`.
 */
export type SetupApplicationStatus = 'applied' | 'failed' | 'partial' | 'interrupted' | 'refused'

/** What the journal records. `started` without a later terminal record is `interrupted`. */
export type SetupApplicationJournalStatus = 'started' | 'succeeded' | 'failed' | 'partial'

export interface SetupApplyVerificationCheck {
  name: string
  ok: boolean
  detail: string
}

export interface SetupApplyVerification {
  /** The verifier that ran, for example `local-skill-installed/v1`. */
  id: string
  scope: 'artifact-installed'
  ok: boolean
  checks: SetupApplyVerificationCheck[]
  proves: string
}

export interface SetupApplicationOperationRecord {
  id: string
  kind: 'ensure-directory' | 'create-directory' | 'write-file'
  path: string
  /** Journal v2 marks an operation `attempting` before its syscall. */
  status: 'pending' | 'attempting' | 'done' | 'failed'
}

/** Journal v1: the shipped local-skill record. Kept readable forever. */
export interface SetupApplicationJournalV1 {
  schemaVersion: 1
  kind: typeof SETUP_APPLICATION_JOURNAL_KIND
  grantId: string
  planDigest: string
  adapter: typeof LOCAL_SKILL_ADAPTER
  adapterFingerprint: string
  repository: { root: string; head: string }
  skill: { name: string; destination: string }
  startedAt: string
  updatedAt: string
  status: SetupApplicationJournalStatus
  operations: SetupApplicationOperationRecord[]
  verification: SetupApplyVerification | null
  reason: string
}

/** Journal v2: any registered adapter; `subject` is the artifact the attempt targets. */
export interface SetupApplicationJournalV2 {
  schemaVersion: 2
  kind: typeof SETUP_APPLICATION_JOURNAL_KIND
  grantId: string
  planDigest: string
  adapter: string
  adapterFingerprint: string
  repository: { root: string; head: string }
  subject: { kind: 'skill'; id: string; destination: string }
  startedAt: string
  updatedAt: string
  status: SetupApplicationJournalStatus
  operations: SetupApplicationOperationRecord[]
  verification: SetupApplyVerification | null
  reason: string
}

export type SetupApplicationJournal = SetupApplicationJournalV1 | SetupApplicationJournalV2

export interface SetupApplicationRecord {
  schemaVersion: 1
  kind: typeof SETUP_APPLICATION_KIND
  status: SetupApplicationStatus
  /** True when this call mutated the repository. */
  executed: boolean
  /** True when the destination currently matches the approved bytes. */
  verified: boolean
  /** True when a previous application already succeeded and only re-verified. */
  alreadyApplied: boolean
  reason: string
  planDigest: string | null
  /** Present for journal v2 adapters; v1 local-skill records omit it. */
  adapter?: string
  /** The artifact this attempt targets. Present for journal v2 adapters. */
  subject?: SetupPlanSubject
  grant: SetupApprovalGrant | null
  repository: { root: string; head: string | null } | null
  destination: string | null
  journal: SetupApplicationJournal | null
  verification: SetupApplyVerification | null
}

export type SetupApplicationJournalRead =
  | { state: 'absent' }
  | { state: 'present'; journal: SetupApplicationJournal }
  | { state: 'unknown'; reason: string }

/** Injection points exist only so a test can drive each failure boundary deterministically. */
export interface SetupApplyHooks {
  /** Runs after the previous-attempt read and immediately before the preflight plan resolution. */
  beforeResolve?(): void
  /** Runs immediately before the preflight grant inspection. */
  beforeInspect?(): void
  /** Runs after revalidation and immediately before the first directory is created. */
  beforeWrite?(plan: SetupExecutionPlan): void
  /** Replace the create-only publish. */
  publish?(destination: string, bytes: Buffer): void
  /**
   * Runs inside the real create-only publisher, after the temporary file is written and
   * after the destination is linked. A test can stop the process at either step.
   */
  duringPublish?(step: 'temp-written' | 'linked'): void
  /** Replace the independent verifier. */
  verify?(target: InstalledLocalSkill): SetupApplyVerification
}

export interface SetupApplyFlow {
  saved: unknown
  repository: SetupRepositoryState
  grantId: string
  /** Serialize against every other writer in this repository. */
  lock<T>(fn: () => Promise<T>): Promise<T>
  /** Read the repository state again while holding the lock. */
  refresh(): Promise<SetupRepositoryState>
  env?: NodeJS.ProcessEnv
  now?: Date
  hooks?: SetupApplyHooks
}

const JOURNAL_KEYS = [
  'adapter',
  'adapterFingerprint',
  'grantId',
  'kind',
  'operations',
  'planDigest',
  'reason',
  'repository',
  'schemaVersion',
  'skill',
  'startedAt',
  'status',
  'updatedAt',
  'verification',
] as const
const JOURNAL_V2_KEYS = [
  'adapter',
  'adapterFingerprint',
  'grantId',
  'kind',
  'operations',
  'planDigest',
  'reason',
  'repository',
  'schemaVersion',
  'startedAt',
  'status',
  'subject',
  'updatedAt',
  'verification',
] as const
const OPERATION_KEYS = ['id', 'kind', 'path', 'status'] as const
const REPOSITORY_KEYS = ['head', 'root'] as const
const SKILL_KEYS = ['destination', 'name'] as const
const SUBJECT_KEYS = ['destination', 'id', 'kind'] as const
const VERIFICATION_KEYS = ['checks', 'id', 'ok', 'proves', 'scope'] as const
const CHECK_KEYS = ['detail', 'name', 'ok'] as const
const VERIFICATION_ID_PATTERN = /^[a-z][a-z0-9-]*\/v[0-9]+$/

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype
  )
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value)
  return actual.length === keys.length && keys.every((key) => Object.hasOwn(value, key))
}

function isIsoDate(value: unknown): value is string {
  return typeof value === 'string' && !Number.isNaN(Date.parse(value))
}

function digestBytes(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex')
}

function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause)
}

/** Resolve a path physically when it exists, and fall back to a lexical absolute path when not. */
function physicalPath(path: string): string {
  try {
    return realpathSync.native(path)
  } catch {
    return resolve(path)
  }
}

/**
 * A journal is evidence about one granted plan in one repository. Reporting a recorded outcome
 * must still prove that the caller asked for that plan and that repository: otherwise a second
 * command could present a different plan, or run in a different checkout, and be told the
 * installation succeeded there.
 */
function savedPlanBinding(
  saved: unknown,
  repository: SetupRepositoryState,
  grant: SetupApprovalGrant,
): { ok: true } | { ok: false; reason: string } {
  if (!isPlainObject(saved)) {
    return { ok: false, reason: 'The saved plan is not a setup-execution-plan JSON object.' }
  }
  if (saved.schemaVersion !== 1 || saved.kind !== SETUP_EXECUTION_PLAN_KIND || typeof saved.digest !== 'string') {
    return { ok: false, reason: 'The saved plan is not a supported setup execution plan.' }
  }
  const { digest: recorded, ...payload } = saved
  let computed: string
  try {
    computed = digestJson(payload)
  } catch {
    return { ok: false, reason: 'The saved plan cannot be canonicalized.' }
  }
  if (computed !== recorded) {
    return { ok: false, reason: 'The saved plan digest does not match its contents.' }
  }
  if (recorded !== grant.planDigest) {
    return { ok: false, reason: 'The saved plan is not the plan this grant approved.' }
  }
  if (saved.adapter !== grant.adapter || saved.adapterFingerprint !== grant.adapterFingerprint) {
    return { ok: false, reason: 'The saved plan names a different adapter or adapter behaviour.' }
  }
  if (physicalPath(repository.root) !== physicalPath(grant.repository.root)) {
    return { ok: false, reason: 'The grant was approved for a different repository.' }
  }
  const planRepository = saved.repository
  if (
    !isPlainObject(planRepository) ||
    planRepository.root !== grant.repository.root ||
    planRepository.head !== grant.repository.head
  ) {
    return { ok: false, reason: 'The saved plan names a different repository or commit than the grant.' }
  }
  if (grant.schemaVersion === 1) {
    const skill = saved.skill
    if (!isPlainObject(skill) || skill.name !== grant.skill.name || skill.destination !== grant.skill.destination) {
      return { ok: false, reason: 'The saved plan names a different skill destination.' }
    }
    const source = saved.source
    if (
      !isPlainObject(source) ||
      source.path !== grant.source.path ||
      source.sha256 !== grant.source.sha256 ||
      source.bytes !== grant.source.bytes
    ) {
      return { ok: false, reason: 'The saved plan names a different source file or source bytes.' }
    }
    return { ok: true }
  }

  // Grant v2 is adapter-agnostic: compare the adapter's canonical binding for this saved
  // plan with the approved bindings. A saved plan that cannot even produce bindings is not
  // the approved plan.
  const adapter = findSetupAdapterById(grant.adapter)
  if (adapter === null) return { ok: false, reason: 'The grant names an unregistered adapter.' }
  const approved = adapter.parseBindings(grant.bindings)
  if (approved === null) return { ok: false, reason: 'The grant bindings are malformed.' }
  let savedBindings: Record<string, unknown>
  try {
    savedBindings = adapter.bindings(saved as unknown as SetupExecutionPlan)
  } catch {
    return { ok: false, reason: 'The saved plan does not carry the approved binding fields.' }
  }
  if (canonicalJson(savedBindings) !== canonicalJson(approved)) {
    return { ok: false, reason: 'The saved plan does not match the plan this grant approved.' }
  }
  return { ok: true }
}

function parseVerification(value: unknown, expectedId: string | null): SetupApplyVerification | null {
  if (!isPlainObject(value) || !hasExactKeys(value, VERIFICATION_KEYS)) return null
  if (typeof value.id !== 'string' || !VERIFICATION_ID_PATTERN.test(value.id)) return null
  if (expectedId !== null && value.id !== expectedId) return null
  if (value.scope !== 'artifact-installed' || typeof value.ok !== 'boolean') return null
  if (typeof value.proves !== 'string' || !Array.isArray(value.checks)) return null
  const checks: SetupApplyVerificationCheck[] = []
  for (const check of value.checks) {
    if (!isPlainObject(check) || !hasExactKeys(check, CHECK_KEYS)) return null
    if (typeof check.name !== 'string' || typeof check.ok !== 'boolean' || typeof check.detail !== 'string') return null
    checks.push({ name: check.name, ok: check.ok, detail: check.detail })
  }
  return { id: value.id, scope: 'artifact-installed', ok: value.ok, checks, proves: value.proves }
}

const OPERATION_KINDS = ['ensure-directory', 'create-directory', 'write-file'] as const
const OPERATION_STATUSES = ['pending', 'attempting', 'done', 'failed'] as const

function parseOperations(value: unknown): SetupApplicationOperationRecord[] | null {
  if (!Array.isArray(value)) return null
  const operations: SetupApplicationOperationRecord[] = []
  for (const operation of value) {
    if (!isPlainObject(operation) || !hasExactKeys(operation, OPERATION_KEYS)) return null
    if (typeof operation.id !== 'string' || typeof operation.path !== 'string') return null
    if (!OPERATION_KINDS.includes(operation.kind as (typeof OPERATION_KINDS)[number])) return null
    if (!OPERATION_STATUSES.includes(operation.status as (typeof OPERATION_STATUSES)[number])) return null
    operations.push({
      id: operation.id,
      kind: operation.kind as SetupApplicationOperationRecord['kind'],
      path: operation.path,
      status: operation.status as SetupApplicationOperationRecord['status'],
    })
  }
  return operations
}

function parseJournalStatus(value: unknown): value is SetupApplicationJournalStatus {
  return typeof value === 'string' && ['started', 'succeeded', 'failed', 'partial'].includes(value)
}

function parseJournalCommon(value: Record<string, unknown>): {
  grantId: string
  planDigest: string
  adapterFingerprint: string
  repository: { root: string; head: string }
  startedAt: string
  updatedAt: string
  status: SetupApplicationJournalStatus
  operations: SetupApplicationOperationRecord[]
  verification: SetupApplyVerification | null
  reason: string
} | null {
  if (typeof value.grantId !== 'string' || value.grantId === '') return null
  if (typeof value.planDigest !== 'string' || !/^[a-f0-9]{64}$/.test(value.planDigest)) return null
  if (typeof value.adapterFingerprint !== 'string' || !/^[a-f0-9]{64}$/.test(value.adapterFingerprint)) return null
  if (!parseJournalStatus(value.status)) return null
  if (
    !isIsoDate(value.startedAt) ||
    !isIsoDate(value.updatedAt) ||
    Date.parse(value.updatedAt) < Date.parse(value.startedAt)
  ) {
    return null
  }
  if (!isPlainObject(value.repository) || !hasExactKeys(value.repository, REPOSITORY_KEYS)) return null
  if (
    typeof value.repository.root !== 'string' ||
    value.repository.root === '' ||
    typeof value.repository.head !== 'string' ||
    value.repository.head === ''
  ) {
    return null
  }
  const operations = parseOperations(value.operations)
  if (operations === null) return null
  if (typeof value.reason !== 'string') return null
  const verification = value.verification === null ? null : parseVerification(value.verification, null)
  if (value.verification !== null && verification === null) return null
  return {
    grantId: value.grantId,
    planDigest: value.planDigest,
    adapterFingerprint: value.adapterFingerprint,
    repository: { root: value.repository.root, head: value.repository.head },
    startedAt: value.startedAt,
    updatedAt: value.updatedAt,
    status: value.status,
    operations,
    verification,
    reason: value.reason,
  }
}

/** Parse an untrusted journal. Unknown fields, a bad status or a bad operation are rejections. */
function parseJournal(value: unknown): SetupApplicationJournal | null {
  if (!isPlainObject(value)) return null
  if (value.schemaVersion === 2) {
    if (!hasExactKeys(value, JOURNAL_V2_KEYS) || value.kind !== SETUP_APPLICATION_JOURNAL_KIND) return null
    if (typeof value.adapter !== 'string' || value.adapter === '') return null
    if (!isPlainObject(value.subject) || !hasExactKeys(value.subject, SUBJECT_KEYS)) return null
    if (
      value.subject.kind !== 'skill' ||
      typeof value.subject.id !== 'string' ||
      value.subject.id === '' ||
      typeof value.subject.destination !== 'string' ||
      value.subject.destination === ''
    ) {
      return null
    }
    const common = parseJournalCommon(value)
    if (common === null) return null
    return {
      schemaVersion: 2,
      kind: SETUP_APPLICATION_JOURNAL_KIND,
      adapter: value.adapter,
      subject: { kind: 'skill', id: value.subject.id, destination: value.subject.destination },
      ...common,
    }
  }
  if (!hasExactKeys(value, JOURNAL_KEYS)) return null
  if (value.schemaVersion !== 1 || value.kind !== SETUP_APPLICATION_JOURNAL_KIND) return null
  if (value.adapter !== LOCAL_SKILL_ADAPTER) return null
  const common = parseJournalCommon(value)
  if (common === null) return null
  if (common.verification !== null && common.verification.id !== DEFAULT_VERIFICATION_ID) return null
  if (!isPlainObject(value.skill) || !hasExactKeys(value.skill, SKILL_KEYS)) return null
  if (typeof value.skill.name !== 'string' || typeof value.skill.destination !== 'string') return null
  if (value.skill.destination !== `.agents/skills/${value.skill.name}/SKILL.md`) return null
  return {
    schemaVersion: 1,
    kind: SETUP_APPLICATION_JOURNAL_KIND,
    adapter: LOCAL_SKILL_ADAPTER,
    skill: { name: value.skill.name, destination: value.skill.destination },
    ...common,
  }
}

/** Read the journal belonging to a validated grant directory. */
export function readSetupApplicationJournal(dir: string): SetupApplicationJournalRead {
  const read = readGrantRecord(dir, SETUP_APPLICATION_JOURNAL_FILE)
  if (read.state === 'absent') return { state: 'absent' }
  if (read.state === 'unknown') return { state: 'unknown', reason: read.reason }
  const journal = parseJournal(read.value)
  if (journal === null) return { state: 'unknown', reason: 'The application journal is malformed.' }
  return { state: 'present', journal }
}

function missing(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | undefined)?.code
  return code === 'ENOENT' || code === 'ENOTDIR'
}

function resolvedRepositoryRoot(root: string): string {
  let resolved: string
  try {
    resolved = realpathSync.native(root)
  } catch (cause) {
    throw new AnvilError(ErrorCode.PreflightFailed, 'The repository root cannot be resolved.', { cause })
  }
  if (!lstatSync(resolved).isDirectory()) {
    throw new AnvilError(ErrorCode.PreflightFailed, 'The repository root is not a directory.')
  }
  return resolved
}

function assertInsideRepository(root: string, candidate: string): void {
  let resolved: string
  try {
    resolved = realpathSync.native(candidate)
  } catch (cause) {
    throw new AnvilError(ErrorCode.PreflightFailed, 'The destination cannot be resolved before writing.', { cause })
  }
  const rel = relative(root, resolved)
  if (rel === '' || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new AnvilError(ErrorCode.PreflightFailed, 'Refusing to write outside the repository.')
  }
}

/** Ensure one planned directory exists as a real directory; report whether this call created it. */
function ensureDirectory(root: string, rel: string): boolean {
  const path = join(root, ...rel.split('/'))
  let stat: ReturnType<typeof lstatSync>
  try {
    stat = lstatSync(path)
  } catch (cause) {
    if (!missing(cause)) {
      throw new AnvilError(ErrorCode.PreflightFailed, `The directory "${rel}" cannot be inspected.`, { cause })
    }
    try {
      mkdirSync(path)
      return true
    } catch (createCause) {
      if ((createCause as NodeJS.ErrnoException).code !== 'EEXIST') {
        throw new AnvilError(ErrorCode.PreflightFailed, `The directory "${rel}" could not be created.`, {
          cause: createCause,
        })
      }
      // A concurrent creator won; accept it only if it is a real directory.
      stat = lstatSync(path)
    }
  }
  if (stat.isSymbolicLink()) {
    throw new AnvilError(ErrorCode.PreflightFailed, `The destination path "${rel}" is a symbolic link or junction.`)
  }
  if (!stat.isDirectory()) {
    throw new AnvilError(ErrorCode.PreflightFailed, `The destination path "${rel}" is not a directory.`)
  }
  return false
}

/** Create the skill directory only if it is absent. Existing content is never replaced. */
function createSkillDirectory(root: string, rel: string): void {
  const path = join(root, ...rel.split('/'))
  try {
    mkdirSync(path)
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === 'EEXIST') {
      throw new AnvilError(ErrorCode.PreflightFailed, `The destination "${rel}" already exists.`, {
        hint: 'This adapter is create-only. Nothing was overwritten.',
      })
    }
    throw new AnvilError(ErrorCode.PreflightFailed, `The destination "${rel}" could not be created.`, { cause })
  }
}

/**
 * Write through a temporary file and publish without replacing anything.
 *
 * `link` is atomic and fails when the target exists. On a filesystem without hard links, an
 * exclusive create is the fallback. Either way an existing destination is refused, never
 * overwritten.
 */
function publishNoReplace(
  destination: string,
  bytes: Buffer,
  duringPublish?: (step: 'temp-written' | 'linked') => void,
): void {
  const target = dirname(destination)
  const temp = join(target, `.SKILL.md.${randomUUID()}.tmp`)
  try {
    writeFileSync(temp, bytes, { flag: 'wx' })
    duringPublish?.('temp-written')
    try {
      linkSync(temp, destination)
      duringPublish?.('linked')
      return
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code === 'EEXIST') {
        throw new AnvilError(ErrorCode.PreflightFailed, 'The destination appeared before it could be published.', {
          hint: 'Existing content was preserved.',
        })
      }
      try {
        writeFileSync(destination, bytes, { flag: 'wx' })
        duringPublish?.('linked')
        return
      } catch (fallback) {
        if ((fallback as NodeJS.ErrnoException).code === 'EEXIST') {
          throw new AnvilError(ErrorCode.PreflightFailed, 'The destination appeared before it could be published.', {
            hint: 'Existing content was preserved.',
          })
        }
        throw fallback
      }
    }
  } finally {
    try {
      rmSync(temp, { force: true })
    } catch {
      // A leftover temp file is inert; the destination is either published or absent.
    }
  }
}

/** The approved bytes, checked to encode back to the recorded hash before anything is written. */
function approvedBytes(plan: SetupExecutionPlan): Buffer {
  const bytes = Buffer.from(plan.source.content, 'utf8')
  if (bytes.length !== plan.source.bytes || digestBytes(bytes) !== plan.source.sha256) {
    throw new AnvilError(ErrorCode.Internal, 'The approved source does not encode to its recorded bytes.', {
      hint: 'Re-plan and re-approve; nothing was written.',
    })
  }
  return bytes
}

/**
 * The minimal identity of an installed artifact. The verifier reads these bytes back from
 * disk; it never trusts the writer's return value or the plan's preview.
 */
export interface InstalledLocalSkill {
  root: string
  /** Repository-relative destination with `/` separators, for example `.agents/skills/x/SKILL.md`. */
  destination: string
  sha256: string
  bytes: number
  /** The verifier id to record; defaults to the shipped `local-skill-installed/v1`. */
  id?: string
  /** The narrow claim to record; defaults to the local-skill claim. */
  proves?: string
}

/**
 * Independently verify an installed artifact by reading it back from disk.
 *
 * This checks only that the reviewed bytes are present at the destination as a regular file
 * with valid skill metadata. It deliberately makes no claim about whether an agent loaded,
 * followed, trusted or benefited from the skill.
 */
export function verifyInstalledLocalSkill(target: InstalledLocalSkill): SetupApplyVerification {
  const id = target.id ?? DEFAULT_VERIFICATION_ID
  const proves = target.proves ?? DEFAULT_VERIFICATION_PROVES
  const checks: SetupApplyVerificationCheck[] = []
  const finish = (): SetupApplyVerification => ({
    id,
    scope: 'artifact-installed',
    ok: checks.every((check) => check.ok),
    checks,
    proves,
  })
  const fail = (name: string, detail: string): SetupApplyVerification => {
    checks.push({ name, ok: false, detail })
    return finish()
  }

  let resolvedRoot: string
  try {
    resolvedRoot = realpathSync.native(target.root)
  } catch {
    return fail('destination-inside-repository', 'The repository root cannot be resolved.')
  }

  if (!isSafeSetupExecutionPath(target.destination)) {
    return fail('destination-inside-repository', 'The destination is not a safe repository-relative path.')
  }
  const segments = target.destination.split('/')
  if (segments.length < 2) {
    return fail('destination-inside-repository', 'The destination is not a file path inside a directory.')
  }
  let current = resolvedRoot
  for (const segment of segments.slice(0, -1)) {
    current = join(current, segment)
    let stat: ReturnType<typeof lstatSync>
    try {
      stat = lstatSync(current)
    } catch {
      return fail('destination-inside-repository', `The destination component "${segment}" is missing.`)
    }
    if (stat.isSymbolicLink()) {
      return fail('destination-inside-repository', `The destination component "${segment}" is a symbolic link.`)
    }
    if (!stat.isDirectory()) {
      return fail('destination-inside-repository', `The destination component "${segment}" is not a directory.`)
    }
  }
  const rel = relative(resolvedRoot, current)
  if (rel === '' || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    return fail('destination-inside-repository', 'The destination resolves outside the repository.')
  }
  checks.push({
    name: 'destination-inside-repository',
    ok: true,
    detail: `${rel.split(sep).join('/')} is inside the repository.`,
  })

  const destination = join(current, segments.at(-1) as string)
  let stat: ReturnType<typeof lstatSync>
  try {
    stat = lstatSync(destination)
  } catch {
    return fail('destination-regular-file', 'The destination does not exist.')
  }
  if (stat.isSymbolicLink()) {
    return fail('destination-regular-file', 'The destination is a symbolic link or junction.')
  }
  if (!stat.isFile()) {
    return fail('destination-regular-file', 'The destination is not a regular file.')
  }
  checks.push({ name: 'destination-regular-file', ok: true, detail: 'The destination is a regular file.' })

  let bytes: Buffer
  try {
    const fd = openSync(destination, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
    try {
      const opened = fstatSync(fd)
      if (!opened.isFile()) return fail('installed-bytes-match-source-sha256', 'The destination is not a regular file.')
      const buffer = Buffer.alloc(MAX_SOURCE_BYTES + 1)
      let length = 0
      while (length < buffer.length) {
        const count = readSync(fd, buffer, length, buffer.length - length, null)
        if (count === 0) break
        length += count
      }
      if (length > MAX_SOURCE_BYTES) {
        return fail('installed-bytes-match-source-sha256', 'The installed file is larger than the approved bound.')
      }
      bytes = buffer.subarray(0, length)
    } finally {
      closeSync(fd)
    }
  } catch (cause) {
    return fail('installed-bytes-match-source-sha256', `The installed bytes cannot be read: ${errorMessage(cause)}`)
  }
  const digest = digestBytes(bytes)
  if (digest !== target.sha256 || bytes.length !== target.bytes) {
    return fail(
      'installed-bytes-match-source-sha256',
      `The installed bytes (${bytes.length} bytes, sha256 ${digest}) do not match the approved source.`,
    )
  }
  checks.push({
    name: 'installed-bytes-match-source-sha256',
    ok: true,
    detail: `${bytes.length} bytes match sha256 ${digest}.`,
  })

  let content: string
  try {
    content = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes)
  } catch {
    return fail('skill-metadata-valid', 'The installed bytes are not valid UTF-8.')
  }
  const validation = validateArtifact(target.destination, content)
  if (!validation.ok) {
    return fail('skill-metadata-valid', `The installed skill metadata is invalid: ${validation.errors.join('; ')}`)
  }
  checks.push({ name: 'skill-metadata-valid', ok: true, detail: 'The installed skill metadata is valid.' })
  return finish()
}

/** Verify one plan's installed artifact against the approved source hash and size. */
export function verifyLocalSkillInstall(
  plan: SetupExecutionPlan,
  root: string = plan.repository.root,
): SetupApplyVerification {
  return verifyInstalledLocalSkill({
    root,
    destination: plan.skill.destination,
    sha256: plan.source.sha256,
    bytes: plan.source.bytes,
    id: plan.verification.id,
    proves: plan.verification.proves,
  })
}

function journalAdapter(journal: SetupApplicationJournal): string {
  return journal.schemaVersion === 1 ? LOCAL_SKILL_ADAPTER : journal.adapter
}

function journalSubject(journal: SetupApplicationJournal): SetupPlanSubject {
  return journal.schemaVersion === 1
    ? { kind: 'skill', id: journal.skill.name, destination: journal.skill.destination }
    : journal.subject
}

/** The approved artifact a grant names, without rebuilding a create-only plan. */
function grantArtifact(grant: SetupApprovalGrant): {
  kind: 'skill'
  id: string
  destination: string
  sha256: string
  bytes: number
} | null {
  if (grant.schemaVersion === 1) {
    return {
      kind: 'skill',
      id: grant.skill.name,
      destination: grant.skill.destination,
      sha256: grant.source.sha256,
      bytes: grant.source.bytes,
    }
  }
  const adapter = findSetupAdapterById(grant.adapter)
  if (adapter === null) return null
  const bindings = adapter.parseBindings(grant.bindings)
  if (bindings === null) return null
  return adapter.approvedArtifact(bindings)
}

function planSubject(plan: SetupExecutionPlan): SetupPlanSubject {
  const adapter = findSetupAdapterById(plan.adapter)
  return adapter === null
    ? { kind: 'skill', id: plan.skill.name, destination: plan.skill.destination }
    : adapter.subject(plan)
}

function applicationRecord(options: {
  status: SetupApplicationStatus
  executed: boolean
  alreadyApplied?: boolean
  reason: string
  plan?: SetupExecutionPlan | null
  planDigest?: string | null
  grant?: SetupApprovalGrant | null
  journal?: SetupApplicationJournal | null
  verification?: SetupApplyVerification | null
}): SetupApplicationRecord {
  const { plan, grant } = options
  const artifact = grant === null || grant === undefined ? null : grantArtifact(grant)
  const destination = plan?.skill.destination ?? artifact?.destination ?? null
  const v2 = plan !== undefined && plan !== null ? plan.adapter !== LOCAL_SKILL_ADAPTER : grant?.schemaVersion === 2
  const record: SetupApplicationRecord = {
    schemaVersion: 1,
    kind: SETUP_APPLICATION_KIND,
    status: options.status,
    executed: options.executed,
    verified: options.verification?.ok === true,
    alreadyApplied: options.alreadyApplied ?? false,
    reason: options.reason,
    planDigest: options.planDigest ?? plan?.digest ?? null,
    grant: grant ?? null,
    repository:
      plan !== null && plan !== undefined
        ? { root: plan.repository.root, head: plan.repository.head }
        : grant !== null && grant !== undefined
          ? { root: grant.repository.root, head: grant.repository.head }
          : null,
    destination,
    journal: options.journal ?? null,
    verification: options.verification ?? null,
  }
  if (v2) {
    const adapter = plan?.adapter ?? (grant?.schemaVersion === 2 ? grant.adapter : undefined)
    if (adapter !== undefined) record.adapter = adapter
    const subject =
      plan !== null && plan !== undefined
        ? planSubject(plan)
        : artifact === null
          ? undefined
          : { kind: 'skill' as const, id: artifact.id, destination: artifact.destination }
    if (subject !== undefined) record.subject = subject
  }
  return record
}

function refusal(
  reason: string,
  plan: SetupExecutionPlan | null,
  grant: SetupApprovalGrant | null,
  journal: SetupApplicationJournal | null = null,
): SetupApplicationRecord {
  return applicationRecord({ status: 'refused', executed: false, reason, plan, grant, journal })
}

/**
 * Report a previous attempt. The journal and grant are enough: the current source or HEAD
 * may have moved since, and a terminal outcome must stay reportable rather than becoming a
 * stale-plan refusal.
 */
function settleExistingAttempt(
  read: SetupApplicationJournalRead,
  grant: SetupApprovalGrant,
  flow: SetupApplyFlow,
): SetupApplicationRecord {
  if (read.state === 'unknown') {
    return applicationRecord({
      status: 'interrupted',
      executed: false,
      reason: `The application journal cannot be trusted: ${read.reason}`,
      grant,
    })
  }
  if (read.state === 'absent') {
    return applicationRecord({
      status: 'interrupted',
      executed: false,
      reason: 'The application journal is absent.',
      grant,
    })
  }
  const journal = read.journal
  const artifact = grantArtifact(grant)
  const belongs =
    artifact !== null &&
    journal.grantId === grant.id &&
    journal.planDigest === grant.planDigest &&
    journal.adapterFingerprint === grant.adapterFingerprint &&
    journal.repository.root === grant.repository.root &&
    journal.repository.head === grant.repository.head &&
    journalAdapter(journal) === grant.adapter &&
    journalSubject(journal).destination === artifact.destination
  if (!belongs) {
    return applicationRecord({
      status: 'interrupted',
      executed: false,
      reason: 'The application journal belongs to a different grant, plan or repository.',
      grant,
      journal,
    })
  }

  if (journal.status === 'started') {
    return applicationRecord({
      status: 'interrupted',
      executed: false,
      reason:
        'A previous application attempt started but never recorded an outcome. No automatic retry is allowed; inspect the destination before issuing a fresh approval.',
      grant,
      journal,
    })
  }

  if (journal.status === 'succeeded') {
    const verify = flow.hooks?.verify ?? verifyInstalledLocalSkill
    const recorded = journal.verification
    let verification: SetupApplyVerification | null = null
    try {
      verification = verify({
        root: grant.repository.root,
        destination: artifact.destination,
        sha256: artifact.sha256,
        bytes: artifact.bytes,
        ...(recorded === null ? {} : { id: recorded.id, proves: recorded.proves }),
      })
    } catch {
      verification = null
    }
    if (verification?.ok === true) {
      return applicationRecord({
        status: 'applied',
        executed: false,
        alreadyApplied: true,
        reason:
          'This grant was already applied and the installed bytes still verify. Nothing was written again; the single attempt stays used.',
        planDigest: journal.planDigest,
        grant,
        journal,
        verification,
      })
    }
    return applicationRecord({
      status: 'partial',
      executed: false,
      reason:
        'This grant was already applied, but the installed bytes no longer verify against the approved source. Nothing was written again.',
      planDigest: journal.planDigest,
      grant,
      journal,
      verification,
    })
  }

  return applicationRecord({
    status: journal.status === 'partial' ? 'partial' : 'failed',
    executed: false,
    reason: journal.reason,
    planDigest: journal.planDigest,
    grant,
    journal,
    verification: journal.verification,
  })
}

/**
 * Re-read authority and the journal while holding the repository lock.
 *
 * A `started` journal, an unreadable journal, a reservation whose journal has not been
 * published yet, and a reservation record caught in its own publication window are all
 * waited out under the lock. The grant and store are read again here rather than reused from
 * before the wait, so authority that disappeared while this caller waited cannot settle the
 * outcome.
 */
const MISSING_RESERVED_JOURNAL_REASON =
  'The single application attempt was already reserved, but no application journal exists. Treat the outcome as unknown; no retry is allowed without fresh approval.'
const MISSING_UNREADABLE_JOURNAL_REASON =
  'The application journal was unreadable and is now absent. Treat the outcome as unknown; no retry is allowed without fresh approval.'

interface SettleOptions {
  /** Reported when the attempt was reserved but its journal is missing. */
  missingReason?: string
  /**
   * Reported when, under the lock, no reservation won the grant. A caller that waited
   * because of an ambiguous read passes its original refusal here.
   */
  noAttemptReason?: string
}

async function settleUnderLock(
  flow: SetupApplyFlow,
  storeOptions: SetupApprovalStoreOptions,
  plan: SetupExecutionPlan | null,
  grant: SetupApprovalGrant,
  options: SettleOptions = {},
): Promise<SetupApplicationRecord> {
  return flow.lock(async () => {
    const lockedRead = readSetupApprovalGrant(flow.grantId, storeOptions)
    if (!lockedRead.ok) return refusal(lockedRead.reason, plan, grant)
    const binding = savedPlanBinding(flow.saved, flow.repository, lockedRead.grant)
    if (!binding.ok) return refusal(binding.reason, plan, lockedRead.grant)
    const after = readSetupApplicationJournal(lockedRead.dir)
    if (after.state !== 'absent') return settleExistingAttempt(after, lockedRead.grant, flow)
    const transition = inspectSetupApprovalTransition(lockedRead.dir)
    // A live writer holds the repository lock for the whole consume-and-journal sequence, so
    // a record still unreadable once this caller holds the lock is corrupt, not in flight.
    if (transition.state === 'unknown') {
      return refusal(transition.reason ?? 'The grant state record cannot be inspected.', plan, lockedRead.grant)
    }
    if (transition.state === 'revoked') return refusal('The grant was revoked.', plan, lockedRead.grant)
    if (transition.state === 'none' && options.noAttemptReason !== undefined) {
      // No application won this grant: the caller's original refusal is the accurate report.
      return refusal(options.noAttemptReason, plan, lockedRead.grant)
    }
    return applicationRecord({
      status: 'interrupted',
      executed: false,
      reason: options.missingReason ?? MISSING_RESERVED_JOURNAL_REASON,
      plan,
      grant: lockedRead.grant,
    })
  })
}

/**
 * True when this grant may already own an application attempt: a journal exists, or the
 * terminal-state record was consumed or is briefly unreadable. A reservation is published
 * with a hard link, so its record can be multiply-linked for a moment; that is a possible
 * attempt, not a reason to refuse. Used only to decide whether a failed preflight must wait
 * for the repository lock before it is reported as a refusal.
 */
function hasApplicationAttempt(dir: string): boolean {
  if (readSetupApplicationJournal(dir).state !== 'absent') return true
  const transition = readSetupApprovalTransition(dir)
  return transition === 'consumed' || transition === 'unknown'
}

/**
 * Apply one current plan with an active grant.
 *
 * The grant is consumed after a second revalidation inside the repository lock and before
 * the first mutation. Every outcome after that is journaled; a second call re-reads the
 * journal instead of writing again.
 */
export async function applySetupPlan(flow: SetupApplyFlow): Promise<SetupApplicationRecord> {
  const storeOptions: SetupApprovalStoreOptions = flow.env === undefined ? {} : { env: flow.env }
  // A fixed clock is for deterministic tests. In a real run, consume and inspect read the
  // current time when they run, so a long lock wait cannot outlive a grant unnoticed.
  const nowOption: SetupApprovalStoreOptions = flow.now === undefined ? {} : { now: flow.now }

  const read = readSetupApprovalGrant(flow.grantId, storeOptions)
  if (!read.ok) return refusal(read.reason, null, null)
  const { grant, dir } = read

  // The requested plan and repository must be the ones this grant names, even when the
  // result being reported is a previous attempt rather than a new write.
  const binding = savedPlanBinding(flow.saved, flow.repository, grant)
  if (!binding.ok) return refusal(binding.reason, null, grant)

  // A previous attempt is final. Report it before resolving the saved plan, so a repository
  // or source that moved afterwards cannot turn a recorded outcome into a stale-plan refusal.
  const existing = readSetupApplicationJournal(dir)
  if (existing.state === 'unknown') {
    // A journal is briefly unreadable while a live writer publishes or replaces it: the
    // protected reader refuses a multiply-linked file, and hard-link publication has a
    // two-link window. Wait for the repository lock and re-read before calling it unknown.
    return settleUnderLock(flow, storeOptions, null, grant, { missingReason: MISSING_UNREADABLE_JOURNAL_REASON })
  }
  if (existing.state === 'present' && existing.journal.status === 'started') {
    // A live writer holds the repository lock while its journal is `started`. Wait for it,
    // re-read the authority and the journal, and only then settle the recorded outcome.
    return settleUnderLock(flow, storeOptions, null, grant)
  }
  if (existing.state === 'present') {
    return settleExistingAttempt(existing, grant, flow)
  }

  // Refuse a stale, tampered or unsafe plan without waiting for the lock and without
  // touching the grant. A refusal here leaves the single attempt unused.
  flow.hooks?.beforeResolve?.()
  const first = resolveSetupPlan(flow.saved, flow.repository, storeOptions)
  if (first.validation.status !== 'current' || first.plan === null) {
    // A concurrent application can make this same saved plan look stale: it writes the
    // destination and its journal before releasing the lock. Re-read the journal and the
    // reservation before turning that race into a refusal, and settle a real attempt under
    // the lock instead of reporting "already exists" while its writer is still finishing.
    if (hasApplicationAttempt(dir)) {
      return settleUnderLock(flow, storeOptions, first.plan, grant, { noAttemptReason: first.validation.reason })
    }
    return refusal(first.validation.reason, first.plan, grant)
  }
  const firstPlan = first.plan
  const verdict = gradeSetupApprovalGrant(grant, firstPlan)
  if (!verdict.ok) return refusal(verdict.reason, firstPlan, grant)

  flow.hooks?.beforeInspect?.()
  const inspection = inspectSetupApproval(flow.grantId, flow.repository, { ...storeOptions, ...nowOption })
  if (inspection.status === 'consumed') {
    // The journal may not be published yet: the winning writer still holds the lock while it
    // consumes and starts its journal. Wait, re-read authority and the journal, and only then
    // decide that nothing recorded an outcome.
    return settleUnderLock(flow, storeOptions, firstPlan, grant)
  }
  if (inspection.status !== 'active') {
    // A concurrent writer can consume and publish between the preflight resolution and this
    // inspection, leaving the grant not-yet-consumed at the transition read but the
    // destination present when the plan is rebuilt. Re-check the attempt before refusing.
    if (hasApplicationAttempt(dir)) {
      return settleUnderLock(flow, storeOptions, firstPlan, grant, { noAttemptReason: inspection.reason })
    }
    return refusal(inspection.reason, firstPlan, grant)
  }

  return flow.lock(async () => {
    // A caller that waited for the lock may have lost the race: re-read the journal first,
    // because the attempt may already be complete (and the destination now exists, which a
    // fresh plan build would otherwise report as stale).
    const lockedRead = readSetupApprovalGrant(flow.grantId, storeOptions)
    if (!lockedRead.ok) return refusal(lockedRead.reason, firstPlan, grant)
    const after = readSetupApplicationJournal(lockedRead.dir)
    if (after.state !== 'absent') return settleExistingAttempt(after, lockedRead.grant, flow)

    // The repository may have moved while this process waited for the lock.
    const fresh = await flow.refresh()
    const second = resolveSetupPlan(flow.saved, fresh, storeOptions)
    if (second.validation.status !== 'current' || second.plan === null) {
      return refusal(second.validation.reason, second.plan, grant)
    }
    const plan = second.plan

    const consumption = consumeSetupApproval(flow.grantId, fresh, { ...storeOptions, ...nowOption })
    if (!consumption.reserved) {
      const latest = readSetupApplicationJournal(lockedRead.dir)
      if (latest.state !== 'absent') return settleExistingAttempt(latest, grant, flow)
      if (consumption.record.status === 'consumed') {
        return applicationRecord({
          status: 'interrupted',
          executed: false,
          reason:
            'The single application attempt was already reserved, but no application journal exists. Treat the outcome as unknown; no retry is allowed without fresh approval.',
          plan,
          grant,
        })
      }
      return refusal(consumption.record.reason, plan, consumption.record.grant)
    }

    return runApplication(plan, grant, dir, flow, flow.now ?? new Date())
  })
}

function runApplication(
  plan: SetupExecutionPlan,
  grant: SetupApprovalGrant,
  dir: string,
  flow: SetupApplyFlow,
  now: Date,
): SetupApplicationRecord {
  // `local-skill/v1` keeps journal v1 and its shipped failure classification, so saved
  // journals and existing behaviour are unchanged. Every other adapter uses journal v2.
  if (plan.adapter === LOCAL_SKILL_ADAPTER) return runLocalApplication(plan, grant, dir, flow, now)
  return runRegisteredApplication(plan, grant, dir, flow, now)
}

function runLocalApplication(
  plan: SetupExecutionPlan,
  grant: SetupApprovalGrant,
  dir: string,
  flow: SetupApplyFlow,
  now: Date,
): SetupApplicationRecord {
  const startedAt = now.toISOString()
  let journal: SetupApplicationJournal = {
    schemaVersion: 1,
    kind: SETUP_APPLICATION_JOURNAL_KIND,
    grantId: grant.id,
    planDigest: plan.digest,
    adapter: LOCAL_SKILL_ADAPTER,
    adapterFingerprint: plan.adapterFingerprint,
    repository: { root: grant.repository.root, head: grant.repository.head },
    skill: { name: plan.skill.name, destination: plan.skill.destination },
    startedAt,
    updatedAt: startedAt,
    status: 'started',
    operations: plan.operations.map((operation) => ({
      id: operation.id,
      kind: operation.kind,
      path: operation.path,
      status: 'pending',
    })),
    verification: null,
    reason: "The grant's single attempt is reserved and application has started.",
  }

  try {
    const written = writeGrantRecordOnce(dir, SETUP_APPLICATION_JOURNAL_FILE, journal)
    if (written !== 'written') {
      return applicationRecord({
        status: 'failed',
        executed: false,
        reason:
          'An application journal already exists, so this attempt was not started. No automatic retry is allowed.',
        plan,
        grant,
        journal,
      })
    }
  } catch (cause) {
    // The attempt is already reserved. Stop before the first mutation rather than write
    // without evidence.
    return applicationRecord({
      status: 'failed',
      executed: false,
      reason: `The application journal could not be written, so nothing was changed: ${errorMessage(cause)}`,
      plan,
      grant,
      journal,
    })
  }

  let mutated = false
  let currentOperation: string | null = null

  const update = (
    status: SetupApplicationJournalStatus,
    reason: string,
    verification: SetupApplyVerification | null = null,
  ): void => {
    journal = { ...journal, status, reason, verification, updatedAt: now.toISOString() }
    replaceGrantRecord(dir, SETUP_APPLICATION_JOURNAL_FILE, journal)
  }
  const mark = (id: string | null, status: 'done' | 'failed'): void => {
    if (id === null) return
    journal = {
      ...journal,
      operations: journal.operations.map((operation) => (operation.id === id ? { ...operation, status } : operation)),
    }
  }

  try {
    const root = resolvedRepositoryRoot(plan.repository.root)
    flow.hooks?.beforeWrite?.(plan)

    for (const operation of plan.operations) {
      if (operation.kind === 'write-file') break
      currentOperation = operation.id
      if (operation.kind === 'ensure-directory') {
        if (ensureDirectory(root, operation.path)) mutated = true
      } else {
        createSkillDirectory(root, operation.path)
        mutated = true
      }
      mark(operation.id, 'done')
      currentOperation = null
      update('started', 'Directory operations are in progress.')
    }

    const destination = join(root, ...plan.skill.destination.split('/'))
    assertInsideRepository(root, dirname(destination))
    const publish =
      flow.hooks?.publish ??
      ((target: string, bytes: Buffer) => publishNoReplace(target, bytes, flow.hooks?.duringPublish))
    currentOperation = plan.operations.find((operation) => operation.kind === 'write-file')?.id ?? null
    publish(destination, approvedBytes(plan))
    mutated = true
    mark(currentOperation, 'done')
    currentOperation = null
    update('started', 'The reviewed bytes are installed; verification is pending.')

    const verify = flow.hooks?.verify ?? verifyInstalledLocalSkill
    const verification = verify({
      root,
      destination: plan.skill.destination,
      sha256: plan.source.sha256,
      bytes: plan.source.bytes,
    })
    if (verification.ok) {
      const reason =
        'The reviewed bytes were installed and independently verified at the destination. This proves the artifact is present, not that an agent used it.'
      update('succeeded', reason, verification)
      return applicationRecord({
        status: 'applied',
        executed: true,
        reason,
        plan,
        grant,
        journal,
        verification,
      })
    }
    const reason =
      'The destination was written but independent verification failed, so this is not a completed integration.'
    update('partial', reason, verification)
    return applicationRecord({
      status: 'partial',
      executed: true,
      reason,
      plan,
      grant,
      journal,
      verification,
    })
  } catch (cause) {
    mark(currentOperation, 'failed')
    const status: SetupApplicationJournalStatus = mutated ? 'partial' : 'failed'
    const reason = mutated
      ? `Application failed after a partial write; the repository was not rolled back: ${errorMessage(cause)}`
      : `Application failed before any repository write: ${errorMessage(cause)}`
    try {
      update(status, reason)
    } catch {
      // The journal could not record the terminal state; the attempt stays `started`, which
      // a later read reports as interrupted rather than as success.
    }
    return applicationRecord({
      status: status === 'partial' ? 'partial' : 'failed',
      executed: mutated,
      reason,
      plan,
      grant,
      journal,
      verification: null,
    })
  }
}

/**
 * Apply any registered non-local adapter with journal v2.
 *
 * Before every mutating syscall the operation is persisted as `attempting`. An exception after
 * that point may have changed the repository, so the outcome floor is `partial`; `failed` is
 * reserved for a failure with evidence that nothing was mutated (for example, the attempt
 * journal could not be written, or the very first syscall failed before any effect).
 */
function runRegisteredApplication(
  plan: SetupExecutionPlan,
  grant: SetupApprovalGrant,
  dir: string,
  flow: SetupApplyFlow,
  now: Date,
): SetupApplicationRecord {
  const artifact = grantArtifact(grant)
  const adapter = findSetupAdapterById(plan.adapter)
  if (artifact === null || adapter === null) {
    return applicationRecord({
      status: 'failed',
      executed: false,
      reason: 'The grant does not name a usable artifact for this adapter, so nothing was written.',
      plan,
      grant,
    })
  }
  const startedAt = now.toISOString()
  let journal: SetupApplicationJournalV2 = {
    schemaVersion: 2,
    kind: SETUP_APPLICATION_JOURNAL_KIND,
    grantId: grant.id,
    planDigest: plan.digest,
    adapter: plan.adapter,
    adapterFingerprint: plan.adapterFingerprint,
    repository: { root: grant.repository.root, head: grant.repository.head },
    subject: adapter.subject(plan),
    startedAt,
    updatedAt: startedAt,
    status: 'started',
    operations: plan.operations.map((operation) => ({
      id: operation.id,
      kind: operation.kind,
      path: operation.path,
      status: 'pending',
    })),
    verification: null,
    reason: "The grant's single attempt is reserved and application has started.",
  }

  try {
    const written = writeGrantRecordOnce(dir, SETUP_APPLICATION_JOURNAL_FILE, journal)
    if (written !== 'written') {
      return applicationRecord({
        status: 'failed',
        executed: false,
        reason:
          'An application journal already exists, so this attempt was not started. No automatic retry is allowed.',
        plan,
        grant,
        journal,
      })
    }
  } catch (cause) {
    return applicationRecord({
      status: 'failed',
      executed: false,
      reason: `The application journal could not be written, so nothing was changed: ${errorMessage(cause)}`,
      plan,
      grant,
      journal,
    })
  }

  let mutated = false
  let uncertain = false
  let currentOperation: string | null = null

  const setOperation = (id: string, status: SetupApplicationOperationRecord['status']): void => {
    journal = {
      ...journal,
      operations: journal.operations.map((operation) => (operation.id === id ? { ...operation, status } : operation)),
    }
  }
  const persist = (
    status: SetupApplicationJournalStatus,
    reason: string,
    verification: SetupApplyVerification | null = null,
  ): void => {
    journal = { ...journal, status, reason, verification, updatedAt: now.toISOString() }
    replaceGrantRecord(dir, SETUP_APPLICATION_JOURNAL_FILE, journal)
  }
  /**
   * Persist `attempting` before the syscall. Only after that record lands is the outcome
   * uncertain; a failure to write the marker stops before anything is mutated.
   */
  const beginOperation = (id: string): void => {
    currentOperation = id
    setOperation(id, 'attempting')
    journal = { ...journal, updatedAt: now.toISOString() }
    replaceGrantRecord(dir, SETUP_APPLICATION_JOURNAL_FILE, journal)
    uncertain = true
  }

  try {
    const root = resolvedRepositoryRoot(plan.repository.root)
    flow.hooks?.beforeWrite?.(plan)

    for (const operation of plan.operations) {
      if (operation.kind === 'write-file') break
      beginOperation(operation.id)
      if (operation.kind === 'ensure-directory') {
        if (ensureDirectory(root, operation.path)) mutated = true
      } else {
        createSkillDirectory(root, operation.path)
        mutated = true
      }
      setOperation(operation.id, 'done')
      currentOperation = null
      persist('started', 'Directory operations are in progress.')
    }

    const destination = join(root, ...artifact.destination.split('/'))
    assertInsideRepository(root, dirname(destination))
    const publish =
      flow.hooks?.publish ??
      ((target: string, bytes: Buffer) => publishNoReplace(target, bytes, flow.hooks?.duringPublish))
    const writeOperation = plan.operations.find((operation) => operation.kind === 'write-file')
    if (writeOperation !== undefined) beginOperation(writeOperation.id)
    publish(destination, approvedBytes(plan))
    mutated = true
    if (writeOperation !== undefined) setOperation(writeOperation.id, 'done')
    currentOperation = null
    persist('started', 'The reviewed bytes are installed; verification is pending.')

    const verify = flow.hooks?.verify ?? verifyInstalledLocalSkill
    const verification = verify({
      root,
      destination: artifact.destination,
      sha256: artifact.sha256,
      bytes: artifact.bytes,
      id: plan.verification.id,
      proves: plan.verification.proves,
    })
    if (verification.ok) {
      const reason =
        'The reviewed bytes were installed and independently verified at the destination. This proves the artifact is present, not that an agent used it.'
      persist('succeeded', reason, verification)
      return applicationRecord({
        status: 'applied',
        executed: true,
        reason,
        plan,
        grant,
        journal,
        verification,
      })
    }
    const reason =
      'The destination was written but independent verification failed, so this is not a completed integration.'
    persist('partial', reason, verification)
    return applicationRecord({
      status: 'partial',
      executed: true,
      reason,
      plan,
      grant,
      journal,
      verification,
    })
  } catch (cause) {
    if (currentOperation !== null) setOperation(currentOperation, 'failed')
    const status: SetupApplicationJournalStatus = uncertain || mutated ? 'partial' : 'failed'
    const reason =
      uncertain || mutated
        ? `Application failed after a mutation was attempted; the repository was not rolled back: ${errorMessage(cause)}`
        : `Application failed before any repository write: ${errorMessage(cause)}`
    try {
      persist(status, reason)
    } catch {
      // The journal could not record the terminal state; the attempt stays `started`, which
      // a later read reports as interrupted rather than as success.
    }
    return applicationRecord({
      status: status === 'partial' ? 'partial' : 'failed',
      executed: mutated,
      reason,
      plan,
      grant,
      journal,
      verification: null,
    })
  }
}
