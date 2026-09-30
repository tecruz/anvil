/**
 * The Playbook schema.
 *
 * Validation is strict in the same way config validation is: unknown keys are an error,
 * not a warning. A typo in `riskGlobs` that silently becomes `riskGlob` would mean the
 * blast-radius map quietly stops covering a technology's dangerous paths, with nothing
 * anywhere reporting the loss.
 */

import { AnvilError, ErrorCode } from '@anvil/core'
import { parseYamlSubset, YamlError, type YamlValue } from './yaml.ts'

/**
 * Where the playbook format is documented.
 *
 * This pointed at `docs/playbook-schema.md`, which does not exist -- the first thing
 * `anvil playbook check` would have flagged as a dead link if the constant had been on its
 * list. It now points at the section of the plan that actually specifies the format.
 */
export const SCHEMA_URL = 'https://github.com/anomalyco/anvil/blob/main/IMPLEMENTATION_PLAN.md#playbook-registry'

export interface Resource {
  label: string
  url: string
  /** Why this is worth the reader's (or agent's) time. */
  why: string
  /** How to use it, when it is not just a URL to read. */
  install?: string
}

export interface OfficialResources {
  docs: Resource[]
  skills: Resource[]
  agents: Resource[]
  mcp: Resource[]
  styleGuides: Resource[]
  migrationGuides: Resource[]
}

export interface CommunityResource extends Resource {
  repo: string
  /** Approximate stars, for ranking. `null` when unknown. */
  stars: number | null
}

export interface PlaybookVerify {
  build: string[]
  test: string[]
  testFast: string[]
  lint: string[]
  format: string[]
  typecheck: string[]
}

export interface Conventions {
  moduleLayout: string | null
  testNaming: string | null
  reviewFocus: string[]
}

export interface PlaybookMatch {
  /** Glob matched against repo-relative POSIX paths. */
  files: string[]
  /** Dependency names or glob-ish patterns, matched against detected stack ids. */
  deps: string[]
  /** Import prefixes, reserved for source-scanning in M2b. */
  importPrefixes: string[]
}

export interface Playbook {
  id: string
  title: string
  /** Higher wins when several playbooks match. More specific ecosystems score higher. */
  priority: number
  match: PlaybookMatch
  official: OfficialResources
  community: CommunityResource[]
  verify: PlaybookVerify
  conventions: Conventions
  riskGlobs: string[]
  /** File this playbook was loaded from, for provenance. */
  source?: string
}

export interface ValidationIssue {
  path: string
  message: string
}

function isPlainObject(v: YamlValue | undefined): v is Record<string, YamlValue> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

/** A section that must be present and must be a mapping. */
function issuesOn(value: YamlValue | undefined, path: string, issues: ValidationIssue[]): Record<string, YamlValue> {
  if (isPlainObject(value)) return value
  issues.push({ path, message: 'expected a mapping' })
  return {}
}

/**
 * A section that is optional. Absent or null means "nothing to say", which every
 * playbook is allowed to do; present-but-wrong-shape is still an error.
 */
function optionalSection(value: YamlValue | undefined): Record<string, YamlValue> {
  if (value === undefined || value === null) return {}
  return isPlainObject(value) ? value : {}
}

function strArray(value: YamlValue | undefined, path: string, issues: ValidationIssue[], allowEmpty = true): string[] {
  if (value === undefined || value === null) return []
  if (!Array.isArray(value)) {
    issues.push({ path, message: 'expected a list of strings' })
    return []
  }
  const out: string[] = []
  for (const item of value) {
    if (typeof item !== 'string') {
      issues.push({ path, message: 'expected a string' })
      continue
    }
    out.push(item)
  }
  if (!allowEmpty && out.length === 0) issues.push({ path, message: 'expected at least one entry' })
  return out
}

function checkKeys(
  obj: Record<string, YamlValue>,
  allowed: readonly string[],
  path: string,
  issues: ValidationIssue[],
): void {
  for (const key of Object.keys(obj)) {
    if (!allowed.includes(key)) {
      issues.push({
        path: path === '' ? key : `${path}.${key}`,
        message: 'unknown key',
      })
    }
  }
}

const RESOURCE_KEYS = ['label', 'url', 'why', 'install'] as const

function resourceList(
  value: YamlValue | undefined,
  path: string,
  issues: ValidationIssue[],
  extra: readonly string[] = [],
  requireUrl = true,
): Array<Resource & Record<string, string>> {
  if (value === undefined || value === null) return []
  if (!Array.isArray(value)) {
    issues.push({ path, message: 'expected a list' })
    return []
  }
  const out: Array<Resource & Record<string, string>> = []
  for (const [i, item] of value.entries()) {
    const obj = issuesOn(item, `${path}[${i}]`, issues)
    checkKeys(obj, [...RESOURCE_KEYS, ...extra], `${path}[${i}]`, issues)
    const label = obj.label
    const url = obj.url
    const why = obj.why
    if (typeof label !== 'string' || label === '')
      issues.push({ path: `${path}[${i}].label`, message: 'required string' })
    if (requireUrl && (typeof url !== 'string' || url === ''))
      issues.push({ path: `${path}[${i}].url`, message: 'required url' })
    if (typeof why !== 'string') issues.push({ path: `${path}[${i}].why`, message: 'required string' })
    out.push({
      label: typeof label === 'string' ? label : '',
      url: typeof url === 'string' ? url : '',
      why: typeof why === 'string' ? why.trim() : '',
      ...(typeof obj.install === 'string' ? { install: obj.install } : {}),
    })
  }
  return out
}

function strOrNull(value: YamlValue | undefined, path: string, issues: ValidationIssue[]): string | null {
  if (value === undefined || value === null) return null
  if (typeof value !== 'string') {
    issues.push({ path, message: 'expected a string or null' })
    return null
  }
  return value
}

/** Validate a parsed YAML document into a Playbook, collecting every issue. */
export function validatePlaybook(
  raw: YamlValue,
  source = '<memory>',
): { playbook: Playbook | null; issues: ValidationIssue[] } {
  const issues: ValidationIssue[] = []
  const doc = issuesOn(raw, '', issues)
  checkKeys(
    doc,
    ['id', 'title', 'priority', 'match', 'official', 'community', 'verify', 'conventions', 'riskGlobs'],
    '',
    issues,
  )

  const id = strOrNull(doc.id, 'id', issues) ?? ''
  const title = strOrNull(doc.title, 'title', issues) ?? ''

  let priority = 50
  if (doc.priority !== undefined && doc.priority !== null) {
    if (typeof doc.priority === 'number') priority = doc.priority
    else issues.push({ path: 'priority', message: 'expected a number' })
  }

  if (id !== '') {
    if (!/^[a-z0-9][a-z0-9-]*$/.test(id))
      issues.push({
        path: 'id',
        message: 'must be lowercase alphanumeric with hyphens',
      })
  } else {
    issues.push({ path: 'id', message: 'required' })
  }

  const m = issuesOn(doc.match, 'match', issues)
  checkKeys(m, ['files', 'deps', 'importPrefixes'], 'match', issues)

  // `official`, `verify` and `conventions` are all optional: a playbook that only wants to
  // declare official docs should not have to stub out the rest.
  const o = optionalSection(doc.official)
  checkKeys(o, ['docs', 'skills', 'agents', 'mcp', 'styleGuides', 'migrationGuides'], 'official', issues)

  const v = optionalSection(doc.verify)
  checkKeys(v, ['build', 'test', 'testFast', 'lint', 'format', 'typecheck'], 'verify', issues)

  const c = optionalSection(doc.conventions)
  checkKeys(c, ['moduleLayout', 'testNaming', 'reviewFocus'], 'conventions', issues)

  const communityRaw = doc.community
  const community: CommunityResource[] = []
  if (Array.isArray(communityRaw)) {
    for (const [i, item] of communityRaw.entries()) {
      const obj = issuesOn(item, `community[${i}]`, issues)
      checkKeys(obj, [...RESOURCE_KEYS, 'repo', 'stars'], `community[${i}]`, issues)
      const repo = obj.repo
      if (typeof repo !== 'string' || repo === '')
        issues.push({
          path: `community[${i}].repo`,
          message: 'required string',
        })
      let stars: number | null = null
      if (typeof obj.stars === 'number') stars = obj.stars
      else if (obj.stars !== undefined && obj.stars !== null)
        issues.push({
          path: `community[${i}].stars`,
          message: 'expected a number',
        })
      community.push({
        repo: typeof repo === 'string' ? repo : '',
        stars,
        label: typeof obj.label === 'string' ? obj.label : typeof repo === 'string' ? repo : '',
        url: typeof obj.url === 'string' ? obj.url : typeof repo === 'string' ? `https://github.com/${repo}` : '',
        why: typeof obj.why === 'string' ? obj.why.trim() : '',
        ...(typeof obj.install === 'string' ? { install: obj.install } : {}),
      })
    }
  } else if (communityRaw !== undefined && communityRaw !== null) {
    issues.push({ path: 'community', message: 'expected a list' })
  }

  // A playbook that matches nothing is dead weight and a maintenance trap.
  const match = {
    files: strArray(m.files, 'match.files', issues),
    deps: strArray(m.deps, 'match.deps', issues),
    importPrefixes: strArray(m.importPrefixes, 'match.importPrefixes', issues),
  }
  if (match.files.length === 0 && match.deps.length === 0 && match.importPrefixes.length === 0) {
    issues.push({
      path: 'match',
      message: 'a playbook must match something (files, deps or importPrefixes)',
    })
  }

  if (issues.length > 0) return { playbook: null, issues }

  return {
    playbook: {
      id,
      title,
      priority,
      match,
      official: {
        docs: resourceList(o.docs, 'official.docs', issues),
        skills: resourceList(o.skills, 'official.skills', issues),
        agents: resourceList(o.agents, 'official.agents', issues),
        mcp: resourceList(o.mcp, 'official.mcp', issues),
        styleGuides: resourceList(o.styleGuides, 'official.styleGuides', issues),
        migrationGuides: resourceList(o.migrationGuides, 'official.migrationGuides', issues),
      },
      community,
      verify: {
        build: strArray(v.build, 'verify.build', issues),
        test: strArray(v.test, 'verify.test', issues),
        testFast: strArray(v.testFast, 'verify.testFast', issues),
        lint: strArray(v.lint, 'verify.lint', issues),
        format: strArray(v.format, 'verify.format', issues),
        typecheck: strArray(v.typecheck, 'verify.typecheck', issues),
      },
      conventions: {
        moduleLayout: strOrNull(c.moduleLayout, 'conventions.moduleLayout', issues),
        testNaming: strOrNull(c.testNaming, 'conventions.testNaming', issues),
        reviewFocus: strArray(c.reviewFocus, 'conventions.reviewFocus', issues),
      },
      riskGlobs: strArray(doc.riskGlobs, 'riskGlobs', issues),
      source,
    },
    issues,
  }
}

/** Parse and validate one playbook file, throwing an AnvilError on any issue. */
export function parsePlaybook(text: string, source: string): Playbook {
  let raw: YamlValue
  try {
    raw = parseYamlSubset(text)
  } catch (err) {
    const message = err instanceof YamlError ? err.message : String(err)
    throw new AnvilError(ErrorCode.ConfigInvalid, `Cannot parse playbook ${source}: ${message}`, {
      hint: 'The playbook must use the supported YAML subset: block mappings and sequences, flow collections, quoted scalars, block scalars for prose. Anchors, aliases and tabs are rejected.',
      cause: err,
    })
  }

  const { playbook, issues } = validatePlaybook(raw, source)
  if (playbook === null) {
    const detail = issues.map((i) => `  ${i.path}: ${i.message}`).join('\n')
    throw new AnvilError(ErrorCode.ConfigInvalid, `Invalid playbook ${source}:\n${detail}`, {
      hint: 'Unknown keys are rejected so a typo cannot silently disable part of a playbook.',
    })
  }
  return playbook
}
