# ADR-0025: The local dashboard is a read-only view over CLI JSON

- Status: accepted
- Date: 2026-11-17
- Amended: 2026-11-19 (task brief)
- Milestone: Phase 4 follow-on (#67)

## Context

The CLI answers each question well in isolation: `doctor` reports readiness, `ready` reports
what an AI needs, `plan` ranks fixes, `brief` publishes verified context, `init` stages a
diff, and `crew status` lists claimed worktrees. The friction is between commands. An
operator comparing several active claims has to remember which command answers which part
and stitch the outputs together by hand.

A dashboard is the obvious shape for that overview. It is also the easiest place to
accidentally build a second product: a server with a route per command, its own copy of the
audit rules, a database of verification results, and write buttons that bypass the approval
boundaries the CLI deliberately enforces. [ADR-0001](0001-deterministic-cli-agent-reasons.md)
separates deterministic facts from prose; [ADR-0007](0007-distribution-git-install.md) keeps
the distribution at one file with zero runtime dependencies.

## Decision

**Add an on-demand, loopback-only, read-only dashboard that presents existing CLI JSON and
a read-only view of the staging bundle. Do not duplicate any business logic and do not add a
runtime dependency.**

- `anvil dashboard [--repo <dir>] [--port <n>]` binds to `127.0.0.1`, prints a one-time URL
  with a random session token, and keeps that token in an HttpOnly `SameSite=Strict` cookie.
- The server rejects unknown `Host` headers, serves a strict content security policy, has no
  inline script or style, and exposes the page, two static assets, `GET /api/snapshot` and
  `POST /api/brief`. A request can name bounded task text or a plan suggestion id; it can
  never name a command, a path or a repository.
- Each refresh spawns the same CLI commands a human would run with `--json`, all in offline
  mode for guidance. A failing command is recorded beside the others as a source error; it
  never makes the rest of the overview look empty.
- The task brief has two entry points: a pasted ticket and a derived `plan` suggestion. It
  maps the text to files through the `profile` file index, prints the verification commands
  with the source and working directory that established them, lists required needs that
  `ready` reports blocked, and states what it cannot know. It runs nothing and writes
  nothing: `POST /api/brief` takes no command, path or repository, is capped at 4,000
  characters, and stores no request or response.
- The context view reads `.anvil/staging/` through the same functions `init` uses. It shows
  the diff and whether staged bytes were edited after staging. It never stages, applies, or
  refreshes anything.
- Verification is reported as `unavailable`, never as green by absence. anvil does not
  persist verification results, and the dashboard does not run `crew verify` on page load.
- The page is a snapshot with an explicit timestamp and a manual refresh. It does not claim
  to be a live view of an agent, a tracker, or a CI run.
- No write actions are wired. The brief route is a derivation with no side effect beyond its
  response. Adding a write action later is a separate decision that must go through the same
  approval boundary the CLI command would use.
- The brief is built when a person asks for it, from the cached snapshot. A refresh
  invalidates it, so a brief is never presented as newer than the facts behind it.

## Consequences

- The CLI remains the product and every value on the page can be reproduced with one
  command from the source line the page prints. The dashboard cannot disagree with the CLI
  because it does not implement the rules.
- One refresh costs six CLI processes, as MCP tool calls already do. That is acceptable for
  an on-demand human view and keeps the single-file bundle free of a web framework.
- The browser page needs no build step, no CDN and no telemetry. It works in a locked-down
  network because it only talks to its own loopback server.
- A user with no browser, or a headless workflow, loses nothing: every command behind the
  page is already directly available.
- The first version deliberately does not show saved verification history, live agent
  output, or tracker state. Those need a storage contract anvil does not have yet, and
  inventing one would make the page assert facts it cannot verify.

## Alternatives rejected

- **A desktop app or hosted service.** Both add a distribution and an account boundary to
  a tool whose promise is local, evidence-first operation (#67 non-goals).
- **A terminal UI.** It would duplicate the overview in a second rendering model, and the
  narrowest real gap is comparing several worktrees side by side.
- **Running commands from HTTP requests.** That would turn a loopback page into a remote
  code-execution endpoint if any other page could reach it, and would bypass the explicit
  approval boundaries for setup and ship.
- **Persisting verification results for the dashboard.** It would create a second source of
  truth about whether work passed, with no reviewer for the stored verdict.
