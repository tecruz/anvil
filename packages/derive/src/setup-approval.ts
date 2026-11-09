/**
 * Approval grants.
 *
 * An approval grant is the authority to apply one already-reviewed `local-skill/v1`
 * execution plan, exactly once. It is deliberately separate from the plan: a plan digest is
 * a change detector, not approval, and a grant is stored outside the repository because a
 * repository anvil does not own must not be able to mint its own authority.
 *
 * This slice issues, inspects, reserves and revokes grants. It does not apply them: there is
 * no writer, journal or verifier here, and nothing in this module mutates the repository.
 *
 * Authority model: the protected user-owned store is the authority, not the digest. A store
 * that another user can write, that lives inside the repository it approves, or that a
 * symlink can redirect is not authority, so every read and write checks the store's
 * ownership, permissions and containment, and reads never follow links. The terminal states
 * (revoked, consumed) are decided by a single no-replace record, so two transitions cannot
 * both win. This does not defend against another process running as the same user.
 */
import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
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
import { homedir, userInfo } from 'node:os'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { AnvilError, ErrorCode } from '@anvil/core'
import { digestJson } from './canonical.ts'
import type { SetupRepositoryState } from './setup.ts'
import {
  buildSetupExecutionPlan,
  isSafeSetupExecutionPath,
  LOCAL_SKILL_ADAPTER,
  MAX_SKILL_NAME_LENGTH,
  MAX_SOURCE_BYTES,
  SetupExecutionError,
  type SetupExecutionPlan,
} from './setup-execution.ts'
import { SKILL_NAME_PATTERN } from './validate.ts'

export const SETUP_APPROVAL_KIND = 'setup-approval'
export const SETUP_APPROVAL_GRANT_KIND = 'setup-approval-grant'
export const SETUP_APPROVAL_PERMISSION = 'apply-local-skill-once'

/** Grants are short-lived: ten minutes is enough to review and re-run the command. */
export const SETUP_APPROVAL_TTL_MS = 10 * 60 * 1000

const GRANT_FILE = 'grant.json'
/** One file decides the terminal state, so consume and revoke cannot both win. */
const TRANSITION_FILE = 'transition.json'
const MAX_RECORD_BYTES = 64 * 1024
const GRANT_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
/** Group/other write bits: the store must not be writable by anyone but its owner. */
const STORE_FORBIDDEN_BITS = 0o022
/** Private modes, applied explicitly so a permissive umask cannot widen the store. */
const PRIVATE_DIRECTORY_MODE = 0o700
const PRIVATE_FILE_MODE = 0o600
/** A grant cannot be issued in the future; a little slack absorbs a clock adjustment. */
const ISSUED_AT_SKEW_MS = 5_000

const GRANT_KEYS = [
  'adapter',
  'adapterFingerprint',
  'expiresAt',
  'id',
  'issuedAt',
  'kind',
  'maxAttempts',
  'operationsDigest',
  'permission',
  'planDigest',
  'repository',
  'schemaVersion',
  'skill',
  'source',
] as const
const REPOSITORY_KEYS = ['head', 'root'] as const
const SOURCE_KEYS = ['bytes', 'path', 'sha256'] as const
const SKILL_KEYS = ['destination', 'name'] as const

/**
 * One approval: the plan, repository, source, destination and adapter behaviour it authorizes,
 * with a single application attempt and a short expiry.
 */
export interface SetupApprovalGrant {
  schemaVersion: 1
  kind: typeof SETUP_APPROVAL_GRANT_KIND
  id: string
  permission: typeof SETUP_APPROVAL_PERMISSION
  planDigest: string
  adapter: typeof LOCAL_SKILL_ADAPTER
  adapterFingerprint: string
  repository: { root: string; head: string }
  source: { path: string; sha256: string; bytes: number }
  skill: { name: string; destination: string }
  /** Binds the ordered operations, including their preconditions. */
  operationsDigest: string
  issuedAt: string
  expiresAt: string
  maxAttempts: 1
}

/**
 * `consumed` means an application attempt has been reserved and cannot be reused; it is
 * terminal, like `revoked`. `stale` means current inputs no longer match the approved ones.
 */
export type SetupApprovalStatus = 'active' | 'expired' | 'revoked' | 'consumed' | 'stale' | 'invalid' | 'unknown'

export interface SetupApprovalRecord {
  schemaVersion: 1
  kind: typeof SETUP_APPROVAL_KIND
  id: string
  status: SetupApprovalStatus
  /** Even an active grant does not execute anything in this slice. */
  executed: false
  executionSupported: false
  reason: string
  grant: SetupApprovalGrant | null
}

/** The result of reserving an attempt: `reserved` is true only for the call that won it. */
export interface SetupApprovalConsumption {
  record: SetupApprovalRecord
  reserved: boolean
}

export interface SetupApprovalStoreOptions {
  env?: NodeJS.ProcessEnv
  now?: Date
}

export interface SetupApprovalGrantOptions {
  now?: Date
  ttlMs?: number
  id?: string
}

export interface SetupApprovalVerdict {
  ok: boolean
  status: 'active' | 'stale'
  reason: string
}

/**
 * The approval store. A dedicated user-owned location, deliberately *not* the config home:
 * `ANVIL_CONFIG_HOME` may point inside a repository, and a repository must not be able to
 * choose where its own authority lives. `ANVIL_APPROVAL_HOME` is an explicit, process-level
 * override for tests and unusual setups, never a value a config file can set.
 */
export function approvalStoreDir(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.ANVIL_APPROVAL_HOME
  if (override !== undefined && override !== '') return resolve(override)
  return join(homedir(), '.anvil', 'approvals', 'setup', 'v1')
}

/**
 * Create the approval store if needed and make it private, returning its path. Exposed so a
 * caller can prepare the store before the first grant, and so tests can build a usable store
 * without issuing a grant.
 */
export function prepareSetupApprovalStore(env: NodeJS.ProcessEnv = process.env): string {
  return ensureStoreRoot(env)
}

/** The ordered operations, canonicalized, so a precondition change invalidates a grant. */
export function setupApprovalOperationsDigest(plan: SetupExecutionPlan): string {
  return digestJson(plan.operations)
}

/**
 * Build the grant for one validated plan. The plan must come from a clean commit; a grant
 * that cannot name a commit cannot be checked later, so it is refused rather than recorded
 * with a placeholder.
 */
export function buildSetupApprovalGrant(
  plan: SetupExecutionPlan,
  options: SetupApprovalGrantOptions = {},
): SetupApprovalGrant {
  if (plan.repository.head === null || plan.repository.worktree !== 'clean') {
    throw new AnvilError(ErrorCode.PreflightFailed, 'An approval grant needs a clean repository commit', {
      hint: 'Generate and validate the plan from a clean commit before approving it.',
    })
  }
  const now = options.now ?? new Date()
  const ttlMs = options.ttlMs ?? SETUP_APPROVAL_TTL_MS
  if (!Number.isFinite(ttlMs) || ttlMs <= 0) {
    throw new AnvilError(ErrorCode.Internal, 'The approval lifetime must be a positive number of milliseconds')
  }
  const id = options.id ?? randomUUID()
  if (!GRANT_ID_PATTERN.test(id)) {
    throw new AnvilError(ErrorCode.Internal, 'The approval grant id is malformed')
  }
  return {
    schemaVersion: 1,
    kind: SETUP_APPROVAL_GRANT_KIND,
    id,
    permission: SETUP_APPROVAL_PERMISSION,
    planDigest: plan.digest,
    adapter: plan.adapter,
    adapterFingerprint: plan.adapterFingerprint,
    repository: { root: plan.repository.root, head: plan.repository.head },
    source: { path: plan.source.path, sha256: plan.source.sha256, bytes: plan.source.bytes },
    skill: { name: plan.skill.name, destination: plan.skill.destination },
    operationsDigest: setupApprovalOperationsDigest(plan),
    issuedAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + ttlMs).toISOString(),
    maxAttempts: 1,
  }
}

/**
 * Compare a grant with a freshly rebuilt plan. Every field the grant duplicates is checked,
 * so a record whose digest was left in place but whose other fields were edited is caught;
 * the plan digest check is the backstop.
 */
export function gradeSetupApprovalGrant(grant: SetupApprovalGrant, plan: SetupExecutionPlan): SetupApprovalVerdict {
  const stale = (reason: string): SetupApprovalVerdict => ({ ok: false, status: 'stale', reason })
  if (grant.adapter !== LOCAL_SKILL_ADAPTER) return stale('The grant names a different adapter.')
  if (grant.adapterFingerprint !== plan.adapterFingerprint) {
    return stale('The adapter behaviour changed since this grant was issued.')
  }
  if (grant.repository.root !== plan.repository.root) return stale('The grant was approved for a different repository.')
  if (grant.repository.head !== plan.repository.head)
    return stale('The repository HEAD changed since this grant was issued.')
  if (grant.source.path !== plan.source.path || grant.source.sha256 !== plan.source.sha256) {
    return stale('The source file changed since this grant was issued.')
  }
  if (grant.source.bytes !== plan.source.bytes) return stale('The source size changed since this grant was issued.')
  if (grant.skill.name !== plan.skill.name || grant.skill.destination !== plan.skill.destination) {
    return stale('The destination changed since this grant was issued.')
  }
  if (grant.operationsDigest !== setupApprovalOperationsDigest(plan)) {
    return stale('The planned operations changed since this grant was issued.')
  }
  if (grant.planDigest !== plan.digest) return stale('The plan changed since this grant was issued.')
  return { ok: true, status: 'active', reason: 'The grant matches the current plan.' }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype
  )
}

function isHex64(value: unknown): value is string {
  return typeof value === 'string' && /^[a-f0-9]{64}$/.test(value)
}

function isIsoDate(value: unknown): value is string {
  return typeof value === 'string' && !Number.isNaN(Date.parse(value))
}

/** True only for a plain object carrying exactly these keys; unknown keys are rejected. */
function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value)
  return actual.length === keys.length && keys.every((key) => Object.hasOwn(value, key))
}

/**
 * Parse an untrusted grant record. Every field is checked, the key set is exact (an unknown
 * field is a rejection, not an oversight) and the id must match the directory it was read
 * from, so a record swapped between directories is refused. A record issued in the future is
 * malformed, not a long-lived grant.
 */
function parseSetupApprovalGrant(value: unknown, expectedId: string, nowMs: number): SetupApprovalGrant | null {
  if (!isPlainObject(value) || !hasExactKeys(value, GRANT_KEYS)) return null
  if (value.schemaVersion !== 1 || value.kind !== SETUP_APPROVAL_GRANT_KIND) return null
  if (value.id !== expectedId || typeof value.id !== 'string') return null
  if (value.permission !== SETUP_APPROVAL_PERMISSION) return null
  if (value.adapter !== LOCAL_SKILL_ADAPTER) return null
  if (value.maxAttempts !== 1) return null
  if (!isHex64(value.planDigest) || !isHex64(value.adapterFingerprint) || !isHex64(value.operationsDigest)) return null
  if (!isIsoDate(value.issuedAt) || !isIsoDate(value.expiresAt)) return null
  if (Date.parse(value.expiresAt) <= Date.parse(value.issuedAt)) return null
  if (Date.parse(value.issuedAt) > nowMs + ISSUED_AT_SKEW_MS) return null

  const repository = value.repository
  if (
    !isPlainObject(repository) ||
    !hasExactKeys(repository, REPOSITORY_KEYS) ||
    typeof repository.root !== 'string' ||
    repository.root === '' ||
    typeof repository.head !== 'string' ||
    repository.head === ''
  ) {
    return null
  }
  const source = value.source
  if (
    !isPlainObject(source) ||
    !hasExactKeys(source, SOURCE_KEYS) ||
    typeof source.path !== 'string' ||
    !isSafeSetupExecutionPath(source.path)
  ) {
    return null
  }
  if (!isHex64(source.sha256) || typeof source.bytes !== 'number' || !Number.isInteger(source.bytes)) return null
  if (source.bytes < 0 || source.bytes > MAX_SOURCE_BYTES) return null
  const skill = value.skill
  if (
    !isPlainObject(skill) ||
    !hasExactKeys(skill, SKILL_KEYS) ||
    typeof skill.name !== 'string' ||
    skill.name.length > MAX_SKILL_NAME_LENGTH ||
    !SKILL_NAME_PATTERN.test(skill.name)
  ) {
    return null
  }
  if (skill.destination !== `.agents/skills/${skill.name}/SKILL.md`) return null

  return value as unknown as SetupApprovalGrant
}

/** Read a regular, singly-linked file, bounded, refusing symlinks. Null when absent or unsafe. */
function readRegularFile(path: string, maxBytes: number): string | null {
  let stat: ReturnType<typeof lstatSync>
  try {
    stat = lstatSync(path)
  } catch {
    return null
  }
  if (stat.isSymbolicLink() || !stat.isFile() || stat.nlink !== 1 || stat.size > maxBytes) return null
  let fd: number | undefined
  try {
    fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
    const opened = fstatSync(fd)
    if (!opened.isFile() || opened.nlink !== 1 || opened.size > maxBytes) return null
    const buffer = Buffer.alloc(maxBytes + 1)
    let length = 0
    while (length < buffer.length) {
      const count = readSync(fd, buffer, length, buffer.length - length, null)
      if (count === 0) break
      length += count
    }
    if (length > maxBytes) return null
    return buffer.subarray(0, length).toString('utf8')
  } catch {
    return null
  } finally {
    if (fd !== undefined) closeSync(fd)
  }
}

/**
 * Write a record without ever replacing an existing one.
 *
 * A temporary file is written first and linked into place: `link` is atomic and fails when
 * the target exists, which is exactly the no-replace guarantee a one-shot grant needs. On a
 * filesystem without hard links, an exclusive create is the fallback.
 */
function writeExclusiveJson(path: string, value: unknown): 'written' | 'exists' {
  const data = `${JSON.stringify(value, null, 2)}\n`
  const temp = join(dirname(path), `.${basename(path)}.${randomUUID()}.tmp`)
  writeFileSync(temp, data, { encoding: 'utf8', flag: 'wx', mode: PRIVATE_FILE_MODE })
  try {
    linkSync(temp, path)
    return 'written'
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === 'EEXIST') return 'exists'
    try {
      writeFileSync(path, data, { encoding: 'utf8', flag: 'wx', mode: PRIVATE_FILE_MODE })
      return 'written'
    } catch (fallback) {
      if ((fallback as NodeJS.ErrnoException).code === 'EEXIST') return 'exists'
      throw fallback
    }
  } finally {
    try {
      rmSync(temp, { force: true })
    } catch {
      // A leftover temp file is inert; the record itself is already in place.
    }
  }
}

/** Why a path is not a plain, inspectable directory or file, or null when it is. */
function structureProblem(path: string, kind: 'directory' | 'file'): string | null {
  let stat: ReturnType<typeof lstatSync>
  try {
    stat = lstatSync(path)
  } catch {
    return `The approval ${kind} cannot be inspected.`
  }
  if (stat.isSymbolicLink()) return `The approval ${kind} is a symbolic link or junction.`
  if (kind === 'directory' ? !stat.isDirectory() : !stat.isFile()) {
    return `The approval ${kind} is not a ${kind}.`
  }
  return null
}

/**
 * POSIX ownership and mode for one record: it must belong to this user and must not be
 * writable by group or other. On Windows these bits are meaningless and the ACL check below
 * governs instead, so this returns null there.
 */
function posixProtectionProblem(path: string, kind: 'directory' | 'file'): string | null {
  if (process.platform === 'win32') return null
  let stat: ReturnType<typeof lstatSync>
  try {
    stat = lstatSync(path)
  } catch {
    return `The approval ${kind} cannot be inspected.`
  }
  const uid = typeof process.getuid === 'function' ? process.getuid() : undefined
  if (uid !== undefined && stat.uid !== uid) return `The approval ${kind} is not owned by the current user.`
  if ((stat.mode & STORE_FORBIDDEN_BITS) !== 0) {
    return `The approval ${kind} is writable by group or other users.`
  }
  return null
}

/**
 * Why one record path is not private, or null when it is.
 *
 * A record another user could write is not authority, so the check applies to the store, every
 * grant directory and every record file, not only the store root. POSIX uses ownership and mode
 * bits; Windows uses the object's access control list, because a Windows `lstat` reports no
 * meaningful owner or mode.
 */
function protectionProblem(path: string, kind: 'directory' | 'file'): string | null {
  const structure = structureProblem(path, kind)
  if (structure !== null) return structure
  if (process.platform === 'win32') return windowsProtectionProblem(path, kind)
  return posixProtectionProblem(path, kind)
}

/** The `<domain>\<user>` name Windows uses for the current user's account. */
function windowsSelfPrincipal(): string | null {
  const user = process.env.USERNAME ?? userInfo().username
  if (user === undefined || user === '') return null
  const domain = process.env.USERDOMAIN ?? process.env.COMPUTERNAME ?? ''
  return domain === '' ? user : `${domain}\\${user}`
}

/** An absolute path to a Windows system tool: never a PATH or working-directory lookup. */
function windowsSystemExecutable(...segments: string[]): string | null {
  const root = process.env.SystemRoot ?? process.env.windir
  if (root === undefined || root === '') return null
  return join(root, 'System32', ...segments)
}

/** The absolute path to Windows PowerShell, which ships with every supported Windows. */
function windowsPowerShell(): string | null {
  return windowsSystemExecutable('WindowsPowerShell', 'v1.0', 'powershell.exe')
}

/**
 * Run a Windows system tool from its own directory, returning its output or null when it cannot
 * be run. The executable path is absolute and the working directory holds no repository, so
 * neither the search path nor a checked-out binary can be chosen by a repository.
 */
function runWindowsTool(executable: string, args: string[], extraEnv: NodeJS.ProcessEnv = {}): string | null {
  try {
    return execFileSync(executable, args, {
      encoding: 'utf8',
      windowsHide: true,
      timeout: 20_000,
      cwd: dirname(executable),
      env: { ...process.env, ...extraEnv },
    })
  } catch {
    return null
  }
}

/**
 * A fixed PowerShell program that reports the current user's SID, an object's owner SID and the
 * SID of every allow entry.
 *
 * Reading the .NET security objects returns SIDs rather than the localized display names
 * `icacls` prints, so the check cannot be fooled by a name that merely ends with the current
 * user's name. The object path is handed over in the environment and never interpolated into
 * the program, so a path can never become code.
 */
const WINDOWS_ACL_SCRIPT = [
  "$ErrorActionPreference = 'Stop'",
  '$p = $env:ANVIL_APPROVAL_ACL_PATH',
  "Write-Output ('S:' + [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value)",
  '$acl = if ([System.IO.Directory]::Exists($p)) { [System.IO.Directory]::GetAccessControl($p) } else { [System.IO.File]::GetAccessControl($p) }',
  "Write-Output ('O:' + $acl.GetOwner([System.Security.Principal.SecurityIdentifier]).Value)",
  'foreach ($rule in $acl.GetAccessRules($true, $true, [System.Security.Principal.SecurityIdentifier])) {',
  "  Write-Output ('A:' + $rule.AccessControlType.ToString() + ':' + $rule.IdentityReference.Value)",
  '}',
].join('\n')

interface WindowsAcl {
  self: string
  owner: string
  allow: string[]
}

/** The current user, owner and allow SIDs of one object, or null when they cannot be read. */
function readWindowsAcl(path: string): WindowsAcl | null {
  const shell = windowsPowerShell()
  if (shell === null) return null
  const output = runWindowsTool(
    shell,
    ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', WINDOWS_ACL_SCRIPT],
    { ANVIL_APPROVAL_ACL_PATH: path },
  )
  if (output === null) return null
  const acl: WindowsAcl = { self: '', owner: '', allow: [] }
  for (const rawLine of output.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (line.startsWith('S:')) acl.self = line.slice(2)
    else if (line.startsWith('O:')) acl.owner = line.slice(2)
    else if (line.startsWith('A:Allow:')) acl.allow.push(line.slice('A:Allow:'.length))
  }
  if (acl.self === '' || acl.owner === '') return null
  return acl
}

/**
 * The SIDs an allow entry or owner may name without being another user: SYSTEM, the built-in
 * Administrators group and the two owner pseudo-accounts. Administrators can already take
 * ownership of anything, so naming them adds no authority; naming another ordinary user does.
 */
const WINDOWS_TRUSTED_SIDS = new Set(['S-1-5-18', 'S-1-5-32-544', 'S-1-3-0', 'S-1-3-4'])

/**
 * Whether a Windows object denies everyone but the current user.
 *
 * Node cannot read a Windows ACL, so a system PowerShell reads it and reports SIDs. The owner
 * and every allow entry must name the current user (or a trusted system account): the owner of
 * an object can always rewrite its access control list, so a foreign owner is a refusal even
 * when the current list looks private. Output that cannot be read is also a refusal, which
 * keeps the check fail-closed.
 */
function windowsProtectionProblem(path: string, kind: 'directory' | 'file'): string | null {
  const acl = readWindowsAcl(path)
  if (acl === null) return `The approval ${kind} access control list cannot be read.`
  if (acl.owner !== acl.self && !WINDOWS_TRUSTED_SIDS.has(acl.owner)) {
    return `The approval ${kind} is owned by ${acl.owner}.`
  }
  if (acl.allow.length === 0) return `The approval ${kind} has no access control entry for its owner.`
  for (const sid of acl.allow) {
    if (sid === acl.self || WINDOWS_TRUSTED_SIDS.has(sid)) continue
    return `The approval ${kind} grants access to ${sid}.`
  }
  return null
}

/** Restrict a Windows store to the current user, dropping every inherited entry. */
function hardenWindowsStore(storeDir: string): string | null {
  const principal = windowsSelfPrincipal()
  if (principal === null) return 'The current Windows user cannot be identified.'
  const icacls = windowsSystemExecutable('icacls.exe')
  if (icacls === null) return 'The Windows icacls tool cannot be located.'
  const output = runWindowsTool(icacls, [storeDir, '/inheritance:r', '/grant:r', `${principal}:(OI)(CI)F`])
  if (output === null) return 'The approval store access control list could not be restricted.'
  return null
}

/**
 * Resolve a path even when its tail does not exist yet, by resolving the deepest existing
 * ancestor and re-appending the missing components. System aliases such as macOS's
 * `/var` -> `/private/var` are followed; a caller path through a link is judged by where it
 * actually lands.
 */
function resolveThroughExisting(path: string): string {
  let current = resolve(path)
  const suffix: string[] = []
  for (;;) {
    try {
      const real = realpathSync.native(current)
      return suffix.length === 0 ? real : join(real, ...suffix)
    } catch {
      const parent = dirname(current)
      if (parent === current) return resolve(path)
      suffix.unshift(basename(current))
      current = parent
    }
  }
}

/** True when `target` is `root` itself or lies beneath it. */
function isInsideOrEqual(root: string, target: string): boolean {
  const rel = relative(root, target)
  return rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel))
}

/**
 * Refuse to keep authority for a repository inside that repository, before anything is
 * created.
 *
 * Both paths are resolved through their deepest existing ancestor rather than requiring the
 * repository to still exist, so a record stays inspectable -- and revocable -- after its
 * checkout has been removed. Containment is still decided physically, so a store reached
 * through a link inside the repository is still refused.
 */
function assertStoreOutsideRepository(storeDir: string, repositoryRoot: string): void {
  if (isInsideOrEqual(resolveThroughExisting(repositoryRoot), resolveThroughExisting(storeDir))) {
    throw new AnvilError(ErrorCode.PreflightFailed, 'The approval store must live outside the repository it approves', {
      hint: 'Set ANVIL_APPROVAL_HOME to a directory outside the repository, or use the default under your home.',
    })
  }
}

type LocatedStore = { dir: string } | 'unsafe' | null

/** Locate the store without creating it. `'unsafe'` means it exists but is not usable authority. */
function locateStore(env: NodeJS.ProcessEnv | undefined): LocatedStore {
  const dir = approvalStoreDir(env)
  let stat: ReturnType<typeof lstatSync>
  try {
    stat = lstatSync(dir)
  } catch {
    return null
  }
  if (!stat.isDirectory() || stat.isSymbolicLink()) return 'unsafe'
  return protectionProblem(dir, 'directory') === null ? { dir } : 'unsafe'
}

/**
 * Create the store if needed and make it private. On Windows the inherited access control
 * list is replaced with one entry for the current user; if that cannot be done the store is
 * refused, because an unprotected store is not authority.
 */
function ensureStoreRoot(env: NodeJS.ProcessEnv | undefined): string {
  const dir = approvalStoreDir(env)
  try {
    mkdirSync(dir, { recursive: true, mode: PRIVATE_DIRECTORY_MODE })
  } catch (cause) {
    throw new AnvilError(ErrorCode.PreflightFailed, `Cannot create the approval store at ${dir}`, {
      hint: 'Set ANVIL_APPROVAL_HOME to a writable directory outside the repository, or use the default under your home.',
      cause,
    })
  }
  // Reject a store that is not a real directory before touching its access control list: a
  // refused store must never be modified. `mkdirSync` follows a link, so this is where a
  // store reached through a symbolic link or junction is caught.
  const structure = structureProblem(dir, 'directory')
  if (structure !== null) {
    throw new AnvilError(ErrorCode.PreflightFailed, `Refusing the approval store at ${dir}: ${structure}`, {
      hint: 'The approval store must be a real directory, not a link or a file.',
    })
  }
  const hardening = process.platform === 'win32' ? hardenWindowsStore(dir) : null
  if (hardening !== null) {
    throw new AnvilError(ErrorCode.PreflightFailed, `Refusing the approval store at ${dir}: ${hardening}`, {
      hint: 'The approval store must be a private directory for your user. Choose a location you own.',
    })
  }
  const problem = protectionProblem(dir, 'directory')
  if (problem !== null) {
    throw new AnvilError(ErrorCode.PreflightFailed, `Refusing the approval store at ${dir}: ${problem}`, {
      hint: 'The approval store must be a real directory owned by your user, not writable by group or other.',
    })
  }
  return dir
}

function assertGrantId(id: string): void {
  if (!GRANT_ID_PATTERN.test(id)) {
    throw new AnvilError(ErrorCode.ConfigInvalid, `Invalid approval grant id: ${id}`, {
      hint: 'Pass the id printed when the grant was created.',
    })
  }
}

export type ReadSetupApprovalGrantResult =
  | { ok: true; grant: SetupApprovalGrant; dir: string }
  | { ok: false; status: 'invalid' | 'unknown'; reason: string }

/** Read one grant record, refusing links, multiply-linked files and an unprotected store. */
export function readSetupApprovalGrant(
  id: string,
  options: SetupApprovalStoreOptions = {},
): ReadSetupApprovalGrantResult {
  assertGrantId(id)
  const located = locateStore(options.env)
  if (located === null) return { ok: false, status: 'invalid', reason: 'No such approval grant.' }
  if (located === 'unsafe') {
    return { ok: false, status: 'unknown', reason: 'The approval store is not a private, user-owned directory.' }
  }
  const dir = join(located.dir, id)
  let stat: ReturnType<typeof lstatSync>
  try {
    stat = lstatSync(dir)
  } catch {
    return { ok: false, status: 'invalid', reason: 'No such approval grant.' }
  }
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    return { ok: false, status: 'unknown', reason: 'The approval record is a symlink or not a directory.' }
  }
  // A record directory another user can write is not a record anvil can trust, even when the
  // store root itself is private.
  const dirProblem = protectionProblem(dir, 'directory')
  if (dirProblem !== null) {
    return { ok: false, status: 'unknown', reason: `The approval record is not private: ${dirProblem}` }
  }
  const grantPath = join(dir, GRANT_FILE)
  const raw = readRegularFile(grantPath, MAX_RECORD_BYTES)
  if (raw === null)
    return { ok: false, status: 'invalid', reason: 'The approval grant record is missing or unreadable.' }
  const fileProblem = protectionProblem(grantPath, 'file')
  if (fileProblem !== null) {
    return { ok: false, status: 'unknown', reason: `The approval grant record is not private: ${fileProblem}` }
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return { ok: false, status: 'invalid', reason: 'The approval grant record is not valid JSON.' }
  }
  const nowMs = (options.now ?? new Date()).getTime()
  const grant = parseSetupApprovalGrant(parsed, id, nowMs)
  if (grant === null) {
    return { ok: false, status: 'invalid', reason: 'The approval grant record is malformed or does not match its id.' }
  }
  // A store the approved repository could itself write is not authority; refuse it rather
  // than read a grant a repository may have planted.
  try {
    assertStoreOutsideRepository(located.dir, grant.repository.root)
  } catch {
    return { ok: false, status: 'unknown', reason: 'The approval store is inside the repository it approves.' }
  }
  return { ok: true, grant, dir }
}

/** Persist a grant. Refuses an existing id and a store inside the approved repository. */
export function saveSetupApprovalGrant(
  grant: SetupApprovalGrant,
  options: SetupApprovalStoreOptions = {},
): SetupApprovalGrant {
  assertGrantId(grant.id)
  // Containment is checked before anything is created, so a rejected store cannot leave a
  // directory behind inside the repository.
  assertStoreOutsideRepository(approvalStoreDir(options.env), grant.repository.root)
  const storeDir = ensureStoreRoot(options.env)
  const dir = join(storeDir, grant.id)
  try {
    mkdirSync(dir, { mode: PRIVATE_DIRECTORY_MODE })
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === 'EEXIST') {
      throw new AnvilError(ErrorCode.PreflightFailed, `An approval grant ${grant.id} already exists.`, {
        hint: 'Issue a new approval instead of reusing an existing id.',
      })
    }
    throw new AnvilError(ErrorCode.PreflightFailed, 'Cannot create the approval record directory.', { cause })
  }
  try {
    if (writeExclusiveJson(join(dir, GRANT_FILE), grant) !== 'written') {
      throw new AnvilError(ErrorCode.PreflightFailed, `An approval grant ${grant.id} already exists.`)
    }
  } catch (cause) {
    try {
      rmSync(dir, { recursive: true, force: true })
    } catch {
      // Leave an inert, grant-less directory rather than masking the original failure.
    }
    throw cause instanceof AnvilError
      ? cause
      : new AnvilError(ErrorCode.PreflightFailed, 'Could not write the approval grant.', { cause })
  }
  return grant
}

type TransitionState = 'none' | 'revoked' | 'consumed' | 'unknown'

/** Read the single terminal-state record. Absent, a valid kind, or uninspectable. */
function readTransition(dir: string): TransitionState {
  const path = join(dir, TRANSITION_FILE)
  let stat: ReturnType<typeof lstatSync>
  try {
    stat = lstatSync(path)
  } catch (cause) {
    return (cause as NodeJS.ErrnoException).code === 'ENOENT' ? 'none' : 'unknown'
  }
  if (stat.isSymbolicLink() || !stat.isFile() || stat.nlink !== 1) return 'unknown'
  // A transition record another user can rewrite could revoke or consume a grant at will.
  if (protectionProblem(path, 'file') !== null) return 'unknown'
  const raw = readRegularFile(path, MAX_RECORD_BYTES)
  if (raw === null) return 'unknown'
  try {
    const parsed: unknown = JSON.parse(raw)
    if (isPlainObject(parsed) && (parsed.kind === 'revoked' || parsed.kind === 'consumed') && isIsoDate(parsed.at)) {
      return parsed.kind
    }
  } catch {
    // Fall through to unknown.
  }
  return 'unknown'
}

function writeTransition(dir: string, kind: 'revoked' | 'consumed', now: Date): 'written' | 'exists' {
  return writeExclusiveJson(join(dir, TRANSITION_FILE), { schemaVersion: 1, kind, at: now.toISOString() })
}

function approvalRecord(
  id: string,
  status: SetupApprovalStatus,
  reason: string,
  grant: SetupApprovalGrant | null,
): SetupApprovalRecord {
  return {
    schemaVersion: 1,
    kind: SETUP_APPROVAL_KIND,
    id,
    status,
    executed: false,
    executionSupported: false,
    reason,
    grant,
  }
}

/**
 * Inspect a grant against current inputs. Pass the current repository state to confirm
 * freshness; with `null`, a grant that is not already terminal is `unknown`, because the
 * inputs that decide `active` cannot be checked.
 *
 * Terminal states are reported first: a revoked or already-used grant never becomes active,
 * and an expired grant is reported without touching the repository.
 */
export function inspectSetupApproval(
  id: string,
  current: SetupRepositoryState | null,
  options: SetupApprovalStoreOptions = {},
): SetupApprovalRecord {
  const read = readSetupApprovalGrant(id, options)
  if (!read.ok) return approvalRecord(id, read.status, read.reason, null)
  const { grant, dir } = read

  const transition = readTransition(dir)
  if (transition === 'unknown')
    return approvalRecord(id, 'unknown', 'The grant state record cannot be inspected.', grant)
  if (transition === 'revoked') return approvalRecord(id, 'revoked', 'The grant was revoked.', grant)
  if (transition === 'consumed') {
    return approvalRecord(
      id,
      'consumed',
      'An application attempt has already started; the grant cannot be reused.',
      grant,
    )
  }

  const now = options.now ?? new Date()
  const expiresAt = Date.parse(grant.expiresAt)
  if (Number.isNaN(expiresAt)) return approvalRecord(id, 'invalid', 'The grant expiry is malformed.', grant)
  if (expiresAt <= now.getTime())
    return approvalRecord(id, 'expired', `The grant expired at ${grant.expiresAt}.`, grant)

  if (current === null) {
    return approvalRecord(id, 'unknown', 'The current repository state is required to confirm a grant.', grant)
  }
  if (current.head === null || current.worktree !== 'clean') {
    return approvalRecord(id, 'unknown', 'A clean repository commit is needed to check a grant.', grant)
  }
  let plan: SetupExecutionPlan
  try {
    plan = buildSetupExecutionPlan({ repository: current, sourcePath: grant.source.path, name: grant.skill.name })
  } catch (cause) {
    if (cause instanceof SetupExecutionError) {
      return approvalRecord(id, cause.validationStatus === 'unknown' ? 'unknown' : 'stale', cause.message, grant)
    }
    if (cause instanceof AnvilError) return approvalRecord(id, 'invalid', cause.message, grant)
    throw cause
  }
  const verdict = gradeSetupApprovalGrant(grant, plan)
  if (!verdict.ok) return approvalRecord(id, verdict.status, verdict.reason, grant)

  return approvalRecord(id, 'active', 'The grant is active: it authorizes one application of this plan.', grant)
}

/**
 * Revoke a grant. Terminal and idempotent: revoking a revoked grant reports `revoked`, but a
 * consumed grant already started its attempt and cannot be revoked. The terminal state is a
 * single no-replace record, so a revoke racing a consume cannot both win.
 */
export function revokeSetupApproval(id: string, options: SetupApprovalStoreOptions = {}): SetupApprovalRecord {
  const read = readSetupApprovalGrant(id, options)
  if (!read.ok) return approvalRecord(id, read.status, read.reason, null)
  const { grant, dir } = read

  const transition = readTransition(dir)
  if (transition === 'unknown')
    return approvalRecord(id, 'unknown', 'The grant state record cannot be inspected.', grant)
  if (transition === 'consumed') {
    return approvalRecord(
      id,
      'consumed',
      'An application attempt has already started, so the grant cannot be revoked.',
      grant,
    )
  }
  if (transition === 'revoked') return approvalRecord(id, 'revoked', 'The grant was already revoked.', grant)

  const now = options.now ?? new Date()
  let written: 'written' | 'exists'
  try {
    written = writeTransition(dir, 'revoked', now)
  } catch (cause) {
    throw new AnvilError(ErrorCode.PreflightFailed, 'Could not record the revocation.', { cause })
  }
  if (written === 'written') {
    return approvalRecord(id, 'revoked', 'The grant was revoked. It can no longer authorize an application.', grant)
  }
  // Another transition won the race; report whichever terminal state it wrote.
  const after = readTransition(dir)
  if (after === 'consumed') {
    return approvalRecord(
      id,
      'consumed',
      'An application attempt has already started, so the grant cannot be revoked.',
      grant,
    )
  }
  if (after === 'revoked') return approvalRecord(id, 'revoked', 'The grant was already revoked.', grant)
  return approvalRecord(id, 'unknown', 'The grant state record cannot be inspected.', grant)
}

/**
 * Reserve the single application attempt. Application code must call this after full
 * revalidation and *before* its first repository mutation, so a crash or failure burns the
 * attempt and cannot be retried without fresh approval. The state is written as a single
 * no-replace record, so two concurrent callers cannot both reserve it, `reserved` is true
 * only for the call that won the attempt.
 */
export function consumeSetupApproval(
  id: string,
  current: SetupRepositoryState | null,
  options: SetupApprovalStoreOptions = {},
): SetupApprovalConsumption {
  const read = readSetupApprovalGrant(id, options)
  if (!read.ok) return { record: approvalRecord(id, read.status, read.reason, null), reserved: false }
  const { grant, dir } = read

  const transition = readTransition(dir)
  if (transition === 'unknown') {
    return {
      record: approvalRecord(id, 'unknown', 'The grant state record cannot be inspected.', grant),
      reserved: false,
    }
  }
  if (transition === 'consumed') {
    return { record: approvalRecord(id, 'consumed', 'This grant has already been used.', grant), reserved: false }
  }
  if (transition === 'revoked') {
    return { record: approvalRecord(id, 'revoked', 'The grant was revoked.', grant), reserved: false }
  }

  const inspection = inspectSetupApproval(id, current, options)
  if (inspection.status !== 'active') return { record: inspection, reserved: false }

  const now = options.now ?? new Date()
  let written: 'written' | 'exists'
  try {
    written = writeTransition(dir, 'consumed', now)
  } catch (cause) {
    throw new AnvilError(ErrorCode.PreflightFailed, 'Could not reserve the application attempt.', { cause })
  }
  if (written === 'exists') {
    const after = readTransition(dir)
    if (after === 'revoked') {
      return {
        record: approvalRecord(id, 'revoked', 'The grant was revoked before the attempt could be reserved.', grant),
        reserved: false,
      }
    }
    return { record: approvalRecord(id, 'consumed', 'This grant has already been used.', grant), reserved: false }
  }
  return {
    record: approvalRecord(
      id,
      'consumed',
      'The single application attempt is reserved. No automatic retry is allowed.',
      grant,
    ),
    reserved: true,
  }
}
