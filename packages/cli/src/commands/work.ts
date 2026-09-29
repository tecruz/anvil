/**
 * `anvil claim`, `anvil release`, `anvil status`, `anvil issue`, `anvil auth`.
 *
 * The first half of the per-ticket loop. `claim` turns a ticket reference into a warm
 * worktree an agent can work in immediately; `status` shows what is in flight and what
 * would be lost if it were released now.
 */

import { existsSync, mkdirSync, writeFileSync, readFileSync, appendFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { AnvilError, ErrorCode, loadConfig, parseCliArgs, renderTable } from '@anvil/core'
import { buildProfile } from '@anvil/profile'
import { currentBranch, mainWorktreeRoot } from '@anvil/git'
import { parseRef, type NormalizedState, type Ticket, type TicketRef } from '@anvil/tickets'
import { renderContextBundle, renderAgentsOverlay, CONTEXT_FILE, AGENTS_OVERLAY } from '@anvil/tickets/context'
import { DEFAULT_TICKETS_DIR, LocalTicketProvider } from '@anvil/providers'
import { claimStatuses, claimTicket, findOrphanWorktrees, releaseClaim } from '@anvil/worktrees'
import type { Command, CommandContext } from './types.ts'

/**
 * The repository that owns shared state.
 *
 * Always the **main** worktree, never whichever worktree anvil is running from. Tickets
 * and the claim registry are shared; a disposable worktree must not own them. Without
 * this, `anvil issue refresh` run inside a worktree looks for tickets the worktree does
 * not have, and the mid-task refresh workflow simply does not work.
 */
async function mainRootFor(ctx: CommandContext): Promise<string> {
  const cwd = ctx.repoRoot
  if (cwd === null) {
    throw new AnvilError(ErrorCode.NotAGitRepo, 'Not inside a git repository', {
      hint: 'Claims and tickets need a repository.',
    })
  }
  const main = await mainWorktreeRoot(cwd)
  return main ?? cwd
}

/** Resolve the tickets directory, always against the main worktree. */
function ticketsDirFor(ctx: CommandContext, mainRoot: string): string {
  const configured = process.env.ANVIL_TICKETS_DIR
  if (configured !== undefined && configured !== '') return resolve(configured)
  return join(mainRoot, DEFAULT_TICKETS_DIR)
}

function providerFor(ctx: CommandContext, mainRoot: string): LocalTicketProvider {
  return new LocalTicketProvider({ dir: ticketsDirFor(ctx, mainRoot) })
}

function requireRepo(ctx: CommandContext): string {
  if (ctx.repoRoot === null) {
    throw new AnvilError(ErrorCode.NotAGitRepo, 'Not inside a git repository', {
      hint: 'Claims need a repository to branch from.',
    })
  }
  return ctx.repoRoot
}

async function loadTicket(ctx: CommandContext, input: string, mainRoot: string): Promise<Ticket> {
  const provider = providerFor(ctx, mainRoot)
  const auth = await provider.authStatus()
  if (!auth.ok && !existsSync(ticketsDirFor(ctx, mainRoot))) {
    throw new AnvilError(ErrorCode.Usage, 'No ticket directory yet', {
      hint: `Create one with \`anvil issue create <title>\`, or set ANVIL_TICKETS_DIR. (${auth.detail ?? ''})`,
    })
  }
  const ref = parseRef(input, 'local')
  return provider.fetch(ref)
}

const GLOBAL_ONLY = { json: { type: 'boolean', short: 'j' }, noColor: { type: 'boolean' }, help: { type: 'boolean', short: 'h' } } as const

// ---------------------------------------------------------------------------
// anvil claim
// ---------------------------------------------------------------------------

export const claimCommand: Command = {
  name: 'claim',
  summary: 'Create a branch, a worktree, and the ticket context for an agent to work in.',
  usage: 'anvil claim <ticket-ref> [--prefix feat] [--base <branch>] [--runner <name>]',
  details: [
    'Creates a worktree outside the repository (a short sibling directory, to stay under',
    "the Windows path limit) and makes it warm: the ticket, the acceptance criteria, the",
    "repository's real verify commands and the high-risk paths are written into the",
    'worktree as a context bundle the agent reads first.',
    '',
    'Refuses rather than guesses: a colliding branch, an occupied path, a dirty target or',
    'a path over the Windows budget all stop the claim before anything is created.',
    '',
    '--prefix <p>   branch prefix, default `feat` (try fix/, chore/, spike/)',
    '--base <b>     branch from this instead of the ticket or default branch',
    '--runner <r>   record which agent will work here, for `anvil status`',
  ].join('\n'),
  flags: {
    ...GLOBAL_ONLY,
    prefix: { type: 'string' },
    base: { type: 'string' },
    runner: { type: 'string' },
    'worktree-root': { type: 'string' },
  },

  async run(ctx, rawArgs) {
    const args = parseCliArgs(rawArgs, claimCommand.flags)
    const ref = args.positionals[0]
    if (ref === undefined) {
      throw new AnvilError(ErrorCode.Usage, 'claim needs a ticket reference', {
        hint: 'e.g. `anvil claim 3`, `anvil claim local-3`, or a full ticket URL.',
      })
    }

    const repoRoot = requireRepo(ctx)
    const mainRoot = await mainRootFor(ctx)
    const ticket = await loadTicket(ctx, ref, mainRoot)
    const { config } = loadConfig({ repoRoot: mainRoot })

    const result = await claimTicket({
      repoRoot,
      ticket,
      ...(typeof args.values.prefix === 'string' ? { prefix: args.values.prefix } : {}),
      ...(typeof args.values.base === 'string' ? { base: args.values.base } : {}),
      ...(typeof args.values['worktree-root'] === 'string' ? { worktreeRoot: args.values['worktree-root'] } : {}),
      worktreeRoot: config.git.worktreeRoot,
      ...(typeof args.values.runner === 'string' ? { runner: args.values.runner } : {}),
    })

    const data = {
      schemaVersion: 1,
      key: result.claim.key,
      branch: result.claim.branch,
      baseBranch: result.claim.baseBranch,
      baseRef: result.claim.baseRef,
      worktree: result.claim.worktreePath,
      checks: result.checks,
      notes: result.notes,
      needsUpstream: result.needsUpstream,
    }

    ctx.out(data, () => {
      const s = ctx.style
      const out: string[] = []
      out.push(`${s.green('claimed')} ${result.claim.key}`)
      out.push(`  branch    ${result.claim.branch}  ${s.dim(`(from ${result.claim.baseRef})`)}`)
      out.push(`  worktree  ${result.claim.worktreePath}`)
      out.push(`  context   ${CONTEXT_FILE}  ${AGENTS_OVERLAY}`)
      if (result.notes.length > 0) {
        out.push('')
        out.push(s.yellow('note'))
        for (const n of result.notes) out.push(`  ${n}`)
      }
      if (result.needsUpstream) {
        out.push('')
        out.push(s.dim('The branch has no upstream yet; `anvil ship` (M4) will push it.'))
      }
      out.push('')
      out.push(s.dim('Start an agent in it:'))
      out.push(s.dim(`  cd ${result.claim.worktreePath}`))
      return out.join('\n')
    })
    return undefined
  },
}

// ---------------------------------------------------------------------------
// anvil release
// ---------------------------------------------------------------------------

export const releaseCommand: Command = {
  name: 'release',
  summary: 'Tear down a claim: remove its worktree, optionally its branch.',
  usage: 'anvil release <key> [--force] [--delete-branch]',
  details: [
    'Refuses to remove a worktree holding uncommitted changes or unpushed commits unless',
    '--force is passed, and reports which of the two it found. A crew that reports "clean"',
    'while commits sit unpushed will lose them.',
  ].join('\n'),
  flags: {
    ...GLOBAL_ONLY,
    force: { type: 'boolean' },
    'delete-branch': { type: 'boolean' },
  },

  async run(ctx, rawArgs) {
    const args = parseCliArgs(rawArgs, releaseCommand.flags)
    const key = args.positionals[0]
    if (key === undefined) {
      throw new AnvilError(ErrorCode.Usage, 'release needs a claim key', { hint: 'Run `anvil status` to list them.' })
    }

    const repoRoot = await mainRootFor(ctx)
    const result = await releaseClaim({
      repoRoot,
      key,
      force: args.values.force === true,
      deleteBranch: args.values['delete-branch'] === true,
    })

    const data = {
      schemaVersion: 1,
      key,
      worktreeRemoved: result.worktreeRemoved,
      branchDeleted: result.branchDeleted,
      ...(result.retainedBecause === undefined ? {} : { retainedBecause: result.retainedBecause }),
    }

    if (result.retainedBecause !== undefined) {
      const err = new AnvilError(ErrorCode.Usage, `Kept ${result.claim.worktreePath}: ${result.retainedBecause}`, {
        hint: 'Commit or push the work, or re-run with --force to discard it.',
      })
      if (args.values.json === true) {
        ctx.out(data, () => '')
        ctx.writeError(`\nerror ${err.message}\nhint  ${err.hint}\n`)
      } else {
        ctx.writeError(`\nerror ${err.message}\nhint  ${err.hint}\n`)
      }
      return err.exitCode
    }

    ctx.out(data, () => {
      const s = ctx.style
      const out = [`${s.green('released')} ${key}`]
      if (result.branchDeleted) out.push(`  deleted branch ${result.claim.branch}`)
      return out.join('\n')
    })
    return undefined
  },
}

// ---------------------------------------------------------------------------
// anvil status
// ---------------------------------------------------------------------------

function age(seconds: number | null): string {
  if (seconds === null) return '-'
  if (seconds < 90) return `${seconds}s`
  if (seconds < 5400) return `${Math.round(seconds / 60)}m`
  if (seconds < 172800) return `${Math.round(seconds / 3600)}h`
  return `${Math.round(seconds / 86400)}d`
}

export const statusCommand: Command = {
  name: 'status',
  summary: 'Show every claim: branch, worktree, uncommitted changes, unpushed commits.',
  usage: 'anvil status [--orphans]',
  details: [
    'Uncommitted changes and unpushed commits are reported separately, because they need',
    'different handling and only one of them is obvious from `git status`.',
    '',
    '--orphans   also list worktrees git knows about that no claim references',
  ].join('\n'),
  flags: {
    ...GLOBAL_ONLY,
    orphans: { type: 'boolean' },
  },

  async run(ctx, rawArgs) {
    const args = parseCliArgs(rawArgs, statusCommand.flags)
    const repoRoot = await mainRootFor(ctx)
    const statuses = await claimStatuses(repoRoot)
    const orphans = args.values.orphans === true ? await findOrphanWorktrees(repoRoot) : []

    const data = {
      schemaVersion: 1,
      claims: statuses.map((s) => ({
        key: s.claim.key,
        branch: s.claim.branch,
        state: s.claim.state,
        worktree: s.claim.worktreePath,
        present: s.present,
        uncommitted: s.uncommitted,
        unpushed: s.unpushed,
        hasUpstream: s.hasUpstream,
        lastCommitAgeSeconds: s.lastCommitAgeSeconds,
        lastCommitSubject: s.lastCommitSubject,
        orphaned: s.orphaned,
        branchMismatch: s.branchMismatch,
        pr: s.claim.pr ?? null,
      })),
      orphanWorktrees: orphans,
    }

    ctx.out(data, () => {
      const s = ctx.style
      const out: string[] = []
      if (statuses.length === 0) {
        out.push(s.dim('No claims. Run `anvil claim <ticket-ref>` to start one.'))
      } else {
        out.push(
          renderTable(
            ['key', 'branch', 'wt', 'uncommitted', 'unpushed', 'last', 'state'],
            statuses.map((st) => [
              st.claim.key,
              st.claim.branch,
              st.present ? s.green('ok') : s.red('gone'),
              st.uncommitted === 0 ? s.dim('0') : s.yellow(String(st.uncommitted)),
              st.unpushed === null ? s.dim('-') : st.unpushed === 0 ? s.dim('0') : s.yellow(String(st.unpushed)),
              age(st.lastCommitAgeSeconds),
              st.orphaned ? s.red('orphaned') : st.branchMismatch ? s.yellow('moved') : st.claim.state,
            ]),
            s,
          ),
        )
        const risky = statuses.filter((st) => st.uncommitted > 0 || (st.unpushed ?? 0) > 0)
        if (risky.length > 0) {
          out.push('')
          out.push(s.yellow(`${risky.length} claim(s) hold work that a release would discard`))
          for (const st of risky) {
            const parts: string[] = []
            if (st.uncommitted > 0) parts.push(`${st.uncommitted} uncommitted`)
            if ((st.unpushed ?? 0) > 0) parts.push(`${st.unpushed} unpushed`)
            out.push(`  ${st.claim.key}: ${parts.join(', ')}`)
          }
        }
      }
      if (orphans.length > 0) {
        out.push('')
        out.push(s.yellow(`Orphan worktrees (${orphans.length})`))
        for (const p of orphans) out.push(`  ${p}`)
      }
      return out.join('\n')
    })
    return undefined
  },
}

// ---------------------------------------------------------------------------
// anvil issue
// ---------------------------------------------------------------------------

const ISSUE_SUBCOMMANDS = ['show', 'list', 'create', 'comment', 'set-state', 'pull', 'refresh', 'sync'] as const

export const issueCommand: Command = {
  name: 'issue',
  summary: 'Work with tickets: show, list, create, comment, set-state, refresh context.',
  usage: 'anvil issue <show|list|create|comment|set-state|pull|refresh> [args]',
  details: [
    'Reads from the local markdown provider, which needs no account and no network. That',
    'is deliberate: it is the escape hatch for a company that blocks API egress.',
    '',
    'pull       write the context bundle into the current directory (or a worktree)',
    'refresh    re-read the ticket and rewrite the bundle, picking up new comments',
    'sync       push state from the linked pull request back to the ticket',
  ].join('\n'),
  flags: {
    ...GLOBAL_ONLY,
    body: { type: 'string', short: 'b' },
    state: { type: 'string' },
    label: { type: 'string', multiple: true },
    limit: { type: 'string' },
    dir: { type: 'string' },
  },

  async run(ctx, rawArgs) {
    const args = parseCliArgs(rawArgs, issueCommand.flags)
    const sub = args.positionals[0] ?? 'list'
    if (!(ISSUE_SUBCOMMANDS as readonly string[]).includes(sub)) {
      throw new AnvilError(ErrorCode.Usage, `Unknown issue subcommand: ${sub}`, {
        hint: `Expected one of: ${ISSUE_SUBCOMMANDS.join(', ')}`,
      })
    }

    const mainRoot = await mainRootFor(ctx)
    const dir =
      typeof args.values.dir === 'string' ? resolve(args.values.dir) : ticketsDirFor(ctx, mainRoot)
    const provider = new LocalTicketProvider({ dir })

    if (sub === 'create') {
      const title = args.positionals.slice(1).join(' ').trim()
      if (title === '') {
        throw new AnvilError(ErrorCode.Usage, 'create needs a title', { hint: 'e.g. `anvil issue create Fix login redirect`.' })
      }
      const body = typeof args.values.body === 'string' ? args.values.body : ''
      const ref = await provider.create({ title, body, labels: toList(args.values.label) })
      ctx.out({ schemaVersion: 1, created: ref }, () => `${ctx.style.green('created')} ${ref.key}  ${join(dir, `${ref.id}.md`)}`)
      return undefined
    }

    if (sub === 'list') {
      const refs = await provider.list({
        ...(typeof args.values.state === 'string' ? { state: args.values.state as NormalizedState } : {}),
        ...(typeof args.values.limit === 'string' ? { limit: Number.parseInt(args.values.limit, 10) } : {}),
      })
      const rows: Array<[string, string, string]> = []
      for (const ref of refs) {
        const t = await provider.fetch(ref)
        rows.push([ref.key, t.state ?? t.normalizedState, t.title])
      }
      ctx.out({ schemaVersion: 1, tickets: rows.map((r) => ({ key: r[0], state: r[1], title: r[2] })) }, () =>
        rows.length === 0
          ? ctx.style.dim(`(no tickets in ${dir})`)
          : renderTable(['key', 'state', 'title'], rows, ctx.style),
      )
      return undefined
    }

    const refArg = args.positionals[1]
    if (refArg === undefined) {
      throw new AnvilError(ErrorCode.Usage, `issue ${sub} needs a ticket reference`, {
        hint: 'e.g. `anvil issue show 1`.',
      })
    }
    const ref = parseRef(refArg, 'local')

    if (sub === 'show') {
      const ticket = await provider.fetch(ref)
      ctx.out({ schemaVersion: 1, ticket }, () => renderTicket(ctx, ticket))
      return undefined
    }

    if (sub === 'comment') {
      const body = typeof args.values.body === 'string' ? args.values.body : ''
      if (body.trim() === '') {
        throw new AnvilError(ErrorCode.Usage, 'comment needs a body', { hint: 'Use --body "...".' })
      }
      await provider.comment(ref, body)
      ctx.out({ schemaVersion: 1, commented: ref }, () => `${ctx.style.green('commented on')} ${ref.key}`)
      return undefined
    }

    if (sub === 'set-state') {
      const to = args.positionals[2]
      if (to === undefined) {
        throw new AnvilError(ErrorCode.Usage, 'set-state needs a state', {
          hint: 'todo, in_progress, in_review, done, wontfix',
        })
      }
      await provider.transition(ref, to as NormalizedState)
      ctx.out({ schemaVersion: 1, ref, state: to }, () => `${ctx.style.green(ref.key)} -> ${to}`)
      return undefined
    }

    if (sub === 'sync') {
      // PR -> ticket. The other direction is `ship`, which updates the ticket as it opens
      // the PR; `sync` is for when that update was skipped, or when the PR moved on.
      const { GitHubProvider, hostFromRemote } = await import('@anvil/providers')
      const { git, mainWorktreeRoot: mainOf } = await import('@anvil/git')
      const { readClaims: readClaimsOf } = await import('@anvil/worktrees')
      const claim = readClaimsOf(mainRoot).claims.find((c) => c.key === ref.key)
      if (claim === undefined) {
        throw new AnvilError(ErrorCode.Usage, `No claim for "${ref.key}"`, {
          hint: 'Run `anvil status` to see claims, or `anvil ship <key>` to open the pull request first.',
        })
      }

      const remote = await git(['remote', 'get-url', 'origin'], { cwd: mainRoot })
      const host = hostFromRemote(remote.exitCode === 0 ? remote.stdout.trim() : null)
      const ghProvider = new GitHubProvider({ ...(host === null ? {} : { host }) })

      const branch = await currentBranch(claim.worktreePath)
      if (branch === null) {
        throw new AnvilError(ErrorCode.Usage, `The worktree for ${ref.key} has no branch`, { hint: 'Inspect the worktree, or release and re-claim.' })
      }
      const pr = await ghProvider.transport().findPullRequest({ cwd: claim.worktreePath, branch })
      if (pr === null) {
        throw new AnvilError(ErrorCode.Usage, `No open pull request for ${branch}`, {
          hint: `Run \`anvil ship ${ref.key}\` to open one.`,
        })
      }

      const state = pr.state.toUpperCase() === 'MERGED' ? 'done' : 'in_review'
      const note = `Pull request #${pr.number} is ${pr.state.toLowerCase()}: ${pr.url}`
      await ghProvider.comment(claim.ticket, note)
      await ghProvider.transition(claim.ticket, state)

      ctx.out({ schemaVersion: 1, ref, pr, state }, () =>
        [
          `${ctx.style.green('synced')} ${ref.key}`,
          `  pull request  #${pr.number} ${pr.state}`,
          `  ticket state  ${state}`,
        ].join('\n'),
      )
      return undefined
    }

    // pull / refresh: write the context bundle for the current directory.
    const target = requireRepo(ctx)
    const ticket = await provider.fetch(ref)
    const profile = buildProfile(target, { root: target, host: null, remote: null, defaultBranch: null }).profile
    const branch = await currentBranch(target)
    const context = renderContextBundle({ ticket, profile, branch: branch ?? 'HEAD' })
    const overlay = renderAgentsOverlay({ ticket, profile })
    mkdirSync(join(target, '.anvil'), { recursive: true })
    writeFileSync(join(target, context.path), context.content, 'utf8')
    writeFileSync(join(target, overlay.path), overlay.content, 'utf8')
    await excludeAnvilState(target)

    ctx.out({ schemaVersion: 1, ref, written: [context.path, overlay.path] }, () =>
      [
        `${ctx.style.green('wrote')} ${context.path}`,
        `${ctx.style.green('wrote')} ${overlay.path}`,
        ctx.style.dim('The agent in this directory should read the context bundle first.'),
      ].join('\n'),
    )
    return undefined
  },
}

function toList(value: unknown): string[] {
  if (Array.isArray(value)) return value.filter((v): v is string => typeof v === 'string')
  if (typeof value === 'string') return value.split(',').map((s) => s.trim()).filter((s) => s !== '')
  return []
}

/**
 * Keep `.anvil/` out of git.
 *
 * Uses the repository's shared `info/exclude` rather than editing `.gitignore`. Editing
 * `.gitignore` would dirty the working tree on every claim, which in turn means `anvil
 * release` always reports uncommitted changes and refuses -- turning the clean path into
 * a dead end. `info/exclude` is local-only by design, which is exactly right for
 * regenerated, company-internal state.
 */
async function excludeAnvilState(repoRoot: string): Promise<void> {
  const { excludeAnvilState: exclude } = await import('@anvil/worktrees')
  await exclude(repoRoot)
}

function renderTicket(ctx: CommandContext, ticket: Ticket): string {
  const s = ctx.style
  const out: string[] = []
  out.push(`${s.bold(ticket.ref.key)}  ${ticket.title}`)
  out.push(s.dim(`  state: ${ticket.state ?? ticket.normalizedState}`))
  if (ticket.labels !== undefined && ticket.labels.length > 0) out.push(s.dim(`  labels: ${ticket.labels.join(', ')}`))
  if (ticket.baseBranch != null && ticket.baseBranch !== '') out.push(s.dim(`  base branch: ${ticket.baseBranch}`))
  if (ticket.body !== undefined && ticket.body.trim() !== '') {
    out.push('')
    out.push(ticket.body.trim())
  }
  if (ticket.acceptance !== undefined && ticket.acceptance.length > 0) {
    out.push('')
    out.push(s.bold('Acceptance criteria'))
    for (const a of ticket.acceptance) out.push(`  [ ] ${a}`)
  }
  return out.join('\n')
}

// ---------------------------------------------------------------------------
// anvil auth
// ---------------------------------------------------------------------------

export const authCommand: Command = {
  name: 'auth',
  summary: 'Check ticket-provider access and print the exact command to fix it.',
  usage: 'anvil auth [local|github] [--check]',
  details: [
    'Checks the provider offline where possible, and never emits a bare "auth failed".',
    '',
    'For GitHub Enterprise -- the common case when you join a new company -- the check',
    'probes the *detected host* and returns the login command naming that host, so you do',
    'not authenticate to the wrong one. A failure here stops `ship` before anything is',
    'pushed.',
  ].join('\n'),
  flags: {
    ...GLOBAL_ONLY,
    check: { type: 'boolean' },
  },

  async run(ctx, rawArgs) {
    const args = parseCliArgs(rawArgs, authCommand.flags)
    const which = args.positionals[0] ?? 'local'

    if (which === 'github') {
      const { GitHubProvider, hostFromRemote } = await import('@anvil/providers')
      const { git } = await import('@anvil/git')
      const cwd = requireRepo(ctx)
      const remote = await git(['remote', 'get-url', 'origin'], { cwd })
      const remoteUrl = remote.exitCode === 0 ? remote.stdout.trim() : null
      const host = hostFromRemote(remoteUrl)
      const provider = new GitHubProvider({ ...(host === null ? {} : { host }) })
      const status = await provider.authStatus()

      if (!status.ok) {
        const err = new AnvilError(ErrorCode.AuthFailed, `github provider: ${status.detail ?? 'unavailable'}`, {
          ...(status.remediation === undefined ? {} : { hint: status.remediation }),
        })
        if (args.values.json === true) ctx.out({ schemaVersion: 1, provider: 'github', ok: false, host }, () => '')
        ctx.writeError(`\nerror ${err.message}\n${err.hint === undefined ? '' : `hint  ${err.hint}\n`}`)
        return err.exitCode
      }
      ctx.out(
        { schemaVersion: 1, provider: 'github', ok: true, host, identity: status.identity },
        () =>
          `${ctx.style.green('ok')} github${host === null ? '' : ` (${host})`}: ${status.identity ?? 'authenticated'}`,
      )
      return undefined
    }

    if (which !== 'local') {
      throw new AnvilError(ErrorCode.Usage, `Unknown provider: ${which}`, {
        hint: 'Expected one of: local, github',
      })
    }

    const mainRoot = await mainRootFor(ctx)
    const dir = ticketsDirFor(ctx, mainRoot)
    const provider = new LocalTicketProvider({ dir })
    const status = await provider.authStatus()

    if (!status.ok) {
      const err = new AnvilError(ErrorCode.AuthFailed, `local provider: ${status.detail ?? 'unavailable'}`, {
        ...(status.remediation === undefined ? {} : { hint: status.remediation }),
      })
      if (args.values.json === true) ctx.out({ schemaVersion: 1, provider: 'local', ok: false }, () => '')
      ctx.writeError(`\nerror ${err.message}\n${err.hint === undefined ? '' : `hint  ${err.hint}\n`}`)
      return err.exitCode
    }

    ctx.out({ schemaVersion: 1, provider: 'local', ok: true, identity: status.identity, dir }, () =>
      `${ctx.style.green('ok')} local provider: ${status.identity ?? dir}`,
    )
    return undefined
  },
}
