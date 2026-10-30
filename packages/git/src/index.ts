/**
 * Git operations for worktree-based parallel work.
 *
 * Two rules govern everything here:
 *
 *  1. **Never invoke a shell.** Every call is `execFile` with an argument array. A remote
 *     URL, a branch name and a ticket title are all attacker-controlled in a repository
 *     you do not own; through a shell they are command injection.
 *  2. **Normalize paths at the boundary.** Git reports forward slashes and, on Windows,
 *     may lower-case the drive. Left alone, those paths never compare equal to Node-native
 *     ones, and the failure surfaces much later as mysterious worktree-matching bugs.
 *
 * Git failures are returned as exit codes rather than thrown, because almost every
 * caller needs to *decide* what a non-zero exit means (branch exists, worktree already
 * registered, nothing to fetch) rather than abort.
 */

import { execFile } from 'node:child_process'
import { existsSync, realpathSync } from 'node:fs'
import { basename, dirname, isAbsolute, join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { AnvilError, ErrorCode } from '@anvil/core'
import { withDirectoryLock } from './lock.ts'

const execFileAsync = promisify(execFile)

export interface RunResult {
  stdout: string
  stderr: string
  exitCode: number
}

export interface RunOptions {
  cwd?: string
  env?: NodeJS.ProcessEnv
  maxBuffer?: number
}

/** Run a git subcommand with an argument array. Never invokes a shell. */
export async function git(args: string[], options: RunOptions = {}): Promise<RunResult> {
  try {
    const { stdout, stderr } = await execFileAsync('git', args, {
      ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
      ...(options.env === undefined ? {} : { env: options.env }),
      maxBuffer: options.maxBuffer ?? 8 * 1024 * 1024,
      windowsHide: true,
    })
    return { stdout, stderr, exitCode: 0 }
  } catch (err) {
    const e = err as {
      code?: number | string
      stdout?: string
      stderr?: string
      message?: string
    }
    if (e !== null && typeof e === 'object' && typeof e.code === 'number') {
      return {
        stdout: e.stdout ?? '',
        stderr: e.stderr ?? e.message ?? '',
        exitCode: e.code,
      }
    }
    throw new AnvilError(ErrorCode.ToolMissing, `Failed to run git: ${e?.message ?? String(err)}`, {
      hint: 'Is git installed and on PATH? anvil needs it to create worktrees.',
      cause: err,
    })
  }
}

export async function gitOrThrow(args: string[], options: RunOptions = {}): Promise<string> {
  const result = await git(args, options)
  if (result.exitCode !== 0) {
    const detail = result.stderr.trim() || result.stdout.trim() || `exit ${result.exitCode}`
    throw new AnvilError(ErrorCode.Internal, `git ${args.join(' ')} failed: ${detail}`, {
      details: { exitCode: result.exitCode },
    })
  }
  return result.stdout
}

// ---------------------------------------------------------------------------
// Path normalization
// ---------------------------------------------------------------------------

/**
 * Normalize a path git reported. Uses `realpath.native` so the drive letter casing and
 * separator style match what Node produces from `join`.
 */
export function normalizeGitPath(raw: string): string {
  const trimmed = raw.trim()
  try {
    return realpathSync.native(trimmed)
  } catch {
    return resolve(trimmed)
  }
}

// ---------------------------------------------------------------------------
// Repository discovery
// ---------------------------------------------------------------------------

export interface GitRepoInfo {
  /** Absolute, normalized. */
  root: string
  /** Current branch, or null when HEAD is detached. */
  branch: string | null
  /** Primary remote URL, or null. */
  remote: string | null
  /** Default branch per the remote HEAD, or null. */
  defaultBranch: string | null
  /** True when this directory is a linked worktree rather than the main one. */
  isWorktree: boolean
  /** `git worktree list` id, unique per worktree. Used for reliable removal. */
  worktreeId: string | null
}

export async function discoverRepo(cwd: string): Promise<GitRepoInfo | null> {
  const toplevel = await git(['rev-parse', '--show-toplevel'], { cwd })
  if (toplevel.exitCode !== 0) return null
  const root = normalizeGitPath(toplevel.stdout)
  if (root === '') return null

  const [branchRes, remoteRes, headRes, commonRes, gitDirRes] = await Promise.all([
    git(['rev-parse', '--abbrev-ref', 'HEAD'], { cwd }),
    git(['remote', 'get-url', 'origin'], { cwd }),
    git(['symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD'], {
      cwd,
    }),
    git(['rev-parse', '--path-format=absolute', '--git-common-dir'], { cwd }),
    git(['rev-parse', '--path-format=absolute', '--absolute-git-dir'], {
      cwd,
    }),
  ])

  const branch = branchRes.exitCode === 0 ? branchRes.stdout.trim() : null
  const remote = remoteRes.exitCode === 0 ? remoteRes.stdout.trim() : null
  const defaultBranch = headRes.exitCode === 0 ? headRes.stdout.trim() : null

  // The common git dir is the main repository's .git. A linked worktree has a different
  // absolute git dir but shares the common one, so they being equal means "main worktree".
  const commonDir = commonRes.exitCode === 0 ? normalizeGitPath(commonRes.stdout) : null
  const gitDir = gitDirRes.exitCode === 0 ? normalizeGitPath(gitDirRes.stdout) : null
  const isWorktree = commonDir !== null && gitDir !== null && commonDir !== gitDir

  return {
    root,
    branch: branch === 'HEAD' || branch === '' ? null : branch,
    remote: remote === '' ? null : remote,
    defaultBranch: defaultBranch === '' ? null : defaultBranch,
    isWorktree,
    worktreeId: gitDir,
  }
}

export async function discoverRepoOrThrow(cwd: string): Promise<GitRepoInfo> {
  const info = await discoverRepo(cwd)
  if (info === null) {
    throw new AnvilError(ErrorCode.NotAGitRepo, `${cwd} is not inside a git repository`, {
      hint: 'Run `git init`, or cd into an existing repository.',
    })
  }
  return info
}

/**
 * The **main** worktree's root, from any worktree of the same repository.
 *
 * Shared state -- tickets, the claim registry -- must live in the main worktree, not in
 * whatever worktree anvil happens to be running from. A disposable worktree must not
 * hold the registry that tracks the other worktrees, and `anvil issue refresh` run inside
 * a worktree must find the same tickets as `anvil claim` did outside it.
 *
 * Derived from the common git dir, which is `<main>/.git`.
 */
export async function mainWorktreeRoot(cwd: string): Promise<string | null> {
  const res = await git(['rev-parse', '--path-format=absolute', '--git-common-dir'], { cwd })
  if (res.exitCode !== 0) return null
  const commonDir = normalizeGitPath(res.stdout)
  const parent = dirname(commonDir)
  // The common dir is `<main>/.git`; be defensive about a bare repository or a custom
  // layout rather than returning a path that does not exist.
  return basename(commonDir) === '.git' ? parent : null
}

/** The common git directory (`<main>/.git`), shared by every worktree. */
export async function commonGitDir(cwd: string): Promise<string | null> {
  const res = await git(['rev-parse', '--path-format=absolute', '--git-common-dir'], { cwd })
  if (res.exitCode !== 0) return null
  const trimmed = res.stdout.trim()
  return trimmed === '' ? null : normalizeGitPath(trimmed)
}

/**
 * The directory git runs hooks from, before anvil overrides it for a worktree.
 *
 * `core.hooksPath` may be relative, and git resolves a relative hooks path against the
 * top level of the working tree for a non-bare repository -- so that is what this does.
 * When the key is unset, git's default is `<common git dir>/hooks`, shared by every
 * worktree; the claim installs a per-worktree path instead of writing into that one.
 */
export async function effectiveHooksDir(cwd: string): Promise<string | null> {
  const configured = await git(['config', '--get', 'core.hooksPath'], { cwd })
  const value = configured.exitCode === 0 ? configured.stdout.trim() : ''
  if (value !== '') return normalizeGitPath(isAbsolute(value) ? value : join(cwd, value))
  const common = await commonGitDir(cwd)
  return common === null ? null : join(common, 'hooks')
}

/**
 * Enable `config.worktree`, the mechanism that lets one worktree carry configuration the
 * others do not. Without it, `core.hooksPath` is repository-wide and a hook installed for
 * a claim would refuse pushes from the main worktree too.
 */
export async function enableWorktreeConfig(cwd: string): Promise<RunResult> {
  return git(['config', 'extensions.worktreeConfig', 'true'], { cwd })
}

/**
 * Set a worktree-local config value.
 *
 * Forward slashes are deliberate: git accepts them on every platform, and a backslash in a
 * config value is an escape character in some parsers. The value itself is absolute, so a
 * relative `core.hooksPath` cannot resolve differently depending on where the hook runs.
 */
export async function setWorktreeHooksPath(cwd: string, hooksPath: string): Promise<RunResult> {
  return git(['config', '--worktree', 'core.hooksPath', hooksPath.replace(/\\/g, '/')], { cwd })
}

// ---------------------------------------------------------------------------
// Branches
// ---------------------------------------------------------------------------

export async function branchExists(cwd: string, branch: string): Promise<boolean> {
  const local = await git(['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`], { cwd })
  if (local.exitCode === 0) return true
  const remote = await git(['rev-parse', '--verify', '--quiet', `refs/remotes/origin/${branch}`], { cwd })
  return remote.exitCode === 0
}

export async function revExists(cwd: string, ref: string): Promise<boolean> {
  const res = await git(['rev-parse', '--verify', '--quiet', ref], { cwd })
  return res.exitCode === 0
}

export async function hasRemote(cwd: string, name = 'origin'): Promise<boolean> {
  const res = await git(['remote', 'get-url', name], { cwd })
  return res.exitCode === 0
}

/**
 * Resolve a base ref for a new branch, preferring the remote tracking branch so a claim
 * is not created from a stale local default.
 */
export async function resolveBaseRef(
  cwd: string,
  preferred: string | null,
): Promise<{ ref: string; resolved: string }> {
  const candidates: string[] = []
  if (preferred !== null) candidates.push(`origin/${preferred}`, preferred)
  const info = await discoverRepo(cwd)
  if (info?.defaultBranch != null) candidates.push(`origin/${info.defaultBranch}`, info.defaultBranch)
  if (info?.branch != null) candidates.push(`origin/${info.branch}`, info.branch)
  candidates.push('origin/main', 'main', 'origin/master', 'master')

  for (const ref of candidates) {
    if (await revExists(cwd, ref)) return { ref, resolved: ref }
  }
  // A user-recoverable condition (no branch, no remote, nothing fetched), so it must not
  // report as Internal -- that exit code means "bug in anvil, report it".
  throw new AnvilError(ErrorCode.PreflightFailed, 'Cannot resolve a base branch to branch from', {
    hint: 'Fetch first (`git fetch --all`), or pass --base <branch>.',
  })
}

// ---------------------------------------------------------------------------
// Worktrees
// ---------------------------------------------------------------------------

export interface WorktreeEntry {
  /** The worktree's absolute path, normalized. */
  path: string
  /** The `HEAD` line from porcelain output: the commit sha the worktree points at. */
  ref: string | null
  /** Short branch name, or null when detached. */
  branch: string | null
  /** Porcelain's `HEAD` value (a commit sha), or the path when absent. */
  id: string
  /** True for the main worktree. */
  isMain: boolean
  /** Reason recorded for a prunable/locked worktree. */
  prunable: boolean
  locked: boolean
}

/** Parse `git worktree list --porcelain`, whose records are line-oriented. */
export async function listWorktrees(cwd: string): Promise<WorktreeEntry[]> {
  const res = await gitOrThrow(['worktree', 'list', '--porcelain'], { cwd })
  const out: WorktreeEntry[] = []

  for (const block of res.split(/\r?\n\r?\n/)) {
    const lines = block.split(/\r?\n/).filter((l) => l.trim() !== '')
    if (lines.length === 0) continue

    const get = (prefix: string): string | null => {
      const line = lines.find((l) => l.startsWith(prefix))
      return line === undefined ? null : line.slice(prefix.length).trim()
    }

    const rawPath = get('worktree ')
    if (rawPath === null) continue
    const branchRef = get('branch ')

    out.push({
      path: normalizeGitPath(rawPath),
      ref: get('HEAD '),
      branch: branchRef === null ? null : branchRef.replace(/^refs\/heads\//, ''),
      id: get('HEAD ') ?? rawPath,
      // `git worktree list` always lists the main worktree first, so the entry order is
      // the reliable signal. Deriving it from paths would break inside a worktree.
      isMain: false,
      prunable: get('prunable') !== null,
      locked: get('locked') !== null,
    })
  }

  if (out.length > 0) out[0]!.isMain = true
  return out
}

export interface AddWorktreeOptions {
  cwd: string
  path: string
  branch: string
  /** Ref to branch from. */
  baseRef: string
}

export async function addWorktree(options: AddWorktreeOptions): Promise<RunResult> {
  return git(['worktree', 'add', '-b', options.branch, options.path, options.baseRef], { cwd: options.cwd })
}

export async function removeWorktree(cwd: string, path: string, force = false): Promise<RunResult> {
  return git(['worktree', 'remove', ...(force ? ['--force'] : []), path], {
    cwd,
  })
}

export async function pruneWorktrees(cwd: string): Promise<void> {
  await git(['worktree', 'prune'], { cwd })
}

// ---------------------------------------------------------------------------
// Worktree state
// ---------------------------------------------------------------------------

export interface WorktreeStatus {
  /** Uncommitted changes in the worktree. */
  dirty: boolean
  /** Lines from `git status --porcelain`. */
  changes: string[]
  /** Commits present locally but not on the upstream branch. */
  unpushed: number | null
  /** True when the branch has an upstream configured. */
  hasUpstream: boolean
  /** Age in seconds of the last commit, or null for an empty worktree. */
  lastCommitAgeSeconds: number | null
  lastCommitSubject: string | null
}

/**
 * Worktree state, with the two "would lose work" conditions reported **separately**.
 *
 * Collapsing them into one `dirty` flag is a real trap: uncommitted changes and unpushed
 * commits need different handling, and a crew that reports "clean" while commits sit
 * unpushed will happily release a worktree and lose them.
 */
export async function worktreeStatus(cwd: string): Promise<WorktreeStatus> {
  const statusRes = await git(['status', '--porcelain'], { cwd })
  const changes = statusRes.exitCode === 0 ? statusRes.stdout.split('\n').filter((l) => l.trim() !== '') : []

  const upstreamRes = await git(['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}'], { cwd })
  const hasUpstream = upstreamRes.exitCode === 0
  let unpushed: number | null = null
  if (hasUpstream) {
    const count = await git(['rev-list', '--count', '@{upstream}..HEAD'], {
      cwd,
    })
    if (count.exitCode === 0) {
      const n = Number.parseInt(count.stdout.trim(), 10)
      unpushed = Number.isFinite(n) ? n : null
    }
  }

  const log = await git(['log', '-1', '--format=%ct%x00%s'], { cwd })
  let lastCommitAgeSeconds: number | null = null
  let lastCommitSubject: string | null = null
  if (log.exitCode === 0) {
    const [ts, subject] = log.stdout.trim().split('\0')
    const parsed = Number.parseInt(ts ?? '', 10)
    if (Number.isFinite(parsed)) lastCommitAgeSeconds = Math.max(0, Math.floor(Date.now() / 1000) - parsed)
    lastCommitSubject = subject ?? null
  }

  return {
    dirty: changes.length > 0,
    changes,
    unpushed,
    hasUpstream,
    lastCommitAgeSeconds,
    lastCommitSubject,
  }
}

export async function currentBranch(cwd: string): Promise<string | null> {
  const res = await git(['rev-parse', '--abbrev-ref', 'HEAD'], { cwd })
  if (res.exitCode !== 0) return null
  const b = res.stdout.trim()
  return b === 'HEAD' || b === '' ? null : b
}

export async function deleteBranch(cwd: string, branch: string, force = true): Promise<RunResult> {
  return git(['branch', ...(force ? ['-D'] : ['-d']), branch], { cwd })
}

// ---------------------------------------------------------------------------
// Repository locks
// ---------------------------------------------------------------------------

/**
 * Serialize work that mutates shared repository state across processes.
 *
 * Worktrees have isolated indexes but **share** refs and the per-repository state file
 * anvil keeps beside the common git dir. Two concurrent fetches race on refs, and two
 * concurrent claim registrations race on a read-modify-write cycle. A lock directory with a
 * bounded wait turns both into a short pause.
 *
 * The lock is advisory and per-repository, stored beside the common git dir so every
 * worktree of the same repo contends on the same file.
 *
 * A process killed between acquiring and releasing leaves its unique record behind, and without
 * recovery every later operation in that repository waits out the timeout and fails until
 * someone deletes it by hand. Dead contenders are removed by the next waiter. Unique
 * record names prevent two stale observers from accidentally removing a live successor.
 */
export interface LockOptions {
  cwd: string
  timeoutMs?: number
  pollMs?: number
}

export interface RepoLockOptions extends LockOptions {
  /** Lock file stem, e.g. `fetch` or `claims`. Internal names only, never user input. */
  name: string
}

export async function withRepoLock<T>(options: RepoLockOptions, fn: () => Promise<T>): Promise<T> {
  const timeoutMs = options.timeoutMs ?? 20_000
  const pollMs = options.pollMs ?? 100
  if (!/^[a-z][a-z0-9-]*$/.test(options.name)) {
    throw new AnvilError(ErrorCode.Internal, `Invalid repository lock name: ${options.name}`, {
      hint: 'Lock names are fixed identifiers chosen by anvil, not paths.',
    })
  }
  const common = await git(['rev-parse', '--path-format=absolute', '--git-common-dir'], { cwd: options.cwd })
  if (common.exitCode !== 0) {
    throw new AnvilError(ErrorCode.NotAGitRepo, 'Cannot locate the repository git directory', {
      hint: 'Run this from inside a git repository.',
    })
  }
  const dir = join(normalizeGitPath(common.stdout), 'anvil-locks')
  const lockPath = join(dir, `${options.name}.lock`)
  return withDirectoryLock(lockPath, { timeoutMs, pollMs, name: options.name }, fn)
}

/** Serialize `git fetch` across processes. */
export async function withFetchLock<T>(options: LockOptions, fn: () => Promise<T>): Promise<T> {
  return withRepoLock({ ...options, name: 'fetch' }, fn)
}

/** Fetch, serialized. Returns the raw result so callers can decide on a non-zero exit. */
export async function fetchLocked(cwd: string, remote = 'origin'): Promise<RunResult> {
  return withFetchLock({ cwd }, () => git(['fetch', remote, '--prune'], { cwd }))
}

// ---------------------------------------------------------------------------
// Preflight
// ---------------------------------------------------------------------------

export interface PreflightCheck {
  name: string
  ok: boolean
  level: 'block' | 'warn'
  detail: string
  hint?: string
}

export interface PreflightResult {
  ok: boolean
  checks: PreflightCheck[]
}

/**
 * Windows caps a path at 260 characters by default, and git worktrees add a long
 * `.git/worktrees/<name>` companion path. The failure shows up on *removal* long after a
 * successful create, which is why the estimate is checked up front.
 */
export const WINDOWS_SAFE_PATH_BUDGET = 180

export function estimateWorktreePathLength(target: string): number {
  // The companion administrative path git creates alongside the worktree.
  const companion = 24 // '/.git/worktrees/' + a ~10 char name + '/'
  return target.length + companion
}

export interface PreflightInput {
  root: string
  targetPath: string
  branch: string
  /** True when the main worktree has uncommitted changes. */
  baseDirty: boolean
  platform?: NodeJS.Platform
}

/**
 * Refuse a claim that would fail later, or lose work now.
 *
 * Order matters: the cheapest and most decisive checks first, so a clear refusal message
 * comes out before a slow filesystem probe.
 */
export function preflightClaim(input: PreflightInput): PreflightResult {
  const platform = input.platform ?? process.platform
  const checks: PreflightCheck[] = []

  // 1. Dirty base worktree. Claiming does not switch the base worktree's branch, so a
  //    dirty tree is not fatal -- but it is worth saying, because a user who switches
  //    branches next will lose work and blame anvil.
  if (input.baseDirty) {
    checks.push({
      name: 'base-worktree-clean',
      ok: false,
      level: 'warn',
      detail: 'The main worktree has uncommitted changes.',
      hint: 'anvil does not switch your main worktree, but commit or stash before working there.',
    })
  } else {
    checks.push({
      name: 'base-worktree-clean',
      ok: true,
      level: 'warn',
      detail: 'Main worktree is clean.',
    })
  }

  // 2. Path budget. Checked on both create and remove, because remove is where
  //    ENAMETOOLONG actually bites.
  const estimated = estimateWorktreePathLength(input.targetPath)
  if (platform === 'win32' && estimated > WINDOWS_SAFE_PATH_BUDGET) {
    checks.push({
      name: 'path-length',
      ok: false,
      level: 'block',
      detail: `Worktree path would be about ${estimated} characters, over the ${WINDOWS_SAFE_PATH_BUDGET} safe budget for Windows.`,
      hint: 'Set git.worktreeRoot in anvil.config.json to a short path such as C:\\wt.',
    })
  } else {
    checks.push({
      name: 'path-length',
      ok: true,
      level: 'block',
      detail: `Worktree path budget ~${estimated} characters.`,
    })
  }

  // 3. A path that already exists as a non-empty directory.
  if (existsSync(input.targetPath)) {
    checks.push({
      name: 'target-free',
      ok: false,
      level: 'block',
      detail: `${input.targetPath} already exists.`,
      hint: 'Choose a different worktree root, or remove the directory.',
    })
  } else {
    checks.push({
      name: 'target-free',
      ok: true,
      level: 'block',
      detail: 'Target path is free.',
    })
  }

  // 4. Branch name validity, checked before git so the error is ours and actionable.
  if (!isValidBranchName(input.branch)) {
    checks.push({
      name: 'branch-name',
      ok: false,
      level: 'block',
      detail: `"${input.branch}" is not a valid git branch name.`,
      hint: 'Branch names cannot contain spaces, ~, ^, :, ?, *, [, \\, or start with - or end with .lock.',
    })
  } else {
    checks.push({
      name: 'branch-name',
      ok: true,
      level: 'block',
      detail: 'Branch name is valid.',
    })
  }

  return { ok: !checks.some((c) => c.level === 'block' && !c.ok), checks }
}

/**
 * `git check-ref-format` semantics, approximated.
 *
 * Approximated deliberately: shelling out to git for a name we generated ourselves is
 * wasteful, and being slightly stricter than git is safe. Being *looser* would not be,
 * which is why the rules below are the full set git enforces.
 */
export function isValidBranchName(name: string): boolean {
  if (name === '') return false
  if (name.length > 255) return false
  if (name.startsWith('-') || name.startsWith('/') || name.endsWith('/')) return false
  if (name.endsWith('.') || name.endsWith('.lock')) return false
  if (name.includes('..') || name.includes('//')) return false
  if (name.includes('@{')) return false
  if (name.includes(' ')) return false
  if (/[~^:?*[\]\\]/.test(name)) return false
  // Control characters and DEL are rejected by git, and would corrupt a filesystem path
  // on Windows long before anvil noticed.
  if (/[\u0000-\u001f\u007f]/.test(name)) return false
  return true
}

/** Facts that change how a worktree behaves and are worth surfacing rather than ignoring. */
export async function environmentNotes(cwd: string): Promise<string[]> {
  const notes: string[] = []
  const submodules = await git(['config', '--file', '.gitmodules', '--get-regexp', 'path'], { cwd })
  if (submodules.exitCode === 0 && submodules.stdout.trim() !== '') {
    notes.push(
      'This repository has submodules. Each new worktree needs `git submodule update --init` before it builds.',
    )
  }
  const lfs = await git(['config', '--get', 'lfs.repositoryformatversion'], {
    cwd,
  })
  if (lfs.exitCode === 0) {
    notes.push(
      'Git LFS is configured. `git worktree add` shares the LFS object store, so parallel builds will contend on it.',
    )
  }
  const sparse = await git(['config', '--get', 'core.sparseCheckout'], { cwd })
  if (sparse.exitCode === 0 && sparse.stdout.trim() === 'true') {
    notes.push(
      'Sparse checkout is enabled; a new worktree inherits the sparse settings but starts with an empty index.',
    )
  }
  return notes
}
