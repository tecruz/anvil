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
export const SCHEMA_URL = 'https://github.com/tecruz/anvil/blob/main/IMPLEMENTATION_PLAN.md#playbook-registry'

export interface Resource {
  label: string
  url: string
  /** Why this is worth the reader's (or agent's) time. */
  why: string
  /** How to use it, when it is not just a URL to read. */
  install?: string
  /**
   * Files whose presence means the repository already follows this guidance.
   *
   * The plan used to offer a repository the official style guide whether or not the
   * repository already had that style guide configured. The guidance was not wrong; it
   * was redundant, and redundancy is what teaches a reader to skip a list.
   *
   * Glob-only in this version, and that is a narrowing rather than a decision: a file's
   * presence is the one signal that can be checked without reading it. Content signals
   * ("the pyproject declares ruff") would be stronger, and are not supported yet.
   */
  satisfiedBy?: string[]
}

export interface OfficialResources {
  docs: Resource[]
  skills: Resource[]
  agents: Resource[]
  mcp: Resource[]
  styleGuides: Resource[]
  migrationGuides: Resource[]
}

/**
 * What to ask the network about a technology, rather than what it says today.
 *
 * The split from the rest of the playbook is the whole design. Which GitHub
 * organisations speak officially for Android is hand-authored fact, exactly the kind
 * of fact this registry exists to hold, and it changes on a scale of years. The
 * repositories, agent skills and MCP servers those organisations publish change on a
 * scale of weeks: Google shipped an official `android` CLI and a skills repository
 * after this playbook was written, and nothing here could have recorded it.
 *
 * So the seeds are curated and reviewable, everything derived from them is fetched at
 * runtime, labelled `live`, and merged *below* the curated entries. A promoted finding
 * becomes curated data through a human editing YAML and opening a PR -- never by
 * `anvil playbook discover`, which writes a proposal and nothing else.
 *
 * Deliberately no list of awesome-lists here. An awesome list is a curated resource, it
 * rots like one, and `official.docs` already holds those with the probe that catches a
 * dead link. A second copy in `discover` would rot separately and be checked separately.
 */
export interface DiscoverSeeds {
  /** GitHub orgs or users that publish on behalf of the technology. */
  officialOrgs: string[]
  /**
   * Hosts, or `host/path` namespaces, the technology publishes its own documentation on.
   *
   * Publisher evidence, alongside `officialOrgs`. A resource in the official list whose URL
   * carries no GitHub owner is only `official-publisher` when its host matches one of these;
   * otherwise the publisher cannot be established from evidence and it is `third-party`. A
   * bare host matches exactly -- subdomains do not, so a shared host is not read as a shared
   * publisher -- and an optional `/path` scopes the match to a namespace
   * (`hexdocs.pm/elixir`, `pkg.go.dev/golang.org/x`). A trailing `host/` matches only the root.
   * The host is case-insensitive; the path is not, because a URL path is case-sensitive.
   */
  officialDomains?: string[]
  /** Repository-search terms. Kept generic enough that new repos match too. */
  keywords: string[]
  /** Search terms for the MCP registry. */
  mcp: string[]
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

/**
 * A resource found by live discovery, in the shape the plan needs.
 *
 * Declared here rather than imported from `@anvil/discovery` on purpose: discovery
 * depends on playbooks, so playbooks depending on discovery would be a cycle. The types
 * line up structurally instead, which is also the safer coupling -- the plan says what it
 * needs, and the producer satisfies it without either package knowing the other's shape.
 */
export interface LiveResource {
  url: string
  label: string
  why: string
  /** `official` only when the owner is a seeded official org; otherwise `community`. */
  tier: 'official' | 'community'
  /**
   * Who vouches for it, separate from the ranking tier.
   *
   * Optional because it was added after the first live caches existed; a reader that finds it
   * absent must fall back to the source rather than assume a publisher.
   */
  trust?: 'official-publisher' | 'local-install' | 'third-party'
  /** The playbook section this belongs in, which is also its label prefix in the plan. */
  section: 'docs' | 'skills' | 'agents' | 'mcp' | 'styleGuides' | 'migrationGuides' | 'community'
  /** Star count at fetch time. `null` when the source has no such number. */
  stars: number | null
  /** How to install it, when it is not just a URL to read. */
  install: string | null
  /** Which source produced it: `github-search`, `mcp-registry`, `local-scan`. */
  source: string
  /** ISO timestamp of the fetch that produced this entry. */
  fetchedAt: string
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
  /** Live-discovery seeds. Empty when the playbook declares nothing to look for. */
  discover: DiscoverSeeds
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

/**
 * A GitHub login, which is what a seeded official org is.
 *
 * The rule is GitHub's own: letters, digits and single hyphens, no leading or trailing
 * hyphen, 39 characters. It is checked here because a typo in this list is silent in the
 * worst way -- the search runs, matches nothing, and the plan reports that the ecosystem
 * has published nothing, which is indistinguishable from the truth.
 */
const GITHUB_LOGIN = /^[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38}$/

/**
 * A hostname, which is what the host half of a declared official domain is.
 *
 * Dotted labels, no scheme, no port and no path. Checked because a typo here is silent in the
 * worst way: the publisher rule then matches nothing and a first-party resource is quietly
 * labelled third-party, which reads as an attribution rather than a mistake.
 */
const HOSTNAME = /^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)+$/

/** The characters a path prefix in an official domain may use; no whitespace, `?` or `#`. */
const DOMAIN_PATH = /^[A-Za-z0-9._~%:@!$&'()*+,;=/-]*$/

/** Hosts, or `host/path` namespaces, a technology publishes its own documentation on. */
function domainArray(value: YamlValue | undefined, path: string, issues: ValidationIssue[]): string[] {
  const out = strArray(value, path, issues)
  for (const item of out) {
    const slash = item.indexOf('/')
    const host = slash === -1 ? item : item.slice(0, slash)
    const rest = slash === -1 ? '' : item.slice(slash + 1)
    if (!HOSTNAME.test(host) || !DOMAIN_PATH.test(rest)) {
      issues.push({ path, message: `not a host or host/path: "${item}"` })
    }
  }
  return out
}

/**
 * The orgs a technology speaks through.
 *
 * Every entry must be a login, because the org check in discovery compares against it
 * exactly: "android" matches the android org and "Android" matches it too, but "android "
 * with a trailing space matches nothing and says so nowhere.
 */
function loginArray(value: YamlValue | undefined, path: string, issues: ValidationIssue[]): string[] {
  const out = strArray(value, path, issues)
  for (const item of out) {
    if (!GITHUB_LOGIN.test(item)) {
      issues.push({ path, message: `not a GitHub login: "${item}"` })
    }
  }
  return out
}

/**
 * A list of strings that must all carry something.
 *
 * A blank keyword or a blank MCP term searches for nothing and costs a request, so it is
 * an error here rather than a silent zero.
 */
function nonEmptyStrArray(value: YamlValue | undefined, path: string, issues: ValidationIssue[]): string[] {
  const out = strArray(value, path, issues)
  for (const item of out) {
    if (item.trim() === '') issues.push({ path, message: 'expected a non-empty string' })
  }
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

const RESOURCE_KEYS = ['label', 'url', 'why', 'install', 'satisfiedBy'] as const

/**
 * The globs that say a repository already follows a piece of guidance.
 *
 * Validated rather than trusted, because a glob that matches nothing is a rule that
 * never fires: the suggestion it guards would be offered forever, which is the exact
 * behaviour `satisfiedBy` exists to remove.
 */
function satisfiedByList(value: YamlValue | undefined, path: string, issues: ValidationIssue[]): string[] | undefined {
  if (value === undefined || value === null) return undefined
  if (!Array.isArray(value)) {
    issues.push({ path, message: 'expected a list of globs' })
    return undefined
  }
  const out: string[] = []
  for (const [i, item] of value.entries()) {
    if (typeof item !== 'string' || item.trim() === '') {
      issues.push({ path: `${path}[${i}]`, message: 'expected a non-empty glob' })
      continue
    }
    const glob = item.trim()
    if (glob.startsWith('/') || glob.includes('..')) {
      issues.push({ path: `${path}[${i}]`, message: 'expected a repo-relative glob' })
      continue
    }
    out.push(glob)
  }
  return out.length === 0 ? undefined : out
}

function resourceList(
  value: YamlValue | undefined,
  path: string,
  issues: ValidationIssue[],
  extra: readonly string[] = [],
  requireUrl = true,
): Resource[] {
  if (value === undefined || value === null) return []
  if (!Array.isArray(value)) {
    issues.push({ path, message: 'expected a list' })
    return []
  }
  const out: Resource[] = []
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
    const satisfiedBy = satisfiedByList(obj.satisfiedBy, `${path}[${i}].satisfiedBy`, issues)
    out.push({
      label: typeof label === 'string' ? label : '',
      url: typeof url === 'string' ? url : '',
      why: typeof why === 'string' ? why.trim() : '',
      ...(typeof obj.install === 'string' ? { install: obj.install } : {}),
      ...(satisfiedBy === undefined ? {} : { satisfiedBy }),
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
    ['id', 'title', 'priority', 'match', 'official', 'community', 'verify', 'conventions', 'riskGlobs', 'discover'],
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

  const d = optionalSection(doc.discover)
  checkKeys(d, ['officialOrgs', 'officialDomains', 'keywords', 'mcp'], 'discover', issues)
  const officialDomains = domainArray(d.officialDomains, 'discover.officialDomains', issues)

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
      const satisfiedBy = satisfiedByList(obj.satisfiedBy, `community[${i}].satisfiedBy`, issues)
      community.push({
        repo: typeof repo === 'string' ? repo : '',
        stars,
        label: typeof obj.label === 'string' ? obj.label : typeof repo === 'string' ? repo : '',
        url: typeof obj.url === 'string' ? obj.url : typeof repo === 'string' ? `https://github.com/${repo}` : '',
        why: typeof obj.why === 'string' ? obj.why.trim() : '',
        ...(typeof obj.install === 'string' ? { install: obj.install } : {}),
        ...(satisfiedBy === undefined ? {} : { satisfiedBy }),
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
      discover: {
        officialOrgs: loginArray(d.officialOrgs, 'discover.officialOrgs', issues),
        ...(officialDomains.length === 0 ? {} : { officialDomains }),
        keywords: nonEmptyStrArray(d.keywords, 'discover.keywords', issues),
        mcp: nonEmptyStrArray(d.mcp, 'discover.mcp', issues),
      },
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
