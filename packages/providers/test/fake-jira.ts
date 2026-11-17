/**
 * A Jira Cloud API that answers from memory.
 *
 * Every Jira test goes through `JiraOptions.request`, so no test reaches the network. The
 * fake keeps enough state for the provider's real parsing to be exercised: `create` adds an
 * issue, `fetch` returns it as ADF, `comment` appends an ADF comment, and the transitions
 * endpoint reports the workflow below. That workflow is deliberately *not* linear -- a
 * ticket can be closed from any open status, and `wontfix` is only reachable through a
 * transition that offers a matching resolution -- because those are the cases the provider
 * has to map correctly against a real team's workflow.
 *
 * It records every request, so a test can assert the URL, the body and the Basic auth header
 * without a live account. Anything unrecognised fails loudly: a fake that silently accepts
 * an unknown route hides a real regression.
 */

import type { AdfDoc, JiraHttpRequest, JiraHttpResponse, JiraRequest } from '@anvil/providers'

export interface FakeJiraComment {
  author: string
  body: AdfDoc
  created: string
}

export interface FakeJiraIssue {
  key: string
  summary: string
  description?: AdfDoc
  /** Status name. Defaults to `To Do`. */
  status?: string
  resolution?: string | null
  labels?: string[]
  comments?: FakeJiraComment[]
}

export interface FakeJiraOptions {
  site?: string
  project?: string
  email?: string
  token?: string
  /** When false, every request answers 401, as a missing or revoked token does. */
  authenticated?: boolean
  /** Force pagination smaller than `maxResults`, so a test can prove the cursor is followed. */
  pageSize?: number
  issues?: FakeJiraIssue[]
  /** One injected failure, optionally scoped to a path, for the error-mapping tests. */
  failure?: { status: number; body: string; path?: string }
}

export interface FakeJira {
  request: JiraRequest
  calls: JiraHttpRequest[]
  env: NodeJS.ProcessEnv
  site: string
  project: string
  issues: FakeJiraIssue[]
}

const STATUS: Record<string, { category: string }> = {
  'To Do': { category: 'new' },
  'In Progress': { category: 'indeterminate' },
  'In Review': { category: 'indeterminate' },
  Done: { category: 'done' },
}

const RESOLUTIONS: Record<string, { id: string; name: string }> = {
  Fixed: { id: '1', name: 'Fixed' },
  "Won't Do": { id: '2', name: "Won't Do" },
  Duplicate: { id: '3', name: 'Duplicate' },
}

interface FakeTransition {
  id: string
  name: string
  to: string
  resolutions?: string[]
}

function transitionsFor(status: string): FakeTransition[] {
  if (status === 'To Do') {
    return [
      { id: '11', name: 'Start', to: 'In Progress' },
      { id: '12', name: 'Send to review', to: 'In Review' },
      { id: '13', name: 'Close', to: 'Done', resolutions: ['Fixed'] },
      { id: '14', name: "Won't Do", to: 'Done', resolutions: ["Won't Do"] },
    ]
  }
  if (status === 'In Progress') {
    return [
      { id: '21', name: 'Submit', to: 'In Review' },
      { id: '22', name: 'Reopen', to: 'To Do' },
      { id: '23', name: 'Close', to: 'Done', resolutions: ['Fixed'] },
      { id: '24', name: "Won't Do", to: 'Done', resolutions: ["Won't Do"] },
    ]
  }
  if (status === 'In Review') {
    return [
      { id: '31', name: 'Back to progress', to: 'In Progress' },
      { id: '32', name: 'Reopen', to: 'To Do' },
      { id: '33', name: 'Approve', to: 'Done', resolutions: ['Fixed'] },
      { id: '34', name: "Won't Do", to: 'Done', resolutions: ["Won't Do"] },
    ]
  }
  return [{ id: '41', name: 'Reopen', to: 'To Do' }]
}

function fail(status: number, message: string): JiraHttpResponse {
  return { status, body: JSON.stringify({ errorMessages: [message] }) }
}

export function fakeJira(options: FakeJiraOptions = {}): FakeJira {
  const site = options.site ?? 'https://acme.atlassian.net'
  const project = options.project ?? 'PROJ'
  const email = options.email ?? 'dev@example.com'
  const token = options.token ?? 'fake-token-not-real'
  const authenticated = options.authenticated ?? true
  const issues = options.issues ?? []
  const calls: JiraHttpRequest[] = []
  let nextNumber = 1

  const statusOf = (issue: FakeJiraIssue): string => issue.status ?? 'To Do'

  const issuePayload = (issue: FakeJiraIssue) => {
    const status = statusOf(issue)
    const category = STATUS[status]?.category ?? 'indeterminate'
    return {
      id: issue.key,
      key: issue.key,
      self: `${site}/rest/api/3/issue/${issue.key}`,
      fields: {
        summary: issue.summary,
        ...(issue.description === undefined ? {} : { description: issue.description }),
        status: { name: status, statusCategory: { key: category, name: status } },
        resolution: issue.resolution === null || issue.resolution === undefined ? null : { name: issue.resolution },
        issuetype: { name: 'Task' },
        priority: { name: 'Medium' },
        assignee: { displayName: 'Fake User' },
        labels: issue.labels ?? [],
        comment: {
          comments: (issue.comments ?? []).map((comment, index) => ({
            author: { displayName: comment.author },
            body: comment.body,
            created: comment.created,
            self: `${site}/rest/api/3/issue/${issue.key}/comment/${String(index + 1)}`,
          })),
        },
        fixVersions: [],
        issuelinks: [],
      },
    }
  }

  const request: JiraRequest = async (req) => {
    calls.push(req)
    const url = new URL(req.url)
    const path = url.pathname.replace(/^\/rest\/api\/3/, '')

    if (options.failure !== undefined) {
      const failure = options.failure
      if (failure.path === undefined || path.startsWith(failure.path)) {
        return { status: failure.status, body: failure.body }
      }
    }

    const expected = `Basic ${Buffer.from(`${email}:${token}`, 'utf8').toString('base64')}`
    if (!authenticated || req.headers.authorization !== expected) {
      return fail(401, 'Unauthorized')
    }

    const body = (): Record<string, unknown> => {
      if (req.body === undefined) return {}
      try {
        return JSON.parse(req.body) as Record<string, unknown>
      } catch {
        return {}
      }
    }

    if (req.method === 'POST' && path === '/issue') {
      const fields = (body().fields ?? {}) as {
        summary?: string
        description?: AdfDoc
        labels?: string[]
        project?: { key?: string }
        issuetype?: { name?: string }
      }
      if (fields.project?.key !== project) {
        return fail(400, `project ${fields.project?.key ?? '(missing)'} does not exist`)
      }
      if (fields.issuetype?.name === undefined) return fail(400, 'issuetype is required')
      if (typeof fields.summary !== 'string' || fields.summary.trim() === '') {
        return fail(400, 'summary is required')
      }
      while (issues.some((issue) => issue.key === `${project}-${String(nextNumber)}`)) nextNumber++
      const key = `${project}-${String(nextNumber)}`
      nextNumber++
      issues.push({
        key,
        summary: fields.summary,
        ...(fields.description === undefined ? {} : { description: fields.description }),
        status: 'To Do',
        labels: fields.labels ?? [],
        comments: [],
      })
      return { status: 201, body: JSON.stringify({ id: key, key, self: `${site}/rest/api/3/issue/${key}` }) }
    }

    if (req.method === 'POST' && path === '/search/jql') {
      const payload = body() as { jql?: string; maxResults?: number; nextPageToken?: string }
      const jql = typeof payload.jql === 'string' ? payload.jql : ''
      const projectMatch = /project = "([^"]+)"/.exec(jql)?.[1]
      if (projectMatch !== undefined && projectMatch !== project) {
        return { status: 200, body: JSON.stringify({ issues: [], isLast: true }) }
      }
      const doneOnly = /statusCategory = Done/.test(jql)
      const notDone = /statusCategory != Done/.test(jql)
      const label = /labels = "([^"]+)"/.exec(jql)?.[1]

      let matched = issues.filter((issue) => {
        const category = STATUS[statusOf(issue)]?.category ?? 'indeterminate'
        if (doneOnly && category !== 'done') return false
        if (notDone && category === 'done') return false
        if (label !== undefined) {
          const wanted = label.toLowerCase()
          if (!(issue.labels ?? []).some((entry) => entry.toLowerCase() === wanted)) return false
        }
        return true
      })
      matched = matched.sort((a, b) => a.key.localeCompare(b.key, 'en', { numeric: true }))

      const offset = payload.nextPageToken === undefined ? 0 : Number.parseInt(payload.nextPageToken, 10)
      const pageSize = Math.max(1, Math.min(payload.maxResults ?? 100, options.pageSize ?? payload.maxResults ?? 100))
      const page = matched.slice(offset, offset + pageSize)
      const next = offset + page.length
      return {
        status: 200,
        body: JSON.stringify({
          issues: page.map((issue) => ({
            id: issue.key,
            key: issue.key,
            fields: {
              summary: issue.summary,
              status: {
                name: statusOf(issue),
                statusCategory: { key: STATUS[statusOf(issue)]?.category ?? 'indeterminate' },
              },
              resolution:
                issue.resolution === null || issue.resolution === undefined ? null : { name: issue.resolution },
              labels: issue.labels ?? [],
            },
          })),
          ...(next < matched.length ? { nextPageToken: String(next) } : { isLast: true }),
        }),
      }
    }

    const comment = /^\/issue\/([^/]+)\/comment$/.exec(path)
    if (req.method === 'POST' && comment !== null) {
      const issue = issues.find((entry) => entry.key === decodeURIComponent(comment[1] as string))
      if (issue === undefined) return fail(404, 'Issue does not exist')
      const payload = body() as { body?: AdfDoc }
      if (payload.body === undefined) return fail(400, 'comment body is required')
      issue.comments = issue.comments ?? []
      issue.comments.push({ author: 'Fake User', body: payload.body, created: '2026-11-17T12:00:00.000+0000' })
      return { status: 201, body: JSON.stringify({ id: String(issue.comments.length) }) }
    }

    const transitions = /^\/issue\/([^/]+)\/transitions$/.exec(path)
    if (transitions !== null) {
      const issue = issues.find((entry) => entry.key === decodeURIComponent(transitions[1] as string))
      if (issue === undefined) return fail(404, 'Issue does not exist')
      const available = transitionsFor(statusOf(issue))

      if (req.method === 'GET') {
        return {
          status: 200,
          body: JSON.stringify({
            transitions: available.map((transition) => ({
              id: transition.id,
              name: transition.name,
              to: {
                name: transition.to,
                statusCategory: { key: STATUS[transition.to]?.category ?? 'indeterminate' },
              },
              ...(transition.resolutions === undefined
                ? {}
                : {
                    fields: {
                      resolution: {
                        required: true,
                        allowedValues: transition.resolutions.map((name) => RESOLUTIONS[name] ?? { id: name, name }),
                      },
                    },
                  }),
            })),
          }),
        }
      }

      if (req.method === 'POST') {
        const payload = body() as { transition?: { id?: string }; resolution?: { id?: string } }
        const chosen = available.find((transition) => transition.id === payload.transition?.id)
        if (chosen === undefined) return fail(400, 'Transition is not valid for this issue')
        issue.status = chosen.to
        issue.resolution = null
        if (payload.resolution?.id !== undefined) {
          const resolution = Object.values(RESOLUTIONS).find((entry) => entry.id === payload.resolution?.id)
          if (resolution === undefined) return fail(400, 'Resolution is not valid')
          issue.resolution = resolution.name
        }
        return { status: 204, body: '' }
      }
    }

    const issuePath = /^\/issue\/([^/]+)$/.exec(path)
    if (req.method === 'GET' && issuePath !== null) {
      const issue = issues.find((entry) => entry.key === decodeURIComponent(issuePath[1] as string))
      if (issue === undefined) return fail(404, 'Issue does not exist or you do not have permission to see it.')
      return { status: 200, body: JSON.stringify(issuePayload(issue)) }
    }

    return fail(404, `The fake Jira has no route for ${req.method} ${path}`)
  }

  return {
    request,
    calls,
    env: { JIRA_EMAIL: email, JIRA_API_TOKEN: token },
    site,
    project,
    issues,
  }
}
