/**
 * `anvil claim`, `anvil release`, `anvil status`, `anvil issue`, `anvil auth`.
 *
 * The first half of the per-ticket loop. `claim` turns a ticket reference into a warm
 * worktree an agent can work in immediately; `status` shows what is in flight and what
 * would be lost if it were released now.
 */

import { mkdirSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { AnvilError, ErrorCode, loadConfig, parseCliArgs, renderTable } from '@anvil/core'
import { currentBranch, mainWorktreeRoot } from '@anvil/git'
import { buildProfile } from '@anvil/profile'
import { createTicketProvider, GitHubProvider, requireCapability, SUPPORTED_PROVIDERS } from '@anvil/providers'
import type { NormalizedState, Ticket } from '@anvil/tickets'
import { repositoryOf } from '@anvil/tickets'
import { AGENTS_OVERLAY, CONTEXT_FILE, renderAgentsOverlay, renderContextBundle } from '@anvil/tickets/context'
import { claimStatuses, claimTicket, findOrphanWorktrees, releaseClaim } from '@anvil/worktrees'
import {
  fetchTicket,
  type ProviderOptions,
  providerUnavailable,
  readTicket,
  ticketProviderFor,
  ticketsDirFor,
} from '../tickets.ts'
import { recommendForProfile, recommendForWorktree } from './recommend.ts'
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

/** The `--provider` value, or null when the flag is absent. */
function providerFlag(args: ReturnType<typeof parseCliArgs>): string | null {
  return typeof args.values.provider === 'string' ? args.values.provider : null
}

/** The per-command overrides a provider needs: `--dir`, and nothing in production. */
function providerOptions(args: ReturnType<typeof parseCliArgs>): ProviderOptions {
  return typeof args.values.dir === 'string' ? { ticketsDir: resolve(args.values.dir) } : {}
}

function requireRepo(ctx: CommandContext): string {
  if (ctx.repoRoot === null) {
    throw new AnvilError(ErrorCode.NotAGitRepo, 'Not inside a git repository', {
      hint: 'Claims need a repository to branch from.',
    })
  }
  return ctx.repoRoot
}

const GLOBAL_ONLY = {
  json: { type: 'boolean', short: 'j' },
  help: { type: 'boolean', short: 'h' },
} as const

// ---------------------------------------------------------------------------
// anvil claim
// ---------------------------------------------------------------------------

export const claimCommand: Command = {
  name: 'claim',
  summary: 'Create a branch, a worktree, and the ticket context for an agent to work in.',
  usage: 'anvil claim <ticket-ref> [--provider local|github|jira] [--prefix feat] [--base <branch>] [--runner <name>]',
  details: [
    'Creates a worktree outside the repository (a short sibling directory, to stay under',
    'the Windows path limit) and makes it warm: the ticket, the acceptance criteria, the',
    "repository's real verify commands and the high-risk paths are written into the",
    'worktree as a context bundle the agent reads first.',
    '',
    'Refuses rather than guesses: a colliding branch, an occupied path, a dirty target or',
    'a path over the Windows budget all stop the claim before anything is created.',
    '',
    'The ticket text is marked untrusted in the bundle, and the worktree gets a pre-push',
    'hook that only `anvil ship` can satisfy. Instruction-like ticket lines are reported.',
    '',
    'The provider is the `--provider` flag, else `provider.default`, else whatever the',
    'reference names (`gh-42`, or a ticket URL), else `local`.',
    '',
    '--provider <p>  ticket provider: local (default), github or jira',
    '--prefix <p>    branch prefix, default `feat` (try fix/, chore/, spike/)',
    '--base <b>      branch from this instead of the ticket or default branch',
    '--runner <r>    record which agent will work here, for `anvil status`',
  ].join('\n'),
  flags: {
    ...GLOBAL_ONLY,
    provider: { type: 'string' },
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
        hint: 'e.g. `anvil claim 3`, `anvil claim gh-42`, `anvil claim local-3`, or a full ticket URL.',
      })
    }

    const repoRoot = requireRepo(ctx)
    const mainRoot = await mainRootFor(ctx)
    const { ticket, resolved } = await fetchTicket(mainRoot, ref, { provider: providerFlag(args) })
    const { config } = loadConfig({ repoRoot: mainRoot })

    // Optional aids for the worktree's context bundle. Ranked against the worktree that is
    // created, not this checkout: the claim may fork from a base branch with a different stack.
    const result = await claimTicket({
      repoRoot,
      ticket,
      declared: config.project.commands,
      recommend: (worktreePath) => recommendForWorktree(worktreePath, ticket),
      ...(typeof args.values.prefix === 'string' ? { prefix: args.values.prefix } : {}),
      ...(typeof args.values.base === 'string' ? { base: args.values.base } : {}),
      ...(typeof args.values.runner === 'string' ? { runner: args.values.runner } : {}),
      // An explicit --worktree-root wins over the config; the config is the fallback.
      // (This was previously a duplicated object key, so the config value silently
      // overwrote the flag and the flag did nothing.)
      worktreeRoot:
        typeof args.values['worktree-root'] === 'string' ? args.values['worktree-root'] : config.git.worktreeRoot,
    })

    const data = {
      schemaVersion: 1,
      key: result.claim.key,
      provider: resolved.id,
      branch: result.claim.branch,
      baseBranch: result.claim.baseBranch,
      baseRef: result.claim.baseRef,
      worktree: result.claim.worktreePath,
      agent: result.claim.agent ?? null,
      checks: result.checks,
      notes: result.notes,
      needsUpstream: result.needsUpstream,
      injection: result.injection,
      pushGuard: result.pushGuard,
    }

    ctx.out(data, () => {
      const s = ctx.style
      const out: string[] = []
      out.push(`${s.green('claimed')} ${result.claim.key}`)
      out.push(`  branch    ${result.claim.branch}  ${s.dim(`(from ${result.claim.baseRef})`)}`)
      out.push(`  worktree  ${result.claim.worktreePath}`)
      out.push(`  provider  ${resolved.id} ${s.dim(`(${resolved.source})`)}`)
      if (result.claim.agent !== undefined) {
        const version = result.claim.agent.version === undefined ? '' : ` (${result.claim.agent.version})`
        out.push(`  agent     ${result.claim.agent.runner}${version}`)
      }
      out.push(`  context   ${CONTEXT_FILE}  ${AGENTS_OVERLAY}`)
      out.push(
        `  guard     ${result.pushGuard.installed ? s.green(result.pushGuard.detail) : s.yellow(result.pushGuard.detail)}`,
      )
      if (result.notes.length > 0) {
        out.push('')
        out.push(s.yellow('note'))
        for (const n of result.notes) out.push(`  ${n}`)
      }
      if (result.injection.length > 0) {
        out.push('')
        out.push(
          s.yellow(
            `${result.injection.length} instruction-like line(s) in the ticket; the bundle quotes them as untrusted`,
          ),
        )
        for (const f of result.injection.slice(0, 5)) out.push(`  ${f.field}:${f.line} (${f.kind}) '${f.excerpt}'`)
        if (result.injection.length > 5) out.push(`  ... and ${result.injection.length - 5} more`)
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
      throw new AnvilError(ErrorCode.Usage, 'release needs a claim key', {
        hint: 'Run `anvil status` to list them.',
      })
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
      ...(result.branchRetainedBecause === undefined ? {} : { branchRetainedBecause: result.branchRetainedBecause }),
    }

    if (result.retainedBecause !== undefined) {
      const err = new AnvilError(ErrorCode.Usage, `Kept ${result.claim.worktreePath}: ${result.retainedBecause}`, {
        hint: 'Commit or push the work, or re-run with --force to discard it.',
      })
      ctx.outFailure(
        data,
        err,
        () => `\n${ctx.style.red('error')} ${err.message}\n${ctx.style.dim('hint ')} ${err.hint}\n`,
      )
      return err.exitCode
    }

    ctx.out(data, () => {
      const s = ctx.style
      const out = [`${s.green('released')} ${key}`]
      if (result.branchDeleted) out.push(`  deleted branch ${result.claim.branch}`)
      if (result.branchRetainedBecause !== undefined) {
        out.push(`  ${s.yellow('kept branch')} ${result.claim.branch}: ${result.branchRetainedBecause}`)
      }
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
  usage: 'anvil issue <show|list|create|comment|set-state|pull|refresh> [args] [--provider local|github|jira]',
  details: [
    'The provider is the `--provider` flag, else `provider.default`, else whatever the',
    'reference names (`gh-42`, or a ticket URL), else `local`. `local` reads markdown files',
    'and needs no account, no network and no `gh`: it is the escape hatch for a company that',
    'blocks API egress. `jira` needs `provider.jira.site` plus JIRA_EMAIL and JIRA_API_TOKEN.',
    '',
    'pull       write the context bundle into the current directory (or a worktree)',
    'refresh    re-read the ticket and rewrite the bundle, picking up new comments',
    'sync       push state from the linked pull request back to the ticket',
    '',
    '--provider <p>  ticket provider: local (default), github or jira',
  ].join('\n'),
  flags: {
    ...GLOBAL_ONLY,
    body: { type: 'string', short: 'b' },
    state: { type: 'string' },
    label: { type: 'string', multiple: true },
    limit: { type: 'string' },
    dir: { type: 'string' },
    provider: { type: 'string' },
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
    const explicit = providerFlag(args)
    const overrides = providerOptions(args)
    const providerFor = ctx.providerFor ?? ticketProviderFor
    // The directory a local create writes into. Only used for the human-readable path;
    // the provider itself owns the write.
    const localDir = overrides.ticketsDir ?? ticketsDirFor(mainRoot)

    if (sub === 'create') {
      const title = args.positionals.slice(1).join(' ').trim()
      if (title === '') {
        throw new AnvilError(ErrorCode.Usage, 'create needs a title', {
          hint: 'e.g. `anvil issue create Fix login redirect`.',
        })
      }
      const body = typeof args.values.body === 'string' ? args.values.body : ''
      const resolved = await providerFor(mainRoot, { provider: explicit }, overrides)
      requireCapability(resolved.provider, 'create', 'create a ticket')
      const ref = await resolved.provider.create({
        title,
        body,
        labels: toList(args.values.label),
      })
      const where = ref.url ?? join(localDir, `${ref.id}.md`)
      ctx.out(
        { schemaVersion: 1, provider: resolved.id, created: ref },
        () => `${ctx.style.green('created')} ${ref.key}  ${where}`,
      )
      return undefined
    }

    if (sub === 'list') {
      const resolved = await providerFor(mainRoot, { provider: explicit }, overrides)
      requireCapability(resolved.provider, 'list', 'list tickets')
      const auth = await resolved.provider.authStatus()
      if (!auth.ok) throw providerUnavailable(resolved, auth)
      const refs =
        (await resolved.provider.list?.({
          ...(typeof args.values.state === 'string' ? { state: stateArg(args.values.state) } : {}),
          ...(typeof args.values.limit === 'string' ? { limit: Number.parseInt(args.values.limit, 10) } : {}),
        })) ?? []
      const rows: Array<[string, string, string]> = []
      for (const ref of refs) {
        const t = await resolved.provider.fetch(ref)
        rows.push([ref.key, t.state ?? t.normalizedState, t.title])
      }
      ctx.out(
        {
          schemaVersion: 1,
          provider: resolved.id,
          tickets: rows.map((r) => ({ key: r[0], state: r[1], title: r[2] })),
        },
        () =>
          rows.length === 0
            ? ctx.style.dim(`(no tickets from the ${resolved.id} provider)`)
            : renderTable(['key', 'state', 'title'], rows, ctx.style),
      )
      return undefined
    }

    const refArg = args.positionals[1]
    if (refArg === undefined) {
      throw new AnvilError(ErrorCode.Usage, `issue ${sub} needs a ticket reference`, {
        hint: 'e.g. `anvil issue show 1`, `anvil issue show gh-42`, or a ticket URL.',
      })
    }
    const resolved = await providerFor(mainRoot, { ref: refArg, provider: explicit }, overrides)
    if (resolved.ref === undefined) {
      throw new AnvilError(ErrorCode.Internal, `issue ${sub} resolved no ticket reference`, {
        hint: 'This is a bug in anvil: the reference was checked above.',
      })
    }
    const ref = resolved.ref

    if (sub === 'show') {
      const ticket = await readTicket(resolved)
      ctx.out({ schemaVersion: 1, provider: resolved.id, ticket }, () => renderTicket(ctx, ticket))
      return undefined
    }

    if (sub === 'comment') {
      const body = typeof args.values.body === 'string' ? args.values.body : ''
      if (body.trim() === '') {
        throw new AnvilError(ErrorCode.Usage, 'comment needs a body', {
          hint: 'Use --body "...".',
        })
      }
      requireCapability(resolved.provider, 'comment', 'comment on a ticket')
      await resolved.provider.comment(ref, body)
      ctx.out(
        { schemaVersion: 1, provider: resolved.id, commented: ref },
        () => `${ctx.style.green('commented on')} ${ref.key}`,
      )
      return undefined
    }

    if (sub === 'set-state') {
      const to = args.positionals[2]
      if (to === undefined) {
        throw new AnvilError(ErrorCode.Usage, 'set-state needs a state', {
          hint: 'todo, in_progress, in_review, done, wontfix',
        })
      }
      const state = stateArg(to)
      requireCapability(resolved.provider, 'transition', 'move a ticket between states')
      await resolved.provider.transition(ref, state)
      ctx.out({ schemaVersion: 1, provider: resolved.id, ref, state }, () => `${ctx.style.green(ref.key)} -> ${state}`)
      return undefined
    }

    if (sub === 'sync') {
      // PR -> ticket. The other direction is `ship`, which updates the ticket as it opens
      // the PR; `sync` is for when that update was skipped, or when the PR moved on.
      const { readClaims: readClaimsOf } = await import('@anvil/worktrees')
      const claims = readClaimsOf(mainRoot).claims.filter((c) => c.key === ref.key)
      // A URL names a repository. Two repositories can each have an issue #42, so a claim
      // match by key alone would let a URL for repo B act on repo A's claim. The requested
      // repository has to agree with what the claim recorded; substituting the claim's
      // ticket is exactly the wrong-repository write this prevents.
      const requestedRepo = repositoryOf(ref.url)
      const claim =
        requestedRepo === null
          ? claims[0]
          : claims.find((c) => {
              const recorded = repositoryOf(c.ticket.url)
              return recorded !== null && recorded.host === requestedRepo.host && recorded.path === requestedRepo.path
            })
      if (claim === undefined) {
        if (requestedRepo !== null && claims.length > 0) {
          const recorded = claims
            .map((c) => c.ticket.url)
            .filter((url): url is string => url !== undefined && url !== '')
          const recordedText =
            recorded.length === 0
              ? `a bare issue number in this repository (${claims.map((c) => c.key).join(', ')})`
              : recorded.join(', ')
          throw new AnvilError(ErrorCode.Usage, `Claim "${ref.key}" is for ${recordedText}, not ${ref.url}`, {
            hint: `Refusing to sync a different repository's issue. Run \`anvil claim ${ref.url}\` to make a separate claim.`,
            details: {
              requested: { url: ref.url, repository: `${requestedRepo.host}/${requestedRepo.path}` },
              recorded,
            },
          })
        }
        throw new AnvilError(ErrorCode.Usage, `No claim for "${ref.key}"`, {
          hint: 'Run `anvil status` to see claims, or `anvil ship <key>` to open the pull request first.',
        })
      }
      // Sync is the GitHub side of the bridge. A claim made against a *local* ticket on a
      // repo that happens to have a GitHub remote would otherwise comment on the
      // same-numbered GitHub issue -- a different ticket, on a different system.
      if (claim.ticket.provider !== 'github') {
        throw new AnvilError(
          ErrorCode.Usage,
          `Ticket ${ref.key} is a ${claim.ticket.provider} ticket, not a GitHub issue`,
          {
            hint: '`anvil issue sync` links a GitHub pull request to a GitHub issue. Other ticket providers are updated by `anvil ship` itself.',
          },
        )
      }

      const ticketProvider = await providerFor(
        mainRoot,
        { ref: claim.ticket.key, provider: claim.ticket.provider },
        overrides,
      )
      requireCapability(ticketProvider.provider, 'comment', 'comment on a ticket')
      requireCapability(ticketProvider.provider, 'transition', 'move a ticket between states')
      const ghProvider = ticketProvider.provider
      if (!(ghProvider instanceof GitHubProvider)) {
        throw new AnvilError(ErrorCode.Internal, `The ${ticketProvider.id} provider has no pull-request transport`, {
          hint: 'This is a bug in anvil: only the GitHub provider can sync a pull request.',
        })
      }

      const branch = await currentBranch(claim.worktreePath)
      if (branch === null) {
        throw new AnvilError(ErrorCode.Usage, `The worktree for ${ref.key} has no branch`, {
          hint: 'Inspect the worktree, or release and re-claim.',
        })
      }
      const pr = await ghProvider.transport().findPullRequest({ cwd: claim.worktreePath, branch })
      if (pr === null) {
        throw new AnvilError(ErrorCode.Usage, `No open pull request for ${branch}`, {
          hint: `Run \`anvil ship ${ref.key}\` to open one.`,
        })
      }

      // A merged PR means done. A closed-unmerged PR means the work was not shipped, so
      // calling it `in_review` would claim otherwise. An open PR is in review.
      const prUpper = pr.state.toUpperCase()
      const state: NormalizedState = prUpper === 'MERGED' ? 'done' : prUpper === 'CLOSED' ? 'in_progress' : 'in_review'
      const note = `Pull request #${pr.number} is ${pr.state.toLowerCase()}: ${pr.url}`
      await ghProvider.comment(claim.ticket, note)
      await ghProvider.transition(claim.ticket, state)

      ctx.out({ schemaVersion: 1, provider: ticketProvider.id, ref, pr, state }, () =>
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
    const ticket = await readTicket(resolved)
    const profile = buildProfile(target, {
      root: target,
      host: null,
      remote: null,
      defaultBranch: null,
    }).profile
    const branch = await currentBranch(target)
    // Read the owner's declarations from this checkout too, so a refresh cannot replace a
    // declared plan in the bundle with the detected commands the runners will not use.
    const { config } = loadConfig({ repoRoot: target })
    const context = renderContextBundle({
      ticket,
      profile,
      branch: branch ?? 'HEAD',
      declared: config.project.commands,
      resources: recommendForProfile(profile, ticket),
    })
    const overlay = renderAgentsOverlay({ ticket, profile })
    mkdirSync(join(target, '.anvil'), { recursive: true })
    writeFileSync(join(target, context.path), context.content, 'utf8')
    writeFileSync(join(target, overlay.path), overlay.content, 'utf8')
    await excludeAnvilState(target)

    ctx.out({ schemaVersion: 1, ref, written: [context.path, overlay.path], injection: context.injection }, () => {
      const s = ctx.style
      const lines = [
        `${s.green('wrote')} ${context.path}`,
        `${s.green('wrote')} ${overlay.path}`,
        s.dim('The agent in this directory should read the context bundle first.'),
      ]
      if (context.injection.length > 0) {
        lines.push('')
        lines.push(
          s.yellow(
            `${context.injection.length} instruction-like line(s) in the ticket; they are quoted in the bundle as untrusted`,
          ),
        )
        for (const f of context.injection.slice(0, 5)) lines.push(`  ${f.field}:${f.line} (${f.kind}) '${f.excerpt}'`)
        if (context.injection.length > 5) lines.push(`  ... and ${context.injection.length - 5} more`)
      }
      return lines.join('\n')
    })
    return undefined
  },
}

function toList(value: unknown): string[] {
  if (Array.isArray(value)) return value.filter((v): v is string => typeof v === 'string')
  if (typeof value === 'string')
    return value
      .split(',')
      .map((s) => s.trim())
      .filter((s) => s !== '')
  return []
}

/** A normalized state from a flag, or a rejection naming the ones that exist. */
function stateArg(value: string): NormalizedState {
  const states: NormalizedState[] = ['todo', 'in_progress', 'in_review', 'done', 'wontfix']
  if ((states as string[]).includes(value)) return value as NormalizedState
  throw new AnvilError(ErrorCode.Usage, `Unknown ticket state: ${value}`, {
    hint: `Expected one of: ${states.join(', ')}.`,
  })
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
  usage: 'anvil auth [local|github|jira] [--check]',
  details: [
    'Checks the provider offline where possible, and never emits a bare "auth failed".',
    '',
    'For GitHub Enterprise -- the common case when you join a new company -- the check',
    'probes the *detected host* and returns the login command naming that host, so you do',
    'not authenticate to the wrong one. A failure here stops `ship` before anything is',
    'pushed.',
    '',
    'For Jira the check is entirely offline: it reports whether provider.jira.site and the',
    'JIRA_EMAIL / JIRA_API_TOKEN environment variables are set, without printing either',
    'value or contacting Atlassian.',
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
      const provider = new GitHubProvider({
        ...(host === null ? {} : { host }),
      })
      const status = await provider.authStatus()

      if (!status.ok) {
        const err = new AnvilError(ErrorCode.AuthFailed, `github provider: ${status.detail ?? 'unavailable'}`, {
          ...(status.remediation === undefined ? {} : { hint: status.remediation }),
        })
        ctx.outFailure(
          { schemaVersion: 1, provider: 'github', ok: false, host },
          err,
          () => `\n${ctx.style.red('error')} ${err.message}\n${err.hint === undefined ? '' : `hint  ${err.hint}\n`}`,
        )
        return err.exitCode
      }
      ctx.out(
        {
          schemaVersion: 1,
          provider: 'github',
          ok: true,
          host,
          identity: status.identity,
        },
        () =>
          `${ctx.style.green('ok')} github${host === null ? '' : ` (${host})`}: ${status.identity ?? 'authenticated'}`,
      )
      return undefined
    }

    if (which === 'jira') {
      const { JiraProvider } = await import('@anvil/providers')
      const mainRoot = await mainRootFor(ctx)
      const { config } = loadConfig({ repoRoot: mainRoot })
      const provider = new JiraProvider({
        site: config.provider.jira.site,
        project: config.provider.jira.project,
        issueType: config.provider.jira.issueType,
      })
      const status = await provider.authStatus()
      const data = {
        schemaVersion: 1,
        provider: 'jira',
        ok: status.ok,
        site: config.provider.jira.site,
        project: config.provider.jira.project,
      }

      if (!status.ok) {
        const err = new AnvilError(ErrorCode.AuthFailed, `jira provider: ${status.detail ?? 'unavailable'}`, {
          ...(status.remediation === undefined ? {} : { hint: status.remediation }),
        })
        ctx.outFailure(
          data,
          err,
          () => `\n${ctx.style.red('error')} ${err.message}\n${err.hint === undefined ? '' : `hint  ${err.hint}\n`}`,
        )
        return err.exitCode
      }

      ctx.out(data, () => {
        const site = config.provider.jira.site ?? '(unset)'
        const note = status.detail === undefined ? '' : ` ${ctx.style.dim(`(${status.detail})`)}`
        return `${ctx.style.green('ok')} jira (${site})${note}`
      })
      return undefined
    }

    if (which !== 'local') {
      throw new AnvilError(ErrorCode.Usage, `Unknown provider: ${which}`, {
        hint: `Expected one of: ${SUPPORTED_PROVIDERS.join(', ')}`,
      })
    }

    const mainRoot = await mainRootFor(ctx)
    const dir = ticketsDirFor(mainRoot)
    const provider = createTicketProvider('local', { ticketsDir: dir })
    const status = await provider.authStatus()

    if (!status.ok) {
      const err = new AnvilError(ErrorCode.AuthFailed, `local provider: ${status.detail ?? 'unavailable'}`, {
        ...(status.remediation === undefined ? {} : { hint: status.remediation }),
      })
      ctx.outFailure(
        { schemaVersion: 1, provider: 'local', ok: false },
        err,
        () => `\n${ctx.style.red('error')} ${err.message}\n${err.hint === undefined ? '' : `hint  ${err.hint}\n`}`,
      )
      return err.exitCode
    }

    ctx.out(
      {
        schemaVersion: 1,
        provider: 'local',
        ok: true,
        identity: status.identity,
        dir,
      },
      () => `${ctx.style.green('ok')} local provider: ${status.identity ?? dir}`,
    )
    return undefined
  },
}
