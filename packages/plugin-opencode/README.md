# opencode-anvil

The [opencode](https://opencode.ai) plugin for [anvil](../../README.md). It registers
anvil's tools inside the agent, keeps the ticket context alive across a compaction, and
records which session is running in which worktree.

It is deliberately thin: every tool shells out to the `anvil` CLI with `--json` and
returns the envelope. The CLI is the product; this is the wiring. The same behaviour is
available in Claude Code, in Cursor and in a raw shell, and nothing here is the only
copy of a rule.

## Requirements

- The `anvil` CLI on your `PATH` — the plugin runs it, it does not embed it:
  `npm install -g github:tecruz/anvil`.
- opencode, with the plugin loaded.

## Install

**From npm, once it is published:**

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["opencode-anvil"]
}
```

opencode installs npm plugins with Bun at startup and caches them in
`~/.cache/opencode/node_modules/`.

**From a clone, today.** The plugin is not on npm yet, so build it and point opencode
at the built file:

```bash
git clone https://github.com/tecruz/anvil.git
cd anvil && npm ci && npm run build
```

The build produces `packages/plugin-opencode/dist/index.js`. opencode loads plugin files
from `.opencode/plugins/` (per project) or `~/.config/opencode/plugins/` (per machine),
so a one-line file is enough:

```js
// ~/.config/opencode/plugins/anvil.js
export { default } from '/absolute/path/to/anvil/packages/plugin-opencode/dist/index.js'
```

Use an absolute path: opencode resolves the import from the plugin file's own
directory, and a relative path would depend on where you started it from.

## The tools

| Tool | Arguments | What it does |
| --- | --- | --- |
| `anvil_doctor` | `layer` | Audits the current repository for AI-readiness and returns the score, the per-layer breakdown, and every finding with file:line evidence and a fix. Read-only. |
| `anvil_plan` | `tier`, `limit` | Ranked fixes for the current repository, in the derived / official / community tiers. Guidance the repository already satisfies is left out. Read-only. |
| `anvil_ticket` | — | Reads the ticket this worktree was claimed for, including the acceptance criteria and the repository's verify commands. |
| `anvil_status` | — | Lists every active claim: branch, worktree, uncommitted changes, unpushed commits. Read-only. |

`layer` is one of `orientability`, `operability`, `context` or `governance`. `tier` is
one of `derived`, `official` or `community`.

## The hooks

Three, and each one exists because of a failure mode it prevents:

- **Compaction** (`experimental.session.compacting`) re-reads `.anvil/ticket.md` from
  disk and pushes it back into the context, with a line saying it is authoritative over
  anything summarized above. Ticket context dying at a compaction is the single worst
  failure of a worktree crew: the agent quietly forgets the acceptance criteria and
  keeps going, confidently. The bundle is re-read on every compaction rather than
  cached, so a comment added mid-task survives too.
- **Session recording** (`chat.message`) writes the opencode session id to
  `.anvil/session.json` in the worktree, once per session and never overwritten. The
  session id is the only thing that ties a conversation to a claim, and opencode is what
  chooses it — anvil launches the agent and never sees it.
- **Environment** (`shell.env`) forwards `ANVIL_TICKETS_DIR`, `ANVIL_PLAYBOOKS`,
  `ANVIL_CONFIG_HOME` and `NO_COLOR` into the shell the agent gets, but only when they
  are already set. It never invents a value and never stores a secret.

The session id is what makes `anvil crew status --cost` possible: the CLI asks the
host's usage ledger (ccusage) what a session cost, and the plugin is the only place both
the conversation and the directory are known. See
[ADR-0010](../../docs/adr/0010-cost-is-read-from-the-hosts-ledger.md).

## Troubleshooting

**A tool says `anvil doctor failed: ...`.** The CLI is not on the `PATH` the agent
runs with, or the command exited non-zero. Run the same command in the same directory
to see the real error; the tool surfaces the CLI's message, not a summary of it.

**`anvil_ticket` says there is no ticket context.** The directory is not an anvil claim,
or `anvil issue pull` has not been run in it. A claim writes `.anvil/ticket.md` into its
worktree.

**The cost report is empty.** Either ccusage is not installed, or the session id was
never recorded — which happens when the plugin is not loaded in the session you are
asking about. See [the usage guide](../../docs/USAGE.md#troubleshooting).

## Licence

MIT, same as anvil. See [LICENSE](LICENSE).
