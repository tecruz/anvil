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
   file:line evidence and a concrete fix.
3. **Plan / brief** — rank the gaps and emit the facts an LLM needs, so the model does
   the prose and anvil does the facts.
4. **Init** — write the derived context into the repository, through a staging bundle
   and a diff, so a human or an agent can review it before it lands.
5. **Claim / ship** — do the work in a worktree, and put it back on the remote in an
   order where a failure cannot lose anything.

The CLI never calls a model. It gathers verified facts, and hands them over. That split
is what lets the same behaviour work in Claude Code, in Cursor, in an opencode plugin and
in a raw shell.

## The packages

Thirteen packages, one directory each, no package depending on a higher layer than its
own. The import graph below is the real one, read from the source.

| Package | Responsibility | Imports |
| --- | --- | --- |
| `packages/core` | Shared types, config resolution, argument parsing, the output contract, process execution | — |
| `packages/profile` | Stack detection: the `ProjectProfile` | — |
| `packages/audit` | The readiness rules engine, the findings, the score | `profile` |
| `packages/playbooks` | The guidance registry: loading, matching, planning, rot checks | `core`, `profile`, `audit` |
| `packages/discovery` | What the ecosystem published that the curated registry does not know | `core`, `playbooks` |
| `packages/derive` | The LLM seam: brief, generate, validate, diff, staging | `core`, `profile`, `audit`, `playbooks` |
| `packages/git` | Git operations, worktree preflight, path normalisation | `core` |
| `packages/tickets` | The canonical ticket model and the provider interface | `profile` |
| `packages/providers` | The `gh` and local-markdown providers | `core`, `tickets`, `worktrees` |
| `packages/pr` | Pull request construction: title, body, risk checklist, reviewers | `profile`, `tickets` |
| `packages/worktrees` | Claims, the crew, the ship pipeline | `core`, `git`, `pr`, `profile`, `tickets` |
| `packages/cli` | The command surface: parsing, help, output, exit codes | all of the above |
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

## The contracts

Everything that crosses a package boundary is a typed object, and every payload that is
published — the profile, the report, the plan, the brief, the envelope — carries a
`schemaVersion`, published rather than implied.

| Contract | Defined in | What it carries |
| --- | --- | --- |
| `ProjectProfile` | `packages/profile/src/types.ts` | the repository as facts: languages, modules, stacks, commands, tooling, docs, risk paths, instruction files, and `diagnostics` for scan completeness |
| `Finding` | `packages/audit/src/types.ts` | one rule's verdict: `pass`, `warn`, `fail` or `na`, a severity, evidence, and a fix |
| `Plan` | `packages/playbooks/src/plan.ts` | ranked suggestions in three tiers, with the satisfied ones counted and left out |
| `Brief` | `packages/derive/src/brief.ts` | verified facts and the `gaps` that keep generated guidance honest |
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
| `<worktree>/.anvil/ticket.md` | the ticket context bundle an agent reads first | regenerated by `issue refresh` |
| `<worktree>/.anvil/AGENTS.md` | the worktree's rule overlay | regenerated with the bundle |
| `<worktree>/.anvil/session.json` | the agent session id, written by the plugin | per session |
| `~/.anvil/config.json` | the global configuration | your machine |
| `~/.anvil/playbooks/` | your installed playbooks | your machine |
| `~/.anvil/cache/discovery/` | the discovery cache | your machine |
| `<repoParent>/<repoName>-worktrees/` | the worktrees, deliberately outside the repository | until released |

The claim registry lives in the main worktree because the worktrees are disposable and
the registry must outlive them: a crew of five is five worktrees and one state file, so
`anvil status` can answer "what is in flight" from any of them.

`.anvil/` is kept out of git through the repository's `info/exclude`, not through
`.gitignore`. An ignore-file edit would dirty the working tree on every claim, and
`release` reports uncommitted changes, so the clean path would become unreachable.

## The build

```bash
npm run gen:playbooks   # registry/playbooks/*.yaml -> packages/playbooks/src/generated.ts
npm run build           # esbuild -> packages/cli/dist/cli.js, and the plugin bundle
npm run check           # lint, typecheck, the whole suite, the build, the docs check
```

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
| [IMPLEMENTATION_PLAN.md](../IMPLEMENTATION_PLAN.md) | the design, the milestones, and the defects each one found |

The [usage guide](USAGE.md) is the other half of this document: what to run.
