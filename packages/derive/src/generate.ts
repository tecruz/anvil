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

import type { DeclaredCommand, ProjectConfig } from '@anvil/core'
import type { MatchResult } from '@anvil/playbooks'
import type { CommandEntry, ProjectProfile } from '@anvil/profile'
import { INTENDED_BEHAVIOR_QUESTION } from './brief.ts'

/**
 * The declarations that can change a generated artifact, or `undefined` when none can.
 *
 * Every generator in this module reads `commands` and nothing else. Tool, reference,
 * environment, service, credential, access and hardware declarations describe what a machine
 * or a reader needs; they never appear in a generated file. A staging bundle hashes its
 * inputs so a changed repository is caught, not so a declaration that cannot change a byte
 * invalidates a diff the owner already reviewed — or every bundle in flight when an upgrade
 * adds a new declaration array.
 *
 * No declared command generates exactly what no config generates, so both return `undefined`
 * and `hashInputs` omits the field: adding the first reference, or removing the last
 * credential, keeps a staged bundle's hash.
 */
export function generationInputs(declared: ProjectConfig | undefined): Pick<ProjectConfig, 'commands'> | undefined {
  if (declared === undefined || declared.commands.length === 0) return undefined
  return { commands: declared.commands }
}

export interface GeneratedArtifact {
  path: string
  content: string
  /** Why anvil produced this file, shown in the plan. */
  reason: string
}

const CODE_FENCE = '```'

/** Tool-specific instruction files that can mirror the generated AGENTS.md baseline. */
export const MIRROR_TARGETS = ['claude', 'cursor', 'copilot'] as const
export type MirrorTarget = (typeof MIRROR_TARGETS)[number]

export const MIRROR_PATHS: Readonly<Record<MirrorTarget, string>> = {
  claude: 'CLAUDE.md',
  cursor: '.cursor/rules/anvil.mdc',
  copilot: '.github/copilot-instructions.md',
}

/** The path part of a `file:line` citation, normalized for comparison. */
function evidenceFilePath(evidence: string): string {
  return evidence.replace(/:\d+$/, '').replace(/\\/g, '/').replace(/^\.\//, '')
}

/** True when a citation points at a file the generated mirrors will overwrite. */
function isReplacedEvidence(evidence: string | null | undefined, replaced: readonly string[]): boolean {
  if (evidence === null || evidence === undefined) return false
  const path = evidenceFilePath(evidence)
  return replaced.some((candidate) => evidenceFilePath(candidate) === path)
}

/**
 * Command kinds in display order, shared by AGENTS.md and the instruction mirrors.
 *
 * `verify` marks what an agent must run before claiming a change is done. One list keeps a
 * changed-files-only project verifiable in both artifacts: with two lists, AGENTS.md
 * listed `testFast` while the mirror claimed no verify commands were detected.
 */
const COMMAND_KINDS: ReadonlyArray<{
  label: string
  kind: keyof ProjectProfile['commands']
  verify: boolean
}> = [
  { label: 'Install', kind: 'install', verify: false },
  { label: 'Build', kind: 'build', verify: true },
  { label: 'Test', kind: 'test', verify: true },
  { label: 'Test (changed files only)', kind: 'testFast', verify: true },
  { label: 'Lint', kind: 'lint', verify: true },
  { label: 'Format', kind: 'format', verify: false },
  { label: 'Typecheck', kind: 'typecheck', verify: true },
]

/** Best command for a kind, preferring documented, then detected, then inferred. */
export function bestCommand(profile: ProjectProfile, kind: keyof ProjectProfile['commands']): CommandEntry | null {
  const entries = profile.commands[kind]
  if (entries === undefined || entries.length === 0) return null
  // The list is already sorted highest-priority-first by the profile builder.
  return entries[0] as CommandEntry
}

/**
 * A command chosen for an artifact, with the directory it runs from.
 *
 * Declared capabilities are the escape hatch for a project anvil cannot detect on its own, so
 * they rank above the detected command for the same kind: the owner wrote them down, and the
 * generated context would otherwise omit exactly the commands the repository needs.
 */
interface ChosenCommand {
  cmd: string
  source: CommandEntry['source'] | 'declared'
  evidence: string | null
  dir: string
}

function chooseCommand(options: GenerateOptions, kind: keyof ProjectProfile['commands']): ChosenCommand | null {
  const profile = options.profile
  const declared: DeclaredCommand | undefined = options.declared?.commands.find((c) => c.kind === kind)
  if (declared !== undefined) {
    return {
      cmd: declared.cmd,
      source: 'declared',
      evidence: 'anvil.config.json',
      dir: declared.dir ?? profile.projectDir,
    }
  }
  const entry = bestCommand(profile, kind)
  if (entry === null) return null
  const replaced = options.replacedEvidencePaths ?? []
  if (isReplacedEvidence(entry.evidence, replaced)) {
    // A command documented in CLAUDE.md (or another mirror) gets a `file:line` citation
    // pointing into the file this same bundle replaces with a generated stub. The line
    // would land on the generated notice, not the command. Prefer a surviving source for
    // the very same command so the provenance stays real.
    const surviving = (profile.commands[kind] ?? []).find(
      (candidate) => candidate.cmd === entry.cmd && !isReplacedEvidence(candidate.evidence, replaced),
    )
    if (surviving !== undefined) {
      return {
        cmd: surviving.cmd,
        source: surviving.source,
        evidence: surviving.evidence ?? null,
        dir: profile.projectDir,
      }
    }
    // No alternative: keep the command (it is still a verified fact and must not vanish
    // from AGENTS.md) but drop the citation. The source label still records that the
    // command was documented; it just no longer claims a line that will not exist.
    return { cmd: entry.cmd, source: entry.source, evidence: null, dir: profile.projectDir }
  }
  return {
    cmd: entry.cmd,
    source: entry.source,
    evidence: entry.evidence ?? null,
    dir: profile.projectDir,
  }
}

/**
 * Quote a directory for a `cd` in a generated shell snippet.
 *
 * A path with a space (`engine tools`) is not a valid `cd` argument unquoted, so it is
 * single-quoted; the common path needs no quotes and stays readable.
 */
function quoteShellDir(dir: string): string {
  return /^[A-Za-z0-9_./-]+$/.test(dir) ? dir : `'${dir.replace(/'/g, `'\\''`)}'`
}

/** The `cd <dir> && ` prefix for a command, or nothing when it runs from the repository root. */
function cdPrefix(dir: string): string {
  return dir === '' ? '' : `cd ${quoteShellDir(dir)} && `
}

function bullet(
  label: string,
  entry: ChosenCommand | null,
  fallback: string | null,
  defaultDir: string,
): string | null {
  if (entry === null)
    return fallback === null ? null : `- **${label}:** _not yet defined_ -- add this so the agent can verify its work`
  const source = entry.source === 'documented' ? '' : ` _(${entry.source})_`
  // A row whose directory differs from the project directory states it: the document's note
  // names one directory, and an explicit root override (`dir: ""`) must not be read as running
  // from the project directory. The common case stays exactly as it was.
  let dir = ''
  if (entry.dir !== defaultDir) {
    dir = entry.dir === '' ? ' (from the repository root)' : ` (from \`${entry.dir}/\`)`
  }
  const evidence = entry.evidence === null ? '' : ` \`${entry.evidence}\``
  return `- **${label}:** \`${entry.cmd}\`${source}${dir}${evidence}`
}

/**
 * A command row whose evidence points at this file has a line number from the *previous*
 * AGENTS.md -- the profile reads the file on disk before this template lays out the new
 * one. Left alone, every edit above the command block makes the citation point at the
 * wrong line, which is the one kind of stale evidence this project must not ship.
 *
 * The final line is known only after the document is assembled, so the fix is a second
 * pass over the finished text: each self-citing command row cites its own current line.
 */
const SELF_CITATION = / `AGENTS\.md:\d+`$/

function retargetSelfCitations(content: string): string {
  const lines = content.split('\n')
  return lines
    .map((line, index) => (line.startsWith('- **') ? line.replace(SELF_CITATION, ` \`AGENTS.md:${index + 1}\``) : line))
    .join('\n')
}

export interface GenerateOptions {
  profile: ProjectProfile
  matches: readonly MatchResult[]
  /**
   * Owner-declared capabilities from `anvil.config.json`.
   *
   * Optional so nothing has to construct it: generation on a repository with no declarations
   * behaves exactly as before. When present, a declared command outranks the detected command
   * for its kind, which is what makes an unrecognized technology usable.
   */
  declared?: ProjectConfig
  /**
   * Repo-relative paths this bundle will overwrite with generated mirrors.
   *
   * Set by `anvil init --with-mirrors`. A command whose only evidence is a line in one of
   * these files would cite the replacement stub instead of the original document, so such
   * a citation is re-sourced or dropped. The default three-file bundle leaves it alone.
   */
  replacedEvidencePaths?: readonly string[]
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
  let declaredRows = 0
  for (const { label, kind } of COMMAND_KINDS) {
    const chosen = chooseCommand(options, kind)
    const b = bullet(label, chosen, null, profile.projectDir)
    if (b !== null) commandRows.push(b)
    if (chosen?.source === 'declared') declaredRows++
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
    if (declaredRows > 0) {
      lines.push('')
      lines.push(
        `> Some of these are declared in \`anvil.config.json\`, not found in this repository. Treat them as the owner's statement of how to work here.`,
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

  lines.push('## Product expectations')
  lines.push('')
  lines.push(
    '- Business expectations were not assessed here: what the product should do, and its acceptance criteria, are open questions, not facts.',
  )
  lines.push(
    '- Source code and tests are evidence of the current implementation, not by themselves the definition of correct product behavior.',
  )
  lines.push(`- Ask: ${INTENDED_BEHAVIOR_QUESTION}`)
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
    content: retargetSelfCitations(lines.join('\n').replace(/\n{3,}/g, '\n\n')),
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
  const test = chooseCommand(options, 'test')
  const fast = chooseCommand(options, 'testFast')
  const lint = chooseCommand(options, 'lint')

  if (test === null) return null

  const steps: string[] = []
  // A command like `cargo test` is written the way its ecosystem writes it: relative to the
  // project, not to wherever the agent is standing. In a repository whose project lives in a
  // subdirectory, the raw command is a trap, so every artifact that embeds one carries the
  // directory -- the AGENTS.md template, this skill, and the review command alike. Getting it
  // right in one of three and not the others leaves the two that are not the AGENTS.md
  // actively misleading.
  const note =
    profile.projectDir === ''
      ? []
      : [
          // The commands below carry their own `cd`, so the reader starts at the repository
          // root. Saying "run from this directory" instead would contradict a command that
          // overrides back to the root (`dir: ""`) and has no `cd`.
          `> The project lives in \`${profile.projectDir}/\`. Run the commands below from the repository root.`,
          '',
        ]
  const run = (entry: ChosenCommand): string => `${cdPrefix(entry.dir)}${entry.cmd}`

  steps.push('1. Run the changed-files subset first:')
  if (fast !== null) {
    steps.push(`${CODE_FENCE}bash\n${run(fast)}\n${CODE_FENCE}`)
    steps.push('')
  } else {
    steps.push('   _No changed-files subset is defined in this repo. Run the full suite._')
    steps.push('')
  }
  steps.push('2. Run the full suite before you claim the work is done:')
  steps.push(`${CODE_FENCE}bash\n${run(test)}\n${CODE_FENCE}`)
  if (lint !== null) {
    steps.push('')
    steps.push('3. Lint:')
    steps.push(`${CODE_FENCE}bash\n${run(lint)}\n${CODE_FENCE}`)
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
 * Thin mirrors for tools that read their own instruction files.
 *
 * `AGENTS.md` stays the source of truth. The mirror deliberately does NOT copy the command
 * strings: those carry a working directory and evidence (`cd apps/web && npm test`), and a
 * copy that drops the directory would send an agent to the wrong place. Instead the mirror
 * names which verify kinds exist -- derived from the exact same `chooseCommand` set the root
 * file uses -- and points the reader at `AGENTS.md` for the commands and their directories.
 * There is no second command text to drift.
 */
export function generateInstructionMirrors(
  options: GenerateOptions,
  targets: readonly MirrorTarget[] = MIRROR_TARGETS,
): GeneratedArtifact[] {
  const kinds: string[] = []
  for (const spec of COMMAND_KINDS) {
    if (spec.verify && chooseCommand(options, spec.kind) !== null) kinds.push(spec.label.toLowerCase())
  }

  const body = [
    '# Repository instructions (anvil mirror)',
    '',
    'This file is generated by `anvil init --with-mirrors`.',
    '`AGENTS.md` is the source of truth: read it before making changes. If this mirror and',
    '`AGENTS.md` disagree, `AGENTS.md` wins. Do not edit this file by hand -- re-run',
    '`anvil init` to refresh it.',
    '',
    '## Verification',
    '',
    ...(kinds.length > 0
      ? [
          `Verification kinds found here: ${kinds.join(', ')}. Read \`AGENTS.md\` for each exact command, its working directory and its evidence -- this mirror never copies them so they cannot drift.`,
        ]
      : [
          'No verify commands were detected. Read `AGENTS.md` and `anvil profile` before claiming a change is verified.',
        ]),
    '',
    'Read `AGENTS.md` in this repository for the full instructions, conventions and high-risk paths.',
    '',
  ].join('\n')

  return targets.map((target) => {
    const path = MIRROR_PATHS[target]
    const content =
      target === 'cursor'
        ? [
            '---',
            'description: Repository verify commands generated by anvil init; AGENTS.md is the source of truth.',
            'globs: ["**/*"]',
            'alwaysApply: true',
            '---',
            '',
            body,
          ].join('\n')
        : body
    return {
      path,
      content,
      reason: `Thin ${target} mirror deferring to the generated AGENTS.md (no copied commands)`,
    }
  })
}

/**
 * A review command wired to the repo's real commands.
 *
 * Commands support ``!`cmd` `` shell injection and `@file` references, so the
 * generated command genuinely re-runs verification rather than describing it.
 */
export function generateReviewCommand(options: GenerateOptions): GeneratedArtifact | null {
  const { profile } = options
  const test = chooseCommand(options, 'test')
  const lint = chooseCommand(options, 'lint')
  if (test === null && lint === null) return null

  const run = (entry: ChosenCommand): string => `${cdPrefix(entry.dir)}${entry.cmd}`

  const body: string[] = []
  body.push('Review the current diff for correctness before it is proposed.')
  if (profile.projectDir !== '') {
    body.push('')
    // The commands below carry their own `cd`, so the reader starts at the repository root;
    // a command that overrides back to the root has no prefix and would be wrong from the
    // project directory.
    body.push(`The project lives in \`${profile.projectDir}/\`, so the commands below run from the repository root.`)
  }
  body.push('')
  body.push('Recent commits:')
  body.push('!`git log --oneline -10`')
  body.push('')
  if (test !== null) {
    body.push('Test results:')
    body.push(`!\`${run(test)}\``)
    body.push('')
  }
  if (lint !== null) {
    body.push('Lint results:')
    body.push(`!\`${run(lint)}\``)
    body.push('')
  }
  body.push('Treat what the code does as evidence of the current implementation; it does not by')
  body.push('itself define intended product behavior. If the diff depends on an undocumented')
  body.push('business expectation, name it as an open question instead of inventing an answer.')
  body.push('')
  body.push(`If the intent is unclear, ask: ${INTENDED_BEHAVIOR_QUESTION}`)
  body.push('')
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
