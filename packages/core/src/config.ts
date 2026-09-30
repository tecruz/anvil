/**
 * Configuration resolution.
 *
 * Two layers, repo-local wins:
 *
 *   global: ~/.anvil/config.json      (portable across companies)
 *   repo:   <repoRoot>/anvil.config.json  (optional; commit it or gitignore it)
 *
 * Only a fixed, validated set of keys is accepted. Unknown keys are an error, not a
 * warning: a typo in `provider.default` should fail loudly on day one rather than
 * silently do nothing for a year.
 *
 * The repo-local file is optional by design. `anvil` must work in a repo you have
 * never seen and are not allowed to modify.
 */

import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { AnvilError, ErrorCode } from './errors.ts'

export const CONFIG_FILE_NAME = 'anvil.config.json'
export const CONFIG_DIR_NAME = '.anvil'

/**
 * The JSON-schema URL written as `$schema` in a starter config.
 *
 * Deliberately absent: anvil does not publish a JSON schema, and pointing editors at
 * another tool's schema (as this used to, with `https://opencode.ai/config.json`) makes
 * a valid file look invalid and an invalid one look valid. An honest, absent `$schema` is
 * better than a wrong one. If a schema is published later, this is where it goes.
 */
export const SCHEMA_URL: string | undefined = undefined

export interface AnvilConfig {
  schemaVersion: 1
  git: {
    /** Branch claims fork from when a ticket does not name one. `null` = repo default. */
    defaultBaseBranch: string | null
    /** Where worktrees are created. `null` = `<repoParent>/<repoName>-worktrees`. */
    worktreeRoot: string | null
  }
  provider: {
    /** Provider used when a ticket ref carries no explicit provider. */
    default: string
  }
  output: {
    color: 'auto' | 'always' | 'never'
  }
  /** Feature toggles. Kept explicit so behavior changes are visible in the config. */
  features: {
    /** Run external verify commands during `ship`. */
    probeCommands: boolean
  }
}

export type ConfigSourceKind = 'global' | 'repo' | 'default'

export interface ConfigSource {
  kind: ConfigSourceKind
  path: string
  /** True when the file was read and contributed. */
  present: boolean
}

export interface ResolvedConfig {
  config: AnvilConfig
  sources: ConfigSource[]
}

export function defaultConfig(): AnvilConfig {
  return {
    schemaVersion: 1,
    git: { defaultBaseBranch: null, worktreeRoot: null },
    provider: { default: 'local' },
    output: { color: 'auto' },
    features: { probeCommands: false },
  }
}

export function globalConfigPath(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.ANVIL_CONFIG_HOME
  if (override !== undefined && override !== '') return resolve(override, CONFIG_FILE_NAME)
  return join(homedir(), CONFIG_DIR_NAME, CONFIG_FILE_NAME)
}

export function repoConfigPath(repoRoot: string): string {
  return join(repoRoot, CONFIG_FILE_NAME)
}

interface ValidationIssue {
  path: string
  message: string
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function expectObject(value: unknown, path: string, issues: ValidationIssue[]): Record<string, unknown> {
  if (isPlainObject(value)) return value
  issues.push({ path, message: 'expected an object' })
  return {}
}

function expectStringOrNull(value: unknown, path: string, issues: ValidationIssue[]): string | null | undefined {
  if (value === null) return null
  if (typeof value === 'string') return value
  issues.push({ path, message: 'expected a string or null' })
  return undefined
}

function expectBoolean(value: unknown, path: string, issues: ValidationIssue[]): boolean | undefined {
  if (typeof value === 'boolean') return value
  issues.push({ path, message: 'expected a boolean' })
  return undefined
}

function expectEnum<T extends string>(
  value: unknown,
  path: string,
  allowed: readonly T[],
  issues: ValidationIssue[],
): T | undefined {
  if (typeof value === 'string' && (allowed as readonly string[]).includes(value)) return value as T
  issues.push({ path, message: `expected one of: ${allowed.join(', ')}` })
  return undefined
}

/**
 * Validate and merge a config layer onto `base`. Returns a new config; `base` is not
 * mutated. Unknown top-level keys are rejected.
 */
export function mergeConfig(base: AnvilConfig, layer: Record<string, unknown>, sourcePath: string): AnvilConfig {
  const issues: ValidationIssue[] = []

  // `$schema` is a standard JSON key that an editor adds by hand; accept and ignore it
  // rather than failing a config that is otherwise valid.
  const known = new Set(['$schema', 'schemaVersion', 'git', 'provider', 'output', 'features'])
  for (const key of Object.keys(layer)) {
    if (!known.has(key)) issues.push({ path: key, message: 'unknown configuration key' })
  }
  if (layer.$schema !== undefined && typeof layer.$schema !== 'string') {
    issues.push({ path: '$schema', message: 'expected a string URL' })
  }

  if (layer.schemaVersion !== undefined && layer.schemaVersion !== 1) {
    issues.push({
      path: 'schemaVersion',
      message: 'unsupported schemaVersion (expected 1)',
    })
  }

  const next: AnvilConfig = structuredClone(base)

  if (layer.git !== undefined) {
    const git = expectObject(layer.git, 'git', issues)
    const knownGit = new Set(['defaultBaseBranch', 'worktreeRoot'])
    for (const key of Object.keys(git)) {
      if (!knownGit.has(key))
        issues.push({
          path: `git.${key}`,
          message: 'unknown configuration key',
        })
    }
    // Only validate keys the layer actually sets. A layer that sets one key must not be
    // required to set its siblings.
    if (git.defaultBaseBranch !== undefined) {
      const value = expectStringOrNull(git.defaultBaseBranch, 'git.defaultBaseBranch', issues)
      if (value !== undefined) next.git.defaultBaseBranch = value
    }
    if (git.worktreeRoot !== undefined) {
      const value = expectStringOrNull(git.worktreeRoot, 'git.worktreeRoot', issues)
      if (value !== undefined) next.git.worktreeRoot = value
    }
  }

  if (layer.provider !== undefined) {
    const provider = expectObject(layer.provider, 'provider', issues)
    for (const key of Object.keys(provider)) {
      if (key !== 'default')
        issues.push({
          path: `provider.${key}`,
          message: 'unknown configuration key',
        })
    }
    if (provider.default !== undefined) {
      if (typeof provider.default === 'string') next.provider.default = provider.default
      else issues.push({ path: 'provider.default', message: 'expected a string' })
    }
  }

  if (layer.output !== undefined) {
    const output = expectObject(layer.output, 'output', issues)
    for (const key of Object.keys(output)) {
      if (key !== 'color')
        issues.push({
          path: `output.${key}`,
          message: 'unknown configuration key',
        })
    }
    if (output.color !== undefined) {
      const color = expectEnum(output.color, 'output.color', ['auto', 'always', 'never'] as const, issues)
      if (color !== undefined) next.output.color = color
    }
  }

  if (layer.features !== undefined) {
    const features = expectObject(layer.features, 'features', issues)
    for (const key of Object.keys(features)) {
      if (key !== 'probeCommands')
        issues.push({
          path: `features.${key}`,
          message: 'unknown configuration key',
        })
    }
    if (features.probeCommands !== undefined) {
      const probe = expectBoolean(features.probeCommands, 'features.probeCommands', issues)
      if (probe !== undefined) next.features.probeCommands = probe
    }
  }

  if (issues.length > 0) {
    const detail = issues.map((i) => `  ${i.path}: ${i.message}`).join('\n')
    throw new AnvilError(ErrorCode.ConfigInvalid, `Invalid configuration in ${sourcePath}:\n${detail}`, {
      hint: 'Run `anvil config show` to see the resolved config, or delete the file to fall back to defaults.',
    })
  }

  return next
}

function readLayer(path: string): Record<string, unknown> | null {
  if (!existsSync(path)) return null
  let text: string
  try {
    text = readFileSync(path, 'utf8')
  } catch (cause) {
    throw new AnvilError(ErrorCode.ConfigUnreadable, `Cannot read config at ${path}`, {
      hint: 'Check file permissions, or delete the file to fall back to defaults.',
      cause,
    })
  }
  try {
    const parsed: unknown = JSON.parse(text)
    if (!isPlainObject(parsed)) {
      throw new AnvilError(ErrorCode.ConfigInvalid, `Config at ${path} must contain a JSON object`, {
        hint: 'Delete the file to fall back to defaults.',
      })
    }
    return parsed
  } catch (cause) {
    if (cause instanceof AnvilError) throw cause
    throw new AnvilError(ErrorCode.ConfigInvalid, `Config at ${path} is not valid JSON`, {
      hint: 'Delete the file to fall back to defaults.',
      cause,
    })
  }
}

export interface LoadConfigOptions {
  /** Repo root, if known. Omit to resolve config without a repo-local layer. */
  repoRoot?: string | undefined
  env?: NodeJS.ProcessEnv
}

/** Resolve the effective config, merging global then repo-local layers. */
export function loadConfig(options: LoadConfigOptions = {}): ResolvedConfig {
  const env = options.env ?? process.env
  const globalPath = globalConfigPath(env)
  const sources: ConfigSource[] = [{ kind: 'global', path: globalPath, present: false }]

  let config = defaultConfig()

  const globalLayer = readLayer(globalPath)
  if (globalLayer !== null) {
    config = mergeConfig(config, globalLayer, globalPath)
    sources[0] = { kind: 'global', path: globalPath, present: true }
  }

  if (options.repoRoot !== undefined) {
    const repoPath = repoConfigPath(options.repoRoot)
    const repoLayer = readLayer(repoPath)
    sources.push({ kind: 'repo', path: repoPath, present: repoLayer !== null })
    if (repoLayer !== null) config = mergeConfig(config, repoLayer, repoPath)
  }

  sources.push({ kind: 'default', path: '(built-in defaults)', present: true })
  return { config, sources }
}

/** Write a starter repo-local config. Used by `anvil config init`. */
export function starterConfigJson(): string {
  // `$schema` is included only when a real schema URL exists. The starter file must pass
  // `mergeConfig` unchanged -- a scaffold that its own validator rejects is a trap, and it
  // is what `config init` used to write.
  const body: Record<string, unknown> = {
    schemaVersion: 1,
    git: {
      defaultBaseBranch: null,
      worktreeRoot: null,
    },
    provider: { default: 'local' },
    output: { color: 'auto' },
    features: { probeCommands: false },
  }
  if (SCHEMA_URL !== undefined) body.$schema = SCHEMA_URL
  return `${JSON.stringify(body, null, 2)}\n`
}

/** Directory used for anvil's own per-repo state (staging, tickets). */
export function stateDir(repoRoot: string): string {
  return join(repoRoot, CONFIG_DIR_NAME)
}

export function ensureParentDir(filePath: string): void {
  const dir = dirname(filePath)
  if (!existsSync(dir)) {
    throw new AnvilError(ErrorCode.Internal, `Expected parent directory to exist: ${dir}`)
  }
}
