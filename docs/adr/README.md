# Architecture decision records

One document per decision that was hard to reverse. Each one states the context, the
decision, the consequences, and the alternatives that were rejected — the rejected
alternatives are usually the most useful part, because they record what was tried.

An ADR is written when the decision is made and amended afterwards only by a new ADR
that supersedes it. The status line at the top is the source of truth.

| ADR | Decision | Status |
| --- | --- | --- |
| [0001](0001-deterministic-cli-agent-reasons.md) | The CLI is deterministic; the model writes the prose | accepted |
| [0002](0002-gh-cli-as-first-transport.md) | `gh` is the first ticket transport | accepted |
| [0003](0003-diff-first-staging-lifecycle.md) | Nothing is written before a diff | accepted |
| [0004](0004-local-provider-as-egress-escape-hatch.md) | The local markdown provider is the escape hatch for blocked egress | accepted |
| [0005](0005-governance-ships-in-m4.md) | Governance ships in M4, not M6 | accepted |
| [0006](0006-single-file-bundle-location.md) | The single-file bundle lives in `packages/cli/dist` | accepted, superseded on the publish target by [0007](0007-distribution-git-install.md) |
| [0007](0007-distribution-git-install.md) | The distribution is a git install; the workspace root is the package | accepted |
| [0008](0008-live-discovery-keeps-registry-curated.md) | Live discovery enriches the plan; the registry stays curated | accepted |
| [0009](0009-guidance-has-to-earn-its-place.md) | Guidance has to earn its place: an instruction budget, and resources that can be satisfied | accepted |
| [0010](0010-cost-is-read-from-the-hosts-ledger.md) | Cost is read from the host's ledger; anvil records nothing | accepted |
| [0011](0011-mcp-for-the-control-surface.md) | The MCP control surface runs the CLI, not a second contract | accepted |
| [0012](0012-versioned-prebuilt-distribution.md) | Versioned prebuilt distribution via a scoped registry package | accepted |
| [0013](0013-stale-discovery-is-reported-not-merged.md) | A stale discovery cache is reported, not merged | accepted |
| [0014](0014-optional-resources-in-the-worktree.md) | A worktree gets a shortlist of optional resources, with publisher evidence | accepted |
| [0015](0015-framework-evidence-is-the-framework.md) | A framework is matched by its own evidence, not its build system | accepted |
| [0016](0016-mobile-platforms-are-their-own-stacks.md) | Mobile platforms are their own stacks, and Apple's two are two playbooks | accepted |

The [architecture document](../ARCHITECTURE.md) describes the system as it is today; these
describe the decisions that shaped it.
