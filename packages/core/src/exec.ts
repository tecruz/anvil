/**
 * Cross-platform process execution.
 *
 * The rule everywhere else in anvil is "never through a shell", because ticket text, branch
 * names and commit bodies are all attacker-controlled in a repo you do not own. That rule
 * has one unavoidable exception on **Windows**, and this module is where it is handled.
 *
 * The problem: on Windows, `npm`, `npx`, `pnpm`, `yarn`, `bun`, `mvn`, `gradlew.bat` and
 * friends are `.cmd`/`.bat` shims, not executables. Node's `uv_spawn` does not resolve
 * PATHEXT, so `execFile('npm', ...)` fails with ENOENT. This is not hypothetical -- it
 * breaks every verify command, every `gh` call and every agent launch on Windows.
 *
 * The temptation is `shell: true`, which reopens command injection: a PR body or a ticket
 * title containing `; whoami` would execute. So instead:
 *
 *  1. Resolve the binary on PATH ourselves, trying each PATHEXT extension.
 *  2. If it is a real executable (`.exe`, `.com`), `execFile` it directly with an argument
 *     array. Nothing is re-parsed, so nothing can be injected. This is the path taken by
 *     `gh` and `git` on Windows, so most calls never reach step 3.
 *  3. If it is a shim (`.cmd`, `.bat`), `cmd.exe` is unavoidable -- the OS has no other way
 *     to run one. The command line is then built by quoting every argument, and any
 *     argument containing a character cmd would treat as a metacharacter is **refused**
 *     rather than escaped.
 *
 * Step 3's last part is the important design decision: refuse, do not attempt to escape.
 * A metacharacter that we cannot prove is inert is an error with a clear message, not a
 * best-effort string. The tool would rather decline to run a command than run the wrong
 * one.
 */

import { execFile } from 'node:child_process'
import { existsSync, statSync } from 'node:fs'
import { delimiter, isAbsolute, join } from 'node:path'
import { promisify } from 'node:util'
import { AnvilError, ErrorCode } from './errors.ts'

const execFileAsync = promisify(execFile)

export interface ProcessResult {
  stdout: string
  stderr: string
  exitCode: number
}

export interface RunProcessOptions {
  cwd?: string
  env?: NodeJS.ProcessEnv
  maxBuffer?: number
  timeoutMs?: number
  /** Overridable for tests. Defaults to the real platform. */
  platform?: NodeJS.Platform
}

/** Extensions Windows treats as executable, in PATHEXT order. */
export const WINDOWS_EXECUTABLE_EXTENSIONS = ['.exe', '.com', '.cmd', '.bat'] as const

/**
 * Characters cmd.exe interprets even inside double quotes, or that break quoting.
 *
 * `%` is excluded on purpose: it survives quoting and still triggers variable expansion,
 * but it is legitimate in real commands (`%PATH%`, npm's `%npm_config_*%`), and the
 * arguments reaching here are script names and flags from manifests, not prose. Excluding
 * it would refuse `mvn -Dfoo=%bar%` for no safety gain. `!` and backtick and caret are
 * refused because they are expansion metacharacters with no legitimate use here.
 */
const UNSAFE_ARG_CHARS = /["&|<>^`!\0\r\n]/

export function isUnsafeArgument(arg: string): boolean {
  return UNSAFE_ARG_CHARS.test(arg)
}

/**
 * Quote one argument for a cmd.exe command line.
 *
 * Only called for arguments that already passed `isUnsafeArgument`, so this is about
 * correctness (spaces, wildcards, parens) rather than safety.
 */
export function quoteForCmd(arg: string): string {
  if (arg === '') return '""'
  if (/^[A-Za-z0-9_.:/\\=@,+%-]+$/.test(arg)) return arg
  return `"${arg.replace(/(\\*)"/g, '$1$1\\"')}"`
}

function buildCmdLine(bin: string, args: readonly string[]): string {
  // The binary path is quoted too, not just the arguments. On a default Windows install
  // that path is `C:\Program Files\nodejs\npm.cmd`, and an unquoted command line makes
  // cmd treat `C:\Program` as the program.
  return [quoteForCmd(bin), ...args.map(quoteForCmd)].join(' ')
}

/**
 * The argv for launching a shim through cmd.exe.
 *
 * Two Windows quirks have to be satisfied at once, and both are load-bearing:
 *
 *  1. **Node escapes embedded quotes.** By default, `execFile` turns a `"` in an argument
 *     into `\"` on the way to CreateProcess, so cmd receives a literal backslash-quote and
 *     reports `'"C:\Program Files\...\npm.CMD"' is not recognized`, quotes included.
 *     `windowsVerbatimArguments` passes argv through untouched, which is what lets the
 *     real quoting reach cmd.
 *  2. **Do not pass `/s`.** With `/s`, cmd strips the first and last quote of the command
 *     line, which removes the *inner* quotes around a spaced path instead of the outer
 *     pair. `/d /c` with one wrapping pair of quotes is the shape that works.
 *
 * The wrapping quotes are required for the spaced path; the inner ones are what make cmd
 * treat `C:\Program Files\...` as a single program.
 */
function cmdShimArgs(bin: string, args: readonly string[]): string[] {
  return ['/d', '/c', `"${buildCmdLine(bin, args)}"`]
}

/** Split a PATH entry list, honouring PATHEXT. */
function pathExtensions(env: NodeJS.ProcessEnv): string[] {
  const pathext = env.PATHEXT
  if (pathext === undefined || pathext === '') return [...WINDOWS_EXECUTABLE_EXTENSIONS]
  return pathext.split(';').filter((e) => e !== '')
}

export interface ResolvedCommand {
  /** The path to execute. */
  path: string
  /** True when the target is a cmd/bat shim and must be launched through cmd.exe. */
  isShim: boolean
}

/**
 * Find a command on PATH.
 *
 * On Windows this is the step `execFile` refuses to do. On other platforms it just checks
 * that the thing exists before we bother spawning.
 */
export function resolveCommand(
  bin: string,
  opts: { env?: NodeJS.ProcessEnv; platform?: NodeJS.Platform } = {},
): ResolvedCommand | null {
  const env = opts.env ?? process.env
  const platform = opts.platform ?? process.platform

  // An explicit path is used as given, if it exists.
  if (bin.includes('/') || bin.includes('\\') || isAbsolute(bin)) {
    if (!existsSync(bin)) return null
    const isShim = platform === 'win32' && /\.(cmd|bat)$/i.test(bin)
    return { path: bin, isShim }
  }

  const pathValue = env.PATH ?? env.Path ?? ''
  const dirs = pathValue.split(delimiter).filter((d) => d !== '')

  if (platform !== 'win32') {
    for (const dir of dirs) {
      const candidate = join(dir, bin)
      if (existsSync(candidate)) return { path: candidate, isShim: false }
    }
    return null
  }

  for (const dir of dirs) {
    for (const ext of pathExtensions(env)) {
      const candidate = join(dir, `${bin}${ext}`)
      if (existsSync(candidate)) return { path: candidate, isShim: /\.(cmd|bat)$/i.test(ext) }
    }
  }
  return null
}

/**
 * Refuse an argument that cmd would interpret, rather than trying to escape it.
 *
 * Escaping is the wrong tool here: the arguments include ticket titles, PR bodies and file
 * paths, all of which are user input, and a tool that runs the wrong command is worse than
 * one that declines. The refusal names the argument so it is obvious which value to fix.
 */
function assertSafeArgument(arg: string, bin: string, platform: NodeJS.Platform): void {
  if (!isUnsafeArgument(arg)) return
  const detail =
    platform === 'win32'
      ? 'an argument contains a character Windows cmd would interpret'
      : 'an argument contains a character that would need shell escaping'
  throw new AnvilError(ErrorCode.Usage, `Refusing to run \`${bin}\`: ${detail}: ${JSON.stringify(arg)}`, {
    hint: 'This is a shell-metacharacter safety check, not a bug. anvil only runs commands whose arguments it can verify are inert.',
  })
}

/**
 * The argv for launching a binary in a way that does not wait for it.
 *
 * Same shim handling as {@link runProcess}, and for the same reason: `spawn('opencode')`
 * fails with ENOENT on Windows because the npm-installed `opencode` is a `.CMD` shim.
 * An agent launcher that silently fails to start is worse than one that refuses, because
 * the crew reports success and nothing is working.
 */
export function spawnArgv(
  bin: string,
  args: readonly string[] = [],
  opts: { env?: NodeJS.ProcessEnv; platform?: NodeJS.Platform } = {},
): { file: string; args: string[]; resolved: ResolvedCommand } {
  const platform = opts.platform ?? process.platform
  const resolved = resolveCommand(bin, {
    ...(opts.env === undefined ? {} : { env: opts.env }),
    platform,
  })
  if (resolved === null) {
    throw new AnvilError(ErrorCode.ToolMissing, `Command not found: ${bin}`, {
      hint: hintFor(bin, platform),
    })
  }
  if (resolved.isShim) {
    for (const arg of args) assertSafeArgument(arg, bin, platform)
  }
  const env = opts.env ?? process.env
  const file = resolved.isShim ? (env.ComSpec ?? 'cmd.exe') : resolved.path
  const spawnArgs = resolved.isShim ? cmdShimArgs(resolved.path, args) : [...args]
  return { file, args: spawnArgs, resolved }
}

/** True when a launch needs `windowsVerbatimArguments` to keep its quoting intact. */
export function needsVerbatimArguments(
  bin: string,
  opts: { env?: NodeJS.ProcessEnv; platform?: NodeJS.Platform } = {},
): boolean {
  const platform = opts.platform ?? process.platform
  const resolved = resolveCommand(bin, {
    ...(opts.env === undefined ? {} : { env: opts.env }),
    platform,
  })
  // Not `resolved?.isShim`: this returns `boolean`, and an optional chain would widen it
  // to `boolean | undefined` -- a lie about a question that always has an answer.
  if (resolved === null) return false
  return resolved.isShim
}

/**
 * Run a program with an argument array, safely, on any platform.
 *
 * Returns the exit code rather than throwing on a non-zero exit, because almost every
 * caller needs to *decide* what a failure means.
 */
export async function runProcess(
  bin: string,
  args: readonly string[] = [],
  options: RunProcessOptions = {},
): Promise<ProcessResult> {
  const platform = options.platform ?? process.platform
  const resolved = resolveCommand(bin, {
    ...(options.env === undefined ? {} : { env: options.env }),
    platform,
  })

  if (resolved === null) {
    throw new AnvilError(ErrorCode.ToolMissing, `Command not found: ${bin}`, {
      hint: hintFor(bin, platform),
    })
  }

  // On Windows a shim must go through cmd.exe. Refuse anything we cannot prove inert.
  if (resolved.isShim) {
    for (const arg of args) assertSafeArgument(arg, bin, platform)
  }

  const env = options.env ?? process.env
  const execPath = resolved.isShim ? (env.ComSpec ?? 'cmd.exe') : resolved.path
  const execArgs = resolved.isShim ? cmdShimArgs(resolved.path, args) : [...args]

  try {
    const { stdout, stderr } = await execFileAsync(execPath, execArgs, {
      ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
      ...(options.env === undefined ? {} : { env: options.env }),
      maxBuffer: options.maxBuffer ?? 8 * 1024 * 1024,
      windowsHide: true,
      // Only for the shim path, where it is what lets our quoting survive to cmd.
      ...(resolved.isShim ? { windowsVerbatimArguments: true } : {}),
      ...(options.timeoutMs === undefined ? {} : { timeout: options.timeoutMs }),
    })
    return { stdout, stderr, exitCode: 0 }
  } catch (err) {
    const e = err as {
      code?: number | string
      stdout?: string
      stderr?: string
      message?: string
    }
    if (e !== null && typeof e === 'object' && typeof e.code === 'number') {
      return {
        stdout: e.stdout ?? '',
        stderr: e.stderr ?? e.message ?? '',
        exitCode: e.code,
      }
    }
    throw new AnvilError(ErrorCode.Internal, `Failed to run ${bin}: ${e?.message ?? String(err)}`, { cause: err })
  }
}

function hintFor(bin: string, platform: NodeJS.Platform): string {
  if (platform !== 'win32') return `Is ${bin} installed and on PATH?`
  const base = bin.replace(/\.(cmd|bat|exe)$/i, '')
  return `Is ${base} installed and on PATH? On Windows anvil resolves ${base}.exe, ${base}.cmd and ${base}.bat.`
}

/** True when a path looks like an executable rather than a directory. */
export function isExecutableFile(path: string): boolean {
  try {
    return statSync(path).isFile()
  } catch {
    return false
  }
}
