/**
 * @anvil/playbooks -- per-technology AI guidance.
 *
 * A playbook is hand-authored data: official documentation, official skills and agents,
 * well-known community resources, and the verify commands and conventions for a
 * technology. `anvil plan` matches a detected stack against the registry and ranks the
 * resulting fixes by origin and confidence.
 */

export {
  type CheckReport,
  checkPlaybooks,
  checkStructure,
  classifyStatus,
  collectUrls,
  type ProbeFetch,
  type ProbeOptions,
  type Problem,
  type ProblemLevel,
  probeUrls,
  type UrlStatus,
} from './check.ts'
export {
  type MatchResult,
  matchPlaybooks,
  type PlaybookMatchReason,
} from './match.ts'
export {
  buildPlan,
  type Plan,
  type PlanTier,
  rankSuggestions,
  type Suggestion,
} from './plan.ts'
export {
  BUILTIN_PLAYBOOK_SOURCE,
  type LoadResult,
  loadBuiltins,
  loadPlaybooks,
  loadPlaybooksFromDirectory,
  parsePlaybookFiles,
  requireDirectory,
  userPlaybookDir,
} from './registry.ts'
export {
  type CommunityResource,
  type Conventions,
  type OfficialResources,
  type Playbook,
  type PlaybookMatch,
  type PlaybookVerify,
  parsePlaybook,
  type Resource,
  SCHEMA_URL,
  type ValidationIssue,
  validatePlaybook,
} from './schema.ts'
export { parseYamlSubset, YamlError, type YamlValue } from './yaml.ts'
