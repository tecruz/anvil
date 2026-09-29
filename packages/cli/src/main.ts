/**
 * anvil CLI entry point.
 *
 * Responsibilities, in order:
 *   1. split the command out of argv
 *   2. decide output mode (--json wins, and is the only mode that writes on failure)
 *   3. discover the repo (best-effort; most commands do not need it)
 *   4. dispatch, and funnel every throw into one exit code
 *
 * The single funnel in `main()` is deliberate: no command gets to decide its own exit
 * behaviour, so scripts can rely on the exit-code table in `errors.ts`.
 */

import {
  AnvilError,
  ErrorCode,
  ExitCode,
  VERSION,
  emitJson,
  makeStyle,
  shouldUseColor,
  success,
  toAnvilError,
  type Envelope,
} from '@anvil/core'
import { discoverRepo } from '@anvil/git'
import { realpathSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { renderCommandHelp, renderRootHelp } from './help.ts'
import { configCommand } from './commands/config.ts'
import { briefCommand, initCommand } from './commands/init.ts'
import { doctorCommand, profileCommand } from './commands/doctor.ts'
import { planCommand } from './commands/plan.ts'
import { shipCommand } from './commands/ship.ts'
import { authCommand, claimCommand, issueCommand, releaseCommand, statusCommand } from './commands/work.ts'
import { versionCommand } from './commands/version.ts'
import type { Command, CommandContext } from './commands/types.ts'

const COMMANDS: Command[] = [
  authCommand,
  briefCommand,
  claimCommand,
  configCommand,
  doctorCommand,
  initCommand,
  issueCommand,
  planCommand,
  profileCommand,
  releaseCommand,
  shipCommand,
  statusCommand,
  versionCommand,
]

const GLOBAL_FLAGS = new Set(['--json', '-j', '--no-color', '--help', '-h'])

function findCommand(name: string): Command | undefined {
  return COMMANDS.find((c) => c.name === name)
}

export async function run(argv: string[]): Promise<number> {
  const json = argv.includes('--json') || argv.includes('-j')
  const noColor = argv.includes('--no-color')
  const wantsHelp = argv.includes('--help') || argv.includes('-h')

  // `anvil` or `anvil --json` with no command: print help, but in JSON mode emit an
  // envelope so a caller parsing stdout is not handed a help page.
  const firstPositional = argv.find((a) => !a.startsWith('-'))
  if (firstPositional === undefined) {
    if (json) {
      const style = makeStyle(false)
      emitJson('anvil', success('anvil', {
        version: VERSION,
        help: renderRootHelp(COMMANDS, style),
        commands: COMMANDS.map((c) => ({ name: c.name, summary: c.summary, usage: c.usage })),
      }))
      return ExitCode.Ok
    }
    const style = makeStyle(shouldUseColor({ noColor, stream: process.stdout, env: process.env }))
    process.stdout.write(renderRootHelp(COMMANDS, style))
    return ExitCode.Ok
  }

  const command = findCommand(firstPositional)
  if (command === undefined) {
    const err = new AnvilError(
      ErrorCode.UnknownCommand,
      `Unknown command: ${firstPositional}`,
      { hint: 'Run `anvil --help` to see available commands.' },
    )
    if (json) {
      emitJson('anvil', {
        schemaVersion: 1,
        ok: false,
        command: 'anvil',
        error: err.toJSON(),
      })
      return err.exitCode
    }
    process.stderr.write(renderFailureText(err, makeStyle(shouldUseColor({ noColor, stream: process.stderr, env: process.env }))))
    return err.exitCode
  }

  const rest = stripCommand(argv, firstPositional)

  if (wantsHelp) {
    const style = makeStyle(shouldUseColor({ noColor, stream: process.stdout, env: process.env }))
    const help = renderCommandHelp(command, style)
    if (json) {
      emitJson(command.name, success(command.name, { help }))
    } else {
      process.stdout.write(help)
    }
    return ExitCode.Ok
  }

  // Best-effort repo discovery. A missing repo is not an error until a command needs it.
  const repo = await discoverRepo(process.cwd())

  const colorEnabled = shouldUseColor({ noColor, stream: process.stdout, env: process.env })
  const style = makeStyle(colorEnabled)

  const ctx: CommandContext = {
    cwd: process.cwd(),
    repoRoot: repo === null ? null : repo.root,
    repo,
    style,
    json,
    say(message) {
      if (!json) process.stdout.write(message + '\n')
    },
    out(data, render) {
      if (json) {
        emitJson(command.name, success(command.name, data))
      } else {
        process.stdout.write(render() + '\n')
      }
    },
    writeRaw(text) {
      process.stdout.write(text)
    },
    writeError(text) {
      process.stderr.write(text)
    },
  }

  try {
    const code = await command.run(ctx, rest)
    return code ?? ExitCode.Ok
  } catch (thrown) {
    const err = toAnvilError(thrown)
    if (json) {
      emitJson(command.name, {
        schemaVersion: 1,
        ok: false,
        command: command.name,
        error: err.toJSON(),
      } satisfies Envelope)
    } else {
      const errStyle = makeStyle(shouldUseColor({ noColor, stream: process.stderr, env: process.env }))
      process.stderr.write(renderFailureText(err, errStyle))
    }
    return err.exitCode
  }
}

function renderFailureText(err: AnvilError, style: ReturnType<typeof makeStyle>): string {
  const lines: string[] = []
  lines.push(`${style.red('error')} ${err.message}`)
  if (err.hint !== undefined) lines.push(`${style.dim('hint ')} ${err.hint}`)
  lines.push(style.dim(`code  ${err.code}`))
  return lines.join('\n') + '\n'
}

/** Remove the command token (and its first occurrence) from argv. */
function stripCommand(argv: string[], command: string): string[] {
  const index = argv.indexOf(command)
  if (index === -1) return argv.filter((a) => !GLOBAL_FLAGS.has(a))
  return [...argv.slice(0, index), ...argv.slice(index + 1)]
}

/**
 * True when this module is the process entrypoint.
 *
 * Compared as resolved filesystem paths rather than by rebuilding a `file://` URL:
 * on Windows `new URL('file://' + 'C:/x')` parses `C:` as a host, which never matches.
 */
function isEntrypoint(): boolean {
  const invoked = process.argv[1]
  if (invoked === undefined) return false
  try {
    return realpathSync(invoked) === realpathSync(fileURLToPath(import.meta.url))
  } catch {
    return false
  }
}

if (isEntrypoint()) {
  process.exitCode = await run(process.argv.slice(2))
}
