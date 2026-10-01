/**
 * `anvil version` -- tool version plus the JSON schema version it emits.
 *
 * The schema version is here on purpose: the opencode plugin needs to know which
 * envelope it is parsing, and a machine that can be asked is a machine that can be
 * checked.
 */

import { parseCliArgs, SCHEMA_VERSION, VERSION } from '@anvil/core'
import type { Command } from './types.ts'

export const versionCommand: Command = {
  name: 'version',
  summary: 'Print the anvil version and JSON schema version.',
  usage: 'anvil version [--json]',
  flags: {
    json: { type: 'boolean', short: 'j' },
    help: { type: 'boolean', short: 'h' },
  },
  async run(ctx, rawArgs) {
    const _args = parseCliArgs(rawArgs, versionCommand.flags)
    const data = {
      version: VERSION,
      schemaVersion: SCHEMA_VERSION,
      node: process.versions.node,
    }
    ctx.out(data, () => `anvil ${VERSION} (schema v${SCHEMA_VERSION}, node ${process.versions.node})`)
  },
}
