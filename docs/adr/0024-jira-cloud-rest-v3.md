# ADR-0024: The Jira provider speaks Jira Cloud REST API v3 only

- Status: accepted
- Date: 2026-11-17
- Milestone: Phase 4

## Context

ADR-0002 chose the `gh` CLI as the first ticket transport because it already owns auth
refresh, Enterprise host selection and proxy configuration. Jira has no equivalent CLI that
anvil can assume: Atlassian's own tooling is a separate product, third-party extensions
change without notice, and a company's Jira is often reachable only through the same proxy
that `fetch` already respects. Reimplementing a login flow was the failure mode ADR-0002
rejected, so the provider has to work without one.

Jira is also not one product. Jira Cloud and Jira Server/Data Center differ in their REST
surface, their authentication (account email plus API token versus personal access token),
their deployment hostnames, and the fidelity of Atlassian Document Format. Treating them as
one client produces failures that look like bad credentials when they are actually a
different API.

Three further constraints came from the ticket workflow:

- **Credentials must not leak.** A ticket body is user input, and a claim, error or JSON
  payload is easy to paste into an issue. A token in configuration is a token in git.
- **Bodies are not markdown.** Jira Cloud stores descriptions and comments as ADF, while
  every other anvil provider and the shared acceptance extractor speak markdown.
- **Workflows are per project.** A Jira status is whatever a team configured. There is no
  fixed `open`/`closed` pair to hard-code, and an issue's available transitions depend on
  its current status.

Anvil also must not grow a runtime dependency for this: the CLI is distributed as a
single-file bundle, and the ticket provider is not worth a client library.

## Decision

**Add a `jira` provider that targets Jira Cloud's REST API v3, using the built-in `fetch`
behind an injectable request seam, and support nothing else in this phase.**

- `JiraOptions.request` is the transport. It defaults to `fetch` with a timeout; every test
  injects an in-memory Jira (`packages/providers/test/fake-jira.ts`) and no test reaches the
  network. No runtime dependency is added.
- Credentials come only from `JIRA_EMAIL` and `JIRA_API_TOKEN`, read when a request is
  built. They are never stored on the provider, written to configuration, included in a
  claim, or repeated in an error. A report names a missing variable, not a value. The
  `Basic` header is constructed per request and discarded with it.
- `provider.jira.site`, `provider.jira.project` and `provider.jira.issueType` are the only
  configuration keys. The starter config includes them with `null`/`Task` and no
  credentials.
- A description or comment is converted between ADF and markdown by
  `packages/providers/src/adf.ts`. The conversion is a deliberate subset: text and marks,
  headings, lists, task lists, quotes, code, rules, links, mentions and media fallbacks. An
  unrecognised node keeps its text rather than vanishing. ADF task items become literal
  `- [ ]` / `- [x]` bullets so the shared acceptance extractor reads them exactly as it
  reads a local or GitHub ticket.
- Transitions are workflow-driven. The provider reads the issue's available transitions and
  maps the normalized target onto them. `in_review` is decided by a review-shaped status
  name inside Jira's `indeterminate` category, because Jira's category alone cannot separate
  "in progress" from "in review". `wontfix` requires a done status whose transition offers a
  rejection resolution; a status that merely contains "reject" is not enough. A target the
  workflow cannot reach is refused with the available transition names.
- `list` narrows server-side with JQL, filters the final page with the same mapping `fetch`
  uses, and follows `nextPageToken`. Hitting the page cap with the query incomplete is an
  explicit error, never a truncated backlog reported as empty.
- A `/browse/<KEY>` URL names Jira only on a recognisably Jira host (`*.atlassian.net`, a
  `jira.` hostname, or `provider.jira.site`). `--provider jira` accepts such a URL on any
  host. Issue keys are uppercased, so `proj-123` and `PROJ-123` are one claim.

## Consequences

- Jira Server and Data Center are not supported. `provider.jira.site` is reduced to an
  origin and the API path is always `/rest/api/3`; a Server deployment's PAT and context
  path are out of scope until a separate decision adds them. A user on Server gets a clear
  authentication or 404 failure pointing at `provider.jira.site`, not a half-working
  client.
- `anvil auth jira` is offline. It can say whether the site and both variables are present,
  which covers most first-run failures, but it cannot prove the token works without a
  network call. The first real command reports a 401 with the token-creation URL.
- The ADF conversion is lossy for nodes it does not model. The provider preserves the raw
  payload on `Ticket.raw`, so nothing is lost from anvil's own reporting, and round-trip
  tests pin the shapes a ticket actually uses. A node outside the subset keeps its text.
- The provider needs `provider.jira.project` for `list` and `create`. `claim PROJ-123` does
  not, so a read-and-transition workflow can leave the project unset; the auth check reports
  that as a note rather than a failure.
- The shared contract tests now run three providers. A new provider has to satisfy the same
  ref, read-back, comment and normalized-state semantics, which is what keeps `local` honest
  as a real provider rather than a mock.
- Jira's untrusted text is never passed to a shell. The transport builds a URL from a
  validated issue key and project key and a JSON body from converted ADF; JQL literals are
  escaped, and a value containing a line break is refused.

## Alternatives rejected

- **A Jira CLI or an Atlassian client library.** No first-party CLI is guaranteed to be
  installed or authenticated, and a library would be anvil's first runtime dependency for a
  provider. `fetch` plus an injected seam is smaller and testable offline.
- **Support Jira Server/Data Center in the same provider.** They use a different auth
  mechanism and deployment path. A client that guesses which one it is talking to turns a
  configuration mistake into an auth failure. Defer them to a later ADR that can test the
  real surface.
- **Store the token in `anvil.config.json`.** A committed secret is the failure this
  project spends effort avoiding elsewhere (`project.credentials` names variables and never
  reads values). Environment-only keeps the same rule for the provider.
- **Send markdown and let Jira render it.** Jira Cloud's API expects ADF for v3; the older
  wiki-markup path is a different API and does not carry task lists. Converting explicitly
  keeps the acceptance extractor shared and the round trip testable.
- **Map transitions by status name only.** Teams rename and add statuses. Asking the issue
  what it can do now, and refusing a target it cannot reach, is the only mapping that works
  across projects without configuration.
