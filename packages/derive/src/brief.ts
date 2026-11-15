/**
 * The brief: verified facts handed to the LLM step.
 *
 * This is the seam between the deterministic half of anvil and the agent. Everything in
 * here is *verified* -- a command that exists in a manifest with a `file:line`, a module
 * from the workspace graph -- and nothing is a guess. The agent's job is to turn these
 * facts into prose and structure; it is never asked to rediscover them.
 *
 * Two things deliberately absent:
 *
 *  - **No instructions to guess.** The brief says what the repo *is*, not what a good
 *    AGENTS.md should say. Templates provide the shape; the model fills it.
 *  - **No secrets.** The file list is filtered, and file *contents* are only included
 *    for a small allowlist of manifest-shaped paths. An agent working in a corporate repo
 *    should not have secrets pushed into its context by a convenience feature.
 *
 * The brief also states what it did not establish. Source code is evidence of the current
 * implementation, references are pointers, and business expectations remain questions. That
 * way a model cannot turn "the code does this" into "the product is supposed to do this".
 */

import type { Finding, ReadinessReport } from '@anvil/audit'
import type { ProjectConfig } from '@anvil/core'
import { curatedTrust, liveTrust, type MatchResult } from '@anvil/playbooks'
import type { CommandEntry, ProjectProfile, RiskPath } from '@anvil/profile'

export type BriefTarget = 'agents' | 'commands' | 'skills' | 'all'

export interface BriefCommand {
  kind: string
  cmd: string
  source: CommandEntry['source'] | 'declared'
  /** The first command of a kind is the one anvil uses; the rest are real candidates. */
  primary: boolean
  evidence: string | null
  /** Repo-relative directory the command runs from. `''` means the repository root. */
  dir: string
}

export interface BriefModule {
  id: string
  path: string
  dependsOn: string[]
}

/**
 * An approved context document, by path and scope only.
 *
 * The brief names what the owner approved so an agent can open it; it never carries the
 * document's contents, so approving a pointer cannot upload a sensitive document.
 */
export interface BriefReference {
  id: string
  path: string
  scope: string
  reason: string | null
}

export interface BriefFileExcerpt {
  path: string
  /** File contents, truncated. Only for the allowlisted manifest shapes. */
  content: string
  truncated: boolean
}

/**
 * How each kind of input may be used by the model.
 *
 * The distinction is the difference between a fact and a decision. Detected facts describe
 * the repository as it is; source code is evidence of the current implementation; and the
 * business expectations behind that implementation were not assessed at all.
 */
export interface BriefContextPolicy {
  sourceCode: 'implementation-evidence-not-product-spec'
  references: 'pointers-only'
  businessExpectations: 'not-assessed'
}

/**
 * A question the repository does not answer.
 *
 * A question is deliberately not a gap: a gap says something is missing from the repository,
 * while a question says anvil did not establish the answer. An approved reference may help a
 * reader answer it, but the reference is a pointer, never an answer anvil read for them.
 */
export interface BriefQuestion {
  id: string
  prompt: string
  /** Why this is open, so a reader cannot mistake it for a generated recommendation. */
  reason: string
  /** Approved documents that may help answer it. Listing a pointer is not reading it. */
  referenceIds: string[]
}

export const INTENDED_BEHAVIOR_QUESTION_ID = 'intended-product-behavior'

/** The single question the current brief can ask without reading an owner's documents. */
export const INTENDED_BEHAVIOR_QUESTION = 'What intended product behavior and acceptance criteria should guide changes?'

/** A fresh copy, so a caller cannot mutate the policy every other consumer sees. */
export function briefContextPolicy(): BriefContextPolicy {
  return {
    sourceCode: 'implementation-evidence-not-product-spec',
    references: 'pointers-only',
    businessExpectations: 'not-assessed',
  }
}

/**
 * The questions anvil can state without interpreting a document.
 *
 * Requirements references are attached by id, because they are the approved places a reader
 * might find the answer. Their presence changes nothing else: the question stays open, and
 * the brief carries no contents from them.
 */
export function briefQuestions(declared: ProjectConfig | undefined): BriefQuestion[] {
  const referenceIds = [
    ...new Set(
      (declared?.references ?? [])
        .filter((reference) => (reference.scope ?? 'other') === 'requirements')
        .map((reference) => reference.id),
    ),
  ]
  return [
    {
      id: INTENDED_BEHAVIOR_QUESTION_ID,
      prompt: INTENDED_BEHAVIOR_QUESTION,
      reason:
        'Business expectations were not assessed from this repository. Source code and tests show the current implementation, not necessarily the intended product behavior.',
      referenceIds,
    },
  ]
}

export interface Brief {
  schemaVersion: 2
  target: BriefTarget
  repo: {
    root: string
    vcs: string | null
    defaultBranch: string | null
    languages: Array<{ id: string; files: number; primary: boolean }>
    stacks: Array<{ id: string; version: string | null; evidence: string[] }>
    monorepo: { tool: string; members: string[] } | null
  }
  commands: BriefCommand[]
  tooling: {
    lint: string[]
    formatter: string[]
    typecheck: string[]
    test: string[]
    ci: string[]
    hooks: string[]
    container: boolean
  }
  modules: BriefModule[]
  docs: Record<string, string | null>
  instructions: Array<{ path: string; category: string }>
  risk: RiskPath[]
  playbooks: Array<{
    id: string
    title: string
    matchedBy: string[]
    conventions: {
      moduleLayout: string | null
      testNaming: string | null
      reviewFocus: string[]
    }
    verify: Record<string, string[]>
    guidance: Array<{
      kind: string
      label: string
      url: string
      why: string
      provenance: 'curated' | 'live'
      /**
       * Install path, for a resource that is a file on this machine rather than a link.
       *
       * A locally installed skill has no URL at all; dropping it for that would hide the one
       * source that works offline. Its path is the citation instead.
       */
      install?: string
      /** Who vouches for it. Absent on entries written before the field existed. */
      trust?: string
    }>
  }>
  findings: Array<{
    id: string
    layer: string
    status: string
    severity: string
    detail: string
  }>
  /** Excerpts from a small allowlist of manifest files. Never secrets. */
  excerpts: BriefFileExcerpt[]
  /** Approved context documents, by path and scope only. Their contents are never copied. */
  references: BriefReference[]
  /** How the model may use source code and references; what it must not treat as decided. */
  contextPolicy: BriefContextPolicy
  /** What the repository does not answer, so the model asks rather than invents. */
  questions: BriefQuestion[]
  /** What the repo lacks, so the model does not write guidance for things already present. */
  gaps: string[]
  /**
   * Conditions worth stating, such as a stale discovery cache that was left out.
   *
   * A brief that quietly lost guidance would read as a brief that found less, and the
   * reader would have no way to tell the difference.
   */
  warnings: string[]
}

/**
 * Files whose contents are safe and useful to include. Manifests and agent instructions
 * only -- never `.env`, keys, or source files.
 */
const EXCERPT_ALLOW: Array<{ path: string; maxBytes: number }> = [
  { path: 'AGENTS.md', maxBytes: 20_000 },
  { path: 'CLAUDE.md', maxBytes: 20_000 },
  { path: 'README.md', maxBytes: 20_000 },
  { path: 'CONTRIBUTING.md', maxBytes: 20_000 },
  { path: 'package.json', maxBytes: 40_000 },
  { path: 'pyproject.toml', maxBytes: 40_000 },
  { path: 'Cargo.toml', maxBytes: 40_000 },
  { path: 'go.mod', maxBytes: 4_000 },
  { path: 'Makefile', maxBytes: 20_000 },
  { path: 'settings.gradle.kts', maxBytes: 20_000 },
  { path: 'build.gradle.kts', maxBytes: 40_000 },
  { path: '.editorconfig', maxBytes: 8_000 },
]

export interface BuildBriefOptions {
  profile: ProjectProfile
  report: ReadinessReport
  matches: readonly MatchResult[]
  target: BriefTarget
  /** Reads a repo-relative file. Injected so tests do not need a real repo. */
  read: (relPath: string) => string | null
  /**
   * Names the file a repo-relative path resolves to (device and inode), without opening it,
   * or `null` when it names no file. Injected like `read`. With it, a reference that reaches
   * an allowlisted file through a symlink or hard link is recognized as that file; without
   * it, references are compared by path only.
   */
  identify?: (relPath: string) => string | null
  /** Owner-declared capabilities, carried so an unrecognized technology is still described. */
  declared?: ProjectConfig
  /** Findings to omit, so a `brief --for agents` is not swamped by unrelated rules. */
  relevantLayers?: readonly string[]
  /**
   * Live-discovered resources, keyed by playbook id.
   *
   * Optional so nothing has to construct it: a brief on a machine that has never run
   * `anvil playbook discover` builds exactly as before.
   */
  live?: ReadonlyMap<string, readonly LiveGuidance[]>
  /** Conditions the caller already knows about, carried through to the output unchanged. */
  warnings?: readonly string[]
}

/**
 * The shape a live entry needs to appear in a brief.
 *
 * Structural, like `LiveResource` in `@anvil/playbooks`, and for the same reason: `@anvil/derive`
 * must not depend on `@anvil/discovery` to render a resource, or every consumer of the brief
 * would pull the discovery package in. Stating the requirement here keeps the coupling at the
 * boundary that actually needs it.
 */
export interface LiveGuidance {
  label: string
  url: string
  why: string
  section: string
  /** Who vouches for it: `official-publisher`, `local-install` or `third-party`. */
  trust?: string
  /**
   * The ranking tier, `official` when the technology's own orgs publish it.
   *
   * Read only to fill in `trust` for an entry from a cache written before that field
   * existed; the publisher of a live entry is otherwise already decided by discovery.
   */
  tier?: string
  /**
   * Install path, when the resource is a file on this machine rather than a link.
   *
   * A local-scan skill has an empty `url` and its `SKILL.md` path here. Carried through so a
   * brief can cite it by path instead of dropping it for having no URL.
   */
  install?: string | null
  /** Which source produced it: `github-search`, `mcp-registry`, `local-scan`. */
  source?: string
}

export function buildBrief(options: BuildBriefOptions): Brief {
  const { profile, report, matches, target, read } = options

  const commands: BriefCommand[] = []
  const declaredCommands = options.declared?.commands ?? []
  const commandKinds = [...new Set([...Object.keys(profile.commands), ...declaredCommands.map((c) => c.kind)])].sort()
  for (const kind of commandKinds) {
    // Declared commands lead: the owner overrides the detected command for that kind, and the
    // detected one is kept beside it so the model sees both rather than a silent replacement.
    const declaredForKind = declaredCommands.filter((c) => c.kind === kind)
    declaredForKind.forEach((entry, index) => {
      commands.push({
        kind,
        cmd: entry.cmd,
        source: 'declared',
        primary: index === 0,
        evidence: 'anvil.config.json',
        dir: entry.dir ?? profile.projectDir,
      })
    })
    for (const [index, entry] of (profile.commands[kind as keyof typeof profile.commands] ?? []).entries()) {
      commands.push({
        kind,
        cmd: entry.cmd,
        source: entry.source,
        primary: index === 0 && declaredForKind.length === 0,
        evidence: entry.evidence ?? null,
        dir: profile.projectDir,
      })
    }
  }

  const layers = options.relevantLayers
  const findings: Brief['findings'] = report.findings
    .filter((f) => f.status !== 'na')
    .filter((f) => layers === undefined || layers.includes(f.layer))
    .map((f) => ({
      id: f.id,
      layer: f.layer,
      status: f.status,
      severity: f.severity,
      detail: f.detail,
    }))

  const playbooks: Brief['playbooks'] = matches.map((m) => ({
    id: m.playbook.id,
    title: m.playbook.title,
    matchedBy: m.reasons.map((r) => `${r.kind}:${r.pattern} -> ${r.matched}`),
    conventions: {
      moduleLayout: m.playbook.conventions.moduleLayout,
      testNaming: m.playbook.conventions.testNaming,
      reviewFocus: m.playbook.conventions.reviewFocus,
    },
    verify: m.playbook.verify as unknown as Record<string, string[]>,
    guidance: flattenGuidance(m.playbook, options.live?.get(m.playbook.id) ?? []),
  }))

  const excerpts: BriefFileExcerpt[] = []
  const warnings = [...(options.warnings ?? [])]
  // An approved reference is a pointer, and pointer-only treatment wins over the general
  // excerpt allowlist. Otherwise approving `README.md` as context would be the way to get its
  // contents copied into the brief, which is exactly what the approval did not grant.
  //
  // A reference that names an allowlisted file directly is skipped silently: the owner asked
  // for exactly that, and the reference is listed in `references`. A reference that reaches
  // the same file under another name (a symlink or hard link) is skipped too, with a warning,
  // because nothing in the path says it is the same document.
  const references = options.declared?.references ?? []
  const referencedPaths = new Set(references.map((r) => excerptKey(r.path)))
  const referencedFiles = new Map<string, string>()
  if (options.identify !== undefined) {
    for (const r of references) {
      const file = options.identify(r.path)
      if (file !== null && !referencedFiles.has(file)) referencedFiles.set(file, r.path)
    }
  }
  for (const { path, maxBytes } of EXCERPT_ALLOW) {
    if (!profile.files.includes(path)) continue
    if (referencedPaths.has(excerptKey(path))) continue
    const file = options.identify?.(path) ?? null
    const alias = file === null ? undefined : referencedFiles.get(file)
    if (alias !== undefined) {
      warnings.push(
        `approved context reference ${alias} resolves to ${path}; its contents were not copied into this brief.`,
      )
      continue
    }
    const content = read(path)
    if (content === null) continue
    const truncated = content.length > maxBytes
    excerpts.push({
      path,
      content: truncated ? content.slice(0, maxBytes) : content,
      truncated,
    })
  }

  return {
    schemaVersion: 2,
    target,
    repo: {
      root: profile.root,
      vcs: profile.vcs.host,
      defaultBranch: profile.vcs.defaultBranch,
      languages: profile.languages.map((l) => ({
        id: l.id,
        files: l.files,
        primary: l.primary,
      })),
      stacks: profile.stacks.map((s) => ({
        id: s.id,
        version: s.version,
        evidence: s.evidence,
      })),
      monorepo: profile.monorepo === null ? null : { tool: profile.monorepo.tool, members: profile.monorepo.members },
    },
    commands,
    tooling: {
      lint: profile.tooling.lint,
      formatter: profile.tooling.formatter,
      typecheck: profile.tooling.typecheck,
      test: profile.tooling.test,
      ci: profile.tooling.ci,
      hooks: profile.tooling.hooks,
      container: profile.tooling.container,
    },
    modules: profile.modules.map((m) => ({
      id: m.id,
      path: m.path,
      dependsOn: m.deps,
    })),
    docs: { ...profile.docs },
    instructions: profile.instructions.map((i) => ({
      path: i.path,
      category: i.category,
    })),
    risk: profile.risk,
    playbooks,
    findings,
    excerpts,
    references: (options.declared?.references ?? []).map((r) => ({
      id: r.id,
      path: r.path,
      scope: r.scope ?? 'other',
      reason: r.reason ?? null,
    })),
    contextPolicy: briefContextPolicy(),
    questions: briefQuestions(options.declared),
    gaps: computeGaps(report, profile),
    warnings,
  }
}

/**
 * Compare an excerpt path with a reference path as text.
 *
 * Case-insensitive, because on Windows and default macOS volumes `readme.md` is `README.md`;
 * on a case-sensitive volume this can only withhold an excerpt, never copy one. Backslashes
 * become slashes so a Windows-style reference compares like its POSIX spelling. There is no
 * `./` or `//` handling: `project.references` rejects `.` and empty segments, and the allowlist
 * names top-level files. Any other alias is caught by file identity, not by this key.
 */
export function excerptKey(path: string): string {
  return path.trim().replace(/\\/g, '/').toLowerCase()
}

function flattenGuidance(
  playbook: {
    official: {
      docs: unknown[]
      skills: unknown[]
      agents: unknown[]
      mcp: unknown[]
      styleGuides: unknown[]
      migrationGuides: unknown[]
    }
    community?: unknown[]
    /** The playbook's publisher evidence, so a resource's publisher can be read from its URL. */
    discover?: { officialOrgs?: string[]; officialDomains?: string[] }
  },
  live: readonly LiveGuidance[] = [],
): Array<{
  kind: string
  label: string
  url: string
  why: string
  provenance: 'curated' | 'live'
  install?: string
  trust?: string
}> {
  const groups: Array<[string, Array<{ label: string; url: string; why: string }>]> = [
    [
      'doc',
      playbook.official.docs as Array<{
        label: string
        url: string
        why: string
      }>,
    ],
    [
      'skill',
      playbook.official.skills as Array<{
        label: string
        url: string
        why: string
      }>,
    ],
    [
      'agent',
      playbook.official.agents as Array<{
        label: string
        url: string
        why: string
      }>,
    ],
    [
      'mcp',
      playbook.official.mcp as Array<{
        label: string
        url: string
        why: string
      }>,
    ],
    [
      'style',
      playbook.official.styleGuides as Array<{
        label: string
        url: string
        why: string
      }>,
    ],
    [
      'migration',
      playbook.official.migrationGuides as Array<{
        label: string
        url: string
        why: string
      }>,
    ],
  ]
  const curated: Array<{
    kind: string
    label: string
    url: string
    why: string
    provenance: 'curated' | 'live'
    install?: string
    trust?: string
  }> = groups.flatMap(([kind, resources]) =>
    resources.map((r) => ({
      kind,
      label: r.label,
      url: r.url,
      why: r.why,
      provenance: 'curated' as const,
      // The publisher is read from the resource's evidence, not assumed because the playbook
      // filed it as official: `Context7` sits under `official.mcp` and is hosted by upstash.
      trust: curatedTrust(
        { url: r.url },
        {
          officialOrgs: playbook.discover?.officialOrgs ?? [],
          officialDomains: playbook.discover?.officialDomains ?? [],
        },
      ),
    })),
  )

  // Live entries go last, and only when the curated list does not already cite them. Same
  // rule as the plan: a person-reviewed entry outranks a fetched one, and a brief is the
  // text an agent will read as authoritative, so a duplicate there is worse than a duplicate
  // in a terminal.
  //
  // Identity is the URL, or the install path when there is no URL: a locally installed skill
  // hrefs at nothing, and its `SKILL.md` path is what a reader would open. Its empty URL is
  // not a reason to drop it -- it is the one source that works with no network at all.
  const cited = new Set(curated.map((r) => citationKey(r.url, '')))
  const added = live
    .filter((r) => {
      const key = citationKey(r.url, installOf(r.install))
      if (key === '' || cited.has(key)) return false
      cited.add(key)
      return true
    })
    .map((r) => {
      const install = installOf(r.install)
      return {
        kind: `live ${r.section}`,
        label: r.label,
        url: r.url,
        why: r.why,
        provenance: 'live' as const,
        ...(install === '' ? {} : { install }),
        // A cache written before `trust` existed has none; the same fallback the plan uses
        // fills it in, so a live row is never left without a publisher.
        trust: liveTrust(r),
      }
    })

  return [...curated, ...added]
}

/**
 * A usable install path: a trimmed string, or empty when the field is absent or malformed.
 *
 * The live map is typed, but its values can come from a cache file any process may have
 * written, and a caller can hand `buildBrief` anything. A non-string install is treated as no
 * install rather than allowed to throw where a reader expects a line of guidance.
 */
function installOf(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

/**
 * Dedupe identity for guidance: the URL, else the install path, else nothing.
 *
 * Prefixing keeps a URL that happens to look like a path from colliding with one, and the
 * trailing-slash strip matches how the plan normalises the same link.
 */
function citationKey(url: string, install: string): string {
  const trimmedUrl = url.trim().toLowerCase().replace(/\/+$/, '')
  if (trimmedUrl !== '') return `url:${trimmedUrl}`
  const trimmedInstall = install.trim().toLowerCase()
  return trimmedInstall === '' ? '' : `install:${trimmedInstall}`
}

/**
 * What the repo lacks.
 *
 * This is the part that keeps generated guidance honest. Without it a model writes
 * instructions for things the repo already does -- a "we use pnpm" note in an npm repo --
 * and the result is worse than writing nothing.
 */
export function computeGaps(report: ReadinessReport, profile: ProjectProfile): string[] {
  const gaps: string[] = []
  for (const f of report.findings) {
    if (f.status === 'pass' || f.status === 'na') continue
    gaps.push(`${f.id} (${f.severity}): ${f.detail}`)
  }
  if (profile.instructions.length === 0) gaps.push('no agent instructions file exists at all')
  if (profile.modules.length > 1) gaps.push('multi-module repo: guidance must include a module map')
  return gaps
}

export type { Finding }
