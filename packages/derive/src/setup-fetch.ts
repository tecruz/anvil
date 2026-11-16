/**
 * `setup fetch`: the only network operation in the setup adapters.
 *
 * Fetching is explicit, separate and reviewable. It resolves a mutable ref to a full commit,
 * downloads one file at that commit from an explicit host, and freezes the bytes in the
 * protected store. From then on `plan`, `validate`, `approve` and `apply` read only that
 * frozen cache, so they never touch the network.
 *
 * The bytes and their origin are separate records. Bytes are content-addressed
 * (`fetched/blobs/<sha256>`); an immutable origin record names the commit and path that
 * produced them. Both are written no-replace: a second fetch of the same origin that yields
 * different bytes is a conflict, because a commit cannot change content. Concurrent fetches
 * race on no-replace, and the loser re-reads and compares rather than overwriting.
 *
 * `gh` is resolved to an absolute path outside the checkout, or the fetch refuses. A binary
 * found inside the repository is not trusted to authenticate against it, and the default
 * runner is a test seam rather than a security boundary.
 */
import { createHash } from 'node:crypto'
import { realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { isAbsolute, relative, sep } from 'node:path'
import { AnvilError, ErrorCode, type ProcessResult, resolveCommand, runProcess } from '@anvil/core'
import {
  ensurePrivateStoreDirectory,
  prepareSetupStore,
  readPrivateStoreRecord,
  writePrivateStoreFileOnce,
} from './setup-approval.ts'
import { MAX_SOURCE_BYTES, type SetupOrigin } from './setup-execution.ts'
import {
  PINNED_SKILL_ORIGIN_KIND,
  type PinnedSkillOriginRecord,
  parsePinnedSkillOriginRecord,
  pinnedSkillBlobPath,
  pinnedSkillCommit,
  pinnedSkillHost,
  pinnedSkillName,
  pinnedSkillOriginOf,
  pinnedSkillOriginPath,
  pinnedSkillPath,
  pinnedSkillRef,
  pinnedSkillRepo,
  readPinnedSkillOrigin,
} from './setup-pinned-skill.ts'

/** GitHub's REST responses for one bounded skill file stay comfortably inside this. */
const MAX_GH_OUTPUT_BYTES = 512 * 1024
const DEFAULT_TIMEOUT_MS = 20_000
const AUTH_PATTERN = /authenticat|authoriz|bad credentials|not logged in|gh auth login|\b401\b|\b403\b/i

/** The injected runner a test uses; the default is the real `gh` resolved below. */
export type SetupFetchGhRun = (args: string[]) => Promise<ProcessResult>

export interface SetupFetchOptions {
  /** The repository the store must stay outside of. */
  repositoryRoot: string
  host?: string | undefined
  repo: string
  /** A commit SHA, tag or branch. Resolved to a full commit SHA before downloading. */
  ref?: string | undefined
  /** An already-resolved full commit SHA. Exactly one of ref/commit is required. */
  commit?: string | undefined
  path: string
  name: string
  env?: NodeJS.ProcessEnv
  now?: Date
  timeoutMs?: number
  /** Test seam. When omitted, `gh` is resolved to an absolute path outside the checkout. */
  gh?: SetupFetchGhRun
}

export interface PinnedSkillFetchResult {
  schemaVersion: 1
  kind: 'setup-fetch'
  status: 'fetched' | 'cached'
  /** True when this call added new bytes or an origin record. */
  wrote: boolean
  origin: SetupOrigin
  record: PinnedSkillOriginRecord
}

function digestBytes(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex')
}

function isInside(root: string, candidate: string): boolean {
  const rel = relative(root, candidate)
  return rel !== '' && rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel)
}

/**
 * Resolve `gh` the way `ready` resolves tools: an absolute path, checked to be outside the
 * repository that is asking for the fetch. A shim inside the checkout could be a committed
 * script, so its mere presence is a refusal, not a preference.
 */
function resolveFetchGh(repositoryRoot: string, env: NodeJS.ProcessEnv): string {
  const resolved = resolveCommand('gh', { env })
  if (resolved === null) {
    throw new AnvilError(ErrorCode.ToolMissing, 'setup fetch requires the GitHub CLI (`gh`)', {
      hint: 'Install gh from https://cli.github.com and run `gh auth login`, then retry.',
    })
  }
  let real: string
  try {
    real = realpathSync.native(resolved.path)
  } catch {
    throw new AnvilError(ErrorCode.ToolMissing, 'setup fetch could not resolve the GitHub CLI', {
      hint: 'Install gh from https://cli.github.com and make sure it is on PATH.',
    })
  }
  if (isInside(repositoryRoot, real)) {
    throw new AnvilError(ErrorCode.ToolMissing, 'setup fetch refused a GitHub CLI resolved inside the repository', {
      hint: 'Remove the repository-local gh shim and use a GitHub CLI installed outside this checkout.',
    })
  }
  return resolved.path
}

/** Keep a failing `gh` message useful without echoing credentials or headers. */
function sanitize(detail: string): string {
  const first = detail.split('\n')[0]?.trim() ?? ''
  return first
    .replace(/\bgh[pousr]_[A-Za-z0-9]{20,}\b/g, '[redacted]')
    .replace(/\bgithub_pat_[A-Za-z0-9_]{20,}\b/g, '[redacted]')
    .slice(0, 300)
}

function failedCommand(args: readonly string[], result: ProcessResult): AnvilError {
  const detail = sanitize(result.stderr !== '' ? result.stderr : result.stdout)
  const suffix = detail === '' ? `gh exited ${String(result.exitCode)}` : detail
  if (AUTH_PATTERN.test(detail)) {
    return new AnvilError(ErrorCode.AuthFailed, `GitHub CLI could not authenticate: ${suffix}`, {
      hint: 'Run `gh auth status`; a token needs access to this repository.',
    })
  }
  return new AnvilError(ErrorCode.PreflightFailed, `setup fetch could not query github.com: ${suffix}`, {
    hint: `Check the repository, ref and path, and that you can reach github.com. The command was: gh ${args.join(' ')}`,
  })
}

function runner(options: SetupFetchOptions): SetupFetchGhRun {
  if (options.gh !== undefined) return options.gh
  const env = options.env ?? process.env
  const repositoryRoot = options.repositoryRoot
  const bin = resolveFetchGh(repositoryRoot, env)
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  return async (args) => {
    try {
      return await runProcess(bin, args, {
        cwd: tmpdir(),
        env,
        timeoutMs,
        maxBuffer: MAX_GH_OUTPUT_BYTES,
      })
    } catch (cause) {
      if (cause instanceof AnvilError && cause.code === ErrorCode.ToolMissing) throw cause
      throw new AnvilError(ErrorCode.PreflightFailed, 'setup fetch could not run the GitHub CLI', {
        hint: 'Check that gh is installed, authenticated and able to reach github.com.',
        cause,
      })
    }
  }
}

function assertOk(args: readonly string[], result: ProcessResult): void {
  if (result.exitCode !== 0) throw failedCommand(args, result)
}

function encodedPath(path: string): string {
  return path
    .split('/')
    .map((segment) => encodeURIComponent(segment))
    .join('/')
}

function resolvedCommitFrom(text: string): string | null {
  const direct = text.trim()
  if (/^[0-9a-f]{40}$/.test(direct)) return direct
  try {
    const parsed: unknown = JSON.parse(direct)
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
      const sha = (parsed as Record<string, unknown>).sha
      if (typeof sha === 'string' && /^[0-9a-f]{40}$/.test(sha)) return sha
    }
  } catch {
    // Not JSON. The direct form above is the only other accepted shape.
  }
  return null
}

async function resolveRef(gh: SetupFetchGhRun, repo: string, ref: string): Promise<string> {
  const args = ['api', '-H', 'Accept: application/vnd.github.sha', `repos/${repo}/commits/${encodeURIComponent(ref)}`]
  const result = await gh(args)
  assertOk(args, result)
  const commit = resolvedCommitFrom(result.stdout)
  if (commit === null) {
    throw new AnvilError(ErrorCode.PreflightFailed, 'GitHub did not return a full commit SHA for the requested ref', {
      hint: 'Use a commit SHA, tag or branch that exists in the repository.',
    })
  }
  return commit
}

interface DownloadedFile {
  bytes: Buffer
  sha256: string
}

async function downloadFile(gh: SetupFetchGhRun, repo: string, commit: string, path: string): Promise<DownloadedFile> {
  const args = ['api', '-X', 'GET', `repos/${repo}/contents/${encodedPath(path)}?ref=${commit}`]
  const result = await gh(args)
  assertOk(args, result)
  let parsed: unknown
  try {
    parsed = JSON.parse(result.stdout)
  } catch {
    throw new AnvilError(ErrorCode.PreflightFailed, 'GitHub returned an unreadable file response', {
      hint: 'Retry the fetch. Nothing was cached.',
    })
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new AnvilError(ErrorCode.PreflightFailed, 'GitHub returned an unexpected file response')
  }
  const body = parsed as Record<string, unknown>
  if (body.type !== 'file') {
    throw new AnvilError(ErrorCode.PreflightFailed, 'The requested GitHub path is not a regular file', {
      hint: 'Use the repository-relative path to one SKILL.md file.',
    })
  }
  if (typeof body.size !== 'number' || !Number.isInteger(body.size) || body.size < 0) {
    throw new AnvilError(ErrorCode.PreflightFailed, 'GitHub did not report the file size')
  }
  if (body.size > MAX_SOURCE_BYTES) {
    throw new AnvilError(
      ErrorCode.PreflightFailed,
      `The pinned file is larger than ${String(MAX_SOURCE_BYTES)} bytes`,
      {
        hint: 'A setup skill is bounded so its bytes can be reviewed as one plan.',
      },
    )
  }
  if (body.encoding !== 'base64' || typeof body.content !== 'string') {
    throw new AnvilError(ErrorCode.PreflightFailed, 'GitHub did not return base64 file content')
  }
  const base64 = body.content.replace(/\s+/g, '')
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(base64) || base64.length % 4 !== 0) {
    throw new AnvilError(ErrorCode.PreflightFailed, 'GitHub returned malformed file content')
  }
  const bytes = Buffer.from(base64, 'base64')
  if (bytes.length !== body.size || bytes.length > MAX_SOURCE_BYTES) {
    throw new AnvilError(ErrorCode.PreflightFailed, 'The downloaded bytes do not match the reported file size', {
      hint: 'Retry the fetch. Nothing was cached.',
    })
  }
  return { bytes, sha256: digestBytes(bytes) }
}

function conflict(url: string, detail: string): AnvilError {
  return new AnvilError(
    ErrorCode.PreflightFailed,
    `The protected fetch cache already records different content for ${url}: ${detail}`,
    {
      hint: 'A commit cannot change content. Inspect the protected store; do not delete records to force a refetch.',
    },
  )
}

function writeBlob(blobPath: string, bytes: Buffer, sha256: string, url: string): void {
  const written = writePrivateStoreFileOnce(blobPath, bytes)
  const read = readPrivateStoreRecord(blobPath, MAX_SOURCE_BYTES)
  if (read.state === 'absent') throw conflict(url, 'the frozen bytes disappeared during publication')
  if (read.state === 'unknown') throw conflict(url, read.reason)
  if (read.bytes.length !== bytes.length || digestBytes(read.bytes) !== sha256) {
    throw conflict(url, 'the stored bytes do not hash to their content address')
  }
  // `written === 'exists'` is an idempotent refetch of the same bytes, or a concurrent
  // winner that wrote the same content. The content address above is the authority.
  void written
}

function writeOrigin(originPath: string, record: PinnedSkillOriginRecord): 'written' | 'exists' {
  const written = writePrivateStoreFileOnce(originPath, `${JSON.stringify(record, null, 2)}\n`)
  if (written === 'written') return 'written'
  const read = readStoreOrigin(originPath)
  if (read.state !== 'present') {
    throw conflict(
      record.url,
      read.state === 'unknown' ? read.reason : 'the origin record disappeared during publication',
    )
  }
  const existing = read.record
  if (existing.blobSha256 !== record.blobSha256 || existing.bytes !== record.bytes) {
    throw conflict(record.url, 'a different blob is already recorded for this commit and path')
  }
  return 'exists'
}

type StoreOriginRead =
  | { state: 'present'; record: PinnedSkillOriginRecord }
  | { state: 'absent' }
  | { state: 'unknown'; reason: string }

function readStoreOrigin(originPath: string): StoreOriginRead {
  const read = readPrivateStoreRecord(originPath, 256 * 1024)
  if (read.state === 'absent') return { state: 'absent' }
  if (read.state === 'unknown') return { state: 'unknown', reason: read.reason }
  let parsed: unknown
  try {
    parsed = JSON.parse(read.bytes.toString('utf8'))
  } catch {
    return { state: 'unknown', reason: 'the stored origin record is not valid JSON' }
  }
  const record = parsePinnedSkillOriginRecord(parsed)
  if (record === null) return { state: 'unknown', reason: 'the stored origin record is malformed' }
  return { state: 'present', record }
}

/**
 * Fetch one file at one commit into the protected cache. Network access happens here and
 * nowhere else in the setup flow.
 */
export async function fetchPinnedSkill(options: SetupFetchOptions): Promise<PinnedSkillFetchResult> {
  const env = options.env ?? process.env
  const host = pinnedSkillHost(options.host)
  const repo = pinnedSkillRepo(options.repo)
  const path = pinnedSkillPath(options.path)
  // Validate the name now so a fetch cannot cache bytes for a plan that could never exist.
  pinnedSkillName(options.name)
  const ref = options.ref === undefined ? null : pinnedSkillRef(options.ref)
  const fixedCommit = options.commit === undefined ? null : pinnedSkillCommit(options.commit)
  if (ref === null && fixedCommit === null) {
    throw new AnvilError(ErrorCode.Usage, 'setup fetch requires --ref <ref> or --commit <40-hex>', {
      hint: 'Pass the ref to resolve, or the full commit SHA you already reviewed.',
    })
  }

  // The store is checked for containment before any directory or file is created.
  const store = prepareSetupStore(options.repositoryRoot, env)
  ensurePrivateStoreDirectory(store, ['fetched', 'blobs'])
  ensurePrivateStoreDirectory(store, ['fetched', 'origins'])

  const gh = runner(options)
  let commit: string
  let requestedRef: string
  if (ref === null) {
    commit = fixedCommit as string
    requestedRef = commit
  } else if (/^[0-9a-f]{40}$/.test(ref)) {
    commit = ref
    requestedRef = ref
    if (fixedCommit !== null && fixedCommit !== commit) {
      throw new AnvilError(ErrorCode.PreflightFailed, '--commit does not match the 40-hex --ref', {
        hint: 'Pass one revision, or make --ref resolve to the commit you passed.',
      })
    }
  } else {
    commit = await resolveRef(gh, repo, ref)
    requestedRef = ref
    if (fixedCommit !== null && fixedCommit !== commit) {
      throw new AnvilError(ErrorCode.PreflightFailed, '--commit does not match the resolved --ref', {
        hint: 'Run setup fetch again and use the commit it reports.',
      })
    }
  }

  const origin = pinnedSkillOriginOf({
    adapter: 'pinned-skill/v1',
    host,
    repo,
    commit,
    path,
    name: options.name,
  })
  const record: PinnedSkillOriginRecord = {
    schemaVersion: 1,
    kind: PINNED_SKILL_ORIGIN_KIND,
    host,
    repo,
    commit,
    path,
    blobSha256: '',
    bytes: 0,
    fetchedAt: (options.now ?? new Date()).toISOString(),
    requestedRef,
    url: origin.url,
  }

  // A present origin is authoritative for the bytes it names. Refuse a second fetch that
  // would disagree with it before downloading anything.
  const existing = readPinnedSkillOrigin({ host, repo, commit, path }, env)
  if (existing.state === 'invalid') throw conflict(origin.url, existing.reason)

  const downloaded = await downloadFile(gh, repo, commit, path)
  const frozen: PinnedSkillOriginRecord = {
    ...record,
    blobSha256: downloaded.sha256,
    bytes: downloaded.bytes.length,
  }

  if (existing.state === 'present') {
    const current = existing.record
    if (current.blobSha256 !== frozen.blobSha256 || current.bytes !== frozen.bytes) {
      throw conflict(origin.url, 'the cached origin names different bytes for this commit')
    }
    // Keep the original fetchedAt: freezing happened once, and re-fetching must not move an
    // approved plan's identity.
    writeBlob(pinnedSkillBlobPath(current.blobSha256, env), downloaded.bytes, downloaded.sha256, origin.url)
    return { schemaVersion: 1, kind: 'setup-fetch', status: 'cached', wrote: false, origin, record: current }
  }
  if (existing.state === 'unknown') {
    throw conflict(origin.url, existing.reason)
  }

  writeBlob(pinnedSkillBlobPath(frozen.blobSha256, env), downloaded.bytes, frozen.blobSha256, origin.url)
  const written = writeOrigin(pinnedSkillOriginPath({ host, repo, commit, path }, env), frozen)
  if (written === 'exists') {
    const after = readStoreOrigin(pinnedSkillOriginPath({ host, repo, commit, path }, env))
    if (after.state !== 'present') throw conflict(origin.url, 'the stored origin record cannot be read back')
    if (after.record.blobSha256 !== frozen.blobSha256 || after.record.bytes !== frozen.bytes) {
      throw conflict(origin.url, 'a concurrent fetch recorded different bytes')
    }
    return { schemaVersion: 1, kind: 'setup-fetch', status: 'cached', wrote: false, origin, record: after.record }
  }
  return { schemaVersion: 1, kind: 'setup-fetch', status: 'fetched', wrote: true, origin, record: frozen }
}
