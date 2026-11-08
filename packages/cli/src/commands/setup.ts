/** Read-only setup proposals. No installer, approval writer or environment probes. */
import { closeSync, constants, fstatSync, openSync, readdirSync, readSync, realpathSync, statSync } from 'node:fs'
import { dirname, isAbsolute, resolve, sep } from 'node:path'
import { AnvilError, ErrorCode, loadConfig, parseCliArgs } from '@anvil/core'
import { buildSetupPlan, type SetupPlan, type SetupRepositoryState, validateSetupPlan } from '@anvil/derive'
import { git, normalizeGitPath, probePromisorRemote, type RunResult, readOnlyGitEnv } from '@anvil/git'
import { loadProfile, parseMaxFiles } from './doctor.ts'
import type { Command } from './types.ts'

/**
 * Classify `git status`. A non-zero exit is incomplete, and so is a warning on stderr:
 * Git can report `could not open directory` while exiting 0 with empty stdout, which
 * must not become `clean`.
 */
export function worktreeFromStatus(result: RunResult): SetupRepositoryState['worktree'] {
  if (result.exitCode !== 0 || result.stderr.trim() !== '') return 'unknown'
  return result.stdout === '' ? 'clean' : 'dirty'
}

function succeeded(result: RunResult): boolean {
  return result.exitCode === 0 && result.stderr.trim() === ''
}

/**
 * Parse a single path from Git's line output without trimming filename whitespace.
 * A leading or trailing space is a valid filename character and changes which directory
 * Git reads, so only the terminating newline is removed. Output that cannot be parsed
 * unambiguously (no terminator, or an embedded newline) stays `null` and thus `unknown`.
 */
function outputPath(result: RunResult): string | null {
  if (!result.stdout.endsWith('\n')) return null
  const path = result.stdout.slice(0, -1)
  return path === '' || /[\r\n]/.test(path) ? null : path
}

/**
 * A split index is rewritten (its `sharedindex.*` mtime is refreshed) by merely reading
 * it, even with `--no-optional-locks`. Detect it before any command that reads the index.
 *
 * `sharedindex.*` is not guaranteed to sit beside the index. A relocated `GIT_INDEX_FILE`
 * can point outside the Git directory while the shared index stays in the Git directory,
 * and a linked index resolves elsewhere again, so both the index directory (as Git was
 * given it, without following links) and the resolved Git directory are checked.
 */
async function splitIndexActive(root: string, call: (args: string[]) => Promise<RunResult>): Promise<boolean> {
  const [config, indexPath, gitDirPath] = await Promise.all([
    call(['config', '--bool', '--get', 'core.splitIndex']),
    // No --path-format: Git falls back to a shared index beside the index path *as given*,
    // and the canonical form resolves a symlinked index away from that directory.
    call(['rev-parse', '--git-path', 'index']),
    call(['rev-parse', '--path-format=absolute', '--absolute-git-dir']),
  ])
  if (config.exitCode === 0) {
    if (config.stderr.trim() !== '' || config.stdout.trim() === 'true') return true
  } else if (config.exitCode !== 1 || config.stderr.trim() !== '') {
    // The setting cannot be read, so the index cannot be proven safe to read either.
    return true
  }
  if (!succeeded(indexPath) || !succeeded(gitDirPath)) return true
  const reportedIndex = outputPath(indexPath)
  const reportedGitDir = outputPath(gitDirPath)
  // Ambiguous output cannot be scanned safely, so the index is not read.
  if (reportedIndex === null || reportedGitDir === null) return true
  try {
    // Resolve the *parent* with filesystem semantics, not `resolve()`, which collapses
    // `..` lexically. With `link -> /outside/child`, `/repo/link/../index` is really
    // `/outside/index`, and Git looks for a shared index beside `/outside`. Keeping the
    // final component unresolved also preserves the directory a linked index was named in.
    const lexicalParent = dirname(isAbsolute(reportedIndex) ? reportedIndex : `${root}${sep}${reportedIndex}`)
    // No `normalizeGitPath` here: its fallback collapses `..` lexically when realpath
    // fails, which could scan the wrong directory. A failure must stay `unknown`.
    const indexParent = realpathSync.native(lexicalParent)
    const dirs = new Set([indexParent, realpathSync.native(reportedGitDir)])
    for (const dir of dirs) {
      // A case-insensitive filesystem can open `sharedindex.*` under any casing, so any
      // casing is treated as a shared index rather than risk reading one.
      if (readdirSync(dir).some((name) => name.toLowerCase().startsWith('sharedindex.'))) return true
    }
    return false
  } catch {
    return true
  }
}

/** Git must not fetch missing objects, execute fsmonitor, filters or submodule-local helpers. */
export async function repositoryState(root: string, run: typeof git = git): Promise<SetupRepositoryState> {
  const env = readOnlyGitEnv()
  // `GIT_NO_LAZY_FETCH` only exists in Git 2.45 and later. When a promisor remote is
  // configured, also ask for `--no-lazy-fetch`: on an older Git the unknown option makes
  // the read fail closed instead of fetching. Non-promisor repositories are unaffected.
  // An incomplete probe still requests the guard, but also keeps the whole snapshot
  // unknown: a configuration read that warned cannot prove either presence or absence.
  const promisor = await probePromisorRemote(root, { env, run })
  const noLazyFetch = promisor.present
  const options = ['--no-optional-locks', '-c', 'core.fsmonitor=false']
  const call = (args: string[]) => run([...options, ...args], { cwd: root, env, noLazyFetch })
  const [top, head, filters, split] = await Promise.all([
    call(['rev-parse', '--show-toplevel']),
    call(['rev-parse', '--verify', 'HEAD^{commit}']),
    // Names only: configured commands may contain credentials and are never copied out.
    call(['config', '--null', '--name-only', '--get-regexp', '^filter\\.']),
    splitIndexActive(root, call),
  ])
  // A nested --profile must not bind its proposal to a different enclosing project.
  // Compare paths the same way repository discovery does: git may report a different
  // drive-letter case or separator style than Node's JavaScript realpath.
  const topPath = succeeded(top) && top.stdout.trim() !== '' ? normalizeGitPath(top.stdout) : null
  const isRoot = topPath !== null && topPath === root
  const state: SetupRepositoryState = {
    root,
    head: isRoot && succeeded(head) ? head.stdout.trim() : null,
    worktree: 'unknown',
  }
  // Without a readable commit there is no complete snapshot to validate against.
  if (!isRoot || state.head === null) return state
  // A warning during the promisor probe leaves configuration partly unread, so the
  // snapshot cannot be called clean even when every later command succeeds.
  if (!promisor.complete) return state
  if ((filters.exitCode !== 0 && filters.exitCode !== 1) || filters.stderr.trim() !== '') return state
  // Do not run status or read the index when a split index would be rewritten on read.
  if (split) return state
  for (const key of filters.stdout.split('\0').filter(Boolean)) {
    if (!/\.(clean|smudge|process|required)$/.test(key)) continue
    // Filter keys are validated by the same pattern above; they are names, not commands.
    options.push('-c', `${key}=${key.endsWith('.required') ? 'false' : ''}`)
    options.push('-c', `${key.slice(0, key.lastIndexOf('.'))}.required=false`)
  }
  // One index read supplies both mode (gitlinks, 160000) and the -v flag column.
  const index = await call(['ls-files', '--stage', '-v', '-z'])
  if (!succeeded(index)) return state
  for (const entry of index.stdout.split('\0')) {
    if (entry === '') continue
    const [tag, mode] = entry.split(' ', 2)
    // A lowercase tag is assume-unchanged; `S` is skip-worktree. Either hides
    // working-tree changes, so status alone cannot establish a clean snapshot.
    if (mode === '160000' || tag === 'S' || /^[a-z]$/.test(tag ?? '')) return state
  }
  // A disabled filter can conservatively make a transformed working copy appear dirty.
  // That is preferable to executing a helper just to decide whether a proposal is current.
  const status = await call(['status', '--porcelain=v1', '-z', '--untracked-files=normal', '--ignore-submodules=all'])
  return { ...state, worktree: worktreeFromStatus(status) }
}

/** Bounded read of a user-selected regular JSON file, never a device or directory. */
function readPlan(path: string): unknown {
  let fd: number | undefined
  try {
    if (!statSync(path).isFile()) throw new Error('Not a regular file')
    fd = openSync(path, constants.O_RDONLY | (constants.O_NONBLOCK ?? 0))
    const stat = fstatSync(fd)
    if (!stat.isFile() || stat.size > 1024 * 1024) throw new Error('Not a regular file under 1 MiB')
    // Bound the actual read as well as the initial stat, even if the file grows meanwhile.
    const bytes = Buffer.alloc(1024 * 1024 + 1)
    let length = 0
    while (length < bytes.length) {
      const count = readSync(fd, bytes, length, bytes.length - length, null)
      if (count === 0) break
      length += count
    }
    if (length > 1024 * 1024) throw new Error('Plan is too large')
    return JSON.parse(bytes.subarray(0, length).toString('utf8'))
  } catch (cause) {
    throw new AnvilError(ErrorCode.ConfigInvalid, 'Cannot read setup plan JSON', {
      hint: 'Choose a regular JSON file under 1 MiB containing the data object from `anvil setup plan --json`.',
      cause,
    })
  } finally {
    if (fd !== undefined) closeSync(fd)
  }
}

export const setupCommand: Command = {
  name: 'setup',
  summary: 'Generate or validate a setup proposal; never execute or approve it.',
  usage: 'anvil setup <plan|validate> [--json] [--profile <dir>] [--max-files <n>] [--plan <file>]',
  details: [
    'plan       Describe owner-declared install commands and emit a content-addressed proposal.',
    'validate   Compare saved plan JSON with fresh inputs; requires --plan <file>.',
    '',
    'No setup commands, version probes, service connections or file writes are performed.',
    'Only Git metadata commands run. No approval is granted, even when a plan is current.',
    'Permissions, file changes and immutable resource references remain unknown.',
    "Save the JSON envelope's data object outside the worktree (or in an ignored file).",
    'Validation refuses changed, dirty or unknown repository state; it is not a sandbox.',
  ].join('\n'),
  flags: {
    json: { type: 'boolean', short: 'j' },
    help: { type: 'boolean', short: 'h' },
    profile: { type: 'string' },
    'max-files': { type: 'string' },
    plan: { type: 'string' },
  },
  async run(ctx, rawArgs) {
    const args = parseCliArgs(rawArgs, setupCommand.flags)
    const sub = args.positionals[0]
    const planPath = args.values.plan
    if (
      args.positionals.length !== 1 ||
      (sub !== 'plan' && sub !== 'validate') ||
      (sub === 'validate' && (typeof planPath !== 'string' || planPath === '')) ||
      (sub === 'plan' && planPath !== undefined)
    ) {
      throw new AnvilError(ErrorCode.Usage, 'Use setup plan, or setup validate --plan <file>', {
        hint: 'There is no setup execution or approval command.',
      })
    }
    const target = typeof args.values.profile === 'string' ? args.values.profile : undefined
    const profile = await loadProfile(ctx, target, parseMaxFiles(args.values['max-files']))
    const root = normalizeGitPath(profile.root)
    const declared = loadConfig({ repoRoot: root }).config.project
    const repository = await repositoryState(root)
    // Incomplete detection cannot be treated as an approval-ready repository snapshot.
    if (profile.diagnostics.truncated || profile.diagnostics.failedDetectors.length > 0) repository.worktree = 'unknown'
    const plan = buildSetupPlan({ repository, declared, projectDir: profile.projectDir })
    if (sub === 'plan') {
      ctx.out(plan, () => renderPlan(plan))
      return
    }
    const validation = validateSetupPlan(readPlan(resolve(ctx.cwd, planPath as string)), plan)
    if (validation.status !== 'current') {
      const error = new AnvilError(ErrorCode.PreflightFailed, validation.reason, {
        hint: 'Generate a fresh proposal from a clean commit and review it. No setup or approval has occurred.',
      })
      ctx.outFailure(validation, error, () => `${validation.status}: ${validation.reason}\n`)
      return error.exitCode
    }
    ctx.out(validation, () => `${validation.status}: ${validation.reason}`)
  },
}

function renderPlan(plan: SetupPlan): string {
  const lines = [
    `Setup proposal: ${plan.digest}`,
    `root: ${plan.repository.root}`,
    `HEAD: ${plan.repository.head ?? 'unknown'} (${plan.repository.worktree})`,
    'Not approved. Nothing executed. No execution adapter is supported.',
  ]
  for (const action of plan.actions) {
    lines.push('', `${action.id} (${action.source})`, `  command: ${action.command}`, `  cwd: ${action.cwd || '.'}`)
    if (action.versionRange !== null) lines.push(`  required version: ${action.versionRange} (not an immutable pin)`)
    lines.push('  permissions / file changes / immutable reference: unknown', '  verification: not-run')
  }
  lines.push('', ...plan.warnings.map((warning) => `Warning: ${warning}`))
  return lines.join('\n')
}
