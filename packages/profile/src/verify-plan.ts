/**
 * The effective verification plan: one place that decides which command anvil runs, from
 * where, and which source it came from.
 *
 * The brief, `anvil init`, `crew verify` and `ship` must agree with each other. When they do
 * not, AGENTS.md can name a declared command while the verifier silently runs a detected one,
 * and a green check says nothing about the command the reviewer was told to use. Declared
 * commands win, exactly as they do in the brief and the generated instructions; a conflicting
 * detected command stays visible rather than disappearing.
 */

import type { DeclaredCommand } from '@anvil/core'
import type { CommandEntry, ProjectProfile } from './types.ts'

export type VerificationSource = CommandEntry['source'] | 'declared'

export interface VerificationCommand {
  kind: string
  cmd: string
  /** Repo-relative working directory, '' for the repository root. */
  dir: string
  source: VerificationSource
  /** file:line for a detected command, 'anvil.config.json' for a declared one. */
  evidence: string | null
}

export interface VerificationPlan {
  commands: VerificationCommand[]
  /** The owner declared a different command for a kind anvil also detected. */
  conflicts: Array<{ kind: string; declared: string; detected: string }>
}

/** Highest-confidence first, matching the order used by ship and the generated instructions. */
const ORDER = ['testFast', 'test', 'typecheck', 'lint', 'build'] as const

/**
 * Build the plan from detected facts plus owner declarations. This function is pure: it reads
 * no config and starts no process, so every caller can compute the same result from the same
 * inputs.
 */
export function verificationPlan(
  profile: Pick<ProjectProfile, 'commands' | 'projectDir'>,
  declared: readonly DeclaredCommand[] = [],
): VerificationPlan {
  const commands: VerificationCommand[] = []
  const conflicts: VerificationPlan['conflicts'] = []
  const seen = new Set<string>()
  for (const kind of ORDER) {
    const owner = declared.find((entry) => entry.kind === kind)
    const detected = profile.commands[kind]?.[0]
    if (owner !== undefined && detected !== undefined && owner.cmd !== detected.cmd) {
      conflicts.push({ kind, declared: owner.cmd, detected: detected.cmd })
    }
    const chosen: VerificationCommand | null = owner
      ? {
          kind,
          cmd: owner.cmd,
          dir: owner.dir ?? profile.projectDir,
          source: 'declared',
          evidence: 'anvil.config.json',
        }
      : detected
        ? {
            kind,
            cmd: detected.cmd,
            dir: profile.projectDir,
            source: detected.source,
            evidence: detected.evidence ?? null,
          }
        : null
    if (chosen === null || seen.has(chosen.cmd)) continue
    seen.add(chosen.cmd)
    commands.push(chosen)
  }
  return { commands, conflicts }
}
