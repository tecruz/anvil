/**
 * `anvil crew` -- run several tickets in parallel.
 *
 * `crew up` claims N tickets and optionally starts an agent in each worktree; `crew verify`
 * runs every worktree's verification under a concurrency policy the tool will explain.
 */

import { join } from 'node:path'
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
import { DEFAULT_TICKETS_DIR, LocalTicketProvider } from '@anvil/providers'
import { parseRef, type Ticket } from '@anvil/tickets'
import { claimAgentPid, claimStatuses, readAgentSession, readClaims } from '@anvil/worktrees'
import { type CrewVerifyResult, crewUp, crewVerify, isProcessAlive, mapWithConcurrency } from '@anvil/worktrees/crew'
import { formatCost, lookupSessionCosts } from '../cost.ts'
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
    '--jobs <n>        concurrent verify runs (overrides the cache policy only with --force-parallel)',
    '--force-parallel  ignore the cache policy and use --jobs literally',
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
    prefix: { type: 'string' },
    base: { type: 'string' },
    jobs: { type: 'string' },
    'force-parallel': { type: 'boolean' },
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
    const provider = new LocalTicketProvider({
      dir: join(repoRoot, process.env.ANVIL_TICKETS_DIR ?? DEFAULT_TICKETS_DIR),
    })

    if (sub === 'up') return crewUpFlow(ctx, repoRoot, provider, args)
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
  provider: LocalTicketProvider,
  args: ReturnType<typeof parseCliArgs>,
): Promise<number | undefined> {
  const refs = splitRefs(args.values.tickets)
  if (refs.length === 0) {
    // No explicit list: take the ready work. A crew is most useful when you do not have to
    // enumerate the tickets yourself.
    const all = await provider.list({ state: 'todo' })
    const limit = (typeof args.values.limit === 'string' ? parsePositiveInt(args.values.limit) : null) ?? all.length
    if (all.length === 0) {
      throw new AnvilError(ErrorCode.Usage, 'No tickets in state `todo`', {
        hint: 'Name them explicitly with --tickets 1,2,3, or create one with `anvil issue create`.',
      })
    }
    refs.push(...all.slice(0, limit).map((r) => r.id))
  }

  const tickets: Ticket[] = []
  for (const ref of refs) {
    try {
      tickets.push(await provider.fetch(parseRef(ref, 'local')))
    } catch (err) {
      throw new AnvilError(
        ErrorCode.Usage,
        `Cannot read ticket "${ref}": ${err instanceof Error ? err.message : String(err)}`,
        {
          hint: 'Run `anvil issue list` to see what is available.',
        },
      )
    }
  }

  const { config } = loadConfig({ repoRoot })
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

  const result: CrewVerifyResult = await crewVerify({
    repoRoot,
    ...(keys === undefined ? {} : { keys }),
    jobs,
    forceParallel: args.values['force-parallel'] === true,
    run: runCommand,
  })

  const data = {
    schemaVersion: 1,
    ok: result.ok,
    concurrency: result.concurrency,
    results: result.results,
    skipped: result.skipped,
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
      out.push(renderVerify(ctx, result))
      return out.join('\n')
    })
    return ExitCode.Threshold
  }

  ctx.out(data, () => renderVerify(ctx, result))
  return undefined
}

function renderVerify(ctx: CommandContext, result: CrewVerifyResult): string {
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
