/**
 * The audit engine: run every rule, score the result, produce the ReadinessReport.
 *
 * Scoring is severity-weighted rather than a raw pass count, because a repo can pass
 * thirty cosmetic rules and still be unusable by an agent. A missing `AGENTS_COMMANDS`
 * (a blocker) has to outweigh a missing LICENSE (info).
 *
 * A rule that throws is reported as a degraded finding rather than aborting the audit. A
 * report with one broken rule and forty working ones is far more useful than none.
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { ProjectProfile } from '@anvil/profile'
import { RULES, type Rule, type RuleContext } from './rules.ts'
import {
  LAYERS,
  LAYER_TITLES,
  SEVERITY_WEIGHT,
  STATUS_CREDIT,
  gradeFor,
  type Finding,
  type Layer,
  type LayerScore,
  type ReadinessReport,
  type Status,
} from './types.ts'

export interface AuditOptions {
  /** Evaluate only these rules. */
  only?: readonly string[]
  /** Skip these rules. */
  skip?: readonly string[]
  /** Only evaluate rules in these layers. */
  layers?: readonly Layer[]
  /** Pre-read instruction text; the engine reads from disk when omitted. */
  instructionsText?: string
}

export function buildRuleContext(profile: ProjectProfile, options: AuditOptions = {}): RuleContext {
  const root = profile.root

  const instructionText =
    options.instructionsText ??
    profile.instructions
      .map((i) => {
        try {
          return readFileSync(join(root, i.path), 'utf8')
        } catch {
          return ''
        }
      })
      .join('\n')

  // CI workflow bodies are read here rather than stored in the profile: one rule needs
  // them and the plugin does not want every workflow in its JSON payload.
  const ciWorkflows = new Map<string, string>()
  for (const path of profile.tooling.ci) {
    try {
      ciWorkflows.set(path, readFileSync(join(root, path), 'utf8'))
    } catch {
      ciWorkflows.set(path, '')
    }
  }

  const hasCode = profile.languages.some((l) => l.primary && l.files > 0)
  const hasTests = profile.files.some((f) =>
    /(^|\/)(tests?|__tests__|spec)\//i.test(f) ||
    /(_test\.|\.test\.|\.spec\.|Test\.java$|Tests\.cs$|_spec\.rb$)/.test(f) ||
    /(^|\/)test_[^/]+\.py$/.test(f),
  )

  return { profile, hasCode, hasTests, instructionsText: instructionText, ciWorkflows }
}

export function audit(profile: ProjectProfile, options: AuditOptions = {}): ReadinessReport {
  const ctx = buildRuleContext(profile, options)
  const degraded: Array<{ reason: string }> = []

  let rules: readonly Rule[] = RULES
  if (options.layers !== undefined) {
    const wanted = new Set(options.layers)
    rules = rules.filter((r) => wanted.has(r.layer))
  }
  if (options.only !== undefined) {
    const wanted = new Set(options.only)
    rules = rules.filter((r) => wanted.has(r.id))
  }
  if (options.skip !== undefined) {
    const unwanted = new Set(options.skip)
    rules = rules.filter((r) => !unwanted.has(r.id))
  }

  const findings: Finding[] = []
  const notApplicable: string[] = []

  for (const rule of rules) {
    try {
      const outcome = rule.evaluate(ctx)
      const status: Status = outcome.status
      if (status === 'na') {
        notApplicable.push(rule.id)
        findings.push({
          id: rule.id,
          layer: rule.layer,
          status: 'na',
          severity: rule.severity,
          title: rule.title,
          detail: outcome.detail,
          evidence: outcome.evidence ?? [],
          fix: null,
        })
        continue
      }
      findings.push({
        id: rule.id,
        layer: rule.layer,
        status,
        severity: rule.severity,
        title: rule.title,
        detail: outcome.detail,
        evidence: outcome.evidence ?? [],
        fix: outcome.fix ?? null,
      })
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      degraded.push({ reason: `rule ${rule.id} threw: ${message}` })
      findings.push({
        id: rule.id,
        layer: rule.layer,
        status: 'warn',
        severity: 'info',
        title: rule.title,
        detail: `Rule could not be evaluated: ${message}`,
        evidence: [],
        fix: null,
      })
    }
  }

  return {
    schemaVersion: 1,
    score: computeScore(findings),
    grade: gradeFor(computeScore(findings)),
    layers: computeLayerScores(findings),
    findings,
    notApplicable,
    degraded,
  }
}

/**
 * Weighted score.
 *
 * Credit is earned per rule and weighted by the rule's severity, so a repo cannot buy a
 * good score with trivial passes. A blocker is worth 12 points of penalty -- roughly two
 * `high` findings -- because a repo where the agent cannot verify its own work is not
 * usable regardless of how tidy the rest is.
 */
export function computeScore(findings: readonly Finding[]): number {
  let earned = 0
  let possible = 0
  for (const finding of findings) {
    if (finding.status === 'na') continue
    const weight = SEVERITY_WEIGHT[finding.severity]
    if (weight === 0) continue
    possible += weight
    earned += weight * STATUS_CREDIT[finding.status]
  }
  if (possible === 0) return 100
  return Math.round((earned / possible) * 100)
}

export function computeLayerScores(findings: readonly Finding[]): LayerScore[] {
  return LAYERS.map((layer) => {
    const layerFindings = findings.filter((f) => f.layer === layer)
    let earned = 0
    let possible = 0
    let passing = 0
    let failing = 0
    let applicable = 0
    for (const f of layerFindings) {
      if (f.status === 'na') continue
      applicable++
      if (f.status === 'fail') failing++
      else passing++
      const weight = SEVERITY_WEIGHT[f.severity]
      if (weight === 0) continue
      possible += weight
      earned += weight * STATUS_CREDIT[f.status]
    }
    return {
      layer,
      score: possible === 0 ? 100 : Math.round((earned / possible) * 100),
      total: layerFindings.length,
      passing,
      failing,
      applicable,
    }
  })
}

export { LAYER_TITLES, LAYERS }
