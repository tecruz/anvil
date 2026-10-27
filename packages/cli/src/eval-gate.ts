/**
 * The eval gate.
 *
 * The harness exists to answer one question over time: does the derived context still
 * help? A single run answers it once. A gate answers it on every change, which is the
 * only way a slow, expensive harness stays honest instead of becoming a script nobody
 * runs.
 *
 * The gate is deliberately small. It compares a checked-in baseline with the latest
 * summary the harness wrote: the scenario and source hashes must match, both variants
 * must be present, and every recorded result must still meet the expectations the
 * scenario declares. When no baseline exists yet the gate passes and says so, because
 * the first run is a measurement, not a regression.
 */

import { createHash } from 'node:crypto'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'

/** The two repository sizes the matrix is required to cover. */
export type EvalScenarioSize = 'tiny' | 'medium'

/** The two ways a scenario can ask an agent to spend its turn. */
export type EvalScenarioKind = 'code-change' | 'verify-only'

/** The roles a model can play in a comparison. */
export type EvalModelRole = 'small' | 'frontier'

export interface EvalScenario {
  id: string
  size: EvalScenarioSize
  kind: EvalScenarioKind
  /** Repository the task runs in, relative to the repository root. */
  repo: string
  /** What the agent is asked to do. */
  task: string
  /** Commands that must pass after the agent finishes. */
  verify: string[]
  /** Files copied in after the agent finishes, to grade the work itself. */
  hidden?: Array<{ from: string; to: string }>
  /** Commands that grade the work, run after the hidden files are in place. */
  hiddenVerify?: string[]
  /** A canned answer for `--fake-agent`, never shown to a real model. */
  solution?: { from: string; to: string }
  /** How long the agent gets. */
  timeoutMinutes?: number
  /** What a passing run must produce. */
  expect: { verified?: boolean; hiddenVerified?: boolean }
}

export interface EvalModel {
  id: string
  role: EvalModelRole
}

export interface EvalBaselineScenario {
  id: string
  size: EvalScenarioSize
  kind: EvalScenarioKind
  scenarioHash: string
  sourceHash: string
  expect: { verified?: boolean; hiddenVerified?: boolean }
}

export interface EvalBaseline {
  schemaVersion: 1
  scenarios: EvalBaselineScenario[]
}

export interface EvalResultSummary {
  scenario: string
  size: EvalScenarioSize
  kind: EvalScenarioKind
  variant: 'bare' | 'anvil'
  model: string | null
  modelRole: EvalModelRole | null
  opencodeVersion: string | null
  scenarioHash: string
  sourceHash: string
  verified: boolean
  hiddenVerified: boolean | null
  verifyExitCodes: number[]
  error?: string
}

export interface EvalLatest {
  schemaVersion: 1
  generatedAt: string
  /**
   * Hash of the implementation that produced these results. Optional only so older
   * summaries still parse; the gate refuses a summary that does not carry one.
   */
  implementation?: string
  /**
   * The run record this summary was promoted from. Present once the run completed; the
   * gate uses it to reject summaries promoted from partial or interrupted runs.
   */
  runId?: string
  results: EvalResultSummary[]
}

/** One attempt at a scenario/variant, recorded explicitly so a resume can tell
 *  completed work from work that must be retried. */
export interface EvalRunRecordAttempt {
  startedAt: string
  completedAt: string | null
  /** `completed` when the result is trustworthy; `failed` or `timed-out` otherwise. */
  state: 'completed' | 'failed' | 'timed-out'
  error?: string
}

/** One completed scenario/variant result inside a run record. */
export interface EvalRunRecordResult {
  scenario: string
  variant: 'bare' | 'anvil'
  model: string | null
  modelRole: string | null
  /** Hash of the scenario definition this result was produced against. */
  scenarioHash: string
  /** Hash of the fixture/verifier sources this result was produced against. */
  sourceHash: string
  /** Every attempt at this key, newest last. A key is complete only when the last
   *  attempt finished in `completed` state. */
  attempts: EvalRunRecordAttempt[]
}

/** The latest attempt's state, or `null` when no attempt exists yet. */
export function latestAttemptState(result: EvalRunRecordResult): 'completed' | 'failed' | 'timed-out' | null {
  const last = result.attempts[result.attempts.length - 1]
  if (last === undefined) return null
  return last.state
}

/** The number of attempts made for a run key. */
export function attemptCount(result: EvalRunRecordResult): number {
  return result.attempts.length
}

/**
 * A benchmark run record, written separately from the checked-in `latest.json` summary.
 *
 * `latest.json` is the hermetic evidence the gate compares against a baseline. The run
 * record is the account of how that evidence was produced: what ran, in what order, and
 * whether every declared run key finished. A partial run leaves checkpoints and a run
 * record marked `partial` or `failed`, but never touches `latest.json` -- so an earlier,
 * complete run's evidence cannot be overwritten by an incomplete one.
 */
export interface EvalRunRecord {
  schemaVersion: 1
  /** Unique id for this run; checkpoint files and the summary reference it. */
  runId: string
  startedAt: string
  completedAt: string | null
  /** `completed` only when every declared run key finished; otherwise `partial` or `failed`. */
  completionState: 'in-progress' | 'completed' | 'partial' | 'failed'
  /** HEAD of the repository the run was executed against. */
  commitSha: string | null
  /** Hash of the anvil implementation that executed the run. */
  implementation: string
  /** Hash of the built CLI bundle, captured before the first scenario. */
  bundleDigest: string | null
  models: Array<{ id: string; role: string }>
  opencodeVersion: string | null
  nodeVersion: string | null
  /** The run keys (scenario/variant/model) the run was asked to produce. */
  runKeys: string[]
  /** The run keys in the order they were executed. */
  executionOrder: string[]
  /** One entry per executed scenario/variant, in completion order. */
  results: EvalRunRecordResult[]
}

export interface EvalGateResult {
  ok: boolean
  message: string
}

/**
 * Deterministic JSON, because a hash of `JSON.stringify` changes when key order changes.
 */
function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(',')}}`
  }
  return JSON.stringify(value) ?? 'null'
}

/** SHA-256 of a stable JSON encoding. */
export function hashJson(value: unknown): string {
  return createHash('sha256').update(stableStringify(value), 'utf8').digest('hex')
}

/** SHA-256 of a file's bytes. */
function hashFile(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

/** Every file under `dir`, sorted so the hash is stable across platforms. */
function filesUnder(root: string): string[] {
  const out: string[] = []
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name)
      if (entry.isDirectory()) walk(path)
      else if (entry.isFile()) out.push(path)
    }
  }
  walk(root)
  return out.sort()
}

/**
 * Hash a fixture directory.
 *
 * Path separators are normalised, because the same fixture hashes differently on Windows
 * and POSIX otherwise -- and a gate that fails only on one platform is a gate nobody
 * trusts.
 */
export function hashDirectory(dir: string): string {
  const hash = createHash('sha256')
  for (const path of filesUnder(dir)) {
    const rel = path.slice(dir.length).replace(/\\/g, '/')
    hash.update(rel)
    hash.update('\0')
    hash.update(hashFile(path))
    hash.update('\0')
  }
  return hash.digest('hex')
}

/**
 * Hash the implementation under evaluation: anvil's sources and the package metadata that
 * decides what `anvil init` emits.
 *
 * Results have to be bound to this, because a checked-in `latest.json` outlives the run
 * that produced it. Comparing results with a baseline tells you the scenarios did not
 * change; it says nothing about the code that executed them. Without this hash, a change
 * to the CLI passes the gate on evidence gathered from a different binary.
 */
export function hashImplementation(repoRoot: string): string {
  const hash = createHash('sha256')
  const add = (path: string, label: string): void => {
    hash.update(label.replace(/\\/g, '/'))
    hash.update('\0')
    hash.update(hashFile(path))
    hash.update('\0')
  }

  for (const rel of ['package.json', 'package-lock.json']) {
    const path = join(repoRoot, ...rel.split('/'))
    if (existsSync(path)) add(path, rel)
  }

  const packagesDir = join(repoRoot, 'packages')
  if (!existsSync(packagesDir)) return hash.digest('hex')
  const packageDirs = readdirSync(packagesDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => join(packagesDir, entry.name))
    .sort()
  for (const dir of packageDirs) {
    const manifest = join(dir, 'package.json')
    if (existsSync(manifest)) add(manifest, relative(repoRoot, manifest))
    const src = join(dir, 'src')
    if (!existsSync(src)) continue
    for (const path of filesUnder(src)) add(path, relative(repoRoot, path))
  }
  return hash.digest('hex')
}

/** Hash a scenario's definition, excluding fields that do not change the work. */
export function hashScenario(scenario: EvalScenario): string {
  return hashJson({
    id: scenario.id,
    size: scenario.size,
    kind: scenario.kind,
    repo: scenario.repo,
    task: scenario.task,
    verify: scenario.verify,
    hidden: scenario.hidden ?? [],
    hiddenVerify: scenario.hiddenVerify ?? [],
    solution: scenario.solution ?? null,
    timeoutMinutes: scenario.timeoutMinutes ?? null,
    expect: scenario.expect,
  })
}

/**
 * Hash everything a run is graded against: the fixture repository, the hidden verifier
 * and, when there is one, the canned answer the fake agent uses.
 *
 * `repoRoot` is the repository the harness runs from, not the fixture root; the paths in
 * a scenario are relative to it.
 */
export function hashScenarioSource(repoRoot: string, scenario: EvalScenario): string {
  const hash = createHash('sha256')
  const hashPath = (rel: string): void => {
    const path = join(repoRoot, ...rel.split('/'))
    const info = statSync(path)
    hash.update(rel.replace(/\\/g, '/'))
    hash.update('\0')
    hash.update(info.isDirectory() ? hashDirectory(path) : hashFile(path))
    hash.update('\0')
  }
  hashPath(scenario.repo)
  for (const file of scenario.hidden ?? []) hashPath(file.from)
  if (scenario.solution !== undefined) hashPath(scenario.solution.from)
  return hash.digest('hex')
}

/**
 * The matrix the eval harness promises.
 *
 * Two sizes and two kinds, one scenario each: a regression in either half is visible,
 * and a scenario that covers the same cell twice cannot silently replace the missing one.
 */
export function validateScenarioMatrix(scenarios: readonly EvalScenario[]): string | null {
  const expected = new Set(['tiny:code-change', 'tiny:verify-only', 'medium:code-change', 'medium:verify-only'])
  const seen = new Set<string>()
  const ids = new Set<string>()

  for (const scenario of scenarios) {
    if (typeof scenario.id !== 'string' || scenario.id === '') return 'a scenario has no id'
    if (ids.has(scenario.id)) return `duplicate scenario id: ${scenario.id}`
    ids.add(scenario.id)
    if (scenario.size !== 'tiny' && scenario.size !== 'medium') {
      return `${scenario.id}: size must be tiny or medium`
    }
    if (scenario.kind !== 'code-change' && scenario.kind !== 'verify-only') {
      return `${scenario.id}: kind must be code-change or verify-only`
    }
    seen.add(`${scenario.size}:${scenario.kind}`)
  }

  for (const cell of expected) {
    if (!seen.has(cell)) return `the scenario matrix is missing ${cell.replace(':', ' / ')}`
  }
  if (seen.size !== expected.size) return 'the scenario matrix has more cells than the four required ones'
  if (scenarios.length !== expected.size) return 'the scenario matrix must have exactly one scenario per cell'
  return null
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Read and parse a JSON file, or return null when it cannot be read. */
export function readJsonFile(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as unknown
  } catch {
    return null
  }
}

/** Parse a baseline, or explain why the file cannot be a baseline. */
export function parseBaseline(value: unknown): EvalBaseline | string {
  if (!isObject(value)) return 'baseline is not an object'
  if (value.schemaVersion !== 1) return 'baseline schemaVersion must be 1'
  if (!Array.isArray(value.scenarios)) return 'baseline has no scenarios list'
  const scenarios: EvalBaselineScenario[] = []
  for (const raw of value.scenarios) {
    if (!isObject(raw)) return 'baseline scenario is not an object'
    if (typeof raw.id !== 'string') return 'baseline scenario has no id'
    if (raw.size !== 'tiny' && raw.size !== 'medium') return `${raw.id}: baseline size is invalid`
    if (raw.kind !== 'code-change' && raw.kind !== 'verify-only') return `${raw.id}: baseline kind is invalid`
    if (typeof raw.scenarioHash !== 'string') return `${raw.id}: baseline scenarioHash is missing`
    if (typeof raw.sourceHash !== 'string') return `${raw.id}: baseline sourceHash is missing`
    if (!isObject(raw.expect)) return `${raw.id}: baseline expect is missing`
    scenarios.push({
      id: raw.id,
      size: raw.size,
      kind: raw.kind,
      scenarioHash: raw.scenarioHash,
      sourceHash: raw.sourceHash,
      expect: {
        ...(raw.expect.verified === undefined ? {} : { verified: raw.expect.verified === true }),
        ...(raw.expect.hiddenVerified === undefined ? {} : { hiddenVerified: raw.expect.hiddenVerified === true }),
      },
    })
  }
  return { schemaVersion: 1, scenarios }
}

/** Parse the latest summary, or explain why the file cannot be a summary. */
export function parseLatest(value: unknown): EvalLatest | string {
  if (!isObject(value)) return 'latest summary is not an object'
  if (value.schemaVersion !== 1) return 'latest summary schemaVersion must be 1'
  if (value.implementation !== undefined && typeof value.implementation !== 'string') {
    return 'latest summary implementation is invalid'
  }
  if (!Array.isArray(value.results)) return 'latest summary has no results list'
  const results: EvalResultSummary[] = []
  for (const raw of value.results) {
    if (!isObject(raw)) return 'latest result is not an object'
    if (typeof raw.scenario !== 'string') return 'latest result has no scenario id'
    if (raw.size !== 'tiny' && raw.size !== 'medium') return `${raw.scenario}: latest size is invalid`
    if (raw.kind !== 'code-change' && raw.kind !== 'verify-only') return `${raw.scenario}: latest kind is invalid`
    if (raw.variant !== 'bare' && raw.variant !== 'anvil') return `${raw.scenario}: latest variant is invalid`
    if (typeof raw.scenarioHash !== 'string') return `${raw.scenario}: latest scenarioHash is missing`
    if (typeof raw.sourceHash !== 'string') return `${raw.scenario}: latest sourceHash is missing`
    if (typeof raw.verified !== 'boolean') return `${raw.scenario}: latest verified is not a boolean`
    if (typeof raw.model !== 'string' && raw.model !== null) return `${raw.scenario}: latest model is invalid`
    if (typeof raw.opencodeVersion !== 'string' && raw.opencodeVersion !== null) {
      return `${raw.scenario}: latest opencodeVersion is invalid`
    }
    if (raw.hiddenVerified !== null && typeof raw.hiddenVerified !== 'boolean') {
      return `${raw.scenario}: latest hiddenVerified is invalid`
    }
    if (!Array.isArray(raw.verifyExitCodes)) return `${raw.scenario}: latest verifyExitCodes is missing`
    if (raw.error !== undefined && typeof raw.error !== 'string') return `${raw.scenario}: latest error is invalid`
    results.push({
      scenario: raw.scenario,
      size: raw.size,
      kind: raw.kind,
      variant: raw.variant,
      model: typeof raw.model === 'string' ? raw.model : null,
      modelRole: raw.modelRole === 'small' || raw.modelRole === 'frontier' ? raw.modelRole : null,
      opencodeVersion: typeof raw.opencodeVersion === 'string' ? raw.opencodeVersion : null,
      scenarioHash: raw.scenarioHash,
      sourceHash: raw.sourceHash,
      verified: raw.verified,
      hiddenVerified: typeof raw.hiddenVerified === 'boolean' ? raw.hiddenVerified : null,
      verifyExitCodes: raw.verifyExitCodes.filter((code): code is number => typeof code === 'number'),
      ...(typeof raw.error === 'string' ? { error: raw.error } : {}),
    })
  }
  return {
    schemaVersion: 1,
    generatedAt: typeof value.generatedAt === 'string' ? value.generatedAt : '',
    ...(typeof value.implementation === 'string' ? { implementation: value.implementation } : {}),
    results,
  }
}

/** Parse a run record, or explain why the file cannot be one. */
export function parseRunRecord(value: unknown): EvalRunRecord | string {
  if (!isObject(value)) return 'run record is not an object'
  if (value.schemaVersion !== 1) return 'run record schemaVersion must be 1'
  if (typeof value.runId !== 'string' || value.runId === '') return 'run record has no runId'
  if (typeof value.startedAt !== 'string') return 'run record startedAt is missing'
  if (
    value.completionState !== 'in-progress' &&
    value.completionState !== 'completed' &&
    value.completionState !== 'partial' &&
    value.completionState !== 'failed'
  ) {
    return 'run record completionState is invalid'
  }
  if (typeof value.implementation !== 'string' || value.implementation === '') {
    return 'run record implementation is missing'
  }
  if (!Array.isArray(value.runKeys)) return 'run record has no runKeys list'
  if (!Array.isArray(value.executionOrder)) return 'run record has no executionOrder list'
  if (!Array.isArray(value.results)) return 'run record has no results list'
  const results: EvalRunRecordResult[] = []
  for (const raw of value.results) {
    if (!isObject(raw)) return 'run record result is not an object'
    if (typeof raw.scenario !== 'string') return 'run record result has no scenario'
    if (raw.variant !== 'bare' && raw.variant !== 'anvil') return 'run record result variant is invalid'
    if (typeof raw.scenarioHash !== 'string')
      return `run record result ${raw.scenario}/${raw.variant} scenarioHash is missing`
    if (typeof raw.sourceHash !== 'string')
      return `run record result ${raw.scenario}/${raw.variant} sourceHash is missing`
    if (!Array.isArray(raw.attempts)) return `run record result ${raw.scenario}/${raw.variant} has no attempts list`
    const attempts: EvalRunRecordAttempt[] = []
    for (const attempt of raw.attempts) {
      if (!isObject(attempt)) return `run record result ${raw.scenario}/${raw.variant} attempt is not an object`
      if (typeof attempt.startedAt !== 'string')
        return `run record result ${raw.scenario}/${raw.variant} attempt startedAt is missing`
      if (attempt.state !== 'completed' && attempt.state !== 'failed' && attempt.state !== 'timed-out') {
        return `run record result ${raw.scenario}/${raw.variant} attempt state is invalid`
      }
      attempts.push({
        startedAt: attempt.startedAt,
        completedAt: typeof attempt.completedAt === 'string' ? attempt.completedAt : null,
        state: attempt.state,
        ...(typeof attempt.error === 'string' ? { error: attempt.error } : {}),
      })
    }
    results.push({
      scenario: raw.scenario,
      variant: raw.variant,
      model: typeof raw.model === 'string' ? raw.model : null,
      modelRole: typeof raw.modelRole === 'string' ? raw.modelRole : null,
      scenarioHash: raw.scenarioHash,
      sourceHash: raw.sourceHash,
      attempts,
    })
  }
  return {
    schemaVersion: 1,
    runId: value.runId,
    startedAt: value.startedAt,
    completedAt: typeof value.completedAt === 'string' ? value.completedAt : null,
    completionState: value.completionState,
    commitSha: typeof value.commitSha === 'string' ? value.commitSha : null,
    implementation: value.implementation,
    bundleDigest: typeof value.bundleDigest === 'string' ? value.bundleDigest : null,
    models: Array.isArray(value.models)
      ? value.models.filter(
          (m): m is { id: string; role: string } =>
            isObject(m) && typeof m.id === 'string' && typeof m.role === 'string',
        )
      : [],
    opencodeVersion: typeof value.opencodeVersion === 'string' ? value.opencodeVersion : null,
    nodeVersion: typeof value.nodeVersion === 'string' ? value.nodeVersion : null,
    runKeys: value.runKeys.filter((k): k is string => typeof k === 'string'),
    executionOrder: value.executionOrder.filter((k): k is string => typeof k === 'string'),
    results,
  }
}

/**
 * Validate that a run record is complete and compatible with the current implementation.
 *
 * A run record that is `partial` or `failed` means the run did not finish -- its checkpoints
 * exist but they must not be promoted to `latest.json`. A record whose implementation does
 * not match the current source means the code changed under the run and the evidence is
 * invalidated.
 */
export function checkRunRecord(
  record: EvalRunRecord | null | undefined,
  currentImplementation: string,
  requiredKeys: string[],
): EvalGateResult {
  if (record === null || record === undefined) {
    return {
      ok: false,
      message: 'no run record exists; the latest summary cannot be trusted without one',
    }
  }
  if (record.completionState !== 'completed') {
    return {
      ok: false,
      message: `run ${record.runId} did not complete (state: ${record.completionState}); the latest summary must not be promoted from an incomplete run`,
    }
  }
  if (record.implementation !== currentImplementation) {
    return {
      ok: false,
      message: `run ${record.runId} evaluated implementation ${record.implementation.slice(0, 12)} but the current source hashes to ${currentImplementation.slice(0, 12)}; the implementation changed under the run`,
    }
  }
  const executed = new Set(record.executionOrder)
  for (const key of requiredKeys) {
    if (!executed.has(key)) {
      return {
        ok: false,
        message: `run ${record.runId} never executed ${key}; the run record is incomplete`,
      }
    }
  }
  const completed = record.results
    .filter((r) => latestAttemptState(r) === 'completed')
    .map((r) => `${r.scenario}/${r.variant}`)
  const missing = requiredKeys.filter((key) => !completed.includes(key))
  if (missing.length > 0) {
    return {
      ok: false,
      message: `run ${record.runId} did not complete ${missing.join(', ')}; the run record is incomplete`,
    }
  }
  return {
    ok: true,
    message: `run ${record.runId} completed all ${requiredKeys.length} declared run keys`,
  }
}

/**
 * Check whether resuming this run record is compatible with the current source.
 *
 * Resume must match the implementation, fixtures (scenario and source hashes),
 * models, and requested run keys exactly. A mismatch means the completed results
 * were produced under different inputs and must not be reused.
 */
export function checkRunRecordCompatibility(
  record: EvalRunRecord | null | undefined,
  currentImplementation: string,
  currentScenarioHashes: Record<string, { scenarioHash: string; sourceHash: string }>,
  currentModels: Array<{ id: string; role: string }>,
): EvalGateResult {
  if (record === null || record === undefined) {
    return {
      ok: false,
      message: 'no run record exists to resume',
    }
  }
  if (record.implementation !== currentImplementation) {
    return {
      ok: false,
      message: `run ${record.runId} evaluated implementation ${record.implementation.slice(0, 12)} but the current source hashes to ${currentImplementation.slice(0, 12)}; cannot resume`,
    }
  }
  const recordModels = JSON.stringify(record.models)
  const currentModelsJson = JSON.stringify(currentModels)
  if (recordModels !== currentModelsJson) {
    return {
      ok: false,
      message: `run ${record.runId} used models ${recordModels} but the requested models are ${currentModelsJson}; cannot resume`,
    }
  }
  for (const result of record.results) {
    const expected = currentScenarioHashes[result.scenario]
    if (expected === undefined) continue
    if (result.scenarioHash !== expected.scenarioHash) {
      return {
        ok: false,
        message: `run ${record.runId} scenario ${result.scenario} hashes to ${result.scenarioHash.slice(0, 12)} but the current fixture hashes to ${expected.scenarioHash.slice(0, 12)}; the fixture changed, cannot resume`,
      }
    }
    if (result.sourceHash !== expected.sourceHash) {
      return {
        ok: false,
        message: `run ${record.runId} scenario ${result.scenario} source hashes to ${result.sourceHash.slice(0, 12)} but the current source hashes to ${expected.sourceHash.slice(0, 12)}; cannot resume`,
      }
    }
  }
  return {
    ok: true,
    message: `run ${record.runId} is compatible with the current source and models`,
  }
}

/** The declared run keys implied by a latest summary: `scenario/variant` per result. */
function latestRunKeys(latest: EvalLatest): string[] {
  return latest.results.map((result) => `${result.scenario}/${result.variant}`)
}

/**
 * Compare the latest summary with the baseline.
 *
 * A result is checked per scenario, not per model: every model that ran the scenario has
 * to meet the expectation, because a regression that only affects the small model is
 * still a regression.
 *
 * `current` is the scenario matrix as it exists on disk. When it is supplied, the gate
 * also fails when the baseline no longer describes it: a scenario that changed after the
 * last `--write-baseline` must not pass just because the last *run* still matches the old
 * baseline.
 */
export function checkEvalGate(
  baseline: EvalBaseline,
  latest: EvalLatest,
  current?: readonly EvalBaselineScenario[],
  currentImplementation?: string,
  runRecord?: EvalRunRecord | null,
): EvalGateResult {
  const failures: string[] = []

  // A latest summary must be traceable to a completed run record. An incomplete or
  // missing run record means the evidence was produced by an interrupted run and must
  // not pass the gate. The check only runs when a run record is explicitly supplied;
  // callers that do not pass one keep the previous behaviour.
  if (currentImplementation !== undefined && latest.results.length > 0 && runRecord !== undefined) {
    const recordCheck = checkRunRecord(runRecord ?? null, currentImplementation, latestRunKeys(latest))
    if (!recordCheck.ok) failures.push(recordCheck.message)
    else if (
      latest.runId !== undefined &&
      runRecord !== null &&
      runRecord !== undefined &&
      runRecord.runId !== latest.runId
    ) {
      failures.push(`latest summary references run ${latest.runId} but the run record is ${runRecord.runId}`)
    }
  }

  if (currentImplementation !== undefined) {
    if (latest.implementation === undefined) {
      failures.push('the latest run does not record which implementation it evaluated')
    } else if (latest.implementation !== currentImplementation) {
      failures.push(
        'the latest run evaluated a different implementation; re-run the eval harness and commit the new summary',
      )
    }
  }

  if (current !== undefined) {
    const byId = new Map(current.map((scenario) => [scenario.id, scenario]))
    for (const scenario of baseline.scenarios) {
      const now = byId.get(scenario.id)
      if (now === undefined) {
        failures.push(`${scenario.id}: the scenario was removed without updating the baseline`)
        continue
      }
      if (now.size !== scenario.size || now.kind !== scenario.kind) {
        failures.push(`${scenario.id}: the scenario size or kind changed without updating the baseline`)
      }
      if (now.scenarioHash !== scenario.scenarioHash) {
        failures.push(`${scenario.id}: the scenario changed without updating the baseline`)
      }
      if (now.sourceHash !== scenario.sourceHash) {
        failures.push(`${scenario.id}: the fixture or verifier changed without updating the baseline`)
      }
      if (
        now.expect.verified !== scenario.expect.verified ||
        now.expect.hiddenVerified !== scenario.expect.hiddenVerified
      ) {
        failures.push(`${scenario.id}: the expectation changed without updating the baseline`)
      }
    }
    const baselineIds = new Set(baseline.scenarios.map((scenario) => scenario.id))
    for (const scenario of current) {
      if (!baselineIds.has(scenario.id)) {
        failures.push(`${scenario.id}: the scenario was added without updating the baseline`)
      }
    }
  }

  const byScenario = new Map<string, EvalResultSummary[]>()
  for (const result of latest.results) {
    const list = byScenario.get(result.scenario) ?? []
    list.push(result)
    byScenario.set(result.scenario, list)
  }

  for (const scenario of baseline.scenarios) {
    const results = byScenario.get(scenario.id) ?? []
    if (results.length === 0) {
      failures.push(`${scenario.id}: no result in the latest run`)
      continue
    }
    const variants = new Set(results.map((result) => result.variant))
    if (!variants.has('bare')) failures.push(`${scenario.id}: the latest run has no bare result`)
    if (!variants.has('anvil')) failures.push(`${scenario.id}: the latest run has no anvil result`)
    if (results.some((r) => r.scenarioHash !== scenario.scenarioHash)) {
      failures.push(`${scenario.id}: the scenario changed without updating the baseline`)
    }
    if (results.some((r) => r.sourceHash !== scenario.sourceHash)) {
      failures.push(`${scenario.id}: the fixture or verifier changed without updating the baseline`)
    }
    if (scenario.expect.verified === true && results.some((r) => !r.verified)) {
      failures.push(`${scenario.id}: a run did not pass the visible verifier`)
    }
    if (scenario.expect.hiddenVerified === true && results.some((r) => r.hiddenVerified !== true)) {
      failures.push(`${scenario.id}: a run did not pass the hidden verifier`)
    }
    if (results.some((r) => r.error !== undefined)) {
      failures.push(
        `${scenario.id}: a run encountered an agent error: ${results.find((r) => r.error !== undefined)?.error}`,
      )
    }
  }

  const baselineIds = new Set(baseline.scenarios.map((s) => s.id))
  for (const id of byScenario.keys()) {
    if (!baselineIds.has(id)) failures.push(`${id}: the latest run has a scenario the baseline does not`)
  }

  if (failures.length > 0) {
    return {
      ok: false,
      message: `eval gate failed:\n  - ${failures.join('\n  - ')}`,
    }
  }
  return { ok: true, message: 'eval gate passed: every scenario met its baseline.' }
}
