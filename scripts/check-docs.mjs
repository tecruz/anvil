/**
 * `npm run check:docs` -- the documentation is checked, not hoped for.
 *
 * A document that names a command which was renamed is the same defect as a test that
 * asserts a function that was deleted: the claim is still there, and it is still false.
 * The rule that caught it in the code is `CI_PARITY`; this is the same idea applied to
 * prose.
 *
 * Three checks, all of them cheap and all of them able to fail:
 *
 *   1. **Relative links resolve.** Every `[text](target)` in every document points at a
 *      file that exists, and every `#anchor` in a repository document points at a
 *      heading that exists. A renamed file or a moved section is a broken link, and a
 *      broken link is a reader who gives up.
 *
 *   2. **`anvil <command>` names a real command.** The command list is read from the
 *      source of truth -- the `name:` of each command in `packages/cli/src/commands` --
 *      rather than from the built bundle, so the check works before a build and cannot
 *      pass because a stale `dist/` happened to be lying around.
 *
 *   3. **`npm run <script>` names a real script.** The manifest is the source of truth.
 *      A documented command that does not exist is worse than an undocumented one.
 *
 * Scope, and the reasons for it:
 *
 *   - **Only code is checked for command and script names.** A command in prose is not
 *     an instruction; a command in a fenced block or a code span is. Looking at prose
 *     would flag the English ("anvil is deterministic") as a broken command.
 *
 *   - **`IMPLEMENTATION_PLAN.md` is exempt from checks 2 and 3.** It is history: it
 *     records commands and scripts that existed at the time, including ones that have
 *     since been renamed, and its links are still checked because a link in a
 *     historical document is either right or broken.
 *
 * The check is part of `npm run check`, which is what CI runs, so a documentation
 * regression is a red build rather than a thing somebody notices next quarter.
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/** Directories whose markdown is documentation of this project. */
const DOC_DIRS = ['docs', '.github', '.agents', '.opencode']

/** Markdown files at the repository root that are documentation. */
const ROOT_DOCS = ['README.md', 'CONTRIBUTING.md', 'SECURITY.md', 'AGENTS.md']

/** History: links are checked, but the commands it names are not. */
const HISTORICAL = ['IMPLEMENTATION_PLAN.md']

/** Directories never walked: build output, dependencies, fixtures, and the eval corpus. */
const SKIP_DIRS = new Set(['node_modules', 'dist', '.git', 'fixtures', 'eval', 'eval-results', '.anvil'])

/** @type {{ file: string, problems: string[] }[]} */
const problems = []

function report(file, message) {
  problems.push({ file: relative(repoRoot, file).replace(/\\/g, '/'), message })
}

/** Every markdown file under a directory, recursively. */
function collectMarkdown(dir, acc = []) {
  if (!existsSync(dir)) return acc
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (SKIP_DIRS.has(entry.name)) continue
    const full = join(dir, entry.name)
    if (entry.isDirectory()) collectMarkdown(full, acc)
    else if (entry.name.endsWith('.md')) acc.push(full)
  }
  return acc
}

/** The documents this check reads. */
function documents() {
  const files = []
  for (const name of ROOT_DOCS) {
    const full = join(repoRoot, name)
    if (existsSync(full)) files.push(full)
  }
  for (const dir of DOC_DIRS) collectMarkdown(join(repoRoot, dir), files)
  // The plugin is published on its own, so its README is documentation too.
  collectMarkdown(join(repoRoot, 'packages'), files)
  for (const name of HISTORICAL) {
    const full = join(repoRoot, name)
    if (existsSync(full)) files.push(full)
  }
  return files.filter((file, index) => files.indexOf(file) === index)
}

/**
 * The code in a document: fenced blocks and inline code spans.
 *
 * Prose is excluded on purpose. A command inside a sentence is not an instruction, and
 * the English around it is not a command name.
 */
function codeChunks(text) {
  const chunks = []
  const fences = /```[^\n]*\n([\s\S]*?)```/g
  let match = fences.exec(text)
  while (match !== null) {
    chunks.push(match[1])
    match = fences.exec(text)
  }
  const spans = /`([^`\n]+)`/g
  match = spans.exec(text)
  while (match !== null) {
    chunks.push(match[1])
    match = spans.exec(text)
  }
  return chunks
}

/** GitHub's heading slug: lower case, punctuation dropped, spaces become hyphens. */
function slugify(heading) {
  return heading
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s_-]/gu, '')
    .trim()
    .replace(/\s+/g, '-')
}

/** The slugs of every heading in a markdown file. */
function headingsOf(text) {
  const slugs = []
  for (const line of text.split('\n')) {
    const match = /^#{1,6}\s+(.*)$/.exec(line)
    if (match !== null) slugs.push(slugify(match[1].replace(/`/g, '')))
  }
  return slugs
}

/** A markdown link target, without the surrounding angle brackets. */
function cleanTarget(raw) {
  let target = raw.trim()
  if (target.startsWith('<') && target.endsWith('>')) target = target.slice(1, -1)
  return target
}

/** Every inline link target in a document. */
function linkTargets(text) {
  const targets = []
  const pattern = /!?\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g
  let match = pattern.exec(text)
  while (match !== null) {
    targets.push(match[1])
    match = pattern.exec(text)
  }
  return targets
}

/** True when a link points somewhere this check cannot follow. */
function isExternal(target) {
  return /^(https?:|mailto:|tel:)/i.test(target)
}

/** The command names, read from the CLI's own source of truth. */
function commandNames() {
  const dir = join(repoRoot, 'packages', 'cli', 'src', 'commands')
  const names = new Set()
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith('.ts')) continue
    const text = readFileSync(join(dir, entry.name), 'utf8')
    const pattern = /\bname: '([a-z][a-z-]*)'/g
    let match = pattern.exec(text)
    while (match !== null) {
      names.add(match[1])
      match = pattern.exec(text)
    }
  }
  return names
}

/** The npm scripts the manifest defines. */
function scriptNames() {
  const manifest = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8'))
  return new Set(Object.keys(manifest.scripts ?? {}))
}

const commands = commandNames()
const scripts = scriptNames()
const files = documents()
let linkCount = 0
let commandCount = 0
let scriptCount = 0

for (const file of files) {
  const text = readFileSync(file, 'utf8')
  const isHistorical = HISTORICAL.includes(relative(repoRoot, file).replace(/\\/g, '/'))

  for (const raw of linkTargets(text)) {
    const target = cleanTarget(raw)
    if (target === '' || isExternal(target)) continue
    linkCount++
    if (target.startsWith('#')) {
      const slug = slugify(target.slice(1))
      if (!headingsOf(text).includes(slug)) {
        report(file, `anchor does not exist: ${target}`)
      }
      continue
    }
    const [path, anchor] = target.split('#')
    const resolved = resolve(dirname(file), path)
    if (!existsSync(resolved)) {
      report(file, `link target does not exist: ${target}`)
      continue
    }
    if (anchor === undefined || anchor === '') continue
    if (!resolved.endsWith('.md') || !resolved.startsWith(repoRoot)) continue
    if (!headingsOf(readFileSync(resolved, 'utf8')).includes(slugify(anchor))) {
      report(file, `anchor does not exist: ${target}`)
    }
  }

  if (isHistorical) continue

  for (const chunk of codeChunks(text)) {
    const commandPattern = /\banvil\s+([a-z][a-z0-9-]*)/g
    let match = commandPattern.exec(chunk)
    while (match !== null) {
      commandCount++
      if (!commands.has(match[1])) {
        report(file, `unknown command: \`anvil ${match[1]}\``)
      }
      match = commandPattern.exec(chunk)
    }

    const scriptPattern = /\bnpm run ([a-z0-9:_-]+)/g
    match = scriptPattern.exec(chunk)
    while (match !== null) {
      scriptCount++
      if (!scripts.has(match[1])) {
        report(file, `unknown script: \`npm run ${match[1]}\``)
      }
      match = scriptPattern.exec(chunk)
    }
  }
}

if (problems.length > 0) {
  for (const problem of problems) {
    process.stdout.write(`${problem.file}: ${problem.message}\n`)
  }
  process.stdout.write(`docs check: ${problems.length} problem(s) in ${files.length} documents\n`)
  process.exit(1)
}

process.stdout.write(
  `docs check: ${files.length} documents, ${linkCount} links, ${commandCount} command mentions, ${scriptCount} script mentions\n`,
)
