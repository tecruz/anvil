/** Setup plans, approval grants and the one create-only application path. */
import { closeSync, constants, fstatSync, openSync, readdirSync, readSync, realpathSync, statSync } from 'node:fs'
import { dirname, isAbsolute, resolve, sep } from 'node:path'
import { AnvilError, ErrorCode, loadConfig, parseCliArgs } from '@anvil/core'
import {
  applySetupPlan,
  buildSetupApprovalGrant,
  buildSetupPlan,
  fetchPinnedSkill,
  inspectSetupApproval,
  isSetupExecutionPlan,
  LOCAL_SKILL_ADAPTER,
  type PinnedSkillFetchResult,
  resolveSetupAdapter,
  resolveSetupPlan,
  revokeSetupApproval,
  type SetupApplicationRecord,
  type SetupApprovalRecord,
  type SetupExecutionPlan,
  type SetupExecutionPlanValidation,
  type SetupPlan,
  type SetupRepositoryState,
  saveSetupApprovalGrant,
  setupAdapterList,
  validateSetupPlan,
} from '@anvil/derive'
import { git, normalizeGitPath, probePromisorRemote, type RunResult, readOnlyGitEnv, withRepoLock } from '@anvil/git'
import { loadProfile, parseMaxFiles } from './doctor.ts'
import type { Command, CommandContext } from './types.ts'

/**
 * How long an apply waits for the repository lock.
 *
 * The holder performs several Windows ACL reads and one harden step, each bounded by the
 * approval module's tool timeout. The old 20-second wait could expire while the holder was
 * still doing legitimate, bounded work on a loaded Windows runner. This is a wait bound, not
 * an authority change: a holder that never releases still makes the contender fail.
 */
const SETUP_APPLY_LOCK_TIMEOUT_MS = 120_000

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
  summary: 'Generate, validate, approve, apply or revoke a setup plan; application is create-only and single-use.',
  usage:
    'anvil setup <plan|fetch|validate|approve|approval|revoke|apply> [--json] [--profile <dir>] [--max-files <n>] [--plan <file>] [--grant <id>] [--adapter <adapter>] [--source <file>] [--name <name>] [--repo <owner/name>] [--ref <ref>|--commit <sha>] [--path <file>] [--host <host>]',
  details: [
    'plan       Describe owner-declared install commands, or plan one registered adapter installation.',
    'fetch      Resolve a pinned-skill ref and freeze one SKILL.md in the protected cache; the only network step.',
    'validate   Compare saved plan JSON with fresh inputs; requires --plan <file>.',
    'approve    Grant one application of a current execution plan; requires --plan <file> and a typed confirmation.',
    'approval   Inspect a stored grant; requires --grant <id>.',
    'revoke     Withdraw a stored grant; requires --grant <id>.',
    'apply      Apply an approved execution plan once; requires --plan <file> and --grant <id>.',
    '',
    'plan --adapter local-skill --source <repo-relative-file> --name <name>',
    '           Build an execution plan for one repository-local SKILL.md.',
    'fetch --adapter pinned-skill --repo <owner/name> --ref <ref> --path <repo-file> --name <name>',
    'plan  --adapter pinned-skill --repo <owner/name> --commit <40-hex> --path <repo-file> --name <name>',
    '           Fetch once, then plan offline from the frozen bytes.',
    '',
    'No install commands, version probes, service connections or network fetches are performed.',
    "Only Git metadata commands and the create-only writes of an approved adapter's plan run.",
    'Approval grants are stored outside the repository.',
    'Opaque owner-declared install commands remain proposal-only and cannot be approved or applied.',
    'A local-skill plan is create-only; apply refuses an existing destination and never overwrites.',
    'Only a plan emitted by a registered setup adapter can be approved or applied.',
    "Save the JSON envelope's data object outside the worktree (or in an ignored file).",
    'Application consumes the grant before its first write, journals the outcome and verifies the result.',
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
    repo: { type: 'string' },
    ref: { type: 'string' },
    commit: { type: 'string' },
    path: { type: 'string' },
    host: { type: 'string' },
  },
  async run(ctx, rawArgs) {
    const args = parseCliArgs(rawArgs, setupCommand.flags)
    const sub = args.positionals[0]
    const planPath = args.values.plan
    const grantId = typeof args.values.grant === 'string' ? args.values.grant : undefined
    const adapter = typeof args.values.adapter === 'string' ? args.values.adapter : undefined
    const source = typeof args.values.source === 'string' ? args.values.source : undefined
    const name = typeof args.values.name === 'string' ? args.values.name : undefined
    const repo = typeof args.values.repo === 'string' ? args.values.repo : undefined
    const ref = typeof args.values.ref === 'string' ? args.values.ref : undefined
    const commit = typeof args.values.commit === 'string' ? args.values.commit : undefined
    const skillPath = typeof args.values.path === 'string' ? args.values.path : undefined
    const host = typeof args.values.host === 'string' ? args.values.host : undefined
    const pinnedFlags = [repo, commit, skillPath, host].some((value) => value !== undefined)
    const usage = (message: string, hint: string) => new AnvilError(ErrorCode.Usage, message, { hint })

    const subcommands = ['plan', 'fetch', 'validate', 'approve', 'approval', 'revoke', 'apply']
    if (args.positionals.length !== 1 || !subcommands.includes(sub ?? '')) {
      throw usage(
        'Use setup plan, fetch, validate, approve, approval, revoke or apply',
        `Registered adapters: ${setupAdapterList()}. Owner-declared install commands remain proposal-only.`,
      )
    }
    if (sub === 'approval' || sub === 'revoke') {
      if (adapter !== undefined || source !== undefined || name !== undefined) {
        throw usage(`setup ${sub} reads the grant id`, `Do not pass --adapter, --source or --name with ${sub}.`)
      }
      if (pinnedFlags || ref !== undefined) {
        throw usage(`setup ${sub} does not take pinned-skill flags`, `Use only --grant <id> with ${sub}.`)
      }
      if (planPath !== undefined) throw usage(`setup ${sub} does not take --plan <file>`, 'Use --grant <id>.')
      if (typeof grantId !== 'string' || grantId === '') {
        throw usage(`setup ${sub} requires --grant <id>`, 'Use the grant id printed by setup approve.')
      }
    } else if (sub === 'fetch') {
      if (planPath !== undefined)
        throw usage('setup fetch does not take --plan <file>', 'Use setup plan after fetching.')
      if (grantId !== undefined)
        throw usage('setup fetch does not take --grant <id>', 'A fetch creates no plan or grant.')
      if (source !== undefined)
        throw usage('setup fetch does not take --source', 'Use --repo, --path and --ref or --commit.')
      if (adapter !== 'pinned-skill') {
        throw usage(
          'setup fetch requires --adapter pinned-skill',
          'Fetching is defined only for the pinned-skill adapter.',
        )
      }
      if (repo === undefined) throw usage('setup fetch requires --repo <owner/name>', 'Pass the GitHub repository.')
      if (skillPath === undefined)
        throw usage('setup fetch requires --path <repo-file>', 'Pass the repository-relative file path.')
      if (name === undefined) throw usage('setup fetch requires --name <skill-name>', 'Pass the installed skill name.')
      if (ref === undefined && commit === undefined) {
        throw usage(
          'setup fetch requires --ref <ref> or --commit <40-hex>',
          'Resolve a ref, or pass the reviewed commit.',
        )
      }
    } else if (sub === 'plan') {
      if (planPath !== undefined) {
        throw usage('setup plan does not take --plan <file>', 'Use setup validate --plan <file>.')
      }
      if (grantId !== undefined)
        throw usage('setup plan does not take --grant <id>', 'Use setup approval --grant <id>.')
      if (ref !== undefined) {
        throw usage('setup plan does not take --ref', 'Run setup fetch --ref first, then plan with --commit.')
      }
      if (adapter === undefined && (source !== undefined || name !== undefined || pinnedFlags)) {
        throw usage('adapter flags require --adapter', 'Choose local-skill or pinned-skill explicitly.')
      }
      if (adapter === 'local-skill' && pinnedFlags) {
        throw usage(
          '--repo, --commit, --path and --host require --adapter pinned-skill',
          'Use --source with local-skill.',
        )
      }
      if (adapter !== undefined) {
        // Adapter-specific flags are validated by the adapter itself, so a new adapter cannot
        // be wired into planning without also declaring its bounded inputs.
        resolveSetupAdapter(adapter).parseRequest({ source, name, repo, commit, path: skillPath, host })
      }
    } else if (sub === 'apply') {
      if (adapter !== undefined || source !== undefined || name !== undefined || pinnedFlags || ref !== undefined) {
        throw usage(
          'setup apply reads adapter inputs from the saved plan',
          'Do not pass adapter, source, pinned-skill or ref flags with apply.',
        )
      }
      if (typeof planPath !== 'string' || planPath === '') {
        throw usage('setup apply requires --plan <file>', 'Save the JSON data object produced by setup plan.')
      }
      if (typeof grantId !== 'string' || grantId === '') {
        throw usage('setup apply requires --grant <id>', 'Apply only the grant you approved, exactly once.')
      }
    } else {
      if (adapter !== undefined || source !== undefined || name !== undefined || pinnedFlags || ref !== undefined) {
        throw usage(
          `setup ${sub} reads adapter inputs from the saved plan`,
          `Do not pass adapter, source, pinned-skill or ref flags with ${sub}.`,
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

    // fetch is the only network step; it needs a repository root to keep the store outside it.
    if (sub === 'fetch') {
      if (ctx.repoRoot === null) {
        throw usage(
          'setup fetch must run inside a Git repository',
          'The protected cache is checked to stay outside the checkout.',
        )
      }
      const result = await fetchPinnedSkill({
        repositoryRoot: normalizeGitPath(ctx.repoRoot),
        ...(host === undefined ? {} : { host }),
        repo: repo as string,
        ...(ref === undefined ? {} : { ref }),
        ...(commit === undefined ? {} : { commit }),
        path: skillPath as string,
        name: name as string,
      })
      ctx.out(result, () => renderFetch(result))
      return
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
    const repository = await refreshRepository()

    if (sub === 'plan') {
      if (adapter === undefined) {
        const declared = loadConfig({ repoRoot: root }).config.project
        const plan = buildSetupPlan({ repository, declared, projectDir: profile.projectDir })
        ctx.out(plan, () => renderPlan(plan))
      } else {
        const definition = resolveSetupAdapter(adapter)
        const plan = definition.build(
          repository,
          definition.parseRequest({ source, name, repo, commit, path: skillPath, host }),
        )
        ctx.out(plan, () => renderExecutionPlan(plan))
      }
      return
    }

    const saved = readPlan(resolve(ctx.cwd, planPath as string))

    if (sub === 'apply') {
      if (!isSetupExecutionPlan(saved)) {
        throw new AnvilError(ErrorCode.PreflightFailed, 'Only a registered setup execution plan can be applied.', {
          hint: `Owner-command proposals remain inspect-only; use setup plan --adapter ${setupAdapterList()}.`,
        })
      }
      const record = await applySetupPlan({
        saved,
        repository,
        grantId: grantId as string,
        lock: (work) => withRepoLock({ cwd: root, name: 'setup-apply', timeoutMs: SETUP_APPLY_LOCK_TIMEOUT_MS }, work),
        refresh: refreshRepository,
      })
      if (record.status === 'applied') {
        ctx.out(record, () => renderApplication(record))
        return
      }
      const error = new AnvilError(ErrorCode.PreflightFailed, record.reason, {
        hint: 'Nothing is reported as a completed integration. Inspect the destination and journal; a new attempt needs fresh approval.',
      })
      ctx.outFailure(record, error, () => renderApplicationFailure(record))
      return error.exitCode
    }

    if (sub === 'approve') {
      if (!isSetupExecutionPlan(saved)) {
        throw new AnvilError(ErrorCode.PreflightFailed, 'Only a registered setup execution plan can be approved.', {
          hint: `Owner-command proposals remain inspect-only; use setup plan --adapter ${setupAdapterList()}.`,
        })
      }
      try {
        const record = await approveSetupPlan({
          saved,
          repository,
          confirm: (plan) => confirmPlanDigest(ctx, plan),
          refresh: refreshRepository,
        })
        ctx.out(record, () => renderApproval(record))
      } catch (cause) {
        if (cause instanceof SetupApprovalRefusal) {
          ctx.outFailure(cause.payload, cause, () => `${cause.payload.status}: ${cause.payload.reason}\n`)
          return cause.exitCode
        }
        throw cause
      }
      return
    }

    const validation = isSetupExecutionPlan(saved)
      ? resolveSetupPlan(saved, repository).validation
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
 * The approval flow, with confirmation and repository refresh injected so the ordering can be
 * exercised without a terminal: show the plan, read the digest, revalidate, publish, then read
 * the record back against freshly read state.
 */
export interface SetupApprovalFlow {
  saved: unknown
  repository: SetupRepositoryState
  confirm(plan: SetupExecutionPlan): Promise<string | null>
  refresh(): Promise<SetupRepositoryState>
  env?: NodeJS.ProcessEnv
}

/** A refusal that carries the validation or record the caller should report on the envelope. */
export class SetupApprovalRefusal extends AnvilError {
  readonly payload: SetupExecutionPlanValidation | SetupApprovalRecord

  constructor(payload: SetupExecutionPlanValidation | SetupApprovalRecord, hint: string) {
    super(ErrorCode.PreflightFailed, payload.reason, { hint })
    this.name = 'SetupApprovalRefusal'
    this.payload = payload
  }
}

/**
 * Approve one current local-skill plan, returning the active grant record.
 *
 * A refused approval throws: a {@link SetupApprovalRefusal} carries the validation or record
 * to report, and anything else is a usage or internal error. Nothing is written to the
 * repository.
 */
export async function approveSetupPlan(flow: SetupApprovalFlow): Promise<SetupApprovalRecord> {
  const storeOptions = flow.env === undefined ? {} : { env: flow.env }
  const first = resolveSetupPlan(flow.saved, flow.repository)
  if (first.validation.status !== 'current' || first.plan === null) {
    throw new SetupApprovalRefusal(
      first.validation,
      'Generate a fresh plan from a clean commit and review it before approving.',
    )
  }
  const entered = await flow.confirm(first.plan)
  if (entered === null || entered === '') {
    throw new AnvilError(ErrorCode.Usage, 'setup approve needs an interactive confirmation', {
      hint: 'Type the full plan digest when prompted.',
    })
  }
  // The repository may have moved while the reviewer read; revalidate after confirming.
  const revalidated = await flow.refresh()
  const second = resolveSetupPlan(flow.saved, revalidated)
  if (second.validation.status !== 'current' || second.plan === null) {
    throw new SetupApprovalRefusal(
      second.validation,
      'The plan changed while you were confirming it. Review the fresh plan and approve again.',
    )
  }
  if (entered !== second.plan.digest) {
    throw new AnvilError(ErrorCode.PreflightFailed, 'The confirmation does not match the current plan digest.', {
      hint: 'Run setup plan again, read the digest, and type it exactly when prompted.',
    })
  }

  const grant = buildSetupApprovalGrant(second.plan)
  saveSetupApprovalGrant(grant, storeOptions)
  // Read the record back against freshly read state, so a repository that moved during
  // publication cannot be reported as a successful approval.
  const record = inspectSetupApproval(grant.id, await flow.refresh(), storeOptions)
  if (record.status !== 'active') {
    throw new SetupApprovalRefusal(
      record,
      'The plan changed before the grant completed. Inspect the grant, then approve again.',
    )
  }
  return record
}

/**
 * Show the plan and read the reviewer's confirmation from an interactive terminal.
 *
 * The plan is always shown, in text and JSON mode alike, so nobody approves bytes they have
 * not seen; in JSON mode the preview and prompt go to stderr so stdout stays one document. A
 * non-interactive stdin is refused: piped input is not a review, and a digest passed as a
 * flag is not consent either.
 */
async function confirmPlanDigest(ctx: CommandContext, plan: SetupExecutionPlan): Promise<string | null> {
  const preview = renderExecutionPlan(plan)
  if (ctx.json) ctx.writeError(`${preview}\n`)
  else ctx.say(preview)
  if (process.stdin.isTTY !== true) {
    throw new AnvilError(ErrorCode.Usage, 'setup approve requires an interactive terminal', {
      hint: 'Run it from a terminal and type the plan digest. Piped input is not a review.',
    })
  }
  const prompt = 'Type the plan digest to confirm this approval: '
  if (ctx.json) ctx.writeError(prompt)
  else ctx.writeRaw(prompt)
  return readStdinLine()
}

/**
 * Read one line from stdin, then release it so the process can exit; null at end of input.
 * The listeners are removed and the stream is paused on every completion path, otherwise a
 * resume that never sees a newline keeps the event loop alive.
 */
function readStdinLine(): Promise<string | null> {
  return new Promise((resolvePromise) => {
    const stdin = process.stdin
    let data = ''
    let settled = false
    const finish = (value: string | null) => {
      if (settled) return
      settled = true
      stdin.off('data', onData)
      stdin.off('end', onEnd)
      stdin.off('error', onError)
      stdin.pause()
      // A paused stdin still holds the event loop open, so release it: reading is finished
      // and the command must be able to exit.
      if (typeof stdin.unref === 'function') stdin.unref()
      resolvePromise(value)
    }
    const onData = (chunk: string) => {
      data += chunk
      const newline = data.indexOf('\n')
      if (newline !== -1) finish(data.slice(0, newline).trim())
    }
    const onEnd = () => finish(data.trim() === '' ? null : data.trim())
    const onError = () => finish(null)
    stdin.setEncoding('utf8')
    stdin.on('data', onData)
    stdin.on('end', onEnd)
    stdin.on('error', onError)
    stdin.resume()
  })
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
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
    )
    if (grant.schemaVersion === 1) {
      lines.push(
        `source: ${grant.source.path} (${grant.source.bytes} bytes, sha256 ${grant.source.sha256})`,
        `destination: ${grant.skill.destination}`,
      )
    } else {
      const origin = isRecord(grant.bindings.origin) ? grant.bindings.origin : null
      const content = isRecord(grant.bindings.content) ? grant.bindings.content : null
      const skill = isRecord(grant.bindings.skill) ? grant.bindings.skill : null
      lines.push(`bindings digest: ${grant.bindingsDigest}`)
      if (origin !== null && typeof origin.url === 'string') lines.push(`origin: ${origin.url}`)
      if (origin !== null && typeof origin.commit === 'string') lines.push(`commit: ${origin.commit}`)
      if (content !== null && typeof content.bytes === 'number' && typeof content.sha256 === 'string') {
        lines.push(`content: ${content.bytes} bytes, sha256 ${content.sha256}`)
      }
      if (skill !== null && typeof skill.destination === 'string') lines.push(`destination: ${skill.destination}`)
    }
    lines.push(
      `repository: ${grant.repository.root} @ ${grant.repository.head}`,
      `issued: ${grant.issuedAt}`,
      `expires: ${grant.expiresAt}`,
      `attempts: ${grant.maxAttempts}`,
    )
  }
  lines.push('Not applied by this command. Use setup apply with the grant to install the approved plan.')
  return lines.join('\n')
}

function renderFetch(record: PinnedSkillFetchResult): string {
  return [
    `Fetch: ${record.status}${record.wrote ? '' : ' (already cached)'}`,
    `origin: ${record.origin.url}`,
    `commit: ${record.origin.commit}`,
    `path: ${record.origin.path}`,
    `bytes: ${record.record.bytes} (sha256 ${record.record.blobSha256})`,
    `requested ref: ${record.record.requestedRef}`,
    `fetched at: ${record.record.fetchedAt}`,
    'The bytes are frozen in the protected cache. Planning, validation, approval and application remain offline.',
    'A commit pins bytes, not authorship, review, licensing or safety.',
  ].join('\n')
}

function renderApplication(record: SetupApplicationRecord): string {
  const lines = [
    `Application: ${record.status}${record.alreadyApplied ? ' (already applied)' : ''}`,
    `reason: ${record.reason}`,
    `plan digest: ${record.planDigest ?? 'unknown'}`,
    `destination: ${record.destination ?? 'unknown'}`,
    `verified: ${record.verified}`,
  ]
  if (record.grant !== null) lines.push(`grant: ${record.grant.id}`)
  if (record.verification !== null) {
    lines.push('Verification:')
    for (const check of record.verification.checks) {
      lines.push(`  ${check.ok ? 'ok' : 'failed'}: ${check.name} — ${check.detail}`)
    }
    lines.push(`  ${record.verification.proves}`)
  }
  if (record.journal !== null) {
    lines.push(`journal: ${record.journal.status} (started ${record.journal.startedAt})`)
  }
  if (record.executed) lines.push('The repository was modified by this command.')
  return lines.join('\n')
}

function renderApplicationFailure(record: SetupApplicationRecord): string {
  const lines = [`Application ${record.status}: ${record.reason}`]
  if (record.destination !== null) lines.push(`destination: ${record.destination}`)
  if (record.verification !== null) {
    for (const check of record.verification.checks) {
      if (!check.ok) lines.push(`  failed: ${check.name} — ${check.detail}`)
    }
  }
  lines.push('Nothing is reported as a completed integration. No automatic retry is allowed.')
  return `${lines.join('\n')}\n`
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
    plan.adapter === LOCAL_SKILL_ADAPTER
      ? `source: ${plan.source.path} (${plan.source.bytes} bytes, sha256 ${plan.source.sha256})`
      : `origin: ${plan.origin.url} (commit ${plan.origin.commit}, path ${plan.origin.path})`,
    `content: ${plan.source.bytes} bytes, sha256 ${plan.source.sha256}`,
    `destination: ${plan.skill.destination}`,
    'Not approved. Nothing executed. Approval and application are separate commands.',
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
    'Not approved. Nothing executed. Owner-declared install commands cannot be approved or applied.',
  ]
  for (const action of plan.actions) {
    lines.push('', `${action.id} (${action.source})`, `  command: ${action.command}`, `  cwd: ${action.cwd || '.'}`)
    if (action.versionRange !== null) lines.push(`  required version: ${action.versionRange} (not an immutable pin)`)
    lines.push('  permissions / file changes / immutable reference: unknown', '  verification: not-run')
  }
  lines.push('', ...plan.warnings.map((warning) => `Warning: ${warning}`))
  return lines.join('\n')
}
