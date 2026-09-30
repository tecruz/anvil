# Contributing

The short version: **verify it, and let the diff be the explanation.** Two of those come
from problems this repository has actually had.

## Before you push

```bash
npm run check     # lint, typecheck, the whole suite, the build
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
