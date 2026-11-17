/**
 * One place decides which ticket provider a command uses.
 *
 * Every work-entry command -- `issue`, `claim`, `crew up`, `ship` -- used to construct a
 * provider itself, and every one of them constructed `local`. The result was a dead
 * `provider.default` knob in the configuration and no way to run a GitHub issue through
 * the workflow. The rule below is the whole fix, and it lives here so the commands cannot
 * drift from each other again:
 *
 *   1. an explicit `--provider` flag,
 *   2. `provider.default` from the resolved configuration,
 *   3. the reference's own provider (a URL, or a `gh-42` key),
 *   4. `local`.
 *
 * The last step is not a fallback of last resort: `local` is the documented default and
 * the escape hatch for a machine with no account, no network and no `gh`
 * ([ADR-0004](../../../docs/adr/0004-local-provider-as-egress-escape-hatch.md)). Resolution
 * does no I/O, so it is safe to call from a command that is otherwise offline.
 */

import { AnvilError, ErrorCode } from '@anvil/core'
import {
  type ProviderCapabilities,
  type ProviderId,
  parseRef,
  providerHintFor,
  type TicketProvider,
  type TicketRef,
} from '@anvil/tickets'
import { type GhOptions, GitHubProvider } from './github.ts'
import { type JiraOptions, JiraProvider } from './jira.ts'
import { LocalTicketProvider } from './local.ts'

/** Providers a command can be pointed at today. `local` first: it is the default. */
export const SUPPORTED_PROVIDERS = ['local', 'github', 'jira'] as const
export type SupportedProviderId = (typeof SUPPORTED_PROVIDERS)[number]

/** Why this provider was chosen, for the payload and for error messages. */
export type ProviderSource = 'flag' | 'config' | 'ref' | 'default'

export interface ProviderSelection {
  /** Raw reference as typed by the user, when there is one. */
  ref?: string
  /** The `--provider` flag, when given. */
  explicit?: string | null
  /** `provider.default` from the configuration; `null` means "infer it". */
  configured?: string | null
  /**
   * GitHub hosts already known to the caller, such as the `origin` host and `GH_HOST`.
   * Passed in rather than probed here: resolution stays pure and offline, and a URL on an
   * unknown host is not guessed to be GitHub.
   */
  githubHosts?: readonly (string | null | undefined)[]
  /**
   * Configured Jira sites. A `browse` URL on one of these hosts is inferred as Jira without
   * having to pass `--provider jira`; the parser still stays offline.
   */
  jiraSites?: readonly (string | null | undefined)[]
}

export interface ProviderSelectionResult {
  id: SupportedProviderId
  source: ProviderSource
}

export interface CreateProviderOptions {
  /** Absolute directory holding local markdown tickets. */
  ticketsDir: string
  /** GitHub host detected from the remote, when it is a GitHub remote. */
  host?: string | null
  /** Injected `gh` runner, so a test never shells out. */
  gh?: GhOptions
  /** Jira site, project and injected transport. */
  jira?: JiraOptions
}

export function isSupportedProvider(value: string): value is SupportedProviderId {
  return (SUPPORTED_PROVIDERS as readonly string[]).includes(value)
}

/**
 * Reject a provider anvil does not implement, naming the ones it does.
 *
 * A generic "unknown provider" sends the reader to the docs; this sentence answers the
 * question. `gitlab` is the interesting case: a GitLab URL is recognised as a reference
 * shape (so the message can be specific) but no transport exists for it.
 */
export function assertSupportedProvider(value: string, origin: string): SupportedProviderId {
  const id = value.trim().toLowerCase()
  if (isSupportedProvider(id)) return id
  throw new AnvilError(ErrorCode.Usage, `Unsupported ticket provider: ${value.trim() || '(empty)'}`, {
    hint: `${origin}. Supported providers: ${SUPPORTED_PROVIDERS.join(', ')}.`,
    details: { requested: value, supported: [...SUPPORTED_PROVIDERS] },
  })
}

/** Apply the selection rule. Pure: no provider is constructed and no I/O happens. */
export function resolveProviderId(selection: ProviderSelection): ProviderSelectionResult {
  const flag = selection.explicit?.trim()
  if (flag !== undefined && flag !== '') {
    return { id: assertSupportedProvider(flag, '`--provider` must name a supported provider'), source: 'flag' }
  }

  const configured = selection.configured?.trim()
  if (configured !== undefined && configured !== '') {
    return {
      id: assertSupportedProvider(configured, '`provider.default` must name a supported provider'),
      source: 'config',
    }
  }

  const hint =
    selection.ref === undefined ? null : providerHintFor(selection.ref, selection.githubHosts, selection.jiraSites)
  if (hint !== null) {
    return { id: assertSupportedProvider(hint, `The reference "${selection.ref}" names a provider`), source: 'ref' }
  }

  return { id: 'local', source: 'default' }
}

/** Build the provider a selection names. The only construction site. */
export function createTicketProvider(id: SupportedProviderId, options: CreateProviderOptions): TicketProvider {
  if (id === 'github') {
    const gh: GhOptions = { ...(options.gh ?? {}) }
    if (options.host !== null && options.host !== undefined && options.host !== '') gh.host = options.host
    return new GitHubProvider(gh)
  }
  if (id === 'jira') return new JiraProvider(options.jira ?? {})
  return new LocalTicketProvider({ dir: options.ticketsDir })
}

/**
 * Parse a reference against a selected provider.
 *
 * The selection wins: once a caller has decided on a provider -- by flag or by config --
 * the ref is read with that provider, even when the text looks like another forge's. The
 * `key` and `url` still come from the text, so a claim remains recognisable, but the
 * provider field is the one that will actually be used. That keeps the claim registry and
 * `ship` honest about which tracker the ticket came from.
 */
export function refFor(
  provider: ProviderId,
  input: string,
  githubHosts?: readonly (string | null | undefined)[],
  jiraSites?: readonly (string | null | undefined)[],
): TicketRef {
  return { ...parseRef(input, provider, githubHosts, jiraSites), provider }
}

/** The capabilities a provider actually has, for an error message that lists them. */
export function capabilitiesOf(provider: TicketProvider): string[] {
  const capabilities = provider.capabilities
  return (Object.keys(capabilities) as Array<keyof ProviderCapabilities>).filter((key) => {
    if (key === 'list') return capabilities.list === true && typeof provider.list === 'function'
    return capabilities[key] === true
  })
}

/**
 * Refuse an operation the provider cannot do, naming the missing capability.
 *
 * Without this, a GitHub-backed `issue create` on a provider without `create` would fail
 * somewhere deep in the transport with a message about an argument list, and the reader
 * would go looking for a bug that is not there. The capability list is part of the
 * provider contract ([`ProviderCapabilities`](../../tickets/src/index.ts)), so this reads
 * the contract rather than guessing from the method.
 */
export function requireCapability(
  provider: TicketProvider,
  capability: keyof ProviderCapabilities,
  action: string,
): void {
  const has =
    capability === 'list'
      ? provider.capabilities.list === true && typeof provider.list === 'function'
      : provider.capabilities[capability] === true
  if (has) return

  const supported = capabilitiesOf(provider)
  throw new AnvilError(
    ErrorCode.Usage,
    `The ${provider.id} provider cannot ${action}: missing the "${capability}" capability`,
    {
      hint:
        supported.length === 0
          ? `No provider operation is available through ${provider.id}.`
          : `${provider.id} supports: ${supported.join(', ')}.`,
      details: { provider: provider.id, missing: capability, supported },
    },
  )
}
