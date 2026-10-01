/**
 * Deterministic artifact generation.
 *
 * The templates here produce a *valid, working baseline* from verified facts alone. The
 * agent's job is then to improve the prose and add the structure only it can see
 * (per-module subagents, project-specific commands). That ordering matters: it means
 * `anvil init` is useful on its own, with no model in the loop, and it means the
 * validator is checking a real artifact rather than a hopeful one.
 *
 * The rule throughout: never emit a claim that cannot be traced to the brief. A generated
 * instruction the repo does not satisfy is worse than a missing one, because the agent
 * will trust it.
 */

import type { MatchResult } from '@anvil/playbooks'
import type { CommandEntry, ProjectProfile } from '@anvil/profile'

export interface GeneratedArtifact {
  path: string
  content: string
  /** Why anvil produced this file, shown in the plan. */
  reason: string
}

const CODE_FENCE = '```'

/** Best command for a kind, preferring documented, then detected, then inferred. */
export function bestCommand(profile: ProjectProfile, kind: keyof ProjectProfile['commands']): CommandEntry | null {
  const entries = profile.commands[kind]
  if (entries === undefined || entries.length === 0) return null
  // The list is already sorted highest-priority-first by the profile builder.
  return entries[0] as CommandEntry
}

function bullet(label: string, entry: CommandEntry | null, fallback: string | null): string | null {
  if (entry === null)
    return fallback === null ? null : `- **${label}:** _not yet defined_ -- add this so the agent can verify its work`
  const source = entry.source === 'documented' ? '' : ` _(${entry.source})_`
  const evidence = entry.evidence === undefined ? '' : ` \`${entry.evidence}\``
  return `- **${label}:** \`${entry.cmd}\`${source}${evidence}`
}

export interface GenerateOptions {
  profile: ProjectProfile
  matches: readonly MatchResult[]
  /** Which artifacts to produce. */
  only?: 'agents-file' | 'skills' | 'all'
}

/**
 * The root AGENTS.md.
 *
 * Sections are emitted only when there is verified evidence for them, so the file never
 * claims a project convention the repository does not have.
 */
export function generateAgentsFile(options: GenerateOptions): GeneratedArtifact {
  const { profile, matches } = options
  const lines: string[] = []

  const title = profile.monorepo === null ? 'Project' : `Monorepo (${profile.monorepo.tool})`
  lines.push(`# ${title}`)
  lines.push('')

  const primary = profile.languages.find((l) => l.primary)
  const secondary = profile.languages.filter((l) => !l.primary).slice(0, 4)
  if (primary !== undefined) {
    lines.push(
      `${primary.id[0]?.toUpperCase()}${primary.id.slice(1)} project${secondary.length > 0 ? `, with ${secondary.map((l) => l.id).join(', ')}` : ''}.` +
        (profile.vcs.defaultBranch === null ? '' : ` Default branch: \`${profile.vcs.defaultBranch}\`.`),
    )
    lines.push('')
  }

  // The command table is the single most valuable thing in this file: without it the
  // agent cannot verify anything, which is the blocker the audit reports first.
  const commandRows: string[] = []
  for (const [label, kind] of [
    ['Install', 'install'],
    ['Build', 'build'],
    ['Test', 'test'],
    ['Test (changed files only)', 'testFast'],
    ['Lint', 'lint'],
    ['Format', 'format'],
    ['Typecheck', 'typecheck'],
  ] as Array<[string, keyof ProjectProfile['commands']]>) {
    const b = bullet(label, bestCommand(profile, kind), null)
    if (b !== null) commandRows.push(b)
  }
  if (commandRows.length > 0) {
    lines.push('## Commands')
    lines.push('')
    // A project in a subdirectory is stated before the commands, because a command like
    // `cargo test` is written the way its ecosystem writes it -- relative to the project,
    // not to wherever the reader is standing. Without this line the command is a trap.
    if (profile.projectDir !== '') {
      lines.push(`> The project lives in \`${profile.projectDir}/\`. Run the commands below from that directory.`)
      lines.push('')
    }
    lines.push(...commandRows)
    const inferred = countInferred(profile)
    if (inferred > 0) {
      lines.push('')
      lines.push(
        `> Some of these are inferred from ecosystem convention rather than defined in this repo. Verify them before relying on them.`,
      )
    }
    lines.push('')
  }

  if (profile.modules.length > 1) {
    lines.push('## Layout')
    lines.push('')
    for (const m of profile.modules) {
      const deps = m.deps.length === 0 ? '' : ` (depends on ${m.deps.join(', ')})`
      lines.push(`- \`${m.path}\` -- ${m.id}${deps}`)
    }
    lines.push('')
  }

  const highRisk = profile.risk.filter((r) => r.level === 'high')
  if (highRisk.length > 0) {
    lines.push('## High-risk paths')
    lines.push('')
    lines.push('Changes here reach past code review. Say so in the PR description and get a second pair of eyes.')
    lines.push('')
    for (const r of highRisk) {
      lines.push(`- \`${r.glob}\` -- ${r.reason}`)
    }
    lines.push('')
  }

  if (profile.docs.architecture !== null) {
    lines.push('## Architecture')
    lines.push('')
    lines.push(`See \`${profile.docs.architecture}\`.`)
    lines.push('')
  }

  if (matches.length > 0) {
    lines.push('## Technology guidance')
    lines.push('')
    for (const m of matches) {
      const review = m.playbook.conventions.reviewFocus
      lines.push(`- **${m.playbook.title}**`)
      if (m.playbook.conventions.testNaming !== null) {
        lines.push(`  - Tests are named \`${m.playbook.conventions.testNaming}\``)
      }
      for (const focus of review.slice(0, 3)) lines.push(`  - Review focus: ${focus}`)
    }
    lines.push('')
  }

  lines.push('## Conventions')
  lines.push('')
  const conventions: string[] = []
  if (profile.tooling.lint.length > 0)
    conventions.push(`- Linting is enforced by ${profile.tooling.lint.join(', ')}; run it before proposing a change.`)
  if (profile.tooling.formatter.length > 0)
    conventions.push(`- Formatting is handled by ${profile.tooling.formatter.join(', ')}.`)
  if (profile.tooling.hooks.length > 0)
    conventions.push(`- Pre-commit hooks (${profile.tooling.hooks.join(', ')}) run on every commit.`)
  if (profile.tooling.ci.length > 0) conventions.push(`- CI runs on ${profile.tooling.ci.length} workflow file(s).`)
  if (conventions.length === 0) {
    lines.push('- _No linter, formatter or CI detected. Conventions are unenforced here._')
  } else {
    lines.push(...conventions)
  }
  lines.push('')

  lines.push('## For agents')
  lines.push('')
  lines.push(
    '- Run the test and lint commands above before proposing a change. An unverified change is not a proposal.',
  )
  lines.push('- Do not edit a high-risk path without flagging it in your summary.')
  lines.push('- If a command above is marked inferred, treat it as a guess and confirm it first.')
  lines.push('')

  return {
    path: 'AGENTS.md',
    content: lines.join('\n').replace(/\n{3,}/g, '\n\n'),
    reason: 'Root agent instructions, built from detected commands and structure',
  }
}

/** How many of the *displayed* command rows are inferred rather than found written down. */
function countInferred(profile: ProjectProfile): number {
  let n = 0
  for (const kind of ['install', 'build', 'test', 'testFast', 'lint', 'format', 'typecheck'] as const) {
    const entry = bestCommand(profile, kind)
    if (entry !== null && entry.source === 'inferred') n++
  }
  return n
}

/**
 * A project skill capturing the verify loop.
 *
 * Only generated when the repo actually has a fast test subset, because a skill that
 * says "run the changed tests" in a repo with no such command teaches an agent to invent
 * one.
 */
export function generateVerifySkill(options: GenerateOptions): GeneratedArtifact | null {
  const { profile } = options
  const test = bestCommand(profile, 'test')
  const fast = bestCommand(profile, 'testFast')
  const lint = bestCommand(profile, 'lint')

  if (test === null) return null

  const steps: string[] = []
  // A command like `cargo test` is written the way its ecosystem writes it: relative to the
  // project, not to wherever the agent is standing. In a repository whose project lives in a
  // subdirectory, the raw command is a trap, so every artifact that embeds one carries the
  // directory -- the AGENTS.md template, this skill, and the review command alike. Getting it
  // right in one of three and not the others leaves the two that are not the AGENTS.md
  // actively misleading.
  const cd = profile.projectDir === '' ? '' : `cd ${profile.projectDir} && `
  const note =
    profile.projectDir === ''
      ? []
      : [`> The project lives in \`${profile.projectDir}/\`. Run the commands below from that directory.`, '']
  const run = (cmd: string): string => `${cd}${cmd}`

  steps.push('1. Run the changed-files subset first:')
  if (fast !== null) {
    steps.push(`${CODE_FENCE}bash\n${run(fast.cmd)}\n${CODE_FENCE}`)
    steps.push('')
  } else {
    steps.push('   _No changed-files subset is defined in this repo. Run the full suite._')
    steps.push('')
  }
  steps.push('2. Run the full suite before you claim the work is done:')
  steps.push(`${CODE_FENCE}bash\n${run(test.cmd)}\n${CODE_FENCE}`)
  if (lint !== null) {
    steps.push('')
    steps.push('3. Lint:')
    steps.push(`${CODE_FENCE}bash\n${run(lint.cmd)}\n${CODE_FENCE}`)
  }

  const content = [
    '---',
    'name: verify-change',
    `description: Run this repository's own verification commands before claiming a change is done. Use it after any code edit, before reporting completion.`,
    '---',
    '',
    '# Verifying a change',
    '',
    ...note,
    ...steps,
    '',
    'If a command fails, fix the cause rather than the assertion. If a command is wrong,',
    'say so explicitly instead of reporting a green run you did not observe.',
    '',
  ].join('\n')

  return {
    path: '.agents/skills/verify-change/SKILL.md',
    content,
    reason:
      fast === null
        ? 'Verify loop skill (no changed-files subset detected, so it uses the full suite)'
        : 'Verify loop skill using the detected changed-files test subset',
  }
}

/**
 * A review command wired to the repo's real commands.
 *
 * Commands support ``!`cmd` `` shell injection and `@file` references, so the
 * generated command genuinely re-runs verification rather than describing it.
 */
export function generateReviewCommand(options: GenerateOptions): GeneratedArtifact | null {
  const { profile } = options
  const test = bestCommand(profile, 'test')
  const lint = bestCommand(profile, 'lint')
  if (test === null && lint === null) return null

  // Same rule as the verify skill: the commands below are ecosystem-relative, so a project in
  // a subdirectory needs the directory prefixed or the whole command is a trap.
  const cd = profile.projectDir === '' ? '' : `cd ${profile.projectDir} && `

  const body: string[] = []
  body.push('Review the current diff for correctness before it is proposed.')
  if (profile.projectDir !== '') {
    body.push('')
    body.push(`The project lives in \`${profile.projectDir}/\`, so the commands below run from there.`)
  }
  body.push('')
  body.push('Recent commits:')
  body.push('!`git log --oneline -10`')
  body.push('')
  if (test !== null) {
    body.push('Test results:')
    body.push(`!\`${cd}${test.cmd}\``)
    body.push('')
  }
  if (lint !== null) {
    body.push('Lint results:')
    body.push(`!\`${cd}${lint.cmd}\``)
    body.push('')
  }
  body.push('Report: correctness problems, missing edge cases, and anything that would be')
  body.push('hard to review. If the diff touches a high-risk path, say so explicitly.')

  const content = [
    '---',
    'description: Review the current diff against the project test and lint results',
    '---',
    '',
    ...body,
    '',
  ].join('\n')

  return {
    path: '.opencode/commands/review-change.md',
    content,
    reason: 'Diff review command wired to the detected test and lint commands',
  }
}
