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
import { isValidVersionRange } from './version-range.ts'

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

/** The command kinds a project owner can declare, matching the profile's own set. */
export type DeclaredCommandKind = 'install' | 'build' | 'test' | 'testFast' | 'lint' | 'format' | 'typecheck' | 'run'

/**
 * A command the project owner declares, for a repository anvil does not detect on its own.
 *
 * Declaring a command records an expectation, not evidence that it works and not
 * authorization to run it. `dir` is repo-relative; the command runs there, which is the one
 * thing a declaration cannot leave to convention when the project lives in a subdirectory.
 */
export interface DeclaredCommand {
  kind: DeclaredCommandKind
  cmd: string
  dir?: string
}

/** A tool the project needs in the environment. Checked by `anvil ready --check`. */
export interface DeclaredTool {
  /** Tool name, and the binary probed unless `bin` says otherwise. */
  id: string
  /** The binary to look for on PATH. Defaults to `id`. */
  bin?: string
  /** Why the project needs it. */
  reason?: string
  /**
   * The version range the project supports, as a small documented subset of semver
   * (`>=20 <21`, `^20.11`, `~1.2.3`, `20.x`). Checked against the reported version by
   * `anvil ready --check`; an unparseable range is a config error.
   */
  version?: string
  /** True when the project cannot be verified without it. Defaults to true. */
  required?: boolean
  /**
   * The command that installs it, when the owner knows one. `anvil ready` proposes this as
   * an action to approve; anvil never runs it.
   */
  install?: string
}

/**
 * An environment variable the project needs. Checked by `anvil ready --check`, by name only.
 *
 * A declaration is the variable's *name*. Anvil never reads the declaration for a value and
 * never writes a value into its report; presence is the only thing it can honestly check, and
 * a present variable is not proof that the credential behind it is valid or authorized.
 */
export interface DeclaredEnvVar {
  /** The variable name, as the shell and the process environment spell it. */
  name: string
  /** Why the project needs it. */
  reason?: string
  /** True when the project cannot be verified without it. Defaults to true. */
  required?: boolean
}

/**
 * A local service the project needs, checked by `anvil ready --check` with a TCP connect.
 *
 * Deliberately loopback-only: a committed `anvil.config.json` must not be able to make a
 * read-only readiness report reach an arbitrary host. Only whether something accepts a
 * connection is observed, which is not proof the service is healthy or authorized for use.
 */
export interface DeclaredService {
  /** Stable name, used in the report and proposed actions. */
  id: string
  /** Loopback host to connect to. Defaults to `127.0.0.1`. */
  host?: string
  /** TCP port the service listens on. */
  port: number
  /** Why the project needs it. */
  reason?: string
  /** True when the project cannot be verified without it. Defaults to true. */
  required?: boolean
}

/**
 * What the project owner says the project needs, for the parts anvil cannot detect.
 *
 * The detected profile stays the only source of *detected* facts. This section is the
 * explicit escape hatch: a technology anvil has no detector for, a tool it cannot infer,
 * a working directory it could only guess at, a credential only the environment holds, and
 * a service this machine has to be running.
 */
export interface ProjectConfig {
  /** Owner-declared commands, keyed by kind, for a project anvil cannot detect on its own. */
  commands: DeclaredCommand[]
  /** Owner-declared required tools. */
  tools: DeclaredTool[]
  /** Owner-declared environment variables, checked for presence by name. */
  env: DeclaredEnvVar[]
  /** Owner-declared local services, checked with a bounded loopback TCP connect. */
  services: DeclaredService[]
}

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
  /** Owner-declared project capabilities, for what detection cannot see. */
  project: ProjectConfig
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
    project: { commands: [], tools: [], env: [], services: [] },
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

/** Report a key that the section does not accept. Unknown keys are errors, never ignored. */
function checkUnknownKeys(
  obj: Record<string, unknown>,
  allowed: readonly string[],
  prefix: string,
  issues: ValidationIssue[],
): void {
  for (const key of Object.keys(obj)) {
    if (!allowed.includes(key)) issues.push({ path: `${prefix}.${key}`, message: 'unknown configuration key' })
  }
}

const DECLARED_COMMAND_KINDS: readonly DeclaredCommandKind[] = [
  'install',
  'build',
  'test',
  'testFast',
  'lint',
  'format',
  'typecheck',
  'run',
]

/**
 * Validate `project.commands`.
 *
 * Returns `undefined` only when the whole value is the wrong shape; individual bad entries
 * are dropped after being reported, so one typo does not hide the rest.
 */
function parseDeclaredCommands(value: unknown, path: string, issues: ValidationIssue[]): DeclaredCommand[] | undefined {
  if (!Array.isArray(value)) {
    issues.push({ path, message: 'expected an array' })
    return undefined
  }
  const out: DeclaredCommand[] = []
  value.forEach((entry, index) => {
    const at = `${path}[${index}]`
    if (!isPlainObject(entry)) {
      issues.push({ path: at, message: 'expected an object' })
      return
    }
    checkUnknownKeys(entry, ['kind', 'cmd', 'dir'], at, issues)
    const kind = expectEnum(entry.kind, `${at}.kind`, DECLARED_COMMAND_KINDS, issues)
    if (typeof entry.cmd !== 'string' || entry.cmd.trim() === '') {
      issues.push({ path: `${at}.cmd`, message: 'expected a non-empty string' })
      return
    }
    if (entry.dir !== undefined && typeof entry.dir !== 'string') {
      issues.push({ path: `${at}.dir`, message: 'expected a string' })
      return
    }
    if (kind === undefined) return
    out.push(entry.dir === undefined ? { kind, cmd: entry.cmd } : { kind, cmd: entry.cmd, dir: entry.dir })
  })
  return out
}

/** Validate `project.tools`. Same per-entry reporting as {@link parseDeclaredCommands}. */
function parseDeclaredTools(value: unknown, path: string, issues: ValidationIssue[]): DeclaredTool[] | undefined {
  if (!Array.isArray(value)) {
    issues.push({ path, message: 'expected an array' })
    return undefined
  }
  const out: DeclaredTool[] = []
  value.forEach((entry, index) => {
    const at = `${path}[${index}]`
    if (!isPlainObject(entry)) {
      issues.push({ path: at, message: 'expected an object' })
      return
    }
    checkUnknownKeys(entry, ['id', 'bin', 'reason', 'version', 'required', 'install'], at, issues)
    if (typeof entry.id !== 'string' || entry.id.trim() === '') {
      issues.push({ path: `${at}.id`, message: 'expected a non-empty string' })
      return
    }
    const tool: DeclaredTool = { id: entry.id }
    for (const key of ['bin', 'reason', 'install'] as const) {
      if (entry[key] === undefined) continue
      if (typeof entry[key] !== 'string') {
        issues.push({ path: `${at}.${key}`, message: 'expected a string' })
        return
      }
      tool[key] = entry[key]
    }
    if (entry.version !== undefined) {
      if (typeof entry.version !== 'string' || entry.version.trim() === '') {
        issues.push({ path: `${at}.version`, message: 'expected a non-empty version range' })
        return
      }
      if (!isValidVersionRange(entry.version)) {
        issues.push({
          path: `${at}.version`,
          message: 'expected a version range like ">=20 <21", "^20.11", "~1.2.3" or "20.x"',
        })
        return
      }
      tool.version = entry.version.trim()
    }
    if (entry.required !== undefined) {
      if (typeof entry.required !== 'boolean') {
        issues.push({ path: `${at}.required`, message: 'expected a boolean' })
        return
      }
      tool.required = entry.required
    }
    out.push(tool)
  })
  return out
}

/**
 * The shape of an environment variable name.
 *
 * Deliberately conservative: a name that a shell could not export is a typo, and accepting it
 * would make `anvil ready` report on a variable that can never be set.
 */
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/

/** Validate `project.env`. Names only; a value never appears in the configuration. */
function parseDeclaredEnv(value: unknown, path: string, issues: ValidationIssue[]): DeclaredEnvVar[] | undefined {
  if (!Array.isArray(value)) {
    issues.push({ path, message: 'expected an array' })
    return undefined
  }
  const out: DeclaredEnvVar[] = []
  value.forEach((entry, index) => {
    const at = `${path}[${index}]`
    if (!isPlainObject(entry)) {
      issues.push({ path: at, message: 'expected an object' })
      return
    }
    checkUnknownKeys(entry, ['name', 'reason', 'required'], at, issues)
    if (typeof entry.name !== 'string' || !ENV_NAME.test(entry.name)) {
      issues.push({ path: `${at}.name`, message: 'expected an environment variable name like "DATABASE_URL"' })
      return
    }
    const declared: DeclaredEnvVar = { name: entry.name }
    if (entry.reason !== undefined) {
      if (typeof entry.reason !== 'string') {
        issues.push({ path: `${at}.reason`, message: 'expected a string' })
        return
      }
      declared.reason = entry.reason
    }
    if (entry.required !== undefined) {
      if (typeof entry.required !== 'boolean') {
        issues.push({ path: `${at}.required`, message: 'expected a boolean' })
        return
      }
      declared.required = entry.required
    }
    out.push(declared)
  })
  return out
}

/** The hosts anvil will connect to for a declared service. Loopback only, by design. */
const LOOPBACK_HOSTS: readonly string[] = ['localhost', '127.0.0.1', '::1', '[::1]']

/** Validate `project.services`. Loopback hosts only; a port is mandatory. */
function parseDeclaredServices(value: unknown, path: string, issues: ValidationIssue[]): DeclaredService[] | undefined {
  if (!Array.isArray(value)) {
    issues.push({ path, message: 'expected an array' })
    return undefined
  }
  const out: DeclaredService[] = []
  value.forEach((entry, index) => {
    const at = `${path}[${index}]`
    if (!isPlainObject(entry)) {
      issues.push({ path: at, message: 'expected an object' })
      return
    }
    checkUnknownKeys(entry, ['id', 'host', 'port', 'reason', 'required'], at, issues)
    if (typeof entry.id !== 'string' || entry.id.trim() === '') {
      issues.push({ path: `${at}.id`, message: 'expected a non-empty string' })
      return
    }
    if (typeof entry.port !== 'number' || !Number.isInteger(entry.port) || entry.port < 1 || entry.port > 65535) {
      issues.push({ path: `${at}.port`, message: 'expected an integer port between 1 and 65535' })
      return
    }
    const service: DeclaredService = { id: entry.id, port: entry.port }
    if (entry.host !== undefined) {
      if (typeof entry.host !== 'string' || !LOOPBACK_HOSTS.includes(entry.host)) {
        // A readiness report must not be usable as a request to probe an arbitrary host.
        issues.push({
          path: `${at}.host`,
          message: `expected a loopback host (${LOOPBACK_HOSTS.join(', ')})`,
        })
        return
      }
      service.host = entry.host
    }
    if (entry.reason !== undefined) {
      if (typeof entry.reason !== 'string') {
        issues.push({ path: `${at}.reason`, message: 'expected a string' })
        return
      }
      service.reason = entry.reason
    }
    if (entry.required !== undefined) {
      if (typeof entry.required !== 'boolean') {
        issues.push({ path: `${at}.required`, message: 'expected a boolean' })
        return
      }
      service.required = entry.required
    }
    out.push(service)
  })
  return out
}

/**
 * Validate and merge a config layer onto `base`. Returns a new config; `base` is not
 * mutated. Unknown top-level keys are rejected.
 */
export function mergeConfig(base: AnvilConfig, layer: Record<string, unknown>, sourcePath: string): AnvilConfig {
  const issues: ValidationIssue[] = []

  // `$schema` is a standard JSON key that an editor adds by hand; accept and ignore it
  // rather than failing a config that is otherwise valid.
  const known = new Set(['$schema', 'schemaVersion', 'git', 'provider', 'output', 'features', 'project'])
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

  if (layer.project !== undefined) {
    const project = expectObject(layer.project, 'project', issues)
    checkUnknownKeys(project, ['commands', 'tools', 'env', 'services'], 'project', issues)
    // Each key replaces its array rather than concatenating: a repo layer that declares its
    // own commands is answering the question, not adding to the global answer. Keys the
    // layer is silent about keep the merged value from the layers below.
    if (project.commands !== undefined) {
      const commands = parseDeclaredCommands(project.commands, 'project.commands', issues)
      if (commands !== undefined) next.project.commands = commands
    }
    if (project.tools !== undefined) {
      const tools = parseDeclaredTools(project.tools, 'project.tools', issues)
      if (tools !== undefined) next.project.tools = tools
    }
    if (project.env !== undefined) {
      const env = parseDeclaredEnv(project.env, 'project.env', issues)
      if (env !== undefined) next.project.env = env
    }
    if (project.services !== undefined) {
      const services = parseDeclaredServices(project.services, 'project.services', issues)
      if (services !== undefined) next.project.services = services
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
    // The escape hatch for a project anvil cannot detect on its own. Left empty here and
    // documented in docs/USAGE.md rather than guessed at: a declaration the owner did not
    // write is a claim anvil would be inventing.
    project: { commands: [], tools: [], env: [], services: [] },
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
