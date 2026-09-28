/**
 * Help rendering.
 *
 * Available commands and the planned surface are printed separately. The planned list is
 * a roadmap, not a menu -- it lives under its own heading and is never dispatchable.
 */

import { renderTable, type Style } from '@anvil/core'
import { PLANNED_COMMANDS, type Command } from './commands/types.ts'

function renderFlagTable(flags: Record<string, { type: string; short?: string; multiple?: boolean }>, style: Style): string {
  const rows = Object.entries(flags).map(([name, spec]) => {
    const short = spec.short === undefined ? '    ' : `-${spec.short}, `
    const nameCell = `${short}--${name}`
    const notes: string[] = []
    notes.push(spec.type)
    if (spec.multiple === true) notes.push('repeatable')
    return [nameCell, notes.join(', ')]
  })
  return renderTable(['flag', 'type'], rows, style)
}

export function renderRootHelp(commands: Command[], style: Style): string {
  const lines: string[] = []
  lines.push(style.bold('anvil') + ' - AI-ready dev harness')
  lines.push('')
  lines.push('Audit a repo for AI-readiness, derive agent context, and work tickets')
  lines.push('in parallel git worktrees.')
  lines.push('')
  lines.push(style.bold('USAGE'))
  lines.push('  anvil <command> [flags]')
  lines.push('')
  lines.push(style.bold('COMMANDS'))
  lines.push(
    renderTable(
      ['command', 'summary'],
      commands.map((c) => [`anvil ${c.name}`, c.summary]),
      style,
    ),
  )
  lines.push('')
  lines.push(style.bold('GLOBAL FLAGS'))
  lines.push('  -j, --json      Emit the versioned JSON envelope (see `anvil version`)')
  lines.push('      --no-color  Disable ANSI color')
  lines.push('  -h, --help      Show help for a command')
  lines.push('')
  lines.push(style.bold('PLANNED'))
  lines.push(style.dim('  Not implemented yet. Shown so the roadmap is discoverable.'))
  lines.push(
    renderTable(
      ['command', 'summary', 'ships'],
      PLANNED_COMMANDS.map((c) => [c.usage, c.summary, style.dim(c.milestone)]),
      style,
    ),
  )
  lines.push('')
  return lines.join('\n')
}

export function renderCommandHelp(command: Command, style: Style): string {
  const lines: string[] = []
  lines.push(style.bold(`anvil ${command.name}`) + ' - ' + command.summary)
  lines.push('')
  lines.push(style.bold('USAGE'))
  lines.push(`  ${command.usage}`)
  if (command.details !== undefined) {
    lines.push('')
    lines.push(style.bold('DETAILS'))
    for (const line of command.details.split('\n')) lines.push(`  ${line}`)
  }
  lines.push('')
  lines.push(style.bold('FLAGS'))
  lines.push(renderFlagTable(command.flags, style))
  lines.push('')
  return lines.join('\n')
}
