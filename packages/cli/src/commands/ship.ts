/**
 * `anvil ship` and the `github` branch of `anvil auth` / `anvil issue`.
 *
 * `ship` is the seam, so the command is deliberately thin: it resolves the claim, builds
 * the dependencies the pipeline needs, and renders. All the sequencing and refusal logic
 * lives in `ship()` itself, where it can be tested without git, gh or a network.
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { AnvilError, ErrorCode, parseCliArgs, renderTable, runProcess, tokenizeCommand } from '@anvil/core'
import { currentBranch, git, mainWorktreeRoot } from '@anvil/git'
import { buildProfile } from '@anvil/profile'
import {
  DEFAULT_TICKETS_DIR,
  GhForgeTransport,
  GitHubProvider,
  hostFromRemote,
  LocalTicketProvider,
} from '@anvil/providers'
import { parseRef, type Ticket } from '@anvil/tickets'
import { readClaims } from '@anvil/worktrees'
import { type ShipResult, ship } from '@anvil/worktrees/ship'
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
    'Order matters and is deliberate: refuse, verify, push, pull request, ticket. The',
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

    const ticket = await loadTicketFor(ctx, repoRoot, claim.ticket)

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

    const provider = new GitHubProvider({ ...(host === null ? {} : { host }) })
    const transport = new GhForgeTransport({
      ...(host === null ? {} : { host }),
    })

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
      updateTicket: args.values['no-ticket-update'] !== true,
      ticketOps: {
        comment: (ref, body) => provider.comment(ref, body),
        transition: (ref, to) => provider.transition(ref, to),
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
      commandsRun: result.commandsRun,
    }

    if (!result.ok) {
      const failed = result.stages.find((s) => !s.ok)
      const err = new AnvilError(ErrorCode.PreflightFailed, failed?.detail ?? 'ship did not complete', {
        ...(hintForStage(failed?.name) === undefined ? {} : { hint: hintForStage(failed?.name) as string }),
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

async function loadTicketFor(
  _ctx: CommandContext,
  repoRoot: string,
  ref: { provider: string; id: string; key: string },
): Promise<Ticket> {
  if (ref.provider === 'github') {
    const host = hostFromRemote((await git(['remote', 'get-url', 'origin'], { cwd: repoRoot })).stdout.trim() ?? null)
    return new GitHubProvider({ ...(host === null ? {} : { host }) }).fetch(parseRef(ref.id, 'github'))
  }
  return new LocalTicketProvider({
    dir: join(repoRoot, DEFAULT_TICKETS_DIR),
  }).fetch(parseRef(ref.id, 'local'))
}
