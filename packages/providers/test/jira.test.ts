/**
 * The Jira provider, against an in-memory Jira Cloud API.
 *
 * No test touches the network: every request goes through `JiraOptions.request` (see
 * `fake-jira.ts`). The cases here are the ones that decide whether the provider is safe to
 * point at a real site: credentials are only ever named, never printed; an invalid issue
 * key never becomes a URL; ADF is converted rather than guessed; a workflow with no matching
 * transition is refused instead of silently doing nothing; and `wontfix` needs a resolution,
 * not just a done status.
 */

import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { AnvilError } from '@anvil/core'
import type { AdfDoc } from '@anvil/providers'
import {
  adfToMarkdown,
  type JiraOptions,
  JiraProvider,
  jiraIssueKey,
  markdownToAdf,
  normalizeJiraSite,
} from '@anvil/providers'
import { type FakeJiraOptions, fakeJira } from './fake-jira.ts'

const CHECKLIST = [
  'The redirect loses the return path.',
  '',
  '## Acceptance criteria',
  '',
  '- [ ] the return path survives the login redirect',
  '- [ ] a missing return path falls back to the dashboard',
].join('\n')

function makeJira(options: FakeJiraOptions = {}, extra: Partial<JiraOptions> = {}) {
  const fake = fakeJira(options)
  const provider = new JiraProvider({
    site: fake.site,
    project: fake.project,
    env: fake.env,
    request: fake.request,
    ...extra,
  })
  return { fake, provider }
}

const TODO = { provider: 'jira', id: 'PROJ-1', key: 'PROJ-1' }

/**
 * A provider whose workflow exposes exactly one transition, for resolution edge cases.
 *
 * The general fake models a realistic board; these tests need a board with *only* a
 * rejection resolution, or with both a rejection and a normal one, and writing a second
 * fake for that would bury the point. POST bodies are collected so a test can assert which
 * resolution anvil actually sent.
 */
function transitionOnlyProvider(transition: unknown, bodies: string[] = []): JiraProvider {
  return new JiraProvider({
    site: 'https://acme.atlassian.net',
    project: 'PROJ',
    env: { JIRA_EMAIL: 'dev@example.com', JIRA_API_TOKEN: 'fake-token-not-real' },
    request: async (request) => {
      const path = new URL(request.url).pathname
      if (request.method === 'GET' && path.endsWith('/transitions')) {
        return { status: 200, body: JSON.stringify({ transitions: [transition] }) }
      }
      if (request.body !== undefined) bodies.push(request.body)
      return { status: 204, body: '' }
    },
  })
}

describe('the jira auth check is offline', () => {
  test('a configured site and both variables are usable, with no request', async () => {
    const { fake, provider } = makeJira()
    const status = await provider.authStatus()
    assert.equal(status.ok, true)
    assert.equal(status.identity, undefined, 'the account email is a credential and is not reported')
    assert.match(status.detail ?? '', /https:\/\/acme\.atlassian\.net/)
    assert.doesNotMatch(JSON.stringify(status), /dev@example\.com|fake-token/)
    assert.deepEqual(fake.calls, [], 'authStatus must not touch the network')
  })

  test('a missing site names provider.jira.site, not a network failure', async () => {
    const { fake, provider } = makeJira({}, { site: null })
    const status = await provider.authStatus()
    assert.equal(status.ok, false)
    assert.match(status.detail ?? '', /provider\.jira\.site/)
    assert.match(status.remediation ?? '', /anvil\.config\.json/)
    assert.deepEqual(fake.calls, [])
  })

  test('missing credentials name the variables and never a value', async () => {
    const { provider } = makeJira({}, { env: { JIRA_EMAIL: 'dev@example.com' } })
    const status = await provider.authStatus()
    assert.equal(status.ok, false)
    assert.match(status.detail ?? '', /JIRA_API_TOKEN/)
    assert.doesNotMatch(status.detail ?? '', /fake-token/)
    assert.match(status.remediation ?? '', /JIRA_EMAIL and JIRA_API_TOKEN/)
  })

  test('a missing project is a note, not a failure: claim PROJ-123 needs none', async () => {
    const { provider } = makeJira({}, { project: null })
    const status = await provider.authStatus()
    assert.equal(status.ok, true)
    assert.match(status.detail ?? '', /provider\.jira\.project is not set/)
  })

  test('the provider exposes no credential field of its own', () => {
    const { provider } = makeJira()
    const fields = provider as unknown as Record<string, unknown>
    assert.equal('token' in fields, false)
    assert.equal('password' in fields, false)
    assert.equal(JSON.stringify(fields.capabilities).includes('fake-token'), false)
  })
})

describe('reading a Jira issue', () => {
  test('converts ADF to markdown and keeps the raw payload', async () => {
    const { fake, provider } = makeJira({
      issues: [
        {
          key: 'PROJ-1',
          summary: 'Fix the login redirect',
          description: markdownToAdf(CHECKLIST),
          status: 'In Progress',
          labels: ['bug', 'auth'],
          comments: [
            {
              author: 'Ada',
              body: markdownToAdf('Found the query string drop.'),
              created: '2026-11-17T10:00:00.000+0000',
            },
          ],
        },
      ],
    })

    const ticket = await provider.fetch(TODO)
    assert.equal(ticket.title, 'Fix the login redirect')
    assert.match(ticket.body ?? '', /loses the return path/)
    assert.deepEqual(ticket.acceptance, [
      'the return path survives the login redirect',
      'a missing return path falls back to the dashboard',
    ])
    assert.equal(ticket.normalizedState, 'in_progress')
    assert.equal(ticket.state, 'In Progress')
    assert.equal(ticket.type, 'Task')
    assert.deepEqual(ticket.labels, ['bug', 'auth'])
    assert.equal(ticket.ref.key, 'PROJ-1')
    assert.equal(ticket.ref.url, `${fake.site}/browse/PROJ-1`)
    assert.equal(ticket.comments?.[0]?.author, 'Ada')
    assert.match(ticket.comments?.[0]?.body ?? '', /query string drop/)
    assert.equal((ticket.raw as { key?: string }).key, 'PROJ-1')
    // The token is in the request header by necessity, and nowhere in the ticket.
    assert.equal(JSON.stringify(ticket).includes('fake-token'), false)
  })

  test('a done status with a rejection resolution is wontfix', async () => {
    const { provider } = makeJira({
      issues: [{ key: 'PROJ-1', summary: 'Old idea', status: 'Done', resolution: "Won't Do" }],
    })
    assert.equal((await provider.fetch(TODO)).normalizedState, 'wontfix')
  })

  test('an invalid issue key is refused before any request', async () => {
    const { fake, provider } = makeJira()
    for (const ref of [
      { provider: 'jira', id: '--help', key: '--help' },
      { provider: 'jira', id: 'PROJ', key: 'PROJ' },
      { provider: 'jira', id: '../PROJ-1', key: '../PROJ-1' },
    ]) {
      await assert.rejects(() => provider.fetch(ref), /Invalid Jira issue key/)
    }
    assert.deepEqual(fake.calls, [])
  })

  test('a browse URL supplies the key when the ref id does not', async () => {
    const { provider } = makeJira({ issues: [{ key: 'PROJ-1', summary: 'From URL' }] })
    const ticket = await provider.fetch({
      provider: 'jira',
      id: '',
      key: '',
      url: 'https://acme.atlassian.net/browse/PROJ-1',
    })
    assert.equal(ticket.ref.key, 'PROJ-1')
  })
})

describe('creating and commenting', () => {
  test('create sends ADF, the project and the issue type, then reads back', async () => {
    const { fake, provider } = makeJira({}, { issueType: 'Bug' })
    const ref = await provider.create({ title: 'Fix the redirect', body: CHECKLIST, labels: ['bug'] })
    assert.equal(ref.key, 'PROJ-1')

    const create = fake.calls.find((call) => call.method === 'POST' && call.url.endsWith('/rest/api/3/issue'))
    assert.ok(create !== undefined)
    const payload = JSON.parse(create.body ?? '{}') as {
      fields: { project: { key: string }; issuetype: { name: string }; labels: string[]; description: AdfDoc }
    }
    assert.deepEqual(payload.fields.project, { key: 'PROJ' })
    assert.deepEqual(payload.fields.issuetype, { name: 'Bug' })
    assert.deepEqual(payload.fields.labels, ['bug'])
    assert.equal(payload.fields.description.type, 'doc')

    const ticket = await provider.fetch(ref)
    assert.equal(ticket.title, 'Fix the redirect')
    assert.deepEqual(ticket.acceptance, [
      'the return path survives the login redirect',
      'a missing return path falls back to the dashboard',
    ])
  })

  test('create without a project fails before the request', async () => {
    const { fake, provider } = makeJira({}, { project: null })
    await assert.rejects(() => provider.create({ title: 'No project' }), /provider\.jira\.project/)
    assert.deepEqual(fake.calls, [])
  })

  test('an invalid project key is refused rather than interpolated', async () => {
    const { fake, provider } = makeJira({}, { project: 'PROJ" OR project = "OTHER' })
    await assert.rejects(() => provider.create({ title: 'Injection' }), /Invalid Jira project key/)
    assert.deepEqual(fake.calls, [])
  })

  test('a comment carries the markdown body as ADF', async () => {
    const { provider } = makeJira({ issues: [{ key: 'PROJ-1', summary: 'Comment target' }] })
    await provider.comment(TODO, '- [ ] a checked criterion')
    const ticket = await provider.fetch(TODO)
    assert.equal(ticket.comments?.length, 1)
    assert.match(ticket.comments?.[0]?.body ?? '', /\[ \] a checked criterion/)
  })

  test('a link is recorded as a comment, and its URL survives', async () => {
    const { provider } = makeJira({ issues: [{ key: 'PROJ-1', summary: 'Link target' }] })
    await provider.link(TODO, 'https://github.com/acme/widgets/pull/9', 'pull request')
    const ticket = await provider.fetch(TODO)
    assert.match(ticket.comments?.[0]?.body ?? '', /pull request: https:\/\/github\.com\/acme\/widgets\/pull\/9/)
  })
})

describe('listing issues', () => {
  test('filters by normalized state rather than trusting the status category alone', async () => {
    const { provider } = makeJira({
      issues: [
        { key: 'PROJ-1', summary: 'todo' },
        { key: 'PROJ-2', summary: 'moving', status: 'In Progress' },
        { key: 'PROJ-3', summary: 'reviewing', status: 'In Review' },
        { key: 'PROJ-4', summary: 'done', status: 'Done', resolution: 'Fixed' },
      ],
    })
    assert.deepEqual(
      (await provider.list({ state: 'todo' })).map((ref) => ref.key),
      ['PROJ-1'],
    )
    assert.deepEqual(
      (await provider.list({ state: 'in_review' })).map((ref) => ref.key),
      ['PROJ-3'],
    )
    assert.deepEqual(
      (await provider.list({ state: 'wontfix' })).map((ref) => ref.key),
      [],
    )
  })

  test('follows nextPageToken instead of stopping at one page', async () => {
    const { fake, provider } = makeJira({
      pageSize: 2,
      issues: [
        { key: 'PROJ-1', summary: 'one' },
        { key: 'PROJ-2', summary: 'two' },
        { key: 'PROJ-3', summary: 'three' },
      ],
    })
    const refs = await provider.list({ state: 'todo', limit: 3 })
    assert.deepEqual(
      refs.map((ref) => ref.key),
      ['PROJ-1', 'PROJ-2', 'PROJ-3'],
    )
    const searches = fake.calls.filter((call) => call.url.endsWith('/search/jql'))
    assert.equal(searches.length, 2)
    const second = JSON.parse(searches[1]?.body ?? '{}') as { nextPageToken?: string }
    assert.equal(second.nextPageToken, '2')
  })

  test('a page cap without a match is an explicit incomplete listing', async () => {
    // A little over the cap: enough pages that the guard trips, none of them matching.
    const issues = Array.from({ length: 25 }, (_, index) => ({
      key: `PROJ-${String(index + 1)}`,
      summary: `already in review ${String(index + 1)}`,
      status: 'In Review',
    }))
    const { provider } = makeJira({ issues, pageSize: 1 })
    await assert.rejects(() => provider.list({ state: 'todo', limit: 1 }), /more issues than anvil can page through/)
  })

  test('a label filter is applied to the answer, not only to JQL', async () => {
    const { provider } = makeJira({
      issues: [
        { key: 'PROJ-1', summary: 'labelled', labels: ['bug'] },
        { key: 'PROJ-2', summary: 'other', labels: ['chore'] },
      ],
    })
    assert.deepEqual(
      (await provider.list({ state: 'todo', label: 'BUG' })).map((ref) => ref.key),
      ['PROJ-1'],
    )
  })

  test('listing without a project fails before the request', async () => {
    const { fake, provider } = makeJira({}, { project: null })
    await assert.rejects(() => provider.list({ state: 'todo' }), /provider\.jira\.project/)
    assert.deepEqual(fake.calls, [])
  })
})

describe('workflow transitions', () => {
  test('available transitions are mapped to normalized states', async () => {
    const { provider } = makeJira({ issues: [{ key: 'PROJ-1', summary: 'Todo' }] })
    const transitions = await provider.transitions(TODO)
    const targets = transitions.map((transition) => transition.to)
    assert.ok(targets.includes('in_progress'))
    assert.ok(targets.includes('in_review'))
    assert.ok(targets.includes('done'))
    assert.ok(targets.includes('wontfix'))
    assert.equal(transitions.find((transition) => transition.to === 'in_progress')?.name, 'Start')
  })

  test('done sends the resolution the workflow allows', async () => {
    const { fake, provider } = makeJira({ issues: [{ key: 'PROJ-1', summary: 'Close me' }] })
    await provider.transition(TODO, 'done')
    const ticket = await provider.fetch(TODO)
    assert.equal(ticket.normalizedState, 'done')

    const move = fake.calls.find((call) => call.method === 'POST' && call.url.endsWith('/transitions'))
    const payload = JSON.parse(move?.body ?? '{}') as { transition: { id: string }; resolution?: { id: string } }
    assert.equal(payload.transition.id, '13')
    assert.deepEqual(payload.resolution, { id: '1' })
  })

  test('wontfix needs a resolution that says so, not a status name', async () => {
    const { fake, provider } = makeJira({
      issues: [{ key: 'PROJ-1', summary: 'Not this', status: 'In Progress' }],
    })
    await provider.transition(TODO, 'wontfix')
    assert.equal((await provider.fetch(TODO)).normalizedState, 'wontfix')
    const move = fake.calls.find((call) => call.method === 'POST' && call.url.endsWith('/transitions'))
    assert.match(move?.body ?? '', /"resolution":\{"id":"2"\}/)
  })

  test('a state the workflow cannot reach is refused with what is available', async () => {
    const { provider } = makeJira({
      issues: [{ key: 'PROJ-1', summary: 'Closed', status: 'Done', resolution: 'Fixed' }],
    })
    await assert.rejects(
      () => provider.transition(TODO, 'in_review'),
      (err: Error) => {
        assert.ok(err instanceof AnvilError)
        return (
          /no transition from PROJ-1 to "in_review"/.test(err.message) &&
          /Reopen -> To Do/.test((err as { hint?: string }).hint ?? '')
        )
      },
    )
  })

  test('a done status reachable only through a rejection is wontfix, not done', async () => {
    // Teams do configure one "closed" target whose only resolution is a rejection. Calling
    // that `done` would report a successful completion for work that was explicitly refused.
    const provider = transitionOnlyProvider({
      id: '14',
      name: "Won't Do",
      to: { name: 'Done', statusCategory: { key: 'done' } },
      fields: {
        resolution: { required: true, allowedValues: [{ id: '2', name: "Won't Do" }] },
      },
    })
    assert.deepEqual(
      (await provider.transitions(TODO)).map((transition) => transition.to),
      ['wontfix'],
    )
    await assert.rejects(() => provider.transition(TODO, 'done'), /no transition from PROJ-1 to "done"/)
  })

  test('done prefers a normal resolution over one the workflow also allows', async () => {
    const bodies: string[] = []
    const provider = transitionOnlyProvider(
      {
        id: '13',
        name: 'Close',
        to: { name: 'Done', statusCategory: { key: 'done' } },
        fields: {
          resolution: {
            required: true,
            allowedValues: [
              { id: '2', name: "Won't Do" },
              { id: '1', name: 'Fixed' },
            ],
          },
        },
      },
      bodies,
    )
    await provider.transition(TODO, 'done')
    assert.match(bodies[0] ?? '', /"resolution":\{"id":"1"\}/)
  })
})

describe('error mapping', () => {
  test('a 401 names the variables, the token, and the remediation, never the token value', async () => {
    const { provider } = makeJira({ authenticated: false })
    await assert.rejects(
      () => provider.fetch(TODO),
      (err: Error) => {
        assert.match(err.message, /rejected the credentials/)
        assert.match((err as { hint?: string }).hint ?? '', /JIRA_EMAIL and JIRA_API_TOKEN/)
        assert.doesNotMatch(err.message, /fake-token/)
        assert.doesNotMatch((err as { hint?: string }).hint ?? '', /fake-token/)
        return true
      },
    )
  })

  test('a 404 points at the issue key and the site', async () => {
    const { provider } = makeJira({ issues: [] })
    await assert.rejects(
      () => provider.fetch(TODO),
      (err: Error) =>
        /could not find/.test(err.message) && /provider\.jira\.site/.test((err as { hint?: string }).hint ?? ''),
    )
  })

  test('a 403 says the token is valid but the account lacks permission', async () => {
    const { provider } = makeJira({ failure: { status: 403, body: '{"errorMessages":["denied"]}' } })
    await assert.rejects(() => provider.fetch(TODO), /refused permission .* denied/)
  })

  test('a 400 points at the project and issue type', async () => {
    const { provider } = makeJira({ failure: { status: 400, body: '{"errors":{"summary":"required"}}' } })
    await assert.rejects(
      () => provider.create({ title: 'x' }),
      (err: Error) =>
        /project: required|summary: required/.test(err.message) &&
        /provider\.jira\.issueType/.test((err as { hint?: string }).hint ?? ''),
    )
  })

  test('a 200 that is not JSON is reported as a proxy or SSO page', async () => {
    const provider = new JiraProvider({
      site: 'https://acme.atlassian.net',
      env: { JIRA_EMAIL: 'dev@example.com', JIRA_API_TOKEN: 'fake-token-not-real' },
      request: async () => ({ status: 200, body: '<html>sign in</html>' }),
    })
    await assert.rejects(() => provider.fetch(TODO), /not JSON/)
  })

  test('a transport failure does not repeat the underlying error, which may contain headers', async () => {
    const provider = new JiraProvider({
      site: 'https://acme.atlassian.net',
      env: { JIRA_EMAIL: 'dev@example.com', JIRA_API_TOKEN: 'fake-token-not-real' },
      request: async () => {
        throw new Error('boom: authorization Basic abcdef')
      },
    })
    await assert.rejects(
      () => provider.fetch(TODO),
      (err: Error) => /Could not reach Jira/.test(err.message) && !/abcdef/.test(err.message),
    )
  })
})

describe('site and key normalization', () => {
  test('a site accepts what people paste and always becomes an origin', () => {
    assert.equal(normalizeJiraSite('acme.atlassian.net'), 'https://acme.atlassian.net')
    assert.equal(normalizeJiraSite('https://acme.atlassian.net/'), 'https://acme.atlassian.net')
    assert.equal(normalizeJiraSite('https://acme.atlassian.net/rest/api/3'), 'https://acme.atlassian.net')
    assert.equal(normalizeJiraSite('https://acme.atlassian.net/jira/software'), 'https://acme.atlassian.net')
    assert.equal(normalizeJiraSite('http://localhost:8080'), 'http://localhost:8080')
  })

  test('a site with another scheme or no host is rejected', () => {
    assert.equal(normalizeJiraSite('javascript:alert(1)'), null)
    assert.equal(normalizeJiraSite('file:///etc/passwd'), null)
    assert.equal(normalizeJiraSite(''), null)
    assert.equal(normalizeJiraSite(null), null)
  })

  test('an issue key is uppercased and validated', () => {
    assert.equal(jiraIssueKey('proj-123'), 'PROJ-123')
    assert.throws(() => jiraIssueKey('PROJ'), /Invalid Jira issue key/)
    assert.throws(() => jiraIssueKey('PROJ-'), /Invalid Jira issue key/)
  })

  test('the fake returns the same markdown the converter writes', () => {
    // A guard on the test double itself: if the fake's assumptions drift from the converter,
    // this fails before a provider assertion becomes misleading.
    assert.equal(adfToMarkdown(markdownToAdf('## Title')), '## Title')
  })
})
