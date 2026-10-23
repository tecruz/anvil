/**
 * `anvil mcp` -- expose the read-only control surface to MCP clients over stdio.
 *
 * stdout belongs to the protocol. This command never calls `ctx.out` or `ctx.say`; the
 * server in `../mcp.ts` writes JSON-RPC lines and nothing else. Errors above the protocol
 * (a crashed child, a failed repository read) stay on stderr, so a client that is parsing
 * frames cannot be handed a human-readable error page.
 */

import { parseCliArgs } from '@anvil/core'
import { serveMcp } from '../mcp.ts'
import type { Command } from './types.ts'

export const mcpCommand: Command = {
  name: 'mcp',
  summary: 'Serve doctor, plan and crew status over MCP (stdio).',
  usage: 'anvil mcp',
  details: [
    'Speaks newline-delimited JSON-RPC 2.0, the Model Context Protocol stdio transport.',
    '',
    'Tools:',
    '',
    '  anvil_doctor       the readiness report from `anvil doctor --json`',
    '  anvil_plan         ranked fixes from `anvil plan --json`',
    '  anvil_crew_status  claims and liveness from `anvil crew status --json`',
    '',
    'Every tool is read-only. Each call runs the same CLI command a human would run, so the',
    'result is built from the documented JSON envelope rather than a second implementation of it.',
    '',
    'Nothing is printed to stdout except protocol messages. stderr remains available for',
    'diagnostics.',
  ].join('\n'),
  flags: {
    json: { type: 'boolean', short: 'j' },
    help: { type: 'boolean', short: 'h' },
  },

  async run(ctx, rawArgs) {
    // Parsed so an unknown flag is rejected before the transport starts. `--json` is
    // accepted for consistency with every other command but means nothing here: the
    // protocol is already structured.
    parseCliArgs(rawArgs, mcpCommand.flags)
    await serveMcp(process.stdin, process.stdout, { defaultCwd: ctx.cwd })
  },
}
