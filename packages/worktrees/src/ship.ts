/**
 * The ship pipeline: verify → push → PR → ticket.
 *
 * This is the M4 seam where git, the provider, PR templates, CODEOWNERS and verification
 * all meet at once, and the plan budgeted it at 1.5–2x for that reason. Two decisions
 * keep it from becoming the tangle it was predicted to be:
 *
 *  1. **The provider is injected, not imported.** The pipeline talks to an interface, so
 *     the whole sequence is testable with no network and no `gh`. The real `gh` transport
 *     arrives as one implementation of it.
 *  2. **Every stage can stop the ship, and says why.** A pipeline that pushes first and
 *     verifies later leaves a branch on the remote when the work is broken. Order is
 *     therefore: refuse, verify, diff, push, PR, ticket — and the stages that can lose work
 *     run last.
 */

import { join } from 'node:path'
import { AnvilError, ErrorCode } from '@anvil/core'
import { git, revExists, type WorktreeStatus, worktreeStatus } from '@anvil/git'
import {
  analyzeRisk,
  codeownersFor,
  type PrBodyInput,
  type RiskAnalysis,
  renderPrBody,
  renderPrTitle,
  resolveReviewers,
} from '@anvil/pr'
import type { CommandSource, ProjectProfile } from '@anvil/profile'
import type { NormalizedState, Ticket, TicketRef } from '@anvil/tickets'

/** What the pipeline needs from a forge. The `gh` transport implements this. */
export interface ForgeTransport {
  /**
   * Push a branch, creating it upstream if needed. When `commit` is supplied the transport
   * pushes that exact commit to the branch ref, so the ref cannot move under the push.
   */
  pushBranch(options: { cwd: string; branch: string; commit?: string }): Promise<{ ok: boolean; detail: string }>
  /** Open a PR, or update the existing one for the branch. */
  upsertPullRequest(options: {
    cwd: string
    branch: string
    base: string
    title: string
    body: string
    draft: boolean
    reviewers: string[]
  }): Promise<{ number: number; url: string; created: boolean }>
  /** The PR currently open for a branch, if any. */
  findPullRequest(options: {
    cwd: string
    branch: string
  }): Promise<{ number: number; url: string; state: string } | null>
  /** A link GitHub renders back to the source, used for the ticket comment. */
  sourceLink(options: { cwd: string; branch: string }): Promise<string | null>
}

/** Runs a project's own verify command. Injected so tests never execute a build. */
export type CommandRunner = (
  command: string,
  cwd: string,
) => Promise<{ ok: boolean; code: number; stdout: string; stderr: string }>

export interface ShipOptions {
  repoRoot: string
  worktreePath: string
  branch: string
  baseBranch: string
  /** Resolved Git ref, distinct from the forge's short PR target branch. */
  baseRef?: string
  ticket: Ticket
  profile: ProjectProfile
  transport: ForgeTransport
  run: CommandRunner
  /** Read a repo-relative file. */
  read: (rel: string) => string | null
  draft: boolean
  /** Reviewers from the command line, merged with CODEOWNERS. */
  extraReviewers: string[]
  /** Actually run the verify commands. Off by default: builds are slow and expensive. */
  probe: boolean
  /** Skip verify entirely. */
  skipVerify: boolean
  /**
   * Owner policy: refuse before the push unless the CLI found a current, clean,
   * claim-and-commit-bound verification record. The pipeline does not read that store; the
   * caller supplies the verdict so the evidence format stays a CLI concern.
   */
  requireCurrentVerification?: boolean
  /**
   * The CLI's answer to the policy above, including the reason when it is not satisfied and,
   * when it is satisfied, the exact commit the evidence names. That commit is pinned for the
   * diff, the risk analysis and the push; a branch that moved after verification is refused.
   */
  currentVerification?: { ok: boolean; detail: string; commit?: string }
  /**
   * The shared verification plan from the CLI. Each entry carries its own repo-relative
   * directory, so an owner-declared command in a nested directory is run there. When absent,
   * detected commands are used at the profile's project directory.
   */
  verificationPlan?: ReadonlyArray<{ cmd: string; dir: string; source?: string }>
  /** Do not touch the ticket after opening the PR. */
  updateTicket: boolean
  /** Ticket adapter, so `ship` can comment and transition. */
  ticketOps?: {
    comment(ref: TicketRef, body: string): Promise<void>
    transition(ref: TicketRef, to: NormalizedState): Promise<void>
  }
}

export interface ShipStage {
  name: 'refuse' | 'verify' | 'diff' | 'pin' | 'push' | 'pr' | 'ticket'
  ok: boolean
  detail: string
  /** Actionable recovery guidance, when this stage has a specific remedy. */
  hint?: string
}

export interface ShipResult {
  ok: boolean
  stages: ShipStage[]
  risk: RiskAnalysis
  reviewers: string[]
  pr?: { number: number; url: string; created: boolean }
  verification?: PrBodyInput['verification']
  /** The commit evidence was recorded against, when the policy pinned one. */
  verifiedCommit?: string
  /** Commands that were run, for the plan/cost record. */
  commandsRun: string[]
}

/**
 * The commit the owner's policy pins. Absent when the policy is off, incomplete, or not
 * satisfied — in which case `checkRefusals` already refuses the ship.
 */
function pinnedCommit(options: ShipOptions): string | undefined {
  return options.requireCurrentVerification === true && options.currentVerification?.ok === true
    ? options.currentVerification.commit
    : undefined
}

export async function ship(input: ShipOptions): Promise<ShipResult> {
  // Older callers only supply the PR target name. Resolve its remote-tracking ref
  // without creating a local branch; never change the base sent to the forge.
  const baseRef =
    input.baseRef ??
    ((await revExists(input.worktreePath, `refs/remotes/origin/${input.baseBranch}`))
      ? `refs/remotes/origin/${input.baseBranch}`
      : input.baseBranch)
  const options = { ...input, baseRef }
  const stages: ShipStage[] = []
  const commandsRun: string[] = []

  // ---- 1. Refuse before anything irreversible ------------------------------
  const refusal = await checkRefusals(options)
  stages.push({
    name: 'refuse',
    ok: refusal.ok,
    detail: refusal.detail,
    ...(refusal.hint === undefined ? {} : { hint: refusal.hint }),
  })
  if (!refusal.ok) {
    return {
      ok: false,
      stages,
      risk: { touched: [], highPaths: [], mediumPaths: [], level: null },
      reviewers: [],
      commandsRun,
    }
  }

  // ---- 2. Verify -----------------------------------------------------------
  // A project can live in a subdirectory of the repository (a monorepo, a Gradle module,
  // `services/api`). Verify commands are written relative to that directory, so they run
  // from it, not from the worktree root.
  const cwdFor = (dir: string): string => (dir === '' ? options.worktreePath : join(options.worktreePath, dir))
  const verification: PrBodyInput['verification'] = []
  if (options.skipVerify) {
    stages.push({
      name: 'verify',
      ok: true,
      detail: 'skipped (--skip-verify)',
    })
  } else if (options.probe) {
    const entries =
      options.verificationPlan ??
      verifyCommandEntries(options.profile).map((entry) => ({
        cmd: entry.cmd,
        dir: options.profile.projectDir,
        source: entry.source,
      }))
    if (entries.length === 0) {
      stages.push({
        name: 'verify',
        ok: false,
        detail: 'no verify command detected',
      })
      return {
        ok: false,
        stages,
        risk: { touched: [], highPaths: [], mediumPaths: [], level: null },
        reviewers: [],
        commandsRun,
      }
    }
    for (const entry of entries) {
      commandsRun.push(entry.cmd)
      const result = await options.run(entry.cmd, cwdFor(entry.dir))
      verification.push({
        command: entry.cmd,
        ok: result.ok,
        ...(result.ok ? {} : { detail: (result.stderr || result.stdout).slice(0, 400) }),
      })
    }
    const failed = verification.filter((v) => !v.ok)
    const inferred = entries.filter((e) => e.source === 'inferred').map((e) => e.cmd)
    const declared = entries.filter((e) => e.source === 'declared').map((e) => e.cmd)
    const passed = failed.length === 0
    // An inferred command is a guess from ecosystem convention, and a green result from
    // one is much weaker evidence than a green result from a documented command. Saying so
    // is the difference between a check that ran and a check that means something.
    const caveat =
      passed && inferred.length > 0
        ? ` (inferred, not documented: ${inferred.join(', ')})`
        : passed && declared.length > 0
          ? ` (declared by owner, not observed: ${declared.join(', ')})`
          : ''
    stages.push({
      name: 'verify',
      ok: passed,
      detail: passed
        ? `${verification.length} command(s) passed${caveat}`
        : `${failed.length} command(s) failed: ${failed.map((f) => f.command).join(', ')}`,
    })
    // A failed verify stops the ship *before* the push, so nothing broken reaches the
    // remote.
    if (failed.length > 0) {
      return {
        ok: false,
        stages,
        risk: { touched: [], highPaths: [], mediumPaths: [], level: null },
        reviewers: [],
        verification,
        commandsRun,
      }
    }
  } else {
    stages.push({
      name: 'verify',
      ok: true,
      detail: 'not run (pass --probe to run them, or --skip-verify to acknowledge)',
    })
  }

  // ---- 3. What changed, and how risky is it? -------------------------------
  // Recompute after verification: a check command, or an agent working beside it, can
  // create a commit while verify runs. The push sends the post-verification tree, so the
  // risk analysis and CODEOWNERS reviewers must describe that same tree. The earlier
  // check in checkRefusals only proves the diff can be computed at all.
  let changed: string[]
  try {
    const pinned = pinnedCommit(options)
    changed = await changedPaths({
      ...options,
      ...(pinned === undefined ? {} : { verifiedCommit: pinned }),
    })
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err)
    const hint = err instanceof AnvilError ? err.hint : undefined
    stages.push({ name: 'diff', ok: false, detail, ...(hint === undefined ? {} : { hint }) })
    return {
      ok: false,
      stages,
      risk: { touched: [], highPaths: [], mediumPaths: [], level: null },
      reviewers: [],
      verification,
      commandsRun,
    }
  }
  stages.push({ name: 'diff', ok: true, detail: `${changed.length} file(s) changed against ${options.baseRef}` })
  const risk = analyzeRisk(changed, options.profile.risk)

  const codeowners = codeownersFor(options.profile, options.read)
  const reviewers = [
    ...new Set([
      ...resolveReviewers(changed, codeowners ?? ''),
      ...options.extraReviewers.map((r) => r.replace(/^@/, '')),
    ]),
  ].sort()

  // ---- 4. Push -------------------------------------------------------------
  // The transport is the network boundary. A thrown error is a failed push, not a crash:
  // the caller needs the stage record to know that nothing reached the remote.
  const commit = pinnedCommit(options)
  if (commit !== undefined) {
    // Verification and risk analysis take time. Re-sample immediately before the network
    // boundary so a commit created in that window is never pushed under stale evidence.
    const head = await git(['rev-parse', 'HEAD'], { cwd: options.worktreePath })
    if (head.exitCode !== 0 || head.stdout.trim().toLowerCase() !== commit.toLowerCase()) {
      stages.push({
        name: 'pin',
        ok: false,
        detail: `The branch moved from verified commit ${commit.slice(0, 7)} before the push.`,
        hint: 'Nothing was pushed. Re-run `anvil crew verify --record` on the new HEAD before shipping.',
      })
      return {
        ok: false,
        stages,
        risk,
        reviewers,
        ...(verification === undefined ? {} : { verification }),
        commandsRun,
      }
    }
  }
  let pushed: { ok: boolean; detail: string }
  try {
    pushed = await options.transport.pushBranch({
      cwd: options.worktreePath,
      branch: options.branch,
      ...(commit === undefined ? {} : { commit }),
    })
  } catch (err) {
    pushed = { ok: false, detail: err instanceof Error ? err.message : String(err) }
  }
  stages.push({ name: 'push', ok: pushed.ok, detail: pushed.detail })
  if (!pushed.ok) {
    return { ok: false, stages, risk, reviewers, commandsRun }
  }

  // ---- 5. Pull request -----------------------------------------------------
  // Reading whether a PR already exists is another provider call. If it fails, the push
  // already succeeded, and the result must say so rather than losing that fact in a throw.
  let existing: { number: number; url: string; state: string } | null
  try {
    existing = await options.transport.findPullRequest({
      cwd: options.worktreePath,
      branch: options.branch,
    })
  } catch (err) {
    stages.push({
      name: 'pr',
      ok: false,
      detail: `push succeeded, but could not read the existing PR: ${err instanceof Error ? err.message : String(err)}`,
    })
    return {
      ok: false,
      stages,
      risk,
      reviewers,
      ...(verification === undefined ? {} : { verification }),
      commandsRun,
    }
  }
  const body = renderPrBody({
    ticket: options.ticket,
    risk,
    reviewers,
    verifyCommands: (options.verificationPlan?.map((entry) => entry.cmd) ?? verifyCommands(options.profile)).map(
      (c) => c,
    ),
    ...(verification === undefined ? {} : { verification }),
    ...(commit === undefined ? {} : { verificationCommit: commit }),
    isUpdate: existing !== null,
  })

  let pr: ShipResult['pr']
  try {
    pr = await options.transport.upsertPullRequest({
      cwd: options.worktreePath,
      branch: options.branch,
      base: options.baseBranch,
      title: renderPrTitle(options.ticket),
      body,
      draft: options.draft,
      reviewers,
    })
  } catch (err) {
    stages.push({
      name: 'pr',
      ok: false,
      detail: err instanceof Error ? err.message : String(err),
    })
    return { ok: false, stages, risk, reviewers, commandsRun }
  }
  stages.push({
    name: 'pr',
    ok: true,
    detail: pr.created ? `opened #${pr.number}` : `updated #${pr.number}`,
  })

  // ---- 6. Back to the ticket ----------------------------------------------
  if (options.updateTicket && options.ticketOps !== undefined) {
    try {
      await options.ticketOps.comment(options.ticket.ref, prComment(pr, risk))
      await options.ticketOps.transition(options.ticket.ref, 'in_review')
      stages.push({
        name: 'ticket',
        ok: true,
        detail: `commented and moved to in_review`,
      })
    } catch (err) {
      // The PR exists. A failed ticket update is worth reporting, not worth discarding
      // the PR over -- and it must be visible, or the two systems silently diverge.
      stages.push({
        name: 'ticket',
        ok: false,
        detail: `PR opened but the ticket was not updated: ${err instanceof Error ? err.message : String(err)}`,
      })
    }
  } else {
    stages.push({
      name: 'ticket',
      ok: true,
      detail: options.updateTicket ? 'no ticket adapter available' : 'skipped (--no-ticket-update)',
    })
  }

  return {
    ok: true,
    stages,
    risk,
    reviewers,
    ...(pr === undefined ? {} : { pr }),
    ...(verification === undefined ? {} : { verification }),
    ...(commit === undefined ? {} : { verifiedCommit: commit }),
    commandsRun,
  }
}

/** The verify commands anvil will run, highest-confidence first. */
export function verifyCommands(profile: ProjectProfile): string[] {
  return verifyCommandEntries(profile).map((e) => e.cmd)
}

/**
 * The verify commands, with the provenance of each.
 *
 * `inferred` means anvil guessed the command from ecosystem convention and nobody has run
 * it. It is a reasonable guess and a poor guarantee, so a ship that runs one says so
 * rather than presenting it beside a `documented` command as though they were equal. Open
 * question 3 in the plan settled on "do not block, but log it loudly"; this is the loud
 * part, which was previously missing.
 */
export function verifyCommandEntries(profile: ProjectProfile): Array<{ cmd: string; source: CommandSource }> {
  const order: Array<keyof ProjectProfile['commands']> = ['testFast', 'test', 'typecheck', 'lint', 'build']
  const out: Array<{ cmd: string; source: CommandSource }> = []
  const seen = new Set<string>()
  for (const kind of order) {
    const entry = profile.commands[kind]?.[0]
    if (entry === undefined) continue
    if (seen.has(entry.cmd)) continue
    seen.add(entry.cmd)
    out.push({ cmd: entry.cmd, source: entry.source })
  }
  return out
}

/** The verify commands anvil inferred rather than found written down. */
export function inferredVerifyCommands(profile: ProjectProfile): string[] {
  return verifyCommandEntries(profile)
    .filter((e) => e.source === 'inferred')
    .map((e) => e.cmd)
}

interface Refusal {
  ok: boolean
  detail: string
  /** Actionable recovery guidance, when this refusal has a specific remedy. */
  hint?: string
}

/**
 * Everything that should stop a ship *before* the push.
 *
 * A refused ship is the good outcome: nothing reached the remote, and the user has one
 * specific thing to fix rather than a half-finished PR.
 */
async function checkRefusals(options: ShipOptions): Promise<Refusal> {
  // The policy is checked before anything else, and before the push. A `--skip-verify` flag or
  // an inferred command cannot waive an owner-declared requirement: only current evidence can.
  if (options.requireCurrentVerification === true) {
    const evidence = options.currentVerification
    if (evidence?.ok !== true) {
      return {
        ok: false,
        detail: evidence?.detail ?? 'No current verification evidence was supplied.',
        hint: 'Run `anvil crew verify --record` in a clean worktree for this claim, then ship the checked commit.',
      }
    }
    const commit = evidence.commit
    if (commit === undefined || !/^[0-9a-f]{7,64}$/i.test(commit)) {
      return {
        ok: false,
        detail: 'The current verification record does not name a commit to ship.',
        hint: 'Run `anvil crew verify --record` again, then ship the checked commit.',
      }
    }
    const head = await git(['rev-parse', 'HEAD'], { cwd: options.worktreePath })
    if (head.exitCode !== 0 || head.stdout.trim().toLowerCase() !== commit.toLowerCase()) {
      return {
        ok: false,
        detail: `The worktree HEAD no longer matches the verified commit ${commit.slice(0, 7)}.`,
        hint: 'Ship the verified commit; do not add commits between `crew verify --record` and `ship`.',
      }
    }
  }

  if (options.profile.commands.test === undefined && !options.skipVerify && !options.probe) {
    // Not a refusal, but worth knowing: the branch will open with no verification.
  }

  const status: WorktreeStatus = await worktreeStatus(options.worktreePath)
  if (status.changes.length > 0) {
    return {
      ok: false,
      detail: `The worktree has ${status.changes.length} uncommitted change(s). Ship ships commits, not a working tree.`,
    }
  }

  const head = await git(['rev-list', '--count', `${options.baseRef ?? options.baseBranch}..HEAD`], {
    cwd: options.worktreePath,
  })
  if (head.exitCode !== 0) {
    // A base ref that cannot be resolved makes the diff, the risk analysis and the PR
    // target all unreliable. Refusing here is the only answer that does not guess.
    return {
      ok: false,
      detail: `Cannot resolve base branch ${options.baseBranch} in ${options.worktreePath}: ${head.stderr.trim() || head.stdout.trim() || `exit ${head.exitCode}`}`,
    }
  }
  if (head.stdout.trim() === '0') {
    return {
      ok: false,
      detail: `No commits on ${options.branch} beyond ${options.baseBranch}.`,
    }
  }

  // Validate the changed-file diff before running verification, so an impossible diff
  // does not cost a full test run. The result is discarded: step 3 recomputes it after
  // verification, and the recomputation is what risk analysis and reviewers consume.
  try {
    await changedPaths(options)
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err)
    const hint = err instanceof AnvilError ? err.hint : undefined
    return {
      ok: false,
      detail,
      ...(hint === undefined ? {} : { hint }),
    }
  }

  return { ok: true, detail: 'nothing to refuse' }
}

/**
 * Repo-relative paths changed on this branch.
 *
 * Throws when Git cannot compute the diff. In particular, an unrelated base and branch
 * have no merge base, which is common after a shallow fetch advances the base ref.
 * Treating that failure as an empty diff would bypass risk analysis and reviewers.
 */
export async function changedPaths(options: {
  worktreePath: string
  baseBranch: string
  baseRef?: string
  /** Diff against this commit instead of HEAD, so risk and reviewers describe evidence. */
  verifiedCommit?: string
}): Promise<string[]> {
  const baseRef = options.baseRef ?? options.baseBranch
  const endpoint = options.verifiedCommit ?? 'HEAD'
  const res = await git(['diff', '--name-only', `${baseRef}...${endpoint}`], {
    cwd: options.worktreePath,
  })
  if (res.exitCode !== 0) {
    const detail = res.stderr.trim() || res.stdout.trim() || `exit ${res.exitCode}`
    throw new AnvilError(ErrorCode.PreflightFailed, `Cannot compute changed files against ${baseRef}: ${detail}`, {
      hint: 'Use a base that shares history with the branch; if the clone is shallow, fetch the missing history (for example, `git fetch --unshallow` or `git fetch --deepen=...`).',
      details: { baseRef, baseBranch: options.baseBranch, exitCode: res.exitCode },
    })
  }
  return res.stdout
    .split('\n')
    .map((p) => p.trim())
    .filter((p) => p !== '')
}

/** The comment posted back to the ticket, naming the risk when there is any. */
export function prComment(pr: { number: number; url: string }, risk: RiskAnalysis): string {
  const lines = [`Opened a pull request for this ticket: **#${pr.number}** — ${pr.url}`]
  if (risk.level === 'high') {
    lines.push('')
    lines.push(
      `⚠️ This change touches ${risk.highPaths.length} high-risk path(s): ${risk.highPaths
        .slice(0, 5)
        .map((p) => `\`${p}\``)
        .join(', ')}`,
    )
    lines.push('It needs a closer look than usual.')
  } else if (risk.level === 'medium') {
    lines.push('')
    lines.push('This change touches paths the project marks as needing care.')
  }
  return lines.join('\n')
}
