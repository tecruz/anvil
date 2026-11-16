/**
 * The hermetic failure rehearsal's checks.
 *
 * The workflow used to carry these as inline heredocs, where only a dispatch could exercise
 * them. Keeping them here lets the ordinary suite test the exact code the rehearsal runs,
 * and removes the shell-specific status handling from the workflow.
 */

import { spawnSync } from 'node:child_process'
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

import { checkpointFileName, type EvalRunRecord } from '../packages/cli/src/eval-gate.ts'

/** The diagnostic the tampered `tiny-code-change/bare` result must produce. */
export const EXPECTED_GATE_DIAGNOSTIC = 'tiny-code-change: a run did not pass the visible verifier'

export interface GateCheckOutcome {
  status: number | null
  output: string
}

export interface GateCheckOptions {
  /** Inject the gate result so tests do not have to run the harness. */
  run?: () => GateCheckOutcome
  logPath?: string
  /** Receives the gate output when the assertion fails; defaults to stderr. */
  report?: (output: string) => void
}

/** Run the committed hermetic gate and capture both streams in one log. */
function runEvalCheck(): GateCheckOutcome {
  const result = spawnSync('npm', ['run', 'eval:check'], {
    encoding: 'utf8',
    shell: process.platform === 'win32',
  })
  const output = `${result.stdout ?? ''}${result.stderr ?? ''}`
  if (result.error !== undefined) {
    return { status: null, output: `${output}${result.error.message}\n` }
  }
  return { status: result.status, output }
}

/**
 * Require the gate to reject the tampering for the reason we caused it.
 *
 * A crash, a missing command or any other non-zero exit is not proof that the gate rejected
 * the changed result, so both the normal failure code and its diagnostic are required.
 */
export function assertGateRejection(options: GateCheckOptions = {}): GateCheckOutcome {
  const logPath = options.logPath ?? 'eval-results/gate-rejection.log'
  const report =
    options.report ??
    ((output: string): void => {
      process.stderr.write(output.endsWith('\n') ? output : `${output}\n`)
    })
  const outcome = (options.run ?? runEvalCheck)()
  writeFileSync(logPath, outcome.output)
  if (outcome.status !== 1) {
    report(outcome.output)
    throw new Error(`expected the hermetic gate to exit 1 for tampered evidence, got ${outcome.status}.`)
  }
  if (!outcome.output.includes(EXPECTED_GATE_DIAGNOSTIC)) {
    report(outcome.output)
    throw new Error('the gate failed without the expected tampered-evidence diagnostic.')
  }
  console.log('The hermetic gate rejected the tampered evidence with the expected diagnostic.')
  return outcome
}

export interface RehearsalArtifacts {
  files: number
  checkpoints: number
}

/**
 * Verify every file the retention claim depends on.
 *
 * `upload-artifact`'s `if-no-files-found` only catches the case where no file matches. A
 * count is not enough either: each checkpoint has to parse and name the run result at the
 * path the harness uses for it.
 */
export function validateRehearsalArtifacts(root = process.cwd()): RehearsalArtifacts {
  const resolve = (relative: string): string => join(root, ...relative.split('/'))
  const required = ['eval-results/failure-rehearsal.json', 'eval-results/gate-rejection.log', 'eval-results/run.json']
  for (const relative of required) {
    const file = resolve(relative)
    if (!existsSync(file) || statSync(file).size === 0) {
      throw new Error(`missing or empty required artifact: ${relative}`)
    }
  }

  const rehearsal = JSON.parse(readFileSync(resolve(required[0] as string), 'utf8')) as {
    expectedGate?: unknown
    runId?: unknown
  }
  const run = JSON.parse(readFileSync(resolve(required[2] as string), 'utf8')) as EvalRunRecord
  if (rehearsal.expectedGate !== 'reject' || rehearsal.runId !== run.runId) {
    throw new Error('rehearsal record does not describe this run')
  }

  const archiveRelative = `eval-results/runs/${run.runId}.json`
  const archive = resolve(archiveRelative)
  if (!existsSync(archive)) throw new Error(`missing run archive: ${archiveRelative}`)
  const archived = JSON.parse(readFileSync(archive, 'utf8')) as { runId?: unknown }
  if (archived.runId !== run.runId) throw new Error('run archive names another run')

  const checkpointDirRelative = `eval-results/checkpoints/${run.runId}`
  const checkpointDir = resolve(checkpointDirRelative)
  if (!existsSync(checkpointDir)) throw new Error(`missing checkpoints: ${checkpointDirRelative}`)
  const checkpoints = readdirSync(checkpointDir).filter((entry) => entry.endsWith('.json'))
  if (checkpoints.length !== run.runKeys.length) {
    throw new Error(`expected ${run.runKeys.length} checkpoints, found ${checkpoints.length}`)
  }
  if (run.results.length !== run.runKeys.length) {
    throw new Error(`run record has ${run.results.length} results for ${run.runKeys.length} run keys`)
  }

  const resultKeys = run.results
    .map((result) => `${result.scenario}/${result.variant}/${result.model}/${result.repetition}`)
    .sort()
  const declaredKeys = [...run.runKeys].sort()
  if (resultKeys.some((key, index) => key !== declaredKeys[index])) {
    throw new Error('run record results do not cover the declared run keys')
  }

  const expected = new Set<string>()
  for (const result of run.results) {
    const name = checkpointFileName(result)
    if (expected.has(name)) throw new Error(`duplicate run result for checkpoint ${name}`)
    expected.add(name)
    const file = join(checkpointDir, name)
    if (!existsSync(file) || statSync(file).size === 0) {
      throw new Error(`missing or empty checkpoint: ${file}`)
    }
    const checkpoint = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>
    if (
      checkpoint.schemaVersion !== run.schemaVersion ||
      checkpoint.scenario !== result.scenario ||
      checkpoint.variant !== result.variant ||
      (checkpoint.model ?? null) !== (result.model ?? null) ||
      checkpoint.repetition !== result.repetition
    ) {
      throw new Error(`checkpoint ${file} does not describe the run result it names`)
    }
  }
  for (const name of checkpoints) {
    if (!expected.has(name)) throw new Error(`unexpected checkpoint: ${join(checkpointDir, name)}`)
  }

  console.log(`Validated ${required.length} files, the run archive and ${checkpoints.length} checkpoints.`)
  return { files: required.length, checkpoints: checkpoints.length }
}

function main(): void {
  const command = process.argv[2]
  try {
    if (command === 'assert-gate') {
      assertGateRejection()
      return
    }
    if (command === 'validate-artifacts') {
      validateRehearsalArtifacts()
      return
    }
    console.error('usage: node scripts/eval-rehearsal.ts <assert-gate|validate-artifacts>')
    process.exit(2)
  } catch (error) {
    console.error(`::error::${error instanceof Error ? error.message : String(error)}`)
    process.exit(1)
  }
}

// Only run when executed directly, so the checks can be imported by tests.
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main()
}
