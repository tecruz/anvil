/**
 * The push guard: a `pre-push` hook installed into a claimed worktree only.
 *
 * M5 shipped "do not push" as a sentence in the agent prompt, and a sentence is a
 * request, not a control. The one action the whole refuse → verify → push → PR order
 * exists to prevent is an unreviewed branch reaching the remote, so it is enforced by
 * git instead: the claim installs a hook, and the hook refuses every push unless the
 * caller is `anvil ship`.
 *
 * Three properties are deliberate:
 *
 *  - **Per worktree, not per repository.** `core.hooksPath` is normally repository-wide;
 *    setting it with `git config --worktree` keeps the guard inside the claim and leaves
 *    the main worktree -- where a human may be pushing by hand -- untouched.
 *  - **The repository's own hooks still run.** A claim that silently replaced a husky
 *    `pre-commit` would trade one blind spot for another, so every existing hook is
 *    chained through a wrapper, and an existing `pre-push` runs after the guard allows
 *    the push through.
 *  - **The bypass is admitted.** `git push --no-verify` skips any hook. The guard says
 *    so in its refusal, because a control that pretends to be a sandbox is worse than
 *    one that states its boundary.
 */

import { chmodSync, existsSync, mkdirSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { join, normalize } from 'node:path'
import { SHIP_GUARD_ENV } from '@anvil/core'
import { effectiveHooksDir, enableWorktreeConfig, setWorktreeHooksPath } from '@anvil/git'

/** The directory holding the claim's hooks, inside the claimed worktree. */
export const PUSH_GUARD_DIR = '.anvil/hooks'

/** The hook git runs before a push. */
export const PUSH_GUARD_HOOK = 'pre-push'

export interface PushGuardResult {
  /** False when git could not be configured (for example, an old git without `--worktree`). */
  installed: boolean
  /** Where git now looks for hooks in this worktree, when installation succeeded. */
  hooksPath: string | null
  /** The hooks directory that would have run without the guard, when one could be found. */
  previousHooksPath: string | null
  /** Hook names dispatched back to the repository's own hooks, including `pre-push`. */
  chained: string[]
  /** One line for the claim output: what was installed, or why it was not. */
  detail: string
}

/**
 * Install the guard into one worktree.
 *
 * A failure here does not fail the claim. Claiming a ticket is still useful on a git
 * without `--worktree`, and the honest result is a claim that says the guard is missing,
 * not a refusal that leaves an agent without a worktree. The caller prints `detail`.
 */
export async function installPushGuard(options: {
  worktreePath: string
  /** The claim key, embedded in the refusal so it names the command to run instead. */
  key: string
}): Promise<PushGuardResult> {
  const hooksDir = join(options.worktreePath, ...PUSH_GUARD_DIR.split('/'))
  const previousRaw = await effectiveHooksDir(options.worktreePath)
  const previous = previousRaw !== null && normalize(previousRaw) !== normalize(hooksDir) ? previousRaw : null

  const chained: string[] = []
  try {
    mkdirSync(hooksDir, { recursive: true })

    // Dispatch every existing hook except pre-push; it is handled below, after the guard.
    if (previous !== null && existsSync(previous)) {
      for (const entry of readdirSync(previous, { withFileTypes: true })) {
        if (entry.name === PUSH_GUARD_HOOK || entry.name.endsWith('.sample')) continue
        if (!entry.isFile() && !entry.isSymbolicLink()) continue
        writeHook(join(hooksDir, entry.name), renderChainedHook(join(previous, entry.name)))
        chained.push(entry.name)
      }
    }

    const previousPrePush = previous === null ? null : join(previous, PUSH_GUARD_HOOK)
    const chainPrePush = previousPrePush !== null && isFile(previousPrePush)
    if (chainPrePush) chained.push(PUSH_GUARD_HOOK)

    writeHook(
      join(hooksDir, PUSH_GUARD_HOOK),
      renderPrePushHook({
        key: options.key,
        previousHook: chainPrePush ? previousPrePush : null,
      }),
    )

    const enabled = await enableWorktreeConfig(options.worktreePath)
    if (enabled.exitCode !== 0) {
      return {
        installed: false,
        hooksPath: null,
        previousHooksPath: previous,
        chained,
        detail: `per-worktree config is unavailable (${enabled.stderr.trim() || `git exited ${enabled.exitCode}`}); pushes from this worktree are not guarded`,
      }
    }

    const set = await setWorktreeHooksPath(options.worktreePath, hooksDir)
    if (set.exitCode !== 0) {
      return {
        installed: false,
        hooksPath: null,
        previousHooksPath: previous,
        chained,
        detail: `git could not set the worktree hooks path (${set.stderr.trim() || `git exited ${set.exitCode}`}); pushes from this worktree are not guarded`,
      }
    }

    const chainedNote = chained.length === 0 ? 'no repository hooks to chain' : `chained ${chained.join(', ')}`
    return {
      installed: true,
      hooksPath: hooksDir,
      previousHooksPath: previous,
      chained,
      detail: `pre-push refuses pushes unless ${SHIP_GUARD_ENV}=1 (${chainedNote})`,
    }
  } catch (err) {
    return {
      installed: false,
      hooksPath: null,
      previousHooksPath: previous,
      chained,
      detail: `could not install the push guard: ${err instanceof Error ? err.message : String(err)}`,
    }
  }
}

/**
 * The guard itself.
 *
 * The key is embedded rather than read from the environment at push time: a hook runs in
 * the pusher's environment, and the one thing the pusher controls is the environment.
 */
export function renderPrePushHook(options: { key: string; previousHook: string | null }): string {
  const key = guardKey(options.key)
  const lines = [
    '#!/bin/sh',
    '# Installed by `anvil claim` for this worktree only.',
    '#',
    '# An agent commits; a human ships. `anvil ship` sets ANVIL_SHIP=1 on the one push it',
    '# performs, and every other push from this worktree is refused here rather than asked',
    '# for in a prompt the agent can ignore.',
    '#',
    '# `git push --no-verify` bypasses any git hook. This is a control, not a sandbox, and',
    '# an agent that bypasses it is doing something it was told not to do.',
    `if [ "$${SHIP_GUARD_ENV}" = "1" ]; then`,
  ]
  if (options.previousHook === null) {
    lines.push('  exit 0')
  } else {
    lines.push(`  exec ${shellQuote(hookPath(options.previousHook))} "$@"`)
  }
  lines.push('fi')
  lines.push(`echo "anvil: refusing to push from the claimed worktree for ${key}." >&2`)
  lines.push(`echo "anvil: shipping is a human decision; run 'anvil ship ${key}' from the main worktree." >&2`)
  lines.push('echo "anvil: (git push --no-verify bypasses this hook; do not use it from an agent.)" >&2')
  lines.push('exit 1')
  lines.push('')
  return lines.join('\n')
}

/**
 * A hook that dispatches to the repository's own.
 *
 * Only `exec` is needed: git passes the hook arguments and stdin through, and the exit
 * code must be the original's, which `exec` guarantees without a wrapper that could
 * swallow it.
 */
export function renderChainedHook(originalHook: string): string {
  return [
    '#!/bin/sh',
    '# Installed by `anvil claim`: this worktree owns core.hooksPath for the push guard,',
    "# so the repository's own hook is dispatched from here.",
    `exec ${shellQuote(hookPath(originalHook))} "$@"`,
    '',
  ].join('\n')
}

/**
 * A path as Git for Windows' sh understands it.
 *
 * Backslashes are literal inside a single-quoted string, so `C:\repo\hooks\pre-push` would
 * be looked up under that exact name rather than as a path. Forward slashes work on every
 * platform git supports.
 */
function hookPath(value: string): string {
  return value.replace(/\\/g, '/')
}

/**
 * A claim key safe to embed in a shell script.
 *
 * The key originates in a ticket, which is user input. Branch names are sanitized by the
 * same rule, but this code writes the value into an executable file, so it is sanitized
 * again at the point of use rather than trusted because somewhere upstream did it.
 */
export function guardKey(key: string): string {
  const safe = key.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '')
  return safe === '' ? 'claim' : safe
}

/** Quote a string for POSIX sh. The input is a path, but paths can contain quotes. */
export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`
}

function writeHook(path: string, content: string): void {
  writeFileSync(path, content, 'utf8')
  // Git skips a non-executable hook silently on POSIX. On Windows the bit is ignored, so
  // attempting it there is noise rather than behaviour.
  if (process.platform !== 'win32') chmodSync(path, 0o755)
}

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile()
  } catch {
    return false
  }
}
