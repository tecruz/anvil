/**
 * `anvil ship` and the `github` branch of `anvil auth` / `anvil issue`.
 *
 * `ship` is the seam, so the command is deliberately thin: it resolves the claim, builds
 * the dependencies the pipeline needs, and renders. All the sequencing and refusal logic
 * lives in `ship()` itself, where it can be tested without git, gh or a network.
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { AnvilError, ErrorCode, loadConfig, parseCliArgs, renderTable, runProcess, tokenizeCommand } from '@anvil/core'
import { currentBranch, git, mainWorktreeRoot } from '@anvil/git'
import { buildProfile, verificationPlan } from '@anvil/profile'
import { GhForgeTransport, GitHubProvider, hostFromRemote, requireCapability } from '@anvil/providers'
import { parseRef, type Ticket } from '@anvil/tickets'
import { readClaims } from '@anvil/worktrees'
import { type ShipResult, ship } from '@anvil/worktrees/ship'
import { ticketProviderFor } from '../tickets.ts'
import {
  evidenceMatchesPlan,
  evidencePlanMatches,
  isCurrentEvidenceRecord,
  verdictFor,
} from '../verification-evidence.ts'
import { evidenceStore, headRevision, readVerificationEvidence } from './crew.ts'
import type { Command, CommandContext } from './types.ts'

const GLOBAL_ONLY = {
  json: { type: 'boolean', short: 'j' },
  help: { type: 'boolean', short: 'h' },
} as const

/**
 * Run a verify command in the worktree.
 *
 * Delegates to `runProcess`, the only place that knows about Windows shims. The command
 * is tokenized with quote awareness first: verify commands are stored as one string
 * (`./gradlew test --tests "*Changed*"`), and a whitespace split would pass the quotes
 * through as part of the argument, quietly turning a filtered run into an empty one.
 */
async function runCommand(
  command: string,
  cwd: string,
): Promise<{ ok: boolean; code: number; stdout: string; stderr: string }> {
  const parts = tokenizeCommand(command)
  const [bin, ...args] = parts as [string, ...string[]]
  if (bin === undefined) return { ok: false, code: 1, stdout: '', stderr: 'empty command' }
  try {
    const result = await runProcess(bin, args, { cwd, timeoutMs: 10 * 60_000 })
    return {
      ok: result.exitCode === 0,
      code: result.exitCode,
      stdout: result.stdout,
      stderr: result.stderr,
    }
  } catch (err) {
    return {
      ok: false,
      code: 1,
      stdout: '',
      stderr: err instanceof Error ? err.message : String(err),
    }
  }
}

// ---------------------------------------------------------------------------
// anvil ship
// ---------------------------------------------------------------------------

export const shipCommand: Command = {
  name: 'ship',
  summary: 'Verify, push, open a pull request, and update the ticket.',
  usage: 'anvil ship <key> [--draft] [--probe] [--skip-verify] [--reviewers a,b]',
  details: [
    'Order matters and is deliberate: refuse, verify, diff, push, pull request, ticket. The',
    'stages that could lose work or leave debris on the remote run last, so a failed',
    'verification means nothing reached the remote at all.',
    '',
    'Refuses before pushing when the worktree has uncommitted changes (ship ships',
    'commits, not a working tree) or when the branch has no commits beyond its base.',
    '',
    "--probe          actually run the project's verify commands (slow; off by default)",
    '--skip-verify    acknowledge them and proceed',
    '--draft          open the pull request as a draft',
    '--reviewers a,b  add reviewers on top of those resolved from CODEOWNERS',
    '--no-ticket-update  do not comment on or transition the ticket',
  ].join('\n'),
  flags: {
    ...GLOBAL_ONLY,
    draft: { type: 'boolean' },
    probe: { type: 'boolean' },
    'skip-verify': { type: 'boolean' },
    reviewers: { type: 'string' },
    'no-ticket-update': { type: 'boolean' },
  },

  async run(ctx, rawArgs) {
    const args = parseCliArgs(rawArgs, shipCommand.flags)
    const key = args.positionals[0]
    if (key === undefined) {
      throw new AnvilError(ErrorCode.Usage, 'ship needs a claim key', {
        hint: 'Run `anvil status` to list claims.',
      })
    }
    if (ctx.repoRoot === null) {
      throw new AnvilError(ErrorCode.NotAGitRepo, 'Not inside a git repository')
    }
    const repoRoot = await mainRootFor(ctx)

    const claim = readClaims(repoRoot).claims.find((c) => c.key === key)
    if (claim === undefined) {
      throw new AnvilError(ErrorCode.Usage, `No claim for "${key}"`, {
        hint: 'Run `anvil status` to list claims.',
      })
    }

    const branch = await currentBranch(claim.worktreePath)
    if (branch === null) {
      throw new AnvilError(ErrorCode.PreflightFailed, `The worktree for ${key} has no checked-out branch`, {
        hint: `Inspect ${claim.worktreePath}, or release the claim and start a new one.`,
      })
    }

    const profile = buildProfile(claim.worktreePath, {
      root: claim.worktreePath,
      host: null,
      remote: null,
      defaultBranch: null,
    }).profile

    const ticket = await loadTicketFor(repoRoot, claim.ticket)

    // GitHub is the only forge in M4, so the transport is chosen by whether the repo's
    // remote is GitHub at all. Anything else is a clear error rather than a guess.
    const remote = await git(['remote', 'get-url', 'origin'], {
      cwd: repoRoot,
    })
    const remoteUrl = remote.exitCode === 0 ? remote.stdout.trim() : null
    const host = hostFromRemote(remoteUrl)
    const gh = new GitHubProvider({ ...(host === null ? {} : { host }) })
    const auth = await gh.authStatus()
    if (!auth.ok) {
      throw new AnvilError(ErrorCode.AuthFailed, `Cannot ship: ${auth.detail ?? 'gh is not authenticated'}`, {
        ...(auth.remediation === undefined ? {} : { hint: auth.remediation }),
      })
    }

    const transport = new GhForgeTransport({
      ...(host === null ? {} : { host }),
    })

    // The ticket update goes to the provider the claim came from, not always to GitHub: a
    // local ticket is a real ticket, and `ship` is what advances it.
    const ticketProvider = await ticketProviderFor(repoRoot, {
      ref: claim.ticket.key,
      provider: claim.ticket.provider,
    })
    requireCapability(ticketProvider.provider, 'comment', 'comment on a ticket')
    requireCapability(ticketProvider.provider, 'transition', 'move a ticket between states')

    // The opt-in policy is resolved here, where the CLI owns the evidence format. The pipeline
    // receives only a verdict: it cannot waive the policy with --skip-verify or guess a record.
    const { config } = loadConfig({ repoRoot })
    const plan = verificationPlan(profile, config.project.commands)
    const requireCurrentVerification = config.features.requireCurrentVerification
    const currentVerification = requireCurrentVerification
      ? await currentVerificationFor(repoRoot, key, claim.worktreePath, plan)
      : undefined

    const result: ShipResult = await ship({
      repoRoot,
      worktreePath: claim.worktreePath,
      branch,
      baseBranch: claim.baseBranch,
      baseRef: claim.baseRef,
      ticket,
      profile,
      transport,
      run: runCommand,
      read: (rel) => readTextFile(join(claim.worktreePath, rel)),
      draft: args.values.draft === true,
      extraReviewers: splitList(args.values.reviewers),
      probe: args.values.probe === true,
      skipVerify: args.values['skip-verify'] === true,
      ...(requireCurrentVerification ? { requireCurrentVerification } : {}),
      ...(currentVerification === undefined ? {} : { currentVerification }),
      verificationPlan: plan.commands,
      updateTicket: args.values['no-ticket-update'] !== true,
      ticketOps: {
        comment: (ref, body) => ticketProvider.provider.comment(ref, body),
        transition: (ref, to) => ticketProvider.provider.transition(ref, to),
      },
    })

    const data = {
      schemaVersion: 1,
      key,
      branch,
      ok: result.ok,
      stages: result.stages,
      risk: result.risk,
      reviewers: result.reviewers,
      pr: result.pr ?? null,
      verification: result.verification ?? null,
      verifiedCommit: result.verifiedCommit ?? null,
      commandsRun: result.commandsRun,
    }

    if (!result.ok) {
      const failed = result.stages.find((s) => !s.ok)
      const hint = failed?.hint ?? hintForStage(failed?.name)
      const err = new AnvilError(ErrorCode.PreflightFailed, failed?.detail ?? 'ship did not complete', {
        ...(hint === undefined ? {} : { hint }),
        details: { stages: result.stages },
      })
      // The stage report is the answer even when a stage failed (the plan says a failed
      // verify means nothing was pushed), so it rides on the failure envelope. Emitting it
      // as a success envelope with the error nested in `data` would tell a JSON consumer
      // the ship worked.
      ctx.outFailure(
        data,
        err,
        () => `\n${ctx.style.red('error')} ${err.message}\n${err.hint === undefined ? '' : `hint  ${err.hint}\n`}`,
      )
      return err.exitCode
    }

    ctx.out(data, () => {
      const s = ctx.style
      const out: string[] = []
      out.push(`${s.green('shipped')} ${key}`)
      out.push('')
      out.push(
        renderTable(
          ['stage', 'result', 'detail'],
          result.stages.map((st) => [st.name, st.ok ? s.green('ok') : s.red('FAIL'), st.detail]),
          s,
        ),
      )
      if (result.pr !== undefined) {
        out.push('')
        out.push(`  pull request  ${result.pr.url} ${s.dim(result.pr.created ? '(new)' : '(updated)')}`)
      }
      if (result.verifiedCommit !== undefined) {
        out.push(`  verified      ${result.verifiedCommit.slice(0, 7)} ${s.dim('(evidence-bound commit)')}`)
      }
      if (result.risk.level !== null) {
        out.push(
          `  risk          ${result.risk.level === 'high' ? s.red('HIGH') : s.yellow('medium')} ${s.dim(`${result.risk.highPaths.length} high, ${result.risk.mediumPaths.length} medium`)}`,
        )
      }
      if (result.reviewers.length > 0) out.push(`  reviewers     ${result.reviewers.map((r) => `@${r}`).join(', ')}`)
      return out.join('\n')
    })
    return undefined
  },
}

function hintForStage(stage: string | undefined): string | undefined {
  switch (stage) {
    case 'refuse':
      return 'Commit your work in the worktree, or re-claim the ticket.'
    case 'verify':
      return 'Fix the failing command, or re-run with --skip-verify if it is not a real signal.'
    case 'diff':
      return 'Fetch the missing history, or choose a base that shares history with the branch.'
    case 'pin':
      return 'Re-run `anvil crew verify --record` on the current HEAD, then ship that commit.'
    case 'push':
      return 'Check the remote and your credentials: git push -u origin <branch>.'
    case 'pr':
      return 'Check `gh pr list` for an existing PR on this branch, and that the base branch is correct.'
    case 'ticket':
      return 'The PR exists; update the ticket by hand or re-run `anvil issue sync`.'
    default:
      return undefined
  }
}

function splitList(value: unknown): string[] {
  if (typeof value !== 'string' || value === '') return []
  return value
    .split(',')
    .map((v) => v.trim().replace(/^@/, ''))
    .filter((v) => v !== '')
}

function readTextFile(path: string): string | null {
  try {
    return readFileSync(path, 'utf8')
  } catch {
    return null
  }
}

async function mainRootFor(ctx: CommandContext): Promise<string> {
  const cwd = ctx.repoRoot
  if (cwd === null) {
    throw new AnvilError(ErrorCode.NotAGitRepo, 'Not inside a git repository', {
      hint: 'Claims and tickets live in a repository.',
    })
  }
  return (await mainWorktreeRoot(cwd)) ?? cwd
}

/**
 * Resolve the owner's evidence policy against this claim, this commit and the current check
 * plan. A record written for a different claim, repository, plan or commit cannot satisfy it.
 * An absent or unreadable store is a refusal, never a pass by silence.
 */
async function currentVerificationFor(
  repoRoot: string,
  claimKey: string,
  worktreePath: string,
  plan: ReturnType<typeof verificationPlan>,
): Promise<{ ok: boolean; detail: string; commit?: string }> {
  const store = evidenceStore(repoRoot)
  if (store === null) return { ok: false, detail: 'Cannot resolve the verification evidence store.' }
  const commit = await headRevision(worktreePath)
  if (commit === null) return { ok: false, detail: 'Cannot sample the worktree commit before shipping.' }
  const entries = plan.commands.map((entry) => ({ cmd: entry.cmd, dir: entry.dir }))
  const relevant = readVerificationEvidence(store)
    .filter(isCurrentEvidenceRecord)
    .filter((record) => record.claim === claimKey && record.repository === store.key)
  if (relevant.length === 0) {
    return { ok: false, detail: `No version 2 verification record for claim ${claimKey}.` }
  }
  const matching = relevant.find((record) => evidenceMatchesPlan(record, entries, commit))
  if (matching !== undefined) {
    // Surface the commit the evidence names. The pipeline pins this exact commit for the
    // diff, the risk analysis and the push, so a branch that moves after verification cannot
    // ship an unchecked tree.
    return {
      ok: true,
      detail: `current verification for ${claimKey} at ${commit.slice(0, 7)}`,
      ...(matching.commit === null ? {} : { commit: matching.commit }),
    }
  }
  const planMatch = relevant.some((record) => evidencePlanMatches(record, entries))
  const verdicts = [...new Set(relevant.map((record) => verdictFor(record, commit)))].join(', ')
  return {
    ok: false,
    detail: planMatch
      ? `Verification for ${claimKey} is ${verdicts}, not current.`
      : `Verification for ${claimKey} was recorded for a different check plan (${verdicts}).`,
  }
}

async function loadTicketFor(
  repoRoot: string,
  ref: { provider: string; id: string; key: string; url?: string },
): Promise<Ticket> {
  // The claim records the provider, the id and the URL, so the lookup is the same
  // resolution rule as every other command, with the claim's provider as the explicit
  // selection. The id and URL come from the claim rather than being re-derived from the
  // key: re-parsing a URL turned `https://github.com/acme/issues/issues/42` into the id
  // `issues`, and re-parsing a key loses the repository the claim was made against. A
  // local ticket is read from `ANVIL_TICKETS_DIR`, not from a hardcoded default.
  const parsed = parseRef(ref.key, ref.provider)
  const resolved = await ticketProviderFor(repoRoot, { ref: ref.key, provider: ref.provider })
  if (resolved.ref === undefined) {
    throw new AnvilError(ErrorCode.Internal, `The claim for ${ref.key} has no ticket reference`, {
      hint: 'This is a bug in anvil: a claim always records the ticket it was made from.',
    })
  }
  // The claim is the authority on which issue it names. Keep its id, and keep a hosted
  // ticket's URL so the provider reads and comments on the right repository.
  const ticketRef = {
    ...parsed,
    ...resolved.ref,
    id: ref.id === '' ? parsed.id : ref.id,
    key: ref.key,
    ...(ref.url === undefined ? {} : { url: ref.url }),
  }
  return resolved.provider.fetch(ticketRef)
}
