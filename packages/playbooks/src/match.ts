/**
 * Match a detected profile against the playbook registry.
 *
 * A playbook matches when the profile shows evidence for it: a matching file, or one of
 * the stack ids the detectors emitted matching a `match.deps` entry. Every match records
 * *why* it matched, because "why does anvil think this is a Python project" is the
 * question a reviewer asks first, and a confident match with no evidence is useless.
 */

import { matchesAny, type ProjectProfile } from '@anvil/profile'
import type { Playbook } from './schema.ts'

export interface PlaybookMatchReason {
  kind: 'file' | 'dep' | 'lang'
  /** The glob or dep pattern that matched. */
  pattern: string
  /** The concrete evidence: a file path, a stack id, or an inferred language id. */
  matched: string
}

export interface MatchResult {
  playbook: Playbook
  reasons: PlaybookMatchReason[]
  /** 0..1. File evidence counts for more than a bare dependency-name match. */
  confidence: number
}

/**
 * `deps` entries are glob-ish: `typescript` matches exactly, `react*` matches prefixes.
 * Exact match first, then a trailing-`*` wildcard, then a dotted-prefix match.
 */
function depMatches(pattern: string, stackId: string): boolean {
  if (pattern === stackId) return true
  if (pattern.endsWith('*')) return stackId.startsWith(pattern.slice(0, -1))
  if (pattern.startsWith('.')) return stackId.startsWith(pattern)
  return false
}

export function matchPlaybooks(profile: ProjectProfile, playbooks: readonly Playbook[]): MatchResult[] {
  const results: MatchResult[] = []
  // Playbook authors list deps by ecosystem or language name (`kotlin`, `java`,
  // `typescript`), and those are emitted as *languages* by the detectors, not as stacks.
  // Matching against both means `deps: [kotlin]` means what an author expects it to mean.
  const stackIds = [...new Set([...profile.stacks.map((s) => s.id), ...profile.languages.map((l) => l.id)])]
  const files = profile.files

  for (const playbook of playbooks) {
    const reasons: PlaybookMatchReason[] = []

    for (const glob of playbook.match.files) {
      const hit = firstMatch(files, glob)
      if (hit !== null) reasons.push({ kind: 'file', pattern: glob, matched: hit })
    }

    for (const pattern of playbook.match.deps) {
      const hit = stackIds.find((id) => depMatches(pattern, id))
      // Attribute the match to the strongest evidence: a stack id is a direct
      // declaration, whereas a language id is inferred from file extensions.
      if (hit !== undefined) {
        reasons.push({
          kind: profile.stacks.some((s) => s.id === hit) ? 'dep' : 'lang',
          pattern,
          matched: hit,
        })
      }
    }

    if (reasons.length === 0) continue

    // A file match is stronger evidence than a dep-pattern match: a package.json on
    // disk is a fact, whereas a dep pattern can collide across ecosystems, and a
    // language match is weakest of all because it is inferred from file extensions.
    const fileMatches = reasons.filter((r) => r.kind === 'file').length
    const depMatchesCount = reasons.filter((r) => r.kind === 'dep').length
    const langMatches = reasons.filter((r) => r.kind === 'lang').length
    const confidence = Math.min(1, 0.55 + 0.15 * fileMatches + 0.08 * depMatchesCount + 0.04 * langMatches)

    results.push({ playbook, reasons, confidence })
  }

  // Highest priority first, then most confident, then id for a stable order.
  results.sort(
    (a, b) =>
      b.playbook.priority - a.playbook.priority ||
      b.confidence - a.confidence ||
      (a.playbook.id < b.playbook.id ? -1 : 1),
  )
  return results
}

function firstMatch(files: readonly string[], glob: string): string | null {
  for (const f of files) {
    if (matchesAny([f], glob)) return f
  }
  return null
}
