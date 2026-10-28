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

/** Version 1 remains readable; version 2 adds verifier declarations; version 3 adds
 *  repetition/counterbalancing for paired comparisons. */
export const EVAL_SCHEMA_VERSION = 3
export type EvalSchemaVersion = 1 | 2 | 3

/** Authoritative verifier declarations, supplied from the selected scenario matrix. */
export interface EvalVerifierScenario {
  id: string
  verify: readonly string[] | null
  hiddenVerify?: readonly string[] | null
}

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
  /** Commands that must pass after the agent finishes. */
  verify: string[] | null
  /** Commands that grade the work after hidden files are in place. */
  hiddenVerify: string[] | null
  expect: { verified?: boolean; hiddenVerified?: boolean }
}

export interface EvalBaseline {
  schemaVersion: EvalSchemaVersion
  scenarios: EvalBaselineScenario[]
}

/** The fixture fingerprints captured when a run starts. */
export type EvalFixtureHashes = Record<string, { scenarioHash: string; sourceHash: string }>

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
  /** How many visible verifier commands the scenario declares. */
  verifyCount: number | null
  /** How many hidden verifier commands ran, or zero when the scenario has none. */
  hiddenVerifyCount: number | null
  verified: boolean
  hiddenVerified: boolean | null
  verifyExitCodes: number[]
  error?: string
  /** Which repetition of the scenario this result belongs to, starting at 0. */
  repetition: number | null
}

export interface EvalLatest {
  schemaVersion: EvalSchemaVersion
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
  /** How many repetitions of each scenario were run. */
  repetitions: number
  /** The seed used to determine repetition/counterbalancing order. */
  seed: string | null
  /** The variant ordering policy applied across repetitions. */
  order: string | null
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
  /** How many visible verifier commands the scenario declares. */
  verifyCount: number | null
  /** How many hidden verifier commands ran, or zero when the scenario has none. */
  hiddenVerifyCount: number | null
  /** Every attempt at this key, newest last. A key is complete only when the last
   *  attempt finished in `completed` state. */
  attempts: EvalRunRecordAttempt[]
  /** Whether the visible verifier passed on the last completed attempt. */
  verified: boolean
  /** Whether the hidden verifier passed on the last completed attempt. */
  hiddenVerified: boolean | null
  /** Exit codes from every verifier run on the last completed attempt: visible first,
   *  then hidden. `verifyCount + hiddenVerifyCount` must equal this list's length. */
  verifyExitCodes: number[]
  /** What the run cost, when the ledger knows. */
  costUsd: number | null
  /** Total tokens, including cache reads and writes when the ledger counts them. */
  tokens: number | null
  /** How long the last completed attempt took, in milliseconds. */
  durationMs: number
  /** The agent's transcript from the last completed attempt. */
  transcript: string
  /** Any agent error from the last completed attempt. */
  error?: string
  /** Which repetition of the scenario this result belongs to, starting at 0. */
  repetition: number | null
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
  schemaVersion: EvalSchemaVersion
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
  /**
   * Hash of the harness source. The implementation hash covers `packages/`, not the
   * harness itself, so resume and the gate need this to notice a changed policy.
   */
  harnessDigest: string | null
  models: Array<{ id: string; role: string }>
  opencodeVersion: string | null
  nodeVersion: string | null
  /** Whether transcripts were published when this run was created. */
  publishTranscripts: boolean
  /**
   * True when `--scenario` selected less than the full matrix. A subset can never be
   * promoted as complete evidence, even after every one of its keys finishes.
   */
  subset: boolean
  /** Fingerprints for every scenario in the run's matrix, captured before the first
   *  scenario. This covers not-yet-started scenarios that have no result to carry a hash. */
  scenarioHashes: EvalFixtureHashes | null
  /** How many repetitions of each scenario were run. */
  repetitions: number
  /** The seed used to determine repetition/counterbalancing order. */
  seed: string | null
  /** The variant ordering policy applied across repetitions. */
  order: string | null
  /** The run keys (scenario/variant/model/repetition) the run was asked to produce. */
  runKeys: string[]
  /** The run keys in the order they were executed. */
  executionOrder: string[]
  /** One entry per executed scenario/variant/repetition, in completion order. */
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
    const cell = `${scenario.size}:${scenario.kind}`
    if (seen.has(cell)) {
      return `${scenario.id}: the matrix allows exactly one scenario per cell; ${scenario.size} / ${scenario.kind} is already covered`
    }
    seen.add(cell)
  }

  for (const cell of expected) {
    if (!seen.has(cell)) return `the scenario matrix is missing ${cell.replace(':', ' / ')}`
  }
  // Allow additional scenarios beyond the four required cells (Phase 2B).
  // Extra scenarios must have a unique size/kind combination that is not already covered.
  if (seen.size < expected.size) return 'the scenario matrix must cover all four required cells'
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
  if (value.schemaVersion !== 1 && value.schemaVersion !== 2 && value.schemaVersion !== 3)
    return 'baseline schemaVersion must be 1, 2 or 3'
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
    const verify = value.schemaVersion === 1 && raw.verify == null ? null : raw.verify
    if (verify !== null && (!Array.isArray(verify) || !verify.every((v): v is string => typeof v === 'string'))) {
      return `${raw.id}: baseline verify is invalid`
    }
    if (value.schemaVersion === 2 && verify === null) return `${raw.id}: baseline verify is invalid`
    const hiddenVerify = value.schemaVersion === 1 && raw.hiddenVerify == null ? null : raw.hiddenVerify
    if (
      hiddenVerify !== null &&
      (!Array.isArray(hiddenVerify) || !hiddenVerify.every((v): v is string => typeof v === 'string'))
    ) {
      return `${raw.id}: baseline hiddenVerify is invalid`
    }
    if (value.schemaVersion === 2 && hiddenVerify === null) return `${raw.id}: baseline hiddenVerify is invalid`
    scenarios.push({
      id: raw.id,
      size: raw.size,
      kind: raw.kind,
      scenarioHash: raw.scenarioHash,
      sourceHash: raw.sourceHash,
      verify,
      hiddenVerify,
      expect: {
        ...(raw.expect.verified === undefined ? {} : { verified: raw.expect.verified === true }),
        ...(raw.expect.hiddenVerified === undefined || raw.expect.hiddenVerified === null
          ? {}
          : { hiddenVerified: raw.expect.hiddenVerified === true }),
      },
    })
  }
  return { schemaVersion: value.schemaVersion, scenarios }
}

/**
 * Parse a verifier exit-code list.
 *
 * Invalid elements are rejected rather than filtered: silently dropping a corrupt entry
 * turns a malformed record into a passing one.
 */
function parseExitCodes(value: unknown): number[] | null {
  if (!Array.isArray(value)) return null
  if (!value.every((code): code is number => typeof code === 'number' && Number.isInteger(code))) return null
  return [...value]
}

/** Parse a non-negative command count, or null when it is not one. */
function parseCount(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) return null
  return value
}

/** Parse a fixture-fingerprint map, or explain why it is not one. */
function parseFixtureHashes(value: unknown): EvalFixtureHashes | string {
  if (!isObject(value)) return 'run record has no scenarioHashes map'
  const hashes: EvalFixtureHashes = {}
  for (const [scenario, raw] of Object.entries(value)) {
    if (scenario === '') return 'run record scenarioHashes has an empty scenario id'
    if (!isObject(raw)) return `run record scenarioHashes for ${scenario} is invalid`
    if (typeof raw.scenarioHash !== 'string' || raw.scenarioHash === '') {
      return `run record scenarioHashes for ${scenario} has no scenarioHash`
    }
    if (typeof raw.sourceHash !== 'string' || raw.sourceHash === '') {
      return `run record scenarioHashes for ${scenario} has no sourceHash`
    }
    hashes[scenario] = { scenarioHash: raw.scenarioHash, sourceHash: raw.sourceHash }
  }
  return hashes
}

/** Parse the latest summary, or explain why the file cannot be a summary. */
export function parseLatest(value: unknown): EvalLatest | string {
  if (!isObject(value)) return 'latest summary is not an object'
  if (value.schemaVersion !== 1 && value.schemaVersion !== 2 && value.schemaVersion !== 3)
    return 'latest summary schemaVersion must be 1, 2 or 3'
  if (value.implementation !== undefined && typeof value.implementation !== 'string') {
    return 'latest summary implementation is invalid'
  }
  if (!Array.isArray(value.results)) return 'latest summary has no results list'
  const repetitions = parseCount(value.repetitions)
  if (repetitions === null && !(value.schemaVersion === 1 || value.schemaVersion === 2)) {
    return 'latest summary repetitions is invalid'
  }
  if (repetitions === null && value.schemaVersion === 3) {
    return 'latest summary repetitions is invalid'
  }
  const finalRepetitions = repetitions ?? 1
  const seed = typeof value.seed === 'string' ? value.seed : null
  const order = typeof value.order === 'string' ? value.order : null
  const results: EvalResultSummary[] = []
  for (const raw of value.results) {
    if (!isObject(raw)) return 'latest result is not an object'
    if (typeof raw.scenario !== 'string') return 'latest result has no scenario id'
    if (raw.size !== 'tiny' && raw.size !== 'medium') return `${raw.scenario}: latest size is invalid`
    if (raw.kind !== 'code-change' && raw.kind !== 'verify-only') return `${raw.scenario}: latest kind is invalid`
    if (raw.variant !== 'bare' && raw.variant !== 'anvil') return `${raw.scenario}: latest variant is invalid`
    if (typeof raw.scenarioHash !== 'string') return `${raw.scenario}: latest scenarioHash is missing`
    if (typeof raw.sourceHash !== 'string') return `${raw.scenario}: latest sourceHash is missing`
    const verifyCount = parseCount(raw.verifyCount)
    if (verifyCount === null && !(value.schemaVersion === 1 && raw.verifyCount == null)) {
      return `${raw.scenario}: latest verifyCount is invalid`
    }
    const hiddenVerifyCount = parseCount(raw.hiddenVerifyCount)
    if (hiddenVerifyCount === null && !(value.schemaVersion === 1 && raw.hiddenVerifyCount == null)) {
      return `${raw.scenario}: latest hiddenVerifyCount is invalid`
    }
    const repetition = parseCount(raw.repetition)
    if (repetition === null && !(value.schemaVersion === 1 || value.schemaVersion === 2)) {
      return `${raw.scenario}: latest repetition is invalid`
    }
    if (typeof raw.verified !== 'boolean') return `${raw.scenario}: latest verified is not a boolean`
    if (typeof raw.model !== 'string' && raw.model !== null) return `${raw.scenario}: latest model is invalid`
    if (typeof raw.opencodeVersion !== 'string' && raw.opencodeVersion !== null) {
      return `${raw.scenario}: latest opencodeVersion is invalid`
    }
    if (raw.hiddenVerified !== null && typeof raw.hiddenVerified !== 'boolean') {
      return `${raw.scenario}: latest hiddenVerified is invalid`
    }
    if (!Array.isArray(raw.verifyExitCodes)) return `${raw.scenario}: latest verifyExitCodes is missing`
    const verifyExitCodes = parseExitCodes(raw.verifyExitCodes)
    if (verifyExitCodes === null) return `${raw.scenario}: latest verifyExitCodes is invalid`
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
      verifyCount,
      hiddenVerifyCount,
      verified: raw.verified,
      hiddenVerified: typeof raw.hiddenVerified === 'boolean' ? raw.hiddenVerified : null,
      verifyExitCodes,
      repetition,
      ...(typeof raw.error === 'string' ? { error: raw.error } : {}),
    })
  }
  return {
    schemaVersion: value.schemaVersion,
    generatedAt: typeof value.generatedAt === 'string' ? value.generatedAt : '',
    ...(typeof value.implementation === 'string' ? { implementation: value.implementation } : {}),
    ...(typeof value.runId === 'string' ? { runId: value.runId } : {}),
    repetitions: finalRepetitions,
    seed,
    order,
    results,
  }
}

/** Parse one run-record result, or explain why it cannot be one. */
export function parseRunRecordResult(
  value: unknown,
  schemaVersion: EvalSchemaVersion = 1,
): EvalRunRecordResult | string {
  if (!isObject(value)) return 'run record result is not an object'
  if (typeof value.scenario !== 'string' || value.scenario === '') return 'run record result has no scenario'
  if (value.variant !== 'bare' && value.variant !== 'anvil') return 'run record result variant is invalid'
  if (typeof value.model !== 'string' && value.model !== null) return 'run record result model is invalid'
  if (typeof value.modelRole !== 'string' && value.modelRole !== null) {
    return 'run record result modelRole is invalid'
  }
  const key = `${value.scenario}/${value.variant}`
  if (typeof value.scenarioHash !== 'string' || value.scenarioHash === '') {
    return `run record result ${key} scenarioHash is missing`
  }
  if (typeof value.sourceHash !== 'string' || value.sourceHash === '') {
    return `run record result ${key} sourceHash is missing`
  }
  const verifyCount = parseCount(value.verifyCount)
  if (verifyCount === null && !(schemaVersion === 1 && value.verifyCount == null)) {
    return `run record result ${key} verifyCount is invalid`
  }
  const hiddenVerifyCount = parseCount(value.hiddenVerifyCount)
  if (hiddenVerifyCount === null && !(schemaVersion === 1 && value.hiddenVerifyCount == null)) {
    return `run record result ${key} hiddenVerifyCount is invalid`
  }
  const repetition = parseCount(value.repetition)
  if (repetition === null && !(schemaVersion === 1 || schemaVersion === 2)) {
    return `run record result ${key} repetition is invalid`
  }
  // For v1/v2, repetition can be null (unknown); for v3 it must be present and non-null
  if (!Array.isArray(value.attempts)) return `run record result ${key} has no attempts list`
  const attempts: EvalRunRecordAttempt[] = []
  for (const attempt of value.attempts) {
    if (!isObject(attempt)) return `run record result ${key} attempt is not an object`
    if (typeof attempt.startedAt !== 'string') return `run record result ${key} attempt startedAt is missing`
    if (attempt.state !== 'completed' && attempt.state !== 'failed' && attempt.state !== 'timed-out') {
      return `run record result ${key} attempt state is invalid`
    }
    if (attempt.completedAt !== undefined && attempt.completedAt !== null && typeof attempt.completedAt !== 'string') {
      return `run record result ${key} attempt completedAt is invalid`
    }
    if (attempt.error !== undefined && typeof attempt.error !== 'string') {
      return `run record result ${key} attempt error is invalid`
    }
    attempts.push({
      startedAt: attempt.startedAt,
      completedAt: typeof attempt.completedAt === 'string' ? attempt.completedAt : null,
      state: attempt.state,
      ...(typeof attempt.error === 'string' ? { error: attempt.error } : {}),
    })
  }
  if (!Array.isArray(value.verifyExitCodes)) return `run record result ${key} verifyExitCodes is missing`
  const verifyExitCodes = parseExitCodes(value.verifyExitCodes)
  if (verifyExitCodes === null) return `run record result ${key} verifyExitCodes is invalid`
  if (typeof value.verified !== 'boolean') return `run record result ${key} verified is not a boolean`
  if (value.hiddenVerified !== null && typeof value.hiddenVerified !== 'boolean') {
    return `run record result ${key} hiddenVerified is invalid`
  }
  if (value.error !== undefined && typeof value.error !== 'string') {
    return `run record result ${key} error is invalid`
  }
  return {
    scenario: value.scenario,
    variant: value.variant,
    model: typeof value.model === 'string' ? value.model : null,
    modelRole: typeof value.modelRole === 'string' ? value.modelRole : null,
    scenarioHash: value.scenarioHash,
    sourceHash: value.sourceHash,
    verifyCount,
    hiddenVerifyCount,
    attempts,
    verified: value.verified,
    hiddenVerified: typeof value.hiddenVerified === 'boolean' ? value.hiddenVerified : null,
    verifyExitCodes,
    repetition,
    costUsd: typeof value.costUsd === 'number' && Number.isFinite(value.costUsd) ? value.costUsd : null,
    tokens: typeof value.tokens === 'number' && Number.isFinite(value.tokens) ? value.tokens : null,
    durationMs: typeof value.durationMs === 'number' && Number.isFinite(value.durationMs) ? value.durationMs : 0,
    transcript: typeof value.transcript === 'string' ? value.transcript : '',
    ...(typeof value.error === 'string' ? { error: value.error } : {}),
  }
}

/** Parse a run record, or explain why the file cannot be one. */
export function parseRunRecord(value: unknown): EvalRunRecord | string {
  if (!isObject(value)) return 'run record is not an object'
  if (value.schemaVersion !== 1 && value.schemaVersion !== 2 && value.schemaVersion !== 3)
    return 'run record schemaVersion must be 1, 2 or 3'
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
  if (!Array.isArray(value.models)) return 'run record has no models list'
  const models: Array<{ id: string; role: string }> = []
  for (const model of value.models) {
    if (!isObject(model) || typeof model.id !== 'string' || model.id === '' || typeof model.role !== 'string') {
      return 'run record model is invalid'
    }
    models.push({ id: model.id, role: model.role })
  }
  if (value.publishTranscripts !== undefined && typeof value.publishTranscripts !== 'boolean') {
    return 'run record publishTranscripts is invalid'
  }
  if (value.subset !== undefined && typeof value.subset !== 'boolean') {
    return 'run record subset is invalid'
  }
  const repetitions = parseCount(value.repetitions)
  if (repetitions === null && !(value.schemaVersion === 1 || value.schemaVersion === 2)) {
    return 'run record repetitions is invalid'
  }
  if (repetitions === null && value.schemaVersion === 3) {
    return 'run record repetitions is invalid'
  }
  const finalRepetitions = repetitions ?? 1
  const seed = typeof value.seed === 'string' ? value.seed : null
  const order = typeof value.order === 'string' ? value.order : null
  const scenarioHashes =
    value.schemaVersion === 1 && value.scenarioHashes == null ? null : parseFixtureHashes(value.scenarioHashes)
  if (typeof scenarioHashes === 'string') return scenarioHashes
  const results: EvalRunRecordResult[] = []
  for (const raw of value.results) {
    const parsed = parseRunRecordResult(raw, value.schemaVersion)
    if (typeof parsed === 'string') return parsed
    results.push(parsed)
  }
  return {
    schemaVersion: value.schemaVersion,
    runId: value.runId,
    startedAt: value.startedAt,
    completedAt: typeof value.completedAt === 'string' ? value.completedAt : null,
    completionState: value.completionState,
    commitSha: typeof value.commitSha === 'string' ? value.commitSha : null,
    implementation: value.implementation,
    bundleDigest: typeof value.bundleDigest === 'string' ? value.bundleDigest : null,
    harnessDigest: typeof value.harnessDigest === 'string' ? value.harnessDigest : null,
    models,
    opencodeVersion: typeof value.opencodeVersion === 'string' ? value.opencodeVersion : null,
    nodeVersion: typeof value.nodeVersion === 'string' ? value.nodeVersion : null,
    publishTranscripts: value.publishTranscripts === true,
    subset: value.subset === true,
    repetitions: finalRepetitions,
    seed,
    order,
    scenarioHashes,
    runKeys: value.runKeys.filter((k): k is string => typeof k === 'string'),
    executionOrder: value.executionOrder.filter((k): k is string => typeof k === 'string'),
    results,
  }
}

/** Stable, filesystem-safe checkpoint filename for one result.
 *
 * Model IDs contain `/` (`provider/model`), so the filename is encoded rather than joined
 * raw: a raw join creates nested directories that direct-child discovery never finds.
 * The repetition is included so repeated runs of the same scenario/variant/model do not
 * overwrite each other.
 */
export function checkpointFileName(
  result: Pick<EvalRunRecordResult, 'scenario' | 'variant' | 'model' | 'repetition'>,
): string {
  const parts = [result.scenario, result.variant, result.model ?? 'unknown', String(result.repetition)].map((part) =>
    encodeURIComponent(part),
  )
  return `${parts.join('--')}.json`
}

/** One checkpoint read from disk, with the timestamp used to order recovery. */
export interface EvalCheckpointEntry {
  result: EvalRunRecordResult
  modifiedMs: number
}

/**
 * Read every checkpoint under a checkpoint directory, recursively.
 *
 * A malformed checkpoint is reported, not cast into evidence. Direct-child discovery was
 * wrong once model IDs started containing `/`; recursion keeps that fixed.
 */
export function readCheckpointDirectory(directory: string): {
  entries: EvalCheckpointEntry[]
  rejected: string[]
} {
  const entries: EvalCheckpointEntry[] = []
  const rejected: string[] = []
  if (!existsSync(directory)) return { entries, rejected }
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name)
      if (entry.isDirectory()) {
        walk(path)
        continue
      }
      if (!entry.isFile() || !entry.name.endsWith('.json')) continue
      const raw = readJsonFile(path)
      const schemaVersion = isObject(raw) ? (raw.schemaVersion ?? 1) : 1
      if (schemaVersion !== 1 && schemaVersion !== 2 && schemaVersion !== 3) {
        rejected.push(`${entry.name}: checkpoint schemaVersion must be 1, 2 or 3`)
        continue
      }
      const parsed = parseRunRecordResult(raw, schemaVersion)
      if (typeof parsed === 'string') {
        rejected.push(`${entry.name}: ${parsed}`)
        continue
      }
      entries.push({ result: parsed, modifiedMs: statSync(path).mtimeMs })
    }
  }
  walk(directory)
  return { entries, rejected }
}

/**
 * Check that a result's verdicts agree with its verifier exit codes.
 *
 * `verifyExitCodes` holds the visible commands first and the hidden commands after them,
 * so the counts are what distinguish "the visible verifier failed" from "the hidden
 * verifier failed". Checking only the first code lets `[0, 1]` pass as verified and lets an
 * empty list pass as verified without running anything.
 */
function verifierEvidenceProblem(
  result: {
    verified: boolean
    hiddenVerified: boolean | null
    verifyCount: number | null
    hiddenVerifyCount: number | null
    verifyExitCodes: readonly number[]
  },
  scenario: EvalVerifierScenario | undefined,
): string | null {
  if (result.verifyCount === null || result.hiddenVerifyCount === null) {
    return 'has unknown verifier counts; regenerate version 2 evidence'
  }
  const visible = result.verifyExitCodes.slice(0, result.verifyCount)
  const hidden = result.verifyExitCodes.slice(result.verifyCount)
  if (result.verified && visible.length === 0) {
    return 'is verified without a visible verifier'
  }
  if (result.verified && !visible.every((code) => code === 0)) {
    return 'is verified with a failing visible verifier'
  }
  if (!result.verified && result.verifyCount > 0 && visible.every((code) => code === 0)) {
    return 'is not verified although its visible verifier passed'
  }
  if (result.hiddenVerifyCount === 0) {
    if (result.hiddenVerified !== null) {
      return 'reports a hidden verdict without hidden verifier commands'
    }
  } else if (result.hiddenVerified !== hidden.every((code) => code === 0)) {
    return 'has a hidden verdict that disagrees with its exit codes'
  }
  if (result.verifyExitCodes.length !== result.verifyCount + result.hiddenVerifyCount) {
    return `reports ${result.verifyExitCodes.length} verifier exit codes but declares ${
      result.verifyCount + result.hiddenVerifyCount
    } verifier commands`
  }
  if (scenario === undefined) return 'has no authoritative scenario verifier definition'
  if (scenario.verify === null || scenario.hiddenVerify === null) {
    return 'has unknown scenario verifier definitions; supply the current matrix or regenerate the baseline'
  }
  if (result.verifyCount !== scenario.verify.length) {
    return `reports ${result.verifyCount} visible verifier commands but the scenario defines ${scenario.verify.length}`
  }
  const hiddenCount = scenario.hiddenVerify?.length ?? 0
  if (result.hiddenVerifyCount !== hiddenCount) {
    return `reports ${result.hiddenVerifyCount} hidden verifier commands but the scenario defines ${hiddenCount}`
  }
  return null
}

/**
 * Reconcile checkpoints written before a run-record write succeeded.
 *
 * A checkpoint whose latest attempt completed, whose key belongs to this run, and whose
 * scenario/source hashes match the current fixtures is usable evidence. A newer checkpoint
 * (more attempts) replaces a stale record entry; an older or equal one never does. A newer
 * checkpoint whose latest attempt failed is still adopted so the retry keeps the failure
 * in its history and the key is not mistaken for complete.
 */
export function reconcileRunRecord(
  record: EvalRunRecord,
  checkpoints: readonly EvalCheckpointEntry[],
  currentScenarioHashes: Record<string, { scenarioHash: string; sourceHash: string }>,
  scenarios: readonly EvalVerifierScenario[],
): { record: EvalRunRecord; changed: boolean; rejected: string[] } {
  const next: EvalRunRecord = {
    ...record,
    runKeys: [...record.runKeys],
    executionOrder: [...record.executionOrder],
    results: record.results.map((result) => ({ ...result, attempts: [...result.attempts] })),
  }
  const rejected: string[] = []
  const declared = new Set(next.runKeys)
  const modelIds = new Set(next.models.map((model) => model.id))
  const scenarioById = new Map(scenarios.map((scenario) => [scenario.id, scenario]))
  let changed = false
  const ordered = [...checkpoints].sort((a, b) => a.modifiedMs - b.modifiedMs)
  for (const { result } of ordered) {
    const key = resultKey(result)
    if (!declared.has(key)) {
      rejected.push(`${key}: checkpoint is not a declared key for this run`)
      continue
    }
    if (result.model === null || !modelIds.has(result.model)) {
      rejected.push(`${key}: checkpoint model is not part of this run`)
      continue
    }
    // A failed or timed-out attempt is retried on resume, never recovered as evidence.
    // It is still adopted when it is newer than the recorded result: otherwise a retry
    // would overwrite the checkpoint with only its own attempt and lose the failure that
    // happened after the last run.json write.
    if (latestAttemptState(result) === null) {
      rejected.push(`${key}: checkpoint has no attempts`)
      continue
    }
    if (latestAttemptState(result) === 'completed') {
      const last = result.attempts[result.attempts.length - 1]
      if (last === undefined || last.completedAt === null) {
        rejected.push(`${key}: completed checkpoint has no completion timestamp`)
        continue
      }
      if (last.error !== undefined || result.error !== undefined) {
        rejected.push(`${key}: completed checkpoint carries an error`)
        continue
      }
      const evidence = verifierEvidenceProblem(result, scenarioById.get(result.scenario))
      if (evidence !== null) {
        rejected.push(`${key}: completed checkpoint ${evidence}`)
        continue
      }
    }
    const expected = currentScenarioHashes[result.scenario]
    if (expected === undefined) {
      rejected.push(`${key}: scenario is not part of the current matrix`)
      continue
    }
    if (result.scenarioHash !== expected.scenarioHash || result.sourceHash !== expected.sourceHash) {
      rejected.push(`${key}: checkpoint hashes do not match the current fixtures`)
      continue
    }
    const index = next.results.findIndex((entry) => resultKey(entry) === key)
    // Only a checkpoint with strictly more attempts can replace a recorded result. Using
    // mtime or an equal attempt count could resurrect an older success over a newer
    // failure, which is precisely the kind of evidence mixing resume must refuse.
    if (index !== -1 && result.attempts.length <= next.results[index]!.attempts.length) continue
    if (index === -1) {
      next.results.push(result)
      if (!next.executionOrder.includes(key)) next.executionOrder.push(key)
    } else {
      next.results[index] = result
    }
    changed = true
  }
  return { record: next, changed, rejected }
}

/** Every declared key has a completed result and nothing else does. */
export function allDeclaredCompleted(record: EvalRunRecord): boolean {
  if (record.runKeys.length === 0) return false
  const completed = record.results.filter((result) => latestAttemptState(result) === 'completed').map(resultKey)
  if (new Set(completed).size !== completed.length) return false
  const completedSet = new Set(completed)
  return completedSet.size === record.runKeys.length && record.runKeys.every((key) => completedSet.has(key))
}

/** The first completed result whose fixtures no longer match, or null. */
export function recordFixtureProblem(
  record: EvalRunRecord,
  currentScenarioHashes: Record<string, { scenarioHash: string; sourceHash: string }>,
): string | null {
  for (const result of record.results) {
    if (latestAttemptState(result) !== 'completed') continue
    const expected = currentScenarioHashes[result.scenario]
    if (expected === undefined) {
      return `run ${record.runId} recorded scenario ${result.scenario}, which is no longer in the current matrix`
    }
    if (result.scenarioHash !== expected.scenarioHash || result.sourceHash !== expected.sourceHash) {
      return `run ${record.runId} recorded ${result.scenario} against different fixtures; the scenario or fixture changed`
    }
  }
  return null
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
  currentHarnessDigest: string | null | undefined,
  scenarios: readonly EvalVerifierScenario[],
): EvalGateResult {
  if (record === null || record === undefined) {
    return {
      ok: false,
      message: 'no run record exists; the latest summary cannot be trusted without one',
    }
  }
  if (record.schemaVersion !== EVAL_SCHEMA_VERSION || record.scenarioHashes === null) {
    return { ok: false, message: `run ${record.runId} is legacy evidence; regenerate a version 2 run before promotion` }
  }
  if (record.completionState !== 'completed') {
    return {
      ok: false,
      message: `run ${record.runId} did not complete (state: ${record.completionState}); the latest summary must not be promoted from an incomplete run`,
    }
  }
  if (record.subset) {
    return {
      ok: false,
      message: `run ${record.runId} is a subset run; it cannot be promoted as complete evidence`,
    }
  }
  if (record.completedAt === null) {
    return {
      ok: false,
      message: `run ${record.runId} is marked completed but has no completion timestamp`,
    }
  }
  if (record.harnessDigest === null) {
    return {
      ok: false,
      message: `run ${record.runId} does not record the harness that produced it`,
    }
  }
  if (currentHarnessDigest !== undefined) {
    if (currentHarnessDigest === null) {
      return {
        ok: false,
        message: 'the current harness could not be fingerprinted; its evidence cannot be trusted',
      }
    }
    if (record.harnessDigest !== currentHarnessDigest) {
      return {
        ok: false,
        message: `run ${record.runId} was produced by harness ${record.harnessDigest.slice(0, 12)} but the current harness hashes to ${currentHarnessDigest.slice(0, 12)}; the harness changed`,
      }
    }
  }
  if (record.implementation !== currentImplementation) {
    return {
      ok: false,
      message: `run ${record.runId} evaluated implementation ${record.implementation.slice(0, 12)} but the current source hashes to ${currentImplementation.slice(0, 12)}; the implementation changed under the run`,
    }
  }
  const declared = record.runKeys
  if (new Set(declared).size !== declared.length) {
    return {
      ok: false,
      message: `run ${record.runId} declares duplicate run keys; the run record is corrupt`,
    }
  }
  const declaredSet = new Set(declared)
  for (const key of requiredKeys) {
    if (!declaredSet.has(key)) {
      return {
        ok: false,
        message: `run ${record.runId} never executed ${key}; the run record is incomplete`,
      }
    }
  }
  const requiredSet = new Set(requiredKeys)
  for (const key of declared) {
    if (!requiredSet.has(key)) {
      return {
        ok: false,
        message: `run ${record.runId} declares ${key}, which is not part of the completed matrix; the run record is incomplete`,
      }
    }
  }
  const executed = record.executionOrder
  if (new Set(executed).size !== executed.length) {
    return {
      ok: false,
      message: `run ${record.runId} execution order contains duplicates; the run record is corrupt`,
    }
  }
  if (executed.length !== declared.length || executed.some((key) => !declaredSet.has(key))) {
    return {
      ok: false,
      message: `run ${record.runId} execution order does not match declared run keys; the run record is corrupt`,
    }
  }
  const recorded = record.results.map(resultKey)
  if (new Set(recorded).size !== recorded.length) {
    return {
      ok: false,
      message: `run ${record.runId} records duplicate results; the run record is corrupt`,
    }
  }
  const recordedSet = new Set(recorded)
  for (const key of declared) {
    if (!recordedSet.has(key)) {
      return {
        ok: false,
        message: `run ${record.runId} did not execute ${key}; the run record is incomplete`,
      }
    }
  }
  for (const key of recordedSet) {
    if (!declaredSet.has(key)) {
      return {
        ok: false,
        message: `run ${record.runId} recorded ${key}, which was never declared; the run record is corrupt`,
      }
    }
  }
  const scenarioById = new Map(scenarios.map((scenario) => [scenario.id, scenario]))
  for (const result of record.results) {
    const key = resultKey(result)
    if (latestAttemptState(result) !== 'completed') {
      return {
        ok: false,
        message: `run ${record.runId} did not complete ${key}; the run record is incomplete`,
      }
    }
    const last = result.attempts[result.attempts.length - 1]
    if (last === undefined || last.completedAt === null) {
      return {
        ok: false,
        message: `run ${record.runId} completed ${key} without a completion timestamp; the run record is incomplete`,
      }
    }
    if (last.error !== undefined || result.error !== undefined) {
      return {
        ok: false,
        message: `run ${record.runId} completed ${key} but recorded an error; the run record is contradictory`,
      }
    }
    const fixture = record.scenarioHashes[result.scenario]
    if (fixture === undefined) {
      return {
        ok: false,
        message: `run ${record.runId} has no fixture fingerprint for ${result.scenario}; the run record is corrupt`,
      }
    }
    if (result.scenarioHash !== fixture.scenarioHash || result.sourceHash !== fixture.sourceHash) {
      return {
        ok: false,
        message: `run ${record.runId} recorded ${key} against fixtures that disagree with the run's captured fingerprints; the run record is contradictory`,
      }
    }
    const evidence = verifierEvidenceProblem(result, scenarioById.get(result.scenario))
    if (evidence !== null) {
      return {
        ok: false,
        message: `run ${record.runId} recorded ${key} but it ${evidence}; the run record is contradictory`,
      }
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
/** Everything a resumed run has to agree with, captured as one value so a new input
 *  cannot be forgotten at a call site. */
export interface EvalResumeConfig {
  implementation: string
  scenarioHashes: Record<string, { scenarioHash: string; sourceHash: string }>
  scenarios: readonly EvalVerifierScenario[]
  models: Array<{ id: string; role: string }>
  bundleDigest: string | null
  harnessDigest: string | null
  opencodeVersion: string | null
  publishTranscripts: boolean
  /** How many repetitions of each scenario were run. Defaults to 1. */
  repetitions?: number
}

export function checkRunRecordCompatibility(
  record: EvalRunRecord | null | undefined,
  config: EvalResumeConfig,
): EvalGateResult {
  if (record === null || record === undefined) {
    return {
      ok: false,
      message: 'no run record exists to resume',
    }
  }
  if (record.schemaVersion !== EVAL_SCHEMA_VERSION || record.scenarioHashes === null) {
    return { ok: false, message: `run ${record.runId} is legacy evidence; start a version 2 run instead of resuming` }
  }
  if (record.implementation !== config.implementation) {
    return {
      ok: false,
      message: `run ${record.runId} evaluated implementation ${record.implementation.slice(0, 12)} but the current source hashes to ${config.implementation.slice(0, 12)}; cannot resume`,
    }
  }
  if (record.bundleDigest !== config.bundleDigest) {
    return {
      ok: false,
      message: `run ${record.runId} built bundle ${record.bundleDigest?.slice(0, 12) ?? 'none'} but the current bundle hashes to ${config.bundleDigest?.slice(0, 12) ?? 'none'}; cannot resume`,
    }
  }
  if (record.harnessDigest === null || config.harnessDigest === null) {
    return {
      ok: false,
      message: `run ${record.runId} does not record the harness that produced it; cannot resume safely`,
    }
  }
  if (record.harnessDigest !== config.harnessDigest) {
    return {
      ok: false,
      message: `run ${record.runId} was produced by a different harness (${record.harnessDigest.slice(0, 12)} != ${config.harnessDigest.slice(0, 12)}); cannot resume`,
    }
  }
  if (record.nodeVersion === null) {
    return {
      ok: false,
      message: `run ${record.runId} does not record the Node version it used; cannot resume safely`,
    }
  }
  if (record.nodeVersion !== process.version) {
    return {
      ok: false,
      message: `run ${record.runId} used Node ${record.nodeVersion} but the current Node is ${process.version}; cannot resume`,
    }
  }
  if (record.opencodeVersion !== config.opencodeVersion) {
    return {
      ok: false,
      message: `run ${record.runId} used OpenCode ${record.opencodeVersion ?? 'unknown'} but the current OpenCode is ${config.opencodeVersion ?? 'unknown'}; cannot resume`,
    }
  }
  if (record.publishTranscripts !== config.publishTranscripts) {
    return {
      ok: false,
      message: `run ${record.runId} ${record.publishTranscripts ? 'published' : 'did not publish'} transcripts but this invocation ${config.publishTranscripts ? 'does' : 'does not'}; cannot resume`,
    }
  }
  if (new Set(record.runKeys).size !== record.runKeys.length) {
    return {
      ok: false,
      message: `run ${record.runId} declares duplicate run keys; cannot resume`,
    }
  }
  const recordedKeys = record.results.map(resultKey)
  if (new Set(recordedKeys).size !== recordedKeys.length) {
    return {
      ok: false,
      message: `run ${record.runId} records duplicate results; cannot resume`,
    }
  }
  const recordModels = JSON.stringify(record.models)
  const currentModelsJson = JSON.stringify(config.models)
  if (recordModels !== currentModelsJson) {
    return {
      ok: false,
      message: `run ${record.runId} used models ${recordModels} but the requested models are ${currentModelsJson}; cannot resume`,
    }
  }
  if (record.repetitions !== config.repetitions) {
    return {
      ok: false,
      message: `run ${record.runId} ran ${record.repetitions} repetitions but this invocation requests ${config.repetitions}; cannot resume`,
    }
  }
  const repetitions = config.repetitions ?? 1
  const currentKeys = new Set(
    config.models.flatMap((model) =>
      Object.keys(config.scenarioHashes).flatMap((scenario) =>
        ['bare', 'anvil'].flatMap((variant) =>
          Array.from(
            { length: repetitions },
            (_, repetitionIndex) => `${scenario}/${variant}/${model.id}/${repetitionIndex}`,
          ),
        ),
      ),
    ),
  )
  const recordKeys = new Set(record.runKeys)
  for (const key of currentKeys) {
    if (!recordKeys.has(key)) {
      return {
        ok: false,
        message: `run ${record.runId} did not declare ${key}; cannot resume with a different key set`,
      }
    }
  }
  for (const key of recordKeys) {
    if (!currentKeys.has(key)) {
      return {
        ok: false,
        message: `run ${record.runId} declared ${key} which is not in the requested keys; cannot resume`,
      }
    }
  }
  // Compare the fixtures captured when the run started, not only the results that
  // happen to exist. A scenario that has not started yet has no result to carry a hash,
  // so without this check changing its fixture would let resume continue under the old
  // run id and promote evidence produced against two different matrices.
  for (const [scenario, expected] of Object.entries(config.scenarioHashes)) {
    const recorded = record.scenarioHashes[scenario]
    if (recorded === undefined) {
      return {
        ok: false,
        message: `run ${record.runId} does not record fixture hashes for ${scenario}; cannot resume safely`,
      }
    }
    if (recorded.scenarioHash !== expected.scenarioHash) {
      return {
        ok: false,
        message: `run ${record.runId} scenario ${scenario} hashes to ${recorded.scenarioHash.slice(0, 12)} but the current fixture hashes to ${expected.scenarioHash.slice(0, 12)}; the fixture changed, cannot resume`,
      }
    }
    if (recorded.sourceHash !== expected.sourceHash) {
      return {
        ok: false,
        message: `run ${record.runId} scenario ${scenario} source hashes to ${recorded.sourceHash.slice(0, 12)} but the current source hashes to ${expected.sourceHash.slice(0, 12)}; cannot resume`,
      }
    }
  }
  for (const scenario of Object.keys(record.scenarioHashes)) {
    if (!(scenario in config.scenarioHashes)) {
      return {
        ok: false,
        message: `run ${record.runId} recorded scenario ${scenario}, which is not in the requested matrix; cannot resume`,
      }
    }
  }
  const scenarioById = new Map(config.scenarios.map((scenario) => [scenario.id, scenario]))
  for (const result of record.results) {
    const expected = config.scenarioHashes[result.scenario]
    if (expected === undefined) {
      return {
        ok: false,
        message: `run ${record.runId} recorded scenario ${result.scenario}, which is not in the requested matrix; cannot resume`,
      }
    }
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
    if (latestAttemptState(result) === 'completed') {
      const evidence = verifierEvidenceProblem(result, scenarioById.get(result.scenario))
      if (evidence !== null) {
        return {
          ok: false,
          message: `run ${record.runId} recorded ${result.scenario} but it ${evidence}; cannot resume`,
        }
      }
    }
  }
  return {
    ok: true,
    message: `run ${record.runId} is compatible with the current source, harness, and models`,
  }
}

/** The stable key for one scenario/variant/model/repetition result. */
export function resultKey(result: Pick<EvalResultSummary, 'scenario' | 'variant' | 'model' | 'repetition'>): string {
  return `${result.scenario}/${result.variant}/${result.model ?? 'unknown'}/${result.repetition}`
}

/** The declared run keys implied by a latest summary: `scenario/variant/model/repetition` per result. */
function latestRunKeys(latest: EvalLatest): string[] {
  return latest.results.map(resultKey)
}

/** Compare two exit-code lists in order, without sorting or mutating either input. */
function sameExitCodes(left: readonly number[], right: readonly number[]): boolean {
  if (left.length !== right.length) return false
  for (let i = 0; i < left.length; i += 1) {
    if (left[i] !== right[i]) return false
  }
  return true
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
  currentHarnessDigest?: string | null,
): EvalGateResult {
  const failures: string[] = []
  const verifierScenarios = current ?? baseline.scenarios
  const verifierById = new Map(verifierScenarios.map((scenario) => [scenario.id, scenario]))
  if (latest.schemaVersion !== EVAL_SCHEMA_VERSION) {
    failures.push('the latest summary is legacy evidence; regenerate version 2 evidence')
  }

  // A latest summary must be traceable to a completed run record. An incomplete or
  // missing run record means the evidence was produced by an interrupted run and must
  // not pass the gate. The check only runs when a run record is explicitly supplied;
  // callers that do not pass one keep the previous behaviour.
  if (currentImplementation !== undefined && latest.results.length > 0 && runRecord !== undefined) {
    const record = runRecord ?? null
    const recordCheck = checkRunRecord(
      record,
      currentImplementation,
      latestRunKeys(latest),
      currentHarnessDigest,
      verifierScenarios,
    )
    if (!recordCheck.ok) {
      failures.push(recordCheck.message)
    }
    if (record !== null) {
      if (latest.runId === undefined) {
        failures.push(`latest summary does not reference a run but the run record is ${record.runId}`)
      } else if (record.runId !== latest.runId) {
        failures.push(`latest summary references run ${latest.runId} but the run record is ${record.runId}`)
      }
      // The record's captured fixtures must still describe the matrix on disk. This is
      // what notices a fixture edited after the run started, even when the summary and
      // baseline were both generated from the old fixture.
      if (current !== undefined) {
        for (const scenario of current) {
          const recorded = record.scenarioHashes?.[scenario.id]
          if (recorded === undefined) {
            failures.push(`run ${record.runId} has no fixture fingerprint for ${scenario.id}`)
            continue
          }
          if (recorded.scenarioHash !== scenario.scenarioHash || recorded.sourceHash !== scenario.sourceHash) {
            failures.push(
              `run ${record.runId} recorded ${scenario.id} against different fixtures than the current matrix`,
            )
          }
        }
      }
    }
    if (record !== null && recordCheck.ok) {
      const summaryKeys = new Set(latest.results.map(resultKey))
      const recordKeys = new Set(record.results.filter((r) => latestAttemptState(r) === 'completed').map(resultKey))
      for (const key of summaryKeys) {
        if (!recordKeys.has(key)) {
          failures.push(`latest summary reports ${key} but the run record has no completed result for it`)
        }
      }
      for (const key of recordKeys) {
        if (!summaryKeys.has(key)) {
          failures.push(`run record completed ${key} but the latest summary does not report it`)
        }
      }
      // The summary and run record must agree on verdicts, errors, and hashes for every
      // completed result. Every disagreement is reported; an early return would hide some.
      const byRecordKey = new Map(
        record.results.filter((r) => latestAttemptState(r) === 'completed').map((r) => [resultKey(r), r]),
      )
      for (const summaryResult of latest.results) {
        const key = resultKey(summaryResult)
        const recordResult = byRecordKey.get(key)
        if (recordResult === undefined) continue
        if (summaryResult.verified !== recordResult.verified) {
          failures.push(
            `${key}: summary verified=${summaryResult.verified} but run record verified=${recordResult.verified}`,
          )
        }
        if (summaryResult.hiddenVerified !== recordResult.hiddenVerified) {
          failures.push(
            `${key}: summary hiddenVerified=${summaryResult.hiddenVerified} but run record hiddenVerified=${recordResult.hiddenVerified}`,
          )
        }
        if (!sameExitCodes(summaryResult.verifyExitCodes, recordResult.verifyExitCodes)) {
          failures.push(`${key}: summary verifyExitCodes disagree with run record`)
        }
        if (summaryResult.verifyCount !== recordResult.verifyCount) {
          failures.push(`${key}: summary verifyCount disagrees with run record`)
        }
        if (summaryResult.hiddenVerifyCount !== recordResult.hiddenVerifyCount) {
          failures.push(`${key}: summary hiddenVerifyCount disagrees with run record`)
        }
        if (summaryResult.scenarioHash !== recordResult.scenarioHash) {
          failures.push(`${key}: summary scenarioHash disagrees with run record`)
        }
        if (summaryResult.sourceHash !== recordResult.sourceHash) {
          failures.push(`${key}: summary sourceHash disagrees with run record`)
        }
        if (summaryResult.error !== recordResult.error) {
          failures.push(
            `${key}: summary error ${JSON.stringify(summaryResult.error ?? null)} disagrees with run record ${JSON.stringify(
              recordResult.error ?? null,
            )}`,
          )
        }
      }
      const summaryResultKeys = new Set(latest.results.map(resultKey))
      if (summaryResultKeys.size !== latest.results.length) {
        failures.push(`latest summary records duplicate scenario/variant/model results`)
      }
    }
  }

  // Validate every summary even for callers that omit the optional run record or matrix.
  for (const result of latest.results) {
    const evidence = verifierEvidenceProblem(result, verifierById.get(result.scenario))
    if (evidence !== null) failures.push(`${resultKey(result)}: summary ${evidence}`)
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
    // For repetition runs, every repetition must have both variants.
    if (latest.repetitions !== undefined && latest.repetitions > 1) {
      const expectedResultCount = latest.repetitions * 2
      if (results.length !== expectedResultCount) {
        failures.push(
          `${scenario.id}: expected ${expectedResultCount} results (${latest.repetitions} repetitions × 2 variants) but found ${results.length}`,
        )
      }
      for (let repetition = 0; repetition < latest.repetitions; repetition += 1) {
        const repResults = results.filter((r) => r.repetition === repetition)
        if (repResults.length !== 2) {
          failures.push(`${scenario.id}: repetition ${repetition} expected 2 results but found ${repResults.length}`)
          continue
        }
        const repVariants = new Set(repResults.map((r) => r.variant))
        if (!repVariants.has('bare')) failures.push(`${scenario.id}: repetition ${repetition} missing bare variant`)
        if (!repVariants.has('anvil')) failures.push(`${scenario.id}: repetition ${repetition} missing anvil variant`)
      }
    } else {
      const variants = new Set(results.map((result) => result.variant))
      if (!variants.has('bare')) failures.push(`${scenario.id}: the latest run has no bare result`)
      if (!variants.has('anvil')) failures.push(`${scenario.id}: the latest run has no anvil result`)
    }
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
