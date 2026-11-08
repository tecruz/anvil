/**
 * Inspect-only execution plans.
 *
 * This module defines one bounded adapter, `local-skill/v1`: copy a repository-local,
 * standalone `SKILL.md` to `.agents/skills/<name>/SKILL.md`, and never overwrite anything.
 * It produces a plan for review and validation only. There is deliberately no approval
 * store, writer, journal or verifier here; those are separate authority and a separate
 * change.
 *
 * The digest is a change detector, not an authorization token. A source hash pins bytes;
 * it does not establish authorship, trustworthiness or that an agent will follow the skill.
 */
import { createHash } from 'node:crypto'
import { closeSync, constants, fstatSync, lstatSync, openSync, readSync, realpathSync, statSync } from 'node:fs'
import { isAbsolute, join, relative, sep } from 'node:path'
import { AnvilError, ErrorCode } from '@anvil/core'
import { canonicalJson, digestJson } from './canonical.ts'
import type { SetupRepositoryState } from './setup.ts'
import { SKILL_NAME_PATTERN, validateArtifact } from './validate.ts'

export const SETUP_EXECUTION_PLAN_KIND = 'setup-execution-plan'
export const LOCAL_SKILL_ADAPTER = 'local-skill/v1'

/** Source files are bounded so a saved plan stays inside the 1 MiB plan-file limit. */
export const MAX_SOURCE_BYTES = 128 * 1024

/**
 * The adapter's behaviour fingerprint. Bump the descriptor whenever this module changes
 * what an approved plan would write, so an old approval cannot survive a code change.
 */
const ADAPTER_DESCRIPTOR = {
  adapter: LOCAL_SKILL_ADAPTER,
  source: 'repository-regular-utf8-file',
  destination: '.agents/skills/<name>/SKILL.md',
  createOnly: true,
  overwrite: false,
  publish: 'temp-file-no-replace',
  effects: 'filesystem-only',
  verification: 'installed-bytes-plus-skill-metadata',
} as const
export const LOCAL_SKILL_ADAPTER_FINGERPRINT = digestJson(ADAPTER_DESCRIPTOR)

export interface SetupExecutionSource {
  /** Repository-relative path with `/` separators. */
  path: string
  /** SHA-256 of the exact source bytes, including a BOM or CRLF if present. */
  sha256: string
  bytes: number
  /** Exact decoded UTF-8 content, included for review of what would be installed. */
  content: string
}

export interface SetupExecutionSkill {
  name: string
  destination: string
}

export interface SetupExecutionDirectoryOperation {
  id: string
  kind: 'ensure-directory' | 'create-directory'
  path: string
  /** `absent-or-real-directory` tolerates an existing plain directory; `absent` requires absence. */
  precondition: 'absent-or-real-directory' | 'absent'
}

export interface SetupExecutionFileOperation {
  id: string
  kind: 'write-file'
  path: string
  precondition: 'absent'
  source: string
  sha256: string
  bytes: number
  overwrite: false
  publish: 'temp-file-no-replace'
}

export type SetupExecutionOperation = SetupExecutionDirectoryOperation | SetupExecutionFileOperation

export interface SetupExecutionEffects {
  kind: 'filesystem-only'
  directories: string[]
  files: Array<{ path: string; sha256: string; bytes: number }>
  overwrite: false
  delete: false
  processes: false
  network: false
  credentials: false
}

export interface SetupExecutionVerification {
  id: 'local-skill-installed/v1'
  scope: 'artifact-installed'
  checks: string[]
  /** The narrow claim a later verifier may make when every check passes. */
  proves: string
}

export interface SetupExecutionPlan {
  schemaVersion: 1
  kind: typeof SETUP_EXECUTION_PLAN_KIND
  status: 'proposed'
  executed: false
  approval: 'not-granted'
  executionSupported: false
  adapter: typeof LOCAL_SKILL_ADAPTER
  adapterFingerprint: string
  repository: SetupRepositoryState
  /** Binds the explicit adapter inputs. The whole payload additionally binds the source bytes. */
  inputsDigest: string
  skill: SetupExecutionSkill
  source: SetupExecutionSource
  operations: SetupExecutionOperation[]
  effects: SetupExecutionEffects
  verification: SetupExecutionVerification
  warnings: string[]
  digest: string
}

export interface SetupExecutionPlanValidation {
  schemaVersion: 1
  status: 'current' | 'stale' | 'invalid' | 'unknown'
  /** Even a current execution plan does not authorize anything in this slice. */
  approval: 'not-granted'
  executed: false
  reason: string
}

/** Only the reviewable adapter inputs are extracted from a saved plan. */
export interface SetupExecutionRequest {
  adapter: typeof LOCAL_SKILL_ADAPTER
  name: string
  sourcePath: string
}

/**
 * A refusal while rebuilding a plan. `validationStatus` lets validation distinguish
 * "inputs changed" from "the current state cannot be inspected safely".
 */
export class SetupExecutionError extends AnvilError {
  readonly validationStatus: 'stale' | 'unknown'

  constructor(
    validationStatus: 'stale' | 'unknown',
    message: string,
    options: { hint?: string; cause?: unknown } = {},
  ) {
    super(ErrorCode.PreflightFailed, message, options)
    this.name = 'SetupExecutionError'
    this.validationStatus = validationStatus
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype
  )
}

function missing(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | undefined)?.code
  return code === 'ENOENT' || code === 'ENOTDIR'
}

/**
 * A strict repository-relative path: `/` separators, no empty/`.`/`..` segments, no
 * absolute or drive form, no control characters, and not inside the Git directory.
 * Filename whitespace is legal and preserved.
 *
 * Windows strips trailing dots and spaces from a component, so `.git.`, `.git ` and
 * `.. ` name the same entries as `.git` and `..`. Compare the normalized form rather
 * than letting a rendering difference bypass the traversal and Git-directory guards.
 */
export function isSafeSetupExecutionPath(value: string): boolean {
  if (value === '' || value.startsWith('/') || value.startsWith('\\') || /^[A-Za-z]:/.test(value)) return false
  if (value.includes('\\') || /[\u0000-\u001f]/.test(value)) return false
  return value.split('/').every((segment) => !isUnsafeSegment(segment))
}

function normalizedSegment(segment: string): string {
  return segment.replace(/[. ]+$/, '')
}

function isUnsafeSegment(segment: string): boolean {
  const normalized = normalizedSegment(segment)
  if (normalized === '' || normalized === '.' || normalized === '..') return true
  return normalized.toLowerCase() === '.git'
}

function resolvedRepositoryRoot(root: string): string {
  let resolved: string
  try {
    resolved = realpathSync.native(root)
  } catch (cause) {
    throw new SetupExecutionError(
      'unknown',
      'The repository root cannot be resolved, so the source cannot be checked.',
      {
        hint: 'Run the plan from a readable physical repository directory.',
        cause,
      },
    )
  }
  try {
    if (!statSync(resolved).isDirectory()) {
      throw new SetupExecutionError('unknown', 'The repository root is not a directory.')
    }
  } catch (cause) {
    if (cause instanceof SetupExecutionError) throw cause
    throw new SetupExecutionError('unknown', 'The repository root cannot be inspected.', { cause })
  }
  return resolved
}

function isInside(root: string, candidate: string): boolean {
  const rel = relative(root, candidate)
  return rel !== '' && rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel)
}

interface ReadSource {
  sha256: string
  bytes: Buffer
  content: string
}

/**
 * Read the source through repository-relative components, refusing links anywhere on the
 * path. Containment is decided before the bytes are read: a source that cannot be resolved
 * inside the resolved repository root is refused rather than guessed about.
 */
function readSource(root: string, sourcePath: string): ReadSource {
  if (!isSafeSetupExecutionPath(sourcePath)) {
    throw new AnvilError(ErrorCode.ConfigInvalid, 'The source must be a repository-relative file path', {
      hint: 'Use a path such as docs/skills/example.md with forward slashes and no parent traversal.',
    })
  }
  const segments = sourcePath.split('/')
  let current = root
  for (const [index, segment] of segments.entries()) {
    current = join(current, segment)
    let stat: ReturnType<typeof lstatSync>
    try {
      stat = lstatSync(current)
    } catch (cause) {
      if (missing(cause)) {
        throw new SetupExecutionError('stale', `The source file "${sourcePath}" does not exist.`, {
          hint: 'Choose a regular file inside this repository.',
          cause,
        })
      }
      throw new SetupExecutionError('unknown', `The source path "${sourcePath}" cannot be inspected.`, { cause })
    }
    if (stat.isSymbolicLink()) {
      throw new SetupExecutionError(
        'unknown',
        `The source path "${sourcePath}" goes through a symbolic link or junction.`,
        {
          hint: 'Use a real file inside the repository; links and junctions cannot be installed by this adapter.',
        },
      )
    }
    const last = index === segments.length - 1
    if (last ? !stat.isFile() : !stat.isDirectory()) {
      throw new SetupExecutionError(
        'stale',
        last
          ? `The source "${sourcePath}" is not a regular file.`
          : `A component of "${sourcePath}" is not a directory.`,
        { hint: 'Choose a regular SKILL.md file inside this repository.' },
      )
    }
  }

  let resolvedSource: string
  try {
    resolvedSource = realpathSync.native(current)
  } catch (cause) {
    throw new SetupExecutionError('unknown', `The source "${sourcePath}" cannot be resolved.`, { cause })
  }
  if (!isInside(root, resolvedSource)) {
    throw new SetupExecutionError('unknown', `The source "${sourcePath}" does not resolve inside this repository.`)
  }
  // The string check runs first, but a platform alias could still resolve into the Git
  // directory (for example a short name). Judge the resolved path, not just the input.
  if (relative(root, resolvedSource).split(sep).some(isUnsafeSegment)) {
    throw new SetupExecutionError('unknown', `The source "${sourcePath}" resolves into the Git directory.`)
  }

  let fd: number | undefined
  try {
    fd = openSync(current, constants.O_RDONLY)
    const stat = fstatSync(fd)
    if (!stat.isFile()) {
      throw new SetupExecutionError('stale', `The source "${sourcePath}" is not a regular file.`)
    }
    if (stat.size > MAX_SOURCE_BYTES) {
      throw new SetupExecutionError('stale', `The source "${sourcePath}" is larger than ${MAX_SOURCE_BYTES} bytes.`, {
        hint: 'A skill plan is bounded so its content can be reviewed and saved as a plan file.',
      })
    }
    // Bound the actual read too, in case the file grows between stat and read.
    const buffer = Buffer.alloc(MAX_SOURCE_BYTES + 1)
    let length = 0
    while (length < buffer.length) {
      const count = readSync(fd, buffer, length, buffer.length - length, null)
      if (count === 0) break
      length += count
    }
    if (length > MAX_SOURCE_BYTES) {
      throw new SetupExecutionError(
        'stale',
        `The source "${sourcePath}" grew beyond ${MAX_SOURCE_BYTES} bytes while reading.`,
      )
    }
    const bytes = buffer.subarray(0, length)
    let content: string
    try {
      // `ignoreBOM: true` keeps a leading BOM in the preview so the string round-trips to
      // the exact bytes whose hash is recorded.
      content = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes)
    } catch (cause) {
      throw new SetupExecutionError('stale', `The source "${sourcePath}" is not valid UTF-8.`, {
        hint: 'A skill must be a UTF-8 text file.',
        cause,
      })
    }
    return { sha256: digestBytes(bytes), bytes, content }
  } catch (cause) {
    if (cause instanceof AnvilError) throw cause
    throw new SetupExecutionError('unknown', `The source "${sourcePath}" could not be read.`, { cause })
  } finally {
    if (fd !== undefined) closeSync(fd)
  }
}

function digestBytes(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex')
}

function inspectDestination(root: string, name: string): { destination: string; directories: string[] } {
  const parents = ['.agents', '.agents/skills'] as const
  for (const parent of parents) {
    const path = join(root, ...parent.split('/'))
    let stat: ReturnType<typeof lstatSync> | null
    try {
      stat = lstatSync(path)
    } catch (cause) {
      if (missing(cause)) continue
      throw new SetupExecutionError('unknown', `The destination parent "${parent}" cannot be inspected.`, { cause })
    }
    if (stat.isSymbolicLink()) {
      throw new SetupExecutionError('unknown', `The destination parent "${parent}" is a symbolic link or junction.`, {
        hint: 'Existing links are never followed or replaced. Move the skill destination to a real directory.',
      })
    }
    if (!stat.isDirectory()) {
      throw new SetupExecutionError('stale', `The destination parent "${parent}" is not a directory.`)
    }
  }

  const skillDirectory = join(root, '.agents', 'skills', name)
  try {
    lstatSync(skillDirectory)
  } catch (cause) {
    if (!missing(cause)) {
      throw new SetupExecutionError(
        'unknown',
        `The destination skill directory ".agents/skills/${name}" cannot be inspected.`,
        {
          cause,
        },
      )
    }
    return {
      destination: `.agents/skills/${name}/SKILL.md`,
      directories: ['.agents', '.agents/skills', `.agents/skills/${name}`],
    }
  }
  throw new SetupExecutionError('stale', `The destination ".agents/skills/${name}" already exists.`, {
    hint: 'This adapter is create-only. Choose a different skill name or remove nothing; existing content is preserved.',
  })
}

/**
 * Build an inspect-only execution plan for one repository-local skill.
 *
 * The function only reads. It never creates `.agents`, writes a plan, or executes the
 * source. Missing or unsafe preconditions are refused rather than represented as success.
 */
export function buildSetupExecutionPlan(options: {
  repository: SetupRepositoryState
  sourcePath: string
  name: string
}): SetupExecutionPlan {
  const { repository, sourcePath, name } = options
  if (!SKILL_NAME_PATTERN.test(name)) {
    throw new AnvilError(ErrorCode.ConfigInvalid, `The skill name must match ${SKILL_NAME_PATTERN.source}`, {
      hint: 'Use lowercase letters, digits and single hyphens, for example "release-notes".',
    })
  }

  const root = resolvedRepositoryRoot(repository.root)
  const source = readSource(root, sourcePath)
  const { destination, directories } = inspectDestination(root, name)
  const validation = validateArtifact(destination, source.content)
  if (!validation.ok) {
    throw new SetupExecutionError('stale', `The source is not a valid skill: ${validation.errors.join('; ')}`, {
      hint: 'Fix the SKILL.md metadata before planning an installation.',
    })
  }

  const operations: SetupExecutionOperation[] = [
    {
      id: 'directory:.agents',
      kind: 'ensure-directory',
      path: '.agents',
      precondition: 'absent-or-real-directory',
    },
    {
      id: 'directory:.agents/skills',
      kind: 'ensure-directory',
      path: '.agents/skills',
      precondition: 'absent-or-real-directory',
    },
    {
      id: `directory:.agents/skills/${name}`,
      kind: 'create-directory',
      path: `.agents/skills/${name}`,
      precondition: 'absent',
    },
    {
      id: `file:${destination}`,
      kind: 'write-file',
      path: destination,
      precondition: 'absent',
      source: sourcePath,
      sha256: source.sha256,
      bytes: source.bytes.length,
      overwrite: false,
      publish: 'temp-file-no-replace',
    },
  ]

  const warnings = [
    'Inspection only: this slice has no approval or apply command, and building or validating a plan never executes it.',
    'The source hash pins the exact bytes, not authorship, trustworthiness, quality or whether an agent will follow the skill.',
    'Only a repository-local, standalone SKILL.md is supported. No downloads, scripts, commands, global installs or overwrites are supported.',
    'A later verifier can only prove that the reviewed artifact was installed; it cannot prove that an agent loaded or followed it.',
    'Filesystem checks reduce accidental overwrites but are not an operating-system sandbox against concurrent path changes.',
  ]
  if (repository.head === null || repository.worktree !== 'clean') {
    warnings.push('Repository state is not a clean commit; this plan cannot pass current-plan validation.')
  }
  for (const warning of validation.warnings) warnings.push(`Skill validation warning: ${warning}`)

  const payload = {
    schemaVersion: 1 as const,
    kind: SETUP_EXECUTION_PLAN_KIND as typeof SETUP_EXECUTION_PLAN_KIND,
    status: 'proposed' as const,
    executed: false as const,
    approval: 'not-granted' as const,
    executionSupported: false as const,
    adapter: LOCAL_SKILL_ADAPTER as typeof LOCAL_SKILL_ADAPTER,
    adapterFingerprint: LOCAL_SKILL_ADAPTER_FINGERPRINT,
    repository: { root: repository.root, head: repository.head, worktree: repository.worktree },
    inputsDigest: digestJson({
      adapter: LOCAL_SKILL_ADAPTER,
      adapterFingerprint: LOCAL_SKILL_ADAPTER_FINGERPRINT,
      name,
      sourcePath,
    }),
    skill: { name, destination },
    source: {
      path: sourcePath,
      sha256: source.sha256,
      bytes: source.bytes.length,
      content: source.content,
    },
    operations,
    effects: {
      kind: 'filesystem-only' as const,
      directories,
      files: [{ path: destination, sha256: source.sha256, bytes: source.bytes.length }],
      overwrite: false as const,
      delete: false as const,
      processes: false as const,
      network: false as const,
      credentials: false as const,
    },
    verification: {
      id: 'local-skill-installed/v1' as const,
      scope: 'artifact-installed' as const,
      checks: [
        'destination-inside-repository',
        'destination-regular-file',
        'installed-bytes-match-source-sha256',
        'skill-metadata-valid',
      ],
      proves:
        'Only that the reviewed SKILL.md bytes are present at the destination with valid skill metadata. It does not prove that an agent loaded, followed, trusted or successfully used the skill.',
    },
    warnings,
  }
  return { ...payload, digest: digestJson(payload) }
}

/**
 * Extract only the bounded adapter inputs from a saved plan.
 *
 * A saved plan is untrusted JSON. Name and path are validated before they are used to touch
 * the filesystem; everything else is compared later by whole-payload equality, so a
 * recomputed digest cannot smuggle a different plan into a current result.
 */
export function extractSetupExecutionRequest(saved: unknown): SetupExecutionRequest {
  if (!isPlainObject(saved)) {
    throw new AnvilError(ErrorCode.ConfigInvalid, 'Expected a setup-execution-plan JSON object')
  }
  if (saved.schemaVersion !== 1 || saved.kind !== SETUP_EXECUTION_PLAN_KIND || typeof saved.digest !== 'string') {
    throw new AnvilError(ErrorCode.ConfigInvalid, 'Unsupported setup-execution-plan format.')
  }
  if (saved.adapter !== LOCAL_SKILL_ADAPTER) {
    throw new AnvilError(ErrorCode.ConfigInvalid, 'Unsupported setup execution adapter.')
  }
  const skill = saved.skill
  const source = saved.source
  if (!isPlainObject(skill) || typeof skill.name !== 'string' || !SKILL_NAME_PATTERN.test(skill.name)) {
    throw new AnvilError(ErrorCode.ConfigInvalid, 'The saved plan has an invalid skill name.')
  }
  const destination = `.agents/skills/${skill.name}/SKILL.md`
  if (skill.destination !== destination) {
    throw new AnvilError(ErrorCode.ConfigInvalid, 'The saved plan has an inconsistent skill destination.')
  }
  if (!isPlainObject(source) || typeof source.path !== 'string' || !isSafeSetupExecutionPath(source.path)) {
    throw new AnvilError(ErrorCode.ConfigInvalid, 'The saved plan has an unsafe or missing source path.')
  }
  return { adapter: LOCAL_SKILL_ADAPTER, name: skill.name, sourcePath: source.path }
}

/** True when saved JSON claims to be an execution plan, even if its contents are malformed. */
export function isSetupExecutionPlan(value: unknown): value is SetupExecutionPlan {
  return isPlainObject(value) && value.kind === SETUP_EXECUTION_PLAN_KIND
}

/**
 * Compare untrusted saved JSON with a freshly generated execution plan. Equality is strict:
 * extra keys, changed content, a different source or repository state, or a different
 * adapter fingerprint all fail.
 */
export function validateSetupExecutionPlan(saved: unknown, current: SetupExecutionPlan): SetupExecutionPlanValidation {
  const result = (status: SetupExecutionPlanValidation['status'], reason: string): SetupExecutionPlanValidation => ({
    schemaVersion: 1,
    status,
    approval: 'not-granted',
    executed: false,
    reason,
  })
  if (!isPlainObject(saved)) {
    return result('invalid', 'Expected a setup-execution-plan JSON object, not an approval or an envelope.')
  }
  const { digest: recordedDigest, ...payload } = saved
  if (payload.schemaVersion !== 1 || payload.kind !== SETUP_EXECUTION_PLAN_KIND || typeof recordedDigest !== 'string') {
    return result('invalid', 'Unsupported setup-execution-plan format.')
  }
  try {
    if (digestJson(payload) !== recordedDigest) {
      return result('invalid', 'The saved execution plan digest does not match its contents.')
    }
    // Compare the whole payload, not just a digest supplied by the caller. This rejects
    // extra fields (including forged approval fields) and malformed structures whose digest
    // an attacker recomputed.
    if (canonicalJson(saved) !== canonicalJson(current)) {
      return result(
        'stale',
        'The saved execution plan differs from the current source, destination or repository state.',
      )
    }
  } catch {
    return result('invalid', 'The saved execution plan is not supported JSON data.')
  }
  if (current.repository.head === null || current.repository.worktree !== 'clean') {
    return result('unknown', 'A clean repository commit is needed to validate a current execution plan.')
  }
  return result(
    'current',
    'The execution plan matches current inputs. This is not approval, installation or evidence that the skill is effective.',
  )
}
