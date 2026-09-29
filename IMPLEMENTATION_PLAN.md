# `anvil` — AI-Ready Dev Harness

> Implementation plan. Working name (`anvil`) is one field in `package.json` — rename freely.
> Status: **M0, M1, M2a, M2b and M3 complete**. Next milestone: **M4** (`gh` provider, `ship`, `issue sync`).
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
  templates/                      agents, commands, skills, AGENTS.md
  fixtures/                       mini repos, one per ecosystem
  docs/adr/                       architecture decision records
```

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
   **deferred to M6**.

That second use is what turns a linter into a permission system, but it is read-only
signal in v1: the risk map is computed and reported, and `ship` does not act on it until
M6. Both §Blast-radius and Open question 1 agree on this — governance is M6 scope.

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

```
anvil profile [--json] [--profile <dir>]
anvil doctor  [--json] [--layer <l>] [--strict] [--fail-on blocker] [--probe]
anvil plan    [--json] [--tier derived|official|community]
anvil brief   --for agents|commands|skills        # verified facts for the LLM step
anvil init    [--apply] [--only <artifact>]       # staging + diff; apply is explicit
anvil playbook list|match|show|add|check
anvil auth github [--check]

anvil issue pull <ref> [--refresh]     # -> .anvil/tickets/<key>.md context bundle
anvil issue show|list|comment|set-state <ref>
anvil issue sync [<ref>]               # two-way links, status, comments

anvil claim <ref> [--base <branch>] [--runner opencode|manual|none] [--open]
anvil release <key> [--delete-branch] [--force]
anvil crew up [--tickets a,b,c] [--from <query>] [--limit N] [--jobs N]
anvil crew status | verify [<key>]
anvil ship <key> [--draft] [--reviewers ...] [--no-ticket-update] [--probe]
```

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
| **M5** | `crew up` + parallel agent launch, `crew verify`, ref locking, `--jobs` | 3 tickets shipped in parallel by 3 agents |
| **M6** | `opencode-anvil` plugin (tools, toasts, `shell.env`), 15 playbooks, npm publish | plugin installs from npm; full documented flow works end to end |

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
  `argv → stdout`). Live suite behind `ANVIL_LIVE=1`, never in default CI.
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
   checklists?~~ **Resolved: no.** Plain PR in M4; governance (reviewer resolution +
   risk checklists) is M6, consistent with §Blast-radius. Recorded here so the decision
   has a home, and in an ADR once M0 lands.
2. **Worktree location**: `../<repo>-worktrees/<key>` (default, avoids nesting inside the
   repo) vs `.anvil/worktrees/` (self-contained, needs `git worktree` awareness). Default
   if unanswered: `../`.
3. **Detected command confirmation**: should `ship` require an explicit human confirm when
   a verify command is `inferred`? *Default if unanswered: no, but log it loudly.*

### Decisions get an ADR

`docs/adr/` is in the layout, so ADRs are scheduled, not aspirational. One ADR per
milestone, written when the milestone closes, covering the decisions taken in it. Unwritten
entries are listed as plain text, not links, so this document has no dead references.

| ADR | Decision | Status |
|---|---|---|
| ADR-0001 | The CLI/agent split (CLI deterministic, agent reasons) | determined, unwritten — writes with M2b |
| ADR-0002 | `gh` CLI as the first provider transport | determined, unwritten — writes with M3 |
| ADR-0003 | Diff-first writes + staging/apply lifecycle | determined, unwritten — writes with M2b |
| ADR-0004 | Governance (reviewers, risk checklists) deferred to M6 | determined, unwritten — writes with M6 |
| ADR-0005 | `local` provider as the API-egress escape hatch | determined, unwritten — writes with M3 |
| [ADR-0006](docs/adr/0006-single-file-bundle-location.md) | Single-file bundle lives in `packages/cli/dist` | **written (M0)** |

Each is written by the milestone that puts it under load, not before — an ADR for a decision
no code has exercised yet is a guess with a date on it.

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
