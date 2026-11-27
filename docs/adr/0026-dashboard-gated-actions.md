# ADR-0026: Three confirm-gated dashboard actions

- Status: accepted
- Date: 2026-11-19
- Supersedes the "no write actions are wired" bullet of [ADR-0025](0025-local-dashboard.md) for exactly three actions
- Milestone: Phase 4 follow-on (#88)

## Context

ADR-0025 made the dashboard a loopback-only, read-only view over CLI JSON. It deliberately
deferred write actions because a page cannot be allowed to become a command-execution
endpoint or to bypass the approval boundaries the CLI enforces.

#88 asks for the smallest useful follow-on: from the Work view, an operator wants to claim a
ticket, verify the crew, or ship a change without leaving the page — but only through the
same CLI rules.

## Decision

Add **exactly three** actions to the 2D Work view: `claim`, `crew verify` and `ship`.

- The browser posts an action name and one bounded reference: `claim <ticket>` or
  `ship <claim key>`. It never sends a command, a flag, a path or a repository. A closed map in
  the server turns the action into the fixed argv a human would type (`claim <ticket>`,
  `crew verify`, `ship <key> --probe`). Ship always verifies through the CLI; the page cannot
  ask for `--skip-verify` or an unverified ship.
- Each action runs the existing CLI through the same injected invoke seam the snapshot uses.
  Provider resolution, ship verification and all approval checks stay in the CLI; the server
  has no second implementation of those rules.
- POST requires the session cookie (the token stays HttpOnly and is never served to page
  JavaScript), an `Origin` header matching this dashboard's own Host header, and a JSON content
  type. Each of those headers is read from the raw request exactly once: a repeated field is
   ambiguous and is refused rather than resolved to one value. JSON bodies are decoded as strict
   UTF-8, so an invalid byte is a bad request rather than a replacement character inside a
   string. The Host check and CSP from ADR-0025 still apply, the action body is bounded at 4 KB,
  and POST is allowed on two routes only: `/api/brief` (read-only — derives a brief from the
  cached snapshot, stores nothing and starts no CLI process) and `/api/action` (the three gated
  actions). A brief request carries a required, server-issued generation id for the snapshot
   the page is showing; if another tab has refreshed the shared cache, the old tab gets a 409
   instead of a brief built from a snapshot it is not displaying. A counter is used rather than
   a timestamp because two loads can share a millisecond. There is still no route that accepts
   a raw command or path.
- Every action requires an explicit browser confirmation. The result, including the CLI's
  own refusal, is printed beside the snapshot and kept across refreshes; a failure is never
  rendered as a green result.
- The default page remains a read-only snapshot. Verification stays `unavailable` on load;
  these actions do not persist a second source of truth.

## Consequences

- A compromised or careless page can trigger one of three known CLI commands, never an
  arbitrary one. The threat model of ADR-0025 otherwise stands.
- The dashboard still has no runtime dependencies and no new framework; the actions are a
  closed endpoint plus a few lines in the existing single-file script.
- ADR-0025's "no write actions" bullet is now scoped to read-only-by-default behaviour and
  to all other commands. Setup apply, init apply and other approval-gated flows remain out of
  scope.

## Alternatives rejected

- A generic "run command" endpoint: turns the loopback page into a remote code-execution
  surface and bypasses every CLI boundary.
- Calling internal claim/ship functions directly from the server: duplicates approval logic
  and lets the page disagree with the CLI.
- A 3D view or new framework: rejected in ADR-0025 and #88 for the same reasons.
