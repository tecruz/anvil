/** Read-only setup proposals. No installer, approval writer or environment probes. */
import { closeSync, constants, fstatSync, openSync, readSync, realpathSync, statSync } from 'node:fs'
import { resolve } from 'node:path'
import { AnvilError, ErrorCode, loadConfig, parseCliArgs } from '@anvil/core'
import { buildSetupPlan, type SetupPlan, type SetupRepositoryState, validateSetupPlan } from '@anvil/derive'
import { git } from '@anvil/git'
import { loadProfile, parseMaxFiles } from './doctor.ts'
import type { Command } from './types.ts'

/** Git must not execute fsmonitor, clean/process filters or submodule-local helpers. */
async function repositoryState(root: string): Promise<SetupRepositoryState> {
  const options = ['--no-optional-locks', '-c', 'core.fsmonitor=false']
  const [top, head, filters, index] = await Promise.all([
    git([...options, 'rev-parse', '--show-toplevel'], { cwd: root }),
    git([...options, 'rev-parse', '--verify', 'HEAD^{commit}'], { cwd: root }),
    // Names only: configured commands may contain credentials and are never copied out.
    git([...options, 'config', '--null', '--name-only', '--get-regexp', '^filter\\.'], { cwd: root }),
    git([...options, 'ls-files', '--stage', '-z'], { cwd: root }),
  ])
  // A nested --profile must not bind its proposal to a different enclosing project.
  const isRoot = top.exitCode === 0 && realpathSync(top.stdout.trim()) === root
  const state: SetupRepositoryState = {
    root,
    head: isRoot && head.exitCode === 0 ? head.stdout.trim() : null,
    worktree: 'unknown',
  }
  // Do not recurse into submodules, whose local Git configuration can name more helpers.
  // Until recursive capture has its own safety boundary, their state is undecidable here.
  if (!isRoot || index.exitCode !== 0 || index.stdout.split('\0').some((entry) => entry.startsWith('160000 '))) {
    return state
  }
  if (filters.exitCode !== 0 && filters.exitCode !== 1) return state
  for (const key of filters.stdout.split('\0').filter(Boolean)) {
    if (!/\.(clean|smudge|process|required)$/.test(key)) continue
    options.push('-c', `${key}=${key.endsWith('.required') ? 'false' : ''}`)
    options.push('-c', `${key.slice(0, key.lastIndexOf('.'))}.required=false`)
  }
  // A disabled filter can conservatively make a transformed working copy appear dirty.
  // That is preferable to executing a helper just to decide whether a proposal is current.
  const status = await git(
    [...options, 'status', '--porcelain=v1', '-z', '--untracked-files=normal', '--ignore-submodules=all'],
    { cwd: root },
  )
  return {
    ...state,
    worktree: status.exitCode !== 0 ? 'unknown' : status.stdout === '' ? 'clean' : 'dirty',
  }
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
    const root = realpathSync(profile.root)
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
