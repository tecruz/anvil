/**
 * Human-readable reasons a profile is incomplete.
 *
 * Kept in one place so `audit`, `profile`, `plan` and `init` do not each invent a different
 * sentence for the same condition. A partial profile is useful; a partial profile that
 * looks complete is not.
 */

import type { ProjectProfile } from './types.ts'

export function profileWarnings(profile: { diagnostics?: ProjectProfile['diagnostics'] }): string[] {
  const diagnostics = profile.diagnostics
  if (diagnostics === undefined) return []

  const out: string[] = []
  if (diagnostics.truncated) {
    out.push(`profile may be incomplete: file walk stopped at ${diagnostics.fileLimit} files`)
  }
  for (const f of diagnostics.failedDetectors) {
    out.push(`detector ${f.id} failed: ${f.error}`)
  }
  const unknown = diagnostics.unanalysedDeps ?? []
  if (unknown.length > 0) {
    const names = unknown
      .slice(0, 4)
      .map((m) => m.id)
      .join(', ')
    const more = unknown.length > 4 ? ` and ${unknown.length - 4} more` : ''
    out.push(
      `module dependency graph incomplete: ${unknown.length} module(s) have no dependency resolver (${names}${more}); their deps: [] means unknown, not none`,
    )
  }
  return out
}
