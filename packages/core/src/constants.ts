/**
 * Shared constants that more than one package needs to agree on.
 *
 * The environment marker lives here rather than in `@anvil/worktrees` because the
 * transport that pushes (`@anvil/providers`) and the hook that guards (`@anvil/worktrees`)
 * are different layers: neither may depend on the other just to share a string.
 */

/**
 * The environment marker a forge transport sets on the one push `anvil ship` performs.
 *
 * A claimed worktree installs a `pre-push` hook that refuses every push without this
 * marker, so "agents commit, humans ship" is enforced by git rather than requested in a
 * prompt. It is an environment variable and not a file on purpose: it must not survive
 * the command, or a later process could reuse it.
 *
 * This is a control, not a sandbox. `git push --no-verify` bypasses any hook, and the
 * hook says so rather than pretending otherwise.
 */
export const SHIP_GUARD_ENV = 'ANVIL_SHIP'
