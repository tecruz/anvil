/**
 * Detector contract.
 *
 * A detector contributes evidence to a profile. It must be:
 *
 *  - **Non-executing.** Read files, never run a build. `anvil profile` has to be safe on
 *    a repo you have never seen.
 *  - **Evidence-bearing.** Every stack, command and tool claim carries a `file:line` or
 *    a path. A detector that asserts without evidence produces a report a reviewer
 *    cannot check, which defeats the purpose of the audit.
 *  - **Additive.** Detectors write into a mutable draft and never clobber each other.
 *    When two ecosystems both define a test command, the more specific one wins via
 *    `addCommand` priority rather than by overwriting.
 */

import type {
  CommandEntry,
  CommandKind,
  CommandSource,
  Language,
  Module,
  Monorepo,
  RiskPath,
  Stack,
  Tooling,
} from './types.ts'

/** Mutable accumulator handed to each detector. */
export interface ProfileDraft {
  root: string
  languages: Language[]
  stacks: Stack[]
  modules: Module[]
  monorepo: Monorepo | null
  tooling: Tooling
  risk: RiskPath[]
  commands: Partial<Record<CommandKind, CommandEntry[]>>
  /** Repo-relative POSIX paths the walk found, for detectors to look things up against. */
  files: ReadonlySet<string>
}

export interface DetectorContext {
  root: string
  files: ReadonlySet<string>
  /** Max bytes any detector may read. Manifests are small; this bounds a mistake. */
  maxFileBytes: number
}

export interface Detector {
  /** Playbook id this detector corresponds to, e.g. `node`. */
  id: string
  title: string
  /** Lower runs first. Specific ecosystems sort before general ones. */
  priority: number
  /** Cheap pre-check, so most detectors exit before doing work. */
  matches(ctx: DetectorContext): boolean
  detect(ctx: DetectorContext, draft: ProfileDraft): void
}

export function hasFile(ctx: DetectorContext, relPath: string): boolean {
  return ctx.files.has(relPath)
}

export function hasAnyFile(ctx: DetectorContext, relPaths: readonly string[]): boolean {
  return relPaths.some((p) => ctx.files.has(p))
}

/**
 * Files under `dir`. `''` or `'.'` means the whole repo, which is how a detector asks
 * "does this repo contain any .csproj anywhere?".
 */
export function filesUnder(ctx: DetectorContext, dir: string): string[] {
  const prefix = dirPrefix(dir)
  if (prefix === '') return [...ctx.files]
  const out: string[] = []
  for (const f of ctx.files) {
    if (f.startsWith(prefix)) out.push(f)
  }
  return out
}

/** True when any file under `dir` exists. `''`/`'.'` means the whole repo. */
export function hasFileUnder(ctx: DetectorContext, dir: string): boolean {
  const prefix = dirPrefix(dir)
  if (prefix === '') return ctx.files.size > 0
  for (const f of ctx.files) {
    if (f.startsWith(prefix)) return true
  }
  return false
}

/** Repo-relative POSIX prefix for a directory, or '' for the repo root. */
function dirPrefix(dir: string): string {
  const normalized = dir.replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '')
  if (normalized === '' || normalized === '.') return ''
  return `${normalized}/`
}

/**
 * Record a command, keeping the most trustworthy source first.
 *
 * Priority order is deliberate: `documented` beats `detected` beats `inferred`. A command
 * someone wrote in a README is better evidence than a script name we pattern-matched, and
 * a script name is better than a convention we guessed.
 *
 * Lower-priority candidates are *kept* rather than discarded, so a disagreement between
 * sources stays visible to a rule instead of one silently winning. The list is ordered
 * highest-priority-first, so `commands.test[0]` is the command a reader (or an agent)
 * should actually run.
 */
export function addCommand(draft: ProfileDraft, kind: CommandKind, entry: CommandEntry): void {
  const existing = draft.commands[kind] ?? []
  if (existing.some((e) => e.cmd === entry.cmd && e.source === entry.source)) {
    draft.commands[kind] = existing
    return
  }
  existing.push(entry)
  existing.sort((a, b) => priorityOf(b.source) - priorityOf(a.source))
  draft.commands[kind] = existing
}

export function priorityOf(source: CommandSource): number {
  switch (source) {
    case 'documented':
      return 2
    case 'detected':
      return 1
    case 'inferred':
      return 0
  }
}

export function addStack(draft: ProfileDraft, stack: Stack): void {
  const existing = draft.stacks.find((s) => s.id === stack.id)
  if (existing === undefined) {
    draft.stacks.push(stack)
    return
  }
  // Merge evidence: two detectors matching the same stack should accumulate proof.
  for (const e of stack.evidence) {
    if (!existing.evidence.includes(e)) existing.evidence.push(e)
  }
  existing.version ??= stack.version
}

export function addLanguage(draft: ProfileDraft, lang: Language): void {
  const existing = draft.languages.find((l) => l.id === lang.id)
  if (existing === undefined) {
    draft.languages.push(lang)
    return
  }
  existing.files += lang.files
  if (lang.primary) existing.primary = true
}

export function addTool(draft: ProfileDraft, field: keyof Tooling, value: string): void {
  const list = draft.tooling[field]
  if (Array.isArray(list) && !list.includes(value)) list.push(value)
}

export function setFlag(draft: ProfileDraft, field: 'container', value = true): void {
  if (typeof draft.tooling[field] === 'boolean') draft.tooling[field] = value
}

export function addRisk(draft: ProfileDraft, risk: RiskPath): void {
  if (draft.risk.some((r) => r.glob === risk.glob && r.origin === risk.origin)) return
  draft.risk.push(risk)
}

export function addModule(draft: ProfileDraft, mod: Module): void {
  const existing = draft.modules.find((m) => m.id === mod.id)
  if (existing === undefined) {
    draft.modules.push(mod)
    return
  }
  // Two detectors can find the same module (e.g. a Gradle subproject that is also a
  // Gradle module). Merge rather than clobber.
  existing.deps = [...new Set([...existing.deps, ...mod.deps])]
}

export function setMonorepo(draft: ProfileDraft, mono: Monorepo): void {
  const current = draft.monorepo
  if (current === null) {
    draft.monorepo = mono
    return
  }
  // First detector to claim the monorepo tool wins; later ones only contribute members,
  // because two tool claims usually mean two lockfiles, which is a finding in itself.
  current.members = [...new Set([...current.members, ...mono.members])]
}
