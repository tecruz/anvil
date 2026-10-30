/**
 * Claims: a ticket, a branch, a worktree, and the state that ties them together.
 *
 * The state lives in the **main** worktree (`.anvil/claims.json`) rather than in any
 * worktree, because the worktrees are disposable and the registry must outlive them. A
 * crew of five is five worktrees and one state file, so `anvil status` can answer
 * "what is in flight" from anywhere.
 *
 * The important behaviour here is **refusal**. A claim that cannot succeed should fail
 * before it creates anything, and a claim that would silently collide should be refused
 * rather than renamed:
 *
 *  - A branch that already exists locally or on the remote is refused, not suffixed. A
 *    colliding branch is nearly always a duplicate or stale claim, and appending a
 *    counter hides exactly that.
 *  - Preflight runs before any filesystem or git mutation, so a failed claim leaves no
 *    debris to clean up.
 */

import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { AnvilError, ErrorCode, probeCommandVersion } from '@anvil/core'
import {
  addWorktree,
  branchExists,
  currentBranch,
  deleteBranch,
  environmentNotes,
  git,
  listWorktrees,
  normalizeGitPath,
  type PreflightCheck,
  preflightClaim,
  type RunResult,
  removeWorktree,
  resolveBaseRef,
  type WorktreeStatus,
  withRepoLock,
  worktreeStatus,
} from '@anvil/git'
import { buildProfile } from '@anvil/profile'
import { branchNameFor, type Ticket, type TicketRef } from '@anvil/tickets'
import { type InjectionFinding, renderAgentsOverlay, renderContextBundle } from '@anvil/tickets/context'
import { installPushGuard, type PushGuardResult } from './hooks.ts'
import { checkedStatePath, createStateDirectory } from './state.ts'

export type ClaimState = 'active' | 'shipped' | 'released' | 'stale'

export interface Claim {
  /** The branch-safe key, e.g. `local-3`. */
  key: string
  ticket: TicketRef
  branch: string
  baseBranch: string
  /** The ref the branch was actually created from, e.g. `origin/main`. */
  baseRef: string
  worktreePath: string
  /**
   * The `HEAD` porcelain value recorded for this worktree, for cross-referencing against
   * `git worktree list`. Not a git-assigned stable id (git has none); removal goes by path.
   */
  worktreeId: string | null
  state: ClaimState
  createdAt: string
  agent?: {
    runner: string
    /**
     * The version the runner reported when the claim was made.
     *
     * The path proves *which* binary; the version proves *what* produced the branch, which
     * is the difference between a reproducible claim and a story about one. Absent when the
     * runner could not be asked -- a broken binary must not block the claim.
     */
    version?: string
    /** The agent process id, when one was launched. */
    pid?: number
    /**
     * Legacy: the process id, as a string.
     *
     * This field was named `sessionId` and held the pid, because the launcher had nowhere
     * to put a session id and the name was not checked. Registries written before the
     * rename still carry it, so it is read as a pid and written as `pid`.
     */
    sessionId?: string
    launchedAt?: string
  }
  pr?: { number: number; url: string; state: string }
  lastVerifiedAt?: string
}

export interface ClaimRegistry {
  schemaVersion: 1
  claims: Claim[]
}

export function claimsPath(repoRoot: string): string {
  return join(repoRoot, '.anvil', 'claims.json')
}

export function readClaims(repoRoot: string): ClaimRegistry {
  const path = claimsPath(repoRoot)
  if (!existsSync(path)) return { schemaVersion: 1, claims: [] }
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'))
    if (typeof parsed !== 'object' || parsed === null) return { schemaVersion: 1, claims: [] }
    const reg = parsed as ClaimRegistry
    return Array.isArray(reg.claims) ? reg : { schemaVersion: 1, claims: [] }
  } catch {
    // A corrupt registry must not block work. Losing the registry means an orphaned
    // worktree, which `anvil status --orphan` can find; refusing to run means nothing
    // gets done at all.
    return { schemaVersion: 1, claims: [] }
  }
}

/**
 * Write the claim registry atomically.
 *
 * This file is the only record that a worktree belongs to a claim. A crash or a failed
 * write in the middle of `JSON.stringify` used to leave a truncated file, which `readClaims`
 * treats as an empty registry -- every existing worktree then becomes an orphan. Writing a
 * sibling temp file and renaming it means a reader sees either the previous registry or the
 * complete new one, never half of either.
 */
export function writeClaims(repoRoot: string, registry: ClaimRegistry): void {
  const path = claimsPath(repoRoot)
  checkedStatePath(repoRoot, ['claims.json'])
  createStateDirectory(repoRoot)
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`
  try {
    writeFileSync(temporary, `${JSON.stringify(registry, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' })
    renameSync(temporary, path)
  } catch (err) {
    try {
      unlinkSync(temporary)
    } catch {
      // The temp file may never have been created, or may already be gone.
    }
    throw err
  }
}

/**
 * Serialize the claim registry's read-modify-write cycle across processes.
 *
 * The atomic write stops a truncated file, but not a lost update: two processes that read
 * the same registry and then write their own copy leave only one of the two claims. The
 * lock is per-repository, beside the common git dir, so claims made from different
 * worktrees of the same repository contend on the same file.
 */
export async function withClaimsLock<T>(repoRoot: string, fn: () => Promise<T>): Promise<T> {
  return withRepoLock({ cwd: repoRoot, name: 'claims' }, fn)
}

/**
 * Apply one mutation to the claim registry under the claims lock.
 *
 * The callback is synchronous on purpose: the lock must cover the read, the mutation and
 * the write, and an async callback would invite unrelated work while holding it.
 */
export async function updateClaims(
  repoRoot: string,
  mutate: (registry: ClaimRegistry) => void,
): Promise<ClaimRegistry> {
  return withClaimsLock(repoRoot, async () => {
    const registry = readClaims(repoRoot)
    mutate(registry)
    writeClaims(repoRoot, registry)
    return registry
  })
}

/**
 * The agent session running in a worktree, as recorded by the opencode plugin.
 *
 * The plugin writes `.anvil/session.json` in the worktree it runs in, because that is the
 * only place it knows for certain it is: the session id belongs to a conversation, and the
 * conversation belongs to a directory.
 *
 * The file is written by the plugin rather than by anvil because anvil launches the agent
 * and then has no way to learn which session the agent opened -- opencode chooses the id.
 */
export interface AgentSession {
  sessionId: string
  /** ISO timestamp of when the plugin recorded it. */
  recordedAt?: string
}

/** Where the plugin records the session id inside a worktree. */
export const AGENT_SESSION_FILE = join('.anvil', 'session.json')

/** The agent session recorded for a worktree, or null when there is none. */
export function readAgentSession(worktreePath: string): AgentSession | null {
  const path = join(worktreePath, AGENT_SESSION_FILE)
  if (!existsSync(path)) return null
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'))
    if (typeof parsed !== 'object' || parsed === null) return null
    const record = parsed as { sessionId?: unknown; recordedAt?: unknown }
    if (typeof record.sessionId !== 'string' || record.sessionId.trim() === '') return null
    return {
      sessionId: record.sessionId,
      ...(typeof record.recordedAt === 'string' ? { recordedAt: record.recordedAt } : {}),
    }
  } catch {
    // A half-written file is not a session. The agent is still running either way.
    return null
  }
}

/**
 * The pid of a claim's agent, whether it was recorded as a pid or as the legacy string.
 *
 * Two field names for one value, because the registry is written on disk and read back by
 * versions that disagree about the name.
 */
export function claimAgentPid(claim: Claim): number | null {
  const agent = claim.agent
  if (agent === undefined) return null
  if (typeof agent.pid === 'number' && Number.isFinite(agent.pid)) return agent.pid
  if (typeof agent.sessionId === 'string') {
    const parsed = Number.parseInt(agent.sessionId, 10)
    if (Number.isFinite(parsed)) return parsed
  }
  return null
}

/**
 * Default worktree root.
 *
 * Deliberately *outside* the repository, in a short sibling directory. Nesting worktrees
 * inside the repo puts them on the same filesystem path budget that Windows caps, and
 * makes every recursive tool (search, lint, status) walk them.
 */
export function defaultWorktreeRoot(repoRoot: string, configured: string | null): string {
  if (configured !== null && configured !== '') return resolve(configured)
  const parent = dirname(repoRoot)
  const name = basename(repoRoot)
  return join(parent, `${name}-worktrees`)
}

export interface ClaimOptions {
  repoRoot: string
  ticket: Ticket
  /** Branch prefix; defaults to `feat`. */
  prefix?: string
  /** Override the base branch. */
  base?: string
  /** Configured worktree root, or null for the default. */
  worktreeRoot?: string | null
  /** Directory holding local tickets, for the default provider. */
  ticketsDir?: string
  /** Fetch before branching, serialized by a lock. */
  fetch?: boolean
  runner?: string
  /** Environment for the version probe; tests point PATHEXT/PATH at a stub runner. */
  env?: NodeJS.ProcessEnv
}

export interface ClaimResult {
  claim: Claim
  /** Preflight findings, including the passes, so the user can see what was checked. */
  checks: PreflightCheck[]
  /** Environment notes worth knowing, e.g. submodules need init. */
  notes: string[]
  /** True when the worktree has no upstream yet. */
  needsUpstream: boolean
  /** Instruction-like lines found in the ticket text, reported not removed. */
  injection: InjectionFinding[]
  /** Whether the worktree's pre-push guard was installed. */
  pushGuard: PushGuardResult
}

export async function claimTicket(options: ClaimOptions): Promise<ClaimResult> {
  const { repoRoot, ticket } = options
  const branch = branchNameFor(ticket.ref, ticket.title, options.prefix)

  // 1. Base ref resolution, so a claim forks from the remote rather than a stale local.
  const preferred = options.base ?? ticket.baseBranch ?? null
  const base = await resolveBaseRef(repoRoot, preferred)

  // 2. Refuse a colliding branch *before* touching anything.
  if (await branchExists(repoRoot, branch)) {
    throw new AnvilError(ErrorCode.Usage, `Branch "${branch}" already exists`, {
      hint:
        'A colliding branch is almost always a duplicate or a stale claim, so anvil refuses rather than renaming it. ' +
        'Release the old claim, or pass --prefix to use a different branch.',
      details: { branch },
    })
  }

  // 3. Worktree path, kept short, with a per-claim subdirectory.
  const root = defaultWorktreeRoot(repoRoot, options.worktreeRoot ?? null)
  const safeKey = ticket.ref.key.toLowerCase().replace(/[^a-z0-9._-]+/g, '-')
  const worktreePath = join(root, safeKey)

  // 4. Preflight, before any mutation.
  const baseStatus = await worktreeStatus(repoRoot)
  const pre = preflightClaim({
    root: repoRoot,
    targetPath: worktreePath,
    branch,
    baseDirty: baseStatus.dirty,
  })
  if (!pre.ok) {
    const blocking = pre.checks.filter((c) => !c.ok && c.level === 'block')
    const err = new AnvilError(
      ErrorCode.PreflightFailed,
      `Refusing to claim ${ticket.ref.key}: ${blocking.map((c) => c.detail).join('; ')}`,
      {
        hint: blocking
          .map((c) => c.hint)
          .filter(Boolean)
          .join(' '),
        details: { checks: pre.checks },
      },
    )
    throw err
  }

  // 5. Create. `git worktree add -b` is a single atomic step: a half-created worktree
  //    with no branch is a mess to clean up by hand.
  const added = await addWorktree({
    cwd: repoRoot,
    path: worktreePath,
    branch,
    baseRef: base.ref,
  })
  if (added.exitCode !== 0) {
    throw new AnvilError(
      ErrorCode.PreflightFailed,
      `git worktree add failed: ${added.stderr.trim() || added.stdout.trim()}`,
      {
        hint: 'Check that the base ref exists and the target directory is writable.',
      },
    )
  }

  // 6. From here the worktree exists. Everything between creating it and recording it is
  //    one recoverable unit: a failure must not leave an unregistered worktree and branch
  //    stranded. Nothing after `writeClaims` can fail, so it is deliberately last.
  try {
    // Make the worktree warm: ticket context, AGENTS overlay, and an exclusion so
    // company-internal ticket text stays out of git.
    const profile = buildProfile(worktreePath, {
      root: worktreePath,
      host: null,
      remote: null,
      defaultBranch: null,
    }).profile

    const context = renderContextBundle({ ticket, profile, branch })
    const overlay = renderAgentsOverlay({ ticket, profile })
    // Validate both outputs before the first write: a real parent does not make linked
    // leaf files safe. The hook installer checks its own complete output batch too.
    const contextPath = checkedStatePath(worktreePath, [basename(context.path)])
    const overlayPath = checkedStatePath(worktreePath, [basename(overlay.path)])
    checkedStatePath(worktreePath, ['hooks'], true)
    createStateDirectory(worktreePath)
    writeFileSync(contextPath, context.content, 'utf8')
    writeFileSync(overlayPath, overlay.content, 'utf8')
    const _excluded = await excludeAnvilState(repoRoot)

    // Enforce "agents commit, humans ship" in git rather than in the prompt. A failure
    // here is reported, not fatal: a claim on an old git is still a useful worktree.
    const pushGuard = await installPushGuard({ worktreePath, key: ticket.ref.key })

    const worktrees = await listWorktrees(repoRoot)
    const entry = worktrees.find((w) => w.branch === branch)

    // The path says which binary; the version says what produced the work. Only opencode is
    // probed, because that is the runner whose version the claim is later trying to reproduce;
    // probing arbitrary user commands on every claim would be a surprise side effect.
    const resolvedVersion =
      options.runner !== undefined &&
      basename(options.runner)
        .replace(/\.(?:cmd|bat|exe)$/i, '')
        .toLowerCase() === 'opencode'
        ? await probeCommandVersion(options.runner, {
            cwd: repoRoot,
            ...(options.env === undefined ? {} : { env: options.env }),
          })
        : null

    const claim: Claim = {
      key: ticket.ref.key,
      ticket: ticket.ref,
      branch,
      baseBranch: preferred ?? base.resolved.replace(/^origin\//, ''),
      baseRef: base.ref,
      worktreePath,
      worktreeId: entry?.id ?? null,
      state: 'active',
      createdAt: new Date().toISOString(),
      ...(options.runner === undefined
        ? {}
        : { agent: { runner: options.runner, ...(resolvedVersion === null ? {} : { version: resolvedVersion }) } }),
    }

    // Read state that cannot mutate anything before the registry is written. If either
    // probe fails, the cleanup below sees a claim that was never registered.
    const notes = await environmentNotes(repoRoot)
    const needsUpstream = !(await hasUpstream(worktreePath, branch))

    // The registry update is the last fallible step, and it runs under the repository
    // claims lock so a concurrent claim in another process cannot overwrite this one.
    await updateClaims(repoRoot, (registry) => {
      registry.claims = [...registry.claims.filter((c) => c.key !== claim.key), claim]
    })

    return {
      claim,
      checks: pre.checks,
      notes,
      needsUpstream,
      injection: context.injection,
      pushGuard,
    }
  } catch (err) {
    const cleanupError = await rollbackClaimCreation(repoRoot, worktreePath, branch)
    const detail = err instanceof Error ? err.message : String(err)
    if (cleanupError !== null) {
      throw new AnvilError(
        ErrorCode.Internal,
        `Claim setup failed and cleanup was incomplete: ${detail}. ${cleanupError}`,
        {
          hint: `Inspect ${worktreePath} and branch "${branch}" before retrying; remove them manually if they are still present.`,
          cause: err,
          details: { worktreePath, branch, cleanedUp: false },
        },
      )
    }
    throw new AnvilError(
      err instanceof AnvilError ? err.code : ErrorCode.Internal,
      `Claim setup failed; the worktree and branch were removed: ${detail}`,
      {
        hint: 'Nothing was registered. Fix the reported problem and retry.',
        cause: err,
        details: { worktreePath, branch, cleanedUp: true },
      },
    )
  }
}

/**
 * Remove a worktree and branch created by a claim that failed before registration.
 *
 * Returns a description of what could not be cleaned up, or null when the rollback
 * completed. Forcing is safe here: this worktree was created moments ago and no user work
 * can be in it yet. The branch is deleted only after the worktree is gone, because git
 * refuses to delete a branch that a worktree still has checked out.
 */
async function rollbackClaimCreation(repoRoot: string, worktreePath: string, branch: string): Promise<string | null> {
  const removed = await removeWorktree(repoRoot, worktreePath, true)
  if (removed.exitCode !== 0) {
    return `git worktree remove failed: ${removed.stderr.trim() || removed.stdout.trim() || `exit ${removed.exitCode}`}`
  }
  const deleted = await deleteBranch(repoRoot, branch, true)
  if (deleted.exitCode !== 0) {
    return `git branch -D failed after the worktree was removed: ${deleted.stderr.trim() || deleted.stdout.trim() || `exit ${deleted.exitCode}`}`
  }
  return null
}

async function hasUpstream(cwd: string, branch: string): Promise<boolean> {
  // `<branch>@{upstream}` is the ref that *is* the upstream. `rev-parse --abbrev-ref
  // <branch>` just echoes the branch name back, and every anvil branch contains a `/`
  // (`feat/...`), so the old check reported true for every claim and `needsUpstream` was
  // always false.
  const res = await git(['rev-parse', '--abbrev-ref', '--symbolic-full-name', `${branch}@{upstream}`], { cwd })
  return res.exitCode === 0 && res.stdout.trim() !== ''
}

/** Add an exclusion to the repository's shared `info/exclude`. Returns false if unavailable. */
export async function excludeAnvilState(repoRoot: string): Promise<boolean> {
  const res = await git(['rev-parse', '--path-format=absolute', '--git-common-dir'], { cwd: repoRoot })
  if (res.exitCode !== 0) return false
  const infoDir = join(normalizeGitPath(res.stdout), 'info')
  const path = join(infoDir, 'exclude')
  try {
    mkdirSync(infoDir, { recursive: true })
    const existing = existsSync(path) ? readFileSync(path, 'utf8') : ''
    if (existing.includes(EXCLUDE_ENTRY)) return true
    const prefix = existing === '' || existing.endsWith('\n') ? existing : `${existing}\n`
    writeFileSync(path, `${prefix}${EXCLUDE_BLOCK}`, 'utf8')
    return true
  } catch {
    // Not fatal: the files are still written, they just show as untracked.
    return false
  }
}

const EXCLUDE_ENTRY = '.anvil/'

const EXCLUDE_BLOCK = `# anvil's own state. Ticket context is company-internal and regenerated
# by \`anvil issue pull\`, so it must never be committed or pushed.
.anvil/
`

export interface ReleaseOptions {
  repoRoot: string
  key: string
  /** Remove the worktree even when it has changes. */
  force?: boolean
  /** Also delete the branch. */
  deleteBranch?: boolean
  /**
   * Injected git operations, for failure tests. Production callers never pass this.
   *
   * A locked worktree already fails the real removal; overriding branch deletion is the
   * only way to exercise that boundary without a machine-wide permission change.
   */
  operations?: Partial<ReleaseOperations>
}

export interface ReleaseOperations {
  removeWorktree(repoRoot: string, path: string, force: boolean): Promise<RunResult>
  deleteBranch(repoRoot: string, branch: string, force: boolean): Promise<RunResult>
  writeRegistry(repoRoot: string, registry: ClaimRegistry): void
}

export interface ReleaseResult {
  claim: Claim
  worktreeRemoved: boolean
  branchDeleted: boolean
  /** Why the worktree was kept, when it was. */
  retainedBecause?: string
  /** Why the branch was kept, when deletion was requested and failed. */
  branchRetainedBecause?: string
}

/**
 * Tear a claim down.
 *
 * Refuses to remove a worktree holding uncommitted changes unless forced, and reports the
 * two "would lose work" conditions separately: uncommitted changes and unpushed commits.
 * A crew that reports "clean" while commits sit unpushed will lose them.
 *
 * Every mutation boundary has an explicit outcome: a refused removal leaves the registry
 * active, a failed branch deletion is reported without pretending the release failed, and
 * a failed registry write says which part already happened.
 */
export async function releaseClaim(options: ReleaseOptions): Promise<ReleaseResult> {
  const { repoRoot, key } = options
  const operations: ReleaseOperations = {
    removeWorktree,
    deleteBranch,
    writeRegistry: writeClaims,
    ...options.operations,
  }
  const registry = readClaims(repoRoot)
  const claim = registry.claims.find((c) => c.key === key)
  if (claim === undefined) {
    throw new AnvilError(ErrorCode.Usage, `No claim for "${key}"`, {
      hint: 'Run `anvil status` to list active claims.',
    })
  }

  const exists = existsSync(claim.worktreePath)
  let status: WorktreeStatus | null = null
  if (exists) status = await worktreeStatus(claim.worktreePath)

  let unpushedCount = status?.unpushed ?? 0
  let unpushedUnknown = false
  if (status !== null && !status.hasUpstream && exists) {
    const ahead = await git(['rev-list', '--count', `${claim.baseRef}..HEAD`], { cwd: claim.worktreePath })
    if (ahead.exitCode === 0) {
      const n = Number.parseInt(ahead.stdout.trim(), 10)
      if (Number.isFinite(n)) unpushedCount = n
    } else {
      // Without an upstream there is no `@{upstream}..HEAD` to count, and the base ref can
      // itself be gone (a deleted remote branch). Refusing to remove is the safe answer:
      // `--force` is the explicit way to say the commits do not matter.
      unpushedUnknown = true
    }
  }

  const losing: string[] = []
  if (status?.dirty === true) losing.push(`${status.changes.length} uncommitted change(s)`)
  if (unpushedCount > 0) {
    losing.push(`${unpushedCount} unpushed commit(s)`)
  } else if (unpushedUnknown) {
    losing.push(`commits that could not be counted against ${claim.baseRef}`)
  }

  let worktreeRemoved = false
  let retainedBecause: string | undefined

  if (exists) {
    if (losing.length > 0 && options.force !== true) {
      retainedBecause = `worktree has ${losing.join(' and ')}`
    } else {
      const removed = await operations.removeWorktree(repoRoot, claim.worktreePath, options.force === true)
      if (removed.exitCode === 0) {
        worktreeRemoved = true
      } else if (options.force === true) {
        // `git worktree remove --force` still refuses locked worktrees.
        throw new AnvilError(
          ErrorCode.PreflightFailed,
          `git worktree remove failed: ${removed.stderr.trim() || removed.stdout.trim() || `exit ${removed.exitCode}`}`,
          {
            hint: 'The worktree may be locked. Run `git worktree unlock <path>` and retry.',
            details: { worktreePath: claim.worktreePath },
          },
        )
      } else {
        retainedBecause = `git refused to remove it: ${removed.stderr.trim() || removed.stdout.trim() || `exit ${removed.exitCode}`}`
      }
    }
  } else {
    worktreeRemoved = true
  }

  let branchDeleted = false
  let branchRetainedBecause: string | undefined
  if (options.deleteBranch === true && worktreeRemoved) {
    const res = await operations.deleteBranch(repoRoot, claim.branch, true)
    branchDeleted = res.exitCode === 0
    if (!branchDeleted) {
      branchRetainedBecause = res.stderr.trim() || res.stdout.trim() || `git branch -D exited ${res.exitCode}`
    }
  }

  claim.state = worktreeRemoved ? 'released' : 'active'
  try {
    // Re-read inside the lock: the registry may have gained another process's claim since
    // this release started, and writing the earlier snapshot would discard it.
    await withClaimsLock(repoRoot, async () => {
      const current = readClaims(repoRoot)
      current.claims = current.claims.map((c) => (c.key === key ? claim : c))
      operations.writeRegistry(repoRoot, current)
    })
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err)
    throw new AnvilError(
      ErrorCode.Internal,
      worktreeRemoved
        ? `Released ${key} but could not update the claim registry: ${detail}. The worktree was removed and the registry still lists the claim.`
        : `Could not update the claim registry for ${key}: ${detail}. The worktree was left in place.`,
      {
        hint: worktreeRemoved
          ? 'Run `anvil status --orphans` to find the stale entry, or repair .anvil/claims.json before retrying.'
          : 'Check that .anvil is writable, then retry.',
        cause: err,
        details: { worktreePath: claim.worktreePath, worktreeRemoved, branchDeleted },
      },
    )
  }

  return {
    claim,
    worktreeRemoved,
    branchDeleted,
    ...(retainedBecause === undefined ? {} : { retainedBecause }),
    ...(branchRetainedBecause === undefined ? {} : { branchRetainedBecause }),
  }
}

// ---------------------------------------------------------------------------
// Status
// ---------------------------------------------------------------------------

export interface ClaimStatus {
  claim: Claim
  /** The worktree directory still exists. */
  present: boolean
  /** Uncommitted changes, counted. */
  uncommitted: number
  /** Commits not on an upstream. */
  unpushed: number | null
  hasUpstream: boolean
  lastCommitAgeSeconds: number | null
  lastCommitSubject: string | null
  /** True when the worktree is gone but the claim is still active. */
  orphaned: boolean
  /** True when the worktree's branch no longer matches the claim. */
  branchMismatch: boolean
}

/** Live status for every claim, reconciled against what git actually reports. */
export async function claimStatuses(repoRoot: string): Promise<ClaimStatus[]> {
  const registry = readClaims(repoRoot)
  const out: ClaimStatus[] = []

  for (const claim of registry.claims) {
    const present = existsSync(claim.worktreePath)
    if (!present) {
      out.push({
        claim,
        present: false,
        uncommitted: 0,
        unpushed: null,
        hasUpstream: false,
        lastCommitAgeSeconds: null,
        lastCommitSubject: null,
        orphaned: claim.state === 'active',
        branchMismatch: false,
      })
      continue
    }

    const status = await worktreeStatus(claim.worktreePath)
    const branch = await currentBranch(claim.worktreePath)
    out.push({
      claim,
      present: true,
      uncommitted: status.changes.length,
      unpushed: status.unpushed,
      hasUpstream: status.hasUpstream,
      lastCommitAgeSeconds: status.lastCommitAgeSeconds,
      lastCommitSubject: status.lastCommitSubject,
      orphaned: false,
      branchMismatch: branch !== null && branch !== claim.branch,
    })
  }

  return out
}

/**
 * Worktrees that git knows about but no claim references.
 *
 * An orphaned worktree is invisible work: someone created it, or a claim was released
 * with a corrupt registry. Reporting them is the difference between tidying up and
 * eventually deleting someone's afternoon.
 */
export async function findOrphanWorktrees(repoRoot: string): Promise<string[]> {
  const registry = readClaims(repoRoot)
  const known = new Set(registry.claims.map((c) => c.worktreePath.toLowerCase()))
  const worktrees = await listWorktrees(repoRoot)
  return worktrees.filter((w) => !w.isMain && !known.has(w.path.toLowerCase())).map((w) => w.path)
}
