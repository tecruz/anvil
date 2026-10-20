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
  return out
}
