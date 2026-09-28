/**
 * Git repository discovery and the thin git wrapper.
 *
 * M0 ships only what `anvil` needs before it is a real tool: find the repo root, read
 * the current branch, and get a remote URL so config can be repo-scoped. M3 grows this
 * into branch/worktree/remote management.
 *
 * Every call goes through `execFile` with an argument array -- never a shell string.
 * A remote URL or a branch name is attacker-controlled input in a repo you do not own.
 */

import { execFile } from 'node:child_process'
import { realpathSync } from 'node:fs'
import { resolve } from 'node:path'
import { promisify } from 'node:util'
import { AnvilError, ErrorCode } from './errors.ts'

const execFileAsync = promisify(execFile)

export interface RunResult {
  stdout: string
  stderr: string
  exitCode: number
}

export interface RunOptions {
  cwd?: string
  env?: NodeJS.ProcessEnv
  /** Bytes of captured stdout. Git output is small; cap it so a broken repo cannot OOM us. */
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
    // execFile rejects with an error carrying `code`, `stdout`, `stderr`.
    const e = err as { code?: number | string; stdout?: string; stderr?: string; message?: string }
    if (e && typeof e.code === 'number') {
      return { stdout: e.stdout ?? '', stderr: e.stderr ?? e.message ?? '', exitCode: e.code }
    }
    throw new AnvilError(ErrorCode.Internal, `Failed to run git: ${e.message ?? String(err)}`, { cause: err })
  }
}

export async function gitOrThrow(args: string[], options: RunOptions = {}): Promise<string> {
  const result = await git(args, options)
  if (result.exitCode !== 0) {
    throw new AnvilError(ErrorCode.Internal, `git ${args.join(' ')} failed: ${result.stderr.trim() || result.stdout.trim()}`, {
      details: { exitCode: result.exitCode },
    })
  }
  return result.stdout
}

export interface GitRepoInfo {
  root: string
  /** Current branch name, or null when detached. */
  branch: string | null
  /** Primary remote URL, or null when the repo has no remotes. */
  remote: string | null
  /** Default branch per the remote HEAD, or null. */
  defaultBranch: string | null
}

/**
 * Normalize a path reported by git.
 *
 * On Windows git reports forward slashes and, depending on core settings, may lower-case
 * the drive and path. Left alone, that produces paths that compare unequal to the
 * Node-native paths we build with `join`, which surfaces much later as mysterious
 * worktree and path-matching failures. Normalize once, here, at the boundary.
 */
function normalizeGitPath(raw: string): string {
  const trimmed = raw.trim()
  try {
    return realpathSync.native(trimmed)
  } catch {
    // realpath fails on a path that no longer exists; fall back to a separator fix.
    return resolve(trimmed)
  }
}

/**
 * Discover the git repo containing `cwd` by walking up. Returns null if `cwd` is not
 * inside a git repo. Uses `rev-parse --show-toplevel` so it is correct inside a
 * worktree and inside a subdirectory.
 */
export async function discoverRepo(cwd: string): Promise<GitRepoInfo | null> {
  const toplevel = await git(['rev-parse', '--show-toplevel'], { cwd })
  if (toplevel.exitCode !== 0) return null
  const root = normalizeGitPath(toplevel.stdout)
  if (root === '') return null

  const [branchRes, remoteRes, headRes] = await Promise.all([
    git(['rev-parse', '--abbrev-ref', 'HEAD'], { cwd }),
    git(['remote', 'get-url', 'origin'], { cwd }),
    git(['symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD'], { cwd }),
  ])

  const branch = branchRes.exitCode === 0 ? branchRes.stdout.trim() : null
  const remote = remoteRes.exitCode === 0 ? remoteRes.stdout.trim() : null
  const defaultBranch = headRes.exitCode === 0 ? headRes.stdout.trim() : null

  return {
    root,
    branch: branch === 'HEAD' ? null : branch,
    remote: remote === '' ? null : remote,
    defaultBranch: defaultBranch === '' ? null : defaultBranch,
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
