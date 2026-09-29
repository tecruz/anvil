# ADR-0002: `gh` CLI is the first provider transport, not the REST API

- Status: accepted
- Date: 2026-09-29
- Milestone: M4

## Context

`anvil` needs to read tickets, create PRs, post comments and check authentication. The
obvious implementation is the REST API with a token.

The target user walks into arbitrary companies. That means GitHub Enterprise on arbitrary
hostnames, enterprise proxies, SSO that refreshes tokens behind the scenes, and
organisations where the API's fine-grained permissions are narrower than the CLI's existing
credentials. Every one of those is a support burden, and none of them is where anvil's value
is: anvil's value is the ticket-to-branch-to-PR workflow, not being a GitHub client.

The API also fails in a way that is expensive during a first run. A wrong or expired token
produces a 401 with no remediation, at the exact moment the user is trying to do their first
thing.

## Decision

**Use the `gh` CLI, and abstract it behind a `ForgeTransport` interface.**

`gh` already handles auth refresh, Enterprise host selection and proxy configuration. Using
it means anvil inherits that instead of reimplementing it. The transport is injected, so the
entire ship sequence — refuse, verify, push, PR, ticket — is testable with no network, no
`gh` and no real repository.

The auth contract probes the **detected** host rather than the default one, and on failure
emits the exact remediation for that host: `gh auth login --hostname ghe.acme-corp.com`.
Joining a company with a GHE instance therefore does not mean authenticating to the wrong
place, which is a failure the API approach makes *more* likely, not less, because the API
defaults to github.com.

Every call is an argument array, never a shell string. Ticket titles and PR bodies are user
input, so a body containing `; rm -rf / #$(whoami)` must arrive as a single argv element,
and there is a test asserting exactly that.

## Consequences

- A `gh` dependency, which `anvil doctor` checks for and names precisely when missing.
- The local provider is not an afterthought; it is the required fallback for a machine with
  no `gh` or no network.
- Enterprise support is whatever `gh` supports, which is broad and not ours to maintain.
- `gh` must be installed and authenticated before `claim` or `ship` will work. `anvil auth
  github --check` exists to surface that before a claim rather than during a ship.
- Testability is the main prize: 49 tests in `packages/pr` run the whole pipeline offline.

## Alternatives rejected

- **REST API with a token**: reimplementing auth refresh, Enterprise host handling and
  proxy support, none of which is anvil's value, and failing with a 401 instead of a
  remediation when a token is wrong.
- **A pluggable set of transports from the start**: premature. One transport, behind an
  interface, with the second one (`local`) proving the interface is real.
