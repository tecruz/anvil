/**
 * The provider contract, run against every implementation.
 *
 * [ADR-0004](../../../docs/adr/0004-local-provider-as-egress-escape-hatch.md) is only
 * honest if `local` and `github` agree on the things the workflow depends on: the shape of
 * a ref, how a created ticket reads back, what a comment does, and which normalized state
 * a transition lands in. These tests are that promise, written once and run twice. A
 * behaviour only one provider has fails here rather than in a claim on a real repository.
 *
 * The GitHub half runs through `GhOptions.run` (see `fake-gh.ts`): no test invokes `gh` or
 * touches the network.
 */

import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, describe, test } from 'node:test'
import { GitHubProvider, LocalTicketProvider, type RunResult } from '@anvil/providers'
import type { TicketProvider, TicketRef } from '@anvil/tickets'
import { fakeGh } from './fake-gh.ts'

const temps: string[] = []
after(() => {
  for (const t of temps) rmSync(t, { recursive: true, force: true })
})

interface Harness {
  /** A provider that works, backed by a directory or a fake `gh`. */
  provider: TicketProvider
  /** A provider of the same kind that cannot be used (no directory, no auth). */
  unusable: TicketProvider
  /** Create a ticket through the provider, so nothing is pre-seeded out of band. */
  seed(title: string, body: string, labels?: string[]): Promise<TicketRef>
  /** The argv of every process call the provider made. Empty for the local provider. */
  calls: string[][]
}

function localHarness(): Harness {
  const dir = mkdtempSync(join(tmpdir(), 'anvil-contract-local-'))
  temps.push(dir)
  const provider = new LocalTicketProvider({ dir })
  return {
    provider,
    unusable: new LocalTicketProvider({ dir: join(dir, 'absent') }),
    seed: (title, body, labels = []) => provider.create({ title, body, labels }),
    calls: [],
  }
}

function githubHarness(): Harness {
  const fake = fakeGh({ issue: { number: 7, title: 'seeded', body: 'seeded body' } })
  const provider = new GitHubProvider({ run: fake.run })
  const unauth = fakeGh({ issue: { number: 7, title: 'seeded' }, authenticated: false })
  return {
    provider,
    unusable: new GitHubProvider({ run: unauth.run }),
    seed: (title, body, labels = []) => provider.create({ title, body, labels }),
    calls: fake.calls,
  }
}

const ALL_CAPABILITIES = ['create', 'comment', 'transition', 'link', 'list', 'rawBodies'] as const

const CHECKLIST_BODY = [
  'The redirect loses the return path.',
  '',
  '## Acceptance criteria',
  '',
  '- [ ] the return path survives the login redirect',
  '- [ ] a missing return path falls back to the dashboard',
].join('\n')

function runContract(name: string, make: () => Harness): void {
  describe(`the ${name} provider contract`, () => {
    test('advertises a complete capability set', async () => {
      const { provider } = make()
      for (const capability of ALL_CAPABILITIES) {
        assert.equal(
          typeof provider.capabilities[capability],
          'boolean',
          `${capability} must be a boolean, not inferred from a missing method`,
        )
      }
      assert.equal(provider.id.length > 0, true)
    })

    test('says whether it can be used, and an unusable provider does not claim it can', async () => {
      const { provider, unusable } = make()
      const ok = await provider.authStatus()
      assert.equal(ok.ok, true, ok.detail ?? 'a usable provider must report ok')

      const bad = await unusable.authStatus()
      assert.equal(bad.ok, false)
      assert.ok((bad.detail ?? '').length > 0, 'a failure must say what is wrong')
    })

    test('a created ticket reads back with its title, body and acceptance criteria', async () => {
      const { provider, seed } = make()
      const ref = await seed('Fix the login redirect', CHECKLIST_BODY)

      const ticket = await provider.fetch(ref)
      assert.equal(ticket.title, 'Fix the login redirect')
      assert.match(ticket.body ?? '', /loses the return path/)
      assert.deepEqual(ticket.acceptance, [
        'the return path survives the login redirect',
        'a missing return path falls back to the dashboard',
      ])
      assert.equal(ticket.ref.key, ref.key)
      assert.equal(ticket.normalizedState, 'todo')
    })

    test('a comment is visible on the ticket afterwards', async () => {
      const { provider, seed } = make()
      const ref = await seed('Comment target', 'Body.')
      await provider.comment(ref, 'Investigated: the redirect drops the query string.')

      const ticket = await provider.fetch(ref)
      const bodies = (ticket.comments ?? []).map((c) => c.body).join('\n')
      assert.match(bodies, /drops the query string/)
    })

    test('a transition to done is visible, and so is the transition back', async () => {
      const { provider, seed } = make()
      const ref = await seed('State target', 'Body.')

      await provider.transition(ref, 'done')
      assert.equal((await provider.fetch(ref)).normalizedState, 'done')

      await provider.transition(ref, 'todo')
      assert.equal((await provider.fetch(ref)).normalizedState, 'todo')
    })

    test('a transition to in_review is visible as in_review', async () => {
      const { provider, seed } = make()
      const ref = await seed('Review target', 'Body.')
      await provider.transition(ref, 'in_review')
      assert.equal((await provider.fetch(ref)).normalizedState, 'in_review')
    })

    test('a listing includes the ticket that is still in todo', async () => {
      const { provider, seed } = make()
      const ref = await seed('Listed ticket', 'Body.')
      const refs = (await provider.list?.({ state: 'todo' })) ?? []
      assert.ok(
        refs.some((r) => r.key === ref.key),
        `expected ${ref.key} in ${refs.map((r) => r.key).join(', ') || '(nothing)'}`,
      )
    })

    test('a link is recorded on the ticket', async () => {
      const { provider, seed } = make()
      const ref = await seed('Link target', 'Body.')
      const url = 'https://github.com/acme/widgets/pull/9'
      await provider.link(ref, url, 'pull request')

      const ticket = await provider.fetch(ref)
      const recorded = `${ticket.body ?? ''}\n${(ticket.comments ?? []).map((c) => `${c.body} ${c.url ?? ''}`).join('\n')}`
      assert.match(recorded, /pull\/9/)
    })

    test('a title and body carrying shell metacharacters arrive as data, unchanged', async () => {
      const { provider, seed } = make()
      const body = 'keep; rm -rf / #$(whoami) `id`'
      const ref = await seed('Fix; rm -rf / #$(whoami)', body)

      const ticket = await provider.fetch(ref)
      assert.equal(ticket.title, 'Fix; rm -rf / #$(whoami)')
      assert.match(ticket.body ?? '', /rm -rf \/ #\$\(whoami\) `id`/)
    })
  })
}

/** The argument-array guarantee, asserted on the GitHub transport's own argv. */
describe('the github provider never builds a shell string', () => {
  test('a body of shell metacharacters is one argv element, not a command', async () => {
    const fake = fakeGh({ issue: { number: 1, title: 'seeded' } })
    const provider = new GitHubProvider({ run: fake.run })
    const body = 'x; rm -rf / #$(whoami)'
    await provider.create({ title: 'danger; echo pwned', body })

    const create = fake.calls.find((args) => args[0] === 'issue' && args[1] === 'create')
    assert.ok(create !== undefined, 'issue create was never called')
    assert.equal(create[create.indexOf('--body') + 1], body)
    assert.equal(create[create.indexOf('--title') + 1], 'danger; echo pwned')
    for (const element of create) assert.equal(typeof element, 'string')
  })

  test('a failed gh call is reported, not swallowed', async () => {
    const provider = new GitHubProvider({
      run: async (): Promise<RunResult> => ({ stdout: '', stderr: 'boom', exitCode: 1 }),
    })
    await assert.rejects(() => provider.fetch({ provider: 'github', id: '1', key: 'gh-1' }), /boom/)
  })
})

runContract('local', localHarness)
runContract('github', githubHarness)
