/**
 * Pull request construction.
 *
 * This is the half of M4 that is pure logic, and the half that decides whether a PR is
 * reviewable. Three things matter more than the formatting:
 *
 *  1. **The ticket is the source of truth for the body.** Title, description and
 *     acceptance criteria come from the ticket, so a reviewer reads the requirement next
 *     to the diff. A closing keyword is included, because that is what makes the ticket
 *     transition automatically on merge.
 *  2. **Risk is computed from the diff, not from the ticket.** A PR that touches a
 *     migration or an IaC file gets an explicit checklist, whatever the ticket says.
 *  3. **Reviewers come from CODEOWNERS, most specific match winning**, which is git's own
 *     rule. Getting this wrong means the wrong people review, silently.
 */

import { matchesGlob, type ProjectProfile, type RiskPath } from '@anvil/profile'
import type { Ticket } from '@anvil/tickets'

// ---------------------------------------------------------------------------
// Risk analysis
// ---------------------------------------------------------------------------

export interface RiskAnalysis {
  /** Risk globs the diff actually touched. */
  touched: RiskPath[]
  /** Repo-relative paths in the diff that matched a high-risk glob. */
  highPaths: string[]
  mediumPaths: string[]
  /** The strongest level touched, or null when the diff is unremarkable. */
  level: 'high' | 'medium' | null
}

/**
 * Which high-risk paths a diff touches.
 *
 * The blast-radius map was computed for the whole repository; this narrows it to what
 * actually changed, so the checklist is about *this* change and not about the repo in
 * general. A checklist that always says the same thing gets ignored.
 */
export function analyzeRisk(changedPaths: readonly string[], risk: readonly RiskPath[]): RiskAnalysis {
  const touched = risk.filter((r) => changedPaths.some((p) => matchesGlob(p, r.glob)))
  const highPaths: string[] = []
  const mediumPaths: string[] = []

  for (const path of changedPaths) {
    for (const entry of touched) {
      if (!matchesGlob(path, entry.glob)) continue
      if (entry.level === 'high') {
        if (!highPaths.includes(path)) highPaths.push(path)
      } else if (!mediumPaths.includes(path)) {
        mediumPaths.push(path)
      }
    }
  }

  return {
    touched,
    highPaths,
    mediumPaths,
    level: highPaths.length > 0 ? 'high' : mediumPaths.length > 0 ? 'medium' : null,
  }
}

// ---------------------------------------------------------------------------
// CODEOWNERS
// ---------------------------------------------------------------------------

export interface CodeownersRule {
  pattern: string
  owners: string[]
  line: number
}

/**
 * Parse CODEOWNERS.
 *
 * Comments, blank lines and inline `#` are dropped. `!` negation is recorded but not
 * applied -- negating a rule to un-own a file is rare, and a silently-ignored negation
 * would over-assign reviewers rather than under-assign them, which is the safer error.
 */
export function parseCodeowners(text: string): CodeownersRule[] {
  const rules: CodeownersRule[] = []
  const lines = text.split(/\r?\n/)
  for (const [i, raw] of lines.entries()) {
    const line = raw.replace(/#.*$/, '').trim()
    if (line === '') continue
    const parts = line.split(/\s+/)
    const pattern = parts[0]
    if (pattern === undefined) continue
    rules.push({ pattern, owners: parts.slice(1), line: i + 1 })
  }
  return rules
}

/**
 * Owners for a set of changed paths.
 *
 * Git's rule: the **last** matching pattern in the file wins. Implemented literally, so
 * the result matches what GitHub does rather than a plausible-looking approximation.
 */
export function resolveReviewers(changedPaths: readonly string[], codeownersText: string): string[] {
  const rules = parseCodeowners(codeownersText)
  if (rules.length === 0) return []

  const owners = new Set<string>()
  for (const path of changedPaths) {
    // Git's rule: the **last** matching pattern in the file wins. So every rule is
    // checked, and each match replaces the previous one. Stopping at the first match
    // would send every review to the catch-all default, which is the opposite of what
    // CODEOWNERS is for.
    let winning: string[] = []
    for (const rule of rules) {
      if (codeownersMatches(path, rule.pattern)) {
        winning = rule.owners.filter((owner) => !owner.startsWith('!'))
      }
    }
    for (const owner of winning) owners.add(owner)
  }
  return [...owners].sort()
}

/**
 * CODEOWNERS pattern matching.
 *
 * Supports the forms that actually appear: `*` (within a segment), `**` (across
 * segments), a leading `/` anchoring to the file's directory, and a trailing `/`
 * meaning a directory. Deliberately not a general glob: a wrong match here sends a review
 * to the wrong person, and the failure is invisible.
 *
 * **A pattern containing a slash is anchored to the repository root**, whether or not it
 * leads with one. This is GitHub's rule (CODEOWNERS follows gitignore anchoring), and it
 * is easy to get backwards: treating `docs/*` as "any `docs/` at any depth" also matches
 * `packages/docs/x`, which assigns a review the file's owner never asked for. Only
 * slash-free patterns (`*.ts`, `README.md`) match at any depth.
 */
export function codeownersMatches(path: string, pattern: string): boolean {
  const anchored = pattern.startsWith('/') || pattern.includes('/')
  const body = pattern.startsWith('/') ? pattern.slice(1) : pattern
  const isDir = body.endsWith('/')
  const clean = isDir ? body.slice(0, -1) : body

  // A slash-free pattern is unanchored, so `docs/` matches at any depth -- which is
  // CODEOWNERS' documented behaviour and a common source of surprise if you assume
  // otherwise.
  const re = new RegExp(`^${globToBody(clean, anchored, isDir)}$`)
  return re.test(path)
}

/**
 * Translate a CODEOWNERS glob to a regular expression body.
 *
 * Scans characters rather than chaining `String.replace`, because `**` and `*` need to
 * be distinguished and a chain needs a sentinel to carry that across the passes -- and a
 * sentinel is exactly the kind of thing that ends up in a source file as a literal NUL.
 */
function globToBody(pattern: string, anchored: boolean, isDir: boolean): string {
  let out = anchored ? '' : '(?:.*/)?'
  let i = 0
  while (i < pattern.length) {
    const ch = pattern[i] as string
    if (ch === '*') {
      const isDouble = pattern[i + 1] === '*'
      if (isDouble) {
        out += '.*'
        i += 2
        // `**/` should also match zero directories, so swallow the separator.
        if (pattern[i] === '/') {
          out = `${out.slice(0, -2)}(?:.*/)?`
          i += 1
        }
        continue
      }
      out += '[^/]*'
      i += 1
      continue
    }
    if (/[.+^${}()|[\]\\]/.test(ch)) out += `\\${ch}`
    else out += ch
    i += 1
  }
  if (isDir) out += '(?:/.*)?'
  return out
}

/** CODEOWNERS content read from the profile, or null when the repo has none. */
export function codeownersFor(profile: ProjectProfile, read: (rel: string) => string | null): string | null {
  if (profile.docs.codeowners === null) return null
  return read(profile.docs.codeowners)
}

// ---------------------------------------------------------------------------
// PR body
// ---------------------------------------------------------------------------

export interface PrBodyInput {
  ticket: Ticket
  risk: RiskAnalysis
  /** Extra reviewers resolved from CODEOWNERS. */
  reviewers: string[]
  /** Commands the project documents, so the reviewer knows what "verified" meant. */
  verifyCommands: string[]
  /** Test results, when `ship` actually ran them. */
  verification?: { command: string; ok: boolean; detail?: string }[]
  /** True when this PR replaces an existing one. */
  isUpdate?: boolean
}

/**
 * Render the PR body.
 *
 * The closing keyword is provider-correct for GitHub. A provider whose merge syntax
 * differs gets a different keyword from the provider's own template, not a guess here.
 */
export function renderPrBody(input: PrBodyInput): string {
  const { ticket, risk, reviewers, verification } = input
  const out: string[] = []

  // The description comes first: a reviewer should not have to scroll to learn what the
  // change is for.
  if (ticket.body !== undefined && ticket.body.trim() !== '') {
    out.push(ticket.body.trim())
    out.push('')
  } else {
    out.push(`_${ticket.title}_`)
    out.push('')
  }

  if (ticket.acceptance !== undefined && ticket.acceptance.length > 0) {
    out.push('### Acceptance criteria')
    out.push('')
    for (const item of ticket.acceptance) out.push(`- [ ] ${item}`)
    out.push('')
  }

  if (verification !== undefined && verification.length > 0) {
    out.push('### Verification')
    out.push('')
    out.push('| Command | Result |')
    out.push('| --- | --- |')
    for (const v of verification) {
      out.push(`| \`${v.command}\` | ${v.ok ? 'pass' : 'FAIL'} |`)
    }
    out.push('')
  } else if (input.verifyCommands.length > 0) {
    out.push('### Verification')
    out.push('')
    out.push("Not run by anvil. These are the project's own commands:")
    out.push('')
    for (const cmd of input.verifyCommands) out.push(`- \`${cmd}\``)
    out.push('')
  }

  // The risk checklist is conditional on the diff, and says which files triggered it.
  if (risk.level !== null) {
    out.push(`### ⚠️ ${risk.level === 'high' ? 'High' : 'Medium'}-risk changes`)
    out.push('')
    if (risk.highPaths.length > 0) {
      out.push('This change touches paths the project marks as high risk. Please confirm:')
      out.push('')
      for (const r of risk.touched.filter((t) => t.level === 'high')) {
        out.push(`- [ ] \`${r.glob}\` — ${r.reason}`)
      }
      out.push('')
      out.push(
        `Files: ${risk.highPaths
          .slice(0, 10)
          .map((p) => `\`${p}\``)
          .join(', ')}${risk.highPaths.length > 10 ? ` (+${risk.highPaths.length - 10} more)` : ''}`,
      )
      out.push('')
    } else if (risk.mediumPaths.length > 0) {
      out.push('This change touches paths the project marks as needing care:')
      out.push('')
      for (const r of risk.touched) out.push(`- [ ] \`${r.glob}\` — ${r.reason}`)
      out.push('')
    }
  }

  if (reviewers.length > 0) {
    out.push('### Reviewers')
    out.push('')
    out.push(`Requested by CODEOWNERS: ${reviewers.map((r) => `@${r.replace(/^@/, '')}`).join(', ')}`)
    out.push('')
  }

  out.push('---')
  out.push('')
  // The closing keyword is what transitions the ticket on merge.
  out.push(closingKeyword(ticket))
  out.push('')
  out.push(input.isUpdate === true ? '_Updated by `anvil ship`._' : '_Opened by `anvil ship`._')
  out.push('')
  return out.join('\n')
}

/**
 * The merge-closing keyword for a ticket, per provider syntax.
 *
 * GitHub and GitLab only auto-close an issue when the reference resolves: `#42`,
 * `owner/repo#42`, or a full issue URL. The human key anvil mints (`gh-42`, `gl-42`) is
 * *not* one of those forms -- `Closes gh-42` renders as ordinary prose and the ticket
 * stays open after merge, silently. So the provider-native id is used, with the `#` the
 * forges require.
 */
export function closingKeyword(ticket: Ticket): string {
  switch (ticket.ref.provider) {
    case 'github':
    case 'gitlab':
      return `Closes #${ticket.ref.id}`
    case 'local':
      // A local ticket is not on a forge, so there is nothing to close. Say where the
      // ticket is instead of emitting a keyword that would do nothing.
      return `_Ticket: ${ticket.ref.key} (local)_`
    default:
      return `Refs ${ticket.ref.key}`
  }
}

/** PR title: the ticket title, prefixed with the key so it is greppable in a list. */
export function renderPrTitle(ticket: Ticket): string {
  return `${ticket.ref.key}: ${ticket.title}`.slice(0, 240)
}
