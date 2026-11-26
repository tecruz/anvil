/**
 * Opt-in runner for the verified-patch study.
 *
 * `--preflight` validates every manifest task without calling a model. `--run` refuses to
 * start unless the maintainer has committed an approval whose hash matches the exact run
 * spec (task list, model, seed, repetitions, timeout, config and Anvil commit). There is no
 * path from a preflight or a dry run to a model call without that approval.
 */
import { spawn } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
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
  workdir: string
}

async function runAgent(options: {
  cli: string
  workdir: string
  task: VerifiedPatchTask
  config: RunConfig
  brokerEnv: NodeJS.ProcessEnv
}): Promise<void> {
  writeFileSync(join(options.workdir, TASK_FILE), `${options.task.task}\n`, 'utf8')
  const env: NodeJS.ProcessEnv = { ...process.env }
  for (const key of Object.keys(env)) {
    if (key.toLowerCase() === 'path') delete env[key]
  }
  env.PATH = options.brokerEnv.Path ?? options.brokerEnv.PATH ?? ''
  if (options.config.config !== null) {
    env.OPENCODE_CONFIG = options.config.config
    const base = join(options.config.config, '..')
    env.XDG_CONFIG_HOME = join(base, 'config')
    env.XDG_DATA_HOME = join(base, 'data')
    env.XDG_CACHE_HOME = join(base, 'cache')
    env.XDG_STATE_HOME = join(base, 'state')
  }
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
  await new Promise<void>((resolve, reject) => {
    const child = spawn('opencode', args, { cwd: options.workdir, env })
    let stderr = ''
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8')
    })
    child.on('error', reject)
    child.on('close', () => resolve())
    void stderr
  })
}

export async function runStudy(repoRoot: string, manifest: Manifest, config: RunConfig): Promise<string> {
  if (process.env.ANVIL_EVAL !== '1') {
    throw new Error('the study is opt-in: set ANVIL_EVAL=1')
  }
  const specHash = runSpecHash(repoRoot, manifest, config)
  const approvedBy = requireApproval(repoRoot, specHash)
  const runId = randomUUID()
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
        try {
          await runAgent({ cli: config.cli, workdir, task, config, brokerEnv: handle.broker.env })
        } finally {
          await handle.broker.close()
        }
        const grade = gradeVerifiedPatch({
          task,
          repoRoot,
          baseRoot: join(repoRoot, task.repo),
          armRoot: workdir,
          executions: handle.broker.executions,
          fault: handle.broker.fault,
          started: true,
        })
        results.push({
          task: task.id,
          arm,
          repetition,
          grade: grade.kind,
          reasons: grade.reasons,
          workdir,
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
  const dest = join(repoRoot, 'eval-results', 'pilots', runId)
  mkdirSync(dest, { recursive: true })
  writeFileSync(join(dest, 'run.json'), `${JSON.stringify(record, null, 2)}\n`)
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
