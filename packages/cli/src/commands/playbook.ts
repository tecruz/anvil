/**
 * `anvil playbook` -- inspect the registry, and check it for rot.
 *
 * Three subcommands, and the split is deliberate:
 *
 *   - `list` and `show` are **offline and read-only**. They answer "what guidance does
 *     anvil have for this technology, and where did it come from", which is the question
 *     `plan` answers from the other end. Cheap, deterministic, always available.
 *
 *   - `check` is the mitigation the plan's risk table promised and never built: it
 *     validates the registry, and with `--probe` (on by default when online) it asks the
 *     network whether every URL is still there. The plan also said it validates "version
 *     ranges"; the schema has no version-range field, so there is nothing to validate and
 *     the promise is narrowed rather than faked.
 *
 * Exit codes: 0 clean, 6 (threshold) when something is wrong, 2 for usage. A rot check that
 * always exits 0 is a report, not a check.
 */

import { AnvilError, ErrorCode, ExitCode, type FlagSpecs, parseCliArgs, renderTable } from '@anvil/core'
import {
  type CheckReport,
  checkPlaybooks,
  loadPlaybooks,
  type Playbook,
  type Problem,
  type ProblemLevel,
} from '@anvil/playbooks'
import type { Command, CommandContext } from './types.ts'

const SUBCOMMANDS = ['list', 'show', 'check'] as const
type Subcommand = (typeof SUBCOMMANDS)[number]

function load(env: NodeJS.ProcessEnv = process.env): { playbooks: Playbook[]; warnings: string[] } {
  return loadPlaybooks(env)
}

/** A playbook's resources, flattened for display, with the section each came from. */
function resourceRows(playbook: Playbook): Array<[string, string, string]> {
  const groups: Array<[string, Array<{ label: string; url: string }>]> = [
    ['doc', playbook.official.docs],
    ['skill', playbook.official.skills],
    ['agent', playbook.official.agents],
    ['mcp', playbook.official.mcp],
    ['style', playbook.official.styleGuides],
    ['migration', playbook.official.migrationGuides],
    ['community', playbook.community],
  ]
  const rows: Array<[string, string, string]> = []
  for (const [kind, list] of groups) {
    for (const r of list) rows.push([kind, r.label, r.url])
  }
  return rows
}

function parseCount(value: unknown, name: string): number | undefined {
  if (value === undefined) return undefined
  const n = Number.parseInt(String(value), 10)
  if (!Number.isFinite(n) || n < 1) {
    throw new AnvilError(ErrorCode.Usage, `Invalid --${name}: ${String(value)}`, {
      hint: 'Expected a positive integer.',
    })
  }
  return n
}

const FLAGS: FlagSpecs = {
  json: { type: 'boolean', short: 'j' },
  noColor: { type: 'boolean' },
  help: { type: 'boolean', short: 'h' },
  id: { type: 'string' },
  offline: { type: 'boolean' },
  concurrency: { type: 'string' },
  timeout: { type: 'string' },
  warnings: { type: 'boolean' },
}

export const playbookCommand: Command = {
  name: 'playbook',
  summary: 'Inspect the playbook registry and check it for rot.',
  usage: 'anvil playbook <list|show|check> [flags]',
  details: [
    'list     every playbook, where it came from, and what it matches',
    'show     one playbook in full, with every resource and its url',
    'check    validate the registry; with --probe, whether every url still resolves',
    '',
    'check is the mitigation for playbook rot. It exits 6 when something is wrong, so it',
    'is usable as a CI gate rather than a report nobody reads.',
    '',
    '--offline            skip the network; run only the structural checks',
    '--concurrency <n>    parallel url probes (default 6)',
    '--timeout <ms>       per-request timeout (default 15000)',
    '--warnings           exit non-zero on warnings as well as errors',
  ].join('\n'),
  flags: FLAGS,

  async run(ctx: CommandContext, rawArgs) {
    const args = parseCliArgs(rawArgs, playbookCommand.flags)
    const sub = (args.positionals[0] ?? 'list') as Subcommand
    if (!SUBCOMMANDS.includes(sub)) {
      throw new AnvilError(ErrorCode.Usage, `Unknown playbook subcommand: ${sub}`, {
        hint: `Expected one of: ${SUBCOMMANDS.join(', ')}`,
      })
    }

    const { playbooks, warnings } = load()
    if (sub === 'list') return runList(ctx, playbooks, warnings)
    if (sub === 'show') {
      // The id may be positional (`show terraform`) or a flag (`show --id terraform`);
      // accepting only one of them is the kind of small friction that makes people guess.
      const positional = args.positionals[1]
      const flag = typeof args.values.id === 'string' ? args.values.id : undefined
      return runShow(ctx, playbooks, flag ?? positional)
    }
    return runCheck(ctx, playbooks, warnings, args.values)
  },
}

function runList(ctx: CommandContext, playbooks: readonly Playbook[], warnings: readonly string[]): undefined {
  const rows = playbooks
    .slice()
    .sort((a, b) => b.priority - a.priority || a.id.localeCompare(b.id))
    .map((p) => [
      p.id,
      String(p.priority),
      `${p.match.files.length} file / ${p.match.deps.length} dep`,
      String(resourceRows(p).length),
      p.source ?? 'built-in',
    ])

  const data = {
    schemaVersion: 1,
    count: playbooks.length,
    playbooks: playbooks.map((p) => ({
      id: p.id,
      title: p.title,
      priority: p.priority,
      match: p.match,
      resources: resourceRows(p).length,
      source: p.source ?? 'built-in',
    })),
    warnings: [...warnings],
  }

  ctx.out(data, () => {
    const s = ctx.style
    const out: string[] = []
    out.push(
      `${s.bold('Playbooks')} ${playbooks.length}${warnings.length === 0 ? '' : s.yellow(`  (${warnings.length} warning(s))`)}`,
    )
    out.push('')
    out.push(renderTable(['id', 'prio', 'matches', 'res', 'source'], rows, s))
    if (warnings.length > 0) {
      out.push('')
      out.push(s.yellow('Warnings'))
      for (const w of warnings) out.push(`  ${w}`)
    }
    out.push('')
    out.push(s.dim('Detail: anvil playbook show <id>   Validate: anvil playbook check'))
    return out.join('\n')
  })
  return undefined
}

function runShow(ctx: CommandContext, playbooks: readonly Playbook[], id: string | undefined): undefined {
  if (id === undefined || id === '') {
    throw new AnvilError(ErrorCode.Usage, 'playbook show needs an id', {
      hint: 'Run `anvil playbook list` to see the ids, then `anvil playbook show <id>`.',
    })
  }
  const playbook = playbooks.find((p) => p.id === id)
  if (playbook === undefined) {
    throw new AnvilError(ErrorCode.Usage, `No playbook "${id}"`, {
      hint: 'Run `anvil playbook list` to see the ids.',
    })
  }

  const data = {
    schemaVersion: 1,
    playbook,
    resources: resourceRows(playbook).map(([kind, label, url]) => ({ kind, label, url })),
  }

  ctx.out(data, () => {
    const s = ctx.style
    const out: string[] = []
    out.push(`${s.bold(playbook.title)}  ${s.dim(`(${playbook.id}, priority ${playbook.priority})`)}`)
    out.push('')
    out.push(s.bold('Matches'))
    for (const f of playbook.match.files) out.push(`  file  ${f}`)
    for (const d of playbook.match.deps) out.push(`  dep   ${d}`)
    out.push('')
    if (Object.values(playbook.verify).some((v) => v.length > 0)) {
      out.push(s.bold('Verify commands'))
      for (const [kind, commands] of Object.entries(playbook.verify)) {
        for (const c of commands) out.push(`  ${kind.padEnd(10)} ${c}`)
      }
      out.push('')
    }
    if (playbook.riskGlobs.length > 0) {
      out.push(s.bold('High-risk paths'))
      for (const g of playbook.riskGlobs) out.push(`  ${g}`)
      out.push('')
    }
    if (playbook.conventions.reviewFocus.length > 0) {
      out.push(s.bold('Review focus'))
      for (const f of playbook.conventions.reviewFocus) out.push(`  ${f}`)
      out.push('')
    }
    out.push(s.bold(`Resources (${resourceRows(playbook).length})`))
    out.push(renderTable(['kind', 'label', 'url'], resourceRows(playbook), s))
    return out.join('\n')
  })
  return undefined
}

async function runCheck(
  ctx: CommandContext,
  playbooks: readonly Playbook[],
  warnings: readonly string[],
  values: Record<string, string | boolean | string[] | undefined>,
): Promise<number | void> {
  // Offline unless told otherwise: a rot check that needs the network to be useful is a rot
  // check that cannot run in a locked-down environment, which is the environment this tool
  // is built for. `--offline` makes the structural half explicit; `--probe` forces the rest.
  const offline = values.offline === true
  const report: CheckReport = await checkPlaybooks(playbooks, {
    probe: !offline,
    ...(parseCount(values.concurrency, 'concurrency') === undefined
      ? {}
      : { concurrency: parseCount(values.concurrency, 'concurrency') as number }),
    ...(parseCount(values.timeout, 'timeout') === undefined
      ? {}
      : { timeoutMs: parseCount(values.timeout, 'timeout') as number }),
  })

  const failed = report.counts.error > 0 || (values.warnings === true && report.counts.warn > 0)
  const data = {
    schemaVersion: 1,
    ok: !failed,
    probed: !offline,
    playbooks: playbooks.length,
    urls: report.urls,
    problems: report.problems,
    counts: { ...report.counts, loadWarnings: warnings.length },
    warnings: [...warnings],
  }

  if (failed) {
    // A failure with a full report is the whole point of this command, so the report
    // travels on the failure envelope rather than being printed to stderr and lost.
    const err = new AnvilError(
      ErrorCode.ThresholdNotMet,
      `${report.counts.error} error(s), ${report.counts.warn} warning(s) in the playbook registry`,
      {
        hint: 'Fix the dead links and structural errors. `anvil playbook show <id>` for detail, `--warnings` to fail on warnings too.',
        details: { problems: report.problems },
      },
    )
    ctx.outFailure(data, err, () => renderCheck(ctx, report, warnings, true, values.warnings === true))
    return ExitCode.Threshold
  }

  ctx.out(data, () => renderCheck(ctx, report, warnings, false, false))
  return undefined
}

function renderCheck(
  ctx: CommandContext,
  report: CheckReport,
  warnings: readonly string[],
  failed: boolean,
  failOnWarnings: boolean,
): string {
  const s = ctx.style
  const out: string[] = []
  const probed = report.urls.some((u) => !u.detail.startsWith('not probed'))

  out.push(
    failed
      ? `${s.red('playbook check failed')}  ${report.counts.error} error(s), ${report.counts.warn} warning(s), ${report.counts.info} note(s)`
      : `${s.green('playbook check clean')}  ${report.counts.warn} warning(s), ${report.counts.info} note(s)`,
  )
  out.push(
    s.dim(`  ${report.urls.length} url(s) ${probed ? 'probed over the network' : 'listed but not probed (offline)'}`),
  )

  if (report.problems.length > 0) {
    out.push('')
    out.push(s.bold('Problems'))
    const order: Record<ProblemLevel, number> = { error: 0, warn: 1, info: 2 }
    const sorted = report.problems
      .slice()
      .sort((a, b) => order[a.level] - order[b.level] || a.where.localeCompare(b.where))
    for (const p of sorted) {
      const mark = p.level === 'error' ? s.red('error') : p.level === 'warn' ? s.yellow('warn ') : s.dim('note ')
      out.push(`  ${mark}  ${s.dim(p.where)}`)
      out.push(`         ${p.message}`)
      if (p.fix !== undefined) out.push(`         ${s.dim(p.fix)}`)
    }
  }

  const gone = report.urls.filter((u) => u.outcome === 'gone')
  const unconfirmed = report.urls.filter((u) => u.outcome === 'unconfirmed')
  if (gone.length > 0 || unconfirmed.length > 0) {
    out.push('')
    out.push(s.bold(`Links (${gone.length} dead, ${unconfirmed.length} unconfirmed)`))
    for (const u of [...gone, ...unconfirmed]) {
      const mark = u.outcome === 'gone' ? s.red('dead') : s.yellow('????')
      out.push(`  ${mark}  ${u.url}`)
      out.push(`        ${s.dim(`${u.detail}  cited by ${u.citedBy.join(', ')}`)}`)
    }
    if (unconfirmed.length > 0) {
      out.push('')
      out.push(
        s.dim(
          '  Unconfirmed is not a failure: 403 from a bot wall, a rate limit, a timeout or a 5xx all land here. Re-run later.',
        ),
      )
    }
  }

  if (warnings.length > 0) {
    out.push('')
    out.push(s.yellow(`Load warnings (${warnings.length})`))
    for (const w of warnings) out.push(`  ${w}`)
  }

  if (!failed && failOnWarnings) {
    out.push('')
    out.push(s.yellow('--warnings was passed and there are warnings'))
  }
  out.push('')
  out.push(s.dim('A dead link is a 404 or 410. Everything else is reported, not failed.'))
  return out.join('\n')
}

/** Re-exported for the help renderer. */
export const PLAYBOOK_SUBCOMMANDS = SUBCOMMANDS
export type { Problem }
