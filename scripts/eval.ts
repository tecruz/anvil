/**
 * The eval harness.
 *
 * Does anvil's derived context actually help an agent? Everything else in this project
 * is a proxy for that question: the doctor score says a repository is oriented, the plan
 * says what to fix next, and neither of them says whether the agent got the work done.
 *
 * So this runs the same task twice in the same repository -- once with the artifacts
 * `anvil init --apply` writes, once without -- and grades both the same way. The
 * repository's own verify command decides whether the work was done; a hidden test,
 * copied in only after the agent has finished, decides whether the work was *the work*;
 * and the host's usage ledger decides what it cost.
 *
 * The grading is deterministic even though the agent is not: the verifier is an exit
 * code, and the cost is read from a file another tool wrote. That is what makes the
 * comparison worth running more than once.
 *
 * It is not part of `npm test`, and it needs an agent and a model to run at all, so it
 * is behind `ANVIL_EVAL=1`. `--dry-run` prints what it would do and stops, which is how
 * the harness itself is tested without spending a token.
 *
 * Run with: `ANVIL_EVAL=1 npm run eval`
 *
 * The model is opencode's configured default unless `ANVIL_EVAL_MODEL` names one
 * (`provider/model`). The default on a machine can be an image model or an exhausted
 * free tier, neither of which runs this scenario, and a harness that cannot say which
 * model produced a result cannot compare two runs.
 */

import { type ChildProcess, spawn, spawnSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { lookupSessionCosts } from '../packages/cli/src/cost.ts'
import { tokenizeCommand } from '../packages/core/src/args.ts'
import { spawnArgv } from '../packages/core/src/exec.ts'
import { readAgentSession } from '../packages/worktrees/src/index.ts'

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(here, '..')
const resultsDir = join(repoRoot, 'eval-results')

interface Scenario {
  id: string
  /** Repository the task runs in, relative to the repository root. */
  repo: string
  /** What the agent is asked to do. */
  task: string
  /** Commands that must pass after the agent finishes. */
  verify: string[]
  /** Files copied in after the agent finishes, to grade the work itself. */
  hidden?: Array<{
    /** Where the file lives in this repository. */
    from: string
    /** Where it goes in the prepared repository. */
    to: string
  }>
  /** Commands that grade the work, run after the hidden files are in place. */
  hiddenVerify?: string[]
  /** How long the agent gets. */
  timeoutMinutes?: number
}

/** The two things being compared: the same repository, with and without the artifacts. */
const VARIANTS = ['bare', 'anvil'] as const
type Variant = (typeof VARIANTS)[number]

/** Where the task is written inside the prepared repository. */
const TASK_FILE = '.anvil-eval-task.md'

interface RunResult {
  ok: boolean
  code: number | null
  stdout: string
  stderr: string
  timedOut: boolean
  /** stdout and stderr together, trimmed to what a report can hold. */
  output: string
}

interface ScenarioResult {
  scenario: string
  variant: Variant
  /** The visible verifier passed. */
  verified: boolean
  /** The hidden verifier passed. */
  hiddenVerified: boolean | null
  /** What the work cost, when the ledger knows. */
  costUsd: number | null
  tokens: number | null
  durationMs: number
  /** The agent's own words, so a failure can be read rather than guessed at. */
  transcript: string
  /** What the verifier said, so a failure can be read rather than guessed at. */
  verifyOutput?: string
  error?: string
}

const args = process.argv.slice(2)
const dryRun = args.includes('--dry-run')
const only = flagValue('--scenario')
const model = process.env.ANVIL_EVAL_MODEL
const enabled = process.env.ANVIL_EVAL === '1'

// A dry run costs nothing, so it is not gated. Everything else is.
if (!enabled && !dryRun) {
  console.log('The eval harness is opt-in: it runs an agent against a model.')
  console.log('Run it with: ANVIL_EVAL=1 npm run eval')
  console.log('Preview what it would do with: npm run eval -- --dry-run')
  process.exit(0)
}

const scenarios = loadScenarios()
const selected = only === null ? scenarios : scenarios.filter((s) => s.id === only)
if (selected.length === 0) {
  console.error(`No scenario matched ${only ?? '(nothing)'}`)
  process.exit(1)
}

if (dryRun) {
  for (const scenario of selected) {
    console.log(`${scenario.id}`)
    console.log(`  repo      ${scenario.repo}`)
    console.log(`  task      ${scenario.task}`)
    console.log(`  verify    ${scenario.verify.join('; ')}`)
    console.log(`  hidden    ${(scenario.hidden ?? []).map((h) => `${h.from} -> ${h.to}`).join('; ') || '(none)'}`)
    console.log(`  variants  ${VARIANTS.join(', ')}`)
    console.log(`  model     ${model ?? '(opencode default)'}`)
  }
  process.exit(0)
}

const results: ScenarioResult[] = []
for (const scenario of selected) {
  for (const variant of VARIANTS) {
    results.push(await runScenario(scenario, variant))
  }
}

writeReport(results)
printSummary(results)

// The exit code is the verdict: if the harness itself ran, the agent's work is not the
// harness's exit code. A failed run is reported, not hidden.
process.exit(0)

// ---------------------------------------------------------------------------
// The run
// ---------------------------------------------------------------------------

async function runScenario(scenario: Scenario, variant: Variant): Promise<ScenarioResult> {
  const workdir = mkdtempSync(join(tmpdir(), `anvil-eval-${scenario.id}-${variant}-`))
  const started = Date.now()
  const result: ScenarioResult = {
    scenario: scenario.id,
    variant,
    verified: false,
    hiddenVerified: null,
    costUsd: null,
    tokens: null,
    durationMs: 0,
    transcript: '',
  }

  try {
    prepareRepo(scenario, workdir)

    if (variant === 'anvil') {
      // The whole point of the comparison: the artifacts anvil derives, applied for real.
      // Staging comes first, because `--apply` writes what `init` staged and refuses
      // without it.
      const staged = await run('node', [anvilCli(), 'init'], workdir)
      if (!staged.ok) {
        result.error = `anvil init failed: ${staged.stderr.trim() || staged.stdout.trim()}`
        return result
      }
      const applied = await run('node', [anvilCli(), 'init', '--apply'], workdir)
      if (!applied.ok) {
        result.error = `anvil init --apply failed: ${applied.stderr.trim() || applied.stdout.trim()}`
        return result
      }
    }

    // The task goes in a file and the agent is told to read it, for the same reason the
    // crew does it: a task is prose, and prose contains characters that Windows cmd
    // would interpret -- backticks, ampersands, quotes. Refusing to run is the right
    // behaviour for anvil's safety check, and the answer is not to pass prose as argv.
    const taskFile = join(workdir, TASK_FILE)
    writeFileSync(taskFile, `${scenario.task}\n`, 'utf8')
    // `--auto` because the run is unattended and the workdir is a throwaway copy: a
    // permission prompt is a hang, and a hang is not a result.
    const agentArgs = ['run', '--dir', workdir, '--auto']
    if (model !== undefined && model !== '') agentArgs.push('--model', model)
    agentArgs.push(`Read ${TASK_FILE} and follow every instruction in it exactly.`)
    const agent = await run('opencode', agentArgs, workdir, {
      timeoutMs: (scenario.timeoutMinutes ?? 10) * 60_000,
    })
    result.transcript = `${agent.stdout}\n${agent.stderr}`.trim()
    if (agent.timedOut) {
      result.error = 'the agent timed out'
    } else if (!agent.ok) {
      result.error = `the agent exited with code ${agent.code ?? '?'}`
    }

    const visible = await runAll(scenario.verify, workdir)
    result.verified = visible.every((r) => r.ok)
    result.verifyOutput = visible.map((r) => r.output).join('\n')

    if (scenario.hidden !== undefined && scenario.hidden.length > 0) {
      for (const file of scenario.hidden) {
        cpSync(join(repoRoot, file.from), join(workdir, file.to), { recursive: true })
      }
      const hidden = await runAll(scenario.hiddenVerify ?? [], workdir)
      result.hiddenVerified = hidden.every((r) => r.ok)
    }

    const session = readAgentSession(workdir)
    if (session !== null) {
      const cost = await lookupSessionCosts([session.sessionId])
      const entry = cost.sessions.get(session.sessionId)
      result.costUsd = entry?.costUsd ?? null
      result.tokens = entry?.tokens ?? null
    }
  } catch (err) {
    result.error = err instanceof Error ? err.message : String(err)
  } finally {
    result.durationMs = Date.now() - started
    // `maxRetries` matters on Windows: git checks out its object files read-only, and
    // removing a read-only file fails with EPERM until the permission is relaxed. Node
    // retries that, but only when it is told to. A worktree the agent still holds open
    // is reported against this run rather than allowed to abort the whole harness: the
    // result is the thing the harness exists to produce.
    try {
      rmSync(workdir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
    } catch (err) {
      const note = `could not remove ${workdir}: ${err instanceof Error ? err.message : String(err)}`
      result.error = result.error === undefined ? note : `${result.error}; ${note}`
    }
  }

  return result
}

/** Copy the scenario's repository into a fresh git repository the agent can work in. */
function prepareRepo(scenario: Scenario, workdir: string): void {
  const source = join(repoRoot, scenario.repo)
  if (!existsSync(source)) throw new Error(`scenario repository not found: ${scenario.repo}`)
  cpSync(source, workdir, { recursive: true })
  runSync('git', ['init', '--initial-branch=main'], workdir)
  runSync('git', ['add', '-A'], workdir)
  runSync(
    'git',
    ['-c', 'user.email=eval@anvil.local', '-c', 'user.name=anvil eval', 'commit', '-m', 'initial'],
    workdir,
  )
}

/** The CLI to apply the artifacts with: the built bundle when it exists, the source otherwise. */
function anvilCli(): string {
  const bundle = join(repoRoot, 'packages', 'cli', 'dist', 'cli.js')
  if (existsSync(bundle)) return bundle
  return join(repoRoot, 'packages', 'cli', 'src', 'main.ts')
}

// ---------------------------------------------------------------------------
// Process helpers
// ---------------------------------------------------------------------------

async function runAll(commands: string[], cwd: string): Promise<RunResult[]> {
  const out: RunResult[] = []
  for (const command of commands) {
    // The same tokenizer the crew uses: a verify command is one string, and splitting it
    // on spaces passes quotes through literally.
    const [bin, ...rest] = tokenizeCommand(command)
    if (bin === undefined) continue
    out.push(await run(bin, rest, cwd, { timeoutMs: 5 * 60_000 }))
  }
  return out
}

async function run(bin: string, args: string[], cwd: string, options: { timeoutMs?: number } = {}): Promise<RunResult> {
  // `spawnArgv` rather than `spawn(bin, ...)`: the npm-installed `opencode` is a `.CMD`
  // shim on Windows, and Node's spawn does not resolve PATHEXT.
  const { file, args: argv } = spawnArgv(bin, args, { env: process.env, platform: process.platform })
  const needsVerbatim = process.platform === 'win32' && file.toLowerCase().endsWith('cmd.exe')

  return await new Promise<RunResult>((resolvePromise) => {
    const child = spawn(file, argv, {
      cwd,
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
      ...(needsVerbatim ? { windowsVerbatimArguments: true } : {}),
    })
    let stdout = ''
    let stderr = ''
    let timedOut = false
    child.stdout?.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8')
    })
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8')
    })
    const timer = setTimeout(
      () => {
        timedOut = true
        killTree(child)
      },
      options.timeoutMs ?? 10 * 60_000,
    )
    child.on('error', (err) => {
      clearTimeout(timer)
      const text = `${stderr}${err.message}`
      resolvePromise({ ok: false, code: null, stdout, stderr: text, timedOut, output: trim(text) })
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      resolvePromise({
        ok: code === 0 && !timedOut,
        code,
        stdout,
        stderr,
        timedOut,
        output: trim(`${stdout}\n${stderr}`),
      })
    })
  })
}

/**
 * Stop a timed-out process and its children.
 *
 * On Windows `child.kill()` terminates the cmd.exe shim, not the agent running under it.
 * The orphan keeps the worktree open and the next run contends with it, so the timeout
 * has to walk the tree. `taskkill /T` is the only way to do that without a job object.
 */
function killTree(child: ChildProcess): void {
  if (process.platform === 'win32' && child.pid !== undefined) {
    spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' })
    return
  }
  child.kill()
}

/**
 * Run a command and wait for it, for the setup steps where the result is not graded.
 *
 * Synchronous on purpose: a setup step that is still running holds the working directory
 * open, and Windows refuses to remove a directory that is somebody's current directory.
 */
function runSync(bin: string, args: string[], cwd: string): void {
  const { file, args: argv } = spawnArgv(bin, args, { env: process.env, platform: process.platform })
  const needsVerbatim = process.platform === 'win32' && file.toLowerCase().endsWith('cmd.exe')
  spawnSync(file, argv, {
    cwd,
    env: process.env,
    stdio: 'ignore',
    ...(needsVerbatim ? { windowsVerbatimArguments: true } : {}),
  })
}

// ---------------------------------------------------------------------------
// The report
// ---------------------------------------------------------------------------

function writeReport(results: ScenarioResult[]): void {
  mkdirSync(resultsDir, { recursive: true })
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const path = join(resultsDir, `eval-${stamp}.json`)
  writeFileSync(path, `${JSON.stringify({ generatedAt: new Date().toISOString(), results }, null, 2)}\n`, 'utf8')
  console.log(`\nReport written to ${path}`)
}

function printSummary(results: ScenarioResult[]): void {
  console.log('')
  console.log('scenario              variant  verified  hidden  cost      time')
  console.log('--------------------  -------  --------  ------  --------  ------')
  for (const r of results) {
    const cost = r.costUsd === null ? '-' : `$${r.costUsd.toFixed(2)}`
    console.log(
      [
        r.scenario.padEnd(20),
        r.variant.padEnd(7),
        (r.verified ? 'yes' : 'no').padEnd(8),
        (r.hiddenVerified === null ? '-' : r.hiddenVerified ? 'yes' : 'no').padEnd(6),
        cost.padEnd(8),
        `${Math.round(r.durationMs / 1000)}s`,
      ].join('  '),
    )
    if (r.error !== undefined) console.log(`  error: ${r.error}`)
  }
  console.log('')
  console.log('The comparison that matters is the same row twice: `bare` against `anvil`.')
}

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

function loadScenarios(): Scenario[] {
  const path = join(repoRoot, 'eval', 'scenarios.json')
  const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'))
  const list = (parsed as { scenarios?: unknown }).scenarios
  if (!Array.isArray(list)) throw new Error('eval/scenarios.json has no `scenarios` list')
  return list as Scenario[]
}

function flagValue(flag: string): string | null {
  const index = args.indexOf(flag)
  if (index === -1) return null
  return args[index + 1] ?? null
}

/** Trim a command's output to what a report can hold. */
function trim(text: string): string {
  const lines = text.split('\n').filter((l) => l.trim() !== '')
  return lines.slice(0, 40).join('\n')
}
