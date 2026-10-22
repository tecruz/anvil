# ADR-0011: The control surface speaks MCP by running the CLI

- Status: accepted
- Date: 2026-10-21
- Milestone: post-M6
- Extends: [ADR-0001](0001-deterministic-cli-agent-reasons.md) - the CLI stays the
  deterministic half, and the model stays the prose half.

## Context

Agents already have a place to call tools: the Model Context Protocol. anvil already has
a control surface worth calling: `doctor`, `plan` and `crew status`, each with a stable
`--json` envelope. The missing piece was the bridge between them.

The obvious implementation is the official TypeScript SDK. It is also the implementation
that breaks the project's most load-bearing property: `anvil` ships as one file with no
runtime dependencies, because a tool that has to be installed into a locked-down
corporate network cannot afford a dependency tree. An SDK would also give the server a
second JSON contract to keep in sync with the CLI's own envelopes, and the two would drift
the first time one of them changed.

The second obvious implementation is to call the command functions in-process. It avoids
the process cost, but it couples the server to each command's internals and, worse, to the
CLI's output plumbing: a command that writes one diagnostic line to stdout would corrupt
the protocol stream, and the only way to find that would be a real MCP client failing at
runtime.

## Decision

**`anvil mcp` is a stdio JSON-RPC server, and every tool call runs the CLI.**

The server speaks newline-delimited JSON-RPC 2.0, which is the MCP stdio transport. It
implements four methods: `initialize`, `ping`, `tools/list` and `tools/call`. It exposes
three read-only tools:

- `anvil_doctor` -- the readiness report from `anvil doctor --json`.
- `anvil_plan` -- ranked fixes from `anvil plan --json`.
- `anvil_crew_status` -- claims and liveness from `anvil crew status --json`.

A tool call spawns the same `anvil ... --json` command a human would run, captures its
envelope, and returns the command's payload as the tool's `structuredContent`. There is
no second implementation of a report to keep honest, and no command output can reach the
server's stdout because the child owns its own.

The server's stdout belongs to the protocol. Errors above the protocol -- a crashed
child, a repository that could not be read -- stay on stderr, where a client that is
parsing frames never sees them as a malformed response.

## Consequences

- One process per tool call. For a control surface an agent polls occasionally, that is
  irrelevant next to the guarantee that the tool result and the CLI result cannot differ.
- The tools are read-only by construction: the server only knows how to run three
  commands, and none of them mutates a repository.
- The single-file bundle is preserved. The protocol used here is four methods and a tool
  result shape, not a dependency.
- The server is testable without an MCP client: the process invocation is injectable, so
  the unit suite exercises the protocol with a fake CLI.
- Adding a command to the surface means adding one tool definition that names the CLI
  command to run. It does not mean duplicating the command's payload logic.

## Alternatives rejected

- **The official MCP SDK.** A dependency, a second JSON contract, and a runtime the
  single-file bundle cannot carry.
- **In-process command calls.** Cheaper per call, but coupled to command internals and
  one stray `console.log` away from a corrupted protocol stream.
- **Expose the mutating commands too.** `claim`, `ship` and `release` change repository
  state, and a tool that can be called by a model in one line is not the place to decide
  whether that change should happen. The control surface starts read-only.
- **A second JSON contract for tools.** Rejected for the same reason as the SDK: the
  envelope the CLI already emits is the contract, and the tool returns it unchanged.
