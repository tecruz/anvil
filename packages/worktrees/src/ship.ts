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
 *     therefore: refuse, verify, push, PR, ticket — and the stages that can lose work run
 *     last.
 */

import { git, type WorktreeStatus, worktreeStatus } from '@anvil/git'
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
  /** Push a branch, creating it upstream if needed. */
  pushBranch(options: { cwd: string; branch: string }): Promise<{ ok: boolean; detail: string }>
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
  /** Do not touch the ticket after opening the PR. */
  updateTicket: boolean
  /** Ticket adapter, so `ship` can comment and transition. */
  ticketOps?: {
    comment(ref: TicketRef, body: string): Promise<void>
    transition(ref: TicketRef, to: NormalizedState): Promise<void>
  }
}

export interface ShipStage {
  name: 'refuse' | 'verify' | 'push' | 'pr' | 'ticket'
  ok: boolean
  detail: string
}

export interface ShipResult {
  ok: boolean
  stages: ShipStage[]
  risk: RiskAnalysis
  reviewers: string[]
  pr?: { number: number; url: string; created: boolean }
  verification?: PrBodyInput['verification']
  /** Commands that were run, for the plan/cost record. */
  commandsRun: string[]
}

export async function ship(options: ShipOptions): Promise<ShipResult> {
  const stages: ShipStage[] = []
  const commandsRun: string[] = []

  // ---- 1. Refuse before anything irreversible ------------------------------
  const refusal = await checkRefusals(options)
  stages.push({ name: 'refuse', ok: refusal.ok, detail: refusal.detail })
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
  const verification: PrBodyInput['verification'] = []
  if (options.skipVerify) {
    stages.push({
      name: 'verify',
      ok: true,
      detail: 'skipped (--skip-verify)',
    })
  } else if (options.probe) {
    const entries = verifyCommandEntries(options.profile)
    for (const entry of entries) {
      commandsRun.push(entry.cmd)
      const result = await options.run(entry.cmd, options.worktreePath)
      verification.push({
        command: entry.cmd,
        ok: result.ok,
        ...(result.ok ? {} : { detail: (result.stderr || result.stdout).slice(0, 400) }),
      })
    }
    const failed = verification.filter((v) => !v.ok)
    const inferred = entries.filter((e) => e.source === 'inferred').map((e) => e.cmd)
    const passed = failed.length === 0
    // An inferred command is a guess from ecosystem convention, and a green result from
    // one is much weaker evidence than a green result from a documented command. Saying so
    // is the difference between a check that ran and a check that means something.
    const caveat = passed && inferred.length > 0 ? ` (inferred, not documented: ${inferred.join(', ')})` : ''
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
  const changed = await changedPaths(options)
  const risk = analyzeRisk(changed, options.profile.risk)

  const codeowners = codeownersFor(options.profile, options.read)
  const reviewers = [
    ...new Set([
      ...resolveReviewers(changed, codeowners ?? ''),
      ...options.extraReviewers.map((r) => r.replace(/^@/, '')),
    ]),
  ].sort()

  // ---- 4. Push -------------------------------------------------------------
  const pushed = await options.transport.pushBranch({
    cwd: options.worktreePath,
    branch: options.branch,
  })
  stages.push({ name: 'push', ok: pushed.ok, detail: pushed.detail })
  if (!pushed.ok) {
    return { ok: false, stages, risk, reviewers, commandsRun }
  }

  // ---- 5. Pull request -----------------------------------------------------
  const existing = await options.transport.findPullRequest({
    cwd: options.worktreePath,
    branch: options.branch,
  })
  const body = renderPrBody({
    ticket: options.ticket,
    risk,
    reviewers,
    verifyCommands: verifyCommands(options.profile).map((c) => c),
    ...(verification === undefined ? {} : { verification }),
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
}

/**
 * Everything that should stop a ship *before* the push.
 *
 * A refused ship is the good outcome: nothing reached the remote, and the user has one
 * specific thing to fix rather than a half-finished PR.
 */
async function checkRefusals(options: ShipOptions): Promise<Refusal> {
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

  const head = await git(['rev-list', '--count', `${options.baseBranch}..HEAD`], { cwd: options.worktreePath })
  if (head.exitCode === 0 && head.stdout.trim() === '0') {
    return {
      ok: false,
      detail: `No commits on ${options.branch} beyond ${options.baseBranch}.`,
    }
  }

  return { ok: true, detail: 'nothing to refuse' }
}

/** Repo-relative paths changed on this branch. */
export async function changedPaths(options: { worktreePath: string; baseBranch: string }): Promise<string[]> {
  const res = await git(['diff', '--name-only', `${options.baseBranch}...HEAD`], { cwd: options.worktreePath })
  if (res.exitCode !== 0) return []
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
