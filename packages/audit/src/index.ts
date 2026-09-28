/**
 * @anvil/audit -- the readiness rules engine and report.
 */

export {
  audit,
  buildRuleContext,
  computeLayerScores,
  computeScore,
  LAYERS,
  LAYER_TITLES,
  type AuditOptions,
} from './engine.ts'

export { RULES, type Rule, type RuleContext, type RuleOutcome } from './rules.ts'

export {
  emptyReport,
  gradeFor,
  LAYER_QUESTIONS,
  SEVERITY_WEIGHT,
  STATUS_CREDIT,
  type Fix,
  type FixOrigin,
  type Finding,
  type Layer,
  type LayerScore,
  type ReadinessReport,
  type SchemaVersion,
  type Severity,
  type Status,
} from './types.ts'
