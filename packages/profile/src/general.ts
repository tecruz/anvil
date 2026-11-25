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
import type { CiCheck, CommandKind, Docs, InstructionFile } from './types.ts'
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
    if (ch === '?') {
      body += '[^/]'
      continue
    }
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

const MAX_CI_CHECKS = 12
const MAX_CI_COMMAND = 160
const MAX_BLOCK_LINES = 5

/**
 * Setup, cleanup, release and provenance steps are not checks an agent should be told to run.
 * A workflow may legitimately contain them; presenting `rm -rf` or `npm publish` as "how to
 * check" is worse than leaving the check unknown.
 */
const CI_NON_CHECKS =
  /^(?:rm|rmdir|del|erase|chmod|sudo|cd|echo|mkdir|cp|mv|git\s+(?:push|commit|tag|release)|npm\s+(?:ci|install|pack|publish)|pnpm\s+(?:install|pack|publish)|yarn\s+(?:install|publish)|sha256sum|docker\s+push)\b/i

/** Only recognise a familiar test/build runner from a block scalar; other lines are a script. */
const CI_BLOCK_RUNNER =
  /^(?:npm|pnpm|yarn|node|nodejs|python3?|pytest|go|cargo|make|gradlew|\.{1,2}\/gradlew|dotnet|mvn|\.{1,2}\/mvnw|jest|vitest|ruff|eslint|tsc)\s/

function ciCheckCommand(raw: string): string | null {
  let cmd = raw.trim().replace(/^['"]|['"]$/g, '')
  if (cmd === '') return null
  // A compound step can publish or delete while it tests. Refuse the whole step rather than
  // recommending the first half of a command whose side effects the reader did not ask for.
  if (cmd.includes('<<') || /&&|\|\||[&|;]/.test(cmd)) return null
  if (/\s(?:--version|--help|-v)\b/i.test(cmd) || /\brun\s+clean\b/i.test(cmd) || CI_NON_CHECKS.test(cmd)) {
    return null
  }
  cmd = firstCommand(cmd)
  if (cmd.length > MAX_CI_COMMAND) cmd = cmd.slice(0, MAX_CI_COMMAND)
  return RUNNABLE_START.test(cmd) ? cmd : null
}

/**
 * Commands that publish, deploy, cut a release artifact or rewrite source.
 *
 * They are real workflow steps, but they are not checks: handing a reader `npm publish` or
 * `assembleRelease` as "how to check" is worse than saying nothing. The row is kept and marked
 * `referenceOnly` so a caller can show the gate without offering it as a command to run.
 *
 * Matching is on the publishing or deploying *act*, never on a word that merely appears in a
 * flag: `cargo test --release` runs tests against an optimised profile and stays a check.
 */
const REFERENCE_ONLY_STEP = new RegExp(
  [
    String.raw`\b(?:npm|pnpm|yarn|cargo)\s+publish\b`,
    String.raw`\bdocker\s+push\b`,
    String.raw`\bgh\s+release\s+create\b`,
    String.raw`\b(?:assembleRelease|bundleRelease|assembleStaging|spotlessApply|ktlintFormat)\b`,
    String.raw`\bprettier\b[^\n]*\s--write\b`,
    String.raw`\beslint\b[^\n]*\s--fix\b`,
    String.raw`\bgofmt\b[^\n]*\s-w\b`,
    String.raw`\b(?:firebase|serverless|vercel|netlify|heroku)\s+(?:deploy|--prod)\b`,
    String.raw`(?:^|[\s"'/])(?:deploy|publish)\b[^\s]*\.(?:mjs|cjs|js|ts|sh|bash|ps1|py|rb)\b`,
    String.raw`scripts/sync-docs-versions\.py(?!\s+--check)`,
  ].join('|'),
  'i',
)

/** Words that name a release, deploy or publish stage in a job id or job name. */
const REFERENCE_ONLY_TOKENS = new Set(['release', 'publish', 'publisher', 'deploy', 'deployment'])

/**
 * Classify a job from its id and human name.
 *
 * The separator is not fixed: `staging_deploy`, `'deploy'`, `build-release` and a job named
 * `Deploy staging` all name the same stage. Splitting on non-alphanumerics finds the word
 * wherever it sits, and `_` — which `\b` does not break — no longer hides it.
 */
function referenceOnlyLabel(...labels: readonly string[]): boolean {
  for (const label of labels) {
    for (const token of label.toLowerCase().split(/[^a-z0-9]+/)) {
      if (REFERENCE_ONLY_TOKENS.has(token)) return true
    }
  }
  return false
}

/** One YAML scalar, unquoted and without a trailing comment. */
function yamlScalar(value: string): string {
  return value
    .replace(/\s+#.*$/, '')
    .trim()
    .replace(/^['"]|['"]$/g, '')
}

/** `defaults.run.working-directory` within one YAML block, or undefined when it is not set. */
function defaultsWorkingDirectory(lines: readonly string[], start: number, end: number): string | undefined {
  // A flow-style default is one line: `defaults: {run: {working-directory: packages/web}}`.
  // Ignoring it meant the workflow default silently won over the job's own declaration.
  const flowRun = /\brun\s*:\s*\{([^}]*)\}/
  const flowDir = /\bworking-directory\s*:\s*([^,}]+)/
  let defaultsIndent = -1
  let runIndent = -1
  for (let i = start; i < end; i++) {
    const line = lines[i] ?? ''
    if (line.trim() === '' || line.trimStart().startsWith('#')) continue
    const indent = line.length - line.trimStart().length
    if (/^\s*defaults\s*:/.test(line)) {
      const run = flowRun.exec(line)
      const dir = run === null ? null : flowDir.exec(run[1] as string)
      if (dir !== null) return yamlScalar(dir[1] as string)
    }
    if (defaultsIndent >= 0 && indent <= defaultsIndent) {
      defaultsIndent = -1
      runIndent = -1
    }
    if (runIndent >= 0 && indent <= runIndent) runIndent = -1
    if (defaultsIndent < 0) {
      if (/^\s*defaults\s*:\s*(?:#.*)?$/.test(line)) defaultsIndent = indent
      continue
    }
    if (runIndent < 0) {
      if (/^\s*run\s*:\s*(?:#.*)?$/.test(line)) runIndent = indent
      continue
    }
    const dir = /^\s*working-directory\s*:\s*(.+?)\s*$/.exec(line)
    if (dir !== null) return yamlScalar(dir[1] as string)
  }
  return undefined
}

interface WorkflowJob {
  id: string
  start: number
  end: number
  /** `defaults.run.working-directory` declared for this job. */
  dir?: string
  /** The job id or human name names a release, publish or deploy stage. */
  referenceOnly: boolean
}

/** A job key, quoted or bare: `deploy:`, `'deploy':`, `build-release:`. */
const JOB_KEY = /^\s*(?:(['"])([^'"]+)\1|([A-Za-z0-9_-]+))\s*:\s*(?:#.*)?$/

/** The job's own `name:` line, which can name a stage the id does not. */
function jobName(lines: readonly string[], job: { start: number; end: number; keyIndent: number }): string | null {
  for (let i = job.start + 1; i < job.end; i++) {
    const line = lines[i] ?? ''
    if (line.trim() === '' || line.trimStart().startsWith('#')) continue
    // A step starts with `-`; job metadata is a plain key at the job's child indentation.
    if (line.length - line.trimStart().length !== job.keyIndent + 2) continue
    const match = /^\s*name\s*:\s*(.+?)\s*$/.exec(line)
    if (match !== null) return yamlScalar(match[1] as string)
  }
  return null
}

/** Job ids and their line ranges, so a step can be attributed to the job that runs it. */
function workflowJobs(lines: readonly string[], jobsLine: number): WorkflowJob[] {
  if (jobsLine < 0) return []
  const jobs: WorkflowJob[] = []
  let jobIndent = -1
  for (let i = jobsLine + 1; i < lines.length; i++) {
    const line = lines[i] ?? ''
    if (line.trim() === '' || line.trimStart().startsWith('#')) continue
    const indent = line.length - line.trimStart().length
    if (indent === 0) break
    if (jobIndent < 0) jobIndent = indent
    if (indent !== jobIndent) continue
    const header = JOB_KEY.exec(line)
    if (header === null) continue
    const id = (header[2] ?? header[3]) as string
    const previous = jobs[jobs.length - 1]
    if (previous !== undefined) previous.end = i
    jobs.push({ id, start: i, end: lines.length, referenceOnly: false })
  }
  for (const job of jobs) {
    const dir = defaultsWorkingDirectory(lines, job.start + 1, job.end)
    if (dir !== undefined) job.dir = dir
    const name = jobName(lines, { start: job.start, end: job.end, keyIndent: jobIndent })
    job.referenceOnly = referenceOnlyLabel(job.id, name ?? '')
  }
  return jobs
}

/**
 * Verification commands CI actually runs, read from workflow steps.
 *
 * A documented README command answers "what do I run locally"; CI can run a different,
 * broader set. Recording both with file:line evidence lets a brief distinguish the fast
 * loop from the coverage, formatting and device suites that gate a merge, without running
 * any of them. This is detection, not verification: a listed command has no pass/fail
 * attached, and a workflow with no check steps yields none, never a green claim. Steps whose
 * shape is not understood (other block scalars, matrix expressions) are skipped, not guessed.
 */
export function detectCiChecks(root: string, files: ReadonlySet<string>): CiCheck[] {
  const device: CiCheck[] = []
  const normal: CiCheck[] = []
  const seen = new Set<string>()

  for (const rel of [...files].sort()) {
    if (!rel.startsWith('.github/workflows/') || !/\.ya?ml$/.test(rel)) continue
    const { text } = readText(join(root, ...rel.split('/')))
    if (text === null) continue
    const lines = text.split('\n')
    const jobsLine = lines.findIndex((line) => /^jobs\s*:/.test(line))
    const jobs = workflowJobs(lines, jobsLine)
    // Workflow-level defaults apply to every job that does not override them.
    const workflowDir = jobsLine < 0 ? undefined : defaultsWorkingDirectory(lines, 0, jobsLine)
    let jobIndex = -1
    let jobReferenceOnly = false
    let jobDir = workflowDir
    let emulatorStep = false
    let withContext = false
    let stepDir: string | undefined
    let blockIndent = -1
    let blockScope: CiCheck['scope'] = 'ci'
    let blockLines = 0
    let heredocEnd: string | null = null
    type Pending = { raw: string; scope: CiCheck['scope']; line: number }
    let pending: Pending[] = []

    // A step's `working-directory` may be written after its `run:`. Flush at the step boundary
    // so the directory is known before the command is recorded.
    const flush = (): void => {
      for (const item of pending) {
        const cmd = ciCheckCommand(item.raw)
        if (cmd === null) continue
        // Classification uses the job that owns the step, not only the command text: a deploy
        // job can run a plain command, and that step is still not something to hand a reader.
        const referenceOnly = jobReferenceOnly || REFERENCE_ONLY_STEP.test(cmd)
        const dir = stepDir ?? jobDir
        const key = `${item.scope} ${referenceOnly ? 'ref' : 'check'} ${cmd} ${dir ?? ''}`
        if (seen.has(key)) continue
        seen.add(key)
        const check: CiCheck = { cmd, evidence: evidence(rel, item.line), scope: item.scope }
        if (dir !== undefined && dir !== '') check.dir = dir
        if (referenceOnly) check.referenceOnly = true
        ;(item.scope === 'device' ? device : normal).push(check)
      }
      pending = []
    }

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i] ?? ''
      // Heredoc text must be skipped before any step parsing. A line such as `- run: npm test`
      // inside `cat <<'EOF'` is shell input, not a workflow step, even while a block is open.
      if (heredocEnd !== null) {
        if (line.trim() === heredocEnd) heredocEnd = null
        continue
      }
      const nextJob = jobs[jobIndex + 1]
      if (nextJob !== undefined && i === nextJob.start) {
        flush()
        jobIndex += 1
        jobReferenceOnly = nextJob.referenceOnly
        jobDir = nextJob.dir ?? workflowDir
        emulatorStep = false
        withContext = false
        stepDir = undefined
        blockIndent = -1
        continue
      }
      // Any new step ends the previous one's runner and working directory, including an
      // unnamed `- uses:` or `- id:` step. Without this, a host step after an emulator step
      // would inherit `device` and a later step would inherit the earlier directory.
      if (/^\s*-\s+[a-z][\w-]*\s*:/i.test(line)) {
        flush()
        emulatorStep = false
        withContext = false
        stepDir = undefined
        blockIndent = -1
      }
      if (/^\s*(?:-\s*)?uses\s*:\s*\S*android-emulator-runner/i.test(line)) emulatorStep = true
      // A trailing YAML comment is still the same key. Missing it kept `with` active while an
      // `env:` mapping followed, so data under `env.script` was reported as an executed check.
      if (/^\s+with\s*:\s*(?:#.*)?$/.test(line)) withContext = true
      if (/^\s+env\s*:\s*(?:#.*)?$/.test(line)) withContext = false
      const dirMatch = /^\s+working-directory\s*:\s*(.+?)\s*$/.exec(line)
      if (dirMatch !== null) {
        stepDir = (dirMatch[1] as string)
          .replace(/\s+#.*$/, '')
          .trim()
          .replace(/^['"]|['"]$/g, '')
      }

      const block = /^\s*(?:-\s*)?run\s*:\s*[|>][-+]?(?:\s|$)/.exec(line)
      if (block !== null) {
        blockIndent = line.length - line.trimStart().length
        blockScope = emulatorStep ? 'device' : 'ci'
        blockLines = 0
        heredocEnd = null
        continue
      }
      if (blockIndent >= 0) {
        if (line.trim() === '') continue
        const here = /<<\s*['"]?([\w-]+)['"]?/.exec(line)
        if (here !== null) {
          heredocEnd = here[1] as string
          continue
        }
        const indent = line.length - line.trimStart().length
        if (indent > blockIndent) {
          // Stay inside the block until it dedents. A heredoc body can contain lines that look
          // like YAML keys; interpreting those as steps is how `run: npm test` became a check.
          if (blockLines < MAX_BLOCK_LINES) {
            blockLines++
            if (CI_BLOCK_RUNNER.test(line.trim())) pending.push({ raw: line.trim(), scope: blockScope, line: i + 1 })
          }
          continue
        }
        blockIndent = -1
        if (!/^\s*-\s+[a-z]/i.test(line)) continue
      }

      const run = /^\s*(?:-\s*)?run\s*:\s*(.+?)\s*$/.exec(line)
      if (run !== null) {
        pending.push({ raw: run[1] as string, scope: emulatorStep ? 'device' : 'ci', line: i + 1 })
        continue
      }
      // `script:` is the command an emulator runner executes in `with:`. The same key under
      // `env:` is data, not an executed check.
      const script = /^\s*script\s*:\s*(.+?)\s*$/.exec(line)
      if (script !== null && emulatorStep && withContext) {
        pending.push({ raw: script[1] as string, scope: 'device', line: i + 1 })
      }
    }
    flush()
  }

  // Device suites take the cap first. A long list of ordinary CI steps must not crowd out
  // the one check a local JVM run cannot stand in for. Reference-only rows come last so a
  // release step never displaces a check a reader could actually run.
  const runnable = [...device, ...normal].filter((check) => check.referenceOnly !== true)
  const reference = [...device, ...normal].filter((check) => check.referenceOnly === true)
  return [...runnable, ...reference].slice(0, MAX_CI_CHECKS)
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
    if (!COMPOUND_SHELL.test(candidate) && RUNNABLE_START.test(candidate)) return candidate
  }
  const plain = /^\s{0,4}(?:\$\s*)?((?:\.{1,2}\/)?[a-z][\w./-]*(?:\s+[^\n`$|;#<>]{0,100})?)/.exec(line)
  if (plain !== null) {
    const candidate = firstCommand((plain[1] as string).trim())
    if (!COMPOUND_SHELL.test(candidate) && candidate.includes(' ')) return candidate
  }
  return null
}

/** Operators that may publish, delete or chain after the command the reader wanted. */
const COMPOUND_SHELL = /&&|\|\||[&|;]/

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
