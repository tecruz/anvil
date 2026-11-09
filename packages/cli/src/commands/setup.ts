/** Read-only setup plans. No installer, approval writer, apply command or environment probes. */
import { closeSync, constants, fstatSync, openSync, readdirSync, readSync, realpathSync, statSync } from 'node:fs'
import { dirname, isAbsolute, resolve, sep } from 'node:path'
import { AnvilError, ErrorCode, loadConfig, parseCliArgs } from '@anvil/core'
import {
  buildSetupApprovalGrant,
  buildSetupExecutionPlan,
  buildSetupPlan,
  extractSetupExecutionRequest,
  inspectSetupApproval,
  isSetupExecutionPlan,
  revokeSetupApproval,
  type SetupApprovalRecord,
  SetupExecutionError,
  type SetupExecutionPlan,
  type SetupExecutionPlanValidation,
  type SetupPlan,
  type SetupRepositoryState,
  saveSetupApprovalGrant,
  validateSetupExecutionPlan,
  validateSetupPlan,
} from '@anvil/derive'
import { git, normalizeGitPath, probePromisorRemote, type RunResult, readOnlyGitEnv } from '@anvil/git'
import { loadProfile, parseMaxFiles } from './doctor.ts'
import type { Command, CommandContext } from './types.ts'

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
  summary: 'Generate, validate, approve or revoke a setup plan; never execute or apply it.',
  usage:
    'anvil setup <plan|validate|approve|approval|revoke> [--json] [--profile <dir>] [--max-files <n>] [--plan <file>] [--grant <id>] [--adapter local-skill --source <file> --name <name>]',
  details: [
    'plan       Describe owner-declared install commands, or plan one local-skill installation.',
    'validate   Compare saved plan JSON with fresh inputs; requires --plan <file>.',
    'approve    Grant one application of a current local-skill plan; requires --plan <file> and a typed confirmation.',
    'approval   Inspect a stored grant; requires --grant <id>.',
    'revoke     Withdraw a stored grant; requires --grant <id>.',
    '',
    'plan --adapter local-skill --source <repo-relative-file> --name <name>',
    '           Build an inspect-only execution plan for one repository-local SKILL.md.',
    '',
    'No setup commands, version probes, service connections or file writes are performed.',
    'Only Git metadata commands run. Approval grants are stored outside the repository.',
    'Opaque install commands remain proposal-only; only a local-skill execution plan can be approved.',
    'A local-skill plan is create-only and refuses an existing destination.',
    "Save the JSON envelope's data object outside the worktree (or in an ignored file).",
    'There is no apply command: approving a plan never writes to the repository.',
  ].join('\n'),
  flags: {
    json: { type: 'boolean', short: 'j' },
    help: { type: 'boolean', short: 'h' },
    profile: { type: 'string' },
    'max-files': { type: 'string' },
    plan: { type: 'string' },
    grant: { type: 'string' },
    adapter: { type: 'string' },
    source: { type: 'string' },
    name: { type: 'string' },
  },
  async run(ctx, rawArgs) {
    const args = parseCliArgs(rawArgs, setupCommand.flags)
    const sub = args.positionals[0]
    const planPath = args.values.plan
    const grantId = typeof args.values.grant === 'string' ? args.values.grant : undefined
    const adapter = typeof args.values.adapter === 'string' ? args.values.adapter : undefined
    const source = typeof args.values.source === 'string' ? args.values.source : undefined
    const name = typeof args.values.name === 'string' ? args.values.name : undefined
    const usage = (message: string, hint: string) => new AnvilError(ErrorCode.Usage, message, { hint })

    const subcommands = ['plan', 'validate', 'approve', 'approval', 'revoke']
    if (args.positionals.length !== 1 || !subcommands.includes(sub ?? '')) {
      throw usage(
        'Use setup plan, validate, approve, approval or revoke',
        'There is no setup execution or apply command.',
      )
    }
    if (sub === 'approval' || sub === 'revoke') {
      if (adapter !== undefined || source !== undefined || name !== undefined) {
        throw usage(`setup ${sub} reads the grant id`, `Do not pass --adapter, --source or --name with ${sub}.`)
      }
      if (planPath !== undefined) throw usage(`setup ${sub} does not take --plan <file>`, 'Use --grant <id>.')
      if (typeof grantId !== 'string' || grantId === '') {
        throw usage(`setup ${sub} requires --grant <id>`, 'Use the grant id printed by setup approve.')
      }
    } else if (sub === 'plan') {
      if (planPath !== undefined) {
        throw usage('setup plan does not take --plan <file>', 'Use setup validate --plan <file>.')
      }
      if (grantId !== undefined)
        throw usage('setup plan does not take --grant <id>', 'Use setup approval --grant <id>.')
      if (adapter === undefined && (source !== undefined || name !== undefined)) {
        throw usage('--source and --name require --adapter local-skill', 'Choose an explicit adapter.')
      }
      if (adapter !== undefined) {
        if (adapter !== 'local-skill') {
          throw usage('Unsupported setup adapter', 'Use --adapter local-skill; no other adapter is implemented.')
        }
        if (source === undefined || source === '') {
          throw usage(
            '--adapter local-skill requires --source <repo-relative-file>',
            'The source must be a file inside this repository.',
          )
        }
        if (name === undefined || name === '') {
          throw usage(
            '--adapter local-skill requires --name <skill-name>',
            'The name must match the skill name in its frontmatter.',
          )
        }
      }
    } else {
      if (adapter !== undefined || source !== undefined || name !== undefined) {
        throw usage(
          `setup ${sub} reads adapter inputs from the saved plan`,
          `Do not pass --adapter, --source or --name with ${sub}.`,
        )
      }
      if (typeof planPath !== 'string' || planPath === '') {
        throw usage(`setup ${sub} requires --plan <file>`, 'Save the JSON data object produced by setup plan.')
      }
      if (grantId !== undefined)
        throw usage(`setup ${sub} does not take --grant <id>`, 'Use setup approval --grant <id>.')
    }

    // approval and revoke read the user-owned grant store; neither needs a repository.
    if (sub === 'approval' || sub === 'revoke') {
      const record =
        sub === 'approval'
          ? inspectSetupApproval(grantId as string, await currentRepositoryState(ctx))
          : revokeSetupApproval(grantId as string)
      const expected: SetupApprovalRecord['status'] = sub === 'revoke' ? 'revoked' : 'active'
      if (record.status === expected) {
        ctx.out(record, () => renderApproval(record))
        return
      }
      const error = new AnvilError(ErrorCode.PreflightFailed, record.reason, {
        hint: 'Nothing was applied. Inspect the grant, or issue a fresh approval with setup approve.',
      })
      ctx.outFailure(record, error, () => `${record.status}: ${record.reason}\n`)
      return error.exitCode
    }

    const target = typeof args.values.profile === 'string' ? args.values.profile : undefined
    const profile = await loadProfile(ctx, target, parseMaxFiles(args.values['max-files']))
    const root = normalizeGitPath(profile.root)
    // Incomplete detection cannot be treated as an approval-ready repository snapshot.
    const refreshRepository = async (): Promise<SetupRepositoryState> => {
      const state = await repositoryState(root)
      if (profile.diagnostics.truncated || profile.diagnostics.failedDetectors.length > 0) state.worktree = 'unknown'
      return state
    }
    let repository = await refreshRepository()

    if (sub === 'plan') {
      if (adapter === undefined) {
        const declared = loadConfig({ repoRoot: root }).config.project
        const plan = buildSetupPlan({ repository, declared, projectDir: profile.projectDir })
        ctx.out(plan, () => renderPlan(plan))
      } else {
        const plan = buildSetupExecutionPlan({ repository, sourcePath: source as string, name: name as string })
        ctx.out(plan, () => renderExecutionPlan(plan))
      }
      return
    }

    const saved = readPlan(resolve(ctx.cwd, planPath as string))

    if (sub === 'approve') {
      if (!isSetupExecutionPlan(saved)) {
        throw new AnvilError(ErrorCode.PreflightFailed, 'Only a local-skill execution plan can be approved.', {
          hint: 'Owner-command proposals remain inspect-only; use setup plan --adapter local-skill.',
        })
      }
      const first = resolveExecutionPlan(saved, repository)
      if (first.validation.status !== 'current' || first.plan === null) {
        const error = new AnvilError(ErrorCode.PreflightFailed, first.validation.reason, {
          hint: 'Generate a fresh plan from a clean commit and review it before approving.',
        })
        ctx.outFailure(first.validation, error, () => `${first.validation.status}: ${first.validation.reason}\n`)
        return error.exitCode
      }

      // Show the plan, then challenge the reviewer to type its digest. A machine-readable
      // digest passed on the command line is not consent, so it is not accepted as one.
      const entered = await confirmPlanDigest(ctx, first.plan)
      if (entered === null || entered === '') {
        throw usage('setup approve needs an interactive confirmation', 'Type the full plan digest when prompted.')
      }
      // The repository may have moved while the reviewer read; revalidate after confirming.
      repository = await refreshRepository()
      const second = resolveExecutionPlan(saved, repository)
      if (second.validation.status !== 'current' || second.plan === null) {
        const error = new AnvilError(ErrorCode.PreflightFailed, second.validation.reason, {
          hint: 'The plan changed while you were confirming it. Review the fresh plan and approve again.',
        })
        ctx.outFailure(second.validation, error, () => `${second.validation.status}: ${second.validation.reason}\n`)
        return error.exitCode
      }
      if (entered !== second.plan.digest) {
        throw new AnvilError(ErrorCode.PreflightFailed, 'The confirmation does not match the current plan digest.', {
          hint: 'Run setup plan again, read the digest, and type it exactly when prompted.',
        })
      }

      const grant = buildSetupApprovalGrant(second.plan)
      saveSetupApprovalGrant(grant)
      // Read the record back, so a plan that moved between the write and the read cannot be
      // reported as a successful approval.
      const record = inspectSetupApproval(grant.id, repository)
      if (record.status !== 'active') {
        const error = new AnvilError(ErrorCode.PreflightFailed, record.reason, {
          hint: 'The plan changed before the grant completed. Inspect the grant, then approve again.',
        })
        ctx.outFailure(record, error, () => `${record.status}: ${record.reason}\n`)
        return error.exitCode
      }
      ctx.out(record, () => renderApproval(record))
      return
    }

    const validation = isSetupExecutionPlan(saved)
      ? executionValidation(saved, repository)
      : validateSetupPlan(
          saved,
          buildSetupPlan({
            repository,
            declared: loadConfig({ repoRoot: root }).config.project,
            projectDir: profile.projectDir,
          }),
        )
    if (validation.status !== 'current') {
      const error = new AnvilError(ErrorCode.PreflightFailed, validation.reason, {
        hint: 'Generate a fresh plan from a clean commit and review it. No setup or approval has occurred.',
      })
      ctx.outFailure(validation, error, () => `${validation.status}: ${validation.reason}\n`)
      return error.exitCode
    }
    ctx.out(validation, () => `${validation.status}: ${validation.reason}`)
  },
}

/** Resolve the current repository state for a grant check, or null outside a repository. */
async function currentRepositoryState(ctx: CommandContext): Promise<SetupRepositoryState | null> {
  if (ctx.repoRoot === null) return null
  try {
    return await repositoryState(normalizeGitPath(ctx.repoRoot))
  } catch {
    return null
  }
}

/**
 * Show the plan and read the reviewer's confirmation. The digest must be typed (or piped) on
 * stdin: a flag cannot prove that anyone looked at the plan. In JSON mode the prompt goes to
 * stderr so stdout stays a single JSON document.
 */
async function confirmPlanDigest(ctx: CommandContext, plan: SetupExecutionPlan): Promise<string | null> {
  if (!ctx.json) ctx.say(renderExecutionPlan(plan))
  const prompt = 'Type the plan digest to confirm this approval: '
  if (ctx.json) ctx.writeError(prompt)
  else ctx.writeRaw(prompt)
  return readStdinLine()
}

/** Read one line from stdin; null when stdin ends before a line arrives. */
function readStdinLine(): Promise<string | null> {
  return new Promise((resolvePromise) => {
    const stdin = process.stdin
    let data = ''
    let settled = false
    const done = (value: string | null) => {
      if (settled) return
      settled = true
      resolvePromise(value)
    }
    stdin.setEncoding('utf8')
    stdin.on('data', (chunk: string) => {
      data += chunk
      const newline = data.indexOf('\n')
      if (newline !== -1) done(data.slice(0, newline).trim())
    })
    stdin.on('end', () => done(data.trim() === '' ? null : data.trim()))
    stdin.on('error', () => done(null))
    stdin.resume()
  })
}

function renderApproval(record: SetupApprovalRecord): string {
  const lines = [`Approval: ${record.status}`, `reason: ${record.reason}`]
  const grant = record.grant
  if (grant !== null) {
    lines.push(
      `grant: ${grant.id}`,
      `permission: ${grant.permission}`,
      `plan digest: ${grant.planDigest}`,
      `adapter: ${grant.adapter} (fingerprint ${grant.adapterFingerprint})`,
      `source: ${grant.source.path} (${grant.source.bytes} bytes, sha256 ${grant.source.sha256})`,
      `destination: ${grant.skill.destination}`,
      `repository: ${grant.repository.root} @ ${grant.repository.head}`,
      `issued: ${grant.issuedAt}`,
      `expires: ${grant.expiresAt}`,
      `attempts: ${grant.maxAttempts}`,
    )
  }
  lines.push('Not applied. Nothing was written to the repository; this slice has no apply command.')
  return lines.join('\n')
}

/**
 * Rebuild an execution plan from a saved plan's bounded inputs and compare it with current
 * state. The saved plan supplies only the adapter inputs; it never supplies approval, a
 * destination or a command. The rebuilt plan is returned so a caller can bind a grant to it.
 */
function resolveExecutionPlan(
  saved: unknown,
  repository: SetupRepositoryState,
): { plan: SetupExecutionPlan | null; validation: SetupExecutionPlanValidation } {
  const result = (status: SetupExecutionPlanValidation['status'], reason: string): SetupExecutionPlanValidation => ({
    schemaVersion: 1,
    status,
    approval: 'not-granted',
    executed: false,
    reason,
  })
  let request: ReturnType<typeof extractSetupExecutionRequest>
  try {
    request = extractSetupExecutionRequest(saved)
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : 'Unsupported setup-execution-plan format.'
    return { plan: null, validation: result('invalid', message) }
  }
  let current: SetupExecutionPlan
  try {
    current = buildSetupExecutionPlan({ repository, sourcePath: request.sourcePath, name: request.name })
  } catch (cause) {
    if (cause instanceof SetupExecutionError)
      return { plan: null, validation: result(cause.validationStatus, cause.message) }
    if (cause instanceof AnvilError) return { plan: null, validation: result('invalid', cause.message) }
    throw cause
  }
  return { plan: current, validation: validateSetupExecutionPlan(saved, current) }
}

/** Validate an execution plan against current inputs. */
function executionValidation(saved: unknown, repository: SetupRepositoryState): SetupExecutionPlanValidation {
  return resolveExecutionPlan(saved, repository).validation
}

function fenceFor(content: string): string {
  let longest = 0
  for (const match of content.matchAll(/`+/g)) longest = Math.max(longest, match[0].length)
  return '`'.repeat(Math.max(3, longest + 1))
}

/**
 * Make a skill's bytes safe to print.
 *
 * A skill file is data from a repository the user may not own, so terminal control
 * sequences in it (erase-screen, cursor moves, OSC title changes) must not be allowed to
 * drive the reviewer's terminal; a fence protects the editor, not the terminal. Newlines
 * and tabs are layout and stay; every other C0 control, DEL and the C1 range is shown as a
 * visible escape. The JSON payload and the recorded hash keep the exact bytes -- only this
 * human preview is transformed.
 */
function escapeTerminalControls(text: string): string {
  return text.replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, (control) => {
    return `\\u${(control.codePointAt(0) ?? 0).toString(16).padStart(4, '0')}`
  })
}

function renderExecutionPlan(plan: SetupExecutionPlan): string {
  const content = escapeTerminalControls(plan.source.content)
  const fence = fenceFor(content)
  const lines = [
    `Execution plan: ${plan.digest}`,
    `adapter: ${plan.adapter} (fingerprint ${plan.adapterFingerprint})`,
    `root: ${plan.repository.root}`,
    `HEAD: ${plan.repository.head ?? 'unknown'} (${plan.repository.worktree})`,
    `source: ${plan.source.path} (${plan.source.bytes} bytes, sha256 ${plan.source.sha256})`,
    `destination: ${plan.skill.destination}`,
    'Not approved. Nothing executed. This slice has no approval or apply command.',
    '',
    'Operations:',
  ]
  for (const operation of plan.operations) {
    if (operation.kind === 'write-file') {
      lines.push(
        `  ${operation.kind} ${operation.path} (${operation.precondition}; ${operation.bytes} bytes; sha256 ${operation.sha256}; publish ${operation.publish})`,
      )
    } else {
      lines.push(`  ${operation.kind} ${operation.path} (${operation.precondition})`)
    }
  }
  lines.push(
    '',
    'Effects: filesystem only; no processes, network or credentials; overwrite: false; delete: false.',
    `Verification: ${plan.verification.id} (${plan.verification.scope})`,
    `  ${plan.verification.proves}`,
    '',
    'Skill content:',
    `${fence}markdown`,
    content,
    fence,
    '',
    ...plan.warnings.map((warning) => `Warning: ${warning}`),
  )
  return lines.join('\n')
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
