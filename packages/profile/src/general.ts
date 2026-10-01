/**
 * Ecosystem-agnostic repo facts: instruction files, docs, CI, the blast-radius map, and
 * commands found written in prose.
 *
 * Not a stack detector -- this runs for every repo regardless of language, and it is
 * where the highest-value readiness evidence comes from, because "does this repo tell an
 * agent what to do and how to check its work" is language-independent.
 */

import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { addCommand, addRisk, addTool, COMMIT_HOOK_FILES, type ProfileDraft } from './detector.ts'
import { evidence } from './manifest.ts'
import type { Docs, InstructionFile } from './types.ts'
import { firstExisting, readText } from './walk.ts'

/**
 * Instruction files, in the precedence order opencode applies.
 *
 * Recorded rather than assumed: precedence is a *loader* detail that differs between
 * tools, and a profile that claims "AGENTS.md is the source of truth" when the repo only
 * has CLAUDE.md sends a reviewer down the wrong path.
 */
const INSTRUCTION_CANDIDATES: ReadonlyArray<{
  rel: string
  category: InstructionFile['category']
}> = [
  { rel: 'AGENTS.md', category: 'agents' },
  { rel: 'CLAUDE.md', category: 'claude' },
  { rel: '.github/copilot-instructions.md', category: 'copilot' },
  { rel: '.cursorrules', category: 'cursor' },
  { rel: '.cursor/rules', category: 'cursor' },
  { rel: 'GEMINI.md', category: 'agents' },
]

export function detectInstructionFiles(root: string, files: ReadonlySet<string>): InstructionFile[] {
  const out: InstructionFile[] = []
  for (const candidate of INSTRUCTION_CANDIDATES) {
    if (candidate.rel.endsWith('/rules')) {
      const members = [...files].filter((f) => f.startsWith(`${candidate.rel}/`))
      if (members.length === 0) continue
      out.push({ path: candidate.rel, category: candidate.category, bytes: 0 })
      continue
    }
    if (!files.has(candidate.rel)) continue
    const { bytes } = readText(join(root, candidate.rel))
    out.push({ path: candidate.rel, category: candidate.category, bytes })
  }
  return out
}

export function detectDocs(root: string): Docs {
  const any = (candidates: readonly string[]): string | null => firstExisting(root, candidates)
  return {
    readme: any(['README.md', 'README.rst', 'README.txt', 'README', 'readme.md', 'docs/README.md']),
    contributing: any(['CONTRIBUTING.md', 'CONTRIBUTING', 'docs/CONTRIBUTING.md', '.github/CONTRIBUTING.md']),
    security: any(['SECURITY.md', 'docs/SECURITY.md', '.github/SECURITY.md']),
    license: any(['LICENSE', 'LICENSE.md', 'LICENSE.txt', 'LICENCE', 'COPYING']),
    architecture: any([
      'ARCHITECTURE.md',
      'docs/ARCHITECTURE.md',
      'docs/architecture.md',
      'architecture.md',
      'docs/architecture/README.md',
      'doc/architecture.md',
    ]),
    adr: any(['docs/adr', 'doc/adr', 'adr', 'docs/decisions', 'architecture/decisions']),
    codeowners: any(['CODEOWNERS', '.github/CODEOWNERS', 'docs/CODEOWNERS', '.gitlab/CODEOWNERS']),
    prTemplate: any([
      '.github/pull_request_template.md',
      '.github/PULL_REQUEST_TEMPLATE.md',
      '.github/PULL_REQUEST_TEMPLATE',
      'docs/pull_request_template.md',
    ]),
    issueTemplate: any(['.github/ISSUE_TEMPLATE', '.github/ISSUE_TEMPLATE.md', '.github/ISSUE_TEMPLATE/config.yml']),
  }
}

/**
 * The blast-radius map.
 *
 * Every entry is a path pattern where a wrong change is expensive, slow to detect, or
 * dangerous. The globs are deliberately language-agnostic: the migrations pattern matches
 * a Django migration, a Rails migration and a Flyway migration alike.
 */
const RISK_HEURISTICS: ReadonlyArray<{
  glob: string
  level: 'high' | 'medium'
  reason: string
}> = [
  {
    glob: '**/migrations/**',
    level: 'high',
    reason: 'schema or data migration',
  },
  {
    glob: '**/migration/**',
    level: 'high',
    reason: 'schema or data migration',
  },
  { glob: '**/alembic/**', level: 'high', reason: 'database migration' },
  { glob: '**/db/migrate/**', level: 'high', reason: 'database migration' },
  { glob: '**/*.tf', level: 'high', reason: 'infrastructure-as-code' },
  {
    glob: '**/*.tfvars',
    level: 'high',
    reason: 'infrastructure variables, may hold secrets',
  },
  { glob: 'infra/**', level: 'high', reason: 'infrastructure definitions' },
  { glob: 'terraform/**', level: 'high', reason: 'infrastructure definitions' },
  { glob: 'deploy/**', level: 'high', reason: 'deployment configuration' },
  { glob: 'k8s/**', level: 'high', reason: 'kubernetes manifests' },
  { glob: '**/k8s/**', level: 'high', reason: 'kubernetes manifests' },
  { glob: 'helm/**', level: 'high', reason: 'helm charts' },
  {
    glob: '.github/workflows/**',
    level: 'high',
    reason: 'CI definition; a change can silently disable checks',
  },
  {
    glob: 'Dockerfile*',
    level: 'medium',
    reason: 'build and runtime image definition',
  },
  {
    glob: '**/Dockerfile*',
    level: 'medium',
    reason: 'build and runtime image definition',
  },
  {
    glob: 'docker-compose*.y*ml',
    level: 'medium',
    reason: 'local service topology',
  },
  {
    glob: '**/auth/**',
    level: 'high',
    reason: 'authentication or authorization logic',
  },
  { glob: '**/security/**', level: 'high', reason: 'security logic' },
  { glob: '**/permissions/**', level: 'high', reason: 'permissions logic' },
  { glob: '**/crypto/**', level: 'high', reason: 'cryptography' },
  { glob: '**/payments/**', level: 'high', reason: 'payment processing' },
  { glob: '**/billing/**', level: 'high', reason: 'billing logic' },
  {
    glob: '**/package.json',
    level: 'medium',
    reason: 'dependency manifest; a change moves the supply chain',
  },
  { glob: 'Cargo.lock', level: 'medium', reason: 'pinned dependency graph' },
  { glob: 'poetry.lock', level: 'medium', reason: 'pinned dependency graph' },
  { glob: 'go.sum', level: 'medium', reason: 'pinned dependency checksums' },
  {
    glob: 'gradle.lockfile',
    level: 'medium',
    reason: 'pinned dependency graph',
  },
  {
    glob: 'pnpm-lock.yaml',
    level: 'medium',
    reason: 'pinned dependency graph',
  },
  { glob: 'uv.lock', level: 'medium', reason: 'pinned dependency graph' },
]

/** Push risk entries for globs the repo actually contains something matching. */
export function addRiskHeuristics(draft: ProfileDraft, files: ReadonlySet<string>): void {
  for (const heuristic of RISK_HEURISTICS) {
    if (!matchesAny(files, heuristic.glob)) continue
    addRisk(draft, { ...heuristic, origin: 'heuristic' })
  }
}

/**
 * Glob matcher for the recursive and single-segment shapes the heuristics use.
 *
 * Deliberately not a general glob engine: supporting single-star within a segment and
 * double-star across segments covers every pattern above. A full engine would add a place
 * where a parsing bug turns "matched nothing" into "matched everything" -- which, for a
 * risk map, means flagging the entire repository.
 */
export function globToRegExp(glob: string): RegExp {
  const escaped = glob.replace(/[.+^${}()|[\]\\]/g, '\\$&')
  const body = escaped
    // A double-star followed by a slash may match zero directories, so the pattern for
    // "migrations anywhere" also matches a top-level migrations directory.
    .replace(/\*\*\//g, '(?:.*/)?')
    .replace(/\*\*/g, '.*')
    .replace(/\*/g, '[^/]*')
  return new RegExp(`^${body}$`)
}

export function matchesAny(files: Iterable<string>, glob: string): boolean {
  const re = globToRegExp(glob)
  for (const f of files) {
    if (re.test(f)) return true
  }
  return false
}

export function matchesGlob(path: string, glob: string): boolean {
  return globToRegExp(glob).test(path)
}

/** CI, hooks, container and IaC detection, shared across ecosystems. */
export function detectGenericTooling(
  draft: ProfileDraft,
  root: string,
  files: ReadonlySet<string>,
  resolve: (rel: string) => string = (rel) => rel,
): void {
  for (const f of files) {
    if (f.startsWith('.github/workflows/') && /\.ya?ml$/.test(f)) addTool(draft, 'ci', f)
    else if (/^\.gitlab-ci\.ya?ml$/.test(f)) addTool(draft, 'ci', f)
    else if (/^(azure-pipelines\.ya?ml|Jenkinsfile)$/.test(f)) addTool(draft, 'ci', f)
    else if (f.startsWith('.circleci/')) addTool(draft, 'ci', f)
  }
  const hook = COMMIT_HOOK_FILES.find(([f]) => files.has(resolve(f)))
  if (hook !== undefined) addTool(draft, 'hooks', hook[1])
  if (existsSync(join(root, 'Dockerfile')) || hasAny(files, ['docker-compose.yml', 'compose.yaml', 'compose.yml'])) {
    addTool(draft, 'container', 'docker')
  }
  for (const f of files) {
    if (!f.endsWith('.tf')) continue
    addTool(draft, 'iac', f.includes('/') ? f.slice(0, f.lastIndexOf('/')) : '.')
  }
  detectInstallCommand(draft, root, files, resolve)
}

/**
 * The install command, derived from the lockfile.
 *
 * Ten real repositories, and every one of them reported "no documented dependency-install
 * command" -- because nothing ever emitted an `install` command. The kind existed in the
 * type, the generated `AGENTS.md` had a row for it, and no detector filled it in.
 *
 * A lockfile is the evidence, not a guess: `package-lock.json` means npm, `pnpm-lock.yaml`
 * means pnpm, and the file's existence proves both the package manager and that the
 * install is meant to be reproducible (`npm ci`, not `npm install`). Each is labelled
 * `detected` because a file on disk is exactly that. Where the manager has a lockfile but
 * the install needs arguments we cannot know, the plain form is still the honest answer --
 * and the risk of a wrong one is an install that prints a warning, not a lost afternoon.
 */
function detectInstallCommand(
  draft: ProfileDraft,
  root: string,
  files: ReadonlySet<string>,
  resolve: (rel: string) => string,
): void {
  // Yarn first, and separately, because the *flag* differs between the two Yarn lineages:
  // Berry (2+) replaced `--frozen-lockfile` with `--immutable` and rejects the old one
  // instead of ignoring it, so a Berry repository given the Yarn 1 command gets an error on
  // its first install. A Berry lockfile carries a `__metadata` block, which is how the two are
  // told apart -- a version guess would be exactly the confident-and-wrong output this file
  // exists to avoid.
  const yarnLock = resolve('yarn.lock')
  if (files.has(yarnLock)) {
    const berry = isYarnBerry(root, yarnLock)
    addCommand(draft, 'install', {
      cmd: berry ? 'yarn install --immutable' : 'yarn install --frozen-lockfile',
      source: 'detected',
      evidence: yarnLock,
    })
    return
  }

  // A lockfile is the strongest evidence: it names the manager *and* proves the install is
  // meant to be reproducible, so these are `detected`.
  //
  // Two ecosystems are deliberately absent, for the same reason Go and Bazel are: there is no
  // install step, because the build resolves dependencies itself. Emitting one anyway invites
  // the command that looks closest -- `./gradlew dependencies --write-locks`, which *rewrites*
  // `gradle.lockfile` -- and that would tell a new contributor to mutate a pinned dependency
  // graph as their first step, labelled `detected` so it reads as authoritative.
  const byLockfile: ReadonlyArray<readonly [string, string]> = [
    ['pnpm-lock.yaml', 'pnpm install --frozen-lockfile'],
    ['bun.lockb', 'bun install --frozen-lockfile'],
    ['package-lock.json', 'npm ci'],
    ['uv.lock', 'uv sync --frozen'],
    ['poetry.lock', 'poetry install'],
    ['Cargo.lock', 'cargo fetch --locked'],
    ['Gemfile.lock', 'bundle install'],
  ]
  for (const [lockfile, cmd] of byLockfile) {
    if (!files.has(resolve(lockfile))) continue
    addCommand(draft, 'install', { cmd, source: 'detected', evidence: lockfile })
    return
  }

  // No lockfile. The manifest still names the package manager, but the *form* of the
  // install is a convention, so these are `inferred` and labelled as such.
  //
  // Note what is deliberately absent: `npm ci` requires a lockfile and fails without one,
  // so a Node project that has committed no lockfile gets `npm install`. Recommending the
  // reproducible form to a repository that cannot run it is the same confident-and-wrong
  // failure this tool exists to avoid, and it would be the first command a new contributor
  // types.
  const byManifest: ReadonlyArray<readonly [string, string]> = [
    ['composer.json', 'composer install'],
    ['Gemfile', 'bundle install'],
    ['requirements.txt', 'pip install -r requirements.txt'],
    ['pyproject.toml', 'pip install -e .'],
    ['package.json', 'npm install'],
  ]
  for (const [manifest, cmd] of byManifest) {
    if (!files.has(resolve(manifest))) continue
    addCommand(draft, 'install', { cmd, source: 'inferred', evidence: manifest })
    return
  }
}

/** True for a Yarn Berry lockfile, which starts with a `__metadata` block. */
function isYarnBerry(root: string, relPath: string): boolean {
  const { text } = readText(join(root, ...relPath.split('/')))
  return text !== null && /^\s*__metadata:/m.test(text)
}

function hasAny(files: ReadonlySet<string>, candidates: readonly string[]): boolean {
  return candidates.some((c) => files.has(c))
}

// ---------------------------------------------------------------------------
// Documented commands
// ---------------------------------------------------------------------------

const DOC_CANDIDATES: readonly string[] = [
  'README.md',
  'CONTRIBUTING.md',
  'AGENTS.md',
  'CLAUDE.md',
  'Makefile',
  'docs/development.md',
  'docs/CONTRIBUTING.md',
  'docs/DEVELOPMENT.md',
]

/**
 * Kind patterns for prose commands, most specific first: `testFast` before `test`, or
 * `npm run test:fast` gets classified as a full suite.
 */
const DOC_PATTERNS: ReadonlyArray<{ kind: string; re: RegExp }> = [
  {
    kind: 'testFast',
    // Two shapes, because they do not overlap: a fast-test *script* named
    // `test:changed`, and a full-suite runner *given* a changed-files filter. Matching
    // `\btest\b` first would consume the `test` in `test:changed` and leave nothing for
    // the marker to match.
    re: /(?:\b(?:npm|pnpm|yarn|bun)\s+run\s+test[:-](?:fast|changed|quick|affected)\b)|(?:\b(?:test|it)\b[^\n]{0,50}(?:--changed|--changedSince|-k\s|--onlyChanged|--tests|nextest))/i,
  },
  {
    kind: 'test',
    re: /(npm (run )?test|yarn test|pnpm test|bun test|pytest|go test|cargo test|dotnet test|mvnw? test|gradlew? test|jest\b|vitest\b)/,
  },
  {
    kind: 'build',
    re: /(npm (run )?build|yarn build|pnpm build|cargo build|dotnet build|gradlew? build|mvnw? package|go build)/,
  },
  {
    kind: 'lint',
    re: /(npm (run )?lint|eslint\b|ruff check|golangci-lint|cargo clippy|dotnet format)/,
  },
  { kind: 'typecheck', re: /(tsc --noEmit|typecheck|pyright|mypy)/ },
]

export interface DocumentedCommand {
  kind: string
  cmd: string
  evidence: string
}

/**
 * Find commands written in prose.
 *
 * These are the only `documented` commands, because a human wrote them down and an agent
 * can be pointed at the line. A script named `test` in package.json is `detected`, not
 * documented -- it may do anything at all.
 */
export function detectDocumentedCommands(root: string, files: ReadonlySet<string>): DocumentedCommand[] {
  const out: DocumentedCommand[] = []
  const seen = new Set<string>()

  for (const rel of DOC_CANDIDATES) {
    if (!files.has(rel)) continue
    const { text } = readText(join(root, rel))
    if (text === null) continue
    const lines = text.split('\n')
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i] ?? ''
      if (!looksLikeCommandLine(line)) continue
      const cmd = extractCommand(line)
      if (cmd === null) continue
      for (const pattern of DOC_PATTERNS) {
        if (!pattern.re.test(line)) continue
        const key = `${pattern.kind} ${cmd}`
        if (seen.has(key)) break
        seen.add(key)
        out.push({ kind: pattern.kind, cmd, evidence: evidence(rel, i + 1) })
        break
      }
    }
  }
  return out
}

function looksLikeCommandLine(line: string): boolean {
  const hasRunner =
    /(^|\s|\$|`)(npm|pnpm|yarn|bun|cargo|go|dotnet|gradlew?|mvnw?|pytest|ruff|mypy|make|jest|vitest|nextest|tsc)\b/.test(
      line,
    )
  const fenced = /^\s{0,4}(?:\$|#|>)\s/.test(line) || /```/.test(line)
  return hasRunner && (line.includes('`') || fenced)
}

/** Pull the runnable command out of a line, preferring an inline code span. */
function extractCommand(line: string): string | null {
  const inline = /`([^`]{3,140})`/.exec(line)
  if (inline !== null) {
    const candidate = (inline[1] as string).trim()
    if (/^[a-z][\w.-]*\s+\S/.test(candidate)) return candidate
  }
  const plain = /^\s{0,4}(?:\$\s*)?([a-z][\w./-]*(?:\s+[^\n`$|;#<>]{0,100})?)/.exec(line)
  if (plain !== null) {
    const candidate = (plain[1] as string).trim()
    if (candidate.includes(' ')) return candidate
  }
  return null
}
