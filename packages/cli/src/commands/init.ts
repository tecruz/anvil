/**
 * `anvil brief` and `anvil init`.
 *
 * `brief` emits the verified facts as JSON; a command/skill hands that to the model.
 * `init` builds the deterministic baseline, validates it, shows a diff, and only writes
 * with `--apply`.
 *
 * The agent improves the staged files between the two steps. That is the intended
 * workflow, not an accident: `anvil init` guarantees a valid, useful baseline exists
 * even with no model in the loop, and the validator then gates whatever the model did to
 * it.
 */

import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { audit, type ReadinessReport } from '@anvil/audit'
import { AnvilError, ErrorCode, parseCliArgs, renderTable } from '@anvil/core'
import {
  applyStaging,
  type Brief,
  type BriefTarget,
  buildBrief,
  checkApplyPreconditions,
  clearStaging,
  diffFile,
  type FileDiff,
  type GeneratedArtifact,
  generateAgentsFile,
  generateReviewCommand,
  generateVerifySkill,
  hashInputs,
  inspectStaging,
  readManifest,
  readRepoFile,
  renderUnifiedDiff,
  summarize,
  validateAll,
  writeStaging,
} from '@anvil/derive'
import { discoverRepo } from '@anvil/git'
import { loadPlaybooks, type MatchResult, matchPlaybooks, type Playbook } from '@anvil/playbooks'
import { buildProfile, type ProjectProfile } from '@anvil/profile'
import type { Command, CommandContext } from './types.ts'

function detectHost(remote: string | null): 'github' | 'gitlab' | 'bitbucket' | 'azure' | null {
  if (remote === null) return null
  if (/github\.com|github\./i.test(remote)) return 'github'
  if (/gitlab/i.test(remote)) return 'gitlab'
  if (/bitbucket/i.test(remote)) return 'bitbucket'
  if (/dev\.azure\.com|visualstudio\.com/i.test(remote)) return 'azure'
  return null
}

interface Loaded {
  root: string
  profile: ProjectProfile
  report: ReadinessReport
  matches: readonly MatchResult[]
  playbooks: readonly Playbook[]
  warnings: string[]
}

async function loadAll(ctx: CommandContext, target: string | undefined): Promise<Loaded> {
  const dir = target ?? ctx.repoRoot
  if (dir === undefined || dir === null) {
    throw new AnvilError(ErrorCode.NotAGitRepo, 'Not inside a git repository', {
      hint: 'Run anvil from inside a repository, or pass --profile <dir>.',
    })
  }
  const root = resolve(dir)
  const info = target === undefined ? ctx.repo : await discoverRepo(root)
  const profile = buildProfile(root, {
    root,
    host: detectHost(info?.remote ?? null),
    remote: info?.remote ?? null,
    defaultBranch: info?.defaultBranch ?? null,
  }).profile

  const { playbooks, warnings } = loadPlaybooks(process.env)
  const matches = matchPlaybooks(profile, playbooks)
  return {
    root,
    profile,
    report: audit(profile),
    matches,
    playbooks,
    warnings,
  }
}

const TARGETS: readonly BriefTarget[] = ['agents', 'commands', 'skills', 'all']

// ---------------------------------------------------------------------------
// anvil brief
// ---------------------------------------------------------------------------

export const briefCommand: Command = {
  name: 'brief',
  summary: 'Emit verified facts for the LLM step.',
  usage: 'anvil brief --for <agents|commands|skills|all> [--json] [--profile <dir>]',
  details: [
    'Every value here is verified against the repository and carries evidence. Nothing',
    'is a guess, and no model is called: anvil hands the facts over, and the agent turns',
    'them into prose.',
    '',
    'The `gaps` field is the part that keeps generated guidance honest. It lists what the',
    'repository lacks, so a model does not write instructions for things already present.',
  ].join('\n'),
  flags: {
    json: { type: 'boolean', short: 'j' },
    noColor: { type: 'boolean' },
    help: { type: 'boolean', short: 'h' },
    profile: { type: 'string' },
    for: { type: 'string' },
  },
  async run(ctx, rawArgs) {
    const args = parseCliArgs(rawArgs, briefCommand.flags)
    const target = (args.values.for as string | undefined) ?? 'all'
    if (!TARGETS.includes(target as BriefTarget)) {
      throw new AnvilError(ErrorCode.Usage, `Unknown --for target: ${target}`, {
        hint: `Expected one of: ${TARGETS.join(', ')}`,
      })
    }

    const dir = typeof args.values.profile === 'string' ? args.values.profile : undefined
    const { root, profile, report, matches } = await loadAll(ctx, dir)
    const brief = buildBrief({
      profile,
      report,
      matches,
      target: target as BriefTarget,
      read: (rel) => readRepoFile(root, rel),
    })

    ctx.out(brief, () => renderBrief(ctx, brief))
  },
}

function renderBrief(ctx: CommandContext, brief: Brief): string {
  const s = ctx.style
  const out: string[] = []
  out.push(`${s.bold('Brief')} for ${brief.target}  ${s.dim(brief.repo.root)}`)
  out.push('')
  out.push(s.bold('Repo'))
  out.push(`  languages  ${brief.repo.languages.map((l) => `${l.id}(${l.files})`).join(', ') || '(none)'}`)
  out.push(`  stacks     ${brief.repo.stacks.map((x) => x.id).join(', ') || '(none)'}`)
  if (brief.repo.monorepo !== null) {
    out.push(`  monorepo   ${brief.repo.monorepo.tool}: ${brief.repo.monorepo.members.join(', ')}`)
  }
  out.push('')
  out.push(s.bold('Commands'))
  out.push(
    brief.commands.length === 0
      ? s.dim('  (none)')
      : brief.commands
          .map((c) => `  ${c.kind.padEnd(10)} ${c.cmd.padEnd(32)} ${c.source.padEnd(11)} ${s.dim(c.evidence ?? '')}`)
          .join('\n'),
  )
  if (brief.playbooks.length > 0) {
    out.push('')
    out.push(s.bold('Playbooks'))
    for (const p of brief.playbooks) {
      out.push(`  ${p.title} ${s.dim(`(${p.id})`)}`)
      for (const g of p.guidance.slice(0, 3)) out.push(`    ${g.kind}: ${s.cyan(g.url)}`)
    }
  }
  if (brief.risk.length > 0) {
    out.push('')
    out.push(s.bold('High-risk paths'))
    for (const r of brief.risk.filter((x) => x.level === 'high')) out.push(`  ${r.glob} ${s.dim(r.reason)}`)
  }
  out.push('')
  out.push(s.bold('Gaps the generated guidance must not contradict'))
  out.push(brief.gaps.length === 0 ? s.dim('  (none)') : brief.gaps.map((g) => `  - ${g}`).join('\n'))
  out.push('')
  out.push(s.dim(`Full JSON: anvil brief --for ${brief.target} --json`))
  return out.join('\n')
}

// ---------------------------------------------------------------------------
// anvil init
// ---------------------------------------------------------------------------

export const initCommand: Command = {
  name: 'init',
  summary: 'Derive AGENTS.md, skills and commands from detected facts.',
  usage: 'anvil init [--apply] [--profile <dir>] [--only <artifact>] [--json]',
  details: [
    'Without --apply, nothing is written to the repository: artifacts are built into',
    '.anvil/staging/ and a unified diff is printed.',
    '',
    'With --apply, the bundle is validated, re-checked against the current repository',
    'state, written, and the staging directory cleared. A stale bundle is refused rather',
    'than applied.',
    '',
    'The intended workflow: run `anvil init`, let an agent improve the staged files, then',
    '`anvil init --apply`. The bundle records a hash of its inputs, so a repository that',
    'changed in the meantime is detected instead of silently overwritten.',
    '',
    '--only agents-file|verify-skill|review-command',
  ].join('\n'),
  flags: {
    json: { type: 'boolean', short: 'j' },
    noColor: { type: 'boolean' },
    help: { type: 'boolean', short: 'h' },
    profile: { type: 'string' },
    only: { type: 'string' },
    apply: { type: 'boolean' },
    'allow-warnings': { type: 'boolean' },
  },

  async run(ctx, rawArgs) {
    const args = parseCliArgs(rawArgs, initCommand.flags)
    const dir = typeof args.values.profile === 'string' ? args.values.profile : undefined
    const loaded = await loadAll(ctx, dir)
    const { root, profile, matches, playbooks } = loaded

    const only = (args.values.only as string | undefined) ?? null
    if (only !== null && !['agents-file', 'verify-skill', 'review-command'].includes(only)) {
      throw new AnvilError(ErrorCode.Usage, `Unknown --only artifact: ${only}`, {
        hint: 'Expected one of: agents-file, verify-skill, review-command',
      })
    }

    const currentHash = hashInputs({
      profile: { ...profile, files: undefined, root: undefined },
      report: { score: loaded.report.score, findings: loaded.report.findings },
      playbookIds: playbooks.map((p) => p.id),
    })

    if (args.values.apply === true)
      return applyFlow(ctx, root, currentHash, args.values.json === true, args.values['allow-warnings'] === true)

    // ---- build and stage ----
    const artifacts = buildArtifacts(profile, matches, only)
    if (artifacts.length === 0) {
      throw new AnvilError(ErrorCode.Usage, 'Nothing to generate for this repository', {
        hint: 'A root AGENTS.md is always generated. The others need a test or lint command; check `anvil profile`.',
      })
    }

    const contents = new Map(artifacts.map((a) => [a.path, a.content]))
    const manifest = writeStaging(root, { inputHash: currentHash, generator: 'anvil init' }, contents)

    const state = inspectStaging(root)
    const diffs = computeDiffs(
      root,
      manifest.files.map((f) => ({ path: f.path, stagedPath: f.stagedPath })),
    )
    const validation = validateAll(artifacts.map((a) => ({ path: a.path, content: a.content })))
    const totals = summarize(diffs)

    const data = {
      schemaVersion: 1,
      staged: true,
      applied: false,
      inputHash: currentHash,
      artifacts: artifacts.map((a) => ({
        path: a.path,
        reason: a.reason,
        bytes: Buffer.byteLength(a.content),
      })),
      tampered: state.tampered,
      validation,
      diff: { ...totals, text: renderUnifiedDiff(diffs) },
      warnings: loaded.warnings,
    }

    if (validation.errors.length > 0) {
      // Anvil generated something invalid: that is a bug in the templates, and it must
      // not be staged as if it were fine.
      const err = new AnvilError(
        ErrorCode.Internal,
        `Generated ${validation.errors.length} invalid artifact(s); nothing was applied`,
        {
          hint: validation.errors.map((e) => `${e.path}: ${e.message}`).join('\n'),
          details: { errors: validation.errors },
        },
      )
      if (args.values.json === true) {
        ctx.outFailure(data, err, () => renderInitError(ctx, err, diffs, validation, totals))
        return err.exitCode
      }
      ctx.writeError(renderInitError(ctx, err, diffs, validation, totals))
      return err.exitCode
    }

    ctx.out(data, () => renderStaged(ctx, artifacts, diffs, totals, state.tampered, validation.warnings))
  },
}

function buildArtifacts(
  profile: ProjectProfile,
  matches: readonly MatchResult[],
  only: string | null,
): GeneratedArtifact[] {
  const options = { profile, matches }
  const out: GeneratedArtifact[] = []
  if (only === null || only === 'agents-file') out.push(generateAgentsFile(options))
  if (only === null || only === 'verify-skill') {
    const skill = generateVerifySkill(options)
    if (skill !== null) out.push(skill)
  }
  if (only === null || only === 'review-command') {
    const cmd = generateReviewCommand(options)
    if (cmd !== null) out.push(cmd)
  }
  return out
}

function computeDiffs(root: string, files: ReadonlyArray<{ path: string; stagedPath: string }>): FileDiff[] {
  const out: FileDiff[] = []
  for (const f of files) {
    const stagedPath = join(root, '.anvil', 'staging', f.stagedPath)
    let content: string
    try {
      content = readFileSync(stagedPath, 'utf8')
    } catch {
      continue
    }
    const before = readRepoFile(root, f.path)
    const diff = diffFile({ path: f.path, before, after: content })
    if (diff !== null) out.push(diff)
  }
  return out
}

function applyFlow(
  ctx: CommandContext,
  root: string,
  currentHash: string,
  json: boolean,
  allowWarnings: boolean,
): number {
  const manifest = readManifest(root)
  const check = checkApplyPreconditions(root, manifest, currentHash)

  // The diff is computed before the precondition check on purpose: the refusal message
  // says "inspect the diff above", so a diff has to actually be above it. On a stale
  // bundle that diff is also the most useful thing to show -- it is what changed under
  // the bundle.
  const artifacts = (manifest?.files ?? []).map((f) => {
    const staged = join(root, '.anvil', 'staging', f.stagedPath)
    let content = ''
    try {
      content = readFileSync(staged, 'utf8')
    } catch {
      content = ''
    }
    return { path: f.path, content }
  })
  const diffs = computeDiffs(
    root,
    (manifest?.files ?? []).map((f) => ({
      path: f.path,
      stagedPath: f.stagedPath,
    })),
  )
  const diffText = renderUnifiedDiff(diffs)

  if (!check.ok) {
    const err = new AnvilError(ErrorCode.StaleStaging, check.reason ?? 'Cannot apply', {
      ...(check.hint === undefined ? {} : { hint: check.hint }),
    })
    const data = {
      schemaVersion: 1,
      staged: manifest !== null,
      applied: false,
      diff: diffText,
    }
    ctx.outFailure(data, err, () => {
      const s = ctx.style
      const out = [`\n${s.red('error')} ${err.message}`, '']
      if (diffText !== '') {
        out.push(s.bold('Staged diff'), diffText, '')
      }
      out.push(`${s.dim('hint ')} ${err.hint ?? ''}`, '')
      return out.join('\n')
    })
    return err.exitCode
  }

  const validation = validateAll(artifacts)

  if (!validation.ok) {
    const err = new AnvilError(ErrorCode.Internal, `Staged artifacts failed validation; nothing was written`, {
      hint: validation.errors.map((e) => `${e.path}: ${e.message}`).join('\n'),
    })
    ctx.outFailure(
      {
        schemaVersion: 1,
        staged: true,
        applied: false,
        validation,
        diff: diffText,
      },
      err,
      () => {
        const s = ctx.style
        const out = [`\n${s.red('error')} ${err.message}`, '']
        if (diffText !== '') {
          out.push(s.bold('Staged diff'), diffText, '')
        }
        out.push(`${s.dim('hint ')} ${err.hint ?? ''}`, '')
        return out.join('\n')
      },
    )
    return err.exitCode
  }
  if (validation.warnings.length > 0 && !allowWarnings) {
    const err = new AnvilError(
      ErrorCode.Usage,
      `${validation.warnings.length} staged artifact warning(s); refusing to apply`,
      {
        hint: `${validation.warnings.map((w) => `${w.path}: ${w.message}`).join('\n')}\n\nRe-run with --allow-warnings if these are expected.`,
      },
    )
    ctx.outFailure(
      {
        schemaVersion: 1,
        staged: true,
        applied: false,
        validation,
        diff: diffText,
      },
      err,
      () => {
        const s = ctx.style
        const out = [`\n${s.red('error')} ${err.message}`, '']
        if (diffText !== '') {
          out.push(s.bold('Staged diff'), diffText, '')
        }
        out.push(`${s.dim('hint ')} ${err.hint ?? ''}`, '')
        return out.join('\n')
      },
    )
    return err.exitCode
  }

  const state = inspectStaging(root)
  const written = applyStaging(root, manifest as NonNullable<typeof manifest>)
  clearStaging(root)

  const data = {
    schemaVersion: 1,
    staged: true,
    applied: true,
    inputHash: currentHash,
    written,
    editedByUser: state.tampered,
    validation,
  }

  if (json) {
    ctx.out(data, () => '')
    return 0
  }

  const s = ctx.style
  const lines: string[] = []
  lines.push(`${s.green('applied')} ${written.length} file(s):`)
  for (const p of written) lines.push(`  ${p}`)
  if (state.tampered.length > 0) {
    lines.push('')
    lines.push(
      s.yellow(`note: ${state.tampered.length} staged file(s) were edited before applying; those edits were kept`),
    )
    for (const p of state.tampered) lines.push(`  ${p}`)
  }
  lines.push('')
  lines.push(s.dim('Review with `git diff`, then commit. `.anvil/` is gitignored.'))
  ctx.out(data, () => lines.join('\n'))
  return 0
}

function renderStaged(
  ctx: CommandContext,
  artifacts: readonly GeneratedArtifact[],
  diffs: readonly FileDiff[],
  totals: { files: number; added: number; removed: number },
  tampered: readonly string[],
  warnings: readonly { path: string; message: string }[],
): string {
  const s = ctx.style
  const out: string[] = []

  out.push(
    `${s.bold('staged')} ${totals.files} file(s), +${totals.added} -${totals.removed} ${s.dim('(nothing written to the repository)')}`,
  )
  out.push('')
  out.push(s.bold('Artifacts'))
  out.push(
    renderTable(
      ['path', 'bytes', 'why'],
      artifacts.map((a) => [a.path, String(Buffer.byteLength(a.content)), a.reason]),
      s,
    ),
  )
  if (warnings.length > 0) {
    out.push('')
    out.push(s.yellow('Validation warnings'))
    for (const w of warnings) out.push(`  ${w.path}: ${w.message}`)
  }
  if (tampered.length > 0) {
    out.push('')
    out.push(s.yellow('Edited since staging'))
    for (const p of tampered) out.push(`  ${p}`)
  }
  out.push('')
  out.push(s.bold('Diff'))
  out.push(renderUnifiedDiff(diffs) || s.dim('  (no changes; the repository already has these files)'))
  out.push('')
  out.push(s.dim('Apply with: anvil init --apply'))
  return out.join('\n')
}

function renderInitError(
  ctx: CommandContext,
  err: AnvilError,
  diffs: readonly FileDiff[],
  validation: ReturnType<typeof validateAll>,
  totals: { files: number; added: number; removed: number },
): string {
  const s = ctx.style
  const out: string[] = []
  out.push(`${s.red('error')} ${err.message}`)
  out.push('')
  out.push(s.bold('Validation errors'))
  for (const e of validation.errors) out.push(`  ${s.red(e.path)}: ${e.message}`)
  out.push('')
  out.push(s.bold(`Diff (${totals.files} files, +${totals.added} -${totals.removed})`))
  out.push(renderUnifiedDiff(diffs))
  return `${out.join('\n')}\n`
}
