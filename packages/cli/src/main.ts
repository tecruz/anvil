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

import { realpathSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import {
  AnvilError,
  type Envelope,
  ErrorCode,
  ExitCode,
  emitJson,
  failure,
  makeStyle,
  shouldUseColor,
  success,
  toAnvilError,
  VERSION,
} from '@anvil/core'
import { discoverRepo, type GitRepoInfo } from '@anvil/git'
import { configCommand } from './commands/config.ts'
import { crewCommand } from './commands/crew.ts'
import { doctorCommand, profileCommand } from './commands/doctor.ts'
import { briefCommand, initCommand } from './commands/init.ts'
import { planCommand } from './commands/plan.ts'
import { playbookCommand } from './commands/playbook.ts'
import { shipCommand } from './commands/ship.ts'
import type { Command, CommandContext } from './commands/types.ts'
import { versionCommand } from './commands/version.ts'
import { authCommand, claimCommand, issueCommand, releaseCommand, statusCommand } from './commands/work.ts'
import { renderCommandHelp, renderRootHelp } from './help.ts'

const COMMANDS: Command[] = [
  authCommand,
  briefCommand,
  claimCommand,
  configCommand,
  crewCommand,
  doctorCommand,
  initCommand,
  issueCommand,
  planCommand,
  playbookCommand,
  profileCommand,
  releaseCommand,
  shipCommand,
  statusCommand,
  versionCommand,
]

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
      emitJson(
        'anvil',
        success('anvil', {
          version: VERSION,
          help: renderRootHelp(COMMANDS, style),
          commands: COMMANDS.map((c) => ({
            name: c.name,
            summary: c.summary,
            usage: c.usage,
          })),
        }),
      )
      return ExitCode.Ok
    }
    const style = makeStyle(shouldUseColor({ noColor, stream: process.stdout, env: process.env }))
    process.stdout.write(renderRootHelp(COMMANDS, style))
    return ExitCode.Ok
  }

  const command = findCommand(firstPositional)
  if (command === undefined) {
    const err = new AnvilError(ErrorCode.UnknownCommand, `Unknown command: ${firstPositional}`, {
      hint: 'Run `anvil --help` to see available commands.',
    })
    if (json) {
      emitJson('anvil', {
        schemaVersion: 1,
        ok: false,
        command: 'anvil',
        error: err.toJSON(),
      })
      return err.exitCode
    }
    process.stderr.write(
      renderFailureText(err, makeStyle(shouldUseColor({ noColor, stream: process.stderr, env: process.env }))),
    )
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

  // Best-effort repo discovery. A missing repo is not an error until a command needs it,
  // and neither is git itself being absent: `anvil version --json` must not require a git
  // install. Commands that do need a repository discover it again inside their own `run`,
  // where the failure is funnelled into an envelope with the real exit code.
  const repo = await discoverRepoBestEffort()

  const colorEnabled = shouldUseColor({
    noColor,
    stream: process.stdout,
    env: process.env,
  })
  const style = makeStyle(colorEnabled)

  const ctx: CommandContext = {
    cwd: process.cwd(),
    repoRoot: repo === null ? null : repo.root,
    repo,
    style,
    json,
    say(message) {
      if (!json) process.stdout.write(`${message}\n`)
    },
    out(data, render) {
      if (json) {
        emitJson(command.name, success(command.name, data))
      } else {
        process.stdout.write(`${render()}\n`)
      }
    },
    outFailure(data, error, renderError) {
      // A failure that still produced a payload. In JSON mode that payload rides on an
      // `ok:false` envelope, because a success envelope with an error nested in `data`
      // tells any consumer that branches on `ok` that the command worked.
      if (json) {
        emitJson(command.name, failure(command.name, error, data))
      } else {
        process.stderr.write(renderError())
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
  return `${lines.join('\n')}\n`
}

/**
 * Repo discovery that cannot take the process down.
 *
 * Best-effort, literally: any failure returns `null`, because every command that genuinely
 * needs a repository either checks `ctx.repoRoot === null` or calls `discoverRepo` again
 * inside its own `run`, where the failure is funnelled with the real exit code. Surfacing
 * anything here is a duplicate of that error -- and for commands that need no repo
 * (`version`, `playbook list`, `config path`), it is a crash where the tool could have
 * answered. The original bug was letting this rejection escape `run` as an unhandled
 * rejection: a raw stack trace and exit 1 on every command, contradicting this file's own
 * claim that `--json` is the only mode that writes on failure.
 */
async function discoverRepoBestEffort(): Promise<GitRepoInfo | null> {
  try {
    return await discoverRepo(process.cwd())
  } catch {
    return null
  }
}

/** Remove the command token (and its first occurrence) from argv. */
function stripCommand(argv: string[], command: string): string[] {
  const index = argv.indexOf(command)
  const rest = index === -1 ? argv : [...argv.slice(0, index), ...argv.slice(index + 1)]
  // `--no-color` is consumed here, by `run`, to style every stream anvil writes to. It must
  // therefore never reach a command's parser: each command used to declare a `noColor` flag,
  // which parseArgs exposes as `--noColor`, so the documented `--no-color` was rejected as an
  // unknown option on every command. The flag is global, and it is handled globally.
  //
  // `--json`, `-j`, `--help` and `-h` stay: commands declare those themselves, and `init`
  // reads its own parsed `json` value.
  return rest.filter((a) => a !== '--no-color')
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
