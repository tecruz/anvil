# anvil

An AI-ready dev harness. It audits a repository for AI-readiness, derives the agent context
from what it actually detects, and works tickets in parallel git worktrees.

The premise is narrow and falsifiable: an agent that cannot verify its own work produces
diffs nobody can review. So everything here is built around *evidence* — every command anvil
reports is backed by a file and a line number, and a rule that cannot prove its claim says so
rather than guessing.

## Install

Two channels:

```bash
npm install -g @anvil/cli
```

installs a prebuilt, versioned tarball from the npm registry — no build toolchain needed, zero runtime dependencies.

Or install directly from GitHub, which builds from source:

```bash
npm install -g github:tecruz/anvil
```

or without installing, for one run:

```bash
npx github:tecruz/anvil doctor
```

**Not `npm install -g anvil`.** That name belongs to an unrelated package on npm, and
the scoped `@anvil/cli` above is the one that works.

**Pin a tag if you care what you get.** A git install with no ref tracks the default branch,
so a breaking change reaches you on someone else's schedule — the same reason a lockfile
exists:

```bash
npm install -g github:tecruz/anvil#v0.1.0
```

The registry install is versioned by the package version itself:

```bash
npm install -g @anvil/cli@0.1.0
```

Three things worth knowing before you install:

- **It builds from source.** `dist/` is not committed, so npm runs the build during install.
  You need Node **22.18 or newer** — that is where running TypeScript directly (`node
  scripts/gen-playbooks.ts`, and the whole test suite) stopped needing a flag — and the first
  install takes a minute while it fetches the build toolchain.
- **No registry means no version resolution.** `anvil version` reports the version from the
  manifest, but there is no `anvil@0.2.0` to upgrade to. A tag is the closest thing to a
  release.
- **The binary is one file with zero runtime dependencies**, so once installed it runs in a
  locked-down network with no further installs.

## Use

```bash
anvil doctor            # audit this repository, with a score and the reasoning
anvil init              # derive AGENTS.md, a verify skill and a review command
anvil playbook check    # check the playbook registry for dead links
anvil playbook discover # find agent tooling the curated registry does not know yet
anvil mcp               # serve doctor, plan and crew status to an MCP client over stdio
```

Working a ticket is four commands: `anvil issue create`, `anvil claim` (branch, worktree and
the context an agent needs), `anvil crew verify`, `anvil ship`. Run `anvil --help` for the
rest, and add `--json` to anything for the versioned envelope the opencode plugin consumes.

Start with `anvil doctor` on a repository you know. If its findings are wrong, that is a bug
worth reporting - the tool was built by auditing twenty-seven real repositories, and the bugs
it found in itself are in [IMPLEMENTATION_PLAN.md](IMPLEMENTATION_PLAN.md) because they are
the interesting part.

**The [usage guide](docs/USAGE.md) is the manual**: what each command writes, how to
configure it, the environment variables, and the exit codes to script against.
[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) is for contributors: how the packages fit
together and where the state lives.

Inside opencode, the [plugin](packages/plugin-opencode/README.md) registers the same
tools for the agent, and keeps the ticket context alive when the conversation is
compacted.

## How it decides

- **Detection is evidence, not convention.** A command is reported because a file says so
  (`package-lock.json` means `npm ci`), and it is labelled `documented`, `detected` or
  `inferred` accordingly. A Go project gets no install command, because there is no install
  step.
- **"I don't know" is an answer.** A repository whose build system cannot be identified
  reports `na` and says why, rather than failing a blocker it has not earned.
- **Playbooks are executable configuration.** Their globs decide what counts as high risk and
  their verify commands are what a crew runs, so a playbook is validated before it is
  installed and never silently overwrites an existing one.
- **The curated registry stays curated.** `anvil playbook discover` fetches what a
  technology's own orgs have published since the last edit, caches it under `~/.anvil/`, and
  merges it into `plan` marked live and ranked below the entries a human reviewed. It never
  writes to `registry/playbooks/` — `--propose` prints the additions for a maintainer to
  merge.
- **Guidance has to earn its place.** The instruction file has a byte budget, and over it
  the commands have to be at the top: guidance an agent cannot infer from the repository is
  the part that pays for itself, and the rest is paid for on every request. A playbook
  resource can declare the files that mean the repository already follows it, and then the
  plan leaves it out and says how many it left out.
- **Cost is read, never recorded.** `anvil crew status --cost` prices the agent sessions
  with `ccusage`, which reads the usage logs already on the machine. anvil stores no usage
  data, uploads nothing, and a machine without ccusage still gets a complete report.

## Development

```bash
npm ci                  # install, and build the bundle (prepare runs on install)
npm run check           # lint, typecheck, the suite, the build, docs, and the eval gate
npm run test:changed    # only the packages your change affects, and their dependents
npm run setup:hooks     # once per clone: enable the pre-commit hook
```

`npm run check` is exactly what CI runs, on Windows, Linux and macOS, and a `CI_PARITY` rule
exists to catch the day those two stop agreeing. The docs check is part of it on purpose:
a document that names a command which does not exist, or a script the manifest does not
have, fails the build.

Architectural decisions are recorded in [docs/adr](docs/adr), the module map is in
[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md), and [CONTRIBUTING.md](CONTRIBUTING.md) has
the conventions.

## Status

Pre-1.0, and honest about it. The command surface may change; the install instructions above
are the supported path. Security reports go through GitHub's private vulnerability reporting
for this repository - the address and the fallback are in [SECURITY.md](SECURITY.md) - read
it before reporting, because it also says what is out of scope.

MIT licensed. See [LICENSE](LICENSE).
