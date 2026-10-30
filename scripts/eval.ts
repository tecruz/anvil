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
 * The harness covers a small matrix on purpose: two repository sizes, and two ways to
 * spend a turn. A code-change scenario asks the agent to write something a hidden test
 * grades; a verify-only scenario asks it to run the repository's own checks and report.
 * Both halves matter, because context that helps a model write code can still fail to
 * help it understand a repository it is only reading.
 *
 * A real run is behind `ANVIL_EVAL=1`, because it spends tokens. Three modes are not:
 * `--list` prints the matrix, `--dry-run` prints what a run would do, and `--check`
 * compares the latest summary with the checked-in baseline. `--fake-agent` is the
 * hermetic path: it applies a canned answer instead of calling a model, which is how the
 * harness and the gate are tested without a network or a quota.
 *
 * Run with: `ANVIL_EVAL=1 npm run eval`
 */

import { type ChildProcess, execFileSync, spawn, spawnSync } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import {
  appendFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { lookupSessionCosts } from '../packages/cli/src/cost.ts'
import {
  allDeclaredCompleted,
  checkEvalGate,
  checkpointFileName,
  checkRunRecord,
  checkRunRecordCompatibility,
  EVAL_SCHEMA_VERSION,
  type EvalBaseline,
  type EvalBaselineScenario,
  type EvalLatest,
  type EvalModel,
  type EvalModelRole,
  type EvalResultSummary,
  type EvalRunRecord,
  type EvalRunRecordAttempt,
  type EvalRunRecordResult,
  type EvalScenario,
  hashImplementation,
  hashScenario,
  hashScenarioSource,
  latestAttemptState,
  parseBaseline,
  parseLatest,
  parseRunRecord,
  readCheckpointDirectory,
  readJsonFile,
  reconcileRunRecord,
  recordFixtureProblem,
  resultKey,
  solutionFiles,
  validateScenarioMatrix,
} from '../packages/cli/src/eval-gate.ts'
import { tokenizeCommand } from '../packages/core/src/args.ts'
import { probeCommandVersion, spawnArgv } from '../packages/core/src/exec.ts'
import { buildProfile } from '../packages/profile/src/index.ts'
import { readAgentSession } from '../packages/worktrees/src/index.ts'

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(here, '..')
const resultsDir = join(repoRoot, 'eval-results')
const rawDir = join(resultsDir, 'raw')
const latestPath = join(resultsDir, 'latest.json')
const baselinePath = join(resultsDir, 'baseline.json')
const runRecordPath = join(resultsDir, 'run.json')
const runArchiveDir = join(resultsDir, 'runs')
const checkpointsDir = join(resultsDir, 'checkpoints')

/** Transcript publication policy.
 *
 * Transcripts are never published by default: the checked-in `latest.json` carries
 * structured metadata and verdicts only. `--publish-transcripts` opts in, and even then
 * transcripts are redacted and size-limited before they touch disk or an artifact.
 */
/** Maximum bytes retained per persisted free-text field. Larger values are truncated,
 *  not dropped, so a failure still shows its tail. */
const MAX_TEXT_BYTES = 64 * 1024
/** Secret-shaped markers that must never appear in a persisted transcript. */
const SECRET_MARKERS = [
  /sk-[A-Za-z0-9]{20,}/g, // OpenAI-style keys
  /sk-or-[A-Za-z0-9]{20,}/g, // OpenRouter keys
  /ghp_[A-Za-z0-9]{36,}/g, // GitHub personal access tokens
  /github_pat_[A-Za-z0-9_]{20,}/g, // GitHub fine-grained tokens
  /[A-Za-z0-9+/]{40,}/g, // long base64 blobs (catches provider ledgers)
]

/** Redact secret-shaped content from a transcript before it is persisted or uploaded. */
export function redactTranscript(text: string): string {
  let redacted = text
  for (const marker of SECRET_MARKERS) {
    redacted = redacted.replace(marker, '[redacted]')
  }
  return redacted
}

/** Size-limit a free-text field, keeping the head and tail so failures remain readable. */
function limitText(text: string, label: string): string {
  const bytes = Buffer.byteLength(text, 'utf8')
  if (bytes <= MAX_TEXT_BYTES) return text
  const half = Math.floor(MAX_TEXT_BYTES / 2)
  const head = Buffer.from(text, 'utf8').subarray(0, half).toString('utf8')
  const tail = Buffer.from(text, 'utf8').subarray(-half).toString('utf8')
  return `${head}\n\n... [${label} truncated, ${bytes} bytes total] ...\n\n${tail}`
}

/** Size-limit a transcript before it is persisted or published. */
export function limitTranscript(text: string): string {
  return limitText(text, 'transcript')
}

/**
 * Redact and bound every free-text field before it is persisted.
 *
 * Sanitizing at the persistence boundary -- rather than only in the final report -- is
 * what keeps secrets out of checkpoints, the run record, and stdout. A checkpoint is an
 * uploaded artifact and a run record is committed; neither gets a second chance.
 */
export function sanitizeResult(result: ScenarioResult): ScenarioResult {
  return {
    ...result,
    transcript: limitText(redactTranscript(result.transcript), 'transcript'),
    ...(result.verifyOutput === undefined
      ? {}
      : { verifyOutput: limitText(redactTranscript(result.verifyOutput), 'verifier output') }),
    ...(result.error === undefined ? {} : { error: limitText(redactTranscript(result.error), 'error') }),
  }
}

/** The two things being compared: the same repository, with and without the artifacts. */
const VARIANTS = ['bare', 'anvil'] as const
type Variant = (typeof VARIANTS)[number]

/**
 * The original, gated matrix. The scheduled benchmark and `eval:check` use exactly these
 * four scenarios so a scheduled run still costs eight agent invocations, not the cost of
 * every scenario anyone has ever added. Phase 2B scenarios remain available through
 * `--suite extended` (or `--scenario`), but they do not silently expand the default run.
 */
const SMOKE_SCENARIO_IDS: ReadonlySet<string> = new Set([
  'tiny-code-change',
  'tiny-verify-only',
  'medium-code-change',
  'medium-verify-only',
])

/** Where the task is written inside the prepared repository. */
const TASK_FILE = '.anvil-eval-task.md'

/**
 * The tool names OpenCode has used for its shell tool.
 *
 * OpenCode 2 renamed `bash` to `shell`. The benchmark pins one version and a
 * developer's machine may carry the other, so the harness reads both. A tool the
 * harness does not recognise is not a shell execution, and is ignored.
 */
const SHELL_TOOL_NAMES = new Set(['shell', 'bash'])

/**
 * Where a completed shell tool reports its exit status, per OpenCode version.
 *
 * The paths are relative to the tool state's `metadata` object. OpenCode 2 nests the
 * tool's structured output one level deeper (`state.metadata.metadata.exit`);
 * OpenCode 1 put it directly under `state.metadata.exit`. Both are read, and a status
 * that is in neither place is reported as absent rather than guessed at.
 */
const EXIT_STATUS_PATHS: readonly (readonly string[])[] = [['metadata', 'exit'], ['exit']]

/** One shell command the agent's tool ran, with the status that command produced. */
export interface AgentExecution {
  /** The command string the tool ran, verbatim. */
  command: string
  /**
   * The exit status OpenCode observed for that command, or null when the event
   * carries none.
   *
   * Null is not a pass. The harness compares this number with its own replay, and a
   * command whose status cannot be read cannot be compared, so it is not accepted as
   * evidence.
   */
  exitCode: number | null
}

interface RunResult {
  ok: boolean
  code: number | null
  stdout: string
  stderr: string
  timedOut: boolean
  /** stdout and stderr together, trimmed to what a report can hold. */
  output: string
}

export interface ScenarioResult extends EvalResultSummary {
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

/**
 * Record a failure on a result without discarding the one already there.
 *
 * A run can fail for more than one reason at once: an agent that exits non-zero and
 * leaves no execution evidence behind has two, and the second finding is not less
 * true because the first one was reported first.
 */
function addError(result: ScenarioResult, message: string): void {
  result.error = result.error === undefined ? message : `${result.error}; ${message}`
}

async function main(): Promise<void> {
  const args = process.argv.slice(2)
  const dryRun = args.includes('--dry-run')
  const listOnly = args.includes('--list')
  const checkOnly = args.includes('--check')
  const fakeAgent = args.includes('--fake-agent')
  const writeBaselineAfterRun = args.includes('--write-baseline')
  const resume = args.includes('--resume')
  const publishTranscripts = args.includes('--publish-transcripts')
  const only = flagValue('--scenario', args)
  const suiteRaw = flagValue('--suite', args) ?? 'smoke'
  const repetitionsRaw = flagValue('--repetitions', args)
  const repetitions = repetitionsRaw === null ? 1 : Number(repetitionsRaw)
  const seedRaw = flagValue('--seed', args)
  const seed = seedRaw === null ? randomUUID() : seedRaw
  const orderRaw = flagValue('--order', args)
  const order = orderRaw === null ? 'alternate' : orderRaw
  const enabled = process.env.ANVIL_EVAL === '1'

  if (repetitionsRaw !== null && (!Number.isInteger(repetitions) || repetitions < 1)) {
    console.error(`--repetitions must be a positive integer, got ${repetitionsRaw}`)
    process.exit(1)
  }
  if (repetitions < 1) {
    console.error(`--repetitions must be at least 1, got ${repetitions}`)
    process.exit(1)
  }
  if (!['alternate', 'fixed'].includes(order)) {
    console.error(`--order must be 'alternate' or 'fixed', got ${order}`)
    process.exit(1)
  }
  if (!['smoke', 'extended', 'all'].includes(suiteRaw)) {
    console.error(`--suite must be 'smoke', 'extended' or 'all', got ${suiteRaw}`)
    process.exit(1)
  }
  const suite = suiteRaw as 'smoke' | 'extended' | 'all'

  if (writeBaselineAfterRun && (dryRun || listOnly || checkOnly)) {
    console.error(
      '--write-baseline writes the result of a run; it cannot be combined with --dry-run, --list or --check',
    )
    process.exit(1)
  }

  // A dry run, a listing, a gate check and the fake agent cost no tokens. Everything that
  // can spend money stays opt-in.
  if (!enabled && !dryRun && !listOnly && !checkOnly && !fakeAgent) {
    console.log('The eval harness is opt-in: it runs an agent against a model.')
    console.log('Run it with: ANVIL_EVAL=1 npm run eval')
    console.log('Preview what it would do with: npm run eval -- --dry-run')
    console.log('List the matrix with: npm run eval -- --list')
    console.log('Check the last run with: npm run eval:check')
    process.exit(0)
  }

  const scenarios = loadScenarios()
  const suiteScenarios =
    suite === 'smoke'
      ? scenarios.filter((scenario) => SMOKE_SCENARIO_IDS.has(scenario.id))
      : suite === 'extended'
        ? scenarios.filter((scenario) => !SMOKE_SCENARIO_IDS.has(scenario.id))
        : scenarios
  const selectedScenarios = only === null ? suiteScenarios : scenarios.filter((s) => s.id === only)
  if (selectedScenarios.length === 0) {
    console.error(`No scenario matched ${only ?? '(nothing)'}`)
    process.exit(1)
  }
  // A subset selection is explicitly partial: it must not overwrite valid complete evidence
  // with a success-looking report covering only part of the matrix. The smoke suite is the
  // gated matrix, so it is complete; extended and all are exploratory measurements.
  const isSubset = only !== null || suite !== 'smoke'

  const models = fakeAgent ? ([{ id: 'fake-agent', role: 'small' }] satisfies EvalModel[]) : selectedModels(args)
  if (models.length === 0) {
    console.error('No model matched the requested role. Use --models small, --models frontier or --models all.')
    process.exit(1)
  }

  if (listOnly) {
    printScenarios(selectedScenarios, models)
    process.exit(0)
  }

  if (dryRun) {
    for (const scenario of selectedScenarios) {
      console.log(`${scenario.id}`)
      console.log(`  size      ${scenario.size}`)
      console.log(`  kind      ${scenario.kind}`)
      console.log(`  repo      ${scenario.repo}`)
      console.log(`  task      ${scenario.task}`)
      console.log(`  verify    ${scenario.verify.join('; ')}`)
      console.log(`  hidden    ${(scenario.hidden ?? []).map((h) => `${h.from} -> ${h.to}`).join('; ') || '(none)'}`)
      console.log(`  expect    ${JSON.stringify(scenario.expect)}`)
      console.log(`  variants  ${VARIANTS.join(', ')}`)
      console.log(`  models    ${models.map((m) => `${m.id} (${m.role})`).join(', ')}`)
      if (fakeAgent) console.log('  agent     fake (a canned answer, no model is called)')
    }
    process.exit(0)
  }

  if (checkOnly) {
    // The gate is defined over the original smoke matrix. Extended scenarios are opt-in
    // measurements; they must not make the scheduled check fail simply by existing.
    process.exit(runCheck(scenarios.filter((scenario) => SMOKE_SCENARIO_IDS.has(scenario.id))))
  }

  // The gate hashes the source, so the harness must run that same source -- not a stale
  // checked-in bundle. Rebuild the CLI before evaluating so what executes is what is hashed.
  ensureCliBuilt()

  // `--resume` continues an existing run: it validates that the implementation, fixtures,
  // models, harness policy, and requested run keys still match, skips keys that already
  // completed, and retries only the incomplete ones. Each attempt is recorded explicitly; a
  // failure is never silently retried until it passes.
  let runRecord: EvalRunRecord
  let runId: string
  const declaredKeys: string[] = []
  for (const model of models) {
    for (const scenario of selectedScenarios) {
      for (let repetition = 0; repetition < repetitions; repetition += 1) {
        for (const variant of counterbalanceOrder(repetition, order)) {
          declaredKeys.push(`${scenario.id}/${variant}/${model.id}/${repetition}`)
        }
      }
    }
  }
  const bundlePath = join(repoRoot, 'packages', 'cli', 'dist', 'cli.js')
  const bundleDigest = existsSync(bundlePath)
    ? createHash('sha256').update(readFileSync(bundlePath)).digest('hex')
    : null
  const harnessDigest = hashHarness()
  const implementationBefore = hashImplementation(repoRoot)
  const opencodeVersion = fakeAgent ? null : await probeCommandVersion('opencode')
  const currentScenarioHashes = Object.fromEntries(
    selectedScenarios.map((scenario) => [
      scenario.id,
      { scenarioHash: hashScenario(scenario), sourceHash: hashScenarioSource(repoRoot, scenario) },
    ]),
  )

  if (resume) {
    // Resuming without a record cannot know which keys belong to the run. Starting a new
    // run silently would discard the reason the caller asked to resume, so fail closed.
    if (!existsSync(runRecordPath)) {
      console.error('Cannot resume: eval-results/run.json is missing. Start a new run instead.')
      process.exit(1)
    }
    const parsed = parseRunRecord(readJsonFile(runRecordPath))
    if (typeof parsed === 'string') {
      console.error(`Cannot resume: ${parsed}`)
      process.exit(1)
    }

    // Recover completed checkpoints that were never recorded in run.json (for example
    // because the run.json write failed after a checkpoint write). Discovery is recursive
    // because model IDs contain `/`, and every checkpoint is validated before it can
    // become evidence.
    const checkpointRead = readCheckpointDirectory(join(checkpointsDir, parsed.runId))
    for (const rejected of checkpointRead.rejected) {
      console.warn(`Ignoring checkpoint ${rejected}`)
    }
    const reconciled = reconcileRunRecord(parsed, checkpointRead.entries, currentScenarioHashes, selectedScenarios)
    for (const rejected of reconciled.rejected) {
      console.warn(`Ignoring checkpoint ${rejected}`)
    }
    runRecord = reconciled.record

    // Validate compatibility before mutating run.json: a rejected resume must leave
    // the durable record intact so a later attempt can resume once the incompatibility
    // is resolved. Recovering checkpoints first is safe because reconcileRunRecord
    // validates every checkpoint's hashes before it can become evidence.
    const compatibility = checkRunRecordCompatibility(runRecord, {
      implementation: implementationBefore,
      scenarioHashes: currentScenarioHashes,
      scenarios: selectedScenarios,
      models,
      bundleDigest,
      harnessDigest,
      opencodeVersion,
      publishTranscripts,
      repetitions,
    })
    if (!compatibility.ok) {
      console.error(compatibility.message)
      process.exit(1)
    }

    if (reconciled.changed) {
      runRecord.completionState = 'in-progress'
      runRecord.completedAt = null
      writeRunRecord(runRecord)
      console.log(`Recovered completed checkpoints for run ${runRecord.runId} from previous attempts.`)
    }
    runId = runRecord.runId
    const completed = new Set(runRecord.results.filter((r) => latestAttemptState(r) === 'completed').map(resultKey))
    const remaining = declaredKeys.filter((key) => !completed.has(key))
    console.log(
      remaining.length === 0
        ? `Run ${runId} already completed all ${declaredKeys.length} keys; finishing without rerunning them.`
        : `Resuming run ${runId}: ${remaining.length} of ${declaredKeys.length} keys remain.`,
    )
  } else {
    // Never clobber the record that a checked-in summary references. Archiving a complete
    // record first means a later partial or subset run cannot take away the provenance of
    // the last complete one. Incomplete runs have no evidence to preserve.
    if (existsSync(runRecordPath)) {
      const prior = parseRunRecord(readJsonFile(runRecordPath))
      if (typeof prior === 'string') {
        console.warn(`Not archiving the previous run record: ${prior}`)
      } else if (prior.completionState === 'completed' && !prior.subset) {
        const archived = archiveRunRecord(prior, false)
        console.log(
          archived
            ? `Archived previous run ${prior.runId} to ${join(runArchiveDir, `${prior.runId}.json`)}.`
            : `Previous run ${prior.runId} is already archived.`,
        )
      } else {
        console.log(
          `Previous run ${prior.runId} is ${prior.subset ? 'a subset' : prior.completionState}; not archiving it.`,
        )
      }
    }
    runId = randomUUID()
    const startedAt = new Date().toISOString()
    runRecord = {
      schemaVersion: EVAL_SCHEMA_VERSION,
      runId,
      startedAt,
      completedAt: null,
      completionState: 'in-progress',
      commitSha: readCommitSha(),
      implementation: implementationBefore,
      bundleDigest,
      harnessDigest,
      models,
      opencodeVersion,
      nodeVersion: process.version,
      publishTranscripts,
      subset: isSubset,
      repetitions,
      seed,
      order,
      scenarioHashes: currentScenarioHashes,
      runKeys: declaredKeys,
      executionOrder: [],
      results: [],
    }
    writeRunRecord(runRecord)
  }

  const results: ScenarioResult[] = []
  const completedKeys = new Set(
    runRecord.results
      .filter((r) => latestAttemptState(r) === 'completed')
      .map((r) => `${r.scenario}/${r.variant}/${r.model}/${r.repetition}`),
  )
  for (const prior of runRecord.results) {
    if (latestAttemptState(prior) !== 'completed') continue
    const scenario = selectedScenarios.find((s) => s.id === prior.scenario)
    results.push(
      sanitizeResult({
        scenario: prior.scenario,
        size: scenario?.size ?? 'tiny',
        kind: scenario?.kind ?? 'code-change',
        variant: prior.variant,
        model: prior.model,
        modelRole: prior.modelRole as EvalModelRole | null,
        opencodeVersion: runRecord.opencodeVersion,
        scenarioHash: prior.scenarioHash,
        sourceHash: prior.sourceHash,
        verifyCount: prior.verifyCount,
        hiddenVerifyCount: prior.hiddenVerifyCount,
        verified: prior.verified,
        hiddenVerified: prior.hiddenVerified,
        verifyExitCodes: [...prior.verifyExitCodes],
        repetition: prior.repetition,
        costUsd: prior.costUsd,
        tokens: prior.tokens,
        durationMs: prior.durationMs,
        transcript: prior.transcript,
        ...(prior.error === undefined ? {} : { error: prior.error }),
      }),
    )
  }
  for (const model of models) {
    for (const scenario of selectedScenarios) {
      const scenarioHash = hashScenario(scenario)
      const sourceHash = hashScenarioSource(repoRoot, scenario)
      for (let repetition = 0; repetition < repetitions; repetition += 1) {
        for (const variant of counterbalanceOrder(repetition, order)) {
          const key = `${scenario.id}/${variant}/${model.id}/${repetition}`
          // A key that already completed is not re-run: resume picks up incomplete work,
          // it does not silently rerun finished results until they pass.
          if (completedKeys.has(key)) continue

          const attemptStartedAt = new Date().toISOString()
          const rawResult = await runScenario(
            scenario,
            variant,
            model,
            scenarioHash,
            sourceHash,
            opencodeVersion,
            fakeAgent,
            publishTranscripts,
            repetition,
          )
          // Sanitize before anything persists it: the checkpoint, the run record, and the
          // console table are all sinks, and a secret in an error string reaches all three.
          const result = sanitizeResult(rawResult)
          results.push(result)

          // Checkpoint the attempt immediately, before the next scenario starts. A crash
          // or timeout after this point leaves this attempt readable, and latest.json is
          // never overwritten by an incomplete run.
          const attempt: EvalRunRecordAttempt = {
            startedAt: attemptStartedAt,
            completedAt: new Date().toISOString(),
            state: result.error === undefined ? 'completed' : 'failed',
            ...(result.error === undefined ? {} : { error: result.error }),
          }
          const index = runRecord.results.findIndex(
            (r) =>
              r.scenario === scenario.id &&
              r.variant === variant &&
              r.model === model.id &&
              r.repetition === repetition,
          )
          if (index === -1) {
            const checkpoint = recordResultFrom(result, scenarioHash, sourceHash, [attempt])
            writeCheckpoint(runId, checkpoint)
            runRecord.executionOrder.push(key)
            runRecord.results.push(checkpoint)
          } else {
            // A retry replaces the previous attempt's verdicts and metadata with the latest
            // attempt's, so the run record never mixes a failed attempt's verdict with a
            // completed attempt's metadata. In particular, a successful retry must clear the
            // previous attempt's error rather than leave a contradiction behind.
            const existing = runRecord.results[index]!
            const updated = recordResultFrom(result, scenarioHash, sourceHash, [...existing.attempts, attempt])
            runRecord.results[index] = updated
            if (!runRecord.executionOrder.includes(key)) runRecord.executionOrder.push(key)
            writeCheckpoint(runId, updated)
          }
          writeRunRecord(runRecord)
        }
      }
    }
  }

  // The implementation, bundle, and harness are hashed again after the run: if any changed
  // under the run, the results were produced by different inputs than the ones being
  // committed as evidence.
  const implementationAfter = hashImplementation(repoRoot)
  const bundlePathAfter = join(repoRoot, 'packages', 'cli', 'dist', 'cli.js')
  const bundleDigestAfter = existsSync(bundlePathAfter)
    ? createHash('sha256').update(readFileSync(bundlePathAfter)).digest('hex')
    : null
  const harnessDigestAfter = hashHarness()

  // Reload the scenario matrix from disk so a definition that changed mid-run is detected,
  // not the in-memory object captured before the run started.
  const currentScenarios = loadScenarios()
  const currentHashes = Object.fromEntries(
    currentScenarios.map((scenario) => [
      scenario.id,
      { scenarioHash: hashScenario(scenario), sourceHash: hashScenarioSource(repoRoot, scenario) },
    ]),
  )
  const fixtureProblem = recordFixtureProblem(runRecord, currentHashes)
  const complete = allDeclaredCompleted(runRecord)

  let completionState: EvalRunRecord['completionState']
  if (
    implementationBefore !== implementationAfter ||
    bundleDigest !== bundleDigestAfter ||
    harnessDigest !== harnessDigestAfter
  ) {
    completionState = 'failed'
  } else if (fixtureProblem !== null) {
    console.error(fixtureProblem)
    completionState = 'failed'
  } else if (!complete) {
    completionState = 'partial'
  } else if (isSubset || runRecord.subset) {
    // A subset selection is explicitly partial: it promotes only the keys it ran and must
    // not overwrite valid complete evidence with a success-looking partial report.
    completionState = 'partial'
  } else {
    completionState = 'completed'
  }

  runRecord.completedAt = new Date().toISOString()
  runRecord.completionState = completionState
  runRecord.implementation = implementationBefore
  writeRunRecord(runRecord)

  // Only promote latest.json when the full declared run completed without the
  // implementation changing. An interrupted run leaves checkpoints and a partial run
  // record, but latest.json keeps the last complete summary.
  if (completionState === 'completed') {
    const recordCheck = checkRunRecord(runRecord, implementationBefore, declaredKeys, harnessDigest, currentScenarios)
    if (!recordCheck.ok) {
      // The gate will never accept this record, so do not promote a summary from it.
      console.error(recordCheck.message)
      runRecord.completionState = 'failed'
      completionState = 'failed'
      writeRunRecord(runRecord)
    }
  }

  if (completionState === 'completed') {
    writeReport(results, runRecord)
  } else {
    console.log(`Run ${runId} finished in state ${completionState}; eval-results/latest.json is unchanged.`)
  }

  printSummary(results)
  if (writeBaselineAfterRun && completionState === 'completed') writeBaseline(selectedScenarios)

  // The exit code is the verdict of the harness, not of the agent: a failed run is
  // reported in the summary, and `--check` is the command that turns it into a failure.
  process.exit(0)
}

// Only run the harness when this file is executed directly, so `run` and the other
// helpers can be imported by tests without launching a benchmark.
const argv1 = process.argv[1]
if (typeof argv1 === 'string' && import.meta.url === pathToFileURL(argv1).href) {
  await main().catch((err) => {
    console.error(err)
    process.exit(1)
  })
}

// ---------------------------------------------------------------------------
// The run
// ---------------------------------------------------------------------------

async function runScenario(
  scenario: EvalScenario,
  variant: Variant,
  model: EvalModel,
  scenarioHash: string,
  sourceHash: string,
  opencodeVersion: string | null,
  fake: boolean,
  publishTranscripts: boolean,
  repetition: number,
): Promise<ScenarioResult> {
  const workdir = mkdtempSync(join(tmpdir(), `anvil-eval-${scenario.id}-${variant}-r${repetition}`))
  // Harness-owned execution evidence directory. The agent never receives this path.
  // Verifiers receive it after the agent finishes, so they can compare the report
  // against the actual execution the harness recorded.
  let executionDir: string | null = null
  if (scenario.captureExecution === true) {
    executionDir = mkdtempSync(join(tmpdir(), `anvil-eval-execution-${scenario.id}-`))
  }
  // The agent must never learn the harness-owned log path; a path the agent can
  // write to is forgeable by construction (same user, same filesystem).
  const agentEnv: NodeJS.ProcessEnv = { ANVIL_EVAL_EXECUTION_LOG: undefined }
  // The harness captures execution evidence in its own log after the agent finishes.
  const executionEnv: NodeJS.ProcessEnv =
    executionDir === null ? {} : { ANVIL_EVAL_EXECUTION_LOG: join(executionDir, 'executions.jsonl') }
  const started = Date.now()
  const result: ScenarioResult = {
    scenario: scenario.id,
    size: scenario.size,
    kind: scenario.kind,
    variant,
    model: fake ? 'fake-agent' : model.id,
    modelRole: fake ? null : model.role,
    opencodeVersion,
    scenarioHash,
    sourceHash,
    verifyCount: scenario.verify.length,
    hiddenVerifyCount: 0,
    verified: false,
    hiddenVerified: null,
    verifyExitCodes: [],
    costUsd: null,
    tokens: null,
    durationMs: 0,
    transcript: '',
    repetition,
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
    let agentExecutions: AgentExecution[] = []

    if (fake) {
      // A canned answer can include actions, not only files. Running them here is what
      // makes verify-only evidence real: the check executes and the harness captures it,
      // instead of a canned execution record being copied into the worktree.
      if (scenario.solutionRun !== undefined) {
        const actions = await runAll(scenario.solutionRun, workdir, executionEnv)
        result.verifyOutput = actions.map((action) => action.output).join('\n')
      }
      const answers = solutionFiles(scenario)
      if (answers.length > 0) {
        for (const answer of answers) {
          const target = join(workdir, ...answer.to.split('/'))
          mkdirSync(dirname(target), { recursive: true })
          cpSync(join(repoRoot, answer.from), target)
        }
        result.transcript = publishTranscripts
          ? limitTranscript(
              redactTranscript(
                `[fake-agent] ran ${(scenario.solutionRun ?? []).join(', ') || '(no commands)'}; applied ${answers
                  .map((answer) => `${answer.from} to ${answer.to}`)
                  .join(', ')}`,
              ),
            )
          : ''
      } else if (scenario.kind === 'code-change') {
        result.error = 'a code-change scenario needs a solution for --fake-agent'
        return result
      } else {
        result.transcript = publishTranscripts ? limitTranscript(redactTranscript('[fake-agent] ran the verifier')) : ''
      }
    } else {
      // `--auto` because the run is unattended and the workdir is a throwaway copy: a
      // permission prompt is a hang, and a hang is not a result.
      // OpenCode 2's private server inherits this process's provider credentials and
      // exits with the command instead of leaving work running in a shared service.
      // `run` uses the subprocess cwd; it does not accept a `--dir` flag.
      const agentArgs = ['run', '--standalone', '--auto', '--format', 'json', '--model', model.id]
      agentArgs.push(`Read ${TASK_FILE} and follow every instruction in it exactly.`)
      const agent = await run('opencode', agentArgs, workdir, {
        timeoutMs: (scenario.timeoutMinutes ?? 10) * 60_000,
        env: agentEnv,
      })
      const agentEvents = parseOpenCodeRunEvents(agent.stdout)
      agentExecutions = agentEvents.executions
      result.transcript = publishTranscripts
        ? limitTranscript(redactTranscript(`${agentEvents.text}\n${agent.stderr}`.trim()))
        : ''
      if (agent.timedOut) {
        addError(result, 'the agent timed out')
      } else if (!agent.ok) {
        addError(result, `the agent exited with code ${agent.code ?? '?'}`)
      }
    }

    // For verify-only scenarios with execution capture, the harness records the
    // execution itself rather than trusting an agent-writable log path. The agent
    // never sees `ANVIL_EVAL_EXECUTION_LOG`. Only needed for real agents: fake
    // agents already ran `solutionRun` in the canned-answer block above.
    if (!fake && scenario.captureExecution === true && executionDir !== null) {
      // The agent must have run the check for evidence to be valid; a report-only
      // agent that never invoked the command must fail grading.
      const checkCommands: string[] = Array.isArray(scenario.solutionRun)
        ? scenario.solutionRun
        : scenario.solutionRun !== undefined
          ? [scenario.solutionRun]
          : []
      // The agent's own executions of each check, in the order the tool ran them.
      // These come from OpenCode's events, not from anything the agent wrote, so the
      // agent cannot edit them into existence.
      const observedRuns = checkCommands.map((expected) =>
        agentExecutions.filter((execution) => isCheckCommand(expected, execution.command)),
      )
      if (checkCommands.length === 0) {
        addError(result, 'the scenario declares no check command, so there is no execution evidence to collect')
      } else if (observedRuns.some((runs) => runs.length === 0)) {
        addError(
          result,
          `the agent did not run ${checkCommands.map((command) => JSON.stringify(command)).join(', ')} as a command on its own; a report without execution evidence is not evidence`,
        )
      } else if (!scenarioEvidenceScriptsUnchanged(scenario, workdir)) {
        addError(result, 'the agent modified a check or verifier script; execution evidence is invalid')
      } else {
        // The completed tool event proves the agent invoked the exact check. Rerun
        // the unchanged script under harness control to record its real exit status;
        // its self-reported log goes to a dummy path and is never accepted.
        const dummyEnv = { ...executionEnv, ANVIL_EVAL_EXECUTION_LOG: join(executionDir, 'dummy.jsonl') }
        const replays = await replayCommands(checkCommands, workdir, dummyEnv)
        // The exit status the agent's own run produced has to agree with the replay.
        // Without this, an agent could replace the check with one that exits 0, run
        // it, restore the original, and report the outcome the restored script would
        // have produced: the replay's exit code, not the one it actually saw.
        const disagreement = findEvidenceDisagreement(checkCommands, observedRuns, replays)
        if (disagreement !== null) {
          addError(result, disagreement)
        } else {
          // Write harness-owned evidence from the actual exits, not from a script
          // that the agent could have edited to lie about its exit code.
          const logPath = join(executionDir, 'executions.jsonl')
          for (let i = 0; i < checkCommands.length; i += 1) {
            const replay = replays[i]!
            appendFileSync(
              logPath,
              `${JSON.stringify({
                command: checkCommands[i],
                exitCode: replay.ok ? 0 : (replay.code ?? 1),
                at: new Date().toISOString(),
              })}\n`,
              'utf8',
            )
          }
          result.verifyOutput = replays.map((r) => r.output).join('\n')
        }
      }
    }

    const verifyCwd = scenario.verifyInProjectDir === true ? projectDirIn(workdir) : workdir
    const visible = await runAll(scenario.verify, verifyCwd, executionEnv)
    result.verified = visible.every((r) => r.ok)
    result.verifyExitCodes = visible.map((r) => r.code ?? -1)
    result.verifyOutput = visible.map((r) => r.output).join('\n')

    for (const file of scenario.hidden ?? []) {
      const target = join(workdir, ...file.to.split('/'))
      mkdirSync(dirname(target), { recursive: true })
      cpSync(join(repoRoot, file.from), target, { recursive: true })
    }
    if ((scenario.hiddenVerify?.length ?? 0) > 0) {
      const hiddenCommands = scenario.hiddenVerify ?? []
      const hidden = await runAll(hiddenCommands, workdir, executionEnv)
      result.hiddenVerifyCount = hiddenCommands.length
      result.hiddenVerified = hidden.every((r) => r.ok)
      result.verifyExitCodes = [...result.verifyExitCodes, ...hidden.map((r) => r.code ?? -1)]
    }

    if (!fake) {
      const session = readAgentSession(workdir)
      if (session !== null) {
        const cost = await lookupSessionCosts([session.sessionId])
        const entry = cost.sessions.get(session.sessionId)
        result.costUsd = entry?.costUsd ?? null
        result.tokens = entry?.tokens ?? null
      }
    }
  } catch (err) {
    result.error = err instanceof Error ? err.message : String(err)
  } finally {
    result.durationMs = Date.now() - started
    if (executionDir !== null) {
      try {
        rmSync(executionDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
      } catch {
        // best effort; a leaked evidence directory cannot change a verdict
      }
    }
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

/** Read a number at a path through an unknown value, or null when it is not there. */
function numberAtPath(source: unknown, path: readonly string[]): number | null {
  let current: unknown = source
  for (const key of path) {
    if (current === null || typeof current !== 'object') return null
    current = (current as Record<string, unknown>)[key]
  }
  return typeof current === 'number' && Number.isFinite(current) ? current : null
}

/** The exit status a completed shell tool reported, whichever OpenCode version wrote it. */
function readExitStatus(metadata: unknown): number | null {
  for (const path of EXIT_STATUS_PATHS) {
    const value = numberAtPath(metadata, path)
    if (value !== null) return value
  }
  return null
}

/**
 * Extract text and completed shell executions from OpenCode's `run --format json` stream.
 *
 * Only the tool's own events count. The prose an agent writes is not evidence of
 * anything, and neither is a report the agent left in the worktree: this reads what
 * OpenCode says it ran and what that run returned.
 */
export function parseOpenCodeRunEvents(output: string): { text: string; executions: AgentExecution[] } {
  const text: string[] = []
  const executions: AgentExecution[] = []
  for (const line of output.split(/\r?\n/)) {
    if (line.trim() === '') continue
    let event: unknown
    try {
      event = JSON.parse(line)
    } catch {
      continue
    }
    if (event === null || typeof event !== 'object') continue
    const record = event as {
      type?: unknown
      part?: {
        type?: unknown
        text?: unknown
        tool?: unknown
        state?: { status?: unknown; input?: unknown; metadata?: unknown }
      }
    }
    if (record.type === 'text' && record.part?.type === 'text' && typeof record.part.text === 'string') {
      text.push(record.part.text)
    }
    // OpenCode 2 emits `tool_use` events; OpenCode 1 emits `tool` events. Both carry
    // the tool part under `part`, and both report a shell run that finished as
    // `completed` -- including a command that exited non-zero, which is a completed
    // run with a failing status, not a failed run.
    if (record.type !== 'tool_use' && record.type !== 'tool') continue
    if (record.part?.type !== 'tool') continue
    if (typeof record.part.tool !== 'string' || !SHELL_TOOL_NAMES.has(record.part.tool)) continue
    if (record.part.state?.status !== 'completed') continue
    const input = record.part.state.input
    if (input === null || typeof input !== 'object') continue
    const command = (input as { command?: unknown }).command
    if (typeof command !== 'string') continue
    executions.push({ command, exitCode: readExitStatus(record.part.state.metadata) })
  }
  return { text: text.join('\n'), executions }
}

/**
 * Whether a command the agent ran is the scenario's check command.
 *
 * Accept only a small, literal subset of shell syntax. `tokenizeCommand` is for
 * direct process argv, not shell source: it silently accepts unterminated quotes
 * and flattens newlines that a shell treats as command separators. A shell parse
 * error can exit 1 without running the check, so its status is not check evidence.
 *
 * Executables must match exactly: `./node` is an agent-writable local program, not
 * PATH-resolved `node`. Only Node's script operand gets path normalization, so
 * `node ./run-check.js` remains supported without changing other argument values.
 */
export function isCheckCommand(expected: string, actual: string): boolean {
  const want = parseEvidenceCommand(expected)
  const got = parseEvidenceCommand(actual)
  if (want === null || got === null || want.length === 0 || want.length !== got.length) return false
  return want.every((arg, index) => {
    const actualArg = got[index] as string
    if (index === 1 && want[0] === 'node' && !arg.startsWith('-') && /\.(?:c|m)?js$/.test(arg)) {
      return normalizeScriptPath(arg) === normalizeScriptPath(actualArg)
    }
    return arg === actualArg
  })
}

/**
 * Read inert words separated by ASCII spaces/tabs, with optional whole-argument
 * double quotes. Everything else fails closed: no controls, operators, expansions,
 * escapes, quote concatenation, or quoted executables (which PowerShell does not
 * invoke without an operator). Single quotes and backslashes are not interpreted
 * consistently across cmd, PowerShell and POSIX shells; the host OS alone does not
 * identify the agent's shell. This is deliberately not a general shell parser.
 */
function parseEvidenceCommand(command: string): string[] | null {
  const args: string[] = []
  let cursor = 0
  while (cursor < command.length) {
    if (command[cursor] === ' ' || command[cursor] === '\t') {
      cursor++
      continue
    }
    const start = cursor
    const quote = command[cursor]
    let arg: string
    if (quote === '"') {
      if (args.length === 0) return null
      const end = command.indexOf(quote, cursor + 1)
      if (end === -1) return null
      arg = command.slice(cursor + 1, end)
      cursor = end + 1
    } else {
      while (cursor < command.length && command[cursor] !== ' ' && command[cursor] !== '\t') cursor++
      arg = command.slice(start, cursor)
    }
    if (cursor < command.length && command[cursor] !== ' ' && command[cursor] !== '\t') return null
    if (!/^[A-Za-z0-9_./: -]+$/.test(arg)) return null
    args.push(arg)
  }
  return args
}

/** Normalize a script path, never a command name or an arbitrary argument value. */
function normalizeScriptPath(arg: string): string {
  return arg.replace(/^\.\//, '')
}

/**
 * Run each check command under harness control, keeping every result aligned with
 * the command it came from.
 *
 * `runAll` drops a command it cannot parse, which would shift the remaining results
 * one place along the list. The evidence log pairs each result with its command, so
 * the alignment has to hold even for a command that cannot run.
 */
async function replayCommands(commands: readonly string[], cwd: string, env: NodeJS.ProcessEnv): Promise<RunResult[]> {
  const out: RunResult[] = []
  for (const command of commands) {
    const [bin, ...rest] = tokenizeCommand(command)
    if (bin === undefined) {
      const message = `the check command is empty: ${JSON.stringify(command)}`
      out.push({ ok: false, code: null, stdout: '', stderr: message, timedOut: false, output: message })
      continue
    }
    out.push(await run(bin, rest, cwd, { timeoutMs: 5 * 60_000, env }))
  }
  return out
}

/**
 * Find the first check whose agent-observed outcome disagrees with the harness's replay.
 *
 * The exit status is the one part of the evidence the agent cannot write: OpenCode
 * reports it from the process it ran, and no report or worktree file can turn a
 * command that exited 0 into one that exited 1. Requiring the two to agree is what
 * stops "replace the check, run it, restore it, report the restored result".
 *
 * The last observed run of each command is the one compared, because that is the run
 * whose result the agent was holding when it wrote its report.
 */
function findEvidenceDisagreement(
  commands: readonly string[],
  observedRuns: readonly (readonly AgentExecution[])[],
  replays: readonly RunResult[],
): string | null {
  for (let index = 0; index < commands.length; index += 1) {
    const command = commands[index] as string
    const observed = observedRuns[index]?.at(-1)
    const replay = replays[index]
    if (observed === undefined || replay === undefined) {
      return `the harness could not replay ${JSON.stringify(command)}; execution evidence is incomplete`
    }
    if (observed.exitCode === null) {
      return `the agent's execution of ${JSON.stringify(command)} reported no exit status; execution evidence cannot be verified`
    }
    const replayedExit = replay.ok ? 0 : (replay.code ?? 1)
    if (observed.exitCode !== replayedExit) {
      return `the agent's execution of ${JSON.stringify(command)} exited with ${observed.exitCode}, but the unchanged check exits with ${replayedExit}; execution evidence does not match the check`
    }
  }
  return null
}

/** Ensure the agent did not alter the check or visible verifier before harness replay. */
function scenarioEvidenceScriptsUnchanged(scenario: EvalScenario, workdir: string): boolean {
  const fixtureRoot = join(repoRoot, ...scenario.repo.split('/'))
  const commands = [...(scenario.solutionRun ?? []), ...scenario.verify]
  const scripts = new Set<string>()
  for (const command of commands) {
    const [, ...args] = tokenizeCommand(command)
    for (const arg of args) {
      if (/\.(?:c|m)?js$/i.test(arg) && !arg.startsWith('-')) scripts.add(arg)
    }
  }
  for (const script of scripts) {
    const original = join(fixtureRoot, ...script.split('/'))
    const current = join(workdir, ...script.split('/'))
    if (!existsSync(original) || !existsSync(current) || !readFileSync(original).equals(readFileSync(current)))
      return false
  }
  return true
}

/**
 * Resolve the directory a scenario's verifier should run in.
 *
 * The profile's `projectDir` is the same detection `anvil init` and `crew verify` use.
 * Running the verifier there is what makes a nested-project scenario measure detection
 * rather than accidentally measuring the repository root.
 */
function projectDirIn(workdir: string): string {
  const { profile } = buildProfile(workdir, { root: workdir, host: null, remote: null, defaultBranch: null })
  if (profile.projectDir === '') return workdir
  return join(workdir, ...profile.projectDir.split('/'))
}

/** Copy the scenario's repository into a fresh git repository the agent can work in. */
function prepareRepo(scenario: EvalScenario, workdir: string): void {
  const source = join(repoRoot, ...scenario.repo.split('/'))
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

/** Build the CLI bundle before evaluating, so the code that runs is the code that is hashed. */
function ensureCliBuilt(): void {
  execFileSync(process.execPath, ['scripts/build.mjs'], { cwd: repoRoot, stdio: 'inherit' })
}

// ---------------------------------------------------------------------------
// Process helpers
// ---------------------------------------------------------------------------

async function runAll(commands: string[], cwd: string, env: NodeJS.ProcessEnv = {}): Promise<RunResult[]> {
  const out: RunResult[] = []
  for (const command of commands) {
    // The same tokenizer the crew uses: a verify command is one string, and splitting it
    // on spaces passes quotes through literally.
    const [bin, ...rest] = tokenizeCommand(command)
    if (bin === undefined) continue
    out.push(await run(bin, rest, cwd, { timeoutMs: 5 * 60_000, env }))
  }
  return out
}

export async function run(
  bin: string,
  args: string[],
  cwd: string,
  options: { timeoutMs?: number; env?: NodeJS.ProcessEnv } = {},
): Promise<RunResult> {
  // `spawnArgv` rather than `spawn(bin, ...)`: the npm-installed `opencode` is a `.CMD`
  // shim on Windows, and Node's spawn does not resolve PATHEXT.
  const { file, args: argv } = spawnArgv(bin, args, { env: process.env, platform: process.platform })
  const needsVerbatim = process.platform === 'win32' && file.toLowerCase().endsWith('cmd.exe')

  return await new Promise<RunResult>((resolvePromise) => {
    // OpenCode 2 prefers inherited PWD over cwd. Point PWD at the scenario directory
    // so the agent works in the fixture, not in the repo that launched the harness.
    const child = spawn(file, argv, {
      cwd,
      env: childEnvironment(options.env, cwd),
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

/** Merge a subprocess environment while allowing explicit `undefined` values to unset keys. */
function childEnvironment(overrides: NodeJS.ProcessEnv | undefined, cwd: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, ...overrides, PWD: cwd }
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) delete env[key]
  }
  return env
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

function writeReport(results: ScenarioResult[], runRecord: EvalRunRecord): void {
  mkdirSync(rawDir, { recursive: true })
  const generatedAt = new Date().toISOString()
  const implementation = runRecord.implementation
  const stamp = generatedAt.replace(/[:.]/g, '-')
  const rawPath = join(rawDir, `eval-${stamp}.json`)
  // Sanitize every result before it lands in the raw report: transcripts and verifier
  // output can carry secrets, and the raw upload is world-readable.
  const sanitized = results.map((result) => {
    const safe = sanitizeResult(result)
    return {
      ...safe,
      verifyOutput: safe.verifyOutput === undefined ? undefined : redactTranscript(safe.verifyOutput),
    }
  })
  atomicWriteJson(rawPath, { generatedAt, implementation, results: sanitized })
  console.log(`\nReport written to ${rawPath}`)

  // Archive the exact record the summary references before promoting the summary. If the
  // archive write fails, latest.json still points at the previous, intact evidence.
  archiveRunRecord(runRecord)

  const latest: EvalLatest = {
    schemaVersion: EVAL_SCHEMA_VERSION,
    generatedAt,
    implementation,
    runId: runRecord.runId,
    repetitions: runRecord.repetitions,
    seed: runRecord.seed,
    order: runRecord.order,
    results: results.map(summaryOf),
  }
  atomicWriteJson(latestPath, latest)
  console.log(`Summary written to ${latestPath}`)
}

/** Write JSON atomically: serialize to a temp file in the same directory, then rename. */
function atomicWriteJson(path: string, value: unknown): void {
  const dir = dirname(path)
  mkdirSync(dir, { recursive: true })
  const temp = join(dir, `.tmp-${randomUUID()}.json`)
  try {
    writeFileSync(temp, `${formatJson(value)}\n`, 'utf8')
    renameSync(temp, path)
  } catch (err) {
    // Never leave a half-written file in place of the last good one: remove the temp
    // and leave the existing file untouched.
    try {
      rmSync(temp, { force: true })
    } catch {
      // best effort
    }
    throw err
  }
}

function summaryOf(result: ScenarioResult): EvalResultSummary {
  return {
    scenario: result.scenario,
    size: result.size,
    kind: result.kind,
    variant: result.variant,
    model: result.model,
    modelRole: result.modelRole,
    opencodeVersion: result.opencodeVersion,
    scenarioHash: result.scenarioHash,
    sourceHash: result.sourceHash,
    verifyCount: result.verifyCount,
    hiddenVerifyCount: result.hiddenVerifyCount,
    verified: result.verified,
    hiddenVerified: result.hiddenVerified,
    verifyExitCodes: result.verifyExitCodes,
    repetition: result.repetition ?? null,
    ...(result.error === undefined ? {} : { error: result.error }),
  }
}

function writeBaseline(scenarios: readonly EvalScenario[]): void {
  const baseline: EvalBaseline = {
    schemaVersion: EVAL_SCHEMA_VERSION,
    scenarios: scenarios.map((scenario) => ({
      id: scenario.id,
      size: scenario.size,
      kind: scenario.kind,
      scenarioHash: hashScenario(scenario),
      sourceHash: hashScenarioSource(repoRoot, scenario),
      verify: scenario.verify,
      hiddenVerify: scenario.hiddenVerify ?? [],
      expect: scenario.expect,
    })),
  }
  writeFileSync(baselinePath, `${formatJson(baseline)}\n`, 'utf8')
  console.log(`Baseline written to ${baselinePath}`)
}

/** Variant ordering within a repetition.
 *
 * `alternate` swaps bare/anvil order each repetition so neither variant always runs first.
 * `fixed` always runs bare before anvil. The order does not change results, but alternating
 * keeps variant order from confounding repetition comparisons.
 */
function counterbalanceOrder(repetition: number, order: string): ('bare' | 'anvil')[] {
  if (order === 'fixed') return ['bare', 'anvil']
  return repetition % 2 === 0 ? ['bare', 'anvil'] : ['anvil', 'bare']
}

/** HEAD of the repository the harness runs against, or null when git is unavailable. */
function readCommitSha(): string | null {
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repoRoot, encoding: 'utf8' }).trim() || null
  } catch {
    return null
  }
}

/** Atomically write the run record that tracks how a benchmark run is progressing. */
function writeRunRecord(record: EvalRunRecord): void {
  atomicWriteJson(runRecordPath, record)
}

/** A run id becomes a filename, so it must not be able to escape the archive directory. */
function isSafeRunId(runId: string): boolean {
  return /^[A-Za-z0-9._-]+$/.test(runId)
}

/** Keep a finished record under its run id so a later run cannot erase its provenance. */
function archiveRunRecord(record: EvalRunRecord, overwrite = true): boolean {
  if (!isSafeRunId(record.runId)) {
    throw new Error(`run id ${JSON.stringify(record.runId)} is not safe to use as a filename`)
  }
  const path = join(runArchiveDir, `${record.runId}.json`)
  if (!overwrite && existsSync(path)) return false
  atomicWriteJson(path, record)
  return true
}

/** Fingerprint the harness policy that a resumable run must not silently change. */
function hashHarness(): string {
  const hash = createHash('sha256')
  for (const rel of ['scripts/eval.ts', 'eval/models.json']) {
    const path = join(repoRoot, ...rel.split('/'))
    if (!existsSync(path)) continue
    hash.update(rel.replace(/\\/g, '/'))
    hash.update('\0')
    hash.update(readFileSync(path))
    hash.update('\0')
  }
  return hash.digest('hex')
}

/** Build the persisted shape of one result from the sanitized run output. */
function recordResultFrom(
  result: ScenarioResult,
  scenarioHash: string,
  sourceHash: string,
  attempts: EvalRunRecordAttempt[],
): EvalRunRecordResult {
  return {
    scenario: result.scenario,
    variant: result.variant,
    model: result.model,
    modelRole: result.modelRole,
    scenarioHash,
    sourceHash,
    verifyCount: result.verifyCount,
    hiddenVerifyCount: result.hiddenVerifyCount,
    attempts,
    verified: result.verified,
    hiddenVerified: result.hiddenVerified,
    verifyExitCodes: [...result.verifyExitCodes],
    repetition: result.repetition,
    costUsd: result.costUsd,
    tokens: result.tokens,
    durationMs: result.durationMs,
    transcript: result.transcript,
    ...(result.error === undefined ? {} : { error: result.error }),
  }
}

/** Atomically checkpoint a single completed scenario/variant result. */
function writeCheckpoint(runId: string, result: EvalRunRecordResult): void {
  const dir = join(checkpointsDir, runId)
  mkdirSync(dir, { recursive: true })
  atomicWriteJson(join(dir, checkpointFileName(result)), { schemaVersion: EVAL_SCHEMA_VERSION, ...result })
}

/**
 * JSON in the shape the repository's formatter prints.
 *
 * `JSON.stringify(..., null, 2)` puts a one-line array of exit codes on three lines, and
 * the checked-in summary then fails `biome check` until somebody formats it by hand. The
 * difference is not worth a formatter dependency in the harness, so the two rules that
 * matter are implemented here: two-space indentation, and primitive arrays stay inline.
 */
function formatJson(value: unknown, level = 0): string {
  const indent = '  '.repeat(level)
  const childIndent = '  '.repeat(level + 1)

  if (Array.isArray(value)) {
    if (value.length === 0) return '[]'
    const primitive = (item: unknown): boolean => item === null || ['string', 'number', 'boolean'].includes(typeof item)
    if (value.every(primitive)) {
      const inline = `[${value.map((item) => JSON.stringify(item)).join(', ')}]`
      // Biome's line width is 120 characters. Keeping a long primitive array inline makes
      // `npm run check` fail on the checked-in run record, so only short arrays stay on one
      // line; the rest use the same one-item-per-line shape Biome prints.
      if (inline.length <= 80) return inline
    }
    return `[\n${value.map((item) => `${childIndent}${formatJson(item, level + 1)}`).join(',\n')}\n${indent}]`
  }

  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>).filter(([, item]) => item !== undefined)
    if (entries.length === 0) return '{}'
    return `{\n${entries
      .map(([key, item]) => `${childIndent}${JSON.stringify(key)}: ${formatJson(item, level + 1)}`)
      .join(',\n')}\n${indent}}`
  }

  return JSON.stringify(value) ?? 'null'
}

function printSummary(results: ScenarioResult[]): void {
  console.log('')
  console.log('scenario              model                             variant  verified  hidden  cost      time')
  console.log('--------------------  --------------------------------  -------  --------  ------  --------  ------')
  for (const r of results) {
    const cost = r.costUsd === null ? '-' : `$${r.costUsd.toFixed(2)}`
    console.log(
      [
        r.scenario.padEnd(20),
        (r.model ?? '-').padEnd(32),
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
  console.log('Run `npm run eval:check` to compare this run with the baseline.')
}

function printScenarios(scenarios: readonly EvalScenario[], models: readonly EvalModel[]): void {
  console.log('Scenarios')
  console.log('---------')
  for (const scenario of scenarios) {
    console.log(`${scenario.id} (${scenario.size} / ${scenario.kind})`)
    console.log(`  repo    ${scenario.repo}`)
    console.log(`  task    ${scenario.task}`)
    console.log(`  verify  ${scenario.verify.join('; ')}`)
    console.log(`  expect  ${JSON.stringify(scenario.expect)}`)
  }
  console.log('')
  console.log('Models')
  console.log('------')
  for (const model of models) {
    console.log(`${model.id} (${model.role})`)
  }
}

// ---------------------------------------------------------------------------
// The gate
// ---------------------------------------------------------------------------

/**
 * Find the run record that produced a summary.
 *
 * `run.json` describes the most recent invocation, which may be a subset run. The
 * promoted run's record is archived under `eval-results/runs/<runId>.json`, so the gate
 * reads that first and falls back to `run.json` only when it is the same run.
 */
function loadRunRecordForLatest(latest: EvalLatest): EvalRunRecord | null {
  const read = (path: string): EvalRunRecord | null => {
    if (!existsSync(path)) return null
    const parsed = parseRunRecord(readJsonFile(path))
    return typeof parsed === 'string' ? null : parsed
  }

  if (latest.runId === undefined) return read(runRecordPath)
  if (isSafeRunId(latest.runId)) {
    const archived = read(join(runArchiveDir, `${latest.runId}.json`))
    if (archived !== null && archived.runId === latest.runId) return archived
  }
  const current = read(runRecordPath)
  if (current !== null && current.runId === latest.runId) return current
  return null
}

function runCheck(scenarios: readonly EvalScenario[]): number {
  if (!existsSync(baselinePath)) {
    console.log('No eval baseline exists yet; the gate bootstraps as a pass.')
    console.log('Run `npm run eval -- --fake-agent --write-baseline` to create one.')
    return 0
  }
  const baselineRaw = readJsonFile(baselinePath)
  const baseline = parseBaseline(baselineRaw)
  if (typeof baseline === 'string') {
    console.error(baseline)
    return 1
  }
  if (!existsSync(latestPath)) {
    console.error('No latest eval summary exists. Run the harness, then commit eval-results/latest.json.')
    return 1
  }
  const latestRaw = readJsonFile(latestPath)
  const latest = parseLatest(latestRaw)
  if (typeof latest === 'string') {
    console.error(latest)
    return 1
  }

  // A latest summary must be traceable to a completed run record. Read the record that
  // produced this summary -- which may have been archived if a later run overwrote
  // `run.json` -- so the gate can reject summaries promoted from partial or interrupted
  // runs.
  const runRecord = loadRunRecordForLatest(latest)

  // The baseline has to describe the matrix on disk, not only the last run. Without this
  // half, editing a fixture after `--write-baseline` and never running the harness again
  // would pass, because `latest.json` and `baseline.json` would still agree with each other.
  const current: EvalBaselineScenario[] = scenarios.map((scenario) => ({
    id: scenario.id,
    size: scenario.size,
    kind: scenario.kind,
    scenarioHash: hashScenario(scenario),
    sourceHash: hashScenarioSource(repoRoot, scenario),
    verify: scenario.verify,
    hiddenVerify: scenario.hiddenVerify ?? [],
    expect: scenario.expect,
  }))
  const gate = checkEvalGate(baseline, latest, current, hashImplementation(repoRoot), runRecord, hashHarness())
  if (!gate.ok) {
    console.error(gate.message)
    return 1
  }
  console.log(gate.message)
  return 0
}

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

function loadScenarios(): EvalScenario[] {
  const path = join(repoRoot, 'eval', 'scenarios.json')
  const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'))
  const list = (parsed as { scenarios?: unknown }).scenarios
  if (!Array.isArray(list)) throw new Error('eval/scenarios.json has no `scenarios` list')
  const scenarios = list as EvalScenario[]
  const error = validateScenarioMatrix(scenarios)
  if (error !== null) throw new Error(error)
  return scenarios
}

function loadModels(): EvalModel[] {
  const path = join(repoRoot, 'eval', 'models.json')
  const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'))
  const list = (parsed as { models?: unknown }).models
  if (!Array.isArray(list)) throw new Error('eval/models.json has no `models` list')
  const models = list
    .map((raw): EvalModel | null => {
      if (typeof raw !== 'object' || raw === null) return null
      const record = raw as { id?: unknown; role?: unknown }
      if (typeof record.id !== 'string' || record.id === '') return null
      if (record.role !== 'small' && record.role !== 'frontier') return null
      return { id: record.id, role: record.role }
    })
    .filter((model): model is EvalModel => model !== null)
  if (models.length === 0) throw new Error('eval/models.json has no usable models')
  return models
}

function selectedModels(args: string[]): EvalModel[] {
  let models = loadModels()

  // `ANVIL_EVAL_MODELS` replaces the pair, in small,frontier order.
  const envModels = process.env.ANVIL_EVAL_MODELS
  if (typeof envModels === 'string' && envModels.trim() !== '') {
    models = envModels
      .split(',')
      .map((id, index): EvalModel | null => {
        const trimmed = id.trim()
        if (trimmed === '') return null
        return { id: trimmed, role: index === 0 ? 'small' : 'frontier' }
      })
      .filter((model): model is EvalModel => model !== null)
    if (models.length === 0) throw new Error('ANVIL_EVAL_MODELS is not a comma-separated model list')
  }

  // `ANVIL_EVAL_MODEL` stays supported: it names one model, which is the small slot.
  const single = process.env.ANVIL_EVAL_MODEL
  if (typeof single === 'string' && single !== '') {
    models = [{ id: single, role: 'small' }]
  }

  const requested = modelRoles(args)
  return models.filter((model) => requested.has('all') || requested.has(model.role))
}

function modelRoles(args: string[]): Set<EvalModelRole | 'all'> {
  const raw = flagValue('--models', args) ?? 'small'
  const out = new Set<EvalModelRole | 'all'>()
  for (const part of raw.split(',').map((p) => p.trim().toLowerCase())) {
    if (part !== 'small' && part !== 'frontier' && part !== 'all') {
      throw new Error(`Unknown model role: ${part}. Expected small, frontier or all.`)
    }
    out.add(part)
  }
  if (out.size === 0) out.add('small')
  return out
}

function flagValue(flag: string, args: string[]): string | null {
  const index = args.indexOf(flag)
  if (index === -1) return null
  return args[index + 1] ?? null
}

/** Trim a command's output to what a report can hold. */
function trim(text: string): string {
  const lines = text.split('\n').filter((l) => l.trim() !== '')
  return lines.slice(0, 40).join('\n')
}
