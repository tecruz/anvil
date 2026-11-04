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
import type { CommandKind, Docs, InstructionFile } from './types.ts'
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
      // A rules directory is still guidance the agent loads, so its members are measured.
      // Reporting zero made the instruction budget treat a Cursor repo as having nothing
      // to measure, which is the one answer a budget rule must not get wrong.
      let bytes = 0
      for (const member of members) bytes += readText(join(root, member)).bytes
      out.push({ path: candidate.rel, category: candidate.category, bytes })
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
  // The three shapes are expanded in a single left-to-right pass rather than by three chained
  // `replace` calls. The chained version rewrote the `.*` it had just inserted: the final
  // `*` -> `[^/]*` step turned `**/`'s `(?:.*/)?` into `(?:.[^/]*/)?`, an optional *single*
  // segment. Anything two levels deep was invisible to every `**/` pattern -- which hid
  // `app/src/main/AndroidManifest.xml`, a nested `.maestro/flows/` flow and a deep
  // `wdio.conf`. Inserting the pieces once means a later step cannot see them.
  let body = ''
  for (let i = 0; i < glob.length; i++) {
    const ch = glob[i] as string
    if (ch === '*') {
      if (glob[i + 1] === '*') {
        // A double-star followed by a slash may match zero directories, so the pattern for
        // "migrations anywhere" also matches a top-level migrations directory.
        if (glob[i + 2] === '/') {
          body += '(?:.*/)?'
          i += 2
        } else {
          body += '.*'
          i += 1
        }
      } else {
        body += '[^/]*'
      }
      continue
    }
    body += /[.+^${}()|[\]\\]/.test(ch) ? `\\${ch}` : ch
  }
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
  detectMakefileCommands(draft, root, files, resolve)
}

/**
 * The targets a Makefile actually defines, with the line each is declared on.
 *
 * A Makefile is a build system anvil had no support for at all, and the gap produced a
 * false blocker: traefik's Helm chart documents `make test` and `make lint` in its AGENTS.md
 * and defines both, and was still reported as having "test files but no runnable test
 * command" while failing `BUILD`. Whatever the chart is built with, it is not a mystery.
 *
 * Only real targets are returned. The three shapes that look like targets and are not:
 *
 *   - `.PHONY: test`   a declaration of an existing target, not a definition of one
 *   - `VAR = value` / `export FOO := x`   a variable, and `:` here is an assignment
 *   - `target: VAR = value`   a target-specific variable, which does define `target`
 *
 * A recipe line is indented, so requiring the colon at column 0 is what separates a rule
 * from the shell command underneath it.
 */
export function makefileTargets(root: string, relPath: string): Map<string, number> {
  const out = new Map<string, number>()
  const { text } = readText(join(root, relPath))
  if (text === null) return out
  const lines = text.split('\n')
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? ''
    // A recipe line, a comment, or a line-continuation of a previous rule.
    if (line.length === 0 || /^\s/.test(line) || line.startsWith('#')) continue
    // `name: deps` or `name:` or `name: VAR = value`. Anything with `=` before the colon is
    // a variable assignment.
    const m = /^([A-Za-z0-9][A-Za-z0-9_.-]*)\s*:(?!=)/.exec(line)
    if (m === null) continue
    const name = m[1] as string
    if (name.startsWith('.')) continue
    if (!out.has(name)) out.set(name, i + 1)
  }
  return out
}

/** Command kinds a Makefile can supply, and the target names that mean each one. */
const MAKE_TARGET_KINDS: ReadonlyArray<{ kind: CommandKind; targets: readonly string[] }> = [
  { kind: 'build', targets: ['build', 'all'] },
  { kind: 'test', targets: ['test', 'tests'] },
  { kind: 'lint', targets: ['lint'] },
  { kind: 'format', targets: ['format', 'fmt'] },
]

/**
 * Commands from a Makefile, labelled `detected`.
 *
 * A target defined in the Makefile is a file on disk saying so, which is exactly what
 * `detected` means in the documented/detected/inferred contract -- and it is the reason
 * this is honest where the old guess was not. The Go detector emitted `make build` for any
 * repository with a Makefile at all, with evidence `Makefile` and no claim that a `build`
 * target existed, so a project with a Makefile containing only `deploy` was told to build
 * with `make build`.
 *
 * `detected` also outranks nothing: a `documented` command still wins, because a human
 * writing `make test-unit` down is more authoritative than the name this guesses.
 */
function detectMakefileCommands(
  draft: ProfileDraft,
  root: string,
  files: ReadonlySet<string>,
  resolve: (rel: string) => string,
): void {
  for (const candidate of ['Makefile', 'makefile', 'GNUmakefile']) {
    if (!files.has(resolve(candidate))) continue
    const targets = makefileTargets(root, resolve(candidate))
    if (targets.size === 0) continue
    for (const { kind, targets: names } of MAKE_TARGET_KINDS) {
      const name = names.find((n) => targets.has(n))
      if (name === undefined) continue
      addCommand(draft, kind, {
        cmd: `make ${name}`,
        source: 'detected',
        evidence: evidence(candidate, targets.get(name) as number),
      })
    }
    return
  }
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

/**
 * The command runners anvil can name, in two tiers.
 *
 * **Unambiguous** tokens never appear in plain prose, so seeing one is seeing a command.
 * **Constrained** tokens are ordinary English words -- `mix`, `rake`, `bundle`, `swift` --
 * and naming one is only evidence of a command when a real subcommand follows it:
 * "the mix of concerns I would bundle" mentions none of them, `swift test` is a command.
 *
 * One list, shared by the two consumers: `AGENTS_COMMANDS`, which asks whether an
 * instructions file names a runnable command at all (a false pass is a blocker wrongly
 * cleared), and documented-command extraction, which is fenced- or backtick-gated and so
 * has a second layer of protection. Keeping one list is the same reasoning that merged
 * the hook-framework lists: four near-copies of "what a commit hook looks like" were how a
 * framework added to one of them ended up invisible to the other three.
 */
export const COMMAND_RUNNERS: {
  readonly unambiguous: readonly string[]
  readonly constrained: Readonly<Record<string, readonly string[]>>
} = {
  unambiguous: [
    // npm/yarn/pnpm-era JS
    'npm',
    'pnpm',
    'yarn',
    'bun',
    'jest',
    'vitest',
    'nextest',
    'biome',
    'eslint',
    'tsc',
    // Python
    'pytest',
    'ruff',
    'mypy',
    'uv',
    'poetry',
    // Go / Rust / JVM / .NET
    'go',
    'cargo',
    'gradlew?',
    'mvnw?',
    'dotnet',
    'sbt',
    'golangci-lint',
    // Ruby / PHP / Elixir / Erlang tooling with no English collision
    'phpunit',
    'phpstan',
    'rubocop',
    'rebar3',
    // Swift / infra / CI
    'swiftlint',
    'terraform',
    'tflint',
    'helm',
    'kubectl',
    'bazel(?:isk)?',
    'hadolint',
    'actionlint',
  ],
  constrained: {
    mix: ['test', 'compile', 'format', 'run', 'iex', 'deps', 'phx', 'credo', 'ecto', 'release', 'dialyzer', 'do'],
    rake: ['test', 'spec', 'routes', 'db', 'lint', 'default', 'assets', 'build'],
    bundle: ['exec', 'install', 'update', 'check', 'add', 'config', 'init'],
    swift: ['build', 'test', 'run', 'package', 'resolve', 'format'],
    php: ['artisan'],
    docker: ['build', 'run', 'compose', 'exec', 'push', 'pull', 'images', 'tag'],
    make: ['\\S+'], // any target at all: `make <something>` is how make is invoked
  },
}

/**
 * One regex alternation covering both tiers, used wherever anvil needs to decide "this text
 * names a runnable command" without enumerating runners by hand in two packages.
 */
export function runnerAlternation(): string {
  const flat = COMMAND_RUNNERS.unambiguous.join('|')
  const paired = Object.entries(COMMAND_RUNNERS.constrained).map(
    // The inner `()` are load-bearing: `x(?:\s+a|b)` binds the space to `a` alone, so
    // `swift test` matched only when `test` happened to be the first subcommand listed.
    ([runner, sub]) => `${runner}(?:\\s+(?:${sub.join('|')}))\\b`,
  )
  return [flat, ...paired].join('|')
}

/**
 * Matches text that names a runnable command: a runner, optionally path-prefixed (`./`),
 * followed by a token boundary, so `/opt/gradlew/bin` does not match as a command.
 */
export function mentionsRunner(text: string): boolean {
  return new RegExp(`(^|[\\s\`"'(])(?:\\S*\\/)?(?:${runnerAlternation()})(?=[\\s\`'"()]|$)`, 'm').test(text)
}

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
    re: /(npm (run )?test|yarn test|pnpm test|bun test|pytest|go test|cargo test|dotnet test|mvnw? test|gradlew? test|make (test|tests|check)|jest\b|vitest\b|mix test|bundle exec (rspec|rake( test| spec)?)|rake (test|spec)|php artisan test|phpunit|swift test|helm unittest|bazel test)/,
  },
  {
    kind: 'build',
    re: /(npm (run )?build|yarn build|pnpm build|cargo build|dotnet build|gradlew? (build|assemble\w*)|mvnw? package|go build|make (build|all)|mix (compile|release)|swift build|bazel build|docker build)/,
  },
  {
    kind: 'lint',
    re: /(npm (run )?lint|eslint\b|ruff check|golangci-lint|cargo clippy|dotnet format|make lint|mix credo|bundle exec rubocop|rubocop|swiftlint|tflint\b|helm lint|hadolint|actionlint|biome (check|lint)|gradlew? (detekt|lint\w*|ktlint\w*Check))/,
  },
  {
    kind: 'format',
    re: /(npm (run )?format|biome format|cargo fmt|dotnet format|make format|ruff format|gradlew? (spotless(?:Check|Apply)|ktlintFormat))/,
  },
  { kind: 'typecheck', re: /(tsc --noEmit|typecheck|pyright|mypy|phpstan)/ },
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
    let inFence = false
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i] ?? ''
      // The fence markers themselves are not commands; the lines between them are.
      if (/^\s{0,4}(?:```|~~~)/.test(line)) {
        inFence = !inFence
        continue
      }
      if (!looksLikeCommandLine(line, inFence)) continue
      const cmd = extractCommand(line)
      if (cmd === null) continue
      for (const pattern of DOC_PATTERNS) {
        // Against the extracted command, not the line. They were different strings, and a
        // line could name one command while the first code span on it was another -- so
        // `npm run build && node dist/cli.js <command>` was recorded as a documented *build*
        // command of `node dist/cli.js <command>`, which builds nothing. Pointing anvil at
        // itself surfaced it in its own profile: a confidently-wrong command in the list an
        // agent is told to run. Losing the second command on a shared line is the cheaper
        // error; a wrong command is the one this project refuses to ship.
        if (!pattern.re.test(cmd)) continue
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

function looksLikeCommandLine(line: string, inFence = false): boolean {
  // One runner list (`COMMAND_RUNNERS`) is used here and by the AGENTS_COMMANDS rule, so an
  // ecosystem added in one place is visible in both. The fenced-block half exists because
  // humans write commands there more often than not: traefik's chart documents `make test`
  // and `make lint` in a ```bash block, and requiring a per-line backtick missed every one.
  const fenced = inFence || /^\s{0,4}(?:\$|#|>)\s/.test(line) || /```/.test(line)
  return mentionsRunner(line) && (line.includes('`') || fenced)
}

/**
 * A runnable command starts with a binary name, optionally written as a relative path.
 *
 * `./gradlew test` is the ordinary way a Gradle repository documents a command, and the
 * older `[a-z]` anchor dropped every one of them: the profile then reported only the
 * detected `./gradlew test`, and `init` rewrote a good AGENTS.md without the build,
 * lint and format commands it plainly contained.
 */
const RUNNABLE_START = /^(?:\.{1,2}\/)?[a-z][\w./-]*\s+\S/

/** Pull the runnable command out of a line, preferring an inline code span. */
function extractCommand(line: string): string | null {
  const inline = /`([^`]{3,140})`/.exec(line)
  if (inline !== null) {
    const candidate = firstCommand((inline[1] as string).trim())
    if (RUNNABLE_START.test(candidate)) return candidate
  }
  const plain = /^\s{0,4}(?:\$\s*)?((?:\.{1,2}\/)?[a-z][\w./-]*(?:\s+[^\n`$|;#<>]{0,100})?)/.exec(line)
  if (plain !== null) {
    const candidate = firstCommand((plain[1] as string).trim())
    if (candidate.includes(' ')) return candidate
  }
  return null
}

/**
 * The first command of a compound line.
 *
 * `npm run build && node dist/cli.js <command>` is two commands, and recording the pair as
 * one hands an agent a string it will copy whole -- running whatever came after the `&&` as
 * a side effect of wanting a build. Cutting at the operator keeps the half that matches the
 * kind the line was classified as.
 */
function firstCommand(candidate: string): string {
  const cut = candidate.search(/\s(?:&&|\|\||[|;])\s/)
  return (cut === -1 ? candidate : candidate.slice(0, cut)).trim()
}
