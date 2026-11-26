/**
 * Isolated verification snapshots.
 *
 * A check recorded on a mutable checkout can pass against files that are not in the commit
 * being shipped. When the owner opts into `features.requireCurrentVerification`, the check
 * runs instead in a throwaway clone checked out at the worktree's clean HEAD. The record still
 * names that commit, and the snapshot is removed as soon as the run finishes.
 *
 * The clone is temporary and read-only in practice: commands may write to it, but nothing
 * there reaches the claim's worktree or the remote. A dirty worktree has no immutable tree to
 * pin, so it fails closed rather than falling back to the mutable checkout.
 */

import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { runProcess } from '@anvil/core'
import { readOnlyGitEnv } from '@anvil/git'

/** The worktree a verification cwd belongs to, found without spawning git. */
export function worktreeRootFor(dir: string): string | null {
  let current = resolve(dir)
  for (;;) {
    if (existsSync(join(current, '.git'))) return current
    const parent = dirname(current)
    if (parent === current) return null
    current = parent
  }
}

export interface VerificationSnapshot {
  /** Root of the isolated checkout, used as the physical cwd for commands. */
  root: string
  /** Clean commit the snapshot was checked out at. */
  commit: string
  /** Delete the temporary checkout. Safe to call more than once. */
  dispose(): void
}

/**
 * Prepare an isolated checkout of a clean worktree's HEAD.
 *
 * Returns `null` when the tree is dirty, HEAD cannot be sampled, or the clone/checkout fails.
 * The caller must fail closed on `null`: there is no immutable tree to bind evidence to.
 */
export async function prepareVerificationSnapshot(worktree: string): Promise<VerificationSnapshot | null> {
  const env = readOnlyGitEnv()
  const status = await runProcess('git', ['--no-optional-locks', 'status', '--porcelain'], { cwd: worktree, env })
  if (status.exitCode !== 0 || status.stdout.trim() !== '') return null
  const head = await runProcess('git', ['rev-parse', '--verify', 'HEAD^{commit}'], { cwd: worktree, env })
  if (head.exitCode !== 0) return null
  const commit = head.stdout.trim()
  if (!/^[0-9a-f]{7,64}$/i.test(commit)) return null

  const root = mkdtempSync(join(tmpdir(), 'anvil-verify-snapshot-'))
  let disposed = false
  const dispose = (): void => {
    if (disposed) return
    disposed = true
    rmSync(root, { recursive: true, force: true })
  }
  try {
    const clone = await runProcess('git', ['clone', '--quiet', '--no-hardlinks', '--shared', worktree, root], { env })
    if (clone.exitCode !== 0) {
      dispose()
      return null
    }
    const checkout = await runProcess('git', ['checkout', '--quiet', '--detach', commit], { cwd: root, env })
    if (checkout.exitCode !== 0) {
      dispose()
      return null
    }
    return { root, commit, dispose }
  } catch {
    dispose()
    return null
  }
}
