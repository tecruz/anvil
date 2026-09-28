/**
 * Readiness findings and the report contract.
 *
 * This is the second versioned contract (after the CLI envelope). The opencode plugin
 * parses it, so `schemaVersion` is pinned here from M1.
 */

import type { SchemaVersion } from '@anvil/profile'

export type { SchemaVersion }

/** The four questions the audit asks, in the order a reader needs them. */
export type Layer = 'orientability' | 'operability' | 'context' | 'governance'

export const LAYERS: readonly Layer[] = ['orientability', 'operability', 'context', 'governance']

export const LAYER_TITLES: Record<Layer, string> = {
  orientability: 'Orientability',
  operability: 'Operability',
  context: 'Context',
  governance: 'Governance',
}

export const LAYER_QUESTIONS: Record<Layer, string> = {
  orientability: 'can the agent understand the repo?',
  operability: 'can it verify its work and not break things?',
  context: 'does it know the technology?',
  governance: 'should it be allowed to act?',
}

export type Status = 'pass' | 'warn' | 'fail' | 'na'

export type Severity = 'blocker' | 'high' | 'medium' | 'low' | 'info'

/** Where a proposed fix came from. Drives the tiered ranking in M2a. */
export type FixOrigin = 'derived' | 'official' | 'community'

export interface Fix {
  kind: 'create-file' | 'add-command' | 'install' | 'link-doc' | 'enable-setting' | 'manual'
  origin: FixOrigin
  /** Repo-relative path this would write, when it writes one. */
  target?: string
  summary: string
  /** Staged content, rendered as a diff. Absent until the LLM step (M2b). */
  apply?: { path: string; content: string }
  source?: { label: string; url?: string }
  /** 0..1. A fix with low confidence is a suggestion, not a recommendation. */
  confidence: number
}

export interface Finding {
  /** Stable rule id, e.g. 'AGENTS_COMMANDS'. Safe to branch on. */
  id: string
  layer: Layer
  status: Status
  severity: Severity
  title: string
  detail: string
  /** `file:line` or a path. Every finding carries at least one, or it is not evidence. */
  evidence: string[]
  fix: Fix | null
}

export interface LayerScore {
  layer: Layer
  /** 0..100. */
  score: number
  total: number
  passing: number
  failing: number
  applicable: number
}

export interface ReadinessReport {
  schemaVersion: SchemaVersion
  /** 0..100, weighted. */
  score: number
  grade: 'A' | 'B' | 'C' | 'D' | 'F'
  layers: LayerScore[]
  findings: Finding[]
  /** Rules not applicable to this repo (e.g. BUILD in a docs-only repo). */
  notApplicable: string[]
  /** True when the profile was incomplete (file cap hit, or a detector failed). */
  degraded: Array<{ reason: string }>
}

/** Severity weight for scoring. A blocker is worth more than three mediums. */
export const SEVERITY_WEIGHT: Record<Severity, number> = {
  blocker: 12,
  high: 6,
  medium: 3,
  low: 1,
  info: 0,
}

export const STATUS_CREDIT: Record<Status, number> = {
  pass: 1,
  warn: 0.5,
  fail: 0,
  na: 1,
}

export function gradeFor(score: number): ReadinessReport['grade'] {
  if (score >= 85) return 'A'
  if (score >= 70) return 'B'
  if (score >= 55) return 'C'
  if (score >= 35) return 'D'
  return 'F'
}

export function emptyReport(): ReadinessReport {
  return {
    schemaVersion: 1,
    score: 0,
    grade: 'F',
    layers: [],
    findings: [],
    notApplicable: [],
    degraded: [],
  }
}
