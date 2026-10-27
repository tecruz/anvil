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
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
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
  checkEvalGate,
  checkRunRecordCompatibility,
  type EvalBaseline,
  type EvalBaselineScenario,
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
  readJsonFile,
  validateScenarioMatrix,
} from '../packages/cli/src/eval-gate.ts'
import { tokenizeCommand } from '../packages/core/src/args.ts'
import { probeCommandVersion, spawnArgv } from '../packages/core/src/exec.ts'
import { readAgentSession } from '../packages/worktrees/src/index.ts'

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(here, '..')
const resultsDir = join(repoRoot, 'eval-results')
const rawDir = join(resultsDir, 'raw')
const latestPath = join(resultsDir, 'latest.json')
const baselinePath = join(resultsDir, 'baseline.json')
const runRecordPath = join(resultsDir, 'run.json')
const checkpointsDir = join(resultsDir, 'checkpoints')

/** Transcript publication policy.
 *
 * Transcripts are never published by default: the checked-in `latest.json` carries
 * structured metadata and verdicts only. `--publish-transcripts` opts in, and even then
 * transcripts are redacted and size-limited before they touch disk or an artifact.
 */
/** Maximum transcript bytes retained per scenario/variant. Larger transcripts are
 *  truncated, not dropped, so a failure still shows its tail. */
const MAX_TRANSCRIPT_BYTES = 64 * 1024
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

/** Size-limit a transcript, keeping the head and tail so failures remain readable. */
export function limitTranscript(text: string): string {
  const bytes = Buffer.byteLength(text, 'utf8')
  if (bytes <= MAX_TRANSCRIPT_BYTES) return text
  const half = Math.floor(MAX_TRANSCRIPT_BYTES / 2)
  const head = Buffer.from(text, 'utf8').subarray(0, half).toString('utf8')
  const tail = Buffer.from(text, 'utf8').subarray(-half).toString('utf8')
  return `${head}\n\n... [transcript truncated, ${bytes} bytes total] ...\n\n${tail}`
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

interface ScenarioResult extends EvalResultSummary {
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
  const enabled = process.env.ANVIL_EVAL === '1'

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
  const selectedScenarios = only === null ? scenarios : scenarios.filter((s) => s.id === only)
  if (selectedScenarios.length === 0) {
    console.error(`No scenario matched ${only ?? '(nothing)'}`)
    process.exit(1)
  }
  // A subset selection (--scenario) remains explicitly partial: it must not overwrite
  // valid complete evidence with a success-looking report covering only part of the matrix.
  const isSubset = selectedScenarios.length !== scenarios.length

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
    process.exit(runCheck(scenarios))
  }

  // The gate hashes the source, so the harness must run that same source -- not a stale
  // checked-in bundle. Rebuild the CLI before evaluating so what executes is what is hashed.
  ensureCliBuilt()

  // `--resume` continues an existing run: it validates that the implementation, fixtures,
  // models, and requested run keys still match, skips keys that already completed, and
  // retries only the incomplete ones. Each attempt is recorded explicitly; a failure is
  // never silently retried until it passes.
  let runRecord: EvalRunRecord
  let runId: string
  let startedAt: string
  const incompleteKeys: string[] = []
  const declaredKeys: string[] = []
  for (const _model of models) {
    for (const scenario of selectedScenarios) {
      for (const variant of VARIANTS) {
        declaredKeys.push(`${scenario.id}/${variant}/${_model.id}`)
      }
    }
  }
  const bundlePath = join(repoRoot, 'packages', 'cli', 'dist', 'cli.js')
  const bundleDigest = existsSync(bundlePath)
    ? createHash('sha256').update(readFileSync(bundlePath)).digest('hex')
    : null
  if (resume && existsSync(runRecordPath)) {
    const raw = readJsonFile(runRecordPath)
    const parsed = parseRunRecord(raw)
    if (typeof parsed === 'string') {
      console.error(`Cannot resume: ${parsed}`)
      process.exit(1)
    }
    const compatibility = checkRunRecordCompatibility(
      parsed,
      hashImplementation(repoRoot),
      Object.fromEntries(
        selectedScenarios.map((s) => [
          s.id,
          { scenarioHash: hashScenario(s), sourceHash: hashScenarioSource(repoRoot, s) },
        ]),
      ),
      models,
      bundleDigest,
      fakeAgent ? null : await probeCommandVersion('opencode'),
    )
    if (!compatibility.ok) {
      console.error(compatibility.message)
      process.exit(1)
    }
    runRecord = parsed
    runId = runRecord.runId
    startedAt = runRecord.startedAt
    // Recover any completed checkpoints that were never recorded in run.json (for example
    // because the run.json write failed after a checkpoint was written). A checkpoint file
    // is authoritative evidence that a result completed, even if run.json does not yet know
    // about it.
    const checkpointDir = join(checkpointsDir, runId)
    if (existsSync(checkpointDir)) {
      for (const file of readdirSync(checkpointDir)) {
        if (!file.endsWith('.json')) continue
        const checkpointRaw = readJsonFile(join(checkpointDir, file))
        if (typeof checkpointRaw !== 'object' || checkpointRaw === null) continue
        const checkpoint = checkpointRaw as EvalRunRecordResult
        if (!checkpoint.scenario || !checkpoint.variant || !checkpoint.model) continue
        const key = `${checkpoint.scenario}/${checkpoint.variant}/${checkpoint.model}`
        const alreadyRecorded = runRecord.results.some(
          (r) => r.scenario === checkpoint.scenario && r.variant === checkpoint.variant && r.model === checkpoint.model,
        )
        if (alreadyRecorded) continue
        const completedState: EvalRunRecordResult = {
          scenario: checkpoint.scenario,
          variant: checkpoint.variant,
          model: checkpoint.model,
          modelRole: checkpoint.modelRole,
          scenarioHash: checkpoint.scenarioHash,
          sourceHash: checkpoint.sourceHash,
          verified: checkpoint.verified,
          hiddenVerified: checkpoint.hiddenVerified,
          verifyExitCodes: checkpoint.verifyExitCodes,
          costUsd: checkpoint.costUsd,
          tokens: checkpoint.tokens,
          durationMs: checkpoint.durationMs,
          transcript: checkpoint.transcript,
          ...(checkpoint.error === undefined ? {} : { error: checkpoint.error }),
          attempts: checkpoint.attempts,
        }
        runRecord.results.push(completedState)
        runRecord.executionOrder.push(key)
        console.log(`Recovered completed checkpoint for ${key} from a previous interrupted run.`)
      }
    }
    const completed = new Set(
      runRecord.results
        .filter((r) => latestAttemptState(r) === 'completed')
        .map((r) => `${r.scenario}/${r.variant}/${r.model}`),
    )
    for (const key of declaredKeys) {
      if (!completed.has(key)) incompleteKeys.push(key)
    }
    if (incompleteKeys.length === 0) {
      console.log(`Run ${runId} already completed all ${declaredKeys.length} keys; nothing to resume.`)
      runRecord.completedAt = new Date().toISOString()
      runRecord.completionState = 'completed'
      writeRunRecord(runRecord)
      printSummary([])
      process.exit(0)
    }
    console.log(`Resuming run ${runId}: ${incompleteKeys.length} of ${declaredKeys.length} keys remain.`)
  } else {
    runId = randomUUID()
    startedAt = new Date().toISOString()
    const commitSha = readCommitSha()
    const implementationBefore = hashImplementation(repoRoot)
    runRecord = {
      schemaVersion: 1,
      runId,
      startedAt,
      completedAt: null,
      completionState: 'in-progress',
      commitSha,
      implementation: implementationBefore,
      bundleDigest,
      models,
      opencodeVersion: fakeAgent ? null : await probeCommandVersion('opencode'),
      nodeVersion: process.version,
      runKeys: declaredKeys,
      executionOrder: [],
      results: [],
    }
    writeRunRecord(runRecord)
  }
  const implementationBefore = runRecord.implementation
  const opencodeVersion = runRecord.opencodeVersion

  const results: ScenarioResult[] = []
  let allCompleted = true
  const completedKeys = new Set(
    runRecord.results
      .filter((r) => latestAttemptState(r) === 'completed')
      .map((r) => `${r.scenario}/${r.variant}/${r.model}`),
  )
  // Rehydrate completed results from the run record so a resume promotes every
  // previously completed result, not only the ones this invocation runs.
  for (const prior of runRecord.results) {
    if (latestAttemptState(prior) !== 'completed') continue
    const scenario = selectedScenarios.find((s) => s.id === prior.scenario)
    results.push({
      scenario: prior.scenario,
      size: scenario?.size ?? 'tiny',
      kind: scenario?.kind ?? 'code-change',
      variant: prior.variant,
      model: prior.model,
      modelRole: prior.modelRole as EvalModelRole | null,
      opencodeVersion: runRecord.opencodeVersion,
      scenarioHash: prior.scenarioHash,
      sourceHash: prior.sourceHash,
      verified: prior.verified,
      hiddenVerified: prior.hiddenVerified,
      verifyExitCodes: prior.verifyExitCodes,
      costUsd: prior.costUsd,
      tokens: prior.tokens,
      durationMs: prior.durationMs,
      transcript: prior.transcript,
      ...(prior.error === undefined ? {} : { error: prior.error }),
    })
  }
  for (const model of models) {
    for (const scenario of selectedScenarios) {
      const scenarioHash = hashScenario(scenario)
      const sourceHash = hashScenarioSource(repoRoot, scenario)
      for (const variant of VARIANTS) {
        const key = `${scenario.id}/${variant}/${model.id}`
        // A key that already completed is not re-run: resume picks up incomplete work,
        // it does not silently rerun finished results until they pass.
        if (completedKeys.has(key)) continue

        const result = await runScenario(
          scenario,
          variant,
          model,
          scenarioHash,
          sourceHash,
          opencodeVersion,
          fakeAgent,
          publishTranscripts,
        )
        results.push(result)

        // Redact secrets before checkpointing: errors and verifier output can carry
        // credentials, and checkpoints are uploaded as artifacts.
        const sanitizedResult: ScenarioResult = {
          ...result,
        }
        if (result.error !== undefined) {
          sanitizedResult.error = redactTranscript(result.error)
        }
        if (result.verifyOutput !== undefined) {
          sanitizedResult.verifyOutput = redactTranscript(result.verifyOutput)
        }

        // Checkpoint the attempt immediately, before the next scenario starts. A crash
        // or timeout after this point leaves this attempt readable, and latest.json is
        // never overwritten by an incomplete run.
        const attempt: EvalRunRecordAttempt = {
          startedAt: new Date().toISOString(),
          completedAt: new Date().toISOString(),
          state: result.error === undefined ? 'completed' : 'failed',
          ...(result.error === undefined ? {} : { error: result.error }),
        }
        const existing = runRecord.results.find(
          (r) => r.scenario === scenario.id && r.variant === variant && r.model === model.id,
        )
        if (existing === undefined) {
          const checkpoint: EvalRunRecordResult = {
            scenario: sanitizedResult.scenario,
            variant: sanitizedResult.variant,
            model: sanitizedResult.model,
            modelRole: sanitizedResult.modelRole,
            scenarioHash,
            sourceHash,
            verified: sanitizedResult.verified,
            hiddenVerified: sanitizedResult.hiddenVerified,
            verifyExitCodes: sanitizedResult.verifyExitCodes,
            costUsd: sanitizedResult.costUsd,
            tokens: sanitizedResult.tokens,
            durationMs: sanitizedResult.durationMs,
            transcript: sanitizedResult.transcript,
            ...(sanitizedResult.error === undefined ? {} : { error: sanitizedResult.error }),
            attempts: [attempt],
          }
          writeCheckpoint(runId, checkpoint)
          runRecord.executionOrder.push(key)
          runRecord.results.push(checkpoint)
        } else {
          // A retry replaces the previous attempt's verdicts and metadata with the latest
          // attempt's, so the run record never mixes a failed attempt's verdict with a
          // completed attempt's metadata.
          existing.attempts.push(attempt)
          existing.verified = sanitizedResult.verified
          existing.hiddenVerified = sanitizedResult.hiddenVerified
          existing.verifyExitCodes = sanitizedResult.verifyExitCodes
          existing.costUsd = sanitizedResult.costUsd
          existing.tokens = sanitizedResult.tokens
          existing.durationMs = sanitizedResult.durationMs
          existing.transcript = sanitizedResult.transcript
          if (sanitizedResult.error !== undefined) {
            existing.error = sanitizedResult.error
          }
          writeCheckpoint(runId, existing)
        }
        if (attempt.state !== 'completed') allCompleted = false
        writeRunRecord(runRecord)
      }
    }
  }

  // The implementation and bundle are hashed again after the run: if either changed under
  // the run, the results were produced by a different binary than the one committed.
  const implementationAfter = hashImplementation(repoRoot)
  const bundlePathAfter = join(repoRoot, 'packages', 'cli', 'dist', 'cli.js')
  const bundleDigestAfter = existsSync(bundlePathAfter)
    ? createHash('sha256').update(readFileSync(bundlePathAfter)).digest('hex')
    : null

  let completionState: EvalRunRecord['completionState']
  if (implementationBefore !== implementationAfter || bundleDigest !== bundleDigestAfter) {
    completionState = 'failed'
  } else if (!allCompleted) {
    completionState = 'partial'
  } else if (isSubset) {
    // A subset selection is explicitly partial: it promotes only the keys it ran and must
    // not overwrite valid complete evidence with a success-looking partial report.
    completionState = 'partial'
  } else {
    // Recheck every completed result's scenario and source hashes against the current
    // fixtures. Reload the scenario matrix from disk so a definition that changed mid-run
    // is detected, not the in-memory object captured before the run started.
    const currentScenarios = loadScenarios()
    let fixtureChanged = false
    for (const prior of runRecord.results) {
      if (latestAttemptState(prior) !== 'completed') continue
      const scenario = currentScenarios.find((s) => s.id === prior.scenario)
      if (scenario === undefined) continue
      const expected = {
        scenarioHash: hashScenario(scenario),
        sourceHash: hashScenarioSource(repoRoot, scenario),
      }
      if (prior.scenarioHash !== expected.scenarioHash || prior.sourceHash !== expected.sourceHash) {
        fixtureChanged = true
        break
      }
    }
    completionState = fixtureChanged ? 'failed' : 'completed'
  }

  runRecord.completedAt = new Date().toISOString()
  runRecord.completionState = completionState
  runRecord.implementation = implementationBefore
  writeRunRecord(runRecord)

  // Only promote latest.json when the full declared run completed without the
  // implementation changing. An interrupted run leaves checkpoints and a partial run
  // record, but latest.json keeps the last complete summary.
  if (completionState === 'completed') {
    writeReport(results, runId)
  } else {
    console.log(`Run ${runId} finished in state ${completionState}; eval-results/latest.json is unchanged.`)
  }

  printSummary(results)
  if (writeBaselineAfterRun) writeBaseline(scenarios)

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
): Promise<ScenarioResult> {
  const workdir = mkdtempSync(join(tmpdir(), `anvil-eval-${scenario.id}-${variant}-`))
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
    verified: false,
    hiddenVerified: null,
    verifyExitCodes: [],
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

    if (fake) {
      if (scenario.solution !== undefined) {
        cpSync(join(repoRoot, scenario.solution.from), join(workdir, ...scenario.solution.to.split('/')))
        result.transcript = publishTranscripts
          ? limitTranscript(
              redactTranscript(`[fake-agent] applied ${scenario.solution.from} to ${scenario.solution.to}`),
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
      const agentArgs = ['run', '--standalone', '--auto', '--model', model.id]
      agentArgs.push(`Read ${TASK_FILE} and follow every instruction in it exactly.`)
      const agent = await run('opencode', agentArgs, workdir, {
        timeoutMs: (scenario.timeoutMinutes ?? 10) * 60_000,
      })
      result.transcript = publishTranscripts
        ? limitTranscript(redactTranscript(`${agent.stdout}\n${agent.stderr}`.trim()))
        : ''
      if (agent.timedOut) {
        result.error = 'the agent timed out'
      } else if (!agent.ok) {
        result.error = `the agent exited with code ${agent.code ?? '?'}`
      }
    }

    const visible = await runAll(scenario.verify, workdir)
    result.verified = visible.every((r) => r.ok)
    result.verifyExitCodes = visible.map((r) => r.code ?? -1)
    result.verifyOutput = visible.map((r) => r.output).join('\n')

    if (scenario.hidden !== undefined && scenario.hidden.length > 0) {
      for (const file of scenario.hidden) {
        cpSync(join(repoRoot, file.from), join(workdir, ...file.to.split('/')), { recursive: true })
      }
      const hidden = await runAll(scenario.hiddenVerify ?? [], workdir)
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

export async function run(
  bin: string,
  args: string[],
  cwd: string,
  options: { timeoutMs?: number } = {},
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
      env: { ...process.env, PWD: cwd },
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

function writeReport(results: ScenarioResult[], runId?: string): void {
  mkdirSync(rawDir, { recursive: true })
  const generatedAt = new Date().toISOString()
  const implementation = hashImplementation(repoRoot)
  const stamp = generatedAt.replace(/[:.]/g, '-')
  const rawPath = join(rawDir, `eval-${stamp}.json`)
  // Sanitize every result before it lands in the raw report: transcripts and verifier
  // output can carry secrets, and the raw upload is world-readable.
  const sanitized = results.map((result) => ({
    ...result,
    transcript: redactTranscript(result.transcript),
    verifyOutput: result.verifyOutput === undefined ? undefined : redactTranscript(result.verifyOutput),
    error: result.error === undefined ? undefined : redactTranscript(result.error),
  }))
  atomicWriteJson(rawPath, { generatedAt, implementation, results: sanitized })
  console.log(`\nReport written to ${rawPath}`)

  const latest: {
    schemaVersion: 1
    generatedAt: string
    implementation: string
    runId?: string
    results: EvalResultSummary[]
  } = {
    schemaVersion: 1,
    generatedAt,
    implementation,
    ...(runId === undefined ? {} : { runId }),
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
    verified: result.verified,
    hiddenVerified: result.hiddenVerified,
    verifyExitCodes: result.verifyExitCodes,
    ...(result.error === undefined ? {} : { error: result.error }),
  }
}

function writeBaseline(scenarios: readonly EvalScenario[]): void {
  const baseline: EvalBaseline = {
    schemaVersion: 1,
    scenarios: scenarios.map((scenario) => ({
      id: scenario.id,
      size: scenario.size,
      kind: scenario.kind,
      scenarioHash: hashScenario(scenario),
      sourceHash: hashScenarioSource(repoRoot, scenario),
      expect: scenario.expect,
    })),
  }
  writeFileSync(baselinePath, `${formatJson(baseline)}\n`, 'utf8')
  console.log(`Baseline written to ${baselinePath}`)
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

/** Atomically checkpoint a single completed scenario/variant result. */
function writeCheckpoint(runId: string, result: EvalRunRecordResult): void {
  const dir = join(checkpointsDir, runId)
  mkdirSync(dir, { recursive: true })
  const path = join(dir, `${result.scenario}-${result.variant}-${result.model}.json`)
  atomicWriteJson(path, result)
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
    if (value.every(primitive)) return `[${value.map((item) => JSON.stringify(item)).join(', ')}]`
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

  // A latest summary must be traceable to a completed run record. Read the run record
  // so the gate can reject summaries promoted from partial or interrupted runs.
  let runRecord: EvalRunRecord | null = null
  if (existsSync(runRecordPath)) {
    const runRecordRaw = readJsonFile(runRecordPath)
    const parsed = parseRunRecord(runRecordRaw)
    runRecord = typeof parsed === 'string' ? null : parsed
  }

  // The baseline has to describe the matrix on disk, not only the last run. Without this
  // half, editing a fixture after `--write-baseline` and never running the harness again
  // would pass, because `latest.json` and `baseline.json` would still agree with each other.
  const current: EvalBaselineScenario[] = scenarios.map((scenario) => ({
    id: scenario.id,
    size: scenario.size,
    kind: scenario.kind,
    scenarioHash: hashScenario(scenario),
    sourceHash: hashScenarioSource(repoRoot, scenario),
    expect: scenario.expect,
  }))
  const gate = checkEvalGate(baseline, latest, current, hashImplementation(repoRoot), runRecord)
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
