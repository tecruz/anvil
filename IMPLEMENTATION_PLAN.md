# `anvil` — AI-Ready Dev Harness

> Implementation plan. Working name (`anvil`) is one field in `package.json` — rename freely.
> Status: **M0–M6 complete**, plus a review pass (see
> [Review pass](#review-pass--m6-hardening-2026-09-30)). The tool is built; what it has not
> done yet is run against ten real repositories, which is the exit criterion M1 wrote.
> Deviation from plan: [ADR-0006](docs/adr/0006-single-file-bundle-location.md).

## The problem

Working at any company, on any project, with any technology, using AI agents. Three
concrete failures get in the way:

1. **A cold repo is unusable by an agent.** No instructions, no documented verify
   commands, no conventions, no risk map. The agent guesses and you review 400 lines
   of plausible garbage.
2. **Ticket → PR and PR → ticket are manual and platform-locked.** Every company uses a
   different tracker with a different API, a different auth model, and a different idea
   of what a status means.
3. **You can only work one ticket at a time.** Parallel work means parallel branches and
   manual context switching, which is exactly the thing agents are supposed to remove.

## The pipeline

These are not three features. They are one loop, and the loop is only as strong as its
weakest link:

```
issue pull ──▶ claim ──▶ worktree + ticket context ──▶ agent works
   ▲              ▲                                      │
   │              │                                      ▼
   │         doctor/plan/init              crew verify ──▶ ship ──▶ PR
   │         (once per repo, committed)                            │
   └──────────────────────── issue sync ◀─────────────────────────┘
```

`doctor` / `plan` / `init` run **once per repo** and produce committed artifacts.
`claim` / `ship` / `sync` run **once per ticket**. Optimizing only the per-ticket half
gives you a fast machine pointed at a cold repo.

## Non-goals (v1)

- Being the agent. opencode is the agent.
- Jira / GitLab / Azure DevOps / Linear. The provider interface is designed for them;
  they land after the loop is proven end to end.
- Auto-merge, auto-review, autonomous writes.
- A hosted registry service or a shared public index repo.
- Telemetry. None, ever.

---

## Decisions locked

| Choice | Answer | Why |
|---|---|---|
| Delivery | Standalone bundled TS CLI + thin opencode plugin | Logic lives in the CLI so it also works in Claude Code, Cursor, and a raw shell. The plugin is a thin registration layer, not the product. |
| Runtime | TypeScript / Node, npm workspaces, esbuild → single JS file, `npx anvil` | Native opencode plugin ecosystem, same language as the agent tooling, no runtime install step. |
| First tracker | GitHub Issues via the `gh` CLI transport | `gh` is already installed, handles auth and GHE hosts for free. Proves the bridge design with zero auth plumbing. |
| Fallback tracker | `local` (markdown files) | Not a test stub — **the escape hatch** for companies that block API egress. Also gives zero-auth crews and makes provider tests trivial. |
| Writes | Diff-first, always | You do not own these repos. Nothing enters a checked-out repo without an explicit `--apply`. |
| Audience | Personal, portable across companies | Core works fully offline. Portable config in `~/`. No company-specific assumptions baked in. |
| LLM access | The CLI never calls an LLM | No extra API key to manage on a locked-down corporate network, and no code leaving the machine. |

---

## The load-bearing architectural decision

**The CLI is deterministic and offline. The agent does the reasoning.**

- **CLI**: gather facts, evaluate rules, validate artifacts, render diffs, run git, call
  provider transports.
- **Agent**: write `AGENTS.md` prose, decide which subagents are worth creating, judge
  whether the result is any good.

So `anvil init` never calls an LLM API. Instead:

1. `anvil brief --for agents|commands|skills` emits a JSON bundle of **verified facts**
   (module graph, real build/test/lint commands with evidence, naming conventions, test
   layout, domain vocabulary) plus the matching playbook entries.
2. A command/skill hands that brief to the model. The model writes files into
   `.anvil/staging/`.
3. `anvil init --render` **validates** the output against the real opencode schemas
   (frontmatter fields, required properties, skill name regex, length limits) and renders
   a unified diff.

The CLI is therefore a quality gate on the LLM, not a wrapper around it. Corollary: the
validator is not busywork — it is the product feature that stops a malformed
`SKILL.md` from silently never loading.

### Artifact formats this must emit (verified against opencode docs)

- **Agents** → `.opencode/agents/<name>.md`. Frontmatter: `description` (**required**),
  `mode` (`primary`|`subagent`|`all`), `model`, `temperature`, `steps`, `hidden`,
  `permission` (supports glob maps, e.g. `bash: { "*": ask, "git status *": allow }`).
- **Commands** → `.opencode/commands/<name>.md`. Frontmatter: `description`, `agent`,
  `model`, `subtask`. Body supports `$ARGUMENTS`, positional `$1`, `` !`cmd` `` shell
  injection, and `@file` references.
- **Skills** → `.agents/skills/<name>/SKILL.md` (the cross-tool path — opencode *and*
  Claude Code both load it). Frontmatter: `name` (**required**, must equal the directory
  name and match `^[a-z0-9]+(-[a-z0-9]+)*$`), `description` (**required**, 1–1024
  chars), `license`, `compatibility`, `metadata` (string→string only). Unknown fields
  are ignored, so extra keys are harmless but not useful.
- **Rules** → root `AGENTS.md`. Precedence: nearest `AGENTS.md` beats `CLAUDE.md` beats
  `~/.claude/CLAUDE.md`. `opencode.json` `instructions[]` can pull in extra files and
  accepts globs (`packages/*/AGENTS.md`) — preferred for monorepos over manual
  `@file` references.

### Staging & apply lifecycle

`init` never writes into the checked-out repo directly. It writes into a staging area and
renders a diff; `--apply` is the only operation that mutates the repo.

- **Staging lives at `.anvil/staging/`** (gitignored by default). It is **content-
  addressed**: the directory is keyed by a hash of the inputs (facts + matched playbooks +
  template versions), so `init` on an unchanged repo regenerates an identical staging
  bundle and is trivially idempotent.
- **`--apply` re-diffs against live repo state, not against the state captured at `init`
  time.** If the repo changed since the staging bundle was produced (the input hash no
  longer matches the current facts), `--apply` **refuses** and tells you to re-run
  `init`. Silently applying stale content into a repo you don't own is a write-
  correctness bug; this check is what makes `--apply` safe to leave to the user.
- **Lifecycle**: `init` (re)builds staging → renders diff → stops. `--apply` validates the
  staging bundle against current inputs → writes → clears staging. Editing files between
  `init` and `--apply` therefore invalidates the apply rather than producing a surprise.

This is also what makes the self-referential idempotence test well-defined: same inputs
→ same staging bundle → second `--apply` is a no-op diff.

---

## Monorepo layout

```
anvil/
  package.json                 npm workspaces, devDeps only (typescript, esbuild, @types/node)
  tsconfig.base.json           strict, NodeNext, noEmit
  tsconfig.json                single typecheck entrypoint
  packages/
    core/            types, config resolution, fs + process helpers, json output
    profile/         stack detection -> ProjectProfile
    audit/           rules engine, scoring, evidence, blast-radius
    playbooks/       registry loader, matcher, ranking
    derive/          brief builder, artifact validator, diff renderer
    tickets/         canonical model, context bundle renderer
    providers/       provider interface + github (gh transport) + local
    git/             branch/worktree/remote wrapper (execFile, never shell strings)
    worktrees/       claim/release/state, crew orchestration
    pr/              PR body templates, linking, ship pipeline
    cli/             command wiring -> dist/cli.js (bin: "anvil")
    plugin-opencode/ tools + compaction hook + shell.env + toasts
  registry/playbooks/*.yaml
  fixtures/                       mini repos, one per ecosystem (16)
  docs/adr/                       architecture decision records
```

Generation templates live in `packages/derive/src/generate.ts` rather than a
`templates/` directory: they are TypeScript that reads a `ProjectProfile`, so keeping them
as functions means they are typechecked and unit-tested instead of being string templates
that can drift from the data they read.

`packages/cli` owns the `bin` entry (`"anvil": "./dist/cli.js"`) rather than the workspace
root. The bundle is written to `packages/cli/dist/cli.js`, not a root `dist/` — a publishable
package cannot have a `bin` pointing outside its own root, and the plan's original root-level
`dist/cli.js` was cosmetic. Recorded as ADR-0006.

`packages/core` holds the JSON output contract. Every public command supports
`--json`, and that schema is **versioned from M1** (`schemaVersion: 1`) because the
opencode plugin consumes it and retrofitting stability onto a shipped schema breaks
clients.

---

## Core contracts

```ts
interface ProjectProfile {
  schemaVersion: 1
  vcs: { host: 'github'|'gitlab'|'azure'|null; remote: string|null; defaultBranch: string|null }
  monorepo: null | { tool: 'npm'|'pnpm'|'bun'|'nx'|'gradle'|'maven'|'go-work'|'uv' }
  modules: { id: string; path: string; kind: string; deps: string[] }[]   // module graph
  stacks: { id: string; version?: string; evidence: string[] }[]           // matched playbooks
  commands: Partial<Record<'build'|'test'|'testFast'|'lint'|'format'|'typecheck'|'install'|'run',
                          { cmd: string; source: 'documented'|'detected'|'inferred' }[]>>
  tooling: { ci?: string[]; lint?: string[]; formatter?: string[]; container?: boolean; iac?: string[] }
  risk: { glob: string; level: 'high'|'medium'; reason: string }[]
}

interface Finding {
  id: string                      // 'AGENTS_COMMANDS'
  layer: 'orientability'|'operability'|'context'|'governance'
  status: 'pass'|'warn'|'fail'|'na'
  severity: 'blocker'|'high'|'medium'|'low'|'info'
  evidence: string[]              // ['AGENTS.md:12']
  fix: null | { kind: 'create-file'|'add-command'|'install'|'link-doc'|'manual'
                origin: 'derived'|'official'|'community'
                target?: string; summary: string
                apply?: { path: string; content: string }
                source?: { label: string; url?: string }
                confidence: number }
}

interface Ticket {                // canonical; `raw` is never lost
  ref: { provider: string; id: string; key: string; url?: string }
  title: string; body?: string; acceptance?: string[]
  state?: string                                  // provider-native
  normalizedState: 'todo'|'in_progress'|'in_review'|'done'|'wontfix'|'unknown'
  baseBranch?: string; labels?: string[]; milestone?: string
  links: { kind: 'pr'|'doc'|'commit'|'issue'; url: string; title?: string }[]
  comments: { author: string; body: string; at: string }[]
  raw: unknown
}

interface TicketProvider {
  id: string
  capabilities: { create; comment; transition; link; list; rawBodies }
  fetch(ref): Promise<Ticket>;  list?(q): Promise<TicketRef[]>
  create(draft): Promise<TicketRef>;  comment(ref, body): Promise<void>
  transitions(ref): Promise<{ to: string; name: string }[]>   // name->id resolved internally
  transition(ref, to): Promise<void>;  link(ref, url, title?): Promise<void>
}

interface Claim {
  key: string; ticket: TicketRef; branch: string; baseBranch: string
  worktreePath: string; worktreeId: string        // git worktree id, for reliable removal
  state: 'active'|'shipped'|'released'|'stale'
  agent?: { runner: 'opencode'|'manual'|'none'; sessionId?: string; launchedAt?: string }
  pr?: { number: number; url: string; state: string }
  lastVerifiedAt?: string; createdAt: string
}
```

---

## Readiness rule set

Rules are **data**, not code. Each carries `id`, `layer`, `severity`, an `evaluate`
predicate over the `ProjectProfile`, and an optional `fix`.

### Orientability — can the agent understand the repo?

| id | checks | severity |
|---|---|---|
| `AGENTS_FILE` | `AGENTS.md` exists with non-trivial content; downgrade to `warn` if only `CLAUDE.md` / `.cursorrules` / `.github/copilot-instructions.md` exist | high |
| `AGENTS_COMMANDS` | `AGENTS.md` actually contains runnable build/test/lint commands | **blocker** |
| `ARCH_DOC` | architecture doc exists, or `instructions[]` points at one | medium |
| `CONVENTIONS` | code style documented, not just configured | medium |
| `MODULE_MAP` | a path/module index exists (essential for monorepos) | medium |

`AGENTS_COMMANDS` is a blocker because without it the agent cannot verify anything, and
an unverifiable agent produces unreviewable diffs.

### Operability — can the agent verify its work and not break things?

`BUILD`, `TEST`, **`TEST_FAST`**, `LINT`, `FORMAT`, `TYPECHECK`, `CI`, **`CI_PARITY`**,
`PRECOMMIT`, `LOCKFILE`, `INSTALL_DOC`.

Two of these carry disproportionate weight:

- **`TEST_FAST`** — a documented "changed files only" subset. Full-suite feedback on
  every iteration makes agents unusable, and this is the rule that makes them usable.
  Detection is non-trivial (see below), so its spec is explicit.
- **`CI_PARITY`** — CI must run *the same commands* `AGENTS.md` claims (compared as
  normalized strings). Divergence here means every "verified" claim the agent makes is
  a lie waiting to happen.

#### `TEST_FAST` detection spec

The rule checks for a **documented** fast-test invocation — not merely a *capable*
toolchain. `pytest -k` is a capability; detecting pytest tells you nothing about whether
anyone ever runs a subset. Detection looks for one of:

1. `AGENTS.md` contains a test command with a changed-files filter (`--changed`,
   `--changedSince`, `-k`, `--onlyChanged`, Gradle `--tests`, Bazel target args).
2. A `package.json` script matching `/test.*(fast|changed|watch|staged)/`.
3. A Make/Just/Taskfile target named `test-fast`, `test-changed`, or `test-staged`.
4. A CI job whose step filters by changed files (`paths-changed`, `dorny/paths-filter`,
   `git diff --name-only` feeding a test runner).

**Out of scope:** "the toolchain *could* run a subset but nothing documents it." That is
reported as `info`, not a pass/fail — it is a prompt for the agent to *add* a fast path,
not evidence one exists. This keeps the M1 "no false blockers" criterion testable: a repo
with pytest but no documented subset must **not** fail `TEST_FAST`.

### Context — does the agent know the technology?

`PLAYBOOK` (official AI resources for the matched stack), `MCP`, `STYLE_GUIDE`, `ADR`.

### Governance — should the agent be allowed to act?

`CODEOWNERS`, `PR_TEMPLATE`, `ISSUE_TEMPLATE`, `CONTRIBUTING`, `SECURITY_MD`, `LICENSE`,
`GITIGNORE_ENV`, `ENV_EXAMPLE`, `SECRET_SCAN`, `RISK_MAP`.

### Two invariants

1. **Every finding carries file:line evidence and a concrete fix artifact.** Never vague
   advice. A finding without a fix artifact is a to-do, not a feature.
2. **Commands are labeled.** `documented` (found written down) / `detected` (found in a
   build file) / `inferred` (guessed from convention). `inferred` commands are never
   executed by `ship` without `--probe`. Quiet wrong commands are the single worst
   failure mode of this class of tool.

### Blast-radius map

`ProjectProfile.risk` identifies high-risk paths (migrations, infra, auth, payments,
manifests, lockfiles) from playbook `riskGlobs` plus local heuristics. It feeds two
places:

1. The `RISK_MAP` finding (are these documented, or does the agent not know?) — **v1**.
2. **PR generation** — a PR touching high-risk paths gets an auto-added risk checklist —
   **shipped in M4**, see [ADR-0005](docs/adr/0005-governance-ships-in-m4.md).

That second use is what turns a linter into a permission system, and it is read-only signal:
the risk map is computed and reported, and the checklist is a comment in a PR body, not a
block on shipping. Open question 1 originally resolved this as M6 scope, which
[ADR-0005](docs/adr/0005-governance-ships-in-m4.md) reverses — the PR body is assembled once,
so governance arriving later means rewriting the one step that everything else depends on.

---

## Playbook registry

`registry/playbooks/<id>.yaml`:

```yaml
id: android-jetpack
title: Android (Jetpack Compose)
match:
  files: ['**/build.gradle.kts', '**/build.gradle', 'settings.gradle*']
  deps: ['androidx.compose.*', 'com.android.application']
  importPrefixes: ['androidx.compose']
priority: 60
official:
  docs:            [{ label, url }]
  skills:          [{ label, source, install, why }]
  agents:          []
  mcp:             []
  styleGuides:     []
  migrationGuides: []
community:
  - { repo: 'org/name', why: 'accepted conventions for X', install: '...' }
verify:
  build:    ['./gradlew :app:assembleDebug']
  test:     ['./gradlew test']
  testFast: ['./gradlew test --tests "*Changed*"']
  lint:     ['./gradlew lint']
conventions:
  moduleLayout: 'app/ + feature/*/ + core/*/'
  testNaming:   '*Test.kt'
  reviewFocus:  [...]
riskGlobs: ['**/AndroidManifest.xml', '**/migrations/**']
```

`priority` resolves multi-playbook matches (an Android repo matches both `android-jetpack`
and `kotlin`). `anvil playbook add <path|url>` covers company-specific playbooks, so the
registry is extensible without forking.

**Rot is a real failure mode.** `anvil playbook check` validates every URL and version
range and runs in CI.

---

## CLI surface

What ships today. The planned-but-unbuilt remainder is listed under
[Not built](#not-built) rather than mixed in here, because a surface that lists
unimplemented commands as if they exist is how a plan stops being usable as a spec.

```
anvil profile [--json] [--profile <dir>]
anvil doctor  [--json] [--layer <l>] [--fail-on <severity>] [--profile <dir>]
anvil plan    [--json] [--tier derived|official|community] [--only <ids>] [--limit <n>]
anvil brief   --for agents|commands|skills|all    # verified facts for the LLM step
anvil init    [--apply] [--only <artifact>] [--allow-warnings]
anvil playbook list | show <id> | check [--offline] [--concurrency n] [--timeout ms] [--warnings]
anvil auth github | local

anvil issue show|list|create|comment|set-state <ref>
anvil issue pull|refresh <ref>              # -> .anvil/ticket.md context bundle
anvil issue sync <ref>                      # PR -> ticket

anvil claim <ref> [--prefix p] [--base <branch>] [--runner <name>] [--worktree-root <dir>]
anvil release <key> [--delete-branch] [--force]
anvil status [--orphans]
anvil crew up [--tickets a,b,c] [--limit N] [--launch] [--runner <r>] [--jobs N] [--force-parallel]
anvil crew status | verify [<key>]...
anvil ship <key> [--draft] [--reviewers ...] [--no-ticket-update] [--probe] [--skip-verify]
anvil config show | path | init
anvil version
```

### Not built

- `anvil playbook add <path|url>`, for a company playbook without a fork. `list`, `show` and
  `check` exist; `match` is deliberately absent because `plan` already reports what matched.
- `anvil auth --check` as a distinct mode. `auth github` is already an offline probe, so
  `--check` is accepted and ignored rather than being a different code path.
- `crew up --from <query>`. Tickets are selected with `--tickets`, or by taking everything
  in state `todo`.

#### `auth github --check` unhappy path

Because the target user walks into arbitrary companies, the common case is a **GitHub
Enterprise host `gh` is not authenticated to** — or a GHE setup where `gh` is not the
right entry point at all. `--check` must never emit a generic failure. It:

1. Reads the repo's remote host (from `ProjectProfile.vcs.host`/`remote`).
2. Probes `gh auth status --hostname <host>`.
3. On success: reports the authenticated user and scopes. On failure: emits the **exact
   remediation** for that host — e.g. `gh auth login --hostname ghe.acme-corp.com` —
   and exits non-zero so the failure surfaces before `claim`/`ship`, not during them.

If `gh` itself is missing, the error names the install path and points at the `api`
transport as the fallback, rather than reporting "gh: command not found".

### Ticket ↔ PR bridge

- **Ticket → PR**: branch `proj-123-short-slug`, conventional commits `PROJ-123:`, PR
  body carrying description + acceptance criteria + `Closes PROJ-123`, then link back and
  transition the ticket to In Review.
- **PR → ticket**: parse keys from body, labels and commits; post the PR link; transition
  on review and on merge.
- **Human → agent**: someone comments on the ticket mid-task → `anvil issue pull
  --refresh` → the comment is in the worktree's context bundle. Without this, agents work
  from a stale snapshot of the requirement.

Two mapping details that look trivial and are not:

- **Slug collision**: the branch slug is derived from the ticket title, truncated to keep
  the branch name short. If `proj-123-short-slug` already exists locally *or* on the
  remote, `claim` **refuses** rather than appending a suffix — a colliding branch is
  almost always a sign of a duplicate or stale claim, and silently renaming hides it.
  Recovery is explicit: `release` the old claim or pass `--base` to re-root.
- **`normalizedState` is a per-provider mapping, not a given.** GitHub Issues has exactly
  two native states (open/closed); `in_review` is inferred from a linked open PR, not
  read from the issue. Each provider ships a `state` → `normalizedState` table; the
  canonical model does not pretend providers share a state machine. The table for a new
  provider is part of that provider's contract tests.

---

## Crew / worktrees

- `claim` creates a branch from the ticket's `baseBranch` (from the ticket's parent /
  fix-version / target field, else the repo default branch), `git worktree add`, then
  writes a per-worktree ticket context file and `AGENTS.md` overlay so the agent in that
  worktree starts warm instead of cold.
- `crew up` claims N tickets, creates N worktrees, and optionally launches N agent
  sessions via `opencode run` in each.
- `crew status` shows per-key: worktree path, branch, dirty?, last commit age, PR link,
  last verified. "Dirty" means **uncommitted changes OR unpushed commits** — the two
  states that lose work if the worktree is released — and the two are reported
  separately, not collapsed into one flag.
- `crew verify` runs the project's verify commands in each worktree and aggregates.
- The main worktree stays on the base branch while a crew is active.

`crew verify` across N worktrees has a resource and interference contract, not just an
aggregate:

- **Concurrency** is bounded by `--jobs` (default: half the logical cores). N parallel
  Gradle / cargo / `node_modules`-installing processes will thrash a laptop long before
  they hit a git limit.
- **Shared caches are the real cross-contamination vector**, not git refs. Gradle, Maven,
  npm and Bazel all share state across worktrees of the same repo (a shared
  `~/.gradle`, `~/.m2`, npm cache, Bazel output base, Docker daemon, `.git/objects`).
  Two worktrees building the same repo simultaneously can corrupt or thrash that cache.
  Where the ecosystem has no per-worktree isolation story, `crew verify` **serializes**
  those commands even when `--jobs > 1`; where it does (per-worktree build dirs), it
  parallelises freely.
- **Partial failure**: per-worktree pass/fail is reported per key, and `crew verify`
  exits non-zero if **any** worktree fails — a green aggregate must never hide a red
  member.

**Preflight (Windows is the hostile case):** short default worktree path, `ENAMETOOLONG`
check on *removal* (not just creation), submodules, Git LFS, nested repos, dirty base
repo. All `git` invocations use `execFile` with argument arrays — never shell strings.

---

## Milestones

Each milestone is independently useful. Ship order is risk order: the two things most
likely to invalidate the whole idea (does the audit work on real repos? does the derived
context work?) come first, before any git or provider complexity.

| M | Deliverable | Done when |
|---|---|---|
| **M0** | npm workspaces, tsconfig, `packages/core`, CLI skeleton, versioned `--json` output, config resolution (`~/` + repo), esbuild single-file bundle | `anvil --help` runs from the bundled file |
| **M1** | `profile` + `doctor`. 6 detectors, module graph, command extraction, blast-radius. 10 fixtures + golden snapshots | on 10 real repos: no false blockers, verify commands correctly found |
| **M2a** | Playbook registry + matcher + 3 seed playbooks, `plan` with tiered ranking. Pure data, no LLM | `anvil plan` ranks sensibly on 5 real repos, checked by hand |
| **M2b** | `brief`, `init` staging + validator + diff renderer, templates for AGENTS.md / agents / commands / skills. Detector count 6 → 12 | `init` on a real repo produces artifacts that opencode actually loads, and `doctor` scores higher after `--apply` |
| **M3** | `git` wrapper, `claim` / `release` / `status`, worktree preflight, **`local` provider**, and **compaction-context injection** (see note) | crew of 3 real worktrees with no git-ref **or** build-cache cross-contamination; `crew verify` aggregates per-worktree pass/fail and exits non-zero on any failure |
| **M4** | `gh` provider, `ship` (verify → push → PR → ticket), `issue sync`, PR body templates | ticket → branch → PR → ticket round-trip on a real repo |
| **M5** ✅ | `crew up` + parallel agent launch, `crew verify`, ref locking, `--jobs` | 3 tickets shipped in parallel by 3 agents |
| **M6** ✅ | `opencode-anvil` plugin (tools, toasts, `shell.env`), 15 playbooks, npm publish | plugin installs from npm; full documented flow works end to end |

### M2 is deliberately split

The original plan put registry + 6 playbooks + ranking + brief + scaffolder + validator +
diff renderer in one milestone. That is roughly twice the size of M1 and would have
stalled on playbooks. Splitting at the data/logic boundary gets a shippable milestone
earlier and isolates playbook content work (which is mostly human research) from
scaffolder engineering.

### Compaction-context injection lands in M3, not M6

The original plan deferred this to the plugin in M6. Wrong. Ticket context dying at
context compaction is the single worst failure mode of a worktree crew — the agent
quietly forgets the acceptance criteria and keeps going. It is roughly ten lines against
`experimental.session.compacting`, and it should exist as soon as the first worktree
exists.

### Detector count is staged

6 solid detectors in M1, 12 by M2b. Android/Gradle and mixed-language monorepos (Go
workspace, Bazel, Bazel-without-`WORKSPACE`) are where signature detection quietly
breaks, and a half-working detector is worse than a missing one because it produces
confident wrong output. Six that are right beats twelve that are mostly right.

---

## Testing strategy

- **Golden**: 10 fixture mini-repos → snapshot `ProjectProfile` + report. Every new
  detector ships with a new fixture.
- **Contract**: the `gh` transport is mocked at the `execFile` boundary (record/replay
  `argv → stdout`). Live suite behind `ANVIL_LIVE=1`, never in default CI —
  `packages/providers/test/gh-live.test.ts`, run with `npm run test:live`.
- **Integration**: real `git` in temp dirs, full worktree lifecycle including removal.
- **Self-referential** (the one that actually proves the tool works): `doctor` →
  `init --apply` → `doctor` again must score strictly higher, and `init` must be
  idempotent. The tool has to improve what it measures.
- **CI matrix**: Windows / Linux / macOS. Windows first-class, because path length,
  CRLF and `ENAMETOOLONG` on worktree removal will surface there before anywhere else.

---

## Risks

| # | Risk | Mitigation |
|---|---|---|
| 1 | `gh` as a hard dependency | `Transport` interface with an `api` fallback; hard, actionable error — never a confusing crash |
| 2 | Command extraction lies (esp. monorepo task runners) | `documented`/`detected`/`inferred` labels; `ship` refuses unverified `inferred` commands without `--probe` |
| 3 | Concurrent git ops | Per-worktree indexes are isolated but **refs are shared** → serialize `fetch` behind a per-repo lock; refuse `claim` when the base repo is dirty |
| 4 | Windows path length | Short default worktree path, preflight check on create *and* remove, configurable |
| 5 | Playbook rot | `anvil playbook check` in CI validates URLs and version ranges |
| 6 | LLM writes a bad `AGENTS.md` | Evidence-linked claims only, diff-first, frontmatter validation gate |
| 7 | Secrets | Reports mask high-entropy matches; no telemetry; never write outside the repo; `local` provider works with no egress |
| 8 | M4 seam complexity | `ship` is where git, provider, templates, CODEOWNERS and verify all meet at once. Assume 1.5–2x estimate. Build it last-but-early enough to fail |

---

## Open questions

1. ~~Does v1 `ship` need CODEOWNERS-aware reviewer resolution and auto risk
   checklists?~~ **Resolved: yes, and it shipped in M4.** This was first answered "no, M6
   scope" and that answer was wrong — the PR body is assembled once, so arriving later means
   rewriting the step everything depends on. See
   [ADR-0005](docs/adr/0005-governance-ships-in-m4.md). Recorded here because the reversal is
   the useful part.
2. ~~**Worktree location**~~ **Resolved: `../<repo>-worktrees/<key>`.** Sibling directory, so
   a worktree is never inside the repository it was created from. That nesting matters
   because `git worktree add` on a path inside the repo is legal and produces a directory
   that tools then walk, and `.anvil/` state resolution has to special-case it.
3. **Detected command confirmation**: should `ship` require an explicit human confirm when
   a verify command is `inferred`? *Partly resolved: `ship` refuses an `inferred` verify
   command without `--probe`, and logs it loudly otherwise.* Full resolution in M6.

### Decisions get an ADR

`docs/adr/` is in the layout, so ADRs are scheduled, not aspirational. One ADR per
milestone, written when the milestone closes, covering the decisions taken in it. Unwritten
entries are listed as plain text, not links, so this document has no dead references.

| ADR | Decision | Status |
|---|---|---|
| [ADR-0001](docs/adr/0001-deterministic-cli-agent-reasons.md) | The CLI/agent split (CLI deterministic, agent reasons) | **written (M6)** |
| [ADR-0002](docs/adr/0002-gh-cli-as-first-transport.md) | `gh` CLI as the first provider transport | **written (M6)** |
| [ADR-0003](docs/adr/0003-diff-first-staging-lifecycle.md) | Diff-first writes + staging/apply lifecycle | **written (M6)** |
| [ADR-0004](docs/adr/0004-local-provider-as-egress-escape-hatch.md) | `local` provider as the API-egress escape hatch | **written (M6)** |
| [ADR-0005](docs/adr/0005-governance-ships-in-m4.md) | Governance ships in M4, not M6 | **written (M6)** |
| [ADR-0006](docs/adr/0006-single-file-bundle-location.md) | Single-file bundle lives in `packages/cli/dist` | **written (M0)** |

Each is written by the milestone that puts it under load, not before - an ADR for a decision
no code has exercised yet is a guess with a date on it.

**The five ADRs were written in M6, not in the milestones that decided them**, which
contradicts the rule above. The reason is that the rule protects against a *guess*, and by
M6 none of these were guesses: every one had code exercising it, a bug found, or a
disagreement resolved. Two of them record a decision that reversed an earlier plan
(ADR-0005), which is the clearest sign that the decision was still live when the plan was
written. Writing them earlier would have recorded intent; writing them now records what
happened.

---

## Progress

### M0 — complete (2026-09-28)

Delivered: npm workspaces, `tsconfig` (strict/NodeNext/noEmit), `packages/core`
(versioned output envelope, error→exit-code table, strict two-layer config resolution,
`parseArgs` wrapper, git discovery), `packages/cli` (command registry, `config show|path|init`,
`version`, root help with the planned surface), esbuild single-file bundle, and 80 tests.

Exit criterion met: `anvil --help` runs from the bundled file (26.1 kB, zero runtime deps).

Three real bugs were caught by the tests before they could bite later:

1. **Config validation required sibling keys** — `{"git":{"defaultBaseBranch":"main"}}` was
   rejected because `worktreeRoot` was validated as absent. Any partial config file would
   have failed. Now only keys the layer actually sets are validated; regression test added.
2. **`FORCE_COLOR=0` did not disable color** on a TTY, because the check fell through to
   the TTY test instead of honoring the explicit opt-out.
3. **git returns forward slashes and may lower-case paths on Windows** — left unnormalized,
   `discoverRepo().root` would never compare equal to Node-native paths, surfacing in M3 as
   unexplained worktree/path matching failures. Normalized with `realpath.native` at the
   boundary.

One output inconsistency fixed: `config path` excluded the synthetic default layer in text
mode but not in JSON.

Deviation from plan recorded in [ADR-0006](docs/adr/0006-single-file-bundle-location.md).

### M1 — complete (2026-09-28)

Delivered: `packages/profile` (signature-based, non-executing detection) and
`packages/audit` (rules engine). Six detectors — Node, Python, Go, Rust, JVM, .NET —
plus a language-agnostic pass for docs, instruction files, CI and the blast-radius map.
29 rules across the four layers. `anvil profile` and `anvil doctor` are live, with
`--fail-on <severity>` exiting 6 while still emitting the full report.

130 tests: 10 fixture repos (node-npm, node-workspace, python-django, go-module,
rust-crate, jvm-gradle, dotnet-sln, cold-empty, documented-commands, multi-lockfile)
asserting detection behaviour per ecosystem, plus report-shape and scoring invariants.

Bugs the tests caught:

1. **`--profile <dir>` hoisted to the enclosing git repo root.** Pointing it at a nested
   fixture silently audited the parent project — reporting the wrong repository with total
   confidence, which is the exact failure mode this tool exists to eliminate. An explicit
   `--profile` is now analysed as given; the enclosing repo is consulted only for
   provenance.
2. **`addCommand` appended a higher-priority command last.** A `documented` command
   discovered after a `detected` one ended up *second* in the list, so
   `commands.test[0]` was the less trustworthy entry. Commands are now sorted
   highest-priority-first; lower-priority candidates are kept so a source disagreement
   stays visible to a rule.
3. **The `testFast` prose pattern was unreachable.** `\btest\b` consumed the `test` token
   in `npm run test:changed`, leaving nothing for the marker to match, so a documented fast
   subset was classified as a full suite.
4. **`test:watch` was classified as `testFast`.** A watch process never exits, so it cannot
   be what `crew verify` runs. Excluded from the fast-subset patterns.
5. **A JSDoc comment containing `**/` terminated the block comment early**, twice,
   producing syntax errors. Reworded.

Two rules were initially shipped as dishonest placeholders and now do real work:

- **`CI_PARITY` compared nothing** while reporting `pass` and admitting in its own detail
  text that comparison was unimplemented. It now reads the workflow bodies and checks each
  documented command against the runner tokens that would satisfy it. It found a genuine
  gap in two of the fixtures.
- **`TEST_FAST` conflates "capable" with "documented"**. Per the detection spec, a
  toolchain with a changed-files capability but no documented subset reports `warn`, not
  `fail` — which is what keeps the "no false blockers" criterion testable.

### M2a — complete (2026-09-28)

Delivered: `packages/playbooks` and `anvil plan`. Three seed playbooks (node, jvm,
python), a strict YAML-subset parser, a generated registry, matching, and tiered ranking.
`anvil plan` is read-only and involves no LLM.

Hand-check across the fixture repos plus anvil itself:

| repo | score | grade | playbook | derived/official/community |
|---|---|---|---|---|
| node-npm | 67 | C | node | 7/8/4 |
| node-workspace | 42 | D | node | 10/10/3 |
| python-django | 55 | C | python | 11/12/4 |
| go-module | 54 | D | — | 9/0/2 |
| jvm-gradle | 46 | D | jvm | 13/12/4 |
| dotnet-sln | 39 | D | — | 14/0/2 |
| cold-empty | 30 | F | — | 7/0/1 |
| anvil itself | 53 | D | node | 13/38/8 |

Playbook matching is exact where expected, and `go` and `dotnet` correctly yield **zero**
official suggestions because those playbooks do not exist yet — an honest gap rather than
a generic fallback. Scores track fixture warmth in the right order.

**Authoring format decision.** `registry/playbooks/*.yaml` stays the authoring format, but
loading is a strict, bounded YAML-subset parser that **throws** on anything outside the
subset (anchors, aliases, tags, tab indentation, unterminated quotes). A misparse would
point an agent at the wrong technology guidance with full confidence, which is the one
outcome this tool exists to prevent. 28 tests cover the accepted subset and assert that
everything else is rejected. The YAML is compiled into `generated.ts` at build time
(`npm run gen:playbooks`) so the single-file bundle carries its playbooks; a test asserts
the generated file still matches the YAML, so a playbook edited without regenerating fails
CI instead of silently not existing.

Bugs the tests caught:

1. **Optional sections were treated as required.** A playbook omitting `official:`,
   `verify:` or `conventions:` was rejected outright, which invalidated every minimal
   playbook — including user-supplied overrides, so the whole merge path was dead.
2. **`deps: [java, kotlin]` could never match.** Playbook authors name ecosystems and
   languages, but those are emitted as *languages* by the detectors, not stacks. Matching
   now considers both, and the reason records which kind of evidence matched so confidence
   can weight a file match above a stack id above an inferred language.
3. **The CI fix was tiered `official`.** "Add a CI workflow that runs the documented verify
   commands" is an action derived from this repo's own gap; the GitHub docs link is
   supporting material. Calling it official put a repo-specific task in the
   external-guidance tier and inflated counts on repos with no matched playbook.
**Known refinement for M2b:** official guidance is currently unbounded, so a
well-matched repo shows more external suggestions than derived ones (anvil itself: 38
official vs 13 derived). Reading order is correct — derived first — but the plan should
stop offering guidance the repo already satisfies, so the list stays actionable rather
than browsable.

### M2b — complete (2026-09-28)

Delivered: `packages/derive` and `anvil brief` / `anvil init`. Detector count 6 → **12**.

The end-to-end loop, verified on every fixture:

| fixture | stacks detected | before | after init |
|---|---|---|---|
| node-npm | node, typescript, eslint, prettier, vitest | 67 | 92 |
| python-django | python, pep621, django | 55 | 81 |
| terraform-infra | terraform, terraform-aws, terraform-github | 45 | 69 |
| ruby-rails | ruby, rails, rspec, rubocop | 45 | 67 |
| php-laravel | php, laravel | 42 | 53 |
| elixir-phoenix | elixir, phoenix, ecto | 38 | 49 |
| swift-package | swift | 38 | 47 |
| frontend-vue | vue, vite, node | 38 | 63 |

**The self-referential test now asserts more than a rising score.** A rising score is not
sufficient evidence: the audit can improve by clearing a cosmetic rule while the blocker
that matters most stays failing. So the test additionally requires that `AGENTS_COMMANDS`
— the reason AGENTS.md exists — actually goes to `pass`. That immediately caught two bugs
the weaker assertion had let through, both of which meant anvil failed to recognize its
own output.

**Design decision worth recording.** `anvil init` generates a *working baseline* from
verified facts alone, with no model in the loop. The agent then improves the staged files
before `--apply`. This is better than "emit a brief and hope the model writes something
valid": `init` is useful standalone, the validator always has a real artifact to gate, and
the agent's edits are what land (their version wins, the baseline survives underneath).
Editing a staged file is reported as `tampered` but is *not* an error — that is the
intended workflow, not a violation.

The staleness contract was verified live: with a bundle staged, hand-editing `AGENTS.md`
and running `--apply` exits **8** and leaves the human's file untouched; the same happens
with no bundle at all. Both with a hint naming the next command.

Six more detectors: Ruby, PHP/Laravel, Elixir/Phoenix, frontend (Vue/Svelte/Vite/Next),
Swift, Terraform. Terraform is given priority **85** above the others, because an IaC repo
is a Terraform repo first and its playbook must win over a provider-specific one.

Bugs the tests caught in the new detectors:

1. **The audit could not see its own generated `AGENTS.md`.** `mentionsCommand` required a
   command to be preceded by whitespace, but in markdown it is wrapped in backticks, so
   `AGENTS_COMMANDS` stayed `fail` after an `init` that fixed it. The blocker cleared only
   once the leading-character class included markdown delimiters.
2. **`AGENTS_COMMANDS` over-fired on code-less repositories.** A repo with no source files
   has no verify commands to document, so failing it was a false positive — and a false
   positive teaches the reader to ignore the report. Now `na`, consistent with
   `BUILD`/`TEST`/`LINT`.
3. **The Terraform provider regex stopped at the first closing brace**, so only the first
   provider in a `required_providers` block was ever seen. Now reads provider identity
   from the `source = "org/type"` string, which is Terraform's own convention.
4. **Gemfile patterns anchored at column 0**, missing every `gem` line indented inside a
   `group` block — which is exactly where development tooling like rubocop is declared.
5. **The Rakefile idiom `RuboCop::RakeTask.new` takes no argument**, so it does not
   appear as a named task and was missed by task-name matching.

257 tests. Bundle 193.1 kB, still zero runtime dependencies.

**Remaining M2b refinement, deferred:** the unbounded-official-guidance issue noted above
is not fixed. `anvil plan` should stop offering guidance a repo already satisfies.

### M3 — complete (2026-09-29)

Delivered: `packages/git`, `packages/tickets`, `packages/providers`, `packages/worktrees`,
the `claim` / `release` / `status` / `issue` / `auth` commands, and the opencode plugin
with compaction-context injection.

**`packages/git` was extracted out of `core`.** Core had grown a `git.ts` in M0 for repo
discovery; worktree management does not belong there, and a dependency from core onto git
would have been circular. Core no longer knows about git at all.

**Shared state always resolves against the main worktree.** This was a real bug found by
running the flow for real, not by reading the code. `anvil issue refresh` run *inside* a
worktree looked for tickets in that worktree's own `.anvil/tickets/` — which does not
exist — so the mid-task refresh workflow the plan describes simply did not work. The
claims registry had the same flaw: a disposable worktree must not own the file that tracks
the other worktrees. `mainWorktreeRoot()` derives the main repo from the common git dir
and both now resolve through it.

**`.anvil/` is excluded through `info/exclude`, not `.gitignore`.** Writing a `.gitignore`
entry from `claim` dirtied every new worktree, and since `release` reports uncommitted
changes, **the clean release path was unreachable** — every claim had to be forced. The
exclusion is local-only, which is also exactly right for regenerated, company-internal
state. A test asserts a fresh claim leaves `git status --porcelain` empty.

Windows-first, as planned. The worktree root is a short **sibling** directory rather than
anything inside the repo, and preflight checks the path budget (180 chars, leaving room for
git's `.git/worktrees/<name>` companion path) — the failure that budget prevents surfaces on
*removal*, long after a successful create. Preflight also reports submodules, Git LFS and
sparse checkout, because each changes what a new worktree needs and none of them fail
loudly. A dirty base worktree **warns but does not block**: `claim` never switches your main
worktree's branch, so a dirty tree is not a reason to refuse.

Refusal, not guesswork, is the theme. A colliding branch is refused rather than suffixed —
a collision is nearly always a duplicate or stale claim, and appending a counter hides
exactly that. A blocked claim registers nothing and creates no branch, so there is no debris
to clean up. `release` refuses to discard uncommitted changes or unpushed commits unless
forced, and reports which of the two it found.

Verified end to end on a real repo: two tickets created, two claims, distinct worktrees and
branches, a comment added to ticket 1 mid-task, and `anvil issue refresh 1` run **from
inside the worktree** correctly delivering that comment to the agent's context. Status from
inside a worktree still sees every claim.

314 tests (up from 257), against real git repositories in temp directories rather than
mocks. Bundle 253.0 kB, still zero runtime dependencies — the plugin's
`@opencode-ai/plugin` is a dev-time type dependency, not a runtime one.

Two product bugs caught by running the real flow rather than the tests:

1. **`isValidBranchName` accepted spaces.** Git rejects them, and a space in a branch name
   becomes a space in a worktree path, which then breaks on Windows. Now rejected, along
   with control characters.
2. **A fresh claim always looked dirty**, for the `info/exclude` reason above.

## First move

**M4.** The `gh` transport, `ship` (verify → push → PR → ticket) and `issue sync`. The
risk the plan flagged for this milestone is real: `ship` is the seam where git, provider,
PR templates, CODEOWNERS and verify all meet for the first time. Budget 1.5–2x, and build
it early enough to fail.

### M4 — complete (2026-09-29)

Delivered: `packages/pr`, the `github` provider, the ship pipeline, and
`anvil ship` / `anvil issue sync` / `anvil auth github`.

**The transport is injected, not imported.** That single decision is what kept the seam
tractable: the entire ship sequence — refuse, verify, push, PR, ticket — is tested with no
network, no `gh`, and no real repository. 49 tests in `packages/pr`.

**Order is the design.** Refuse → verify → push → PR → ticket. The stages that can lose
work or leave debris on the remote run last, so **a failed verification means nothing
reached the remote at all**. `ship` refuses before pushing when the worktree has
uncommitted changes (ship ships commits, not a working tree) or when the branch has no
commits beyond its base. Verification is off by default — builds are slow and expensive, so
`--probe` opts in and `--skip-verify` acknowledges.

Risk is computed **from the diff, not from the ticket**. A PR touching a migration or a CI
workflow gets a checklist naming the files that triggered it, in the PR body *and* in the
ticket comment. A checklist that always says the same thing gets ignored, so it is
narrowed to what actually changed.

Reviewers come from CODEOWNERS. A ticket-update failure is reported but does **not**
discard the PR: the PR exists, and silently diverging the two systems is worse than a
partial result. The stage is marked failed and `anvil issue sync` closes the gap.

`gh` rather than the REST API, because it already handles auth refresh, Enterprise hosts
and enterprise proxying — none of which is where anvil's value is. The auth contract
probes the **detected host** and returns the login command naming it, so joining a company
with a GHE instance does not mean authenticating to the wrong one. Every call is
`execFile` with an argument array; there is a test asserting a ticket body containing
`; rm -rf / #$(whoami)` arrives as a single argv element, because ticket text is user input.

363 tests (up from 314). Bundle 291.2 kB, still zero runtime dependencies.

Three real bugs:

1. **`resolveReviewers` stopped at the first matching CODEOWNERS rule.** Git's rule is
   **last match wins**, so every review was going to the `*` catch-all — the exact opposite
   of what CODEOWNERS is for. Now every rule is checked and each match replaces the
   previous one, with a test for the override direction.
2. **`authStatus` called `gh` directly instead of through the injected runner**, making it
   the one untestable method in the transport. A test written to check it then read the
   *developer's real* `gh` identity and asserted against it. Now routed through the runner,
   so no test can touch real credentials.
3. **`GhForgeTransport.pushBranch` was wrong** — a stray `gh api` call, discarded results,
   and it reported success unconditionally. It now runs `git push -u` and returns the real
   outcome, which is what makes "a push failure stops the ship" true.

Verified: exit codes are correct on the shipped bundle (`ship` with no claim → 2, unknown
auth provider → 2, `version` → 0), and `anvil auth github` reports the real authenticated
identity when a GitHub remote is present.

### M5 — complete (2026-09-29)

Delivered: `packages/worktrees/src/crew.ts` and `anvil crew up|status|verify`.

**Claims are serialized, agents are not.** `git worktree add` mutates the repository's
shared administrative area, so claims run one at a time. Agents only touch their own
worktree, so they start concurrently. A refused claim does not stop the others: a crew of
three where one ticket is already claimed should still get two worktrees, not zero.

**Build caches are the real cross-contamination risk**, and it is invisible until a build
corrupts something. Gradle keeps mutable state in `~/.gradle`, Maven in `~/.m2`, npm and
pnpm and Yarn in their home caches, Bazel in a shared output base. So verification runs
under an explicit concurrency policy derived from the detected stacks, and **the decision is
always printed** — a tool that quietly serializes your builds and never says why is worse
than one that runs them all at once. Go and Cargo run concurrently (content-addressed cache,
or the tool takes its own file locks). `--force-parallel` overrides.

`crew verify` exits non-zero if **any** worktree fails, stops at the first failing command
within a worktree, and skips a vanished worktree rather than counting it as a failure.

Agents launch detached via `opencode run --dir <worktree>`, so they survive anvil exiting.
The agent prompt points at the context bundle rather than restating the ticket, and
**forbids pushing** — shipping is a human decision, and an agent that pushes is an agent
nobody reviewed.

### The Windows process bug

This milestone surfaced a defect that had been present since M3 and would have made the
tool **completely non-functional on Windows**: `execFile('npm', ...)` fails with ENOENT,
because `npm`, `npx`, `pnpm`, `yarn`, `bun` and `gradlew.bat` are `.cmd` shims and Node's
`uv_spawn` does not resolve PATHEXT. Every verify command, every `gh` call and every agent
launch would have failed. Found by running `crew verify` for real and reading the error,
which is exactly what a crew is supposed to do.

`packages/core/src/exec.ts` now resolves the binary on PATH itself, executes `.exe`
directly with an argument array, and only falls back to `cmd.exe` for actual shims — where
**arguments containing a character cmd would interpret are refused rather than escaped**.
The tool would rather decline to run a command than run the wrong one. Three Windows
quirks had to be satisfied together, each found by probing rather than reasoning:

1. `/s` must **not** be passed: it strips the first and last quote of the command line,
   which removes the inner quotes around a spaced path instead of the outer pair.
2. The binary path must be quoted. A default install is `C:\Program Files\nodejs\npm.CMD`,
   and unquoted, cmd treats `C:\Program` as the program.
3. `windowsVerbatimArguments: true` is required, because Node otherwise escapes embedded
   quotes to `\"` and cmd reports the quote characters as part of the filename.

A probe confirmed the refusal policy is not theoretical: `npm run test;whoami` **would**
execute through cmd if unquoted, which is why the argument check exists.

409 tests (up from 363). Bundle 315.0 kB, still zero runtime dependencies.

Verified end to end: four tickets claimed into four worktrees, `crew status` clean, real
commits in each, `crew verify` running real commands — 2 pass / 1 fail against a worktree
whose test script was deliberately broken, reporting the serialization reason and exiting 6.

### The agent launcher had never actually launched an agent

M5's closing note flagged that the launcher was only ever exercised through an injected
fake. Checking that gap on the real machine found a second instance of the same Windows
shim defect, in the one place it mattered most: `spawn('opencode', ...)` fails with ENOENT
because the npm-installed `opencode` is a `.CMD` shim. The crew would have reported
`started opencode (pid ...)` for every agent while nothing at all was running — the
worst kind of failure, because the output says everything worked.

`spawnArgv` in `core` now gives the detached launch the same shim handling as
`runProcess`, and three smaller things the fake had hidden:

1. **A spawn error is caught.** ENOENT arrives as an asynchronous `error` event, so
   unhandled it takes the whole process down — which would kill the agents already running
   in the other worktrees. It is now reported as a failed launch.
2. **The log file is actually written to.** `stdio: 'ignore'` meant the CLI's "logs at
   `<path>`" pointed at a file containing only anvil's own header. A detached agent has no
   terminal to report to, and when the run fails on a quota or an auth error, that log is
   the only evidence. stdout and stderr now go to the file, opened append-only so our
   header and the agent's writes do not race for the offset.
3. **The resolved path is recorded, not the bare name**, because a `.CMD` in
   `AppData\Roaming\npm` is the thing worth seeing in a log.

Verified by launching a real `opencode` against a real worktree: the shim is resolved,
the process starts, and the log fills with the agent's own output. The run itself failed
on a Gemini free-tier quota, which is an account fact rather than an anvil bug — but it
is exactly the failure that would have been invisible with the old logger.

416 tests (up from 409). Bundle 316.6 kB.

### M6 — complete (2026-09-29)

Two pieces done, two remaining. Done first because the deferred M2a/M2b defect was a known
wrong output in a shipped command, and it made the expanded registry unusable.

**The unbounded-official-guidance defect is fixed.** It was noted twice in this plan and
left alone, and running `plan` on anvil itself put a number on it: **14 derived, 38
official**. Reading the list showed why. Fifteen of the official entries were risk globs,
and a risk glob was suggested whether or not the repo had such a file — a Node repo with no
`pnpm-lock.yaml` and no Dockerfile was being told to treat both as high-risk. Advice about
files that do not exist is not advice.

Risk globs are now conditional on the repo having a matching file, and each one cites that
file as evidence, so the suggestion is checkable rather than asserted. The count went
**38 → 25 official** against the same 14 derived, and every remaining risk entry names a
file in the repository.

A second kind of duplication showed up once the registry grew: an Android repo matches both
`jvm` and `android`, and both declared `**/build.gradle.kts`, so the same advice appeared
twice. A contested risk glob is now claimed once, by the higher-priority playbook, which is
the one carrying the specific Android rules.

**The registry is at 15.** Added `android`, `go`, `rust`, `dotnet`, `ruby`, `php`, `elixir`,
`swift`, `terraform`, `kubernetes`, `docker` and `ci`. The last three match on files rather
than on a language, so a containerised Go service and a GitHub Actions workflow get
guidance the language playbooks cannot give. `android` outranks `jvm` for the same reason.

Two real bugs the expansion exposed, both from writing playbooks rather than from a test:

1. **The Ruby playbook listed `laravel` in `match.deps`.** A typo, and it made every PHP
   project match it, so `anvil plan` confidently recommended the Rails security guide to a
   Laravel codebase. Confident-and-wrong is worse than no match, because the reader has no
   reason to check. Fixed, and there is now a test asserting no playbook claims another
   ecosystem's framework.
2. **Three tests asserted the registry had exactly 3 playbooks.** They broke the moment a
   4th was added, and the tempting fix — editing `3` to `15` — would have re-broken them on
   the next addition. They now read the built-in count. A test that hardcodes a number the
   project intends to grow is a test that eventually gets deleted or weakened instead of
   fixed.

The `jvm` playbook also loses its Android resource: with a dedicated `android` playbook,
keeping Compose guidance in both printed the same URL twice.

Checked across all 16 fixtures: every one produces a plan, `cold-empty` correctly gets zero
playbook guidance, and the official tier now sits at or below the derived tier on 13 of 16
(the exceptions being `jvm-gradle` and `php-laravel`, which match two playbooks each and
therefore draw on two ecosystems' worth of documentation).

425 tests (up from 416). Bundle 316.9 kB.

### The ADR backlog is written

ADR-0001 through ADR-0005, all deferred since M2b. They were late by this milestone's own
rule, and the plan says why that is acceptable: the rule exists to stop an ADR recording a
guess, and by M6 none of these were guesses. Each had code exercising it, a bug found, or a
disagreement resolved.

**ADR-0005 reverses a decision this document still had wrong.** Open question 1 resolved
governance as "M6 scope", and §Blast-radius agreed. Both are corrected. The reasoning that
moved it: the PR body is assembled **once**, at the seam where git, the provider, templates,
CODEOWNERS and verification all meet. Governance is not a filter applied to a finished PR,
it is content in a body that is written exactly once — so arriving in M6 means rewriting the
step everything else depends on, with the riskiest interaction being the part most likely
to be wrong. It shipped in M4.

### Open question 3 was open because the loud logging was missing

The plan settled this as "do not block an inferred command, but log it loudly." The not-blocking
half shipped. The loud half never did: `ship --probe` ran inferred commands and reported the
result identically to a documented one, so a PR could list a guess beside a written-down
command as though they carried the same weight. A green result from `inferred` is a
considerably weaker claim, and the report should say so.

`verifyCommandEntries` now carries provenance through to the verify stage, and a passing
stage names what it was unsure about: `1 command(s) passed (inferred, not documented: make
check)`. A fully documented project makes no such claim. The rule "do not block" is
preserved — an inferred command is never a reason to refuse.

### Both packages are publishable, and the install is tested

The last mocked boundary in the project, closed by testing it rather than assuming it.

**The published binary reported the wrong version.** `scripts/build.mjs` injected
`npm_package_version`, which npm only sets for the package it is running a script *in* — and
the build runs from the workspace root, which is private and versionless. So every published
binary would have said `0.1.0-dev` forever. The kind of thing nobody notices until a bug
report arrives naming the wrong release. The version is now read from
`packages/cli/package.json`, which is the package the bundle ships as, and a test asserts
the two agree.

**`packages/cli` is published as `anvil`.** Unscoped, so the package name matches the binary
a user types; a scoped `@anvil/cli` would install as `anvil` but appear in `npm ls` as a
scope nobody chose. `files` is an allowlist containing only `dist/cli.js` — source and tests
are not shipped, and the bundle is the whole product. Zero runtime dependencies, which is the
entire reason for bundling: a dependency reintroduces the `npm install` that the single file
exists to avoid.

**`opencode-anvil` now ships compiled JS.** It exported `src/index.ts`, which opencode's
resolver has no transpiler for. That works from a checkout and fails the moment it is
installed — and only for users, never for us, which is the worst place for a bug to live. The
build emits `dist/index.js` plus a `.d.ts`, so the plugin's tools are typed in the host
editor rather than being `any` until they fail at runtime. The SDK is a **peer** dependency
and stays external: a second inlined copy would give the plugin a different `Plugin` type
than the host and the tools would not register.

**A packaging test that actually installs the tarball.** `npm pack` → `npm install` into a
throwaway consumer repo → run the installed `anvil.cmd` through `version --json`, `doctor
--json`, `issue create`, `claim` and `crew verify`. That last step matters: it is the only
check that exercises a real `npm run` through a shim from an installed bundle, which is
exactly the Windows defect that made the tool non-functional and that the unit suite could
not see, because the unit suite runs from the repo. A test also greps the bundle for
unresolvable bare imports, which is the strongest available proof it is self-contained.

One self-inflicted bug worth recording: a `"":` typo made the plugin's `package.json` invalid
JSON, and TypeScript's response was a baffling `TS1295 ... cannot be written in a CommonJS
file` on the plugin source. The message was about module syntax; the cause was an unparseable
manifest. A confusing error far from its cause is worth remembering, because the instinct is
to start changing tsconfig flags.

442 tests (up from 429). Bundle 351.9 kB — up from 317.0 kB, because 12 new playbooks
embedded ~35 kB of YAML-derived strings. The previous commit's figure was simply wrong.
(The review pass below found and fixed seven defects this milestone did not catch; the
442 were green while all seven were live.)

## First move

**M6 and the review pass are complete.** The remaining work, in the order it should be done:

1. **`anvil playbook add <path|url>`**, so a company playbook can be added without a fork.
   The rest of the `playbook` family now exists; this is the last piece of the
   extensibility claim.
2. **Run `anvil doctor` on ten real repositories** -- M1's exit criterion, still unmet.
   Pointing it at this one found nine defects, so the other nine are likely to as well.
3. **Governance decisions that need a human, not a tool**: CODEOWNERS, a PR template, a
   LICENSE. `anvil doctor` will keep reporting them until someone decides.
4. Publishing to the npm registry needs credentials and a decision about the package name,
   so it is prepared but not performed.

---

## Review pass — M6 hardening and dogfooding (2026-09-30)

A line-by-line review of every package, with the shipped bundle and the real `gh` CLI
probed directly rather than trusted. The suite was green at 442/442 throughout; **every
defect below was invisible to it**, and the reason is the same in all seven cases: the
defect lived *inside a mocked boundary*.

### The gh transport failed against real gh for every GitHub repository

`hostArgs()` returned `['--hostname', host]`, and it was appended to every call:
`issue view/list/create/comment/edit/close/reopen`, `pr view/create/edit`, `repo view`.
**Those commands do not have a `--hostname` flag.** Verified against gh 2.97:

```
$ gh issue view 1 --hostname github.com
unknown flag: --hostname
```

Only the `auth` family accepts it, which is exactly why `anvil auth github` reported
success while every other GitHub operation would have failed. gh resolves the host from
the repository's own remote for repo-scoped commands, so the flag was never needed. The
failure was also late rather than early: `ship` authenticates, **pushes the branch**, and
then dies creating the PR — the precise debris the refuse→verify→push→PR→ticket ordering
exists to prevent. `issue sync` reported "no open pull request" for PRs that existed.

The injected-runner tests could not catch this, because a fake runner accepts any argv.
The plan's own answer to that risk — a live suite behind `ANVIL_LIVE=1` — was written into
the testing strategy and never implemented.

### `crew up --launch` could never start an agent on Windows

`agentPrompt()` returns a multi-line document, and the Windows shim path **refuses** any
argument containing a newline (through `cmd.exe` a newline is a command separator, and the
module's stated policy is to refuse rather than escape). `opencode` is a `.CMD` shim. So
every launch threw:

```
Refusing to run `opencode`: an argument contains a character Windows cmd would interpret
```

The launcher tests all used single-line prompts (`'hello'`, `'hi'`, `'do the thing'`), so
the real prompt was never exercised. The M5 note's claim that a real launch was verified
cannot be true of the code as written. Fixed by writing the prompt to
`.anvil/agent-prompt.md` in the worktree and passing a single-line read instruction in argv:
the safety invariant is untouched, and hostile prompt text can no longer reach a command
line at all.

### `anvil config init` produced a config anvil rejected

The starter file contained `$schema`, which `mergeConfig` rejected as an unknown key — so
`config init` made every subsequent command in that repository exit 3, and the error's own
hint ("run `anvil config show`") was itself broken. The `$schema` also pointed at
`https://opencode.ai/config.json`, another tool's schema. There is no published anvil
schema, so the honest fix is to write no `$schema` at all and accept one if a user adds it.

### `init --apply` could never update a pre-existing `AGENTS.md`

`checkApplyPreconditions` compared the repository against the **staged** hash, which cannot
distinguish "the repo changed since staging" from "the repo always differed from what anvil
generates". On any repository that already had an `AGENTS.md` — the common case for a tool
whose job is improving an existing repo — apply was refused **forever**, with a message
claiming the file "has changed in the repository since the bundle was staged" when it never
had. The hint ("re-run `anvil init`") could not help, because re-running regenerated the
same differing content. The fix is to record the **repo-side** hash at staging time, which
is what makes the two cases distinguishable. The second apply remains a no-op, because
content identical to what would be written is always safe.

### Three smaller ship-path defects

- **`Closes gh-42`.** GitHub and GitLab only auto-close on a reference they can resolve
  (`#42`, `owner/repo#42`, or a URL). The human key is prose, so the ticket stayed open
  after merge, silently. The test asserted the wrong string.
- **`--reviewer '@@backend'`.** CODEOWNERS owners keep their `@`, and the transport
  prepended another. gh takes a bare handle or `org/team-name`; the unresolvable reviewer
  failed the PR create — after the push.
- **`claim --worktree-root` did nothing.** A duplicated object key meant the config value
  (often `null`) overwrote the flag on every call.

### The failure envelope said success

`init --apply`, `ship`, `crew verify`, `release` and `auth` all emitted a **success**
envelope (`ok: true`) with the error nested inside `data`, while returning a non-zero exit
code. Any consumer branching on `ok` — which is the documented contract, and what the
opencode plugin consumes — read a failed apply as a successful one. `FailureEnvelope` now
carries an optional `data`, and a new `ctx.outFailure` is the only way to report a failure
with a payload. Verified: `anvil init --apply --json` on a stale bundle now emits
`"ok": false`.

### Also fixed

- Verify commands were split on naive whitespace, so `--tests "*Changed*"` reached the
  process with literal quotes — a filtered run that matched nothing and still reported
  green. There is now a quote-aware `tokenizeCommand` (no shell, no expansion).
- **CODEOWNERS patterns containing a slash** are now anchored to the repo root, per
  GitHub's rule. `docs/*` previously also claimed `packages/docs/x`, over-assigning
  reviews to a team that never asked.
- **A staging manifest inside the repository was trusted.** `.anvil/staging/` is data in a
  repo anvil was told to run in, and a manifest with `../` paths would make `--apply`
  write attacker-chosen bytes outside the repository. Every target is now validated as a
  plain relative path. (The local ticket provider already guarded this class.)
- **`hasUpstream` was always true** for anvil's own `feat/...` branches — it echoed the
  branch name back and looked for a `/` in it — so `needsUpstream` was always false.
- **The fetch lock had no stale-lock recovery.** A killed process left the lock file
  behind and every later fetch in that repository timed out until someone deleted it by
  hand. The lock records its holder's pid; a dead holder is now broken.
- **`issue sync` did not check the ticket's provider**, so a local ticket on a
  GitHub-remote repo commented on the same-numbered GitHub issue. A closed-unmerged PR
  also mapped to `in_review` rather than back to work-in-progress.
- `build.mjs` preferred `npm_package_version` while its own comment explained why that
  variable is wrong.
- The packaging test used `spawnSync(..., { shell: true })` — reintroducing, in the test
  for the Windows-shim fix, the shell it exists to avoid. It now uses `runProcess`.

### The live suite found an eighth defect on its first run

`packages/providers/test/gh-live.test.ts`, run with `ANVIL_LIVE=1 npm run test:live`. It
records the argv the provider actually builds, then asks the installed `gh` which flags it
accepts — no credentials and no network required, which is what makes it affordable to run
often. The first run failed on:

```
gh issue create does not accept --json
```

`gh issue create` has no `--json` output, so `GitHubProvider.create` — and therefore
`anvil issue create` on GitHub — failed with "unknown flag" against real gh. It answers by
printing the new issue's URL, which is now parsed. Eight defects in one family, and the
mocked suite could not see a single one.

The suite was verified by reintroducing the `--hostname` bug and confirming it fails.

### Pointing anvil at itself found two more

The cheapest version of the ten-real-repositories exit criterion, and it paid for itself
immediately.

**The fixtures were the project.** anvil reported `vue`, `dotnet` and `terraform` for
itself, and offered `dotnet test` as a verify command, because `fixtures/` is a tree of
miniature repositories that exist to be detected. This is the exact failure mode the plan
names as unforgivable — confident and wrong — produced by the tool's own test data. The
walk now skips conventional test-data directories (`fixtures`, `testdata`, `__fixtures__`,
and a few more) for the same reason it skips `node_modules`: their contents are not the
code an agent will be asked to change. The error direction is the safe one, and
`followDirs` remains the escape hatch (now reachable through `buildProfile`).

**A false validator warning blocked the tool's own output.** The `@file`-reference check
fired on `@anvil/core` — a scoped package name in the module map the tool itself generates
— and `init --apply` refuses to apply while any warning stands. So the tool could not
apply its own AGENTS.md without `--allow-warnings`. The check now requires an extension,
which is what separates `@src/config.ts` from `@scope/package`.

### Dogfooding, measured

`anvil doctor` on this repository, before and after `anvil init --apply`:

| | before | after |
|---|---|---|
| score | 53 (D) | **75 (B)** |
| Orientability | 17 | **89** |
| `AGENTS_COMMANDS` (blocker) | FAIL | **ok** |
| `MODULE_MAP` | warn | **ok** (12/12) |
| false stacks (`vue`, `dotnet`, `terraform`) | 3 | 0 |

The staged `AGENTS.md` was then edited before applying — the designed workflow — to add
`npm run check`, the live suite, the "never invoke a shell" invariant, the envelope
contract, and the fact that `fixtures/` is excluded. anvil reported the edit as kept.

What it still fails is honest: no linter, no formatter, no CI, and no documented
changed-files test subset. Those are real gaps, not tool defects -- and the next section
closes them.

### Closing the gaps the tool found in itself

**Biome** (`biome.jsonc`), one devDependency, chosen because it lints *and* formats with a
single native binary and matches this codebase's existing style, so adopting it produced a
mechanical diff rather than a re-litigation of style. Three rules are off with the reason
recorded next to them: `noControlCharactersInRegex` (this code matches BOMs and NULs on
purpose), `noNonNullAssertion` (assertions appear only after a check that proves the value
is there), and `noConfusingVoidType` (the `Command` interface is genuinely
`Promise<number | void>`).

Adopting a linter is a lesson in its own right. The first `--write` silently reformatted the
whole repository with Biome's *defaults* — tabs, double quotes — because the comments in
`biome.jsonc` were not the problem; the problem was that a file named `biome.json` must be
strict JSON, and the config was being ignored. The tell was looking at a source file
afterwards and finding tabs. Nothing failed, no test broke, and the diff would have been
reviewed as "formatting".

**A changed-files test subset** (`scripts/test-changed.mjs`, `npm run test:changed`), which
is what `TEST_FAST` asks for and the rule the plan calls "the one that makes agents usable".
It selects whole workspace packages rather than files, widens to every package that depends
on a changed one, treats a root-config change as "run everything", and does nothing when
nothing relevant changed. Three bugs in it, all found by running it rather than reading it:
the dependency closure was keyed by manifest name while the change set speaks in directory
names, so the blast radius silently collapsed; `git status --porcelain` output was passed
through a `.trim()` that ate the leading status column, shifting every path by one
character; and a package with no test directory (`plugin-opencode`) crashed the full-suite
path. It reads git through `-z`, which also removes git's path quoting.

**CI** (`.github/workflows/ci.yml`): the plan's Windows/Linux/macOS matrix, Windows first,
every job running `npm run check` -- the same command `AGENTS.md` documents, because
`CI_PARITY` exists to catch exactly the case where those two diverge. The live `gh` contract
suite runs in its own job where `gh` is installed, so it cannot skip silently.

**And one more false positive, from adding CI.** `CI_PARITY` reported that this repository's
CI "does not appear to run: build, lint, typecheck" -- on a workflow that runs
`npm run check`, which runs all three. The rule token-matched the workflow body and could
not see through a composite script, so it named three specific gaps that did not exist. That
is the worst failure mode this tool has: a confident, checkable, wrong claim. The rule now
expands the npm scripts a workflow invokes, to a bounded depth, and `CI_PARITY` is `ok`.

### The score, after all of it

`anvil doctor` on this repository, over the whole session:

| | start | after the review | after dogfooding |
|---|---|---|---|
| score | 53 (D) | 75 (B) | **92 (A)** |
| Orientability | 17 | 89 | 94 |
| Operability | 63 | 63 | **89** |
| `AGENTS_COMMANDS` (blocker) | FAIL | ok | ok |
| `TEST_FAST` | FAIL | FAIL | **ok** |
| `LINT` / `FORMAT` | FAIL / warn | FAIL / warn | **ok / ok** |
| `CI` / `CI_PARITY` | FAIL / na | FAIL / na | **ok / ok** |
| false stacks from `fixtures/` | 3 | 0 | 0 |

470 tests (up from 442; 28 added, and every test that had encoded a bug now asserts the
corrected behaviour). Bundle 366.2 kB.

### `anvil playbook check` -- the rot mitigation, built

`anvil playbook list | show | check` shipped, and `check` is the mitigation risk 5 named and
M2a never delivered. Two layers, deliberately separated:

- **Structural checks** are pure and offline: a URL that is not absolute https, a resource
  with no `why`, a duplicate playbook id (the merge key, so one of them is silently unused),
  a risk glob claimed by several playbooks, and the same URL cited twice. Deterministic, so
  they live in the normal suite. The shipped registry is asserted to have **zero** structural
  errors -- a rot check that fails on the registry it ships with is a check nobody runs.
- **Reachability** probes every distinct URL with an injected `fetch`, bounded concurrency
  (six), a per-request timeout, `HEAD` falling back to `GET` on 405, and `--offline` to skip
  it entirely. The classification is the delicate part and is biased hard against crying
  wolf: **only 404 and 410 are rot.** A 403 from a bot wall, a 429, a timeout and a 5xx are
  all "unconfirmed" and never fail the build, because a check that goes red on a flaky
  network gets disabled, and a disabled rot check reads as coverage in every dashboard that
  counts green runs.

**It found six dead links on its first run**, which is the entire argument for it:

| dead | verdict |
|---|---|
| `github/actions` | the monorepo no longer exists; first-party actions are per-repo under `actions/` |
| `gruntwork-io/terraform-aws-project-layout` | gone, and both official "state per environment" pages had moved too |
| `sebastianbergmann/phpstan` | the project moved to `phpstan/phpstan` |
| `hexdocs.pm/elixir/design_patterns.html` | page restructured; now points at the `GenServer` docs its own `why` describes |
| `docs.gradle.org/.../upgrading_version.html` | moved to the compatibility page |
| `developer.android.com/.../jetpack-release-notes` | moved to `/androidx/releases` |

Each replacement was probed before it was written down, and the one entry with no honest
replacement was **deleted rather than repointed at something plausible** -- with a comment
saying to re-add it when a URL resolves. Guessing a replacement is how a registry starts
lying about things nobody has verified.

`SCHEMA_URL` in `schema.ts` was itself rot: it pointed at `docs/playbook-schema.md`, which
does not exist. Now the section of this document that actually specifies the format.

**One promise narrowed rather than faked.** The plan said check would "validate every URL and
version range". There is no version-range field anywhere in the schema, so there was nothing
to validate; a fake version check would have been theatre. The structural half that the data
*can* support is what shipped.

### What is still open

- **`anvil playbook add`** (`<path|url>`), the other half of the extensibility claim, and
  `playbook match` as a standalone view. `plan` already reports what matched, so `match` is
  redundant; `add` is not implemented.
- **The ten real repositories.** M1's exit criterion is still unmet; this repository is
  one, and it was enough to find nine defects, which is either an argument for doing the
  other nine or an argument that this one was badly served.
- Governance findings that need a human decision rather than a tool: no CODEOWNERS, no PR
  or issue template, no LICENSE, no SECURITY.md, no CONTRIBUTING.

### What the review says about the testing strategy

The suite is strong at sequencing and behaviour, and the pack→install→run test is the best
test in the repository. But it mocks two boundaries — the `gh` argv shape and the agent
launch prompt — and **all four critical defects lived inside those two mocks**. A mock
proves the pipeline calls what you told it to call; it cannot prove the thing you called is
a real command with real flags. The remaining high-value additions are a live suite behind
`ANVIL_LIVE=1` (as the testing strategy already promised) and a smoke test that runs the
real `agentPrompt` through the real shim path.

`anvil doctor` on anvil itself still fails `AGENTS_COMMANDS` — there is no `AGENTS.md` in
this repository. The tool has not yet been pointed at its own repo, which is the cheapest
possible version of the ten-real-repositories exit criterion.
