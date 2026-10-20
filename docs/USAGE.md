# Using anvil

The [README](../README.md) is the argument for why anvil exists. This is the manual: what
to run, what it writes, what it refuses, and how to script it.

anvil does four things, in this order:

1. **Audit** a repository and say whether an agent could work in it (`anvil doctor`).
2. **Derive** the context an agent needs from what the repository actually contains
   (`anvil init`).
3. **Rank** the gaps between the two, and the guidance that would close them (`anvil plan`).
4. **Work** a ticket in its own git worktree, with the context already warm
   (`anvil claim`, `anvil crew`, `anvil ship`).

Everything below is a description of what the commands actually do. Where a command
refuses something, the refusal is in the docs, because a tool that refuses without
explaining is a tool people route around.

## Requirements

| Tool | Needed for | If it is missing |
| --- | --- | --- |
| Node.js **22.18+** | the install-time build, and every command | the install fails; the bundle itself targets Node 22 |
| `git` | `claim`, `crew`, `ship`, `status` | `doctor`, `plan` and `profile` still work — they only read files |
| `gh` (GitHub CLI) | `anvil ship` (opening the pull request), `anvil auth github` | tickets still work through the local markdown provider; `ship` cannot open a pull request without it |
| `opencode` | `anvil crew up --launch` (the default agent runner) | everything else; pass `--runner <name>` to launch a different agent |
| `ccusage` | `anvil crew status --cost` | the cost report says so instead of failing |

`anvil` never runs a build to find out what a repository is, so it is safe to point at a
repository you have never seen and cannot modify.

## Install

```bash
npm install -g github:tecruz/anvil
```

or, for one run without installing:

```bash
npx github:tecruz/anvil doctor
```

Two things to know:

- **Do not `npm install -g anvil`.** That name belongs to an unrelated package on npm.
  The install path is the GitHub URL above, exactly as written.
- **Pin a tag if you care what you get.** A git install with no ref tracks the default
  branch, so a breaking change reaches you on someone else's schedule:
  `npm install -g github:tecruz/anvil#v0.1.0`.

The install builds from source (`dist/` is not committed), which is why it needs Node
22.18+ and why the first install takes a minute. The result is a single file with no
runtime dependencies, so it runs in a locked-down network with no further installs.

## The first three commands

Start with the audit, on a repository you know:

```bash
anvil doctor
```

Every finding carries file:line evidence and a concrete fix, and the rules that cannot
decide report `na` rather than failing. If a finding is wrong, that is a bug worth
reporting — the tool was calibrated against real repositories, and its own false
positives are the interesting part.

Then derive the context an agent would need:

```bash
anvil init
```

This writes nothing into the repository. It builds a bundle in `.anvil/staging/` and
prints a diff. Let an agent improve the staged files, then:

```bash
anvil init --apply
```

The bundle records a hash of the inputs, so a repository that changed in the meantime is
detected and the apply is refused rather than silently overwriting work. `init` writes
three files:

- `AGENTS.md` — the commands, the module map, the risk paths, and nothing else it can
  infer (see [ADR-0009](adr/0009-guidance-has-to-earn-its-place.md) for why the byte
  budget exists).
- `.agents/skills/verify-change/SKILL.md` — a skill that runs the repository's own
  verification commands.
- `.opencode/commands/review-change.md` — a review command for the current diff.

Then rank what is missing:

```bash
anvil plan
```

Three tiers, ranked: **derived** (from this repository's own facts), **official** (the
technology's own documentation and skills), **community** (well-known third-party
resources, ranked lower because "widely accepted" is a weaker claim than "maintained by
the project"). Guidance the repository already satisfies is left out, and the count of
what was left out is printed, so the omission is visible rather than silent.

## Working a ticket

```bash
anvil issue create "Fix the login redirect"   # a local markdown ticket, no account needed
anvil claim local-1                             # branch + worktree + context bundle
anvil crew verify                               # run the verify commands in every worktree
anvil ship local-1                             # verify, push, open the PR, update the ticket
anvil release local-1                           # tear the worktree down
```

What each step does:

- **`issue create`** writes a ticket to `.anvil/tickets/` in the main worktree. The local
  markdown provider is deliberate: it is the escape hatch for a company that blocks API
  egress, and it needs no account and no network. A ticket reference can be `3`, `#3`,
  `local-3`, `PROJ-123`, or a full ticket URL.
- **`claim`** creates a branch (`feat/local-1-fix-the-login-redirect` by default) and a
  worktree *outside* the repository, in a short sibling directory so Windows path lengths
  stay inside the budget. The worktree comes warm: the ticket, the acceptance criteria,
  the repository's real verify commands and the high-risk paths are written to
  `.anvil/ticket.md` for the agent to read first. A claim that cannot succeed is
  refused before anything is created — a colliding branch, an occupied path, a dirty
  base or a path over the Windows budget all stop it.
- **`crew up --tickets 1,2,3 --launch`** claims several tickets and starts an agent in
  each. Claims are created one at a time (`git worktree add` mutates shared
  administrative state) and agents then start in parallel, because each one only touches
  its own worktree. Agents launched this way are forbidden from pushing: shipping is a
  human decision.
- **`crew verify`** runs each worktree's verify commands. The concurrency is chosen from
  the toolchain — Gradle, Maven, npm, pnpm, Yarn and Bazel keep mutable state in a
  shared home-directory cache, so those serialize to one at a time, while Go and Cargo
  run concurrently. The decision is always printed.
- **`ship`** runs the pipeline in a deliberate order: refuse, verify, push, pull
  request, ticket. The stages that could lose work or leave debris on the remote run
  last, so a failed verification means nothing reached the remote at all. It refuses
  before pushing when the worktree has uncommitted changes or the branch has no commits
  beyond its base. `ship` needs `gh` and a GitHub remote.
- **`release`** removes the worktree, and refuses to remove one holding uncommitted
  changes or unpushed commits unless `--force` is passed — and says which of the two it
  found.

`anvil status` shows every claim: branch, worktree, uncommitted changes and unpushed
commits, reported separately because they need different handling. `anvil status
--orphans` also lists worktrees git knows about that no claim references.

## Command reference

Every command takes `--json` and `--no-color`, and `--help` prints the flags it
accepts. This table is the summary; the help text is the contract.

| Command | What it does |
| --- | --- |
| `anvil doctor` | Audit AI-readiness and score the repository. `--layer`, `--fail-on <severity>`, `--strict`, `--max-files <n>`. |
| `anvil init` | Derive AGENTS.md, a verify skill and a review command. `--apply` writes them. |
| `anvil plan` | Rank fixes as derived / official / community. `--tier`, `--limit`, `--offline`, `--refresh`, `--include-satisfied`. |
| `anvil profile` | Detect the stack and emit a ProjectProfile. Reads files, never runs a build. `--max-files <n>`. |
| `anvil brief` | Emit verified facts for an LLM step. `--for agents\|commands\|skills\|all`. |
| `anvil issue` | `show`, `list`, `create`, `comment`, `set-state`, `pull`, `refresh`, `sync`. |
| `anvil claim` | Branch, worktree and context bundle for one ticket. |
| `anvil crew` | `up`, `status`, `verify` — several tickets at once. |
| `anvil status` | Every claim, and what would be lost if it were released. |
| `anvil ship` | Verify, push, open the pull request, update the ticket. |
| `anvil release` | Tear down a claim's worktree, and optionally its branch. |
| `anvil auth` | Check ticket-provider access and print the command that fixes it. |
| `anvil config` | `show`, `path`, `init` — inspect or scaffold configuration. |
| `anvil playbook` | `list`, `show`, `check`, `add`, `discover` — the guidance registry. |
| `anvil version` | The anvil version and the JSON schema version. |

`anvil profile` reports how complete the scan was in `diagnostics`: `truncated`, the
`fileLimit` that was in force, and any `failedDetectors`. `anvil doctor` repeats those
reasons under `degraded`, and `--strict` fails when the profile is incomplete. Raise
`--max-files` when a real repository exceeds the default 20,000-file cap.

## Configuration

Two layers, repo-local wins:

| Layer | Path | Scope |
| --- | --- | --- |
| global | `~/.anvil/config.json` | every repository on the machine |
| repo | `<repoRoot>/anvil.config.json` | one repository; commit it or ignore it |

```json
{
  "schemaVersion": 1,
  "git": { "defaultBaseBranch": null, "worktreeRoot": null },
  "provider": { "default": "local" },
  "output": { "color": "auto" },
  "features": { "probeCommands": false }
}
```

- `git.defaultBaseBranch` — the branch a claim forks from when the ticket does not name
  one. `null` means the repository's default branch.
- `git.worktreeRoot` — where worktrees are created. `null` means
  `<repoParent>/<repoName>-worktrees`.
- `provider.default` — the ticket provider used when a reference carries none.
- `output.color` — `auto`, `always` or `never`.
- `features.probeCommands` — run the project's verify commands during `ship`.

Only these keys are accepted. An unknown key is an error, not a warning: a typo in
`provider.default` should fail on day one rather than silently do nothing for a year.

```bash
anvil config show    # the resolved configuration and where each layer came from
anvil config path    # each config path, and whether it exists
anvil config init    # write a starter repo-local config (refuses to overwrite)
```

## Environment variables

| Variable | Effect |
| --- | --- |
| `ANVIL_CONFIG_HOME` | Where the global config and caches live. Defaults to `~/.anvil`. |
| `ANVIL_PLAYBOOKS` | A directory of playbook YAML files, merged over the built-in registry. |
| `ANVIL_TICKETS_DIR` | Where local tickets live. Defaults to `.anvil/tickets` in the main worktree. |
| `NO_COLOR` | Disables ANSI colour. `--no-color` does the same for one command. |

The opencode plugin forwards these four into the shell it hands to the agent, so a
worktree agent sees the same configuration the CLI does.

## Automation: `--json` and exit codes

Every command accepts `--json` and emits a versioned envelope:

```json
{
  "schemaVersion": 1,
  "ok": true,
  "command": "doctor",
  "data": { "score": 96, "grade": "A", "findings": [] }
}
```

A failure carries `ok: false` and an `error` object with a stable `code` and a `hint`.
A command that fails but still produced a payload keeps that payload in `data` on the
`ok: false` envelope — never in a success envelope, because a consumer that branches on
`ok` would otherwise read a failure as a success.

Exit codes are part of the public contract and do not change:

| Code | Meaning |
| --- | --- |
| 0 | success |
| 1 | unclassified failure |
| 2 | bad flags, unknown command, missing argument |
| 3 | configuration missing, unparseable or invalid |
| 4 | authentication missing or expired, or the transport cannot reach the host |
| 5 | not a git repository, or a repository preflight check failed |
| 6 | a readiness threshold was not met (`--fail-on`), or `playbook check` found a problem |
| 7 | a required external tool is missing |
| 8 | the staging bundle is stale relative to the current repository |
| 70 | a bug in anvil — report it |

`anvil doctor --fail-on high` and `anvil playbook check` are the two that are meant to
gate a CI job: both exit 6 rather than printing a report nobody reads.

## Playbooks

A playbook is hand-authored guidance for one technology: the official documentation, the
official skills, the community resources, and the verify commands and conventions that
technology implies. `anvil plan` matches a detected stack against the registry.

Three layers, later winning:

1. the built-in registry, compiled into the binary;
2. `~/.anvil/playbooks/`;
3. `$ANVIL_PLAYBOOKS`.

```bash
anvil playbook list            # every playbook, where it came from, what it matches
anvil playbook show node       # one playbook in full, with every resource and its URL
anvil playbook check           # structural checks, and every URL over the network
anvil playbook add ./my.yaml   # install a playbook into your own directory
anvil playbook discover        # what the ecosystem published that the registry does not know
```

`check` is the mitigation for rot: a URL in a hand-maintained file dies quietly, and a
dead URL is a suggestion that sends an agent to a page that says nothing. `discover`
answers what a curated registry cannot — what an ecosystem has published since a human
last edited the file — and writes a cache under `~/.anvil/cache/discovery`. It never
writes to the registry itself: `--propose` prints YAML for a human to merge by hand, and
a fetched suggestion is always ranked below one a person reviewed.

Your own playbooks live in your home directory, never in the repository you are standing
in: a company playbook is shared by being installed, not by being committed to someone
else's project.

## What anvil writes on disk

anvil writes inside `.anvil/`, inside the worktrees it creates, and inside your home
directory. It does not edit a file you wrote — the one exception is `anvil init --apply`,
which is the command whose whole job is to write three of them.

| Path | What it holds | Committed? |
| --- | --- | --- |
| `<repo>/.anvil/staging/` | the `init` bundle and its manifest | no |
| `<repo>/.anvil/tickets/` | local markdown tickets | no |
| `<repo>/.anvil/claims.json` | the claim registry, in the main worktree | no |
| `<worktree>/.anvil/ticket.md` | the ticket context bundle for the agent | no |
| `<worktree>/.anvil/AGENTS.md` | the worktree's rule overlay | no |
| `<worktree>/.anvil/session.json` | the agent session id, written by the opencode plugin | no |
| `~/.anvil/config.json` | the global configuration | your machine |
| `~/.anvil/playbooks/` | your installed playbooks | your machine |
| `~/.anvil/cache/discovery/` | the discovery cache | your machine |
| `<repoParent>/<repoName>-worktrees/` | the worktrees, outside the repository | no |

`.anvil/` is kept out of git through the repository's `info/exclude` rather than by
editing `.gitignore`: an ignore-file edit would dirty the working tree on every claim,
and `release` reports uncommitted changes, so the clean path would become unreachable.

## Troubleshooting

**`anvil` is not found after installing.** The install builds from source, so a failed
build leaves nothing on the PATH. Run the install again and read the error: the usual
cause is Node older than 22.18.

**`No ticket directory yet`.** There is no `.anvil/tickets/` in the main worktree.
Create a ticket with `anvil issue create "<title>"`, or point `ANVIL_TICKETS_DIR` at a
directory that already has one.

**`Cannot ship: gh is not authenticated`.** `ship` needs the GitHub CLI. `anvil auth
github` prints the exact login command for the host your remote actually points at,
which is the detail that matters on GitHub Enterprise.

**`The staging bundle is stale`.** The repository changed between `anvil init` and
`anvil init --apply`. Re-run `anvil init`, review the new diff, and apply again.

**A claim was refused.** Every refusal names the reason: a branch that already exists, an
occupied worktree path, a dirty base branch, or a path over the Windows length budget.
`anvil status --orphans` lists worktrees no claim references any more.

**A finding looks wrong.** It probably is, and it is worth reporting: the rules are
calibrated against real repositories, and a false positive costs the reader more than a
missing check does. [SECURITY.md](../SECURITY.md) is for vulnerabilities;
everything else is an issue.

## Where to go next

- [Architecture](ARCHITECTURE.md) — how the packages fit together, and where state lives.
- [The ADRs](adr/) — why it is built this way, decision by decision.
- [CONTRIBUTING.md](../CONTRIBUTING.md) — the conventions, and what CI runs.
- [IMPLEMENTATION_PLAN.md](../IMPLEMENTATION_PLAN.md) — the design, the milestones and
  the defects each one found. Long, and historical.
- [The opencode plugin](../packages/plugin-opencode/README.md) — the same tools, inside
  the agent.
