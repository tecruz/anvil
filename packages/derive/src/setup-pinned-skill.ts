/**
 * `pinned-skill/v1`: install one `SKILL.md` pinned to a GitHub commit.
 *
 * Fetching is a separate, explicit command (`setup fetch`) that copies bytes into the
 * protected store. Planning reads only that frozen cache, so `plan`, `validate`, `approve` and
 * `apply` never touch the network. The cache separates content from origin: bytes are
 * content-addressed, and an immutable origin record says which commit and path produced them.
 *
 * A commit SHA pins the exact bytes GitHub serves for one path at one commit. It does not
 * establish authorship, review, licensing or safety, and it does not prove an agent will load
 * or follow the skill.
 */
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { AnvilError, ErrorCode } from '@anvil/core'
import { digestJson } from './canonical.ts'
import type { SetupRepositoryState } from './setup.ts'
import { readPrivateStoreRecord } from './setup-approval.ts'
import {
  inspectSetupSkillDestination,
  isSafeSetupExecutionPath,
  isValidSetupSkillName,
  MAX_SOURCE_BYTES,
  PINNED_SKILL_ADAPTER,
  type PinnedSkillExecutionPlan,
  RESERVED_SKILL_NAMES,
  resolvedSetupRepositoryRoot,
  SetupExecutionError,
  type SetupExecutionOperation,
  type SetupExecutionPlanResolution,
  type SetupOrigin,
  validateSetupExecutionPlan,
} from './setup-execution.ts'
import { approvalStoreDir } from './setup-store.ts'
import { validateArtifact } from './validate.ts'

/** GitHub only in v1: one transport (`gh`), one documented host. */
export const PINNED_SKILL_HOST = 'github.com'
export const PINNED_SKILL_ORIGIN_KIND = 'setup-fetch-origin'
export const PINNED_SKILL_FETCH_DIR = ['fetched', 'blobs'] as const
export const PINNED_SKILL_ORIGIN_DIR = ['fetched', 'origins'] as const

/**
 * The adapter's behaviour fingerprint. Bump the descriptor whenever planning, writing or
 * verification changes what an approved plan would do, so an old approval cannot survive.
 */
const PINNED_SKILL_DESCRIPTOR = {
  adapter: PINNED_SKILL_ADAPTER,
  source: 'pinned-github-file-via-protected-fetch-cache',
  destination: '.agents/skills/<name>/SKILL.md',
  createOnly: true,
  overwrite: false,
  publish: 'temp-file-no-replace',
  effects: 'filesystem-only',
  verification: 'installed-bytes-plus-skill-metadata',
  network: 'fetch-command-only',
} as const
export const PINNED_SKILL_ADAPTER_FINGERPRINT = digestJson(PINNED_SKILL_DESCRIPTOR)

const COMMIT_PATTERN = /^[0-9a-f]{40}$/
const HOST_PATTERN = /^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/
const REPO_COMPONENT_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/
const MAX_REPO_COMPONENT = 100
const MAX_REF_LENGTH = 255
const ORIGIN_KEYS = [
  'blobSha256',
  'bytes',
  'commit',
  'fetchedAt',
  'host',
  'kind',
  'path',
  'repo',
  'requestedRef',
  'schemaVersion',
  'url',
] as const
const ORIGIN_BLOCK_KEYS = ['commit', 'host', 'path', 'repo', 'url'] as const
const CONTENT_KEYS = ['bytes', 'sha256'] as const
const SKILL_KEYS = ['destination', 'name'] as const
const BINDING_KEYS = ['content', 'origin', 'skill'] as const

export interface PinnedSkillRequest {
  adapter: typeof PINNED_SKILL_ADAPTER
  host: string
  repo: string
  commit: string
  path: string
  name: string
}

/** The immutable record of where frozen bytes came from. */
export interface PinnedSkillOriginRecord {
  schemaVersion: 1
  kind: typeof PINNED_SKILL_ORIGIN_KIND
  host: string
  repo: string
  commit: string
  path: string
  blobSha256: string
  bytes: number
  fetchedAt: string
  requestedRef: string
  url: string
}

/** What a grant duplicates from a pinned-skill plan. */
export interface PinnedSkillBindings {
  origin: SetupOrigin
  content: { sha256: string; bytes: number }
  skill: { name: string; destination: string }
}

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

function isHex64(value: unknown): value is string {
  return typeof value === 'string' && /^[a-f0-9]{64}$/.test(value)
}

function digestBytes(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex')
}

export function pinnedSkillHost(value: unknown): string {
  const host = value === undefined || value === '' ? PINNED_SKILL_HOST : value
  if (typeof host !== 'string' || !HOST_PATTERN.test(host)) {
    throw new AnvilError(ErrorCode.ConfigInvalid, 'The pinned-skill host is not a valid hostname.', {
      hint: `Use --host ${PINNED_SKILL_HOST}; v1 supports GitHub only.`,
    })
  }
  if (host !== PINNED_SKILL_HOST) {
    throw new AnvilError(ErrorCode.UnsupportedHost, `pinned-skill/v1 supports ${PINNED_SKILL_HOST} only`, {
      hint: 'Fetching from another host is not supported in v1.',
    })
  }
  return host
}

export function pinnedSkillRepo(value: unknown): string {
  if (typeof value !== 'string' || value === '') {
    throw new AnvilError(ErrorCode.ConfigInvalid, 'pinned-skill requires --repo <owner/name>', {
      hint: 'Pass the GitHub repository as owner/name.',
    })
  }
  const parts = value.split('/')
  const valid =
    parts.length === 2 &&
    parts.every(
      (part) =>
        part.length > 0 &&
        part.length <= MAX_REPO_COMPONENT &&
        REPO_COMPONENT_PATTERN.test(part) &&
        part !== '.' &&
        part !== '..',
    )
  if (!valid) {
    throw new AnvilError(ErrorCode.ConfigInvalid, 'The pinned-skill repository is not owner/name.', {
      hint: 'Use a GitHub repository such as tecruz/anvil.',
    })
  }
  return value
}

export function pinnedSkillCommit(value: unknown): string {
  if (typeof value !== 'string' || !COMMIT_PATTERN.test(value)) {
    throw new AnvilError(ErrorCode.ConfigInvalid, 'pinned-skill requires a full 40-hex commit SHA', {
      hint: 'A branch or tag is mutable. Run setup fetch --ref <ref>, then plan with the resolved --commit.',
    })
  }
  return value
}

export function pinnedSkillRef(value: unknown): string {
  if (typeof value !== 'string' || value === '' || value.length > MAX_REF_LENGTH) {
    throw new AnvilError(ErrorCode.ConfigInvalid, 'setup fetch requires --ref <commit-sha|tag|branch>', {
      hint: 'The ref is resolved to a full commit SHA before any bytes are fetched.',
    })
  }
  if (value.startsWith('-') || /[\u0000-\u001f]/.test(value)) {
    throw new AnvilError(ErrorCode.ConfigInvalid, 'The pinned-skill ref contains unsafe characters.')
  }
  return value
}

export function pinnedSkillPath(value: unknown): string {
  if (typeof value !== 'string' || !isSafeSetupExecutionPath(value)) {
    throw new AnvilError(ErrorCode.ConfigInvalid, 'pinned-skill requires a safe repository path', {
      hint: 'Use a forward-slash path such as skills/release-notes/SKILL.md with no parent traversal.',
    })
  }
  return value
}

export function pinnedSkillName(value: unknown): string {
  if (typeof value !== 'string' || !isValidSetupSkillName(value)) {
    throw new AnvilError(ErrorCode.ConfigInvalid, 'The pinned-skill name is invalid.', {
      hint: 'Use lowercase letters, digits and single hyphens, at most 255 characters.',
    })
  }
  if (RESERVED_SKILL_NAMES.has(value)) {
    throw new AnvilError(ErrorCode.ConfigInvalid, `The skill name "${value}" is reserved for anvil init`, {
      hint: 'Choose another name; the generated verify skill owns that path.',
    })
  }
  return value
}

export function pinnedSkillOriginUrl(host: string, repo: string, commit: string, path: string): string {
  return `https://${host}/${repo}/blob/${commit}/${path}`
}

/** The stable id of one origin. Content is deliberately not part of it. */
export function pinnedSkillOriginId(origin: Pick<SetupOrigin, 'host' | 'repo' | 'commit' | 'path'>): string {
  return digestJson({ host: origin.host, repo: origin.repo, commit: origin.commit, path: origin.path })
}

export function pinnedSkillCacheRoot(env: NodeJS.ProcessEnv = process.env): string {
  return join(approvalStoreDir(env), 'fetched')
}

export function pinnedSkillBlobPath(blobSha256: string, env: NodeJS.ProcessEnv = process.env): string {
  if (!isHex64(blobSha256)) throw new AnvilError(ErrorCode.Internal, 'The pinned-skill blob name is malformed.')
  return join(pinnedSkillCacheRoot(env), 'blobs', blobSha256)
}

export function pinnedSkillOriginPath(
  origin: Pick<SetupOrigin, 'host' | 'repo' | 'commit' | 'path'>,
  env: NodeJS.ProcessEnv = process.env,
): string {
  return join(pinnedSkillCacheRoot(env), 'origins', `${pinnedSkillOriginId(origin)}.json`)
}

export function pinnedSkillOriginOf(request: PinnedSkillRequest): SetupOrigin {
  return {
    host: request.host,
    repo: request.repo,
    commit: request.commit,
    path: request.path,
    url: pinnedSkillOriginUrl(request.host, request.repo, request.commit, request.path),
  }
}

/** Validate an untrusted origin record saved by `setup fetch`. Exact keys, exact grammar. */
export function parsePinnedSkillOriginRecord(value: unknown): PinnedSkillOriginRecord | null {
  if (!isPlainObject(value) || !hasExactKeys(value, ORIGIN_KEYS)) return null
  if (value.schemaVersion !== 1 || value.kind !== PINNED_SKILL_ORIGIN_KIND) return null
  if (typeof value.host !== 'string' || value.host !== PINNED_SKILL_HOST) return null
  if (typeof value.repo !== 'string' || typeof value.commit !== 'string' || !COMMIT_PATTERN.test(value.commit)) {
    return null
  }
  if (typeof value.path !== 'string' || !isSafeSetupExecutionPath(value.path)) return null
  if (!isHex64(value.blobSha256)) return null
  if (typeof value.bytes !== 'number' || !Number.isInteger(value.bytes) || value.bytes < 0) return null
  if (value.bytes > MAX_SOURCE_BYTES) return null
  if (typeof value.fetchedAt !== 'string' || Number.isNaN(Date.parse(value.fetchedAt))) return null
  if (
    typeof value.requestedRef !== 'string' ||
    value.requestedRef === '' ||
    value.requestedRef.length > MAX_REF_LENGTH
  ) {
    return null
  }
  if (typeof value.url !== 'string') return null
  if (value.url !== pinnedSkillOriginUrl(value.host, value.repo, value.commit, value.path)) return null
  try {
    if (
      value.repo !== pinnedSkillRepo(value.repo) ||
      value.path !== pinnedSkillPath(value.path) ||
      value.host !== pinnedSkillHost(value.host)
    ) {
      return null
    }
  } catch {
    return null
  }
  return value as unknown as PinnedSkillOriginRecord
}

export type PinnedSkillOriginRead =
  | { state: 'present'; record: PinnedSkillOriginRecord }
  | { state: 'absent' }
  | { state: 'unknown'; reason: string }
  | { state: 'invalid'; reason: string }

/** Read only the immutable origin record, without touching the blob. */
export function readPinnedSkillOrigin(
  request: Pick<PinnedSkillRequest, 'host' | 'repo' | 'commit' | 'path'>,
  env: NodeJS.ProcessEnv = process.env,
): PinnedSkillOriginRead {
  const read = readPrivateStoreRecord(approvalStoreDir(env), pinnedSkillOriginPath(request, env))
  if (read.state === 'absent') return { state: 'absent' }
  if (read.state === 'unknown') return { state: 'unknown', reason: read.reason }
  let parsed: unknown
  try {
    parsed = JSON.parse(read.bytes.toString('utf8'))
  } catch {
    return { state: 'invalid', reason: 'The pinned-skill origin record is not valid JSON.' }
  }
  const record = parsePinnedSkillOriginRecord(parsed)
  if (record === null) return { state: 'invalid', reason: 'The pinned-skill origin record is malformed.' }
  if (
    record.host !== request.host ||
    record.repo !== request.repo ||
    record.commit !== request.commit ||
    record.path !== request.path
  ) {
    return { state: 'invalid', reason: 'The pinned-skill origin record names a different origin.' }
  }
  return { state: 'present', record }
}

export type PinnedSkillContentRead =
  | { state: 'present'; record: PinnedSkillOriginRecord; content: string }
  | { state: 'absent'; reason: string }
  | { state: 'unknown'; reason: string }
  | { state: 'invalid'; reason: string }

/**
 * Read the frozen bytes for one origin, re-hashing them against their content address.
 *
 * A missing origin or blob is `unknown`: there is nothing to plan from, and the remedy is an
 * explicit fetch. A record or blob that does not match its own address is `invalid`: the
 * cache has been tampered with or corrupted, and it must not become a plan.
 */
export function readPinnedSkillContent(
  request: Pick<PinnedSkillRequest, 'host' | 'repo' | 'commit' | 'path'>,
  env: NodeJS.ProcessEnv = process.env,
): PinnedSkillContentRead {
  const origin = readPinnedSkillOrigin(request, env)
  if (origin.state !== 'present') {
    if (origin.state === 'absent') {
      return {
        state: 'absent',
        reason: `No fetched bytes are cached for ${pinnedSkillOriginUrl(request.host, request.repo, request.commit, request.path)}.`,
      }
    }
    return origin
  }
  const record = origin.record
  const blob = readPrivateStoreRecord(
    approvalStoreDir(env),
    pinnedSkillBlobPath(record.blobSha256, env),
    MAX_SOURCE_BYTES,
  )
  if (blob.state === 'absent') {
    return { state: 'unknown', reason: 'The origin record exists but its frozen bytes are missing.' }
  }
  if (blob.state === 'unknown') return { state: 'unknown', reason: blob.reason }
  const bytes = blob.bytes
  if (bytes.length !== record.bytes) {
    return { state: 'invalid', reason: 'The frozen bytes do not match the size in the origin record.' }
  }
  if (digestBytes(bytes) !== record.blobSha256) {
    return { state: 'invalid', reason: 'The frozen bytes do not hash to the content address in the origin record.' }
  }
  let content: string
  try {
    content = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes)
  } catch {
    return { state: 'invalid', reason: 'The frozen bytes are not valid UTF-8.' }
  }
  return { state: 'present', record, content }
}

export function parsePinnedSkillRequest(values: Record<string, unknown>): PinnedSkillRequest {
  if (values.ref !== undefined) {
    throw new AnvilError(ErrorCode.Usage, 'setup plan does not take --ref', {
      hint: 'Run setup fetch --ref <ref> first, then plan with the resolved --commit.',
    })
  }
  return {
    adapter: PINNED_SKILL_ADAPTER,
    host: pinnedSkillHost(values.host),
    repo: pinnedSkillRepo(values.repo),
    commit: pinnedSkillCommit(values.commit),
    path: pinnedSkillPath(values.path),
    name: pinnedSkillName(values.name),
  }
}

/**
 * Build an inspect-only plan from frozen cache bytes. Reads only the protected store and the
 * repository's destination; never the network.
 */
export function buildPinnedSkillPlan(options: {
  repository: SetupRepositoryState
  request: PinnedSkillRequest
  env?: NodeJS.ProcessEnv
}): PinnedSkillExecutionPlan {
  const { repository, request } = options
  const env = options.env ?? process.env
  const read = readPinnedSkillContent(request, env)
  if (read.state === 'absent') {
    throw new SetupExecutionError('unknown', `${read.reason} Run setup fetch first.`, {
      hint: 'Planning is offline; only setup fetch downloads bytes.',
    })
  }
  if (read.state === 'unknown') throw new SetupExecutionError('unknown', read.reason)
  if (read.state === 'invalid') throw new AnvilError(ErrorCode.ConfigInvalid, read.reason)

  const root = resolvedSetupRepositoryRoot(repository.root)
  const { destination, directories } = inspectSetupSkillDestination(root, request.name)
  const validation = validateArtifact(destination, read.content)
  if (!validation.ok) {
    throw new SetupExecutionError('stale', `The fetched file is not a valid skill: ${validation.errors.join('; ')}`, {
      hint: 'Fix the SKILL.md at the pinned commit before planning an installation.',
    })
  }

  const origin = pinnedSkillOriginOf(request)
  const sha256 = read.record.blobSha256
  const bytes = read.record.bytes
  const operations: SetupExecutionOperation[] = [
    { id: 'directory:.agents', kind: 'ensure-directory', path: '.agents', precondition: 'absent-or-real-directory' },
    {
      id: 'directory:.agents/skills',
      kind: 'ensure-directory',
      path: '.agents/skills',
      precondition: 'absent-or-real-directory',
    },
    {
      id: `directory:.agents/skills/${request.name}`,
      kind: 'create-directory',
      path: `.agents/skills/${request.name}`,
      precondition: 'absent',
    },
    {
      id: `file:${destination}`,
      kind: 'write-file',
      path: destination,
      precondition: 'absent',
      source: origin.url,
      sha256,
      bytes,
      overwrite: false,
      publish: 'temp-file-no-replace',
    },
  ]

  const warnings = [
    'Planning only: building or validating a plan never approves or applies it. Approval and application are separate commands.',
    `The commit pins the exact bytes GitHub serves for ${request.repo}@${request.commit}:${request.path}. It does not establish authorship, review, licensing or safety.`,
    `The bytes come from the protected fetch cache recorded at ${read.record.fetchedAt}. Planning, validation, approval and application make no network calls.`,
    'Only a standalone SKILL.md is supported. No scripts, commands, global installs or overwrites are performed.',
    'A verifier can only prove that the approved artifact was installed; it cannot prove that an agent loaded or followed it.',
    'Filesystem checks reduce accidental overwrites but are not an operating-system sandbox against concurrent path changes.',
  ]
  if (repository.head === null || repository.worktree !== 'clean') {
    warnings.push('Repository state is not a clean commit; this plan cannot pass current-plan validation.')
  }
  for (const warning of validation.warnings) warnings.push(`Skill validation warning: ${warning}`)

  const payload = {
    schemaVersion: 1 as const,
    kind: 'setup-execution-plan' as const,
    status: 'proposed' as const,
    executed: false as const,
    approval: 'not-granted' as const,
    executionSupported: true as const,
    adapter: PINNED_SKILL_ADAPTER as typeof PINNED_SKILL_ADAPTER,
    adapterFingerprint: PINNED_SKILL_ADAPTER_FINGERPRINT,
    repository: { root: repository.root, head: repository.head, worktree: repository.worktree },
    inputsDigest: digestJson({
      adapter: PINNED_SKILL_ADAPTER,
      adapterFingerprint: PINNED_SKILL_ADAPTER_FINGERPRINT,
      host: origin.host,
      repo: origin.repo,
      commit: origin.commit,
      path: origin.path,
      name: request.name,
    }),
    skill: { name: request.name, destination },
    origin,
    source: { sha256, bytes, content: read.content },
    operations,
    effects: {
      kind: 'filesystem-only' as const,
      directories,
      files: [{ path: destination, sha256, bytes }],
      overwrite: false as const,
      delete: false as const,
      processes: false as const,
      network: false as const,
      credentials: false as const,
    },
    verification: {
      id: 'pinned-skill-installed/v1',
      scope: 'artifact-installed' as const,
      checks: [
        'destination-inside-repository',
        'destination-regular-file',
        'installed-bytes-match-approved-sha256',
        'skill-metadata-valid',
      ],
      proves: `Only that the reviewed bytes from ${request.repo}@${request.commit}:${request.path} are present at the destination with valid skill metadata. It does not prove that an agent loaded, followed or successfully used the skill.`,
    },
    warnings,
  }
  return { ...payload, digest: digestJson(payload) }
}

/**
 * Extract only the bounded adapter inputs from an untrusted saved plan. Nothing here trusts
 * the saved content: the plan is rebuilt from the cache and compared whole.
 */
export function extractPinnedSkillRequest(saved: unknown): PinnedSkillRequest {
  if (!isPlainObject(saved)) {
    throw new AnvilError(ErrorCode.ConfigInvalid, 'Expected a setup-execution-plan JSON object')
  }
  if (saved.schemaVersion !== 1 || saved.kind !== 'setup-execution-plan' || typeof saved.digest !== 'string') {
    throw new AnvilError(ErrorCode.ConfigInvalid, 'Unsupported setup-execution-plan format.')
  }
  if (saved.adapter !== PINNED_SKILL_ADAPTER) {
    throw new AnvilError(ErrorCode.ConfigInvalid, 'Unsupported setup execution adapter.')
  }
  const skill = saved.skill
  if (!isPlainObject(skill) || typeof skill.name !== 'string') {
    throw new AnvilError(ErrorCode.ConfigInvalid, 'The saved plan has an invalid skill name.')
  }
  const name = pinnedSkillName(skill.name)
  if (skill.destination !== `.agents/skills/${name}/SKILL.md`) {
    throw new AnvilError(ErrorCode.ConfigInvalid, 'The saved plan has an inconsistent skill destination.')
  }
  const origin = saved.origin
  if (!isPlainObject(origin) || !hasExactKeys(origin, ORIGIN_BLOCK_KEYS)) {
    throw new AnvilError(ErrorCode.ConfigInvalid, 'The saved plan has no usable origin block.')
  }
  const request: PinnedSkillRequest = {
    adapter: PINNED_SKILL_ADAPTER,
    host: pinnedSkillHost(origin.host),
    repo: pinnedSkillRepo(origin.repo),
    commit: pinnedSkillCommit(origin.commit),
    path: pinnedSkillPath(origin.path),
    name,
  }
  const originValues = pinnedSkillOriginOf(request)
  if (
    originValues.host !== origin.host ||
    originValues.repo !== origin.repo ||
    originValues.commit !== origin.commit ||
    originValues.path !== origin.path ||
    originValues.url !== origin.url
  ) {
    throw new AnvilError(ErrorCode.ConfigInvalid, 'The saved plan origin block is inconsistent.')
  }
  return request
}

/** Rebuild a saved pinned-skill plan from the cache and compare it with current state. */
export function resolvePinnedSkillPlan(
  saved: unknown,
  repository: SetupRepositoryState,
  env: NodeJS.ProcessEnv = process.env,
): SetupExecutionPlanResolution {
  let request: PinnedSkillRequest
  try {
    request = extractPinnedSkillRequest(saved)
  } catch (cause) {
    return {
      plan: null,
      validation: {
        schemaVersion: 1,
        status: 'invalid',
        approval: 'not-granted',
        executed: false,
        reason: cause instanceof Error ? cause.message : 'Unsupported pinned-skill plan.',
      },
    }
  }
  let current: PinnedSkillExecutionPlan
  try {
    current = buildPinnedSkillPlan({ repository, request, env })
  } catch (cause) {
    if (cause instanceof SetupExecutionError) {
      return {
        plan: null,
        validation: {
          schemaVersion: 1,
          status: cause.validationStatus,
          approval: 'not-granted',
          executed: false,
          reason: cause.message,
        },
      }
    }
    if (cause instanceof AnvilError) {
      return {
        plan: null,
        validation: {
          schemaVersion: 1,
          status: 'invalid',
          approval: 'not-granted',
          executed: false,
          reason: cause.message,
        },
      }
    }
    throw cause
  }
  return { plan: current, validation: validateSetupExecutionPlan(saved, current) }
}

/** What a grant v2 duplicates: an origin, the frozen content identity and the destination. */
export function pinnedSkillBindings(plan: PinnedSkillExecutionPlan): PinnedSkillBindings {
  return {
    origin: plan.origin,
    content: { sha256: plan.source.sha256, bytes: plan.source.bytes },
    skill: { name: plan.skill.name, destination: plan.skill.destination },
  }
}

/** Strict parser for a grant v2 `bindings` object. Unknown keys or fields are rejected. */
export function parsePinnedSkillBindings(value: unknown): PinnedSkillBindings | null {
  if (!isPlainObject(value) || !hasExactKeys(value, BINDING_KEYS)) return null
  const origin = value.origin
  if (!isPlainObject(origin) || !hasExactKeys(origin, ORIGIN_BLOCK_KEYS)) return null
  if (
    typeof origin.host !== 'string' ||
    typeof origin.repo !== 'string' ||
    typeof origin.commit !== 'string' ||
    !COMMIT_PATTERN.test(origin.commit) ||
    typeof origin.path !== 'string' ||
    typeof origin.url !== 'string'
  ) {
    return null
  }
  let parsedOrigin: SetupOrigin
  try {
    parsedOrigin = pinnedSkillOriginOf({
      adapter: PINNED_SKILL_ADAPTER,
      host: pinnedSkillHost(origin.host),
      repo: pinnedSkillRepo(origin.repo),
      commit: pinnedSkillCommit(origin.commit),
      path: pinnedSkillPath(origin.path),
      name: 'placeholder',
    })
  } catch {
    return null
  }
  if (parsedOrigin.url !== origin.url) return null
  const content = value.content
  if (!isPlainObject(content) || !hasExactKeys(content, CONTENT_KEYS)) return null
  if (!isHex64(content.sha256)) return null
  if (typeof content.bytes !== 'number' || !Number.isInteger(content.bytes)) return null
  if (content.bytes < 0 || content.bytes > MAX_SOURCE_BYTES) return null
  const skill = value.skill
  if (!isPlainObject(skill) || !hasExactKeys(skill, SKILL_KEYS)) return null
  if (typeof skill.name !== 'string' || typeof skill.destination !== 'string') return null
  let name: string
  try {
    name = pinnedSkillName(skill.name)
  } catch {
    return null
  }
  if (skill.destination !== `.agents/skills/${name}/SKILL.md`) return null
  return {
    origin: parsedOrigin,
    content: { sha256: content.sha256, bytes: content.bytes },
    skill: { name, destination: skill.destination },
  }
}

/** Plan fields a grant binding rebuild depends on. */
export function pinnedSkillRequestFromBindings(bindings: PinnedSkillBindings): PinnedSkillRequest {
  return {
    adapter: PINNED_SKILL_ADAPTER,
    host: bindings.origin.host,
    repo: bindings.origin.repo,
    commit: bindings.origin.commit,
    path: bindings.origin.path,
    name: bindings.skill.name,
  }
}
