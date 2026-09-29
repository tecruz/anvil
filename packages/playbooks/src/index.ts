/**
 * @anvil/playbooks -- per-technology AI guidance.
 *
 * A playbook is hand-authored data: official documentation, official skills and agents,
 * well-known community resources, and the verify commands and conventions for a
 * technology. `anvil plan` matches a detected stack against the registry and ranks the
 * resulting fixes by origin and confidence.
 */

export { parseYamlSubset, YamlError, type YamlValue } from './yaml.ts'

export {
  SCHEMA_URL,
  validatePlaybook,
  parsePlaybook,
  type CommunityResource,
  type Conventions,
  type OfficialResources,
  type Playbook,
  type PlaybookMatch,
  type PlaybookVerify,
  type Resource,
  type ValidationIssue,
} from './schema.ts'

export {
  BUILTIN_PLAYBOOK_SOURCE,
  loadBuiltins,
  loadPlaybooks,
  loadPlaybooksFromDirectory,
  parsePlaybookFiles,
  requireDirectory,
  type LoadResult,
} from './registry.ts'

export {
  matchPlaybooks,
  type MatchResult,
  type PlaybookMatchReason,
} from './match.ts'

export {
  buildPlan,
  rankSuggestions,
  type Plan,
  type PlanTier,
  type Suggestion,
} from './plan.ts'
