/**
 * The protected approval store location.
 *
 * Kept in its own module so the adapter registry, the fetch cache and the grant store can
 * agree on one location without importing each other in a cycle. This module holds no state.
 */
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

/**
 * The approval store. A dedicated user-owned location, deliberately *not* the config home:
 * `ANVIL_CONFIG_HOME` may point inside a repository, and a repository must not be able to
 * choose where its own authority lives. `ANVIL_APPROVAL_HOME` is an explicit, process-level
 * override for tests and unusual setups, never a value a config file can set.
 */
export function approvalStoreDir(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.ANVIL_APPROVAL_HOME
  if (override !== undefined && override !== '') return resolve(override)
  return join(homedir(), '.anvil', 'approvals', 'setup', 'v1')
}
