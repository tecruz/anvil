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

import { readdirSync, readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { AnvilError, ErrorCode } from '@anvil/core'
import { parsePlaybook, type Playbook } from './schema.ts'
import { BUILTIN_PLAYBOOK_SOURCE, generatedPlaybookFiles } from './generated.ts'

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

/** Load playbooks from a directory of YAML files, merged over the built-ins. */
export function loadPlaybooksFromDirectory(dir: string): LoadResult {
  const builtins = loadBuiltins()
  if (!existsSync(dir)) {
    return {
      playbooks: builtins.playbooks,
      warnings: [...builtins.warnings, `playbook directory not found: ${dir}`],
    }
  }

  const files = new Map<string, string>()
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isFile() || !/\.ya?ml$/.test(entry.name)) continue
    files.set(join(dir, entry.name), readFileSync(join(dir, entry.name), 'utf8'))
  }
  if (files.size === 0) {
    return {
      playbooks: builtins.playbooks,
      warnings: [...builtins.warnings, `no .yaml playbooks in ${dir}`],
    }
  }

  const loaded = parsePlaybookFiles(files)
  const byId = new Map(builtins.playbooks.map((p) => [p.id, p]))
  for (const playbook of loaded.playbooks) byId.set(playbook.id, playbook)

  return { playbooks: [...byId.values()], warnings: [...builtins.warnings, ...loaded.warnings] }
}

/**
 * Load the effective registry: built-ins, overridden or extended by
 * `$ANVIL_PLAYBOOKS` (a user or company directory).
 */
export function loadPlaybooks(env: NodeJS.ProcessEnv = process.env): LoadResult {
  const dir = env.ANVIL_PLAYBOOKS
  if (dir === undefined || dir === '') return loadBuiltins()
  return loadPlaybooksFromDirectory(dir)
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
