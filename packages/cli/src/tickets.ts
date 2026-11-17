/**
 * Where the CLI resolves a ticket provider and the tickets directory.
 *
 * One module, so `issue`, `claim`, `crew up` and `ship` cannot answer either question
 * differently. `ticketsDirFor` is here for the same reason: `ANVIL_TICKETS_DIR` used to be
 * honoured by `issue` and `claim` but not by `ship`, and `crew up` joined it onto the
 * repository root even when it was an absolute path.
 */

import { join, resolve } from 'node:path'
import { type AnvilConfig, AnvilError, ErrorCode, loadConfig } from '@anvil/core'
import { git } from '@anvil/git'
import {
  createTicketProvider,
  DEFAULT_TICKETS_DIR,
  type GhOptions,
  hostFromRemote,
  type JiraOptions,
  type ProviderSource,
  refFor,
  resolveProviderId,
  type SupportedProviderId,
} from '@anvil/providers'
import type { AuthStatus, Ticket, TicketProvider, TicketRef } from '@anvil/tickets'
import { repositoryOf } from '@anvil/tickets'

/**
 * The directory local tickets live in, always resolved against the **main** worktree.
 *
 * `ANVIL_TICKETS_DIR` wins when it is set. An absolute value is used as-is; a relative
 * value is resolved against the main worktree rather than the invocation directory, so
 * claiming from the main checkout and shipping from a worktree use the same directory.
 */
export function ticketsDirFor(mainRoot: string, env: NodeJS.ProcessEnv = process.env): string {
  const configured = env.ANVIL_TICKETS_DIR
  if (configured !== undefined && configured !== '') return resolve(mainRoot, configured)
  return join(mainRoot, DEFAULT_TICKETS_DIR)
}

/** The GitHub host the repository's `origin` points at, or null when there is no remote. */
async function remoteHost(repoRoot: string): Promise<string | null> {
  const remote = await git(['remote', 'get-url', 'origin'], { cwd: repoRoot })
  return hostFromRemote(remote.exitCode === 0 ? remote.stdout.trim() : null)
}

export interface ProviderRequest {
  /** Raw reference the user typed, when the subcommand takes one. */
  ref?: string
  /** The `--provider` flag. */
  provider?: string | null
}

export interface ProviderOptions {
  /**
   * Injected for tests: a `gh` runner, and/or a host to skip the `git remote` probe.
   * Production passes neither, so the host comes from the repository and `gh` is real.
   */
  gh?: GhOptions
  /** Injected Jira transport and environment, so a test never reaches the network. */
  jira?: JiraOptions
  host?: string | null
  /** Injected resolved config, so a test does not read the developer's `~/.anvil`. */
  config?: AnvilConfig
  /** Environment for `ANVIL_TICKETS_DIR` and `GH_HOST`; production uses `process.env`. */
  env?: NodeJS.ProcessEnv
  /** `anvil issue --dir`: an explicit local tickets directory, overriding the default. */
  ticketsDir?: string
}

export interface CommandProvider {
  id: SupportedProviderId
  /** Why this provider was chosen: flag, config, the ref itself, or the built-in default. */
  source: ProviderSource
  provider: TicketProvider
  /** The parsed reference; absent for subcommands that do not take one (`create`, `list`). */
  ref?: TicketRef
}

/**
 * Resolve the provider for one command invocation.
 *
 * The ordering itself lives in `@anvil/providers` (`resolveProviderId`); this function only
 * supplies the inputs it needs -- the config layer and the tickets directory -- and adds
 * the GitHub host when GitHub is the selected provider. Selection happens before the host
 * probe, so a local-only command still spawns no process here.
 */
export async function ticketProviderFor(
  mainRoot: string,
  request: ProviderRequest = {},
  options: ProviderOptions = {},
): Promise<CommandProvider> {
  const env = options.env ?? process.env
  const config = options.config ?? loadConfig({ repoRoot: mainRoot }).config

  // The ticket URL's own host is where the issue lives, and therefore the host the auth
  // probe must name. It is also a candidate for recognising a GHE host the repository is
  // already known to use.
  const refUrlHost = repositoryOf(request.ref)?.host ?? null
  // A URL needs the known host *before* selection so a GHE link can name its provider. A
  // non-URL reference still probes only when GitHub ends up selected, so a local command
  // spawns nothing here.
  let knownHost: string | null = options.host !== undefined ? options.host : null
  if (options.host === undefined && refUrlHost !== null) knownHost = await remoteHost(mainRoot)

  const githubHosts = [knownHost, env.GH_HOST]
  const jiraSites = [config.provider.jira.site]
  const selection = resolveProviderId({
    configured: config.provider.default,
    ...(request.provider === undefined || request.provider === null ? {} : { explicit: request.provider }),
    ...(request.ref === undefined ? {} : { ref: request.ref }),
    githubHosts,
    jiraSites,
  })

  if (selection.id === 'github' && options.host === undefined && knownHost === null) {
    knownHost = await remoteHost(mainRoot)
  }

  const host =
    selection.id === 'github'
      ? (refUrlHost ?? knownHost ?? (env.GH_HOST === undefined || env.GH_HOST === '' ? null : env.GH_HOST))
      : null

  const provider = createTicketProvider(selection.id, {
    ticketsDir: options.ticketsDir ?? ticketsDirFor(mainRoot, env),
    host,
    ...(options.gh === undefined ? {} : { gh: options.gh }),
    jira: {
      site: config.provider.jira.site,
      project: config.provider.jira.project,
      issueType: config.provider.jira.issueType,
      env,
      ...(options.jira ?? {}),
    },
  })

  const ref = request.ref === undefined ? undefined : refFor(selection.id, request.ref, githubHosts, jiraSites)
  return { ...selection, provider, ...(ref === undefined ? {} : { ref }) }
}

/**
 * The error a failed provider auth check should surface.
 *
 * Split out so `list` and `read` report the same thing: a local install with no directory
 * gets "create the first ticket", and a GitHub provider that is not authenticated gets the
 * login command naming the host, which is the whole point of asking `gh` instead of a
 * token.
 */
export function providerUnavailable(resolved: CommandProvider, auth: AuthStatus): AnvilError {
  if (resolved.id === 'local') {
    return new AnvilError(ErrorCode.Usage, 'No ticket directory yet', {
      hint: `Create one with \`anvil issue create <title>\`, or set ANVIL_TICKETS_DIR. (${auth.detail ?? 'the directory does not exist'})`,
    })
  }
  return new AnvilError(
    ErrorCode.AuthFailed,
    `Cannot use the ${resolved.id} provider: ${auth.detail ?? 'unavailable'}`,
    {
      ...(auth.remediation === undefined ? {} : { hint: auth.remediation }),
    },
  )
}

/**
 * Read the ticket a resolved provider points at.
 *
 * The auth check runs first, because "not authenticated" has a remediation and a fetch
 * failure does not. `list` uses the same check through `providerUnavailable`, so an
 * unusable provider cannot quietly answer "no tickets".
 */
export async function readTicket(resolved: CommandProvider): Promise<Ticket> {
  if (resolved.ref === undefined) {
    throw new AnvilError(ErrorCode.Internal, 'No ticket reference was resolved', {
      hint: 'This is a bug in anvil: the command asked for a ticket without a reference.',
    })
  }

  const auth = await resolved.provider.authStatus()
  if (!auth.ok) throw providerUnavailable(resolved, auth)
  return resolved.provider.fetch(resolved.ref)
}

/** Resolve a provider and read one ticket through it. */
export async function fetchTicket(
  mainRoot: string,
  input: string,
  options: ProviderOptions & { provider?: string | null } = {},
): Promise<{ ticket: Ticket; resolved: CommandProvider }> {
  const resolved = await ticketProviderFor(mainRoot, { ref: input, provider: options.provider ?? null }, options)
  return { ticket: await readTicket(resolved), resolved }
}
