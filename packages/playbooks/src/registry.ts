/**
 * Playbook registry loading.
 *
 * Playbooks ship *with* the bundle, so they are compiled into a TypeScript module rather
 * than read from disk at runtime: a single-file CLI cannot depend on a `registry/`
 * directory existing next to it, and a missing playbook directory should be a build
 * failure rather than a runtime surprise.
 *
 * `registry/playbooks/*.yaml` stays the authoring format. `scripts/gen-playbooks.ts`
 * compiles it into `src/generated.ts`, and a test asserts the generated file still matches
 * the YAML sources, so a playbook added without regenerating fails CI instead of silently
 * not existing.
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { AnvilError, CONFIG_DIR_NAME, ErrorCode } from '@anvil/core'
import { BUILTIN_PLAYBOOK_SOURCE, generatedPlaybookFiles } from './generated.ts'
import { type Playbook, parsePlaybook } from './schema.ts'

export { BUILTIN_PLAYBOOK_SOURCE }

export interface LoadResult {
  playbooks: Playbook[]
  /** Non-fatal problems: a user playbook that failed to load. */
  warnings: string[]
}

const playbookId = (file: string): string => file.replace(/\.ya?ml$/, '')

/** Parse a map of `filename -> contents` into playbooks, collecting failures as warnings. */
export function parsePlaybookFiles(files: ReadonlyMap<string, string>): LoadResult {
  const playbooks: Playbook[] = []
  const warnings: string[] = []

  for (const [file, text] of [...files.entries()].sort(([a], [b]) => (a < b ? -1 : 1))) {
    try {
      playbooks.push(parsePlaybook(text, file))
    } catch (err) {
      // A broken user playbook must not take down the built-in ones: the tool still works,
      // it just cannot offer that technology's guidance. The warning says which file.
      warnings.push(err instanceof AnvilError ? err.message : `${file}: ${String(err)}`)
    }
  }

  return { playbooks, warnings }
}

/** Load the playbooks compiled into the bundle. */
export function loadBuiltins(): LoadResult {
  return parsePlaybookFiles(generatedPlaybookFiles)
}

/**
 * Built-ins, then each directory in order, later winning by id.
 *
 * `warnAbout` names the directories whose absence or emptiness is worth reporting, which
 * is every explicitly configured one and not the default home directory.
 */
export function userPlaybookDir(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.ANVIL_CONFIG_HOME
  const home = override !== undefined && override !== '' ? resolve(override) : homedir()
  return join(home, CONFIG_DIR_NAME, 'playbooks')
}

/**
 * Load the effective registry: built-ins, then the user's default directory, then
 * `$ANVIL_PLAYBOOKS` (a user or company directory) merged over them.
 *
 * Three layers rather than one, because "where do my playbooks live" has two reasonable
 * answers and a user should not have to pick: the home directory is the default, and the
 * environment variable is for a company checkout several people share. Later layers win by
 * id, so a company playbook can correct a built-in without forking the registry.
 *
 * The built-ins are always the base. A user directory replaces nothing -- it adds to, and
 * overrides by id. Dropping the built-ins when a user has one playbook would be a silent,
 * catastrophic narrowing of what the tool knows, discovered only by a user wondering why
 * their Terraform guidance vanished.
 */
export function loadPlaybooks(env: NodeJS.ProcessEnv = process.env): LoadResult {
  const override = env.ANVIL_PLAYBOOKS
  const userDir = userPlaybookDir(env)
  const hasOverride = override !== undefined && override !== ''

  // The default directory not existing is the normal case, not a problem: nobody has added
  // a playbook yet. Only an explicitly configured directory that is missing is worth saying.
  if (!hasOverride && !existsSync(userDir)) return loadBuiltins()

  const dirs = hasOverride ? [userDir, override as string] : [userDir]
  return mergeWithBuiltins(dirs, new Set(dirs.filter((d) => d !== userDir)))
}

/** Load playbooks from a directory of YAML files, merged over the built-ins. */
export function loadPlaybooksFromDirectory(dir: string): LoadResult {
  return mergeWithBuiltins([dir], new Set([dir]))
}

/**
 * Built-ins, then each directory in order, later winning by id.
 *
 * `warnAbout` names the directories whose absence or emptiness is worth reporting, which
 * is every explicitly configured one and not the default home directory.
 */
function mergeWithBuiltins(dirs: readonly string[], warnAbout: ReadonlySet<string>): LoadResult {
  const builtins = loadBuiltins()
  const byId = new Map<string, Playbook>(builtins.playbooks.map((p) => [p.id, p]))
  const warnings = [...builtins.warnings]

  for (const dir of dirs) {
    if (!existsSync(dir)) {
      if (warnAbout.has(dir)) warnings.push(`playbook directory not found: ${dir}`)
      continue
    }
    const files = new Map<string, string>()
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isFile() || !/\.ya?ml$/.test(entry.name)) continue
      const path = join(dir, entry.name)
      files.set(path, readFileSync(path, 'utf8'))
    }
    if (files.size === 0) {
      if (warnAbout.has(dir)) warnings.push(`no .yaml playbooks in ${dir}`)
      continue
    }
    const loaded = parsePlaybookFiles(files)
    // A duplicate id *inside one directory* is silent data loss, and it is invisible from
    // here on: the merge below is keyed by id, so of two files claiming `node`, one is never
    // used and the registry is narrower than the directory looks. Reported, because a
    // consumer cannot see it any other way -- the surviving playbook looks perfectly fine.
    //
    // A later layer replacing an *earlier* one is the documented override behaviour, so that
    // case is not a warning. Only two files in the same directory are.
    const seenHere = new Set<string>()
    for (const playbook of loaded.playbooks) {
      if (seenHere.has(playbook.id)) {
        warnings.push(
          `duplicate playbook id "${playbook.id}" in ${dir}: more than one file claims it, and the merge is keyed by id, so one of them is never used`,
        )
      }
      seenHere.add(playbook.id)
    }
    for (const playbook of loaded.playbooks) byId.set(playbook.id, playbook)
    warnings.push(...loaded.warnings)
  }

  return { playbooks: [...byId.values()], warnings }
}

export { playbookId }

/** Guard used by the CLI when a user points at a directory that does not exist. */
export function requireDirectory(dir: string): void {
  if (!existsSync(dir)) {
    throw new AnvilError(ErrorCode.NotAGitRepo, `Playbook directory not found: ${dir}`, {
      hint: 'Point ANVIL_PLAYBOOKS at a directory containing .yaml playbook files.',
    })
  }
}
