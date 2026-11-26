/**
 * Opt-in runner for the verified-patch study.
 *
 * `--preflight` validates every manifest task without calling a model. `--run` refuses to
 * start unless the maintainer has committed an approval whose hash matches the exact run
 * spec (task list, model, seed, repetitions, timeout, config and Anvil commit). There is no
 * path from a preflight or a dry run to a model call without that approval.
 */
import { type ChildProcess, spawn, spawnSync } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  type GradeKind,
  gradeVerifiedPatch,
  hiddenAcceptancePassed,
  openArm,
  stageAnvilContext,
  type VerifiedPatchTask,
} from './verified-patch.ts'

const TASK_FILE = '.anvil-study-task.md'
const MANIFEST = 'eval/verified-patch-tasks.json'
const APPROVAL = 'eval/verified-patch-approval.json'

interface Manifest {
  schemaVersion: number
  tasks: VerifiedPatchTask[]
}

interface RunConfig {
  model: string
  repetitions: number
  timeoutMinutes: number
  seed: string
  config: string | null
  cli: string
}

export function loadManifest(repoRoot: string): Manifest {
  const parsed = JSON.parse(readFileSync(join(repoRoot, MANIFEST), 'utf8')) as Partial<Manifest>
  if (parsed.schemaVersion !== 1 || !Array.isArray(parsed.tasks) || parsed.tasks.length === 0) {
    throw new Error(`${MANIFEST} must declare schemaVersion 1 with at least one task`)
  }
  for (const task of parsed.tasks) {
    for (const field of [
      'id',
      'repo',
      'task',
      'verifyCommand',
      'verifyScript',
      'hiddenAcceptance',
      'referenceFix',
      'fixTarget',
    ] as const) {
      if (typeof task[field] !== 'string') throw new Error(`task is missing ${field}`)
    }
    if (!Array.isArray(task.acceptedCommands) || !Array.isArray(task.inScope)) {
      throw new Error(`task ${task.id} must declare acceptedCommands and inScope`)
    }
  }
  return parsed as Manifest
}

export interface PreflightResult {
  id: string
  hiddenFailsOnBase: boolean
  hiddenPassesWithFix: boolean
  ok: boolean
}

/** No model, no network: copy the pinned task repo and prove the acceptance test discriminates. */
export function preflightTask(repoRoot: string, task: VerifiedPatchTask): PreflightResult {
  const workspace = mkdtempSync(join(tmpdir(), `verified-patch-preflight-${task.id}-`))
  try {
    cpSync(join(repoRoot, task.repo), workspace, { recursive: true })
    const hiddenFailsOnBase = !hiddenAcceptancePassed(task, repoRoot, workspace)
    writeFileSync(join(workspace, task.fixTarget), readFileSync(join(repoRoot, task.referenceFix)))
    const hiddenPassesWithFix = hiddenAcceptancePassed(task, repoRoot, workspace)
    return {
      id: task.id,
      hiddenFailsOnBase,
      hiddenPassesWithFix,
      ok: hiddenFailsOnBase && hiddenPassesWithFix,
    }
  } finally {
    rmSync(workspace, { recursive: true, force: true })
  }
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex')
}

/** Hash a file's bytes when it exists; a missing file is reported as null, never as empty. */
function fileDigest(path: string): string | null {
  if (!existsSync(path)) return null
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

/**
 * Grader and CLI bytes are part of the run spec: a "verified patch" result produced by a
 * different grader is a different measurement and must not inherit an earlier approval.
 */
export function graderDigests(repoRoot: string, cli: string): Record<string, string | null> {
  return {
    runner: fileDigest(join(repoRoot, 'scripts/verified-patch-run.ts')),
    grader: fileDigest(join(repoRoot, 'scripts/verified-patch.ts')),
    broker: fileDigest(join(repoRoot, 'scripts/eval-check-broker.ts')),
    cli: fileDigest(cli),
  }
}

export function runSpecHash(repoRoot: string, manifest: Manifest, config: RunConfig): string {
  const taskDigests = manifest.tasks.map((task) =>
    sha256(
      JSON.stringify({
        id: task.id,
        repo: task.repo,
        task: task.task,
        verifyCommand: task.verifyCommand,
        declared: task.declared ?? null,
        inScope: task.inScope,
        protected: task.protected,
        hiddenAcceptance: task.hiddenAcceptance,
        referenceFix: task.referenceFix,
      }),
    ),
  )
  return sha256(
    JSON.stringify({
      schemaVersion: 1,
      manifestHash: sha256(readFileSync(join(repoRoot, MANIFEST), 'utf8')),
      anvilCommit: process.env.ANVIL_COMMIT ?? null,
      model: config.model,
      repetitions: config.repetitions,
      timeoutMinutes: config.timeoutMinutes,
      seed: config.seed,
      configHash: config.config === null ? null : sha256(readFileSync(config.config, 'utf8')),
      graderDigests: graderDigests(repoRoot, config.cli),
      taskDigests,
    }),
  )
}

export function requireApproval(repoRoot: string, specHash: string): string {
  const path = join(repoRoot, APPROVAL)
  if (!existsSync(path)) {
    throw new Error(`no approval file at ${APPROVAL}; prepare and approve this exact run first`)
  }
  const approval = JSON.parse(readFileSync(path, 'utf8')) as {
    schemaVersion?: number
    specHash?: string
    approvedBy?: string
  }
  if (approval.schemaVersion !== 1 || approval.specHash !== specHash) {
    throw new Error(`${APPROVAL} does not match this run spec; a fresh decision is required`)
  }
  if (typeof approval.approvedBy !== 'string' || approval.approvedBy.trim() === '') {
    throw new Error(`${APPROVAL} must name the approver`)
  }
  return approval.approvedBy
}

interface ArmResult {
  task: string
  arm: 'plain' | 'anvil'
  repetition: number
  grade: GradeKind
  reasons: string[]
  /** Bounded failure reasons with host paths and KEY=value secrets removed. */
  detail: string | null
}

/** Keep failure reasons useful without publishing host paths or environment values. */
function redact(value: string): string {
  let out = value.split(repoRootPath()).join('<repo>')
  out = out.replace(/[A-Za-z]:\\Users\\[^\\\s]+/g, '<home>')
  out = out.replace(/\b([A-Z][A-Z0-9_]{2,}=)[^\s]+/g, '$1<redacted>')
  return out.slice(0, 400)
}

function repoRootPath(): string {
  return fileURLToPath(new URL('../', import.meta.url))
}

function writeCheckpoint(dest: string, name: string, value: unknown): void {
  const path = join(dest, name)
  const temp = `${path}.${process.pid}.tmp`
  writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`)
  renameSync(temp, path)
}

/**
 * Give the agent only what it needs. Inheriting the whole parent environment lets a task
 * read unrelated credentials from the host; an allowlist keeps provider access while removing
 * shell exports, proxies and CI secrets that the study must not depend on.
 */
export function isolatedEnv(brokerEnv: NodeJS.ProcessEnv, configPath: string | null): NodeJS.ProcessEnv {
  const allowed = new Set([
    'PATH',
    'HOME',
    'USERPROFILE',
    'TEMP',
    'TMP',
    'TMPDIR',
    'SYSTEMROOT',
    'WINDIR',
    'LANG',
    'LC_ALL',
    'SSL_CERT_FILE',
    'SSL_CERT_DIR',
    'NODE_EXTRA_CA_CERTS',
    'ANVIL_EVAL',
    'ANVIL_DECLARED_BIN',
  ])
  const env: NodeJS.ProcessEnv = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined) continue
    const upper = key.toUpperCase()
    if (
      allowed.has(upper) ||
      upper.startsWith('XDG_') ||
      upper.startsWith('OPENCODE_') ||
      upper.startsWith('OPENROUTER_')
    ) {
      env[key] = value
    }
  }
  // The broker's PATH carries the shim that captures repository checks. Its own variables
  // must survive even when they are outside the general allowlist.
  Object.assign(env, brokerEnv)
  for (const name of ['NODE_OPTIONS', 'NODE_PATH', 'NODE_TEST_CONTEXT']) delete env[name]
  if (configPath !== null) {
    env.OPENCODE_CONFIG = configPath
    const base = join(configPath, '..')
    env.XDG_CONFIG_HOME = join(base, 'config')
    env.XDG_DATA_HOME = join(base, 'data')
    env.XDG_CACHE_HOME = join(base, 'cache')
    env.XDG_STATE_HOME = join(base, 'state')
  }
  return env
}

/** Kill the agent and anything it spawned; a timed-out child must not keep running the task. */
function killTree(child: ChildProcess): void {
  const pid = child.pid
  if (pid === undefined) {
    child.kill('SIGKILL')
    return
  }
  if (process.platform === 'win32') {
    const result = spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' })
    if (result.status !== 0) child.kill('SIGKILL')
    return
  }
  try {
    process.kill(-pid, 'SIGKILL')
  } catch {
    child.kill('SIGKILL')
  }
}

async function runAgent(options: {
  workdir: string
  task: VerifiedPatchTask
  config: RunConfig
  brokerEnv: NodeJS.ProcessEnv
}): Promise<{ timedOut: boolean; detail: string | null }> {
  writeFileSync(join(options.workdir, TASK_FILE), `${options.task.task}\n`, 'utf8')
  const env = isolatedEnv(options.brokerEnv, options.config.config)
  const args = [
    'run',
    '--standalone',
    '--auto',
    '--format',
    'json',
    '--model',
    options.config.model,
    `Read ${TASK_FILE} and follow every instruction in it exactly.`,
  ]
  let timedOut = false
  await new Promise<void>((resolve, reject) => {
    const child = spawn('opencode', args, {
      cwd: options.workdir,
      env,
      detached: process.platform !== 'win32',
    })
    const timer = setTimeout(() => {
      timedOut = true
      killTree(child)
    }, Math.max(1, options.config.timeoutMinutes) * 60_000)
    child.on('error', (error: Error) => {
      clearTimeout(timer)
      reject(error)
    })
    child.on('close', () => {
      clearTimeout(timer)
      resolve()
    })
  })
  return {
    timedOut,
    detail: timedOut ? `agent exceeded ${options.config.timeoutMinutes} minute(s)` : null,
  }
}

export async function runStudy(repoRoot: string, manifest: Manifest, config: RunConfig): Promise<string> {
  if (process.env.ANVIL_EVAL !== '1') {
    throw new Error('the study is opt-in: set ANVIL_EVAL=1')
  }
  const specHash = runSpecHash(repoRoot, manifest, config)
  const approvedBy = requireApproval(repoRoot, specHash)
  const runId = randomUUID()
  const dest = join(repoRoot, 'eval-results', 'pilots', runId)
  const armsDir = join(dest, 'arms')
  mkdirSync(armsDir, { recursive: true })
  const results: ArmResult[] = []
  for (const [index, task] of manifest.tasks.entries()) {
    for (let repetition = 0; repetition < config.repetitions; repetition++) {
      const arms: Array<'plain' | 'anvil'> = (index + repetition) % 2 === 0 ? ['plain', 'anvil'] : ['anvil', 'plain']
      for (const arm of arms) {
        const workdir = mkdtempSync(join(tmpdir(), `verified-patch-${task.id}-${arm}-`))
        cpSync(join(repoRoot, task.repo), workdir, { recursive: true })
        if (arm === 'anvil') {
          const staged = stageAnvilContext({ cli: config.cli, workdir })
          if (!staged.ok) throw new Error(`anvil staging failed for ${task.id}: ${staged.error}`)
        }
        const handle = await openArm({
          task,
          repoRoot,
          baseRoot: join(repoRoot, task.repo),
          workdir,
        })
        let timedOut = false
        let agentDetail: string | null = null
        try {
          const outcome = await runAgent({ workdir, task, config, brokerEnv: handle.broker.env })
          timedOut = outcome.timedOut
          agentDetail = outcome.detail
        } finally {
          await handle.broker.close()
        }
        const fault = timedOut ? 'agent timeout' : handle.broker.fault
        const grade = gradeVerifiedPatch({
          task,
          repoRoot,
          baseRoot: join(repoRoot, task.repo),
          armRoot: workdir,
          executions: handle.broker.executions,
          fault,
          started: true,
        })
        const result: ArmResult = {
          task: task.id,
          arm,
          repetition,
          grade: grade.kind,
          reasons: grade.reasons.map(redact),
          detail: agentDetail === null ? null : redact(agentDetail),
        }
        results.push(result)
        // Each arm is written as it settles, so an interrupted run keeps its measured work.
        writeCheckpoint(armsDir, `${task.id}-${arm}-r${repetition}.json`, {
          schemaVersion: 1,
          runId,
          specHash,
          ...result,
        })
      }
    }
  }
  const record = {
    schemaVersion: 1,
    runId,
    specHash,
    approvedBy,
    model: config.model,
    seed: config.seed,
    repetitions: config.repetitions,
    tasks: manifest.tasks.map((task) => task.id),
    results,
  }
  writeCheckpoint(dest, 'run.json', record)
  if (config.config !== null) {
    writeFileSync(join(dest, 'opencode-config.json'), readFileSync(config.config))
  }
  return runId
}

function flagValue(flag: string, args: readonly string[]): string | null {
  const at = args.indexOf(flag)
  return at === -1 || at + 1 >= args.length ? null : (args[at + 1] ?? null)
}

export async function main(args: readonly string[]): Promise<number> {
  const repoRoot = fileURLToPath(new URL('../', import.meta.url))
  const manifest = loadManifest(repoRoot)
  if (args.includes('--preflight')) {
    const results = manifest.tasks.map((task) => preflightTask(repoRoot, task))
    const output = { schemaVersion: 1, results }
    writeFileSync(
      join(repoRoot, 'eval-results', 'verified-patch-preflight.json'),
      `${JSON.stringify(output, null, 2)}\n`,
    )
    for (const result of results) {
      console.log(
        `${result.id}: base=${result.hiddenFailsOnBase} fix=${result.hiddenPassesWithFix} ${result.ok ? 'ok' : 'FAILED'}`,
      )
    }
    return results.every((result) => result.ok) ? 0 : 1
  }
  if (args.includes('--run')) {
    const config: RunConfig = {
      model: flagValue('--model', args) ?? 'opencode/hy4-flash-free',
      repetitions: Number(flagValue('--repetitions', args) ?? '1'),
      timeoutMinutes: Number(flagValue('--timeout', args) ?? '5'),
      seed: flagValue('--seed', args) ?? 'verified-patch-v1',
      config: flagValue('--config', args),
      cli: join(repoRoot, 'packages/cli/dist/cli.js'),
    }
    const runId = await runStudy(repoRoot, manifest, config)
    console.log(`run ${runId} retained under eval-results/pilots/${runId}`)
    return 0
  }
  console.log('usage: node scripts/verified-patch-run.ts --preflight | --run [flags]')
  return 2
}

if (process.argv[1] !== undefined && import.meta.url.endsWith(process.argv[1].replaceAll('\\', '/'))) {
  process.exitCode = await main(process.argv.slice(2))
}
