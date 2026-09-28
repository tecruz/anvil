/**
 * `anvil config` -- show resolved config, list config paths, scaffold a repo-local file.
 *
 * This is the first command that exercises the whole M0 stack: repo discovery, config
 * resolution across global + repo layers, and both output modes.
 */

import { writeFileSync, existsSync } from 'node:fs'
import {
  AnvilError,
  CONFIG_FILE_NAME,
  ErrorCode,
  loadConfig,
  parseCliArgs,
  renderKeyValues,
  repoConfigPath,
  starterConfigJson,
  type AnvilConfig,
} from '@anvil/core'
import {
  CONFIG_SUBCOMMANDS,
  type Command,
  type CommandContext,
} from './types.ts'

function describe(config: AnvilConfig): Array<[string, string]> {
  const opt = (v: string | null): string => (v === null ? '(auto)' : v)
  return [
    ['schemaVersion', String(config.schemaVersion)],
    ['git.defaultBaseBranch', opt(config.git.defaultBaseBranch)],
    ['git.worktreeRoot', opt(config.git.worktreeRoot)],
    ['provider.default', config.provider.default],
    ['output.color', config.output.color],
    ['features.probeCommands', String(config.features.probeCommands)],
  ]
}

export const configCommand: Command = {
  name: 'config',
  summary: 'Inspect and scaffold anvil configuration.',
  usage: 'anvil config <show|path|init> [flags]',
  details: [
    'show    Print the resolved configuration, merged from global then repo-local.',
    'path    Print each config file path and whether it exists.',
    'init    Write a starter repo-local config. Refuses to overwrite.',
  ].join('\n'),
  flags: {
    json: { type: 'boolean', short: 'j' },
    noColor: { type: 'boolean' },
    help: { type: 'boolean', short: 'h' },
  },
  async run(ctx: CommandContext, rawArgs) {
    const args = parseCliArgs(rawArgs, configCommand.flags)
    const sub = args.positionals[0] ?? 'show'

    if (!CONFIG_SUBCOMMANDS.includes(sub as (typeof CONFIG_SUBCOMMANDS)[number])) {
      throw new AnvilError(
        ErrorCode.Usage,
        `Unknown config subcommand: ${sub}`,
        { hint: `Expected one of: ${CONFIG_SUBCOMMANDS.join(', ')}` },
      )
    }

    if (sub === 'init') return runInit(ctx, args.positionals[1])
    if (sub === 'path') return runPath(ctx)
    return runShow(ctx)
  },
}

async function runShow(ctx: CommandContext): Promise<void> {
  const resolved = loadConfig(ctx.repoRoot === null ? {} : { repoRoot: ctx.repoRoot })
  const data = { config: resolved.config, sources: resolved.sources }

  ctx.out(data, () => {
    const s = ctx.style
    const lines: string[] = []
    lines.push(s.bold('Resolved configuration'))
    lines.push(renderKeyValues(describe(resolved.config), s))
    lines.push('')
    lines.push(s.bold('Sources (later layers win)'))
    for (const source of resolved.sources) {
      const mark = source.present ? s.green('present') : s.dim('absent ')
      const label = s.dim(source.kind.padEnd(7))
      lines.push(`  ${label}  ${mark}  ${source.path}`)
    }
    if (ctx.repoRoot === null) {
      // Say so, rather than silently omitting the layer -- a silent omission is
      // confusing when the user has just run `config init` in the wrong directory.
      lines.push(`  ${s.dim('repo'.padEnd(7))}  ${s.yellow('skipped')}  ${s.dim('not inside a git repository')}`)
    }
    return lines.join('\n')
  })
}

async function runPath(ctx: CommandContext): Promise<void> {
  const resolved = loadConfig(ctx.repoRoot === null ? {} : { repoRoot: ctx.repoRoot })
  // `path` answers "which files do I edit", so the synthetic built-in default layer is
  // excluded -- in text and JSON alike. The full layer list is `config show`'s job.
  const paths = resolved.sources
    .filter((s) => s.kind !== 'default')
    .map((s) => ({ kind: s.kind, path: s.path, present: s.present }))

  ctx.out({ paths }, () =>
    paths.map((p) => `${p.kind.padEnd(7)}  ${p.path}${p.present ? '' : '  (absent)'}`).join('\n'),
  )
}

async function runInit(ctx: CommandContext, targetDir: string | undefined): Promise<void> {
  // `ctx.repoRoot` is null outside a repo, and an explicit arg wins over it.
  const dir: string | null | undefined = targetDir ?? ctx.repoRoot
  if (dir === undefined || dir === null) {
    throw new AnvilError(ErrorCode.Usage, '`anvil config init` needs a repository or an explicit path', {
      hint: 'Run it from inside a git repository, or pass a directory: anvil config init ../other-repo',
    })
  }

  const path = repoConfigPath(dir)
  if (existsSync(path)) {
    throw new AnvilError(ErrorCode.ConfigInvalid, `${path} already exists`, {
      hint: 'Edit it directly, or delete it and re-run `anvil config init`.',
    })
  }

  writeFileSync(path, starterConfigJson(), 'utf8')
  const data = { created: path }
  ctx.out(data, () => `${ctx.style.green('created')} ${path}`)
}

/** Re-exported so the help renderer can show the file name. */
export const CONFIG_FILE = CONFIG_FILE_NAME
