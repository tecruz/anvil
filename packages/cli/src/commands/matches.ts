/**
 * Adapt matched playbooks to the audit's small, dependency-free contract.
 *
 * The audit package does not import the registry, so this is the one place that turns a
 * `MatchResult` (playbook plus reasons) into the id/evidence pair a rule needs. File
 * matches are the strongest evidence; when a playbook matched only on a stack or language
 * id, the stack's own evidence is used instead.
 */

import type { PlaybookMatchInfo } from '@anvil/audit'
import type { MatchResult } from '@anvil/playbooks'
import type { ProjectProfile } from '@anvil/profile'

export function toPlaybookMatchInfo(matches: readonly MatchResult[], profile: ProjectProfile): PlaybookMatchInfo[] {
  return matches.map((match) => {
    const evidence = new Set<string>()
    for (const reason of match.reasons) {
      if (reason.kind === 'file') evidence.add(reason.matched)
    }

    if (evidence.size === 0) {
      for (const reason of match.reasons) {
        for (const stack of profile.stacks) {
          if (stack.id !== reason.matched) continue
          for (const path of stack.evidence) evidence.add(path)
        }
      }
    }

    return { id: match.playbook.id, evidence: [...evidence] }
  })
}
