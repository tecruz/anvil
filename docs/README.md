# Documentation

| Document | Who it is for | What it answers |
| --- | --- | --- |
| [README.md](../README.md) | everyone | what anvil is, and why it exists |
| [USAGE.md](USAGE.md) | users | what to run, what it writes, how to script it |
| [ARCHITECTURE.md](ARCHITECTURE.md) | contributors | how the packages fit together, and where state lives |
| [adr/](adr/) | contributors | why each decision was made, one document per decision |
| [CONTRIBUTING.md](../CONTRIBUTING.md) | contributors | the conventions, and exactly what CI runs |
| [SECURITY.md](../SECURITY.md) | reporters | how to report a vulnerability, and what is out of scope |
| [IMPLEMENTATION_PLAN.md](../IMPLEMENTATION_PLAN.md) | maintainers | the design, the milestones, and the defects each one found |
| [the opencode plugin](../packages/plugin-opencode/README.md) | plugin users | the same tools, registered inside the agent |

**Start here:** [USAGE.md](USAGE.md). The [README](../README.md) is the argument for why
anvil exists; the usage guide is the manual.

Two rules the documentation follows, so it does not rot:

- **One fact, one place.** A command's flags are documented by `anvil <command> --help`,
  and the usage guide links to that rather than repeating it. The exit-code table lives
  in the usage guide, and `packages/core/src/errors.ts` says it is the contract; the
  numbers appear in both because a reader needs them in both.
- **Checked, not hoped for.** `npm run check` validates the links in these documents,
  the `anvil <command>` examples against the real command surface, and the
  `npm run <script>` examples against the real `package.json`. A document that names a
  command that does not exist fails the build.
