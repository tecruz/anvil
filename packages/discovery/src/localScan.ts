/**
 * The local scan: agent tooling already installed on this machine.
 *
 * This is the one source that answers the question the whole package exists for, and it
 * answers it with no network at all. The question was "can anvil detect that Android has an
 * official CLI and agent skills" -- and on a machine where they are installed, they are
 * sitting in `~/.agents/skills` with a `name` and a `description` in their frontmatter. That
 * is evidence, in the sense this codebase uses the word: a file on disk saying so.
 *
 * So a `plan` can say "you already have 18 Android agent skills installed, including
 * `navigation-3`" without asking anybody, on a locked-down network, offline. Every network
 * source in this package can fail; this one cannot, which is why it is not behind the
 * `--online` gate that governs the others.
 *
 * What it deliberately does not do is claim a skill is official. A directory called
 * `android-skills` proves someone installed it, not who wrote it -- that is what the org
 * check on GitHub results is for. Local skills are reported as `official`-shaped guidance
 * with the install path as the evidence, and the `why` says where it was found rather than
 * who maintains it.
 */

import { type Dirent, existsSync, readdirSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

export interface LocalSkill {
  /** The skill's frontmatter `name`, or the directory name when it has none. */
  name: string
  /** First line of the frontmatter `description`. */
  description: string
  /**
   * Every frontmatter scalar, joined.
   *
   * What matching runs against rather than `description`, so a skill that names its
   * technology in `keywords:` or `metadata:` is matched on the same footing as one that
   * mentions it in prose. On a machine with Google's Play Engage SDK skill installed --
   * which is an Android skill whose description says "Play Engage SDK" and never says
   * "Android" -- this is the difference between finding it and not.
   */
  haystack: string
  /** Absolute path to the SKILL.md, which is what a reader has to open. */
  path: string
  /** Directory the skill was found under, e.g. `~/.agents/skills`. */
  root: string
}

export interface LocalScanOptions {
  /** Overrides the home directory. Used by tests, and honoured by `ANVIL_CONFIG_HOME`. */
  env?: NodeJS.ProcessEnv
  /** Extra roots to scan, e.g. the repository being audited. */
  extraRoots?: readonly string[]
}

/**
 * Where agent skills live, in the order they are listed in a report.
 *
 * Each is a directory containing one subdirectory per skill, each with a `SKILL.md`. The
 * two layouts are the same shape in two different tools' conventions, and a machine
 * commonly has both -- scanning only one would report half of what is installed, which
 * reads as "you have four skills" rather than "you have four of eighteen".
 *
 * `repoRoot` is not here: a repository's own skills are a fact about the repository, and
 * `profile` already detects them for `doctor`. This scans the user's global install, which
 * is the thing no other command knows about.
 */
export function skillSearchRoots(env: NodeJS.ProcessEnv = process.env): string[] {
  const override = env.ANVIL_CONFIG_HOME
  const home = override !== undefined && override !== '' ? override : homedir()
  return [join(home, '.agents', 'skills'), join(home, '.config', 'opencode', 'skills'), join(home, '.claude', 'skills')]
}

/**
 * Frontmatter fields, read leniently.
 *
 * Returns every scalar field, not just `name` and `description`, because the haystack a
 * match is tested against should include whatever else a skill says about itself. A skill
 * that declares `keywords: [android, compose]` is making the same claim as one that writes
 * "Android" in its description, and reading only the two conventional keys would miss it.
 */
function frontmatter(text: string): { name: string | null; description: string; all: string } {
  // A SKILL.md without frontmatter is not malformed, it is just a document: opencode reads
  // the body as the description. Treating the missing block as a parse failure would drop
  // every skill written before the convention existed.
  const empty = { name: null, description: '', all: '' }
  if (!text.startsWith('---')) return { ...empty, description: firstProseLine(text), all: firstProseLine(text) }
  const end = text.indexOf('\n---', 3)
  if (end === -1) return { ...empty, description: firstProseLine(text), all: firstProseLine(text) }
  const block = text.slice(3, end)

  const fields = new Map<string, string[]>()
  // Which key the most recent `key:` line opened, so an indented line that is not itself a
  // key continues it.
  //
  // This is the whole function, and getting it wrong is silent rather than loud: a plain
  // multi-line scalar is the *common* way these files are written --
  //
  //     description: Helps developers integrate, debug, and resolve Play Engage SDK
  //       issues. Use when adding Engage SDK support,
  //
  // -- so truncating at the first line drops the half of the description that usually
  // contains the technology name. Every skill whose `Android` appeared on line two then
  // failed to match, and the symptom was "anvil found 13 of 18" with no error anywhere.
  let currentKey: string | null = null

  for (const line of block.split(/\r?\n/)) {
    const keyMatch = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(line)
    if (keyMatch !== null) {
      currentKey = keyMatch[1] ?? null
      const rest = (keyMatch[2] ?? '').trim()
      if (currentKey === null) continue
      const list = fields.get(currentKey) ?? []
      fields.set(currentKey, list)
      // A block scalar indicator (`>`, `>-`, `|`, `|-`) carries no text of its own; the text
      // is on the lines below, which the continuation branch collects.
      if (rest !== '>' && rest !== '>-' && rest !== '|' && rest !== '|-' && rest !== '') {
        list.push(rest.replace(/^['"]|['"]$/g, ''))
      }
      continue
    }
    // Indented and not a key: a continuation of the value above it.
    if (currentKey !== null && /^\s+\S/.test(line)) {
      const list = fields.get(currentKey)
      if (list !== undefined) list.push(line.trim())
      continue
    }
    // A block sequence item under the current key:
    //
    //     keywords:
    //     - android
    //     - engage sdk
    //
    // Both shapes occur in these files, and dropping the sequence shape loses exactly the
    // field that names the technology when the description does not. It was found by the
    // test above rather than by reading this code.
    const itemMatch = /^\s*-\s+(.+)$/.exec(line)
    if (currentKey !== null && itemMatch !== null) {
      const list = fields.get(currentKey)
      if (list !== undefined) list.push((itemMatch[1] ?? '').trim().replace(/^['"]|['"]$/g, ''))
      continue
    }
    // A dash at column 0 that is not an item, or any other unrecognised line: end the
    // current value rather than folding an unrelated line into it.
    currentKey = null
  }

  const join = (key: string): string => (fields.get(key) ?? []).join(' ').replace(/\s+/g, ' ').trim()
  const name = join('name')
  const description = join('description')
  const all = [...fields.values()].flat().join(' ').replace(/\s+/g, ' ').trim()
  return { name: name === '' ? null : name, description, all: all === '' ? description : all }
}

function firstProseLine(text: string): string {
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (trimmed === '' || trimmed.startsWith('#')) continue
    return trimmed.slice(0, 200)
  }
  return ''
}

/**
 * Find every installed skill under the search roots.
 *
 * One level deep, deliberately: the convention is `<root>/<name>/SKILL.md`, and recursing
 * would also pick up reference material and example directories that are not skills.
 * A `SKILL.md` that fails to read is skipped rather than thrown -- one unreadable file in
 * someone else's tool directory must not stop the scan.
 */
export function scanLocalSkills(options: LocalScanOptions = {}): LocalSkill[] {
  const roots = [...skillSearchRoots(options.env), ...(options.extraRoots ?? [])]
  const out: LocalSkill[] = []
  for (const root of roots) {
    if (!existsSync(root)) continue
    let entries: Dirent[]
    try {
      entries = readdirSync(root, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      const skillFile = join(root, entry.name, 'SKILL.md')
      if (!existsSync(skillFile)) continue
      let text: string
      try {
        text = readFileSync(skillFile, 'utf8')
      } catch {
        continue
      }
      const fm = frontmatter(text)
      const name = fm.name ?? entry.name
      out.push({
        name,
        description: fm.description,
        haystack: fm.all === '' ? `${name} ${fm.description}` : fm.all,
        path: skillFile,
        root,
      })
    }
  }
  return out
}

/**
 * True when a skill's name or description mentions a playbook's technology.
 *
 * A whole-word substring test against the playbook id, its id split into words, and each
 * seeded keyword's leading term. Conservative on purpose: a false positive puts an unrelated
 * skill in an Android plan, and a reader who sees one wrong entry stops reading the rest.
 * Two words of "android" in a sentence is a mention; "and" matching "android" is not,
 * which is why the pattern requires a non-word character at each boundary.
 */
export function skillMatchesSeeds(skill: LocalSkill, terms: readonly string[]): boolean {
  const haystack = skill.haystack.toLowerCase()
  for (const term of terms) {
    const needle = term.toLowerCase().trim()
    if (needle.length < 4) continue
    const pattern = new RegExp(`(^|[^a-z0-9])${needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([^a-z0-9]|$)`)
    if (pattern.test(haystack)) return true
  }
  return false
}
