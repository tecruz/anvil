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
  // An empty store: every ticket this harness reads was created through the provider, so a
  // contract check cannot pass on state the test seeded out of band.
  const fake = fakeGh({})
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

    test('a transition back out of a state leaves that state behind', async () => {
      // A state is the whole state. Going to `in_progress` and back to `todo` must remove
      // the label, or a read reports the state the transition was supposed to leave.
      const { provider, seed } = make()
      const ref = await seed('Rework target', 'Body.')

      await provider.transition(ref, 'in_progress')
      assert.equal((await provider.fetch(ref)).normalizedState, 'in_progress')

      await provider.transition(ref, 'todo')
      assert.equal((await provider.fetch(ref)).normalizedState, 'todo')

      await provider.transition(ref, 'in_review')
      await provider.transition(ref, 'in_progress')
      assert.equal((await provider.fetch(ref)).normalizedState, 'in_progress')
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

    test('a listing excludes the tickets that moved on to another state', async () => {
      // `crew up` takes its work from `list({ state: 'todo' })`. A ticket already in
      // progress or in review is not ready work, and must not be claimed a second time.
      const { provider, seed } = make()
      const todo = await seed('Still to do', 'Body.')
      const progress = await seed('Already moving', 'Body.')
      const review = await seed('Already in review', 'Body.')
      await provider.transition(progress, 'in_progress')
      await provider.transition(review, 'in_review')

      const keys = ((await provider.list?.({ state: 'todo' })) ?? []).map((r) => r.key)
      assert.ok(keys.includes(todo.key), `expected ${todo.key} in ${keys.join(', ') || '(nothing)'}`)
      assert.ok(!keys.includes(progress.key), `${progress.key} is in progress`)
      assert.ok(!keys.includes(review.key), `${review.key} is in review`)
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

describe('the github provider where the fake is the only witness', () => {
  test('a failed listing is an error, not an empty backlog', async () => {
    // `crew up` and `issue list` treat an empty answer as "nothing to do". A 403 or a bad
    // repository must not be reported as a successful empty list.
    const fake = fakeGh({
      issue: { number: 1, title: 't' },
      listFailure: 'HTTP 403: resource not accessible by integration',
    })
    const provider = new GitHubProvider({ run: fake.run })
    await assert.rejects(() => provider.list({ state: 'todo' }), /403/)
  })

  test('a listing that is not a JSON array is an error, not an empty backlog', async () => {
    const provider = new GitHubProvider({
      run: async (): Promise<RunResult> => ({ stdout: 'not json', stderr: '', exitCode: 0 }),
    })
    await assert.rejects(() => provider.list({ state: 'todo' }), /not a list/)
  })

  test('a listing filters out the issues that are already in progress or in review', async () => {
    const fake = fakeGh({
      issue: { number: 1, title: 'todo one' },
      listIssues: [
        { number: 1, title: 'todo one' },
        { number: 2, title: 'moving', labels: [{ name: 'in-progress' }] },
        { number: 3, title: 'reviewing', labels: [{ name: 'In Review' }] },
        { number: 4, title: 'closed', state: 'CLOSED' },
      ],
    })
    const provider = new GitHubProvider({ run: fake.run })
    assert.deepEqual(
      (await provider.list({ state: 'todo' })).map((r) => r.id),
      ['1'],
    )
    // The label may be spelled differently in a real repository; the read and the listing
    // use the same matcher, so both see the same state.
    assert.deepEqual(
      (await provider.list({ state: 'in_review' })).map((r) => r.id),
      ['3'],
    )
  })

  test('a listing keeps looking past a page that is all filtered out', async () => {
    // `gh` has no cursor: a page can be entirely consumed by issues the caller did not ask
    // for, and the ready issue can sit just past it. A fixed over-fetch reported an empty
    // backlog in exactly this shape.
    const backlog = Array.from({ length: 120 }, (_, i) => ({
      number: i + 1,
      title: `already in review ${i + 1}`,
      state: 'OPEN' as const,
      labels: [{ name: 'in-review' }],
    }))
    backlog.push({ number: 121, title: 'ready', state: 'OPEN', labels: [] })

    const fake = fakeGh({ listIssues: backlog })
    const provider = new GitHubProvider({ run: fake.run })
    assert.deepEqual(
      (await provider.list({ state: 'todo' })).map((r) => r.id),
      ['121'],
    )
    const limits = fake.calls
      .filter((args) => args[1] === 'list')
      .map((args) => Number(args[args.indexOf('--limit') + 1]))
    assert.ok(limits.length >= 2, `expected a retry with a bigger page, saw ${limits.join(', ')}`)
    assert.ok((limits.at(-1) ?? 0) > (limits[0] ?? 0), `the retry must ask for more: ${limits.join(', ')}`)
  })

  test('a full page that satisfies the caller does not fetch again', async () => {
    const fake = fakeGh({
      listIssues: Array.from({ length: 10 }, (_, i) => ({ number: i + 1, title: `ready ${i + 1}` })),
    })
    const provider = new GitHubProvider({ run: fake.run })
    assert.equal((await provider.list({ state: 'todo', limit: 2 })).length, 2)
    assert.equal(fake.calls.filter((args) => args[1] === 'list').length, 1)
  })

  test('a label filter does not reject the case GitHub matched', async () => {
    // `--label bug` is matched case-insensitively by GitHub, so an issue labelled `Bug`
    // can come back. Re-checking it with an exact comparison discarded a valid answer.
    const fake = fakeGh({ listIssues: [{ number: 5, title: 'labelled', labels: [{ name: 'Bug' }] }] })
    const provider = new GitHubProvider({ run: fake.run })
    assert.deepEqual(
      (await provider.list({ label: 'bug' })).map((r) => r.id),
      ['5'],
    )
  })

  test('a repository literally named issues or pull parses to the issue number', async () => {
    // The issue marker used to be found from the start of the path, so
    // `acme/issues/issues/42` yielded the id `issues` and `gh issue view issues` failed.
    const fake = fakeGh({ issue: { number: 42, title: 't' } })
    const provider = new GitHubProvider({ run: fake.run })
    const ticket = await provider.fetch({
      provider: 'github',
      id: '42',
      key: 'gh-42',
      url: 'https://github.com/acme/issues/issues/42',
    })
    assert.equal(ticket.ref.id, '42')
    const view = fake.calls.find((args) => args[0] === 'issue' && args[1] === 'view')
    assert.ok(view !== undefined)
    assert.equal(view[2], '42')
    assert.equal(view[view.indexOf('--repo') + 1], 'github.com/acme/issues')
  })

  test('a ticket URL keeps its own repository', async () => {
    // Without `--repo`, gh resolves the number in the current directory. A pasted URL is
    // an explicit pointer at a different repository, and a comment must land there.
    const fake = fakeGh({ issue: { number: 42, title: 'elsewhere' } })
    const provider = new GitHubProvider({ run: fake.run })
    const ref = {
      provider: 'github',
      id: '42',
      key: 'gh-42',
      url: 'https://github.com/acme/other-repo/issues/42',
    }

    await provider.fetch(ref)
    await provider.comment(ref, 'hello')
    await provider.transition(ref, 'in_review')

    const target = 'github.com/acme/other-repo'
    for (const [name, args] of [
      ['view', fake.calls.find((a) => a[0] === 'issue' && a[1] === 'view')],
      ['comment', fake.calls.find((a) => a[0] === 'issue' && a[1] === 'comment')],
      ['edit', fake.calls.find((a) => a[0] === 'issue' && a[1] === 'edit')],
    ] as const) {
      assert.ok(args !== undefined, `issue ${name} was never called`)
      assert.equal(args[args.indexOf('--repo') + 1], target, `issue ${name} must name the URL's repository`)
    }
  })

  test('a bare number leaves the repository to gh', async () => {
    const fake = fakeGh({ issue: { number: 7, title: 'here' } })
    const provider = new GitHubProvider({ run: fake.run })
    await provider.fetch({ provider: 'github', id: '7', key: 'gh-7' })
    const view = fake.calls.find((args) => args[0] === 'issue' && args[1] === 'view')
    assert.ok(view !== undefined)
    assert.equal(view.includes('--repo'), false)
  })

  test('a URL that cannot name a repository is refused rather than re-aimed', async () => {
    const fake = fakeGh({ issue: { number: 7, title: 'here' } })
    const provider = new GitHubProvider({ run: fake.run })
    await assert.rejects(
      () => provider.fetch({ provider: 'github', id: '7', key: 'gh-7', url: 'not-a-url' }),
      /Cannot tell which repository/,
    )
    assert.deepEqual(fake.calls, [])
  })
})

runContract('local', localHarness)
runContract('github', githubHarness)
