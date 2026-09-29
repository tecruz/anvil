/**
 * Crews: several tickets in flight at once.
 *
 * The hard part of parallel work is not git -- M3 solved the ref contention -- it is
 * **build caches**. Worktrees have isolated indexes but share the caches an ecosystem puts
 * in the user's home directory. Two Gradle builds at once contend on `~/.gradle`; two npm
 * installs contend on the shared store; Bazel contends on its output base. That is the
 * "cross-contamination" that actually bites, and it is invisible until a build corrupts
 * something or thrashes a laptop.
 *
 * So verification runs under an explicit concurrency policy, derived from the detected
 * stacks, and the decision is *printed* rather than applied silently. A tool that quietly
 * serializes your builds and never says why is worse than one that runs them all at once
 * and lets the machine cope.
 *
 * Second decision: **claims are serialized, agents are not.** Creating a worktree mutates
 * git's shared administrative area, so claims run one at a time. An agent only touches its
 * own worktree, so agents run fully in parallel.
 */

import { spawn } from 'node:child_process'
import { mkdirSync, writeFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { availableParallelism, cpus } from 'node:os'
import { mainWorktreeRoot } from '@anvil/git'
import { buildProfile, type ProjectProfile } from '@anvil/profile'
import type { Ticket } from '@anvil/tickets'
import { claimTicket, readClaims, writeClaims, type Claim } from './index.ts'

// ---------------------------------------------------------------------------
// Concurrency policy
// ---------------------------------------------------------------------------

/** How safely an ecosystem tolerates parallel builds across worktrees. */
export type Isolation = 'safe' | 'serialized'

interface IsolationRule {
  /** A stack or language id that implies this behaviour. */
  match: string
  isolation: Isolation
  reason: string
}

/**
 * Per-ecosystem build isolation.
 *
 * `serialized` means anvil will not run two of these at once, because the toolchain keeps
 * mutable state in a shared home-directory cache. `safe` means either the cache is
 * content-addressed (Go) or the tool takes its own file locks (Cargo).
 */
const ISOLATION_RULES: readonly IsolationRule[] = [
  { match: 'gradle', isolation: 'serialized', reason: 'Gradle shares a mutable cache in the user home directory (~/.gradle)' },
  { match: 'jvm', isolation: 'serialized', reason: 'Gradle shares a mutable cache in the user home directory (~/.gradle)' },
  { match: 'maven', isolation: 'serialized', reason: 'Maven shares a local repository at ~/.m2/repository' },
  // A Node project emits the stack id `node`, not `npm`, so that is what has to be
  // matched. The registry installer and the build both write to ~/.npm.
  { match: 'node', isolation: 'serialized', reason: 'npm shares a content cache and install tree in ~/.npm' },
  { match: 'bun', isolation: 'serialized', reason: 'Bun shares an install cache in the user home directory' },
  { match: 'pnpm', isolation: 'serialized', reason: 'pnpm shares a content-addressable store, but installs still serialize' },
  { match: 'yarn', isolation: 'serialized', reason: 'Yarn shares a cache in the user home directory' },
  { match: 'bazel', isolation: 'serialized', reason: 'Bazel shares an output base unless the worktree sets its own' },
  { match: 'go', isolation: 'safe', reason: 'the Go build cache is content-addressed and concurrency-safe' },
  { match: 'rust', isolation: 'safe', reason: 'Cargo takes its own file locks on the shared home, and each worktree has its own target/' },
  { match: 'python', isolation: 'safe', reason: 'Python has no shared build cache' },
  { match: 'ruby', isolation: 'safe', reason: 'Ruby has no shared build cache' },
]

export interface ConcurrencyDecision {
  /** The effective number of concurrent verify runs. */
  jobs: number
  /** Why it is that number. Printed, so a slow crew is explainable. */
  reason: string
  /** True when the toolchain forced serialization regardless of --jobs. */
  forcedByCaches: boolean
  rules: Array<{ match: string; reason: string }>
}

/** Default concurrency: half the machine, because builds are memory-hungry. */
export function defaultJobs(): number {
  let cores: number
  try {
    cores = availableParallelism()
  } catch {
    cores = cpus().length
  }
  return Math.max(1, Math.floor(cores / 2))
}

/** Work out how parallel verification may safely be for a repository. */
export function concurrencyFor(profile: ProjectProfile, requested: number | null): ConcurrencyDecision {
  const ids = new Set([...profile.stacks.map((s) => s.id), ...profile.languages.map((l) => l.id)])
  const triggered: IsolationRule[] = []
  for (const rule of ISOLATION_RULES) {
    if (!ids.has(rule.match)) continue
    // A `safe` rule is recorded but does not constrain: one safe toolchain does not
    // make a Gradle build safe.
    if (rule.isolation === 'serialized' || triggered.length === 0) triggered.push(rule)
  }
  const serializing = triggered.filter((r) => r.isolation === 'serialized')

  if (serializing.length > 0) {
    return {
      jobs: 1,
      reason: `serialized: ${serializing.map((r) => r.reason).join('; ')}`,
      forcedByCaches: true,
      rules: serializing.map((r) => ({ match: r.match, reason: r.reason })),
    }
  }

  const jobs = requested ?? defaultJobs()
  return {
    jobs,
    reason: requested === null ? `${jobs} concurrent runs (half of ${availableParallelism()} reported cores)` : `${jobs} concurrent runs (--jobs)`,
    forcedByCaches: false,
    rules: [],
  }
}

// ---------------------------------------------------------------------------
// Bounded concurrency
// ---------------------------------------------------------------------------

/**
 * Run `worker` over `items` with at most `limit` in flight.
 *
 * Results come back in input order, because a crew report read out of order is a crew
 * report nobody trusts. The first rejection propagates, so a caller can fail fast.
 */
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  worker: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const bounded = Math.max(1, Math.min(limit, items.length))
  const results = new Array<R>(items.length)
  let next = 0

  const run = async (): Promise<void> => {
    for (;;) {
      const index = next++
      if (index >= items.length) return
      results[index] = await worker(items[index] as T, index)
    }
  }

  await Promise.all(Array.from({ length: bounded }, run))
  return results
}

// ---------------------------------------------------------------------------
// crew up
// ---------------------------------------------------------------------------

export interface CrewUpOptions {
  repoRoot: string
  tickets: Ticket[]
  prefix?: string
  base?: string
  worktreeRoot?: string | null
  /** Launch an agent in each worktree. */
  launch: boolean
  runner: string
  /** Injected so tests never spawn a process. */
  launcher?: AgentLauncher
  fetchFirst?: boolean
}

export interface AgentLaunch {
  key: string
  worktree: string
  pid: number | null
  logPath: string
  launched: boolean
  detail: string
}

export type AgentLauncher = (options: { worktree: string; key: string; prompt: string; logPath: string; runner: string }) => Promise<{ pid: number | null; detail: string }>

export interface CrewUpResult {
  claims: Claim[]
  launches: AgentLaunch[]
  /** Claims that were refused, with the reason. The rest still stand. */
  failures: Array<{ key: string; reason: string }>
}

/**
 * Claim N tickets and optionally start an agent in each.
 *
 * Claims run one at a time because `git worktree add` mutates the repository's shared
 * administrative area; a partially-created worktree is messy to clean up by hand. Agents
 * then start in parallel, because they only touch their own worktree.
 *
 * A refused claim does not stop the others. A crew of three where one ticket is already
 * claimed should still get two worktrees, not zero.
 */
export async function crewUp(options: CrewUpOptions): Promise<CrewUpResult> {
  const repoRoot = options.repoRoot
  const claims: Claim[] = []
  const failures: Array<{ key: string; reason: string }> = []
  const launches: AgentLaunch[] = []

  for (const ticket of options.tickets) {
    try {
      const result = await claimTicket({
        repoRoot,
        ticket,
        ...(options.prefix === undefined ? {} : { prefix: options.prefix }),
        ...(options.base === undefined ? {} : { base: options.base }),
        worktreeRoot: options.worktreeRoot ?? null,
        runner: options.launch ? options.runner : 'none',
      })
      claims.push(result.claim)
    } catch (err) {
      failures.push({ key: ticket.ref.key, reason: err instanceof Error ? err.message : String(err) })
    }
  }

  if (!options.launch) {
    return { claims, launches, failures }
  }

  const launcher = options.launcher ?? launchOpencodeAgent
  const logDir = join(repoRoot, '.anvil', 'logs')
  mkdirSync(logDir, { recursive: true })

  // Agents are independent, so start them concurrently and collect whatever happened.
  const started = await mapWithConcurrency(claims, 4, async (claim) => {
    const logPath = join(logDir, `${claim.key}.log`)
    try {
      const result = await launcher({
        worktree: claim.worktreePath,
        key: claim.key,
        prompt: agentPrompt(claim, options.repoRoot),
        logPath,
        runner: options.runner,
      })
      const launch: AgentLaunch = {
        key: claim.key,
        worktree: claim.worktreePath,
        pid: result.pid,
        logPath,
        launched: true,
        detail: result.detail,
      }
      recordLaunch(repoRoot, claim.key, result.pid)
      return launch
    } catch (err) {
      return {
        key: claim.key,
        worktree: claim.worktreePath,
        pid: null,
        logPath,
        launched: false,
        detail: err instanceof Error ? err.message : String(err),
      }
    }
  })

  launches.push(...started)
  return { claims, launches, failures }
}

function recordLaunch(repoRoot: string, key: string, pid: number | null): void {
  const registry = readClaims(repoRoot)
  registry.claims = registry.claims.map((c) =>
    c.key === key
      ? { ...c, agent: { ...(c.agent ?? { runner: 'opencode' }), launchedAt: new Date().toISOString(), ...(pid === null ? {} : { sessionId: String(pid) }) } }
      : c,
  )
  writeClaims(repoRoot, registry)
}

/**
 * The prompt an agent starts with.
 *
 * It points at the context bundle rather than restating the ticket, so the context file
 * stays the single source of truth. It explicitly forbids pushing: shipping is a human
 * decision, and an agent that pushes is an agent nobody reviewed.
 */
export function agentPrompt(claim: Claim, repoRoot: string): string {
  return [
    `You are working in a dedicated git worktree for ticket ${claim.key}, on branch ${claim.branch}.`,
    '',
    'Start here:',
    '1. Read .anvil/ticket.md. It has the task, the acceptance criteria and this repository\'s verify commands.',
    '2. Read the repository AGENTS.md if there is one; it still applies.',
    `3. If anything is unclear, the original tickets are in ${join(repoRoot, '.anvil', 'tickets')}.`,
    '',
    'When you finish:',
    '- Run the verify commands from .anvil/ticket.md until they pass. An unverified change is not a proposal.',
    '- Commit your work with a clear message.',
    '- Do NOT push, do NOT open a pull request, and do NOT release the worktree. A human runs `anvil ship`.',
    '- If you are blocked, say so in your final message rather than guessing.',
  ].join('\n')
}

/**
 * Start an opencode agent in a worktree, detached.
 *
 * `--dir` rather than a working-directory change, so the parent's cwd is untouched. The
 * process is detached and its stdio ignored so it survives anvil exiting -- a crew is
 * meant to keep working after you close the terminal.
 */
export async function launchOpencodeAgent(options: {
  worktree: string
  key: string
  prompt: string
  logPath: string
  runner: string
}): Promise<{ pid: number | null; detail: string }> {
  const binary = options.runner === 'opencode' ? 'opencode' : options.runner
  const child = spawn(binary, ['run', '--dir', options.worktree, '--print-logs', options.prompt], {
    cwd: options.worktree,
    detached: process.platform !== 'win32',
    stdio: 'ignore',
    windowsHide: true,
  })
  child.unref()

  writeFileSync(
    options.logPath,
    `launched ${binary} in ${options.worktree}\npid ${String(child.pid ?? 'unknown')}\n\n`,
    'utf8',
  )
  return {
    pid: child.pid ?? null,
    detail: `started ${binary} (pid ${String(child.pid ?? 'unknown')}), logs at ${options.logPath}`,
  }
}

/** Is a launched agent still running? */
export function isProcessAlive(pid: number): boolean {
  try {
    // Signal 0 tests for existence without signalling.
    process.kill(pid, 0)
    return true
  } catch (err) {
    // EPERM means it exists but is owned by someone else.
    return (err as { code?: string }).code === 'EPERM'
  }
}

// ---------------------------------------------------------------------------
// crew verify
// ---------------------------------------------------------------------------

export interface VerifyResult {
  key: string
  worktree: string
  ok: boolean
  /** Per-command outcomes. */
  commands: Array<{ command: string; ok: boolean; code: number; detail: string }>
  error?: string
}

export interface CrewVerifyOptions {
  repoRoot: string
  /** Only verify these claims; all active claims when omitted. */
  keys?: readonly string[]
  /** Concurrency override. */
  jobs?: number | null
  /** Skip the cache policy and use --jobs literally. */
  forceParallel?: boolean
  /** Injected so tests never execute a build. */
  run: (command: string, cwd: string) => Promise<{ ok: boolean; code: number; stdout: string; stderr: string }>
  read?: (rel: string) => string | null
}

export interface CrewVerifyResult {
  results: VerifyResult[]
  ok: boolean
  concurrency: ConcurrencyDecision
  /** Claims that had nothing to verify, e.g. a worktree that vanished. */
  skipped: Array<{ key: string; reason: string }>
}

/**
 * Run each worktree's verify commands.
 *
 * `ok` is false if **any** worktree failed. A green aggregate must never hide a red
 * member, because the whole value of a crew is trusting the aggregate.
 */
export async function crewVerify(options: CrewVerifyOptions): Promise<CrewVerifyResult> {
  const mainRoot = (await mainWorktreeRoot(options.repoRoot)) ?? options.repoRoot
  const registry = readClaims(mainRoot)
  const targets = registry.claims.filter(
    (c) => c.state === 'active' && (options.keys === undefined || options.keys.includes(c.key)),
  )

  const skipped: Array<{ key: string; reason: string }> = []
  const runnable: Claim[] = []
  for (const claim of targets) {
    if (!existsSync(claim.worktreePath)) {
      skipped.push({ key: claim.key, reason: `worktree is gone: ${claim.worktreePath}` })
      continue
    }
    runnable.push(claim)
  }

  // The policy comes from the *repository's* profile, not one worktree's: they are the
  // same project, and the caches are shared across all of them.
  const profileDir = runnable[0]?.worktreePath ?? options.repoRoot
  const profile = buildProfileFor(profileDir)
  const decision =
    options.forceParallel === true && options.jobs != null
      ? {
          jobs: Math.max(1, options.jobs),
          reason: `${options.jobs} concurrent runs (--jobs, cache policy overridden)`,
          forcedByCaches: false,
          rules: [],
        }
      : concurrencyFor(profile, options.jobs ?? null)

  const results = await mapWithConcurrency(runnable, decision.jobs, async (claim) => {
    const commands = verifyCommandsFor(claim, profile)
    if (commands.length === 0) {
      return { key: claim.key, worktree: claim.worktreePath, ok: false, commands: [], error: 'no verify command detected' }
    }
    const perCommand: VerifyResult['commands'] = []
    for (const command of commands) {
      const outcome = await options.run(command, claim.worktreePath)
      perCommand.push({
        command,
        ok: outcome.ok,
        code: outcome.code,
        detail: outcome.ok ? '' : (outcome.stderr || outcome.stdout).slice(0, 300),
      })
      // Stop at the first failure: running lint after tests failed is wasted time, and the
      // failure is already recorded.
      if (!outcome.ok) break
    }
    return {
      key: claim.key,
      worktree: claim.worktreePath,
      ok: perCommand.every((c) => c.ok),
      commands: perCommand,
    }
  })

  return { results, ok: results.every((r) => r.ok), concurrency: decision, skipped }
}

function verifyCommandsFor(claim: Claim, profile: ProjectProfile): string[] {
  void claim
  const order: Array<keyof ProjectProfile['commands']> = ['testFast', 'test', 'typecheck', 'lint', 'build']
  const out: string[] = []
  for (const kind of order) {
    const entry = profile.commands[kind]?.[0]
    if (entry === undefined) continue
    if (out.includes(entry.cmd)) continue
    out.push(entry.cmd)
  }
  return out
}

function buildProfileFor(dir: string): ProjectProfile {
  return buildProfile(dir, { root: dir, host: null, remote: null, defaultBranch: null }).profile
}
