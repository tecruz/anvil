# Monorepo (npm)

Typescript project, with javascript.

## Commands

- **Install:** `npm ci` _(detected)_ `package-lock.json`
- **Build:** `npm run build` `AGENTS.md:7`
- **Test:** `npm run test` `AGENTS.md:8`
- **Test (changed files only):** `npm run test:changed` `CONTRIBUTING.md:17`
- **Lint:** `npm run lint` `AGENTS.md:10`
- **Format:** `npm run format` _(detected)_ `package.json:18`
- **Typecheck:** `npm run typecheck` _(detected)_ `package.json:15`

## Layout

- `packages/audit` -- @anvil/audit (depends on @anvil/profile)
- `packages/cli` -- @anvil/cli
- `packages/core` -- @anvil/core
- `packages/derive` -- @anvil/derive (depends on @anvil/audit, @anvil/playbooks, @anvil/profile)
- `packages/git` -- @anvil/git (depends on @anvil/core)
- `packages/playbooks` -- @anvil/playbooks
- `packages/plugin-opencode` -- opencode-anvil
- `packages/pr` -- @anvil/pr (depends on @anvil/profile, @anvil/tickets)
- `packages/profile` -- @anvil/profile (depends on @anvil/core)
- `packages/providers` -- @anvil/providers (depends on @anvil/core, @anvil/tickets, @anvil/worktrees)
- `packages/tickets` -- @anvil/tickets (depends on @anvil/core, @anvil/profile)
- `packages/worktrees` -- @anvil/worktrees (depends on @anvil/core, @anvil/git, @anvil/pr, @anvil/profile, @anvil/tickets)

## High-risk paths

Changes here reach past code review. Say so in the PR description and get a second pair of eyes.

- `.github/workflows/**` -- CI definition; a change can silently disable checks

## Technology guidance

- **Node / TypeScript**
  - Tests are named `*.test.ts, *.spec.ts`
  - Review focus: lockfile changes move the supply chain
  - Review focus: any edit to a dependency version
  - Review focus: unhandled promise rejections
- **CI / pipelines**
  - Tests are named `one workflow per concern, reusable workflows for shared jobs`
  - Review focus: any change that removes or makes a job non-blocking
  - Review focus: action pins, and whether a version tag can move under you
  - Review focus: permissions blocks, which are usually broader than intended

## Conventions

- Linting is enforced by biome; run it before proposing a change.
- Formatting is handled by biome.
- Pre-commit hooks (githooks) run on every commit.
- CI runs on 1 workflow file(s).

## For agents

- Run the test and lint commands above before proposing a change. An unverified change is not a proposal.
- Do not edit a high-risk path without flagging it in your summary.
- If a command above is marked inferred, treat it as a guess and confirm it first.
