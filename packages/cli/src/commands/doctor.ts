/**
 * `anvil profile` and `anvil doctor`.
 *
 * Two commands, two audiences. `profile` emits the detected facts that M2b's brief
 * builder and the opencode plugin consume. `doctor` runs the rules over those facts and
 * renders the thing a human actually reads.
 *
 * Neither runs a build, so both are safe on a repository you cannot modify.
 */

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import {
  AnvilError,
  ErrorCode,
  ExitCode,
  discoverRepo,
  parseCliArgs,
  renderTable,
  type Style,
} from '@anvil/core'
import { audit, LAYERS, LAYER_QUESTIONS, LAYER_TITLES, type Layer, type ReadinessReport, type Severity } from '@anvil/audit'
import { buildProfile, type ProjectProfile, type VcsHost } from '@anvil/profile'
import type { Command, CommandContext } from './types.ts'

function detectHost(remote: string): VcsHost {
  if (/github\.com|github\./i.test(remote)) return 'github'
  if (/gitlab/i.test(remote)) return 'gitlab'
  if (/bitbucket/i.test(remote)) return 'bitbucket'
  if (/dev\.azure\.com|visualstudio\.com/i.test(remote)) return 'azure'
  return null
}

/**
 * Build a profile for a directory.
 *
 * An explicit `--profile <dir>` is analysed *as given*. It is deliberately not hoisted to
 * the enclosing git repository root: a directory nested inside a repo is a normal thing to
 * point this at, and silently auditing the parent instead would report the wrong project
 * with total confidence. The enclosing repo is consulted only for provenance (host,
 * remote, default branch).
 */
async function loadProfile(ctx: CommandContext, target: string | undefined): Promise<ProjectProfile> {
  const dir = target ?? ctx.repoRoot
  if (dir === undefined || dir === null) {
    throw new AnvilError(ErrorCode.NotAGitRepo, 'Not inside a git repository', {
      hint: 'Run anvil from inside a repository, or pass --profile <dir>.',
    })
  }

  const root = resolve(dir)
  const info = target === undefined ? ctx.repo : await discoverRepo(root)

  return buildProfile(root, {
    root,
    host: info?.remote == null ? null : detectHost(info.remote),
    remote: info?.remote ?? null,
    defaultBranch: info?.defaultBranch ?? null,
  }).profile
}

// ---------------------------------------------------------------------------
// anvil profile
// ---------------------------------------------------------------------------

export const profileCommand: Command = {
  name: 'profile',
  summary: 'Detect the stack and emit a ProjectProfile.',
  usage: 'anvil profile [--json] [--profile <dir>] [--no-files]',
  details: [
    'Reads files; never runs a build.',
    '',
    'Every command is labeled documented, detected or inferred. Only a documented',
    'command has been written down by a human, and `ship` will not execute an inferred',
    'one without --probe.',
  ].join('\n'),
  flags: {
    json: { type: 'boolean', short: 'j' },
    noColor: { type: 'boolean' },
    help: { type: 'boolean', short: 'h' },
    profile: { type: 'string' },
    'no-files': { type: 'boolean' },
  },

  async run(ctx, rawArgs) {
    const args = parseCliArgs(rawArgs, profileCommand.flags)
    const target = typeof args.values.profile === 'string' ? args.values.profile : undefined
    const profile = await loadProfile(ctx, target)
    const omitFiles = args.values['no-files'] === true

    // The file list dominates the payload, so `--no-files` replaces it with a count
    // rather than leaving the consumer to guess whether an empty array means "empty repo"
    // or "files omitted".
    const data = omitFiles ? { ...profile, files: undefined, fileCount: profile.files.length } : profile

    ctx.out(data, () => renderProfile(ctx, profile))
  },
}

function renderProfile(ctx: CommandContext, p: ProjectProfile): string {
  const s = ctx.style
  const out: string[] = []

  out.push(`${s.bold('root')}       ${p.root}`)
  out.push(`${s.bold('vcs')}        ${p.vcs.host ?? s.dim('unknown')}${p.vcs.remote === null ? '' : ` ${s.dim(p.vcs.remote)}`}`)
  out.push(`${s.bold('default')}    ${p.vcs.defaultBranch ?? s.dim('(unknown)')}`)

  out.push('')
  out.push(s.bold('Languages'))
  out.push(
    p.languages.length === 0
      ? s.dim('  (none detected)')
      : p.languages.map((l) => `  ${l.primary ? s.green('*') : ' '} ${l.id.padEnd(12)} ${String(l.files)} files`).join('\n'),
  )

  out.push('')
  out.push(s.bold('Stack'))
  out.push(
    p.stacks.length === 0
      ? s.dim('  (none detected)')
      : p.stacks.map((st) => `  ${st.id.padEnd(14)} ${(st.version ?? '').padEnd(10)} ${s.dim(st.evidence[0] ?? '')}`).join('\n'),
  )

  if (p.monorepo !== null) {
    out.push('')
    out.push(s.bold('Monorepo'))
    out.push(`  tool     ${p.monorepo.tool} ${s.dim(p.monorepo.evidence)}`)
    out.push(`  members  ${p.monorepo.members.length === 0 ? s.dim('(none resolved)') : p.monorepo.members.join(', ')}`)
  }

  if (p.modules.length > 0) {
    out.push('')
    out.push(s.bold('Modules'))
    out.push(
      renderTable(
        ['id', 'path', 'depends on'],
        p.modules.map((m) => [m.id, m.path, m.deps.length === 0 ? s.dim('-') : m.deps.join(', ')]),
        s,
      ),
    )
  }

  const kinds = Object.keys(p.commands).sort()
  if (kinds.length > 0) {
    out.push('')
    out.push(s.bold('Commands'))
    for (const kind of kinds) {
      for (const entry of p.commands[kind as keyof typeof p.commands] ?? []) {
        const tag =
          entry.source === 'documented' ? s.green('documented') : entry.source === 'detected' ? s.cyan('detected') : s.yellow('inferred')
        out.push(`  ${kind.padEnd(10)} ${entry.cmd.padEnd(32)} ${tag} ${s.dim(entry.evidence ?? '')}`)
      }
    }
  }

  out.push('')
  out.push(s.bold('Instructions'))
  out.push(
    p.instructions.length === 0
      ? s.dim('  (none) -- an agent has no project context')
      : p.instructions.map((i) => `  ${i.path} ${s.dim(`[${i.category}]`)}`).join('\n'),
  )

  out.push('')
  out.push(s.bold('Risk paths'))
  out.push(
    p.risk.length === 0
      ? s.dim('  (none)')
      : p.risk
          .map((r) => `  ${(r.level === 'high' ? s.red('high  ') : s.yellow('medium'))} ${r.glob.padEnd(30)} ${s.dim(r.reason)}`)
          .join('\n'),
  )

  return out.join('\n')
}

// ---------------------------------------------------------------------------
// anvil doctor
// ---------------------------------------------------------------------------

const SEVERITY_RANK: Record<Severity, number> = { blocker: 0, high: 1, medium: 2, low: 3, info: 4 }

export const doctorCommand: Command = {
  name: 'doctor',
  summary: 'Audit AI-readiness and score the repository.',
  usage: 'anvil doctor [--json] [--profile <dir>] [--layer <l>] [--fail-on <sev>] [--strict]',
  details: [
    'Four layers: can the agent understand the repo, can it verify its work, does it',
    'know the technology, should it be allowed to act.',
    '',
    'Every finding carries file:line evidence and a concrete fix. Rules that cannot',
    'decide report `na` rather than failing, so the report is not padded with false',
    'positives.',
    '',
    '--fail-on <severity>  exit 6 when a finding of that severity or worse fails',
    '--strict              shorthand for --fail-on high',
  ].join('\n'),
  flags: {
    json: { type: 'boolean', short: 'j' },
    noColor: { type: 'boolean' },
    help: { type: 'boolean', short: 'h' },
    profile: { type: 'string' },
    layer: { type: 'string', multiple: true },
    'fail-on': { type: 'string' },
    strict: { type: 'boolean' },
  },

  async run(ctx, rawArgs) {
    const args = parseCliArgs(rawArgs, doctorCommand.flags)
    const target = typeof args.values.profile === 'string' ? args.values.profile : undefined
    const profile = await loadProfile(ctx, target)

    const layers = parseLayers(args.values.layer)
    const report = audit(profile, layers === null ? {} : { layers })

    const failOn = parseSeverity(args.values['fail-on']) ?? (args.values.strict === true ? 'high' : null)
    const breach =
      failOn === null
        ? null
        : (report.findings.find(
            (f) => f.status === 'fail' && SEVERITY_RANK[f.severity] <= SEVERITY_RANK[failOn],
          ) ?? null)

    // The report is the answer; the exit code is the verdict. Emit the report first so a
    // caller parsing stdout gets the full payload either way.
    ctx.out(report, () => renderReport(ctx, report))

    if (breach !== null) {
      const err = new AnvilError(
        ErrorCode.ThresholdNotMet,
        `Readiness threshold not met: ${breach.id} failed at severity ${breach.severity} (score ${report.score}/100, grade ${report.grade})`,
        {
          hint: 'Run `anvil doctor` without --fail-on to see every finding, or `anvil plan` for ranked fixes.',
          details: { rule: breach.id, severity: breach.severity, score: report.score, grade: report.grade },
        },
      )
      if (!ctx.json) {
        ctx.writeError(`\n${renderErrorText(err, ctx.style)}`)
      }
      return err.exitCode
    }

    return undefined
  },
}

function parseLayers(value: unknown): Layer[] | null {
  const list = Array.isArray(value) ? value : typeof value === 'string' ? value.split(',') : []
  const cleaned = list.map((v) => (v as string).trim()).filter((v) => v !== '')
  if (cleaned.length === 0) return null
  const out: Layer[] = []
  for (const raw of cleaned) {
    if (!LAYERS.includes(raw as Layer)) {
      throw new AnvilError(ErrorCode.Usage, `Unknown layer: ${raw}`, {
        hint: `Expected one of: ${LAYERS.join(', ')}`,
      })
    }
    out.push(raw as Layer)
  }
  return out
}

const SEVERITIES: readonly Severity[] = ['blocker', 'high', 'medium', 'low', 'info']

function parseSeverity(value: unknown): Severity | null {
  if (typeof value !== 'string' || value === '') return null
  if (!SEVERITIES.includes(value as Severity)) {
    throw new AnvilError(ErrorCode.Usage, `Unknown severity: ${value}`, {
      hint: `Expected one of: ${SEVERITIES.join(', ')}`,
    })
  }
  return value as Severity
}

function statusMark(status: string, s: Style): string {
  switch (status) {
    case 'pass':
      return s.green('ok  ')
    case 'warn':
      return s.yellow('warn')
    case 'fail':
      return s.red('FAIL')
    default:
      return s.dim('na  ')
  }
}

function barFor(score: number, s: Style): string {
  const filled = Math.max(0, Math.min(10, Math.round(score / 10)))
  const bar = '█'.repeat(filled) + '░'.repeat(10 - filled)
  return score >= 70 ? s.green(bar) : score >= 40 ? s.yellow(bar) : s.red(bar)
}

function renderReport(ctx: CommandContext, report: ReadinessReport): string {
  const s = ctx.style
  const out: string[] = []

  const grade =
    report.grade === 'A' || report.grade === 'B' ? s.green(report.grade) : report.grade === 'C' ? s.yellow(report.grade) : s.red(report.grade)
  out.push(`${s.bold('AI readiness')}  ${String(report.score)}/100  ${grade}`)
  out.push('')
  out.push(s.bold('By layer'))
  for (const layer of report.layers) {
    out.push(
      `  ${LAYER_TITLES[layer.layer].padEnd(14)} ${String(layer.score).padStart(3)}  ${barFor(layer.score, s)}  ${s.dim(LAYER_QUESTIONS[layer.layer])}`,
    )
  }

  for (const layer of LAYERS) {
    const findings = report.findings.filter((f) => f.layer === layer && f.status !== 'na')
    if (findings.length === 0) continue
    out.push('')
    out.push(s.bold(`${LAYER_TITLES[layer]} (${findings.length})`))
    out.push(
      renderTable(
        ['', 'rule', 'severity', 'finding'],
        findings.map((f) => [statusMark(f.status, s), f.id, f.severity, f.detail]),
        s,
      ),
    )
  }

  const withFix = report.findings.filter((f) => f.fix !== null && f.status !== 'pass')
  if (withFix.length > 0) {
    out.push('')
    out.push(s.bold(`Suggested fixes (${withFix.length})`))
    for (const f of withFix) {
      const fix = f.fix
      if (fix === null) continue
      const origin = fix.origin === 'derived' ? s.cyan('derived') : fix.origin === 'official' ? s.green('official') : s.yellow('community')
      out.push(`  ${f.id.padEnd(20)} ${origin}  ${fix.summary}`)
      if (fix.source?.url !== undefined) out.push(`      ${s.dim(fix.source.url)}`)
    }
  }

  if (report.degraded.length > 0) {
    out.push('')
    out.push(s.yellow('Degraded'))
    for (const d of report.degraded) out.push(`  ${d.reason}`)
  }

  return out.join('\n')
}

function renderErrorText(err: AnvilError, s: Style): string {
  const lines = [`${s.red('error')} ${err.message}`]
  if (err.hint !== undefined) lines.push(`${s.dim('hint ')} ${err.hint}`)
  return lines.join('\n') + '\n'
}
