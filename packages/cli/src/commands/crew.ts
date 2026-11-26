/**
 * `anvil crew` -- run several tickets in parallel.
 *
 * `crew up` claims N tickets and optionally starts an agent in each worktree; `crew verify`
 * runs every worktree's verification under a concurrency policy the tool will explain.
 */

import { createHash } from 'node:crypto'
import {
  closeSync,
  existsSync,
  constants as fsConstants,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readSync,
  renameSync,
  writeFileSync,
} from 'node:fs'
import { dirname, join, relative } from 'node:path'
import {
  AnvilError,
  ErrorCode,
  ExitCode,
  loadConfig,
  parseCliArgs,
  renderTable,
  runProcess,
  tokenizeCommand,
} from '@anvil/core'
import { gitDirFromMetadata, readOnlyGitEnv } from '@anvil/git'
import { buildProfile, verificationPlan } from '@anvil/profile'
import { requireCapability } from '@anvil/providers'
import type { Ticket, TicketRef } from '@anvil/tickets'
import { claimAgentPid, claimStatuses, readAgentSession, readClaims } from '@anvil/worktrees'
import { type CrewVerifyResult, crewUp, crewVerify, isProcessAlive, mapWithConcurrency } from '@anvil/worktrees/crew'
import { formatCost, lookupSessionCosts } from '../cost.ts'
import { ticketProviderFor } from '../tickets.ts'
import {
  type CurrentEvidenceRecord,
  type EvidenceRecord,
  isCurrentEvidenceRecord,
  planDigestForEntries,
  selectVerificationRecords,
  VERIFICATION_EVIDENCE_MAX_BYTES,
  validCwd,
} from '../verification-evidence.ts'
import { prepareVerificationSnapshot, type VerificationSnapshot, worktreeRootFor } from '../verification-snapshot.ts'
import { recommendForWorktree } from './recommend.ts'
import type { Command, CommandContext } from './types.ts'

const GLOBAL_ONLY = {
  json: { type: 'boolean', short: 'j' },
  help: { type: 'boolean', short: 'h' },
} as const

const CREW_SUBCOMMANDS = ['up', 'status', 'verify'] as const

export const crewCommand: Command = {
  name: 'crew',
  summary: 'Claim several tickets at once, start agents, and verify them together.',
  usage: 'anvil crew <up|status|verify> [flags]',
  details: [
    'up       claim N tickets in one command, optionally starting an agent in each',
    'status   every claim, whether its agent is still alive, and what would be lost',
    "verify   run every worktree's verify commands under a concurrency policy",
    '',
    'Claims are created one at a time, because `git worktree add` mutates the',
    "repository's shared administrative area. Agents then start in parallel, because each",
    'one only touches its own worktree.',
    '',
    'verify picks its concurrency from the toolchain: Gradle, Maven, npm, pnpm, Yarn and',
    'Bazel all keep mutable state in a shared home-directory cache, so those serialize to',
    'one at a time. Go and Cargo are content-addressed or self-locking, so they run',
    'concurrently. The decision is always printed.',
    '',
    '--launch          start an agent in each new worktree',
    '--runner <r>      agent binary, default `opencode`',
    '--provider <p>    ticket provider for the whole crew: local (default), github or jira',
    '--jobs <n>        concurrent verify runs (overrides the cache policy only with --force-parallel)',
    '--force-parallel  ignore the cache policy and use --jobs literally',
    '--record          with `verify`, write bounded revision-bound evidence for the dashboard',
    '--cost            with `status`, show what each agent session cost',
    '',
    'Cost is read from ccusage, which prices the usage logs the agents already wrote on',
    'this machine. Nothing is uploaded, and a missing ccusage is a note, not a failure.',
  ].join('\n'),
  flags: {
    ...GLOBAL_ONLY,
    tickets: { type: 'string' },
    limit: { type: 'string' },
    launch: { type: 'boolean' },
    runner: { type: 'string' },
    provider: { type: 'string' },
    prefix: { type: 'string' },
    base: { type: 'string' },
    jobs: { type: 'string' },
    'force-parallel': { type: 'boolean' },
    record: { type: 'boolean' },
    cost: { type: 'boolean' },
    key: { type: 'string', multiple: true },
  },

  async run(ctx, rawArgs) {
    const args = parseCliArgs(rawArgs, crewCommand.flags)
    const sub = args.positionals[0] ?? 'status'
    if (!(CREW_SUBCOMMANDS as readonly string[]).includes(sub)) {
      throw new AnvilError(ErrorCode.Usage, `Unknown crew subcommand: ${sub}`, {
        hint: `Expected one of: ${CREW_SUBCOMMANDS.join(', ')}`,
      })
    }

    const repoRoot = await mainRootFor(ctx)
    if (sub === 'up') return crewUpFlow(ctx, repoRoot, args)
    if (sub === 'verify') return crewVerifyFlow(ctx, repoRoot, args)
    return crewStatusFlow(ctx, repoRoot, args)
  },
}

// ---------------------------------------------------------------------------
// crew up
// ---------------------------------------------------------------------------

async function crewUpFlow(
  ctx: CommandContext,
  repoRoot: string,
  args: ReturnType<typeof parseCliArgs>,
): Promise<number | undefined> {
  const explicit = typeof args.values.provider === 'string' ? args.values.provider : null
  // One config read for the whole crew: the provider selection and the worktree root come
  // from the same layer, so they cannot disagree.
  const { config } = loadConfig({ repoRoot })
  // Resolve the selection before anything else, so an unknown `--provider` is refused with
  // the supported list rather than wrapped in a per-ticket error.
  const base = await ticketProviderFor(repoRoot, { provider: explicit }, { config })
  // An explicit list stays textual (each entry is resolved on its own, so a mixed list is
  // respected); an automatic list keeps the provider's own refs. Re-parsing a display key
  // loses non-numeric ids: `local-incident` is not `local-` plus an id.
  const refs: Array<string | TicketRef> = splitRefs(args.values.tickets)
  if (refs.length === 0) {
    // No explicit list: take the ready work. A crew is most useful when you do not have to
    // enumerate the tickets yourself.
    requireCapability(base.provider, 'list', 'list tickets')
    // Ask the provider for exactly the requested number of ready tickets: listing more than
    // that only to slice it would make a large backlog look incomplete for no reason.
    const requested = typeof args.values.limit === 'string' ? parsePositiveInt(args.values.limit) : null
    const all =
      (await base.provider.list?.(requested === null ? { state: 'todo' } : { state: 'todo', limit: requested })) ?? []
    const limit = requested ?? all.length
    if (all.length === 0) {
      throw new AnvilError(ErrorCode.Usage, 'No tickets in state `todo`', {
        hint: 'Name them explicitly with --tickets 1,2,3, or create one with `anvil issue create`.',
      })
    }
    refs.push(...all.slice(0, limit))
  }

  const tickets: Ticket[] = []
  for (const raw of refs) {
    const key = typeof raw === 'string' ? raw : raw.key
    try {
      if (typeof raw !== 'string') {
        tickets.push(await base.provider.fetch(raw))
        continue
      }
      // Resolved per reference, so `--tickets 1,gh-2` mixes providers exactly as the
      // selection rule says it should.
      const resolved = await ticketProviderFor(repoRoot, { ref: raw, provider: explicit }, { config })
      if (resolved.ref === undefined) throw new Error('no reference was resolved')
      tickets.push(await resolved.provider.fetch(resolved.ref))
    } catch (err) {
      throw new AnvilError(
        ErrorCode.Usage,
        `Cannot read ticket "${key}": ${err instanceof Error ? err.message : String(err)}`,
        {
          // Keep the underlying remediation (the supported provider list, a login command,
          // the file that was missing) instead of replacing it.
          hint:
            err instanceof AnvilError && err.hint !== undefined
              ? err.hint
              : 'Run `anvil issue list` to see what is available.',
        },
      )
    }
  }

  const runner = typeof args.values.runner === 'string' ? args.values.runner : 'opencode'

  const result = await crewUp({
    repoRoot,
    tickets,
    launch: args.values.launch === true,
    runner,
    worktreeRoot: config.git.worktreeRoot,
    // Ranked per ticket, against the worktree it is created in -- not this checkout, which may
    // be a different branch than the claim's base.
    recommend: (ticket, worktreePath) => recommendForWorktree(worktreePath, ticket),
    ...(typeof args.values.prefix === 'string' ? { prefix: args.values.prefix } : {}),
    ...(typeof args.values.base === 'string' ? { base: args.values.base } : {}),
  })

  const data = {
    schemaVersion: 1,
    claims: result.claims.map((c) => ({
      key: c.key,
      branch: c.branch,
      worktree: c.worktreePath,
    })),
    launches: result.launches,
    failures: result.failures,
  }

  ctx.out(data, () => {
    const s = ctx.style
    const out: string[] = []
    out.push(`${s.green('crew up')} ${result.claims.length} claim(s)`)
    for (const c of result.claims) {
      out.push(`  ${c.key.padEnd(14)} ${c.branch}`)
      out.push(`  ${''.padEnd(14)} ${s.dim(c.worktreePath)}`)
    }
    if (result.launches.length > 0) {
      out.push('')
      out.push(s.bold('Agents'))
      for (const l of result.launches) {
        const mark = l.launched ? s.green('started') : s.red('failed')
        out.push(`  ${l.key.padEnd(14)} ${mark} ${s.dim(l.detail)}`)
      }
    }
    if (result.failures.length > 0) {
      out.push('')
      out.push(s.yellow(`Refused (${result.failures.length})`))
      for (const f of result.failures) out.push(`  ${f.key}: ${f.reason}`)
    }
    out.push('')
    out.push(s.dim('Watch with `anvil crew status`; verify with `anvil crew verify`.'))
    return out.join('\n')
  })

  return undefined
}

// ---------------------------------------------------------------------------
// crew verify
// ---------------------------------------------------------------------------

/** Bounded, revision-bound verification facts produced only by an explicit `crew verify --record`. */
const VERIFICATION_EVIDENCE_PREFIX = '.anvil/verification-evidence-'

export interface EvidenceStore {
  /** The worktree root that owns the `.anvil` directory. */
  root: string
  /** A stable key derived from the Git metadata directory, so separate repositories cannot collide. */
  key: string
}

/**
 * Resolve the evidence store from Git metadata without starting a process. The metadata parser and
 * path normalization live in `@anvil/git`, the single source of truth for git paths; this command
 * only derives the store location and key. Unreadable metadata makes evidence unavailable rather
 * than preventing the dashboard from starting.
 */
export function evidenceStore(repoRoot: string): EvidenceStore | null {
  const gitDir = gitDirFromMetadata(repoRoot)
  if (gitDir === null) return null
  return {
    root: dirname(gitDir),
    key: createHash('sha256').update(gitDir).digest('hex').slice(0, 16),
  }
}

export function verificationEvidencePath(store: EvidenceStore): string {
  return join(store.root, `${VERIFICATION_EVIDENCE_PREFIX}${store.key}.json`)
}

function assertWritableDirectory(path: string): void {
  if (!existsSync(path)) return
  const info = lstatSync(path)
  if (info.isSymbolicLink() || !info.isDirectory()) {
    throw new AnvilError(ErrorCode.Usage, 'Refusing to write verification evidence through a link', {
      hint: `Remove or replace the entry at ${path}.`,
    })
  }
}

/**
 * Read the exact opened file, never a path that can be swapped between a stat and a read.
 *
 * `O_NOFOLLOW` rejects a final symlink and `O_NONBLOCK` stops a FIFO swapped in after an advisory
 * check from hanging the read; the `fstat` on the *opened descriptor* is the authoritative check.
 * The buffer is bounded by that stat before any bytes are read.
 */
function readBoundedFile(path: string): string {
  const parent = dirname(path)
  if (existsSync(parent)) {
    const parentInfo = lstatSync(parent)
    if (parentInfo.isSymbolicLink() || !parentInfo.isDirectory()) {
      throw new Error('Verification evidence store is not a regular directory')
    }
  }
  // On Windows O_NOFOLLOW is unavailable; this check is advisory but still rejects a known link.
  const info = lstatSync(path)
  if (info.isSymbolicLink()) throw new Error('Verification evidence is not a regular file')
  const fd = openSync(path, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0) | (fsConstants.O_NONBLOCK ?? 0))
  try {
    const stats = fstatSync(fd)
    if (!stats.isFile() || stats.size > VERIFICATION_EVIDENCE_MAX_BYTES) {
      throw new Error('Verification evidence is not a bounded regular file')
    }
    const size = stats.size
    const buffer = Buffer.allocUnsafe(size + 1)
    if (readSync(fd, buffer, 0, buffer.length, 0) !== size) {
      throw new Error('Verification evidence is not a bounded regular file')
    }
    return buffer.subarray(0, size).toString('utf8')
  } finally {
    closeSync(fd)
  }
}

/** The caller passes the resolved evidence store; this reader never launches Git. */
export function readVerificationEvidence(store: EvidenceStore): unknown[] {
  const path = verificationEvidencePath(store)
  if (!existsSync(path)) return []
  try {
    const parsed: unknown = JSON.parse(readBoundedFile(path))
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

export async function worktreeRevision(worktree: string): Promise<string | null> {
  const head = await runProcess('git', ['rev-parse', 'HEAD'], { cwd: worktree })
  if (head.exitCode !== 0) return null
  const status = await runProcess('git', ['status', '--porcelain'], { cwd: worktree })
  if (status.exitCode !== 0) return null
  return `${head.stdout.trim()}${status.stdout.trim() === '' ? '' : '-dirty'}`
}

/**
 * Sample only the HEAD commit for a read-only consumer such as dashboard startup.
 *
 * `git status` can refresh the index on disk and run configured fsmonitor or filter helpers, so a
 * page load must not call it. The same read-only guards the setup probe uses are applied here; the
 * result is a commit id, never a dirty-state claim.
 */
export async function headRevision(worktree: string): Promise<string | null> {
  const head = await runProcess(
    'git',
    // --no-lazy-fetch keeps a promisor repository from fetching a missing commit; on older Git
    // the unknown option makes the probe fail closed and the revision is reported as unknown.
    ['--no-optional-locks', '--no-lazy-fetch', '-c', 'core.fsmonitor=false', 'rev-parse', '--verify', 'HEAD^{commit}'],
    { cwd: worktree, env: readOnlyGitEnv() },
  )
  return head.exitCode === 0 ? head.stdout.trim() : null
}

export type EvidenceRun = Parameters<typeof crewVerify>[0]['run']

/**
 * The runner used by `crew verify --record`.
 *
 * With `useSnapshot`, each command runs in an isolated clone of the worktree's clean HEAD and
 * the outcome names the logical repository-relative directory, so evidence can still be matched
 * to the plan. Without it, ordinary mutable-checkout sampling is preserved.
 */
export function createEvidenceRunner(options: {
  record: boolean
  useSnapshot: boolean
  snapshots: Map<string, VerificationSnapshot>
  run: EvidenceRun
}): EvidenceRun {
  return async (command, cwd) => {
    if (!options.record) return options.run(command, cwd)
    const startedAt = new Date().toISOString()
    const completedAt = (): string => new Date().toISOString()
    const fail = (detail: string) => ({
      ok: false,
      code: 1,
      stdout: '',
      stderr: detail,
      exitObserved: false,
      revision: null,
      revisionAfter: null,
      startedAt,
      completedAt: completedAt(),
    })

    let executionCwd = cwd
    let revision: string | null
    let sampleFrom = cwd
    let logicalCwd: string | undefined

    if (options.useSnapshot) {
      const root = worktreeRootFor(cwd)
      if (root === null) return fail('Cannot resolve the worktree this check belongs to.')
      const cached = options.snapshots.get(root)
      let snapshot: VerificationSnapshot
      if (cached !== undefined) {
        snapshot = cached
      } else {
        const prepared = await prepareVerificationSnapshot(root)
        if (prepared === null) {
          return fail('Cannot snapshot a clean commit: commit your work before recording verification.')
        }
        options.snapshots.set(root, prepared)
        snapshot = prepared
      }
      logicalCwd = relative(root, cwd).replaceAll('\\', '/')
      executionCwd = logicalCwd === '' ? snapshot.root : join(snapshot.root, logicalCwd)
      revision = snapshot.commit
      sampleFrom = root
    } else {
      // Sample before and after: a check that spanned a tree change cannot bind to either tree.
      revision = await worktreeRevision(cwd)
    }

    const outcome = await options.run(command, executionCwd)
    // When the check ran in a snapshot, a branch that moved while it ran makes the record stale:
    // the sampled HEAD no longer equals the tree that was checked.
    const revisionAfter = options.useSnapshot ? await headRevision(sampleFrom) : await worktreeRevision(sampleFrom)
    return {
      ...outcome,
      ...(logicalCwd === undefined ? {} : { logicalCwd }),
      revision,
      revisionAfter,
      startedAt,
      completedAt: completedAt(),
    }
  }
}

/**
 * Build one version 2 record per worktree whose checks all ran against the same tree.
 *
 * A dirty tree or a revision that moved while the check ran cannot prove a single immutable
 * patch was checked, so no current record is emitted. Commands may live in different
 * directories; each one is bound to its own directory instead of forcing a shared cwd. Legacy
 * rows are still written alongside it for readers that expect the old format.
 */
export function currentRecordFor(
  worktree: CrewVerifyResult['results'][number],
  store: EvidenceStore,
): CurrentEvidenceRecord | null {
  if (worktree.commands.length === 0) return null
  // Worktrees live outside the repository, so the meaningful directory is relative to the
  // worktree root, not to the main checkout that owns the evidence store. A runner that used
  // an isolated snapshot supplies the logical directory explicitly. Commands may live in
  // different directories; each one is bound individually instead of forcing a single cwd.
  const dirs = worktree.commands.map((command) =>
    (command.logicalCwd ?? relative(worktree.worktree, command.cwd)).replaceAll('\\', '/'),
  )
  if (dirs.some((dir) => !validCwd(dir))) return null
  const cwd = dirs[0] ?? ''
  const before = worktree.commands.map((command) => command.revision)
  const after = worktree.commands.map((command) => command.revisionAfter)
  const revision = before[0]
  if (
    revision === null ||
    revision === undefined ||
    !before.every((value) => value === revision) ||
    !after.every((value) => value === revision)
  ) {
    return null
  }
  const clean = !revision.endsWith('-dirty')
  const commands = worktree.commands.map((command, index) => ({
    command: command.command,
    exitCode: command.exitObserved ? command.code : null,
    exitObserved: command.exitObserved,
    dir: dirs[index] ?? '',
  }))
  const startedAt = worktree.commands[0]?.startedAt ?? new Date().toISOString()
  const completedAt = worktree.commands.at(-1)?.completedAt ?? new Date().toISOString()
  return {
    schemaVersion: 2,
    claim: worktree.key,
    repository: store.key,
    commit: clean ? revision.replace(/-dirty$/i, '') : null,
    clean,
    cwd,
    commands,
    planDigest: planDigestForEntries(
      worktree.commands.map((command, index) => ({ cmd: command.command, dir: dirs[index] ?? '' })),
    ),
    startedAt,
    completedAt,
    outcome: worktree.ok ? 'passed' : 'failed',
  }
}

function recordVerificationEvidence(result: CrewVerifyResult, store: EvidenceStore): void {
  const fallbackTimestamp = new Date().toISOString()
  const all: EvidenceRecord[] = []
  for (const worktree of result.results) {
    for (const command of worktree.commands) {
      all.push({
        command: command.command,
        revision: command.revision,
        exitCode: command.exitObserved ? command.code : null,
        timestamp: command.completedAt ?? fallbackTimestamp,
      })
    }
    const current = currentRecordFor(worktree, store)
    if (current !== null && isCurrentEvidenceRecord(current)) all.push(current)
  }
  const anvilDir = join(store.root, '.anvil')
  assertWritableDirectory(anvilDir)
  const path = verificationEvidencePath(store)
  if (existsSync(path) && !lstatSync(path).isFile()) {
    throw new AnvilError(ErrorCode.Usage, 'Refusing to replace non-regular verification evidence', {
      hint: `Remove ${path} before recording again.`,
    })
  }
  const records = selectVerificationRecords(all)
  const payload = `${JSON.stringify(records, null, 2)}\n`
  mkdirSync(anvilDir, { recursive: true })
  const temp = `${path}.${process.pid}.tmp`
  if (existsSync(temp)) {
    throw new AnvilError(ErrorCode.Usage, 'Refusing to reuse an existing verification evidence temp file', {
      hint: `Remove ${temp} before recording again.`,
    })
  }
  writeFileSync(temp, payload, { flag: 'wx' })
  renameSync(temp, path)
}

async function crewVerifyFlow(
  ctx: CommandContext,
  repoRoot: string,
  args: ReturnType<typeof parseCliArgs>,
): Promise<number | undefined> {
  const jobs = typeof args.values.jobs === 'string' ? parsePositiveInt(args.values.jobs) : null
  if (typeof args.values.jobs === 'string' && jobs === null) {
    throw new AnvilError(ErrorCode.Usage, `Invalid --jobs: ${args.values.jobs}`, {
      hint: 'Expected a positive integer.',
    })
  }

  const keys = Array.isArray(args.values.key) ? (args.values.key as string[]) : undefined
  const { config } = loadConfig({ repoRoot })
  // With the owner's policy on, checks run in a throwaway clone of the clean commit instead of
  // the mutable checkout. Without it, ordinary dirty-worktree checks stay cheap and useful.
  const requireSnapshot = config.features.requireCurrentVerification && args.values.record === true
  const snapshots = new Map<string, VerificationSnapshot>()

  // Revision binding is only needed for evidence recording. A plain `crew verify` must not spawn
  // two extra git processes per command: the read-only verification path stays process-free.
  const runWithRevision = createEvidenceRunner({
    record: args.values.record === true,
    useSnapshot: requireSnapshot,
    snapshots,
    run: (command, cwd) => runCommand(command, cwd),
  })

  // The same plan the brief and AGENTS.md describe: owner declarations win, detected commands
  // stay visible as conflicts, and each command carries its own working directory.
  const planFor = (profile: Parameters<typeof verificationPlan>[0]) =>
    verificationPlan(profile, config.project.commands)
  const rootProfile = buildProfile(repoRoot, { root: repoRoot, host: null, remote: null, defaultBranch: null }).profile
  const conflicts = planFor(rootProfile).conflicts

  let result: CrewVerifyResult
  try {
    result = await crewVerify({
      repoRoot,
      ...(keys === undefined ? {} : { keys }),
      jobs,
      forceParallel: args.values['force-parallel'] === true,
      run: runWithRevision,
      verification: (profile) => planFor(profile).commands.map(({ cmd, dir }) => ({ cmd, dir })),
    })
  } finally {
    for (const snapshot of snapshots.values()) snapshot.dispose()
  }
  const data = {
    schemaVersion: 1,
    ok: result.ok,
    concurrency: result.concurrency,
    results: result.results,
    skipped: result.skipped,
    verificationConflicts: conflicts,
  }
  if (args.values.record === true) {
    const store = evidenceStore(repoRoot)
    if (store !== null) recordVerificationEvidence(result, store)
  }

  // A green aggregate must never hide a red member, so the exit code is the verdict and
  // the report is still emitted in full -- on a failure envelope, so a JSON consumer can
  // tell a partial failure from a success without reading stderr.
  if (!result.ok) {
    const failed = result.results.filter((r) => !r.ok)
    const err = new AnvilError(
      ErrorCode.ThresholdNotMet,
      `${failed.length} of ${result.results.length} worktree(s) failed verification`,
      {
        hint: `Failed: ${failed.map((f) => f.key).join(', ')}`,
        details: { results: result.results },
      },
    )
    ctx.outFailure(data, err, () => {
      const out = [
        `\n${ctx.style.red('error')} ${err.message}\n${err.hint === undefined ? '' : `hint  ${err.hint}\n`}\n`,
      ]
      out.push(renderVerify(ctx, result, conflicts))
      return out.join('\n')
    })
    return ExitCode.Threshold
  }

  ctx.out(data, () => renderVerify(ctx, result, conflicts))
  return undefined
}

function renderVerify(
  ctx: CommandContext,
  result: CrewVerifyResult,
  conflicts: readonly { kind: string; declared: string; detected: string }[] = [],
): string {
  const s = ctx.style
  const out: string[] = []
  out.push(
    `${result.ok ? s.green('all worktrees verified') : s.red('verification failed')}  ${s.dim(result.concurrency.reason)}`,
  )
  out.push('')
  out.push(
    renderTable(
      ['key', 'result', 'commands'],
      result.results.map((r) => [
        r.key,
        r.ok ? s.green('pass') : s.red('FAIL'),
        r.commands.map((c) => `${c.command}${c.ok ? '' : ` -> exit ${c.code}`}`).join('; ') || s.dim('(none)'),
      ]),
      s,
    ),
  )
  for (const r of result.results.filter((x) => !x.ok)) {
    for (const c of r.commands.filter((x) => !x.ok)) {
      out.push('')
      out.push(s.red(`  ${r.key}: ${c.command} failed (exit ${c.code})`))
      // Only show a detail line when there is one; some runners fail silently.
      const firstLine = (c.detail ?? '').split('\n').find((l) => l.trim() !== '')
      if (firstLine !== undefined) out.push(`    ${s.dim(firstLine.trim().slice(0, 200))}`)
    }
  }
  if (result.skipped.length > 0) {
    out.push('')
    out.push(s.yellow(`Skipped (${result.skipped.length})`))
    for (const sk of result.skipped) out.push(`  ${sk.key}: ${sk.reason}`)
  }
  for (const conflict of conflicts) {
    out.push(s.yellow(`  ${conflict.kind}: declared ${conflict.declared} overrides detected ${conflict.detected}`))
  }
  return out.join('\n')
}

// ---------------------------------------------------------------------------
// crew status
// ---------------------------------------------------------------------------

async function crewStatusFlow(
  ctx: CommandContext,
  repoRoot: string,
  args: ReturnType<typeof parseCliArgs>,
): Promise<number | undefined> {
  const statuses = await claimStatuses(repoRoot)
  const registry = readClaims(repoRoot)

  const rows = await mapWithConcurrency(statuses, 8, async (st) => {
    const claim = st.claim
    const pid = claimAgentPid(claim)
    const alive = pid !== null ? isProcessAlive(pid) : null
    // The session the agent opened, as the opencode plugin recorded it in the worktree.
    // Absent when the plugin is not installed, which is a fact about the machine rather
    // than an error.
    const session = readAgentSession(claim.worktreePath)
    return { status: st, pid, alive, sessionId: session?.sessionId ?? null }
  })

  // Cost is opt-in and read from the host's usage ledger, so it is only looked up when
  // it is asked for.
  const wantsCost = args.values.cost === true
  const sessionIds = rows.map((r) => r.sessionId).filter((id): id is string => id !== null)
  const cost = wantsCost
    ? await lookupSessionCosts(sessionIds)
    : { available: false, reason: 'cost was not requested', sessions: new Map() }

  const data = {
    schemaVersion: 1,
    active: registry.claims.filter((c) => c.state === 'active').length,
    crew: rows.map((r) => {
      const sessionCost = r.sessionId === null ? undefined : cost.sessions.get(r.sessionId)
      return {
        key: r.status.claim.key,
        branch: r.status.claim.branch,
        worktree: r.status.claim.worktreePath,
        present: r.status.present,
        uncommitted: r.status.uncommitted,
        unpushed: r.status.unpushed,
        lastCommitAgeSeconds: r.status.lastCommitAgeSeconds,
        agentPid: r.pid,
        agentAlive: r.alive,
        agentSessionId: r.sessionId,
        agentRunner: r.status.claim.agent?.runner ?? null,
        agentVersion: r.status.claim.agent?.version ?? null,
        costUsd: sessionCost?.costUsd ?? null,
        costTokens: sessionCost?.tokens ?? null,
        state: r.status.claim.state,
        orphaned: r.status.orphaned,
        pr: r.status.claim.pr ?? null,
      }
    }),
    cost: {
      requested: wantsCost,
      available: cost.available,
      ...(cost.reason === undefined ? {} : { reason: cost.reason }),
    },
  }

  ctx.out(data, () => {
    const s = ctx.style
    const out: string[] = []
    if (rows.length === 0) {
      out.push(s.dim('No claims. Run `anvil crew up` to start one.'))
      return out.join('\n')
    }
    const columns = wantsCost
      ? ['key', 'wt', 'uncom', 'unpush', 'last', 'agent', 'cost', 'state']
      : ['key', 'wt', 'uncom', 'unpush', 'last', 'agent', 'state']
    out.push(
      renderTable(
        columns,
        rows.map((r) => {
          const base = [
            r.status.claim.key,
            r.status.present ? s.green('ok') : s.red('gone'),
            r.status.uncommitted === 0 ? s.dim('0') : s.yellow(String(r.status.uncommitted)),
            r.status.unpushed === null
              ? s.dim('-')
              : r.status.unpushed === 0
                ? s.dim('0')
                : s.yellow(String(r.status.unpushed)),
            age(r.status.lastCommitAgeSeconds),
            r.alive === null ? s.dim('-') : r.alive ? s.green(`pid ${r.pid}`) : s.red('dead'),
          ]
          const withCost = wantsCost
            ? [...base, formatCost(r.sessionId === null ? undefined : cost.sessions.get(r.sessionId))]
            : base
          return [...withCost, r.status.orphaned ? s.red('orphaned') : r.status.claim.state]
        }),
        s,
      ),
    )
    if (wantsCost) {
      const total = [...cost.sessions.values()].reduce((sum, c) => sum + (c.costUsd ?? 0), 0)
      if (cost.available) {
        out.push(s.dim(`  total ${total.toFixed(2)} across ${cost.sessions.size} session(s)`))
      } else {
        // A missing tool is a note, not a failure: the rest of the report is still true.
        out.push(s.yellow(`  no cost data: ${cost.reason ?? 'unknown reason'}`))
        // Only suggest installing ccusage when it was actually asked to price something;
        // a claim with no recorded session needs no tool, it needs an agent that records one.
        if (sessionIds.length > 0) {
          out.push(s.dim('  install ccusage (npm i -g ccusage) to price agent sessions'))
        }
      }
    }
    return out.join('\n')
  })
  return undefined
}

function age(seconds: number | null): string {
  if (seconds === null) return '-'
  if (seconds < 90) return `${seconds}s`
  if (seconds < 5400) return `${Math.round(seconds / 60)}m`
  if (seconds < 172800) return `${Math.round(seconds / 3600)}h`
  return `${Math.round(seconds / 86400)}d`
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

/**
 * Run one of the project's own verify commands.
 *
 * Delegates to `runProcess`, the only place that knows about Windows shims. A naive
 * `execFile(bin, args)` fails with ENOENT on Windows for npm, pnpm, yarn, bun and
 * friends, because they are `.cmd` files and Node does not resolve PATHEXT. The command
 * is tokenized with quote awareness so a filtered invocation keeps its quotes.
 */
async function runCommand(
  command: string,
  cwd: string,
): Promise<{ ok: boolean; code: number; stdout: string; stderr: string; exitObserved: boolean }> {
  const parts = tokenizeCommand(command)
  const [bin, ...args] = parts as [string, ...string[]]
  if (bin === undefined) {
    return { ok: false, code: 1, stdout: '', stderr: 'empty command', exitObserved: false }
  }
  try {
    const result = await runProcess(bin, args, { cwd, timeoutMs: 10 * 60_000 })
    return {
      ok: result.exitCode === 0,
      code: result.exitCode,
      stdout: result.stdout,
      stderr: result.stderr,
      exitObserved: true,
    }
  } catch (err) {
    return {
      ok: false,
      code: 1,
      stdout: '',
      stderr: err instanceof Error ? err.message : String(err),
      exitObserved: false,
    }
  }
}

function splitRefs(value: unknown): string[] {
  if (Array.isArray(value))
    return value
      .flatMap((v) => String(v).split(','))
      .map((v) => v.trim())
      .filter((v) => v !== '')
  if (typeof value === 'string')
    return value
      .split(',')
      .map((v) => v.trim())
      .filter((v) => v !== '')
  return []
}

function parsePositiveInt(value: string | undefined): number | null {
  if (value === undefined || value === '') return null
  const n = Number.parseInt(value, 10)
  if (!Number.isFinite(n) || n < 1) return null
  return n
}

async function mainRootFor(ctx: CommandContext): Promise<string> {
  const cwd = ctx.repoRoot
  if (cwd === null) {
    throw new AnvilError(ErrorCode.NotAGitRepo, 'Not inside a git repository', {
      hint: 'A crew needs a repository to branch from.',
    })
  }
  const { mainWorktreeRoot } = await import('@anvil/git')
  return (await mainWorktreeRoot(cwd)) ?? cwd
}
