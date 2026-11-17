/**
 * Acceptance criteria in a ticket body.
 *
 * Providers convert their own body format to markdown first, then share this extraction.
 * A checklist is the strongest signal, because it is the format the context bundle writes
 * back and the one a reviewer reads; a headed section is the fallback for a body written
 * as prose. Keeping one implementation means `github` and `jira` cannot disagree about
 * what the acceptance criteria of a converted body are.
 */

/** Acceptance criteria, from either a checklist or a headed section. */
export function extractAcceptance(body: string | undefined): string[] {
  if (body === undefined) return []
  const checks = [...body.matchAll(/^\s*[-*]\s*\[[ xX]\]\s*(.+)$/gm)].map((m) => (m[1] ?? '').trim())
  if (checks.length > 0) return checks
  const section = /#+ *acceptance criteria[^\n]*\n([\s\S]*?)(?=\n#|$)/i.exec(body)
  if (section === null) return []
  return (section[1] ?? '')
    .split('\n')
    .map((l) => l.replace(/^\s*[-*]\s*/, '').trim())
    .filter((l) => l !== '')
}
