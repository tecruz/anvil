/**
 * The readiness report: what an AI needs to work in this repository, and whether it is here.
 *
 * `anvil profile` answers "what is this repository". `anvil doctor` answers "is this
 * repository ready for an agent to change". This answers a third question, the one an
 * engineer asks on their first day: *what does this project need from this machine, and is
 * any of it missing?*
 *
 * Four rules shape it, and they are the same rules the rest of anvil runs on:
 *
 *  1. **A declaration is not a verification.** A command the owner wrote in
 *     `anvil.config.json` is recorded as `declared` and `unknown` until something observes
 *     it. Readiness never runs the project's build or tests.
 *  2. **Not checked and checked-and-missing are different answers.** Without `--check`
 *     every tool is `unknown`; with it, a tool is `available`, `missing` or `unavailable`,
 *     and nothing is guessed in between.
 *  3. **`--check` never runs repository-controlled code.** A bare tool name that resolves
 *     outside the repository is probed with a bounded, tool-specific command, run against the
 *     exact path that was checked. A path-shaped tool (`. ./gradlew`), a bare name that
 *     resolves *inside* the repository (a `node_modules/.bin` shim), or a committed symlink
 *     whose target is elsewhere, is only checked for existence and runnability; it is never
 *     executes it, so a committed config cannot turn a read-only report into code execution. A
 *     Windows shim runs through an interpreter anvil resolves to an absolute path and pins
 *     itself, and refuses one it cannot resolve or that lives inside the repository.
 *  4. **anvil proposes, it never installs.** A setup action carries `requiresApproval` and
 *     is text. The only install command that appears is one the owner wrote down.
 */

import { realpathSync, statSync } from 'node:fs'
import { delimiter, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import {
  type DeclaredCommand,
  type ProjectConfig,
  parseVersion,
  resolveCommand,
  runProcess,
  satisfiesVersionRange,
  WINDOWS_EXECUTABLE_EXTENSIONS,
} from '@anvil/core'
import type { MatchResult } from '@anvil/playbooks'
import type { CommandSource, ProjectProfile } from '@anvil/profile'

/** The three answers the objective asks for, and the only ones a reader should branch on. */
export type ReadinessState = 'verified' | 'blocked' | 'unknown'

/** A command's origin, including `declared`, which the profile itself never carries. */
export type ReadyCommandSource = CommandSource | 'declared'

export interface ReadyCommand {
  kind: string
  cmd: string
  /** Repo-relative working directory the command runs from. `''` means the repository root. */
  dir: string
  /** `declared` is the owner's word, not yet observed. The rest come from the profile. */
  source: ReadyCommandSource
  evidence: string | null
  status: ReadinessState
}

/** How a tool's presence and version were decided. */
export type ReadyToolStatus = 'available' | 'incompatible' | 'missing' | 'unavailable' | 'unknown'

export interface ReadyTool {
  /** Stable id, and the binary probed unless it differs. */
  id: string
  bin: string
  /**
   * True when the tool is repository-controlled: a path (`./gradlew`), or a bare name that
   * resolves inside the repository. A repository-controlled tool is never executed.
   */
  path: boolean
  /** The repo-relative directory the tool is looked up from. `''` means the repository root. */
  dir: string
  reason: string | null
  /** True when the project cannot be verified without it. */
  required: boolean
  /** `declared` from config, `command` from the project's own commands, `playbook` from guidance. */
  source: 'declared' | 'command' | 'playbook'
  status: ReadyToolStatus
  /** The version the probe reported, or null when it could not be read. */
  version: string | null
  /** The version range the owner declared, or null when no range was required. */
  versionRange: string | null
  /** The install command the owner declared, if any. Never run by anvil. */
  install: string | null
}

export interface ReadyContext {
  id: string
  label: string
  detail: string
  status: ReadinessState
  evidence: string[]
}

export interface ReadyAction {
  id: string
  summary: string
  /** The command to run, or `null` when anvil can only describe the action. */
  command: string | null
  /** Always true. Nothing in this report ran, and nothing will run without a person. */
  requiresApproval: true
  reason: string
}

export interface ReadyReport {
  schemaVersion: 1
  root: string
  /** The directory the project's commands run from. `''` means the repository root. */
  projectDir: string
  /** True when the environment was probed (`--check`). False means tools are `unknown`. */
  checked: boolean
  status: ReadinessState
  summary: { verified: number; blocked: number; unknown: number }
  commands: ReadyCommand[]
  tools: ReadyTool[]
  context: ReadyContext[]
  actions: ReadyAction[]
  warnings: string[]
}

/** The probe result for one tool: whether it ran, and the version it reported. */
export interface ToolProbe {
  ok: boolean
  version: string | null
  /**
   * True when the probe could not complete — a timeout or a spawn failure — as opposed to a
   * tool that ran and failed. Inconclusive is `unknown`, never a blocker: on a slow machine
   * even `npm --version` can exceed a short budget, and a slow tool is not a broken one.
   */
  inconclusive?: boolean
}

/**
 * Probe arguments per tool, because `--version` is not universal.
 *
 * `go --version` exits 2; `go version` is the supported form. `xcodebuild` takes a single
 * dash. Every tool not listed uses `--version`, which is the overwhelming majority.
 */
const PROBE_ARGS: Readonly<Record<string, readonly string[]>> = {
  go: ['version'],
  xcodebuild: ['-version'],
}

/** The arguments that ask `bin` for its version. */
export function probeArgsFor(bin: string): readonly string[] {
  const base = bin
    .replace(/^.*[\\/]/, '')
    .replace(/\.(exe|cmd|bat|com)$/i, '')
    .toLowerCase()
  return PROBE_ARGS[base] ?? ['--version']
}

/** True when `candidate` is inside `root`, following symlinks when they can be read. */
export function isInsideRepository(root: string, candidate: string): boolean {
  const from = safeRealpath(root)
  const to = safeRealpath(candidate)
  const rel = relative(from, to)
  // `..foo` is a directory name inside the repository, not a step out of it; only `..` and
  // `../...` escape. Matching a bare `startsWith('..')` would treat a committed `..tools`
  // directory as external and let its binary be executed.
  return rel !== '' && rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel)
}

function safeRealpath(path: string): string {
  try {
    return realpathSync(path)
  } catch {
    return path
  }
}

/** True when `target` is `base` or lives under it. Used for containment, not tool identity. */
function isWithin(base: string, target: string): boolean {
  const rel = relative(base, target)
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel))
}

/**
 * True when `candidate` belongs to the repository, by any spelling of its path or directory.
 *
 * A committed symlink can point outside the repository while the entry the repository
 * controls sits inside it, so the directory that holds the executable is the decisive check,
 * canonicalized to follow directory aliases. Walking the lexical ancestors with `realpath`
 * also catches a repository reached through a directory alias under a different spelling.
 */
function isRepositoryControlled(root: string, candidate: string): boolean {
  const rootReal = safeRealpath(root)
  const lexical = resolve(candidate)
  if (isWithin(resolve(root), lexical)) return true
  if (isWithin(rootReal, safeRealpath(candidate))) return true
  let dir = dirname(lexical)
  for (;;) {
    if (isWithin(rootReal, safeRealpath(dir))) return true
    const parent = dirname(dir)
    if (parent === dir) return false
    dir = parent
  }
}

/** The environment checks the report needs, injected so tests never spawn a process. */
export interface ReadyEnvironment {
  /** The absolute path a bare binary name resolves to on PATH, or null when it is not there. */
  resolve(bin: string): string | null
  /**
   * Run the already-resolved `execPath` with its version probe. The caller passes the path it
   * checked, not the bare name, so the binary that is executed is the one that was inspected:
   * re-resolving the name here would let PATH change between the check and the run.
   */
  probe(execPath: string): Promise<ToolProbe>
  /** True when a path names a runnable executable. Never executes it. */
  isRunnable(absPath: string): boolean
}

/** True when an executable file at `absPath` can actually be launched. */
export function isRunnableExecutable(absPath: string, platform: NodeJS.Platform): boolean {
  try {
    const stat = statSync(absPath)
    if (!stat.isFile()) return false
    if (platform === 'win32') {
      return WINDOWS_EXECUTABLE_EXTENSIONS.some((ext) => absPath.toLowerCase().endsWith(ext))
    }
    return (stat.mode & 0o111) !== 0
  } catch {
    return false
  }
}

/** Where a version can begin: at least `major.minor`, optionally `v`-prefixed. */
const VERSION_START = /(?<![\d.])v?\d+\.\d/

/** The characters a version token can contain, so a malformed tail is swallowed whole. */
const VERSION_TOKEN = /[0-9A-Za-z._+-]+/y

/**
 * Read the version a `--version` output reports, or null when it cannot be read.
 *
 * Deliberately not a global scan. A regex with `g` would reject `1.2.3-rc_4.5.6`, then resume
 * and happily match the `4.5.6` inside that same malformed token -- or a dependency version
 * named later in the output -- and report a pass against a range the tool never satisfied.
 *
 * So this takes the *first* `major.minor` candidate, reads the whole contiguous token, and
 * refuses it if the token does not parse. `Python 3.13.0rc1`, `10.0.19045.3803`,
 * `1.2.3-rc_4.5.6` and a bare `1.2.3+` all become `unknown` rather than a shorter number.
 * Two components are accepted because some tools report only those (`Xcode 15.0`), and the
 * token class includes `_`, `+` and `-` so a malformed suffix is part of the candidate
 * rather than a boundary that ends it.
 */
function readVersion(output: string): string | null {
  const start = VERSION_START.exec(output)
  if (start === null) return null
  VERSION_TOKEN.lastIndex = start.index
  const token = VERSION_TOKEN.exec(output)?.[0]
  if (token === undefined) return null
  // `parseVersion` accepts a `v` prefix, but the report has always shown the bare version.
  const candidate = /^[vV]/.test(token) ? token.slice(1) : token
  return parseVersion(candidate) === null ? null : candidate
}

/** True when the name already ends in an extension Windows can launch. */
function hasWindowsExtension(name: string): boolean {
  return /\.(exe|cmd|bat|com)$/i.test(name)
}

/**
 * Find `name` on PATH exactly as written, without PATHEXT substitution.
 *
 * A configured interpreter that already names its extension is a complete filename, not a
 * stem. Looking it up with {@link resolveCommand} would append PATHEXT (`cmd.exe.exe`) and,
 * after stripping the extension, would try every PATHEXT entry (`cmd.com` before `cmd.exe`).
 * Either can select a file the configuration did not name.
 */
function resolveExactName(
  name: string,
  options: { env?: NodeJS.ProcessEnv; platform?: NodeJS.Platform },
): string | null {
  const env = options.env ?? process.env
  const dirs = (env.PATH ?? env.Path ?? '').split(delimiter).filter((d) => d !== '')
  for (const dir of dirs) {
    const candidate = join(dir, name)
    try {
      if (statSync(candidate).isFile()) return resolve(candidate)
    } catch {
      // Not in this directory; the next PATH entry can still contain it.
    }
  }
  return null
}

/**
 * Resolve a shim interpreter to an absolute path, or null when none can be trusted.
 *
 * A configured interpreter can be an absolute path or a bare name; a bare name must be
 * resolved here so the spawn never receives a name whose lookup the current directory or
 * `PATH` can redirect. The default is the system `cmd`.
 */
function resolveInterpreter(
  configured: string | undefined,
  options: { env?: NodeJS.ProcessEnv; platform?: NodeJS.Platform },
): string | null {
  if (configured !== undefined && configured !== '') {
    if (isAbsolute(configured) || configured.includes('/') || configured.includes('\\')) {
      return resolveCommand(configured, options) === null ? null : resolve(configured)
    }
    if (hasWindowsExtension(configured)) {
      // `cmd.exe` must resolve to `cmd.exe`, never to `cmd.exe.exe` or `cmd.com`.
      return resolveExactName(configured, options)
    }
    const resolved = resolveCommand(configured, options)
    return resolved === null ? null : resolve(resolved.path)
  }
  const fallback = resolveCommand('cmd', options)
  return fallback === null ? null : resolve(fallback.path)
}

/** The real environment: PATH lookup, a bounded probe, and a non-executing path check. */
export function systemEnvironment(
  options: {
    env?: NodeJS.ProcessEnv
    platform?: NodeJS.Platform
    containmentRoot?: string
    /** Overridable for tests: the launcher. Defaults to {@link runProcess}. */
    runner?: typeof runProcess
  } = {},
): ReadyEnvironment {
  const platform = options.platform ?? process.platform
  const runner = options.runner ?? runProcess
  return {
    resolve(bin) {
      return resolveCommand(bin, options)?.path ?? null
    },
    async probe(execPath) {
      try {
        const env = options.env ?? process.env
        let launchEnv: NodeJS.ProcessEnv | undefined = options.env
        // A `.cmd`/`.bat` shim is run through an interpreter. Decide which one *here* and pin
        // it: the bare `cmd.exe` fallback is resolved against PATH and the current directory,
        // which can be the repository itself. Only a shim needs an interpreter, so a native
        // executable is never affected by a repository-local `ComSpec`.
        if (platform === 'win32' && /\.(cmd|bat)$/i.test(execPath)) {
          // The interpreter is always an absolute path by the time it is pinned, so the spawn
          // never falls back to a bare `cmd.exe` that the current directory or PATH can decide.
          const interpreter = resolveInterpreter(env.ComSpec ?? env.COMSPEC, options)
          if (
            interpreter === null ||
            (options.containmentRoot !== undefined && isRepositoryControlled(options.containmentRoot, interpreter))
          ) {
            return { ok: false, version: null, inconclusive: true }
          }
          launchEnv = { ...env, ComSpec: interpreter }
        }
        const result = await runner(execPath, [...probeArgsFor(execPath)], {
          maxBuffer: 64 * 1024,
          // Generous on purpose: `npm --version` through a Windows shim can take seconds, and a
          // tight budget turns a working tool into a false "unavailable".
          timeoutMs: 10_000,
          platform,
          ...(launchEnv === undefined ? {} : { env: launchEnv }),
        })
        if (result.exitCode !== 0) return { ok: false, version: null }
        return { ok: true, version: readVersion(`${result.stdout}\n${result.stderr}`) }
      } catch {
        // A timeout or a spawn failure is inconclusive, not evidence that the tool is broken.
        return { ok: false, version: null, inconclusive: true }
      }
    },
    isRunnable(absPath) {
      return isRunnableExecutable(absPath, platform)
    },
  }
}

export interface BuildReadyOptions {
  profile: ProjectProfile
  matches: readonly MatchResult[]
  /** Owner-declared capabilities, already validated by the config loader. */
  declared: ProjectConfig
  /** Opt in to probing the environment. When false, no process is spawned. */
  check: boolean
  /** Overridable for tests. Defaults to {@link systemEnvironment}. */
  environment?: ReadyEnvironment
}

const KIND_ORDER = ['install', 'build', 'test', 'testFast', 'lint', 'format', 'typecheck', 'run']

function kindRank(kind: string): number {
  const index = KIND_ORDER.indexOf(kind)
  return index === -1 ? KIND_ORDER.length : index
}

/** The first token of a command, when it names a tool rather than a path. */
function toolFromCommand(cmd: string): { bin: string; path: boolean } | null {
  const first = cmd.trim().split(/\s+/)[0] ?? ''
  if (first === '') return null
  const path = first.includes('/') || first.includes('\\') || isAbsolute(first)
  if (path) return { bin: first, path: true }
  if (!/^[A-Za-z][A-Za-z0-9._-]*$/.test(first)) return null
  return { bin: first, path: false }
}

export async function buildReadyReport(options: BuildReadyOptions): Promise<ReadyReport> {
  const { profile, matches, declared, check } = options
  const environment = options.environment ?? systemEnvironment({ containmentRoot: profile.root })

  const commands = collectCommands(profile, declared.commands)
  const tools = await collectTools(profile, matches, declared, check, environment)
  const context = collectContext(profile)
  const warnings = collectWarnings(profile, declared.commands)
  const actions = proposeActions(tools, context)
  // Only required tools decide the status. An optional, playbook-suggested tool is guidance,
  // not a need: its absence must not turn a ready repository into an unknown one.
  const requiredReadiness = tools.filter((t) => t.required).map(toolState)
  const status = overallStatus(
    commands,
    requiredReadiness,
    context,
    warnings,
    tools.some((t) => t.required),
  )

  const states: ReadinessState[] = [
    ...commands.map((c) => c.status),
    ...requiredReadiness,
    ...context.map((c) => c.status),
  ]

  return {
    schemaVersion: 1,
    root: profile.root,
    projectDir: profile.projectDir,
    checked: check,
    status,
    summary: {
      verified: states.filter((s) => s === 'verified').length,
      blocked: states.filter((s) => s === 'blocked').length,
      unknown: states.filter((s) => s === 'unknown').length,
    },
    commands,
    tools,
    context,
    actions,
    warnings,
  }
}

function collectCommands(profile: ProjectProfile, declared: readonly DeclaredCommand[]): ReadyCommand[] {
  const out: ReadyCommand[] = []

  // Declared commands first: an owner who wrote a command down is overriding the detected
  // one for that kind, and the report keeps both so the overlap is visible rather than
  // silently resolved.
  for (const entry of declared) {
    out.push({
      kind: entry.kind,
      cmd: entry.cmd,
      dir: entry.dir ?? profile.projectDir,
      source: 'declared',
      evidence: 'anvil.config.json',
      // A declaration is the owner's word. It has not been observed, so it is not verified.
      status: 'unknown',
    })
  }

  for (const kind of Object.keys(profile.commands).sort((a, b) => kindRank(a) - kindRank(b))) {
    for (const entry of profile.commands[kind as keyof typeof profile.commands] ?? []) {
      out.push({
        kind,
        cmd: entry.cmd,
        dir: profile.projectDir,
        // The real source, kept: an inferred command is a guess and must not read as verified.
        source: entry.source,
        evidence: entry.evidence ?? null,
        status: entry.source === 'inferred' ? 'unknown' : 'verified',
      })
    }
  }

  return out
}

interface ToolDraft {
  id: string
  bin: string
  path: boolean
  dir: string
  reason: string | null
  required: boolean
  source: 'declared' | 'command' | 'playbook'
  versionRange: string | null
  install: string | null
}

async function collectTools(
  profile: ProjectProfile,
  matches: readonly MatchResult[],
  declared: ProjectConfig,
  check: boolean,
  environment: ReadyEnvironment,
): Promise<ReadyTool[]> {
  const tools = new Map<string, ToolDraft>()

  const add = (draft: ToolDraft, key: string): void => {
    const existing = tools.get(key)
    if (existing !== undefined) {
      if (existing.source === 'declared') return
      // The first reason wins, and an optional entry is only replaced by a required one: a
      // runner needed by several commands keeps the first command that named it.
      if (existing.required || !draft.required) return
    }
    tools.set(key, draft)
  }

  const addCommand = (cmd: string, dir: string, required: boolean, reason: string): void => {
    const tool = toolFromCommand(cmd)
    if (tool === null) return
    add(
      {
        id: tool.bin,
        bin: tool.bin,
        path: tool.path,
        dir,
        reason,
        required,
        source: 'command',
        versionRange: null,
        install: null,
      },
      tool.path ? `path:${dir}::${tool.bin}` : `bin:${tool.bin}`,
    )
  }

  // The effective command per kind decides what is required: the owner's declaration wins over
  // the detected command, which wins over a convention anvil inferred. A candidate or an
  // inferred command is kept as non-blocking information rather than a need.
  const kinds = [...new Set([...Object.keys(profile.commands), ...declared.commands.map((c) => c.kind)])].sort(
    (a, b) => kindRank(a) - kindRank(b),
  )
  for (const kind of kinds) {
    const declaredForKind = declared.commands.filter((c) => c.kind === kind)
    const entries = profile.commands[kind as keyof typeof profile.commands] ?? []
    if (declaredForKind.length > 0) {
      // Only the first declared command for a kind is the one anvil treats as needed. A second
      // declaration of the same kind is an alternative the owner offered, and a missing
      // alternative must not block a report the primary command satisfies.
      declaredForKind.forEach((entry, index) => {
        addCommand(
          entry.cmd,
          entry.dir ?? profile.projectDir,
          index === 0,
          index === 0 ? `runs the declared ${kind} command` : `an alternative declared ${kind} command`,
        )
      })
      for (const entry of entries) {
        addCommand(entry.cmd, profile.projectDir, false, `an alternative ${kind} command`)
      }
    } else {
      entries.forEach((entry, index) => {
        const inferred = entry.source === 'inferred'
        addCommand(
          entry.cmd,
          profile.projectDir,
          index === 0 && !inferred,
          inferred ? `an inferred ${kind} command` : `runs the ${kind} command`,
        )
      })
    }
  }

  // Tools the owner explicitly declared. Authoritative: they carry the install hint and the
  // required flag, and override a same-named entry from the commands above.
  for (const tool of declared.tools) {
    const bin = tool.bin ?? tool.id
    const path = bin.includes('/') || bin.includes('\\') || isAbsolute(bin)
    tools.set(path ? `path:${profile.projectDir}::${bin}` : `bin:${bin}`, {
      id: tool.id,
      bin,
      path,
      dir: profile.projectDir,
      reason: tool.reason ?? null,
      required: tool.required ?? true,
      source: 'declared',
      versionRange: tool.version ?? null,
      install: tool.install ?? null,
    })
  }

  // Tools a matched playbook's verify step suggests. Optional: the repository may run its
  // suite another way, and a missing suggestion must not block the report.
  for (const match of matches) {
    for (const cmds of Object.values(match.playbook.verify)) {
      for (const cmd of cmds) {
        const tool = toolFromCommand(cmd)
        if (tool === null) continue
        const key = tool.path ? `path:${profile.projectDir}::${tool.bin}` : `bin:${tool.bin}`
        if (tools.has(key)) continue
        tools.set(key, {
          id: tool.bin,
          bin: tool.bin,
          path: tool.path,
          dir: profile.projectDir,
          reason: `used by a ${match.playbook.id} verify command`,
          required: false,
          source: 'playbook',
          versionRange: null,
          install: null,
        })
      }
    }
  }

  const drafts = [...tools.values()]
  if (!check) return drafts.map((draft) => toTool(draft, 'unknown', null))
  return Promise.all(drafts.map((draft) => checkTool(draft, profile, environment)))
}

function toTool(draft: ToolDraft, status: ReadyToolStatus, version: string | null): ReadyTool {
  return {
    id: draft.id,
    bin: draft.bin,
    path: draft.path,
    dir: draft.dir,
    reason: draft.reason,
    required: draft.required,
    source: draft.source,
    status,
    version,
    versionRange: draft.versionRange,
    install: draft.install,
  }
}

/**
 * Decide a tool's status from its probe.
 *
 * A version requirement adds one honest third answer: when the tool ran but reported no
 * comparable version, compatibility is `unknown`, not `available` and not `incompatible`.
 */
function probeState(draft: ToolDraft, probe: ToolProbe): ReadyTool {
  if (!probe.ok) {
    if (probe.inconclusive === true) {
      // Could not be decided: a timeout or spawn failure is not evidence the tool is missing.
      return toTool(draft, 'unknown', null)
    }
    // The tool ran and failed: distinct from "not installed", and not a pass.
    return toTool(draft, 'unavailable', null)
  }
  if (draft.versionRange === null) return toTool(draft, 'available', probe.version)
  if (probe.version === null || parseVersion(probe.version) === null) {
    return toTool(draft, 'unknown', probe.version)
  }
  const satisfied = satisfiesVersionRange(probe.version, draft.versionRange)
  return toTool(draft, satisfied ? 'available' : 'incompatible', probe.version)
}

async function checkTool(draft: ToolDraft, profile: ProjectProfile, environment: ReadyEnvironment): Promise<ReadyTool> {
  if (draft.path) {
    // A path-shaped tool is repository-controlled. Existence and runnability are checked from
    // the directory its command runs in; it is never executed. An absolute path is already
    // rooted, so joining the repository onto it would fabricate a path that cannot exist.
    const absPath = isAbsolute(draft.bin) ? draft.bin : join(profile.root, draft.dir, draft.bin)
    if (!environment.isRunnable(absPath)) return toTool(draft, 'missing', null)
    // A version requirement on an unexecutable tool cannot be compared: available is not
    // justified, and calling it incompatible would invent a version.
    return toTool(draft, draft.versionRange === null ? 'available' : 'unknown', null)
  }
  const resolved = environment.resolve(draft.bin)
  if (resolved === null) return toTool(draft, 'missing', null)
  if (isRepositoryControlled(profile.root, resolved)) {
    // A bare name that resolves inside the repository is repository-controlled code (a shim in
    // `node_modules/.bin`, or a committed symlink whose target is elsewhere). Its existence is
    // checked; it is never executed.
    const runnable = environment.isRunnable(resolved)
    if (!runnable) return toTool({ ...draft, path: true }, 'missing', null)
    return toTool({ ...draft, path: true }, draft.versionRange === null ? 'available' : 'unknown', null)
  }
  // Probe the path that was checked, not the bare name: re-resolving here would let PATH change
  // between the containment check and the run.
  return probeState(draft, await environment.probe(resolved))
}

function toolState(tool: ReadyTool): ReadinessState {
  if (tool.status === 'available') return 'verified'
  // Not checked is `unknown`; checked-and-missing or checked-and-broken is `blocked`.
  if (tool.status === 'unknown') return 'unknown'
  return 'blocked'
}

function collectContext(profile: ProjectProfile): ReadyContext[] {
  // A global instruction file is the developer's, not the repository's, and is not shipped
  // with the code: it is not evidence that this repository has project context.
  const shipped = profile.instructions.filter((i) => i.category !== 'global')

  if (shipped.length > 0) {
    return [
      {
        id: 'instructions',
        label: 'Agent instructions',
        detail: shipped.map((i) => i.path).join(', '),
        status: 'verified',
        evidence: shipped.map((i) => i.path),
      },
    ]
  }

  return [
    {
      id: 'instructions',
      label: 'Agent instructions',
      detail:
        profile.instructions.length > 0
          ? 'Only a global instruction file is present, which is not shipped with the repository'
          : 'No agent instruction file: an agent starts with no project context',
      // A global-only setup is not a failure, but it is not repository context either, so it
      // is unknown rather than verified.
      status: profile.instructions.length > 0 ? 'unknown' : 'blocked',
      evidence: profile.instructions.map((i) => i.path),
    },
  ]
}

function collectWarnings(profile: ProjectProfile, declared: readonly DeclaredCommand[]): string[] {
  const warnings: string[] = []

  if (profile.diagnostics.truncated) {
    warnings.push(
      `the file walk stopped at ${profile.diagnostics.fileLimit} files, so this report is about an unknown subset of the repository`,
    )
  }
  for (const failed of profile.diagnostics.failedDetectors) {
    warnings.push(`detector ${failed.id} failed: ${failed.error}`)
  }

  const detectedKinds = new Set(Object.keys(profile.commands))
  for (const entry of declared) {
    if (!detectedKinds.has(entry.kind)) continue
    const detected = (profile.commands[entry.kind as keyof typeof profile.commands] ?? []).map((c) => c.cmd)
    warnings.push(
      `declared ${entry.kind} command \`${entry.cmd}\` overrides the detected \`${detected.join('`, `')}\` from anvil.config.json`,
    )
  }

  return warnings
}

function proposeActions(tools: readonly ReadyTool[], context: readonly ReadyContext[]): ReadyAction[] {
  const actions: ReadyAction[] = []

  for (const tool of tools) {
    if (!tool.required || tool.path) continue
    if (tool.status === 'incompatible') {
      actions.push({
        id: `upgrade:${tool.id}`,
        summary: `Upgrade ${tool.id}`,
        // Still only the owner's command, never a guessed package-manager line.
        command: tool.install,
        requiresApproval: true,
        reason: `${tool.id} requires ${tool.versionRange ?? 'a different version'}, but ${
          tool.version ?? 'an unreadable version'
        } was found${tool.reason === null ? '' : ` (${tool.reason})`}; install a supported version or update your configuration`,
      })
      continue
    }
    if (tool.status !== 'missing') continue
    if (tool.install !== null) {
      actions.push({
        id: `install:${tool.id}`,
        summary: `Install ${tool.id}`,
        command: tool.install,
        requiresApproval: true,
        reason: tool.reason ?? `${tool.id} is required and was not found on PATH`,
      })
    } else {
      actions.push({
        id: `provide:${tool.id}`,
        summary: `Provide ${tool.id}`,
        // No fabricated command: anvil does not know this project's package manager, and a
        // guessed install line is exactly the kind of confident wrong answer this tool refuses.
        command: null,
        requiresApproval: true,
        reason: `${tool.id} is required and was not found on PATH${
          tool.reason === null ? '' : ` (${tool.reason})`
        }; install it, or declare an \`install\` command for it in anvil.config.json`,
      })
    }
  }

  for (const item of context) {
    if (item.id !== 'instructions' || item.status === 'verified') continue
    actions.push({
      id: 'init-context',
      summary: 'Stage an agent instructions file',
      command: 'anvil init',
      requiresApproval: true,
      reason: 'this repository ships no agent context; `anvil init` stages AGENTS.md and a verify skill for review',
    })
  }

  return actions
}

function overallStatus(
  commands: readonly ReadyCommand[],
  requiredTools: readonly ReadinessState[],
  context: readonly ReadyContext[],
  warnings: readonly string[],
  hasRequiredTools: boolean,
): ReadinessState {
  const states = [...commands.map((c) => c.status), ...requiredTools, ...context.map((c) => c.status)]
  if (states.includes('blocked')) return 'blocked'
  // Nothing identified and nothing required is an unknown answer, not a pass: a repository
  // anvil cannot describe has not been shown to be ready.
  if (commands.length === 0 && !hasRequiredTools) return 'unknown'
  // An incomplete profile is an unknown answer even when every rule that ran passed, for the
  // same reason `doctor --strict` refuses to score it: the report is about a subset.
  if (warnings.length > 0 || states.includes('unknown')) return 'unknown'
  return 'verified'
}
