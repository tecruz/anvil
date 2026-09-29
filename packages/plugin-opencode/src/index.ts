/**
 * opencode plugin.
 *
 * Thin by design: all the logic lives in the CLI, so the same behaviour is available in
 * Claude Code, Cursor or a raw shell. This only registers tools and keeps ticket context
 * alive.
 *
 * The one thing it does that is not thin is `session.compacting`. Ticket context dying at
 * compaction is the single worst failure mode of a worktree crew: the agent quietly
 * forgets the acceptance criteria and keeps going, confidently. Ten lines here prevent
 * that, which is why it landed in M3 rather than M6.
 */

import { existsSync, readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import type { Plugin } from '@opencode-ai/plugin'
import { tool } from '@opencode-ai/plugin'

/** Where a claim writes the ticket context inside its worktree. */
const CONTEXT_FILE = join('.anvil', 'ticket.md')
const OVERLAY_FILE = join('.anvil', 'AGENTS.md')

interface Envelope {
  ok: boolean
  command?: string
  data?: unknown
  error?: { code: string; message: string; hint?: string }
}

function readIfPresent(path: string): string | null {
  if (!existsSync(path)) return null
  try {
    const text = readFileSync(path, 'utf8')
    return text.trim() === '' ? null : text
  } catch {
    return null
  }
}

export const AnvilPlugin: Plugin = async ({ directory, worktree, $ }) => {
  // Prefer the worktree opencode is actually running in; fall back to the project root
  // so the plugin also works when it is loaded outside a claim.
  const root = worktree ?? directory

  const runAnvil = async (args: string[]): Promise<{ ok: boolean; output: string }> => {
    try {
      const result = await $`anvil ${args} --json`
      // Bun's shell resolves stdout as a Buffer; the tools return text.
      const stdout = result.stdout
      return { ok: true, output: typeof stdout === 'string' ? stdout : Buffer.from(stdout ?? '').toString('utf8') }
    } catch (err) {
      return { ok: false, output: err instanceof Error ? err.message : String(err) }
    }
  }

  return {
    tool: {
      anvil_doctor: tool({
        description:
          'Audit the current repository for AI-readiness: whether an agent can understand it, verify its work, ' +
          'know the technology, and is allowed to act. Returns a score, per-layer breakdown, and every finding ' +
          'with file:line evidence and a concrete fix. Read-only.',
        args: {
          layer: tool.schema
            .string()
            .optional()
            .describe('Restrict to one layer: orientability, operability, context or governance'),
        },
        async execute(args) {
          const extra = args.layer === undefined ? [] : ['--layer', args.layer]
          const { ok, output } = await runAnvil(['doctor', ...extra])
          return ok ? output : `anvil doctor failed: ${output}`
        },
      }),

      anvil_plan: tool({
        description:
          'Ranked fixes for the current repository, in three tiers: derived (from this repo\'s own facts), ' +
          'official (the technology\'s own documentation and skills) and community. Read-only.',
        args: {
          tier: tool.schema.enum(['derived', 'official', 'community']).optional().describe('Only this tier'),
          limit: tool.schema.number().optional().describe('Maximum suggestions to return'),
        },
        async execute(args) {
          const extra: string[] = []
          if (args.tier !== undefined) extra.push('--tier', args.tier)
          if (args.limit !== undefined) extra.push('--limit', String(args.limit))
          const { ok, output } = await runAnvil(['plan', ...extra])
          return ok ? output : `anvil plan failed: ${output}`
        },
      }),

      anvil_ticket: tool({
        description:
          'Read the ticket this worktree was claimed for, including acceptance criteria and the repository\'s ' +
          'verify commands. Use this when you need to re-check what you were asked to do, especially after a ' +
          'context compaction.',
        args: {},
        async execute() {
          const context = readIfPresent(join(root, CONTEXT_FILE))
          if (context === null) {
            return 'No ticket context in this worktree. This directory is not an anvil claim, or `anvil issue pull` has not been run.'
          }
          return context
        },
      }),

      anvil_status: tool({
        description:
          'List every active anvil claim: branch, worktree, uncommitted changes and unpushed commits. Read-only.',
        args: {},
        async execute() {
          const { ok, output } = await runAnvil(['status'])
          return ok ? output : `anvil status failed: ${output}`
        },
      }),
    },

    /**
     * Keep ticket context alive across compaction.
     *
     * opencode compacts the conversation when it grows, summarizing what came before. A
     * worktree agent's ticket, acceptance criteria and verify commands live in that
     * conversation, so after a compaction they can be summarized away -- and the agent
     * then finishes work that no longer matches what was asked.
     *
     * The bundle is re-read from disk on every compaction rather than cached, so a
     * comment added mid-task survives too.
     */
    'experimental.session.compacting': async (_input, output) => {
      const context = readIfPresent(join(root, CONTEXT_FILE))
      if (context === null) return
      const overlay = readIfPresent(join(root, OVERLAY_FILE))

      output.context.push(
        [
          '## Task context (do not lose this during compaction)',
          '',
          'This session is working in an anvil worktree with a specific ticket. The following is read',
          'from disk on every compaction and is authoritative over anything summarized above.',
          '',
          context,
        ].join('\n'),
      )

      if (overlay !== null) {
        output.context.push(['## Worktree rules', '', overlay].join('\n'))
      }
    },

    /**
     * Make anvil's own configuration visible to the CLI.
     *
     * Only forwarded when already present in the environment, so this never invents or
     * stores a secret. `shell.env` receives the shell invocation context, not the process
     * environment, so the values come from `process.env` directly.
     */
    'shell.env': async (_input, output) => {
      for (const name of ['ANVIL_TICKETS_DIR', 'ANVIL_PLAYBOOKS', 'ANVIL_CONFIG_HOME', 'NO_COLOR']) {
        const value = process.env[name]
        if (value !== undefined) output.env[name] = value
      }
    },
  }
}

export default AnvilPlugin
