/**
 * @anvil/audit -- the readiness rules engine and report.
 */

export {
  estimateTokens,
  FAIL_INSTRUCTION_BYTES,
  formatBytes,
  WARN_INSTRUCTION_BYTES,
} from './budget.ts'
export {
  type AuditOptions,
  audit,
  buildRuleContext,
  computeLayerScores,
  computeScore,
  LAYER_TITLES,
  LAYERS,
} from './engine.ts'

export {
  RULES,
  type Rule,
  type RuleContext,
  type RuleOutcome,
} from './rules.ts'

export {
  emptyReport,
  type Finding,
  type Fix,
  type FixOrigin,
  gradeFor,
  LAYER_QUESTIONS,
  type Layer,
  type LayerScore,
  type PlaybookMatchInfo,
  type ReadinessReport,
  type SchemaVersion,
  SEVERITY_WEIGHT,
  type Severity,
  STATUS_CREDIT,
  type Status,
} from './types.ts'
