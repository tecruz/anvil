# Contributing

The short version: **verify it, and let the diff be the explanation.** Two of those come
from problems this repository has actually had.

## Before you push

```bash
npm run check     # lint, typecheck, the whole suite, the build, the docs check
```

That is exactly what CI runs, on Windows, Linux and macOS. `anvil doctor` calls the same
thing out: this project has a `CI_PARITY` rule whose whole job is to catch the case where
the command in `AGENTS.md` and the command in CI are different. Running anything else
leaves the reader guessing which one is real.

**Before pushing, run `npm run ci:local`**, which is `npm ci` followed by `npm run check`.
The second half is not enough on its own, and finding that out the hard way is what this
line is for: `npm run check` never touches the lockfile, so a `package.json` change that
desyncs it -- renaming a workspace package, adding a dependency -- passes locally and then
fails CI on a machine that is not yours, at the one step a contributor would have run
anyway. The lockfile is committed, so a stale one is a real defect, not a local artefact.

While iterating, `npm run test:changed` runs the tests of the packages whose source changed,
widened to everything that depends on them -- usually a fraction of the full suite.

## Merging to main

This is a solo-maintainer repository: there is no second reviewer, so review requirements
are waived, but the checks below still have to pass before anything merges.

1. All five CI checks pass on the **final commit** of the PR:
   - `windows-latest`
   - `ubuntu-latest`
   - `macos-latest`
   - `playbook registry (rot check)`
   - `gh contract (live)`
2. `npm run check` passes locally (lint, typecheck, test suite, build, docs check, eval gate).
3. `npm run eval -- --fake-agent` passes and `npm run eval:check` passes.
4. No high-risk path (`.github/workflows/**`) is changed without flagging it in the PR
   description.
5. If any source under `packages/*/src/` changed, regenerate `eval-results/latest.json`
   with `npm run eval -- --fake-agent` and confirm `npm run eval:check` passes before
   merging — the gate binds summaries to the implementation hash.

**Branch protection is enforced.** Branch protection rules on `main` require all five CI
checks above to pass before a merge, branches must be up to date (strict mode), and
administrators cannot bypass the checks. Pull requests are required but need zero
approving reviewers — this is a solo-maintainer repository, so review requirements are
waived. Force pushes and deletion of `main` are blocked.

Configuration was applied via the GitHub API after making the repository public, since
rulesets require GitHub Pro on private repositories. The repository is now public.

## Once per clone: turn the hook on

```bash
npm ci && npm run setup:hooks
```

`setup:hooks` sets `core.hooksPath` to `.githooks`, and it is a separate step because
`core.hooksPath` is *local* git configuration -- it cannot be committed, so no clone can
inherit it. Without it there are no hooks, silently.

The hook checks formatting and lint on the staged files only, which takes about a second.
It does not run the test suite, deliberately: `npm run test` takes seconds, and a hook that
takes seconds is a hook people bypass with `--no-verify`, which is worse than no hook at
all. Tests and typechecking are CI's job, and `npm run check` before you push.

It also refuses to run when `node_modules` is missing, and says so, rather than failing with
"command not found" or -- worse -- passing without checking anything.

## What ships, and where from

There is no npm release. The distribution is the repository itself
(`npm install -g github:tecruz/anvil`), and that decides the manifest layout: **npm packs the
repository root for a git dependency**, and there is no subdirectory install — the fragment
after `#` is parsed as a git ref, not a path. So the root `package.json` is the package, with
`bin` pointing down into `packages/cli/dist/cli.js`. [ADR-0007](docs/adr/0007-distribution-git-install.md)
records the reasoning and supersedes the publish target in ADR-0006.

Two consequences for you as a contributor:

- **`npm ci` builds the bundle.** `prepare` runs `npm run build` on install, because
  `packages/*/dist/` is gitignored and a clone otherwise has no CLI. That is deliberate: the
  thing you test is the thing a user installs.
- **Two version fields exist and a test keeps them equal.** The root's version is the one that
  ships; `packages/cli` has one because npm expects it. If you bump a version, bump both —
  the test will tell you.

`npm pack` from the root produces exactly what a user receives, and the packaging test does
that, installs the tarball and runs the installed binary.

If you would rather not install anything globally, the equivalent is
`node packages/cli/dist/cli.js <command>` after `npm run build`.

## Things that will be asked

- **An unverified change is not a proposal.** State the command you ran and what it printed.
- **Explain why, not what.** The comments in this codebase are load-bearing; a comment that
  restates the line below it is noise, and one that says why a decision was made is what
  saves the next person an afternoon.
- **Do not weaken a check to make it pass.** If a test is wrong, fix the test and say why in
  the commit. If a rule is wrong, fix the rule and add the regression test that pins the
  behaviour you expected -- that is how every bug in this repository was found.
- **Never invoke a shell.** Every process call is `execFile` with an argument array. Ticket
  text, branch names and PR bodies are attacker-controlled in a repository the user does not
  own. The one exception is a Windows `.cmd` shim, handled in `packages/core/src/exec.ts`,
  which *refuses* an argument containing a character `cmd` would interpret rather than
  escaping it.
- **The `--json` envelope and the exit codes are contracts.** Success is
  `{ ok: true, data }`; failure is `{ ok: false, error }`. A failure that still has a payload
  carries it in `data` on the `ok: false` envelope. The opencode plugin consumes this, and
  exit codes are documented in `packages/core/src/errors.ts` -- do not renumber them.

## Style

Biome enforces formatting and lint (`biome.jsonc`); `npm run lint:fix` applies the safe
fixes. The three rules switched off have the reason recorded next to them, so read those
before deciding one of them is wrong.

## The documentation

The documents have different jobs, and putting two of them in one file is how a
document stops answering either question:

| Document | Its job |
| --- | --- |
| `README.md` | why anvil exists, and how to install it |
| `docs/USAGE.md` | the manual: what to run, what it writes, the exit codes |
| `docs/ARCHITECTURE.md` | the module map, the contracts, where the state lives |
| `docs/adr/` | one decision per document, with the alternatives that were rejected |
| `CONTRIBUTING.md` | the conventions, and what CI runs |
| `SECURITY.md` | how to report a vulnerability, and what is out of scope |
| `IMPLEMENTATION_PLAN.md` | the history: the design, the milestones, the defects |

Three rules, and they are the reason `npm run check` includes a docs check:

- **One fact, one place.** A command's flags are documented by `anvil <command> --help`,
  and the usage guide points at that instead of repeating it. If a document and the code
  disagree, the code wins and the document is a bug.
- **A named command is a real command.** `npm run check:docs` reads every document and
  fails when it names an `anvil <command>` that does not exist, an `npm run <script>` the
  manifest does not have, or a relative link that points at nothing. Documentation that
  names a command which was renamed is the same defect as a test that asserts a
  function that was deleted. The one exception is `IMPLEMENTATION_PLAN.md`: it is
  history, and history records the commands and scripts that existed at the time. Its
  links are still checked, because a link in a historical document is either right or
  broken.
- **Evidence is a file and a line.** `AGENTS.md` in this repository is generated, and its
  command entries cite where the command was found -- `CONTRIBUTING.md:38`, and so on.
  Editing one of those files moves the line numbers, so the citation is stale the moment
  you save. Run `anvil init` to see the diff and `anvil init --apply` to write it; do not
  hand-edit the generated file.

## Working on a ticket

```bash
anvil claim 42                 # branch + worktree + ticket context for an agent
anvil crew up --tickets 1,2,3  # several at once
anvil crew verify              # run the verify commands in each worktree
anvil ship <key>               # verify, push, open the PR, update the ticket
```

Agents launched by `crew up` are forbidden from pushing, on purpose: shipping is a human
decision.

## Data changes

`registry/playbooks/*.yaml` is hand-maintained data, and every URL in it can rot. After
editing one:

```bash
npm run gen:playbooks          # rebuild generated.ts; a test fails if you forget
anvil playbook check           # structural checks, plus every URL over the network
```

`check` runs in CI. If a link is dead, find the current URL and probe it before writing it
down; if there is no honest replacement, delete the entry rather than pointing it at
something plausible.

A resource may declare `satisfiedBy`: repo-relative globs whose presence means the
repository already follows that guidance, so the plan leaves it out and counts it. Two
rules make that honest. A glob must be a file whose presence really does imply the
guidance — `ruff.toml` means the repository uses Ruff, and `package.json` does not mean the
repository uses Ruff. And a `satisfiedBy` whose globs are all files the playbook itself
matches on is a defect, because the suggestion can then never be shown; `playbook check`
reports it.

## The harness that runs an agent

```bash
npm run eval -- --list                     # the scenario matrix and the model pair
npm run eval -- --dry-run                  # what a run would do, and it costs nothing
ANVIL_EVAL=1 npm run eval                  # what it would do, with an agent and a model
ANVIL_EVAL=1 npm run eval -- --models all  # small and frontier in one comparison
npm run eval -- --fake-agent --write-baseline  # hermetic bootstrap, no model is called
npm run eval:check                         # compare the last summary with the baseline
```

The matrix is four scenarios on purpose: `tiny` and `medium`, each once as a code change
and once as a verify-only task. A code-change scenario is graded by a hidden test copied
in after the agent finishes; a verify-only scenario is graded by the repository's own
verify command. Both matter, because context that helps a model write code can still fail
to help it read a repository.

The report records what a run cannot be understood without: the model, the opencode
version, the scenario and fixture hashes, the verify exit codes, and what the work cost.
Set `ANVIL_EVAL_MODEL` when the configured default is an image model, an exhausted free
tier or anything else that cannot do the task: a run that cannot name its model is not
comparable with the next one. `ANVIL_EVAL_MODELS` replaces the model pair, in
`small,frontier` order.

A scenario that fails is a finding, not a nuisance: read the transcript in
`eval-results/raw/` before changing the harness. `eval-results/latest.json` is the
summary the gate reads, `eval-results/baseline.json` is the checked-in expectation, and
both are committed; when the fixture, the scenario or the result changes, rerun the
harness with `--write-baseline` and review the diff like any other file.

`npm run check` runs the gate. When no baseline exists it passes and says so, because the
first run is a measurement; once a baseline is committed, a changed hash or a missed
expectation fails the check.

### The scheduled real-model benchmark

`.github/workflows/eval.yml` runs the small model over the same matrix every Monday, and on
demand:

```bash
gh workflow run eval.yml -f models=frontier
```

It is separate from `ci.yml` because it spends tokens and needs credentials. Configure
`OPENCODE_API_KEY` (the small, Zen model) and/or `OPENROUTER_API_KEY` (the frontier model)
as repository secrets or on the `eval` environment, then trigger it once by hand to prove
the setup. The job installs OpenCode 2 (`@opencode/cli@2.1.4`), removes the checked-out summary
before it runs, and finishes with `npm run eval:check`: a scenario that misses its baseline
expectation or records an agent error turns the run red. The complete summary is attached
to the run page, so a red build has its evidence next to it. Bump the pinned agent version
deliberately; the report is only comparable across runs that name the same agent.

Real-model runs require OpenCode 2. The harness runs `opencode run --standalone --auto`
from each scenario's directory so its private server receives the provider credentials
from the environment, without depending on a shared background service.

## The one suite that needs `gh`

```bash
ANVIL_LIVE=1 npm run test:live
```

The unit suite mocks the `gh` argv shape, and every defect found in the first review pass
lived inside that mock — `gh issue view --hostname` does not exist, `gh issue create` has no
`--json`. The live suite records the argv the provider builds and asks the installed `gh`
which flags it accepts, so it needs no credentials and no network. CI runs it in its own job
with `ANVIL_LIVE=1` set; without that variable the suite skips itself and reports zero tests,
which is why the workflow also fails a run where nothing passed.

`anvil playbook check` and the live suite are the only two checks that touch the network. If
you change a command anvil sends to `gh`, or edit a playbook URL, run both.
