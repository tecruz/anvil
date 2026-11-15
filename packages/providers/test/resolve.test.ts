/**
 * The provider selection rule, and the capability failures that go with it.
 *
 * The ordering is the whole feature: `--provider`, then `provider.default`, then whatever
 * the reference names, then `local`. These tests pin the order rather than the outcome, so
 * a later refactor cannot quietly make the config knob inert again.
 */

import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import {
  assertSupportedProvider,
  capabilitiesOf,
  createTicketProvider,
  GitHubProvider,
  LocalTicketProvider,
  refFor,
  requireCapability,
  resolveProviderId,
  SUPPORTED_PROVIDERS,
} from '@anvil/providers'
import type { ProviderCapabilities, TicketProvider, TicketRef } from '@anvil/tickets'
import { fakeGh } from './fake-gh.ts'

const GITHUB_URL = 'https://github.com/acme/widgets/issues/42'
const GITLAB_URL = 'https://gitlab.com/acme/widgets/-/issues/7'

describe('the provider selection rule', () => {
  test('an explicit --provider wins over everything', () => {
    const chosen = resolveProviderId({ explicit: 'github', configured: 'local', ref: 'local-3' })
    assert.deepEqual(chosen, { id: 'github', source: 'flag' })
  })

  test('provider.default is honoured when there is no flag', () => {
    const chosen = resolveProviderId({ configured: 'github', ref: 'local-3' })
    assert.deepEqual(chosen, { id: 'github', source: 'config' })
  })

  test('a reference names its own provider when the config is silent', () => {
    assert.deepEqual(resolveProviderId({ configured: null, ref: 'gh-42' }), { id: 'github', source: 'ref' })
    assert.deepEqual(resolveProviderId({ configured: null, ref: GITHUB_URL }), { id: 'github', source: 'ref' })
  })

  test('local is the default when nothing else decides', () => {
    assert.deepEqual(resolveProviderId({ configured: null, ref: '3' }), { id: 'local', source: 'default' })
    assert.deepEqual(resolveProviderId({ configured: null, ref: 'PROJ-123' }), { id: 'local', source: 'default' })
    assert.deepEqual(resolveProviderId({ configured: null }), { id: 'local', source: 'default' })
  })

  test('an empty string is absence, not a provider name', () => {
    assert.deepEqual(resolveProviderId({ explicit: '', configured: 'local' }), { id: 'local', source: 'config' })
    assert.deepEqual(resolveProviderId({ explicit: '  ', configured: null, ref: 'gh-1' }), {
      id: 'github',
      source: 'ref',
    })
  })

  test('an unknown provider is rejected with the list of supported ones', () => {
    assert.throws(
      () => resolveProviderId({ explicit: 'jira' }),
      (err: Error) => {
        const hint = (err as { hint?: string }).hint ?? ''
        return /Unsupported ticket provider: jira/.test(err.message) && /local, github/.test(hint)
      },
    )
    assert.throws(
      () => assertSupportedProvider('jira', '`provider.default`'),
      (err: Error) => /Supported providers: local, github/.test((err as { hint?: string }).hint ?? ''),
    )
  })

  test('a GitLab URL is recognised as a reference shape that has no transport', () => {
    // The reference names a provider, so the message is about that provider rather than a
    // generic parse failure -- and it lists what would work instead.
    assert.throws(() => resolveProviderId({ ref: GITLAB_URL }), /Unsupported ticket provider: gitlab/)
    assert.deepEqual(SUPPORTED_PROVIDERS, ['local', 'github'])
  })

  test('the parsed reference uses the selected provider', () => {
    assert.deepEqual(refFor('github', '42'), { provider: 'github', id: '42', key: 'gh-42' })
    assert.deepEqual(refFor('local', '42'), { provider: 'local', id: '42', key: 'local-42' })
    // A selection is a decision: even a URL is read with it, and the URL is kept so the
    // claim still points at where the ticket came from.
    const selected = refFor('local', GITHUB_URL)
    assert.equal(selected.provider, 'local')
    assert.equal(selected.url, GITHUB_URL)
    assert.equal(selected.key, 'gh-42')
  })
})

describe('provider construction', () => {
  test('local is built around the tickets directory it is given', async () => {
    const provider = createTicketProvider('local', { ticketsDir: '/tmp/anvil-tickets' })
    assert.ok(provider instanceof LocalTicketProvider)
    const status = await provider.authStatus()
    assert.equal(status.ok, false)
    assert.match(status.detail ?? '', /\/tmp\/anvil-tickets/)
  })

  test('github is built with the detected host and the injected runner', async () => {
    const calls: string[][] = []
    const provider = createTicketProvider('github', {
      ticketsDir: '/tmp/unused',
      host: 'ghe.acme-corp.com',
      gh: {
        run: async (args) => {
          calls.push(args)
          return { stdout: 'github.com\n Logged in to github.com account octocat\n', stderr: '', exitCode: 0 }
        },
      },
    })
    assert.ok(provider instanceof GitHubProvider)
    await provider.authStatus()
    assert.deepEqual(calls[0], ['auth', 'status', '--hostname', 'ghe.acme-corp.com'])
  })

  test('no host means gh resolves the repository itself', async () => {
    const calls: string[][] = []
    const provider = createTicketProvider('github', {
      ticketsDir: '/tmp/unused',
      gh: {
        run: async (args) => {
          calls.push(args)
          return { stdout: 'Logged in to github.com account octocat\n', stderr: '', exitCode: 0 }
        },
      },
    })
    await provider.authStatus()
    assert.deepEqual(calls[0], ['auth', 'status'])
  })
})

describe('capability-aware failure', () => {
  function stub(capabilities: Partial<ProviderCapabilities>): TicketProvider {
    return {
      id: 'stub',
      capabilities: {
        create: true,
        comment: true,
        transition: true,
        link: true,
        list: true,
        rawBodies: false,
        ...capabilities,
      },
      authStatus: async () => ({ ok: true }),
      fetch: async (ref: TicketRef) => ({ ref, title: 't', normalizedState: 'todo' as const }),
      list: async () => [],
      create: async () => ({ provider: 'stub', id: '1', key: 'stub-1' }),
      comment: async () => undefined,
      transitions: async () => [],
      transition: async () => undefined,
      link: async () => undefined,
    }
  }

  test('an unsupported operation fails naming the capability, not the method', () => {
    assert.throws(
      () => requireCapability(stub({ create: false }), 'create', 'create a ticket'),
      (err: Error) =>
        /The stub provider cannot create a ticket/.test(err.message) && /"create" capability/.test(err.message),
    )
  })

  test('a provider with no list method is treated as missing the list capability', () => {
    const withoutList = stub({})
    delete (withoutList as { list?: unknown }).list
    assert.throws(() => requireCapability(withoutList, 'list', 'list tickets'), /"list" capability/)
  })

  test('a supported operation passes, and the supported set is reported', () => {
    requireCapability(stub({}), 'comment', 'comment on a ticket')
    assert.deepEqual(capabilitiesOf(stub({ create: false })), ['comment', 'transition', 'link', 'list'])
  })

  test('the error carries the missing capability and the supported list', () => {
    try {
      requireCapability(stub({ transition: false }), 'transition', 'move a ticket')
      assert.fail('expected a failure')
    } catch (err) {
      const details = (err as { details?: { missing?: string; supported?: string[] } }).details
      assert.equal(details?.missing, 'transition')
      assert.deepEqual(details?.supported, ['create', 'comment', 'link', 'list'])
      assert.match(String((err as { hint?: string }).hint), /supports: create, comment, link, list/)
    }
  })
})

describe('the gh runner is never invoked for a selection that does not need it', () => {
  test('resolving a local selection builds no GitHub provider', () => {
    const calls: string[][] = []
    const provider = createTicketProvider('local', {
      ticketsDir: '/tmp/anvil-contract',
      gh: {
        run: async (args) => {
          calls.push(args)
          return { stdout: '', stderr: '', exitCode: 0 }
        },
      },
    })
    assert.equal(provider.id, 'local')
    assert.deepEqual(calls, [])
  })

  test('the fake runner is the only transport the GitHub tests use', async () => {
    const fake = fakeGh({ issue: { number: 3, title: 't', body: 'b' } })
    const provider = createTicketProvider('github', { ticketsDir: '/tmp/unused', gh: { run: fake.run } })
    const ticket = await provider.fetch({ provider: 'github', id: '3', key: 'gh-3' })
    assert.equal(ticket.title, 't')
    assert.ok(fake.calls.length > 0)
  })
})
