/**
 * Command registry.
 *
 * Each command declares its own flags, so `--help` is generated from the same source
 * the parser uses and cannot drift.
 *
 * A command is only registered once it actually works. `anvil --help` lists the
 * planned surface separately, tagged with the milestone that ships it, so the roadmap
 * is discoverable without pretending unimplemented commands exist.
 */

import type { FlagSpecs, GitRepoInfo, Style } from '@anvil/core'

/** Commands that exist today. */
export interface Command {
  name: string
  /** One-line summary shown in `anvil --help`. */
  summary: string
  usage: string
  details?: string
  flags: FlagSpecs
  /**
   * Commands receive raw argv (minus the command token and global flags) and parse it
   * themselves, so the flag table above is the single source of truth for both the
   * parser and the generated help.
   *
   * Return an exit code to signal a non-zero result while still having emitted a
   * complete payload. `anvil doctor --fail-on` needs exactly that: the report is the
   * answer, the exit code is the verdict.
   */
  run(ctx: CommandContext, argv: string[]): Promise<number | void>
}

export interface CommandContext {
  cwd: string
  /** Repo root when inside a git repo, else null. */
  repoRoot: string | null
  /** Full repo discovery result, when available. */
  repo: GitRepoInfo | null
  style: Style
  json: boolean
  /** Print a human-readable line. No-op in --json mode. */
  say(message: string): void
  /** Emit the payload: an envelope in --json mode, rendered text otherwise. */
  out(data: unknown, render: () => void): void
  /** Write a rendered block to stdout even in --json mode (for report + error combos). */
  writeRaw(text: string): void
  /** Write a rendered error block to stderr. */
  writeError(text: string): void
}

/** Planned commands, surfaced in help with their milestone. Shown, not runnable. */
export const PLANNED_COMMANDS: Array<{ usage: string; summary: string; milestone: string }> = [
  { usage: 'anvil brief --for <t>', summary: 'Emit verified facts for the LLM step', milestone: 'M2b' },
  { usage: 'anvil init [--apply]', summary: 'Derive AGENTS.md, agents, commands, skills', milestone: 'M2b' },
  { usage: 'anvil playbook <sub>', summary: 'List/match/show/add/check tech playbooks', milestone: 'M2a' },
  { usage: 'anvil issue <sub>', summary: 'Pull, show, comment, set-state, sync tickets', milestone: 'M3-M4' },
  { usage: 'anvil claim <ref>', summary: 'Create branch + worktree + ticket context', milestone: 'M3' },
  { usage: 'anvil release <key>', summary: 'Tear down a claim', milestone: 'M3' },
  { usage: 'anvil crew <sub>', summary: 'Run N tickets in parallel worktrees', milestone: 'M5' },
  { usage: 'anvil ship <key>', summary: 'Verify, push, open PR, update ticket', milestone: 'M4' },
]

/** Subcommands of `anvil config`. */
export const CONFIG_SUBCOMMANDS = ['show', 'path', 'init'] as const
export type ConfigSubcommand = (typeof CONFIG_SUBCOMMANDS)[number]
