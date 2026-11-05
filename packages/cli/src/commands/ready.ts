/**
 * `anvil ready` -- what an AI needs in this repository, and whether it is here.
 *
 * The command an engineer runs on their first day in a repository they did not write:
 * which commands this project expects, which tools those commands need, what the agent
 * reads first, and which of those are actually present. It reports `verified`, `blocked`
 * or `unknown` and never guesses between them.
 *
 * Non-executing by default. `--check` opts in to probing the environment, which is a PATH
 * lookup and a bounded `--version`; no command from the repository is run, and no setup
 * action in the report is executed. `anvil ready` proposes, a person approves.
 */

import { AnvilError, ErrorCode, loadConfig, parseCliArgs, type Style } from '@anvil/core'
import { buildReadyReport, type ReadyReport } from '@anvil/derive'
import { loadPlaybooks, matchPlaybooks } from '@anvil/playbooks'
import { loadProfile, parseMaxFiles } from './doctor.ts'
import type { Command } from './types.ts'

export const readyCommand: Command = {
  name: 'ready',
  summary: 'Report what an AI needs here, and whether it is available.',
  usage: 'anvil ready [--json] [--profile <dir>] [--max-files <n>] [--check] [--fail-on-blocked]',
  details: [
    'Reads the repository and the declared project capabilities in anvil.config.json.',
    'Reports each need as verified, blocked or unknown -- never guessed.',
    '',
    'Without --check, no process is spawned and every tool is `unknown`. With --check,',
    'each tool is a PATH lookup and a bounded version probe; a declared version range is',
    'compared with the reported version. Declared environment variables are checked for',
    'presence by name only -- a value is never read into the report. Declared services are',
    'checked with a bounded loopback TCP connect, which sends no data. The repository is',
    'never built or tested, and no setup action is run.',
    '',
    '--check             probe the environment (opt-in; the only mode that spawns)',
    '--fail-on-blocked   exit 6 when the report is blocked, for a CI gate',
    '--max-files <n>     cap the walk; a truncated profile is reported as incomplete',
  ].join('\n'),
  flags: {
    json: { type: 'boolean', short: 'j' },
    help: { type: 'boolean', short: 'h' },
    profile: { type: 'string' },
    'max-files': { type: 'string' },
    check: { type: 'boolean' },
    'fail-on-blocked': { type: 'boolean' },
  },

  async run(ctx, rawArgs) {
    const args = parseCliArgs(rawArgs, readyCommand.flags)
    const target = typeof args.values.profile === 'string' ? args.values.profile : undefined
    const maxFiles = parseMaxFiles(args.values['max-files'])
    const profile = await loadProfile(ctx, target, maxFiles)

    const { playbooks } = loadPlaybooks(process.env)
    const matches = matchPlaybooks(profile, playbooks)
    // The declared capabilities come from the same repository being profiled, so `--profile`
    // and the config layer cannot disagree about which project the report is about.
    const resolved = loadConfig({ repoRoot: profile.root })

    const report = await buildReadyReport({
      profile,
      matches,
      declared: resolved.config.project,
      check: args.values.check === true,
    })

    if (args.values['fail-on-blocked'] === true && report.status === 'blocked') {
      const names = [
        ...report.tools
          .filter(
            (t) => t.required && (t.status === 'missing' || t.status === 'unavailable' || t.status === 'incompatible'),
          )
          .map((t) => t.id),
        ...report.env.filter((e) => e.required && (e.status === 'missing' || e.status === 'empty')).map((e) => e.name),
        ...report.services.filter((s) => s.required && s.status === 'unreachable').map((s) => s.id),
        ...report.context.filter((c) => c.status === 'blocked').map((c) => c.id),
      ]
      const err = new AnvilError(
        ErrorCode.ThresholdNotMet,
        `Readiness blocked: ${names.join(', ') || 'required needs are missing'}`,
        {
          hint: 'Run `anvil ready` without --fail-on-blocked to see every need, or approve the proposed actions.',
          details: { status: report.status, blocked: names },
        },
      )
      ctx.outFailure(report, err, () => `${renderReady(report, ctx.style)}\n\n${renderErrorText(err, ctx.style)}`)
      return err.exitCode
    }

    ctx.out(report, () => renderReady(report, ctx.style))
  },
}

function renderErrorText(err: AnvilError, style: Style): string {
  const lines = [`${style.red('error')} ${err.message}`]
  if (err.hint !== undefined) lines.push(`${style.dim('hint ')} ${err.hint}`)
  return lines.join('\n')
}

function statusTag(status: string, style: Style): string {
  switch (status) {
    case 'verified':
    case 'available':
      return style.green(status === 'available' ? 'available' : 'verified ')
    case 'present':
      return style.green('present  ')
    case 'reachable':
      return style.green('reachable')
    case 'unreachable':
      return style.red('refused  ')
    case 'empty':
      return style.red('empty    ')
    case 'blocked':
    case 'missing':
    case 'unavailable':
    case 'incompatible':
      return style.red(
        status === 'missing'
          ? 'missing  '
          : status === 'unavailable'
            ? 'unusable '
            : status === 'incompatible'
              ? 'incompat '
              : 'blocked  ',
      )
    default:
      return style.dim('unknown  ')
  }
}

function overallTag(status: ReadyReport['status'], style: Style): string {
  switch (status) {
    case 'verified':
      return style.green('VERIFIED')
    case 'blocked':
      return style.red('BLOCKED')
    default:
      return style.yellow('UNKNOWN')
  }
}

function renderReady(report: ReadyReport, style: Style): string {
  const s = style
  const out: string[] = []

  out.push(`${s.bold('root')}     ${report.root}`)
  if (report.projectDir !== '') out.push(`${s.bold('project')}  ${report.projectDir}`)
  out.push(
    `${s.bold('status')}   ${overallTag(report.status, s)} ${
      report.checked ? s.dim('(environment checked)') : s.dim('(environment not checked; pass --check)')
    }`,
  )
  out.push(
    s.dim(
      `         ${report.summary.verified} verified, ${report.summary.blocked} blocked, ${report.summary.unknown} unknown`,
    ),
  )

  out.push('')
  out.push(s.bold('Commands'))
  out.push(
    report.commands.length === 0
      ? s.dim('  (none detected or declared)')
      : report.commands
          .map((c) => {
            const dir = c.dir === '' ? '' : s.dim(` (in ${c.dir})`)
            const evidence = c.evidence === null ? '' : s.dim(` ${c.evidence}`)
            return `  ${c.kind.padEnd(9)} ${c.cmd.padEnd(30)} ${c.source.padEnd(10)} ${statusTag(c.status, s)}${dir}${evidence}`
          })
          .join('\n'),
  )

  out.push('')
  out.push(s.bold('Environment'))
  out.push(
    report.tools.length === 0
      ? s.dim('  (no tools required or inferred)')
      : report.tools
          .map((t) => {
            const req = t.required ? s.yellow('required') : s.dim('optional')
            const version = t.version === null ? '' : s.dim(` ${t.version}`)
            const range = t.versionRange === null ? '' : s.dim(` (requires ${t.versionRange})`)
            const reason = t.reason === null ? '' : s.dim(` -- ${t.reason}`)
            return `  ${t.id.padEnd(12)} ${statusTag(t.status, s)} ${req}${version}${range}${reason}`
          })
          .join('\n'),
  )

  out.push('')
  out.push(s.bold('Environment variables'))
  out.push(
    report.env.length === 0
      ? s.dim('  (none declared)')
      : report.env
          .map((e) => {
            const req = e.required ? s.yellow('required') : s.dim('optional')
            const reason = e.reason === null ? '' : s.dim(` -- ${e.reason}`)
            return `  ${e.name.padEnd(20)} ${statusTag(e.status, s)} ${req}${reason}`
          })
          .join('\n'),
  )

  out.push('')
  out.push(s.bold('Services'))
  out.push(
    report.services.length === 0
      ? s.dim('  (none declared)')
      : report.services
          .map((x) => {
            const req = x.required ? s.yellow('required') : s.dim('optional')
            const address = s.dim(` ${x.host}:${x.port}`)
            const reason = x.reason === null ? '' : s.dim(` -- ${x.reason}`)
            return `  ${x.id.padEnd(20)} ${statusTag(x.status, s)} ${req}${address}${reason}`
          })
          .join('\n'),
  )

  out.push('')
  out.push(s.bold('Context'))
  out.push(report.context.map((c) => `  ${c.label.padEnd(20)} ${statusTag(c.status, s)} ${s.dim(c.detail)}`).join('\n'))

  if (report.actions.length > 0) {
    out.push('')
    out.push(s.bold('Proposed actions'))
    out.push(s.dim('  Nothing has run. Each action needs approval.'))
    for (const action of report.actions) {
      const cmd = action.command === null ? s.dim('(no command proposed)') : `run: ${action.command}`
      out.push(`  ${action.summary}`)
      out.push(`    ${cmd}`)
      out.push(`    ${s.dim(action.reason)}`)
    }
  }

  if (report.warnings.length > 0) {
    out.push('')
    out.push(s.yellow('Warnings'))
    for (const warning of report.warnings) out.push(`  ${warning}`)
  }

  return out.join('\n')
}
