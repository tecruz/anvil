# Architecture

How anvil is put together, and where each piece's state lives. The [ADRs](adr/) record
*why* each decision was made; this document records what the system actually is today.

## The pipeline

```
repository ──▶ profile ──┬──▶ audit ────▶ findings + score
                         ├──▶ plan ─────▶ ranked suggestions
                         └──▶ brief ────▶ verified facts for an LLM
                                          │
                              init ───────┘──▶ AGENTS.md, verify skill, review command

ticket ──▶ claim ──▶ worktree (+ .anvil/ticket.md) ──▶ agent ──▶ ship ──▶ pull request
```

Five stages, and the order is the design:

1. **Profile** — read the repository and describe it. Signature-based and
   non-executing: it reads files, never runs a build, so it is safe on a repository you
   have never seen and cannot modify. This is the only source of truth in the system;
   everything downstream is a function of it.
2. **Audit** — run the readiness rules over the profile. Every finding carries
   file:line evidence and a concrete fix. `anvil doctor` also presents the profile's
   repository-wide `Stack` list grouped by evidence directory ("Stack by location") when
   more than one location is present. That grouping is presentation only: it never adds a
   stack, changes playbook matching, or changes the JSON contract. The profile also reports
   `diagnostics.unanalysedDeps`: a module with `deps: []` is either analysed (a manifest was
   read and no internal edge was found) or unknown, and only the first is allowed to look
   like a negative finding. Go workspace `require` edges, Node workspace dependencies,
   Cargo path dependencies, uv workspace sources and Gradle `project(...)` calls are currently
   resolved; other ecosystems are declared unanalysed rather than silently empty. A uv
   dependency becomes an edge only when `tool.uv.sources` declares it local, and a Gradle edge
   only when the id is in the build's `include` set; a matching name is not enough.
3. **Plan / brief** — rank the gaps and emit the facts an LLM needs, so the model does
   the prose and anvil does the facts.
4. **Init** — write the derived context into the repository, through a staging bundle
   and a diff, so a human or an agent can review it before it lands.
5. **Claim / ship** — do the work in a worktree, and put it back on the remote in an
   order where a failure cannot lose anything.

`anvil ready` reads the profile, the matched playbooks and the owner-declared capabilities
and reports what an AI needs and whether it is present (`verified`, `blocked`, `unknown`).
It is non-executing unless `--check` is passed, and it proposes setup actions rather than
running them.

`anvil setup plan` derives inspect-only, content-addressed plans. The original proposal
covers owner-declared install commands; `--adapter local-skill` plans one create-only copy of
a repository-local `SKILL.md` into `.agents/skills/<name>/SKILL.md`, and
`--adapter pinned-skill` plans one file pinned to a GitHub commit after an explicit
`anvil setup fetch`. Executable adapters are
a closed registry: an adapter describes its plan and operations and never writes, while the
framework owns approval, locking, journaling and verification ([ADR-0021](adr/0021-setup-adapters-are-a-registry.md)).
Fetching is the only network step; it freezes bytes and an origin record in the protected
store, so planning, validation, approval and application stay offline
([ADR-0022](adr/0022-pinned-skills-are-fetched-then-offline.md)).
`anvil setup validate`
compares either saved plan with current inputs and a clean repository commit. `anvil setup
approve` records a separate, single-use approval grant outside the repository, and `approval`
and `revoke` inspect and withdraw it. `anvil setup apply` consumes that grant, holds a
repository lock, publishes the reviewed bytes without replacing anything, journals the
outcome beside the grant and independently verifies the installed artifact. Only a
registered setup adapter's plan can be approved or applied; owner-declared install commands
remain proposal-only. See [the setup plan contracts](SETUP_PLANS.md) for the schemas and limits.

The CLI never calls a model. It gathers verified facts, and hands them over. That split
is what lets the same behaviour work in Claude Code, in Cursor, in an opencode plugin and
in a raw shell.

Detection and audit are offline. `plan` and `brief` enrich the result: they add installed
skills, read a fresh discovery cache, and fetch for any matched playbook whose cache is
missing or expired. Online discovery uses playbook seeds rather than repository source and
writes derived results to the user's cache, never to the curated registry; `--offline` is
the explicit request for no network at all. See the
[detection/enrichment diagram](../README.md#local-detection-online-enrichment) and
[command modes](USAGE.md#offline-detection-and-online-discovery).

## The packages

Fourteen packages, one directory each, no package depending on a higher layer than its
own. The import graph below is the real one, read from the source.

| Package | Responsibility | Imports |
| --- | --- | --- |
| `packages/core` | Shared types, config resolution, argument parsing, the output contract, process execution | — |
| `packages/profile` | Stack detection: the `ProjectProfile` | — |
| `packages/audit` | The readiness rules engine, the findings, the score | `profile` |
| `packages/playbooks` | The guidance registry: loading, matching, planning, rot checks | `core`, `profile`, `audit` |
| `packages/discovery` | What the ecosystem published that the curated registry does not know, and the skills already installed on this machine | `core`, `playbooks` |
| `packages/derive` | The LLM seam: brief, generate, validate, diff, staging | `core`, `profile`, `audit`, `playbooks` |
| `packages/git` | Git operations, worktree preflight, path normalisation | `core` |
| `packages/tickets` | The canonical ticket model, reference parsing, and the provider interface | `core`, `profile` |
| `packages/providers` | The `gh`, Jira Cloud and local-markdown providers, the shared contract tests, and the one place a command resolves which provider to use | `core`, `tickets`, `worktrees` |
| `packages/pr` | Pull request construction: title, body, risk checklist, reviewers | `profile`, `tickets` |
| `packages/worktrees` | Claims, the crew, the ship pipeline | `core`, `git`, `pr`, `profile`, `tickets` |
| `packages/cli` | The command surface: parsing, help, output, exit codes, the stdio MCP server and the loopback dashboard | all of the above |
| `packages/dashboard` | The optional local read-only overview: a loopback HTTP server over CLI JSON and staging diffs | — (Node built-ins only) |
| `packages/plugin-opencode` | The opencode plugin: four tools, a compaction hook, a session recorder | — (it shells out to the CLI) |

Two consequences worth knowing:

- **The root manifest is the package.** The root `package.json` *is* the npm package
  ([ADR-0007](adr/0007-distribution-git-install.md)), and esbuild inlines every other
  package into one file, `packages/cli/dist/cli.js`. Zero runtime dependencies, one
  file, and it runs in a locked-down network. `packages/cli` keeps its own manifest for
  a future registry release, and the plugin has its own publish target, but neither is
  on npm yet: the root manifest is the install unit today.
- **The plugin contains no logic.** It registers four tools that call the CLI with
  `--json`, keeps the ticket context alive across a compaction, and records the session
  id. The same behaviour is available without it, which is the point: the plugin is a
  convenience, the CLI is the product.
- **The MCP server is a transport, not a second product.** `anvil mcp` exposes the same
  three read-only commands — `doctor`, `plan` and `crew status` — by running the CLI and
  returning its envelope, so an MCP client and a shell cannot disagree about what the
  tool said.
- **The dashboard is a view, not a second implementation.** `anvil dashboard` binds to
  loopback, requires a one-time session token, and presents `doctor`, `ready`, `plan`,
  `brief` and `crew status` JSON beside a read-only view of the staging bundle. A failed
  source is reported beside the others, and verification is `unavailable` rather than
  green by absence ([ADR-0025](adr/0025-local-dashboard.md)).

## Tickets and providers

A ticket command resolves its provider once, in `packages/providers/src/resolve.ts`, from:

1. `--provider local|github|jira` on the command,
2. `provider.default` from the resolved configuration,
3. the reference's own provider — a ticket URL, or a `gh-42` key,
4. `local`.

The reference is parsed against the selected provider, and the claim registry records the
provider that was actually used, so `ship` and `issue sync` never have to guess. An
unknown provider is refused with the list of the supported ones; a GitLab URL is
recognised and refused that way rather than parsed as a local ticket.

| Provider | Transport | Account | Network | Capabilities | State mapping |
| --- | --- | --- | --- | --- | --- |
| `local` | markdown files in `ANVIL_TICKETS_DIR` | none | none | `create`, `list`, `comment`, `transition`, `link` | native `state:` frontmatter |
| `github` | `gh`, always `execFile` with an argument array | `gh auth login` | yes, through `gh` | `create`, `list`, `comment`, `transition`, `link` | open/closed; `in_progress`, `in_review`, `wontfix` are labels |
| `jira` | Jira Cloud REST API v3 over `fetch`, injectable for tests | `JIRA_EMAIL` + `JIRA_API_TOKEN` | yes | `create`, `list`, `comment`, `transition`, `link` | status category, status name for review, resolution for `wontfix` |

Three implementation rules make the GitHub provider honest:

- **A URL names its repository.** `fetch`, `comment` and `transition` pass `--repo
  <host>/<owner>/<repo>` when the ref carries a ticket URL, so a pasted link is never
  silently resolved against the checkout anvil happens to run in. A ref whose URL cannot
  name a repository is refused instead of re-aimed. The URL is parsed once, in
  `@anvil/tickets`: the issue marker is found from the end of the path, so a repository
  literally named `issues` or `pull` still yields the issue number. `ship` reuses the id
  and URL stored in the claim rather than re-deriving them.
- **An unreadable list is not an empty list.** `list` throws on a non-zero `gh` exit or a
  body that is not a JSON array. Callers treat empty as "no work", so an error there would
  otherwise look like a finished backlog. Label-emulated states are filtered client-side
  from the `state` and `labels` fields, using the same function `fetch` uses, because no
  `gh` flag can express "open but not `in-review`". Because `gh issue list` has no cursor,
  a page that is entirely filtered out is retried with a larger limit; stopping at a fixed
  page size would report no ready work while a ready issue sat just past it. `gh` caps that
  limit at 1,000, so when the maximum page is still full and no wanted match has appeared,
  `list` reports an incomplete result instead of returning the filtered subset as final.
- **A transition is the whole state.** After closing or reopening as needed, one `gh issue
  edit` adds the desired state label and removes the other state labels in the same call,
  so `in_review → todo` leaves `todo` rather than a stale `in-review`.

Three rules make the Jira provider honest:

- **Credentials are environment only.** `JIRA_EMAIL` and `JIRA_API_TOKEN` are read at the
  moment a request is built and never copied onto the provider or into a ticket, error or
  log. The default transport is the built-in `fetch`; `JiraOptions.request` is the seam the
  tests inject, so no test reaches the network.
- **Bodies are converted, not reinterpreted.** Jira Cloud stores descriptions and comments
  as Atlassian Document Format. `packages/providers/src/adf.ts` converts ADF to markdown on
  read and back on write, including task lists as literal checklist bullets so the shared
  acceptance extractor works. Ticket text is never treated as markup for anything except
  ADF, and an unknown node keeps its text rather than disappearing.
- **Transitions are workflow-driven.** The provider asks the issue which transitions are
  available *now* and maps the target state onto them. `in_review` is a review-shaped
  status name within Jira's `indeterminate` category; `wontfix` needs a done status whose
  transition offers a rejection resolution. A target the workflow cannot reach is refused
  with the available names, not silently skipped. `list` narrows with JQL and follows
  `nextPageToken`; reaching the page cap is an explicit incomplete-listing error.

The provider deliberately speaks only Jira Cloud's REST API v3. Jira Server and Data Center
have a different REST surface and deployment model; a client that pretends to cover both
produces authentication failures nobody can diagnose
([ADR-0024](adr/0024-jira-cloud-rest-v3.md)).

All three implement the same `TicketProvider` interface and pass the same contract tests
(`packages/providers/test/contract.test.ts`), including the same states and comment
semantics — that is what keeps `local` a real provider rather than a test double
([ADR-0004](adr/0004-local-provider-as-egress-escape-hatch.md)). Acceptance extraction is
shared where the providers can share it: local reads unchecked checklist entries
(`packages/providers/src/local.ts`), GitHub also reads checked entries and headed
sections (`packages/providers/src/github.ts`), and Jira converts its ADF task list to the
same checklist markdown before extracting
(`packages/providers/src/acceptance.ts`).

`ProviderCapabilities` is the contract commands check before acting. A missing capability
fails the command with the capability named (`cannot create a ticket: missing the "create"
capability`), never with a transport error from inside the provider.

Resolution itself does no I/O, and `local` is built without touching `gh`: a machine with
no account, no network and no GitHub CLI keeps the whole ticket workflow. Detection,
audit and `doctor` do not build a provider at all, so they gained no network call from
this.

A separate read-only detector in `packages/profile/src/trackers.ts` reports *candidates*
for a tracker from local files: issue templates, contributor/security/README text, issue-key
conventions and the remote host. It cannot prove a server-side fact such as "Issues
enabled", so its contract is a candidate set with `file:line` evidence and a confidence,
never a verdict; two plausible kinds are `unconfirmed`, and no evidence is `na`. `doctor`
prints that set as information and carries it in `data.tracker`. Nothing writes it to
configuration, and provider resolution never reads it: only `provider.default`, the flag
and the reference decide which provider runs.

## The contracts

Everything that crosses a package boundary is a typed object, and every payload that is
published — the profile, the report, the plan, the brief, the envelope — carries a
`schemaVersion`, published rather than implied.

| Contract | Defined in | What it carries |
| --- | --- | --- |
| `ProjectProfile` | `packages/profile/src/types.ts` | the repository as facts: languages, modules, stacks, commands, tooling, docs, risk paths, instruction files, and `diagnostics` for scan completeness |
| `Finding` | `packages/audit/src/types.ts` | one rule's verdict: `pass`, `warn`, `fail` or `na`, a severity, evidence, and a fix |
| `Plan` | `packages/playbooks/src/plan.ts` | ranked suggestions in three tiers, with the satisfied ones counted and left out |
| `Brief` | `packages/derive/src/brief.ts` | verified facts, the `gaps` that keep generated guidance honest, the evidence-use rules, and the context questions anvil did not answer |
| `ReadyReport` | `packages/derive/src/ready.ts` | what an AI needs and whether it is here: commands, tools, environment, services, references, credentials, access, hardware, context, and the setup actions proposed (never run) |
| `Ticket` | `packages/tickets/src/index.ts` | the canonical ticket: the provider's own `state`, a normalized one, and the raw payload |
| `Envelope` | `packages/core/src/output.ts` | the `--json` shape: `{ schemaVersion, ok, command, data \| error }` |
| `ExitCode` | `packages/core/src/errors.ts` | the process exit code, which is public and does not change |

Three rules hold across the system:

- **Evidence or nothing.** A finding without a file and a line is a guess, and a guess
  is reported as `na` rather than dressed up as a `fail`.
- **Unknown keys are errors.** A configuration file with a typo in it fails on day one
  rather than silently doing nothing for a year.
- **The `ok` flag is the truth.** A command that failed but still produced a payload
  keeps that payload in `data` on an `ok: false` envelope, never in a success envelope.

## Where state lives

| Where | What | Lifetime |
| --- | --- | --- |
| `<repo>/.anvil/staging/` | the `init` bundle and its manifest | until the next `init` |
| `<repo>/.anvil/tickets/` | local markdown tickets | until you delete them |
| `<repo>/.anvil/claims.json` | the claim registry, always in the **main** worktree | until a claim is released |
| `<worktree>/.anvil/ticket.md` | the ticket context bundle an agent reads first: the task, verify commands, high-risk paths, and up to five optional resources matched to the ticket, with ticket text fenced as untrusted | regenerated by `issue refresh` |
| `<worktree>/.anvil/AGENTS.md` | the worktree's rule overlay | regenerated with the bundle |
| `<worktree>/.anvil/hooks/` | the `pre-push` push guard and wrappers for the repository's own hooks | per claim |
| `<worktree>/.anvil/session.json` | the agent session id, written by the plugin | per session |
| `~/.anvil/config.json` | the global configuration | your machine |
| `~/.anvil/playbooks/` | your installed playbooks | your machine |
| `~/.anvil/approvals/setup/v1/` | single-use approval grants, the application journal, and the fetched pinned-skill cache, deliberately outside the repository | until expiry, revocation or use; the terminal journal stays for inspection |
| `~/.anvil/cache/discovery/` | the discovery cache | your machine |
| `<repoParent>/<repoName>-worktrees/` | the worktrees, deliberately outside the repository | until released |

The claim registry lives in the main worktree because the worktrees are disposable and
the registry must outlive them: a crew of five is five worktrees and one state file, so
`anvil status` can answer "what is in flight" from any of them.

`.anvil/` is kept out of git through the repository's `info/exclude`, not through
`.gitignore`. An ignore-file edit would dirty the working tree on every claim, and
`release` reports uncommitted changes, so the clean path would become unreachable.

The push guard lives in the worktree rather than the repository. `core.hooksPath` is
normally shared by every worktree, so the claim enables `extensions.worktreeConfig` and
sets the path with `git config --worktree`: the agent's worktree refuses pushes unless
`ANVIL_SHIP=1`, and a human pushing from the main worktree is untouched. Existing repo
hooks are wrapped and dispatched, because a guard that silently replaces a husky
`pre-commit` would trade one blind spot for another.

## The build

```bash
npm run gen:playbooks   # registry/playbooks/*.yaml -> packages/playbooks/src/generated.ts
npm run build           # esbuild -> packages/cli/dist/cli.js, and the plugin bundle
npm run check           # lint, typecheck, the whole suite, the build, the docs check, the eval gate
```

`eval:check` reads `eval-results/latest.json` against `eval-results/baseline.json`. The
summary names the run that produced it; the gate reads that run's full record from
`eval-results/runs/<runId>.json` and falls back to `eval-results/run.json` only when it is
the same run. A later partial or `--scenario` subset run may therefore overwrite
`run.json` without taking away the provenance of the last complete summary. Per-run
checkpoints live under `eval-results/checkpoints/` and raw output under
`eval-results/raw/`; both are ignored and uploaded only as bounded CI artifacts. Promoted
run records are committed with the summary.

The committed summary is hermetic (`fake-agent`) evidence only, so a real-agent benchmark
is gated by a separate command. `npm run eval -- --check-run <runId>` validates the named
run record against the same baseline and provenance checks, refuses a `fake-agent` record,
and writes `eval-results/benchmark-summary.json`, which is labelled `real-agent` and
ignored by Git. It never reads or writes `latest.json`. The scheduled `Eval benchmark`
workflow uses this gate, and normal CI keeps using `eval:check`; a record cannot be
validated by the other channel's gate.

The summary records a hash of the anvil sources that produced it, so a stale run cannot
vouch for a newer implementation. The run record also records the harness digest, Node and
OpenCode versions, transcript policy, model set, and whether the run was a subset.
`--resume` refuses any run whose inputs differ, validates every checkpoint before
recovering it, and never promotes a subset or partial run. A terminal attempt is settled:
a failed key stays in the scored results with its error and is never retried, so a later
success cannot replace it in a comparison. Transcripts are empty by default;
`--publish-transcripts` opts in, and every persisted transcript, error, and verifier output
is redacted and size-limited first.

Resume fails closed rather than guessing when the record and its checkpoints disagree:

- A checkpoint that cannot be read or parsed is a refusal when its filename maps to a
  declared key the record has not settled. Rerunning that key could overwrite evidence the
  run already holds, so `run.json` is left unchanged. The same file is only a warning when
  its key is already settled, or when its name maps to no declared key, because neither can
  cause a rerun. A readable checkpoint that fails verifier-evidence validation is still
  ignored: the missing key is recovered or rerun, as before. A `.json` entry that is not a
  regular file, including a dangling symlink, is treated as unreadable with reason
  `checkpoint is not a regular file`.
- Overlapping resumes: a checkpoint for a key the record has settled is refused when it
  reports a different latest state, a different attempt (timestamps or verdicts) at the same
  attempt count, or more attempts than the record. A recorded terminal failure
  (`failed` / `timed-out`) is final; a later completed or longer checkpoint never replaces
  it. The completed checkpoint written beside the record before that same attempt failed is
  stale, so it is ignored rather than refused. There is no lock, so this only catches a
  conflict already visible when the later resume starts; two resumes that start together can
  still race.
- A result in `run.json` whose key is not in that run's declared key set is refused, since
  resuming would score evidence the run never produced.
- A fresh run (no `--resume`) archives an unarchived `partial`, `failed` or `in-progress`
  record under `eval-results/runs/<runId>.json` before starting a new run id, so scored
  failures and other settled work from the unfinished run survive. This includes an
  unfinished subset; a completed subset is not archived. An existing archive of the same run
  id is never overwritten.

A recorded failed attempt is a scored run error even when the top-level `error` is missing:
scoring copies the attempt's error, or a stable fallback message when the attempt has none,
so an inconsistent record cannot read as task success.

Captured verify-only checks use a harness-provided `node` launcher. Its parent-process
broker executes a Node ESM source snapshot captured before the agent starts, using an
absolute runtime, and keeps source hashes and actual exits in memory. Shell events must
match those executions; an equal exit code or a restored script is not sufficient.
Invalid capture vetoes both verifier verdicts, even if an agent forges an on-disk log.
The launcher is not secret and cannot submit source or attest to results. This protects
execution provenance, not against native processes attacking the host; it is not an OS
sandbox. Capture currently supports standalone Node ESM main scripts.

New baselines, summaries, run records, and checkpoints use evidence schema version 2.
Readers retain version 1 for historical inspection: missing verifier declarations/counts
and the initial fixture snapshot remain unknown (`null`), never inferred from results.
Legacy records cannot be resumed or promoted; a new run is required to produce version 2
evidence. A historical baseline can still be compared with new evidence when the current
scenario matrix supplies its verifier declarations.

Recovery, resume, promotion, and gate checking share verifier-evidence validation against
the scenario's declared visible and hidden commands. An internally consistent but truncated
checkpoint is rejected rather than reused as completed work. If the optional current matrix
is omitted from the gate API, the baseline's declarations are used instead. Resume refusal
does not persist recovered state or replace the previous complete summary or its archive.

`gen:playbooks` exists because a single-file CLI cannot read a directory of YAML at
runtime, so the registry is compiled in. The authoring format stays
`registry/playbooks/*.yaml`, and a test fails if the generated file is stale — the
generator is the documentation of the format.

The build is deliberately boring: esbuild, one entry point, node built-ins left
external, everything else inlined. `ANVIL_MINIFY=1` and `ANVIL_SOURCEMAP=1` are
available when you want them.

## The rules that hold everywhere

These are not style preferences. Each one is a bug that was found and fixed.

- **Never invoke a shell.** Every process call is `execFile` with an argument array.
  Ticket text, branch names and pull request bodies are attacker-controlled in a
  repository the user does not own.
- **Refuse rather than guess.** A claim that cannot succeed is refused before it
  creates anything. A branch that already exists is refused, not suffixed — a collision
  is nearly always a duplicate or a stale claim, and a counter hides exactly that.
- **A rule that cannot decide says `na`.** A docs-only repository has no build, and
  failing it for that is padding the report with false positives.
- **Cost is read, never recorded.** `anvil crew status --cost` prices sessions with
  `ccusage`, which reads the usage logs already on the machine. anvil stores no usage
  data and uploads nothing.
- **The guidance has to earn its place.** An instruction file has a byte budget, and
  the commands have to be at the top ([ADR-0009](adr/0009-guidance-has-to-earn-its-place.md)).

## Where to read next

| Document | What it answers |
| --- | --- |
| [ADR-0001](adr/0001-deterministic-cli-agent-reasons.md) | why the CLI is deterministic and the model writes prose |
| [ADR-0002](adr/0002-gh-cli-as-first-transport.md) | why `gh` is the first transport |
| [ADR-0003](adr/0003-diff-first-staging-lifecycle.md) | why nothing is written before a diff |
| [ADR-0004](adr/0004-local-provider-as-egress-escape-hatch.md) | why the local markdown provider exists |
| [ADR-0005](adr/0005-governance-ships-in-m4.md) | why governance shipped early |
| [ADR-0006](adr/0006-single-file-bundle-location.md) | why the bundle lives in `packages/cli/dist` |
| [ADR-0007](adr/0007-distribution-git-install.md) | why the distribution is a git install |
| [ADR-0008](adr/0008-live-discovery-keeps-registry-curated.md) | why discovery never writes to the registry |
| [ADR-0009](adr/0009-guidance-has-to-earn-its-place.md) | why instructions have a budget |
| [ADR-0010](adr/0010-cost-is-read-from-the-hosts-ledger.md) | why cost is read and never stored |
| [ADR-0021](adr/0021-setup-adapters-are-a-registry.md) | why setup adapters are a closed registry that never writes |
| [ADR-0022](adr/0022-pinned-skills-are-fetched-then-offline.md) | why a pinned skill is fetched once and then planned offline |
| [ADR-0024](adr/0024-jira-cloud-rest-v3.md) | why the Jira provider speaks Jira Cloud REST v3 only |
| [ADR-0025](adr/0025-local-dashboard.md) | why the dashboard is a read-only view over CLI JSON |
| [IMPLEMENTATION_PLAN.md](../IMPLEMENTATION_PLAN.md) | the design, the milestones, and the defects each one found |

The [usage guide](USAGE.md) is the other half of this document: what to run.
