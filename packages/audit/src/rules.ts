/**
 * The readiness rules.
 *
 * Rules are data plus a predicate. Two invariants hold for every rule, and they are the
 * reason this is a rule set rather than a pile of ad-hoc checks:
 *
 *  1. **Every finding carries evidence and a concrete fix.** A finding with no fix is a
 *     to-do, not a feature. "Add tests" is not a fix; "run `npm test`, which is already
 *     defined at package.json:15" is.
 *  2. **A rule that cannot decide says `na`, not `fail`.** A docs-only repo has no build
 *     step, and reporting a missing build command there is a false positive that trains
 *     the reader to ignore the report.
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { CommandEntry, ProjectProfile } from '@anvil/profile'
import type { Fix, Layer, Severity, Status } from './types.ts'

export interface RuleContext {
  profile: ProjectProfile
  /** True when the repo has a primary language (i.e. it is not docs/config only). */
  hasCode: boolean
  hasTests: boolean
  /** Agent instruction text, concatenated, for content checks. */
  instructionsText: string
  /**
   * CI workflow bodies, path to text.
   *
   * Read by the engine rather than carried in the profile: only `CI_PARITY` needs them, and
   * the plugin does not want every workflow in its JSON payload.
   */
  ciWorkflows: ReadonlyMap<string, string>
  /** The `CODEOWNERS` body, for the rule that checks whether its owners are real. */
  codeowners: string | null
  /** The `SECURITY.md` body, for the rule that checks the contact is monitored. */
  security: string | null
  /**
   * The repository's npm scripts, name to command body.
   *
   * Also read by the engine rather than the profile, for the same reason as
   * `ciWorkflows`: it is only needed by CI_PARITY, and it would bloat the profile JSON.
   * Its purpose is to let that rule see through a composite script -- a CI step that runs
   * `npm run check` does run lint and test, because `check` does.
   */
  npmScripts: Readonly<Record<string, string>>
}

export interface Rule {
  id: string
  layer: Layer
  severity: Severity
  title: string
  /** Lower runs first. */
  order: number
  evaluate(ctx: RuleContext): RuleOutcome
}

export interface RuleOutcome {
  status: Status
  detail: string
  evidence?: string[]
  fix?: Fix | null
}

const pass = (detail: string, evidence: string[] = []): RuleOutcome => ({
  status: 'pass',
  detail,
  evidence,
})
const fail = (detail: string, evidence: string[], fix: Fix | null = null): RuleOutcome => ({
  status: 'fail',
  detail,
  evidence,
  fix,
})
const warn = (detail: string, evidence: string[], fix: Fix | null = null): RuleOutcome => ({
  status: 'warn',
  detail,
  evidence,
  fix,
})
const na = (detail: string): RuleOutcome => ({ status: 'na', detail })

function derived(target: string, summary: string, confidence: number): Fix {
  return {
    kind: 'create-file',
    origin: 'derived',
    target,
    summary,
    confidence,
  }
}

function install(summary: string, label: string, url: string, confidence: number): Fix {
  return {
    kind: 'install',
    origin: 'community',
    summary,
    source: { label, url },
    confidence,
  }
}

function hasCommand(ctx: RuleContext, kind: keyof ProjectProfile['commands']): boolean {
  const entries = ctx.profile.commands[kind]
  return Array.isArray(entries) && entries.length > 0
}

function commands(ctx: RuleContext, kind: keyof ProjectProfile['commands']): string[] {
  return (ctx.profile.commands[kind] ?? []).map((c) => `${c.cmd} [${c.source}]`)
}

/**
 * True when anvil cannot say anything true about how this repository is built.
 *
 * A repository whose project lives in a subdirectory -- a Rust crate under `engine/`, a
 * service under `services/api/` -- used to defeat root-level manifest detection entirely.
 * The result was `TEST` failing as a **blocker** on a perfectly good Rust project, claiming
 * "test files exist but no runnable test command was found" when the truth was that anvil
 * had not worked out what the repository was. It had not earned that sentence, and a
 * blocker an agent must act on cannot afford to be wrong about its cause.
 *
 * The subdirectory case is fixed at the source instead: `projectDirOf` resolves the project
 * and `makeResolver` routes every probe through it, so a crate under `engine/` is now a
 * detected Rust project. What is left for this guard is a repository with source files, no
 * detected stack, *and* no build system anvil recognises even by name -- and there "no
 * runnable test command was found" is a sentence about anvil's own blindness, not about the
 * repository.
 *
 * **A build system anvil has no detector for is not that.** A `Makefile` tree or a
 * `CMakeLists.txt` tree is a repository anvil understands perfectly well at the file level:
 * it found the sources, the build file and the tests. Reporting `na` there silently discards
 * a true and actionable finding on every C, C++ and shell project, which is the direction
 * this project has been fixing in every other rule. So the guard requires *both* halves:
 * nothing detected, and nothing recognisable on disk.
 */
const BUILD_SYSTEM_FILES: readonly RegExp[] = [
  /^makefile$/i,
  /^gnumakefile$/i,
  /^justfile$/i,
  /^cmakelists\.txt$/i,
  /^meson\.build$/i,
  /^configure(\.ac)?$/i,
  /^premake5?\.lua$/i,
  /^build\.zig$/i,
  /^sconstruct$/i,
  /^bazel\.bazel$/i,
  /^.*\.(cs|fs|vb)proj$/i,
  /^.*\.sln$/i,
]

/** True when a build system anvil can name exists in the tree, however well it knows it. */
function hasBuildSystem(ctx: RuleContext): boolean {
  return ctx.profile.files.some((f) => {
    const name = f.slice(f.lastIndexOf('/') + 1)
    return BUILD_SYSTEM_FILES.some((re) => re.test(name))
  })
}

function unidentified(ctx: RuleContext): boolean {
  if ((ctx.profile.stacks ?? []).length > 0) return false
  return !hasBuildSystem(ctx)
}

// ---------------------------------------------------------------------------
// Orientability
// ---------------------------------------------------------------------------

/**
 * Does the instruction text name a runnable command?
 *
 * The leading-character class includes markdown delimiters, because in a rendered
 * instructions file a command is almost always wrapped in backticks -- and a rule that
 * cannot see its own generated output is a rule that will never be satisfied.
 */
function mentionsCommand(text: string): boolean {
  return /(^|[\s`"'(])(npm |pnpm |yarn |bun |cargo |go |gradlew|mvnw|pytest|make |dotnet |tsc |ruff |mypy |eslint)/m.test(
    text,
  )
}

const AGENTS_FILE: Rule = {
  id: 'AGENTS_FILE',
  layer: 'orientability',
  severity: 'high',
  title: 'Agent instructions file present',
  order: 10,
  evaluate(ctx) {
    const agents = ctx.profile.instructions.find((i) => i.path === 'AGENTS.md')
    if (agents !== undefined) {
      // A stub AGENTS.md is worse than none: it looks authoritative and is empty.
      if (agents.bytes < 200) {
        return warn('AGENTS.md exists but is nearly empty', ['AGENTS.md'], {
          ...derived('AGENTS.md', 'Populate AGENTS.md with build/test/lint commands and a module map', 0.6),
          kind: 'create-file',
        })
      }
      return pass(`AGENTS.md (${agents.bytes} bytes)`, ['AGENTS.md'])
    }
    const other = ctx.profile.instructions[0]
    if (other !== undefined) {
      return warn(
        `No AGENTS.md. ${other.path} is present and is loaded by some tools, but AGENTS.md is the cross-tool standard.`,
        [other.path],
        derived('AGENTS.md', 'Create AGENTS.md; it is the file every major agent tool reads', 0.9),
      )
    }
    return fail(
      'No agent instructions file. An agent starts with no idea how this repo builds or is tested.',
      [],
      derived('AGENTS.md', 'Create AGENTS.md', 0.95),
    )
  },
}

const AGENTS_COMMANDS: Rule = {
  id: 'AGENTS_COMMANDS',
  layer: 'orientability',
  severity: 'blocker',
  title: 'Instructions contain runnable commands',
  order: 11,
  evaluate(ctx) {
    // A repository with no source files has no verify commands to document, so failing
    // it would be a false positive -- and a false positive is worse than a missing
    // finding, because it teaches the reader to ignore the report. Consistent with
    // BUILD/TEST/LINT, which are all `na` for a code-less repo.
    if (!ctx.hasCode) return na('No source files, so there are no runnable commands to document')

    if (ctx.instructionsText.trim() === '') {
      return fail(
        'No instructions to inspect, and no commands documented',
        [],
        derived('AGENTS.md', 'Create AGENTS.md documenting the build, test and lint commands', 0.95),
      )
    }
    if (!mentionsCommand(ctx.instructionsText)) {
      return fail(
        'Instructions exist but name no runnable command. An agent that cannot verify its work produces unreviewable diffs.',
        ctx.profile.instructions.map((i) => i.path),
        derived('AGENTS.md', 'Add the build/test/lint commands to AGENTS.md', 0.95),
      )
    }
    return pass(
      'Instructions name runnable commands',
      ctx.profile.instructions.map((i) => i.path),
    )
  },
}

const ARCH_DOC: Rule = {
  id: 'ARCH_DOC',
  layer: 'orientability',
  severity: 'medium',
  title: 'Architecture documented',
  order: 12,
  evaluate(ctx) {
    const arch = ctx.profile.docs.architecture
    if (arch !== null) return pass('Architecture document present', [arch])
    const hasModules = ctx.profile.modules.length > 1
    if (!hasModules) {
      return na('Single-module repo: a separate architecture doc is optional')
    }
    return warn(
      `${ctx.profile.modules.length} modules detected but no architecture document. Structure has to be inferred from filenames.`,
      ctx.profile.modules.slice(0, 5).map((m) => m.path),
      derived('docs/architecture.md', 'Create docs/architecture.md with the module map', 0.7),
    )
  },
}

const MODULE_MAP: Rule = {
  id: 'MODULE_MAP',
  layer: 'orientability',
  severity: 'medium',
  title: 'Module layout documented',
  order: 13,
  evaluate(ctx) {
    const modules = ctx.profile.modules
    if (modules.length === 0) return na('No modules detected')
    if (modules.length === 1) return na('Single module: no map needed')
    const text = ctx.instructionsText
    const documented = modules.filter((m) => text.includes(m.path) || text.includes(m.id)).length
    if (documented === 0) {
      return warn(
        `None of the ${modules.length} modules are mentioned in the instructions.`,
        modules.slice(0, 5).map((m) => m.path),
        derived('AGENTS.md', 'Add a short module map to AGENTS.md', 0.75),
      )
    }
    return pass(`${documented}/${modules.length} modules mentioned in instructions`, ['AGENTS.md'])
  },
}

const CONVENTIONS: Rule = {
  id: 'CONVENTIONS',
  layer: 'orientability',
  severity: 'medium',
  title: 'Code conventions documented',
  order: 14,
  evaluate(ctx) {
    if (ctx.profile.docs.contributing !== null) return pass('CONTRIBUTING present', [ctx.profile.docs.contributing])
    const hasFormatter = ctx.profile.tooling.formatter.length > 0
    const hasLinter = ctx.profile.tooling.lint.length > 0
    if (hasFormatter && hasLinter) {
      // Tools enforce conventions; prose is a bonus, not a requirement.
      return pass(
        `Conventions enforced by tooling: ${[...ctx.profile.tooling.lint, ...ctx.profile.tooling.formatter].join(', ')}`,
        ['package.json'],
      )
    }
    return warn(
      hasLinter || hasFormatter
        ? 'Only one of lint/format is configured, so half the conventions are unenforced.'
        : 'No linter or formatter configured, and no CONTRIBUTING document.',
      [],
      derived('CONTRIBUTING.md', 'Document conventions, or configure a formatter so they are enforced', 0.6),
    )
  },
}

// ---------------------------------------------------------------------------
// Operability
// ---------------------------------------------------------------------------

const BUILD: Rule = {
  id: 'BUILD',
  layer: 'operability',
  severity: 'high',
  title: 'Build command available',
  order: 20,
  evaluate(ctx) {
    if (!ctx.hasCode) return na('No source files detected')
    if (unidentified(ctx)) {
      return na(
        'No ecosystem or build system identified: nothing in this tree names one, so no build command can be claimed',
      )
    }
    if (hasCommand(ctx, 'build')) return pass(commands(ctx, 'build').join(', '))
    if (hasCommand(ctx, 'test')) {
      return warn('No separate build command, but a test command exists that implies compilation', ['package.json'])
    }
    return fail(
      'No build command. An agent cannot confirm its change compiles.',
      [],
      derived('AGENTS.md', 'Document the build command', 0.7),
    )
  },
}

const TEST: Rule = {
  id: 'TEST',
  layer: 'operability',
  severity: 'blocker',
  title: 'Tests exist and are runnable',
  order: 21,
  evaluate(ctx) {
    if (!ctx.hasCode) return na('No source files detected')
    if (unidentified(ctx)) {
      return na(
        'No ecosystem or build system identified: nothing in this tree names one, so whether these tests are runnable is unknown',
      )
    }
    if (!hasCommand(ctx, 'test')) {
      return fail(
        ctx.hasTests ? 'Test files exist but no runnable test command was found.' : 'No tests and no test command.',
        [],
        derived('AGENTS.md', 'Add a test command to AGENTS.md', 0.9),
      )
    }
    if (!ctx.hasTests) {
      return warn('A test command exists but no test files were detected', [], {
        ...derived('AGENTS.md', 'Confirm the test command runs something', 0.5),
        kind: 'manual',
      })
    }
    return pass(commands(ctx, 'test').join(', '))
  },
}

/**
 * TEST_FAST: a *documented* changed-files subset, per the plan's detection spec.
 *
 * A capable toolchain with no documented fast path is `info`, not a failure: the finding
 * is a prompt to add one, not evidence that one exists. This distinction is what keeps
 * the "no false blockers" criterion testable.
 */
const TEST_FAST: Rule = {
  id: 'TEST_FAST',
  layer: 'operability',
  severity: 'high',
  title: 'A changed-files test subset is documented',
  order: 22,
  evaluate(ctx) {
    if (!ctx.hasCode || !hasCommand(ctx, 'test')) return na('No test command to narrow')

    const entries = ctx.profile.commands.testFast ?? []
    if (entries.length > 0)
      return pass(entries.map((c) => `${c.cmd} [${c.source}]`).join(', '), commandEvidence(ctx, entries))

    // Documented in prose but not detected as a command: report the prose, not the guess.
    if (
      mentionsCommand(ctx.instructionsText) &&
      /(--changed|-k\s|--onlyChanged|nextest|test:fast|test-changed)/i.test(ctx.instructionsText)
    ) {
      return pass('A changed-files test subset is described in the instructions', ['AGENTS.md'])
    }

    // "Is there a test runner?" cannot be answered from the tooling list alone. That list
    // names the runners the detectors recognise, and it is silent about plenty of them --
    // a Rust project whose documented command is `cargo test` was reported as having *no
    // test runner*, and the rule then failed a repository whose tests run fine. A documented
    // or detected test command is itself proof that a runner exists.
    //
    // What the detail says is the command, not a runner name guessed from its first token:
    // `npm run test` proves npm is on the path, and calling npm a test runner is a
    // confidently-wrong claim in a high-severity finding.
    const named = ctx.profile.tooling.test
    const testEntries = ctx.profile.commands.test ?? []
    const detected = testEntries.filter((e) => e.source !== 'inferred')
    const what = [...new Set([...named, ...detected.map((e) => e.cmd)])]

    if (what.length > 0) {
      return warn(
        `A test command is available (${what.join(', ')}) but no changed-files subset is documented. Full-suite feedback on every iteration makes agents unusable.`,
        // Evidence is a file, or the file that declares the commands. Never a tool name and
        // never an empty string: `Finding.evidence` is a published contract, and a claim
        // that cannot be opened is not evidence.
        commandEvidence(ctx, [...detected, ...testEntries]),
        derived('AGENTS.md', 'Document a changed-files test command', 0.8),
      )
    }
    // Only an inferred command with no recognised runner reaches here, and the plan is
    // explicit about this case: "a toolchain with a changed-files capability but no
    // documented subset is a prompt for the agent to *add* a fast path, not evidence that
    // one exists" -- so it must not fail. It is reported as a warning whose detail says
    // plainly that nothing is proven missing.
    //
    // The plan's wording for this case is `info`, but `Finding.status` is a published
    // contract of `pass | warn | fail | na` and the JSON schema the opencode plugin reads.
    // Adding a fifth status to express "soft warning" would ripple through scoring, the
    // report shape and the plugin, so the distinction is carried in the detail text
    // instead -- and the requirement that actually matters, never failing, is met.
    return warn(
      'No changed-files test subset is documented. Adding one is the single highest-leverage change for agent usability; nothing here is proven missing.',
      commandEvidence(ctx, testEntries),
      derived('AGENTS.md', 'Document a changed-files test command', 0.8),
    )
  },
}

/**
 * Evidence for a command-shaped finding: the files the commands were read from.
 *
 * Falls back to the manifest that declares the project's commands, because a finding with
 * no evidence at all is a to-do rather than a finding -- and an inferred command carries no
 * evidence of its own by design.
 */
function commandEvidence(ctx: RuleContext, entries: readonly CommandEntry[]): string[] {
  const own = entries.map((e) => e.evidence).filter((e): e is string => typeof e === 'string' && e !== '')
  if (own.length > 0) return [...new Set(own)]
  const manifest = ctx.profile.files.find((f) =>
    /(^|\/)(package\.json|Cargo\.toml|go\.mod|pyproject\.toml|Gemfile|composer\.json|mix\.exs|Package\.swift|pom\.xml|build\.gradle(\.kts)?|MODULE\.bazel)$/.test(
      f,
    ),
  )
  return manifest === undefined ? [] : [manifest]
}

const LINT: Rule = {
  id: 'LINT',
  layer: 'operability',
  severity: 'medium',
  title: 'Linter configured',
  order: 23,
  evaluate(ctx) {
    if (!ctx.hasCode) return na('No source files detected')
    if (unidentified(ctx)) {
      return na(
        'No ecosystem or build system identified: linters are declared in ecosystem-specific config, and none was found',
      )
    }
    if (ctx.profile.tooling.lint.length === 0) {
      return fail(
        'No linter configured. Nothing catches the mistakes an agent makes most often.',
        [],
        derived('AGENTS.md', 'Configure a linter and document the command', 0.7),
      )
    }
    return pass(ctx.profile.tooling.lint.join(', '), ['package.json'])
  },
}

const FORMAT: Rule = {
  id: 'FORMAT',
  layer: 'operability',
  severity: 'low',
  title: 'Formatter configured',
  order: 24,
  evaluate(ctx) {
    if (!ctx.hasCode) return na('No source files detected')
    if (ctx.profile.tooling.formatter.length === 0) {
      return warn(
        'No formatter configured; agents reformat by hand and produce noisy diffs',
        [],
        derived('AGENTS.md', 'Configure a formatter and document the command', 0.6),
      )
    }
    return pass(ctx.profile.tooling.formatter.join(', '), ['package.json'])
  },
}

const TYPECHECK: Rule = {
  id: 'TYPECHECK',
  layer: 'operability',
  severity: 'low',
  title: 'Static analysis available',
  order: 25,
  evaluate(ctx) {
    if (!ctx.hasCode) return na('No source files detected')
    if (ctx.profile.tooling.typecheck.length === 0) return warn('No type checker detected', [])
    return pass(ctx.profile.tooling.typecheck.join(', '), ['package.json'])
  },
}

const CI: Rule = {
  id: 'CI',
  layer: 'operability',
  severity: 'medium',
  title: 'CI configured',
  order: 26,
  evaluate(ctx) {
    if (ctx.profile.tooling.ci.length === 0) {
      return fail('No CI workflow found. Nothing catches a change that only breaks the build.', [], {
        // `derived`, not `official`: the *action* comes from this repo's own gap. The docs
        // link is supporting material, and calling the whole fix "official" would put a
        // repo-specific task in the external-guidance tier.
        kind: 'link-doc',
        origin: 'derived',
        summary: 'Add a CI workflow that runs the documented verify commands',
        source: {
          label: 'GitHub Actions docs',
          url: 'https://docs.github.com/actions',
        },
        confidence: 0.85,
      })
    }
    return pass(`${ctx.profile.tooling.ci.length} workflow file(s)`, ctx.profile.tooling.ci)
  },
}

/**
 * Append the bodies of the npm scripts a piece of text invokes.
 *
 * `npm run check` and `npm check` are both recognised, and each expanded body is itself
 * searched, so a script that chains resolves transitively. The depth and the visited set
 * are both bounded: a script that (directly or indirectly) invokes itself must not spin.
 */
function expandNpmScripts(text: string, scripts: Readonly<Record<string, string>>, maxDepth = 3): string {
  let out = text
  const seen = new Set<string>()
  for (let depth = 0; depth < maxDepth; depth++) {
    let grew = false
    for (const match of out.matchAll(/\bnpm\s+(?:run\s+|run-script\s+)?([a-z0-9:._-]+)/g)) {
      const name = match[1] as string
      if (seen.has(name)) continue
      const body = scripts[name]
      if (body === undefined) continue
      seen.add(name)
      out += `\n${body.toLowerCase()}`
      grew = true
    }
    if (!grew) break
  }
  return out
}

/**
 * CI_PARITY: does CI run the commands the instructions claim?
 *
 * The plan calls this one of only two rules carrying disproportionate weight, because
 * divergence here means every "verified" claim an agent makes is a lie waiting to happen.
 *
 * Comparison is at the level of the *runner token*, not the full command string:
 * `npm run test` in package.json legitimately surfaces in a workflow as `npm test`,
 * `npm run test`, or `npx jest`, and an exact-string comparison would report false
 * divergence on almost every real repo.
 */
const CI_PARITY: Rule = {
  id: 'CI_PARITY',
  layer: 'operability',
  severity: 'high',
  title: 'CI runs the documented commands',
  order: 27,
  evaluate(ctx) {
    if (ctx.profile.tooling.ci.length === 0) return na('No CI to compare against')

    // Each documented command kind maps to the tokens that would satisfy it in CI.
    const CHECKS: Array<{
      kind: keyof ProjectProfile['commands']
      label: string
      tokens: string[]
    }> = [
      {
        kind: 'test',
        label: 'test',
        tokens: [
          'npm test',
          'npm run test',
          'yarn test',
          'pnpm test',
          'pytest',
          'go test',
          'cargo test',
          'dotnet test',
          'gradlew test',
          './gradlew test',
          'mvn test',
          './mvnw test',
          'jest',
          'vitest',
          'nextest',
        ],
      },
      {
        kind: 'build',
        label: 'build',
        tokens: [
          'npm run build',
          'npm run build',
          'yarn build',
          'pnpm build',
          'cargo build',
          'dotnet build',
          'gradlew build',
          './gradlew build',
          'go build',
          'mvn package',
          'tsc',
        ],
      },
      {
        kind: 'lint',
        label: 'lint',
        tokens: [
          'npm run lint',
          'npm run lint',
          'yarn lint',
          'eslint',
          'ruff check',
          'golangci-lint',
          'cargo clippy',
          'dotnet format',
        ],
      },
      {
        kind: 'typecheck',
        label: 'typecheck',
        tokens: ['tsc --noEmit', 'npm run typecheck', 'mypy', 'pyright'],
      },
    ]

    // A composite script hides what it runs from a token search. `npm run check` is the
    // most common setup there is, and reading it as "CI runs nothing" produces a specific,
    // confident, false gap -- the one kind of wrong output this tool exists to prevent.
    // So the bodies of the scripts CI invokes are appended before searching, to a bounded
    // depth, because a script may chain (`check` -> `verify` -> `test:unit`).
    const workflowText = [...ctx.ciWorkflows.values()].join('\n').toLowerCase()
    if (workflowText.trim() === '') return na('CI workflow files are empty or unreadable')
    const searched = expandNpmScripts(workflowText, ctx.npmScripts)

    const satisfied: string[] = []
    const unsatisfied: Array<{ label: string; evidence: string[] }> = []

    for (const check of CHECKS) {
      const entries = ctx.profile.commands[check.kind] ?? []
      if (entries.length === 0) continue
      const hit = check.tokens.find((t) => searched.includes(t.toLowerCase()))
      if (hit !== undefined) {
        satisfied.push(`${check.label} (${hit})`)
      } else {
        unsatisfied.push({
          label: check.label,
          evidence: entries.map((e) => e.evidence ?? ''),
        })
      }
    }

    if (satisfied.length === 0 && unsatisfied.length === 0) return na('No comparable commands documented')

    if (unsatisfied.length === 0) {
      return pass(`CI runs every documented command: ${satisfied.join(', ')}`, [...ctx.profile.tooling.ci])
    }

    // Divergence on a subset is a real finding: an agent is told `lint` verifies the
    // change, CI never runs it, and the breakage reaches main.
    return warn(
      `CI does not appear to run: ${unsatisfied.map((u) => u.label).join(', ')}. Matched: ${satisfied.join(', ') || 'none'}. An agent told these commands verify its work would be lying.`,
      [...ctx.profile.tooling.ci, ...unsatisfied.flatMap((u) => u.evidence)],
      {
        kind: 'manual',
        origin: 'derived',
        summary: `Make CI run the documented ${unsatisfied.map((u) => u.label).join(', ')} command(s), or stop documenting them`,
        confidence: 0.7,
      },
    )
  },
}

const LOCKFILE: Rule = {
  id: 'LOCKFILE',
  layer: 'operability',
  severity: 'medium',
  title: 'Dependencies are locked',
  order: 28,
  evaluate(ctx) {
    const lockfiles = [
      'package-lock.json',
      'pnpm-lock.yaml',
      'yarn.lock',
      'bun.lockb',
      'Cargo.lock',
      'poetry.lock',
      'uv.lock',
      'go.sum',
      'Gemfile.lock',
      'gradle.lockfile',
    ]
    const found = lockfiles.filter((f) => ctx.profile.files.includes(f))
    if (found.length === 0) return na('No lockfile convention for this ecosystem detected')
    if (found.length > 1) {
      return fail(
        `${found.length} lockfiles present (${found.join(', ')}). Builds are not reproducible and a second lockfile usually means a second package manager.`,
        found,
        {
          kind: 'manual',
          origin: 'derived',
          summary: `Remove the unused lockfile(s), keep one of: ${found.join(', ')}`,
          confidence: 0.8,
        },
      )
    }
    return pass(found[0] as string, [found[0] as string])
  },
}

const PRECOMMIT: Rule = {
  id: 'PRECOMMIT',
  layer: 'operability',
  severity: 'low',
  title: 'Pre-commit hooks configured',
  order: 29,
  evaluate(ctx) {
    if (!ctx.hasCode) return na('No source files detected')
    if (ctx.profile.tooling.hooks.length === 0) {
      return warn('No pre-commit hooks; formatting and lint fixes land as review noise', [], {
        kind: 'install',
        origin: 'community',
        summary: 'Add a pre-commit framework so the formatter runs before review',
        source: { label: 'pre-commit', url: 'https://pre-commit.com' },
        confidence: 0.7,
      })
    }
    return pass(ctx.profile.tooling.hooks.join(', '), ['package.json'])
  },
}

const INSTALL_DOC: Rule = {
  id: 'INSTALL_DOC',
  layer: 'operability',
  severity: 'medium',
  title: 'Install command documented',
  order: 30,
  evaluate(ctx) {
    if (!ctx.hasCode) return na('No source files detected')
    if (hasCommand(ctx, 'install')) return pass(commands(ctx, 'install').join(', '))
    return warn(
      'No documented dependency-install command',
      [],
      derived('AGENTS.md', 'Document how to install dependencies', 0.7),
    )
  },
}

// ---------------------------------------------------------------------------
// Context
// ---------------------------------------------------------------------------

const PLAYBOOK: Rule = {
  id: 'PLAYBOOK',
  layer: 'context',
  severity: 'medium',
  title: 'Stack matched to known technology guidance',
  order: 40,
  evaluate(ctx) {
    const ids = ctx.profile.stacks.map((s) => s.id)
    if (ids.length === 0) {
      return na('No stack detected; M1 runs with the built-in detectors only')
    }
    return warn(
      `Detected: ${ids.join(', ')}. Playbook matching (official docs, skills and community resources per technology) lands in M2a.`,
      ctx.profile.stacks.flatMap((s) => s.evidence).slice(0, 4),
    )
  },
}

const MCP: Rule = {
  id: 'MCP',
  layer: 'context',
  severity: 'low',
  title: 'MCP servers or agent config present',
  order: 41,
  evaluate(ctx) {
    const configured = ctx.profile.files.filter(
      (f) =>
        f === '.mcp.json' ||
        f === 'opencode.json' ||
        f === 'opencode.jsonc' ||
        f === '.vscode/mcp.json' ||
        f === '.cursor/mcp.json',
    )
    const hasSkills = ctx.profile.files.some(
      (f) => f.startsWith('.agents/skills/') || f.startsWith('.opencode/skills/') || f.startsWith('.claude/skills/'),
    )
    if (configured.length > 0 || hasSkills) {
      return pass([...configured, hasSkills ? 'project skills' : ''].filter(Boolean).join(', '), configured)
    }
    return warn('No MCP servers or project skills configured. The agent has no repo-specific tools.', [], {
      kind: 'install',
      origin: 'community',
      summary: 'Configure an MCP server relevant to this stack',
      confidence: 0.5,
    })
  },
}

const STYLE_GUIDE: Rule = {
  id: 'STYLE_GUIDE',
  layer: 'context',
  severity: 'low',
  title: 'Style guide or ADR history present',
  order: 42,
  evaluate(ctx) {
    if (ctx.profile.docs.adr !== null) return pass('ADR / decision records present', [ctx.profile.docs.adr])
    return warn('No architecture decision records. Conventions are inherited but not justified.', [], null)
  },
}

// ---------------------------------------------------------------------------
// Governance
// ---------------------------------------------------------------------------

/**
 * Words that mean "this is scaffolding", not "this is a person or a team".
 *
 * A CODEOWNERS rule naming a team that does not exist does not fail loudly. GitHub falls
 * back to whoever is eligible to review, so a file full of placeholders behaves exactly like
 * no file at all while reading as though review routing is configured. Presence was all this
 * rule checked, which made a template of placeholders a *pass* -- the most reassuring kind of
 * wrong.
 *
 * Matched **per hyphen/slash-separated segment, case-insensitively**, not as a substring. A
 * substring test is how `@todoist-team`, `@XXXcorp` and `@acme/replace-service` all got
 * flagged, and flagging a real owner is the expensive error here -- it teaches people to
 * ignore the rule. The list is therefore restricted to words no team names itself: `replace`
 * and `change` had to go, because "replace" and "change" are ordinary English words a real
 * service might be named after, and a false positive on a real owner costs more than a
 * missed placeholder. Segments keep every real handle in the plan's own test list passing
 * (`@acme/platform-team`, `@myorg/core`, `@the-owner`, `@nodejs`) while still catching
 * `@TODO-OWNER-default`, which is what the rule exists for.
 */
const PLACEHOLDER_HANDLE_SEGMENTS: ReadonlySet<string> = new Set([
  'todo',
  'fixme',
  'changeme',
  'placeholder',
  'replaceme',
  'your',
  'xxx',
  'tbd',
  'dummy',
  'nobody',
  'unknown',
])

/**
 * Top-level domains reserved by RFC 2606 as permanently unresolvable.
 *
 * Far better evidence than string-matching an address: `.invalid` cannot be delivered to by
 * anyone, ever, so `security@example.invalid` is a placeholder whether or not it says so.
 */
const RESERVED_TLDS: readonly string[] = ['.invalid', '.test', '.example', '.localhost']

/**
 * Whether an owner token is one GitHub can resolve to a real person or team.
 *
 * GitHub accepts `@user`, `@org/team-name` and an email address. It does *not* accept a bare
 * `org/team` or `username`, so those lines route nothing -- but they are not comments either,
 * and saying "every line is a comment or blank" about a file full of them is exactly the
 * confidently-wrong sentence this project refuses to print.
 */
function classifyCodeownerOwners(body: string): { owners: string[]; unresolved: string[]; rules: number } {
  const owners: string[] = []
  const unresolved: string[] = []
  let rules = 0
  for (const raw of body.split('\n')) {
    const line = raw.split('#')[0]?.trim() ?? ''
    if (line === '') continue
    rules++
    // The first token is the path pattern; everything after it is an owner.
    for (const token of line.split(/\s+/).slice(1)) {
      if (token.startsWith('@') && token.length > 1) owners.push(token)
      else if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(token)) owners.push(token)
      else unresolved.push(token)
    }
  }
  return { owners, unresolved, rules }
}

/** A placeholder word in any hyphen/slash segment of a handle, lowercased. */
function isPlaceholderHandle(handle: string): boolean {
  const bare = handle.replace(/^@/, '').toLowerCase()
  return bare.split(/[-_/.]+/).some((segment) => segment !== '' && PLACEHOLDER_HANDLE_SEGMENTS.has(segment))
}

/**
 * A placeholder email address: a reserved TLD, or a placeholder word in the local part.
 *
 * The local part only, because the domain is where real organisations live -- matching
 * placeholder words across the whole address flagged real addresses like
 * `security@replaceme-corp.com`'s innocent cousins for no reason.
 */
function isPlaceholderAddress(address: string): boolean {
  const lower = address.toLowerCase()
  if (RESERVED_TLDS.some((tld) => lower.endsWith(tld))) return true
  const local = lower.split('@')[0] ?? ''
  return local.split(/[-_.]+/).some((segment) => segment !== '' && PLACEHOLDER_HANDLE_SEGMENTS.has(segment))
}

const CODEOWNERS: Rule = {
  id: 'CODEOWNERS',
  layer: 'governance',
  severity: 'medium',
  title: 'CODEOWNERS present',
  order: 50,
  evaluate(ctx) {
    const path = ctx.profile.docs.codeowners
    if (path === null) {
      return warn(
        'No CODEOWNERS. Review routing (including the extra reviewers a risky PR needs) has to be manual.',
        [],
        derived('CODEOWNERS', 'Add CODEOWNERS so review routing is automatic', 0.7),
      )
    }
    const body = ctx.codeowners
    if (body === null) return pass('CODEOWNERS present', [path])

    const { owners, unresolved, rules } = classifyCodeownerOwners(body)
    const handles = owners.filter((o) => o.startsWith('@'))
    const emails = owners.filter((o) => !o.startsWith('@'))

    if (handles.length === 0 && emails.length === 0) {
      if (unresolved.length > 0) {
        return warn(
          `CODEOWNERS names ${unresolved.length} owner(s) GitHub cannot resolve (${[...new Set(unresolved)].slice(0, 3).join(', ')}). It requires @user, @org/team-name or an email address, so those rules route nothing.`,
          [path],
          derived('CODEOWNERS', 'Prefix each owner with @, or use an email address', 0.8),
        )
      }
      return warn(
        'CODEOWNERS contains no owner, so it routes nothing. Every line is a comment, blank, or a path with no owner after it.',
        [path],
        derived('CODEOWNERS', 'Give each rule a real owner handle', 0.8),
      )
    }
    // A placeholder anywhere among the real owners is worth naming, but only those: printing
    // the real owners next to a warning about placeholders teaches a reader to distrust the
    // rule's evidence.
    const placeholders = owners.filter((o) => isPlaceholderHandle(o) || isPlaceholderAddress(o))
    if (placeholders.length === owners.length) {
      // Every owner is scaffolding, so the file is a template. Reported as a warning rather
      // than a pass, because it becomes correct the moment real owners replace them, and as
      // a failure because *today* it routes nothing while looking configured.
      return warn(
        `CODEOWNERS is a template: every owner is a placeholder (${placeholders.join(', ')}). GitHub does not fail on an unknown owner -- it falls back to whoever can review, so this behaves like no CODEOWNERS at all.`,
        [path],
        derived('CODEOWNERS', 'Replace the placeholder owners with real users or teams', 0.9),
      )
    }
    if (placeholders.length > 0) {
      return warn(
        `Some CODEOWNERS rules still point at placeholders (${placeholders.join(', ')}); those paths fall back to the default reviewer.`,
        [path],
        derived('CODEOWNERS', 'Replace the remaining placeholder owners', 0.7),
      )
    }
    if (unresolved.length > 0) {
      return warn(
        `${[...new Set(owners)].join(', ')} route(s) resolve, but ${unresolved.length} owner token(s) (${[...new Set(unresolved)].slice(0, 3).join(', ')}) do not: GitHub needs @user, @org/team-name or an email address.`,
        [path],
        derived('CODEOWNERS', 'Prefix every owner with @, or use an email address', 0.7),
      )
    }
    const distinct = [...new Set(owners)]
    return pass(`${distinct.length} distinct owner(s) across ${rules} rule(s): ${distinct.join(', ')}`, [path])
  },
}

const PR_TEMPLATE: Rule = {
  id: 'PR_TEMPLATE',
  layer: 'governance',
  severity: 'low',
  title: 'PR template present',
  order: 51,
  evaluate(ctx) {
    if (ctx.profile.docs.prTemplate !== null) return pass('PR template present', [ctx.profile.docs.prTemplate])
    return warn('No PR template', [], derived('.github/pull_request_template.md', 'Add a PR template', 0.6))
  },
}

const ISSUE_TEMPLATE: Rule = {
  id: 'ISSUE_TEMPLATE',
  layer: 'governance',
  severity: 'low',
  title: 'Issue template present',
  order: 52,
  evaluate(ctx) {
    if (ctx.profile.docs.issueTemplate !== null) return pass('Issue template present', [ctx.profile.docs.issueTemplate])
    return warn('No issue template', [], derived('.github/ISSUE_TEMPLATE.md', 'Add an issue template', 0.5))
  },
}

const CONTRIBUTING: Rule = {
  id: 'CONTRIBUTING',
  layer: 'governance',
  severity: 'info',
  title: 'CONTRIBUTING present',
  order: 53,
  evaluate(ctx) {
    if (ctx.profile.docs.contributing !== null) return pass('CONTRIBUTING present', [ctx.profile.docs.contributing])
    return warn('No CONTRIBUTING document', [], null)
  },
}

const SECURITY_MD: Rule = {
  id: 'SECURITY_MD',
  layer: 'governance',
  severity: 'low',
  title: 'SECURITY policy present',
  order: 54,
  evaluate(ctx) {
    const path = ctx.profile.docs.security
    if (path === null) return warn('No SECURITY.md', [], null)
    const body = ctx.security
    if (body === null) return pass('SECURITY.md present', [path])

    // A security contact nobody monitors is worse than none: a researcher who reports a real
    // vulnerability and gets silence concludes the project is not worth reporting to, and
    // that conclusion is hard to undo. So a file whose address is still a placeholder is not
    // a policy yet, however official it looks.
    const addresses = [...body.matchAll(/[\w.+-]+@[\w-]+(\.[\w-]+)+/g)].map((m) => m[0])
    // A reporting channel is not an address. GitHub's own SECURITY.md template points at the
    // private advisories page and GitLab at confidential issues, and both are monitored by
    // construction -- so a policy with no email address is often a *good* policy, and calling
    // it "nowhere to report a vulnerability" is a confident claim about the world that no
    // regex can support.
    const channel =
      /advisories\/new|security\/advisories|private vulnerabilit|confidential issue|security report|responsible disclosure/i.test(
        body,
      )
    if (addresses.length === 0) {
      if (channel) {
        return pass('SECURITY.md points reports at a private reporting channel, and names no address', [path])
      }
      return warn(
        'SECURITY.md names no contact address and no private reporting channel, so this report cannot say where a vulnerability would go.',
        [path],
        derived('SECURITY.md', 'Add a monitored security contact address or a private reporting channel', 0.8),
      )
    }
    const placeholders = addresses.filter(isPlaceholderAddress)
    if (placeholders.length === addresses.length) {
      return warn(
        `SECURITY.md still points at a placeholder address (${placeholders.join(', ')}). Reports sent there are not read.`,
        [path],
        derived('SECURITY.md', 'Replace the placeholder with a monitored address', 0.9),
      )
    }
    if (placeholders.length > 0) {
      return warn(
        `SECURITY.md lists a placeholder address (${placeholders.join(', ')}) alongside a real one; verify which one is monitored.`,
        [path],
        derived('SECURITY.md', 'Remove the placeholder address', 0.7),
      )
    }
    return pass(`Reports go to ${addresses.join(', ')}`, [path])
  },
}

const LICENSE: Rule = {
  id: 'LICENSE',
  layer: 'governance',
  severity: 'info',
  title: 'License present',
  order: 55,
  evaluate(ctx) {
    if (ctx.profile.docs.license !== null) return pass('License present', [ctx.profile.docs.license])
    return warn('No LICENSE file', [], null)
  },
}

const GITIGNORE_ENV: Rule = {
  id: 'GITIGNORE_ENV',
  layer: 'governance',
  severity: 'high',
  title: '.env files are gitignored',
  order: 56,
  evaluate(ctx) {
    if (!ctx.profile.files.includes('.gitignore'))
      return na('No .gitignore (repo is not Git-managed, or ignores nothing)')
    const hasEnv = ctx.profile.files.some((f) => /(^|\/)\.env(\..+)?$/.test(f))
    if (!hasEnv) return pass('No .env files present', ['.gitignore'])
    return warn(
      '.env-like files are tracked by git',
      ctx.profile.files.filter((f) => /(^|\/)\.env/.test(f)).slice(0, 3),
      {
        kind: 'manual',
        origin: 'derived',
        summary: 'Remove .env from git and add it to .gitignore',
        confidence: 0.95,
      },
    )
  },
}

const ENV_EXAMPLE: Rule = {
  id: 'ENV_EXAMPLE',
  layer: 'governance',
  severity: 'low',
  title: 'Environment variables documented',
  order: 57,
  evaluate(ctx) {
    const hasExample = ctx.profile.files.some((f) => /\.env\.example$|\.env\.sample$|\.env\.template$/.test(f))
    const referencesEnv =
      ctx.instructionsText.includes('.env') ||
      ctx.profile.files.some((f) => /process\.env|os\.environ|System\.getenv/.test(f))
    if (!referencesEnv) return na('No environment variable usage detected')
    if (hasExample)
      return pass(
        'Environment variables documented',
        ctx.profile.files.filter((f) => /\.env\.example$/.test(f)),
      )
    return warn(
      'Environment variables are used but no .env.example documents them',
      [],
      derived('.env.example', 'Add .env.example listing required variables with no real values', 0.8),
    )
  },
}

/** Secret scanning is filename-and-pattern based in M1; entropy scanning lands later. */
/**
 * Path segments that mean "sample data, not the product".
 *
 * A `.env`, a `.pem` or a private key under one of these is a *fixture* -- a test that
 * proves the code handles a credential, or a playground that exercises env parsing. This
 * list exists because the first audit of ten real repositories failed SECRET_SCAN on six of
 * them, every time on exactly this: expired test certificates under `tests/certs`, a
 * `.env` under `tests/test_apps`, a `.env` per playground in a bundler's fixture tree. A
 * rule that fires on every mature repository teaches its reader to ignore it, which costs
 * more than the one real leak it might catch.
 *
 * `docs` is deliberately **not** here: sample files in documentation are common, but a
 * credential committed under `docs/` is still a leak worth failing on.
 */
const TEST_DATA_SEGMENTS: ReadonlySet<string> = new Set([
  'test',
  'tests',
  '__tests__',
  'spec',
  'specs',
  'testing',
  'testdata',
  'test-data',
  'fixture',
  'fixtures',
  '__fixtures__',
  'playground',
  'playgrounds',
  'example',
  'examples',
  'sample',
  'samples',
])

function isTestDataPath(path: string): boolean {
  return path.split('/').some((segment) => TEST_DATA_SEGMENTS.has(segment.toLowerCase()))
}

/**
 * Credential files that are only suspicious by *content*.
 *
 * A committed `.npmrc` is not a leak: it usually holds a registry URL and a scope. It
 * becomes one the moment it contains an auth token, so this reads the file and decides
 * rather than guessing from the name. (`.netrc` and `.pypirc` are *meant* to hold
 * credentials, so those stay filename-based.)
 *
 * `always-auth` is deliberately absent: it is a boolean flag, not a credential, and older CI
 * configurations set it with no token in sight. Treating it as one produced a false positive
 * on a file that contained no secret at all.
 */
function npmrcHasToken(root: string, path: string): boolean {
  try {
    const text = readFileSync(join(root, ...path.split('/')), 'utf8')
    return /(_authToken|_auth\s*=|_password\s*=)/i.test(text)
  } catch {
    // Unreadable is not evidence of a token, and guessing "secret" on an unreadable file
    // is the same false positive by another route.
    return false
  }
}

const SECRET_SCAN: Rule = {
  id: 'SECRET_SCAN',
  layer: 'governance',
  severity: 'high',
  title: 'No obvious committed secrets',
  order: 58,
  evaluate(ctx) {
    const shaped = ctx.profile.files.filter((f) =>
      /(^|\/)\.env(\.(local|production|prod|secret))?$|\.(pem|p12|pfx|key|keystore)$|(^|\/)id_(rsa|dsa|ecdsa|ed25519)$|(^|\/)\.npmrc$|(^|\/)\.pypirc$|(^|\/)\.netrc$/.test(
        f,
      ),
    )

    // Split what a credential file *looks like* from what it *is*: a fixture under a test
    // path, or a config file with no token in it, is not a committed secret.
    //
    // **The content check runs first, and the order is load-bearing.** Deciding by path
    // first would let a real `_authToken` sitting in `examples/app/.npmrc` be dismissed as
    // a fixture -- and then the pass detail would assert "no committed secrets" about a file
    // nobody opened. A rule that says a credential is absent after not looking at it is the
    // most dangerous output this tool can produce, so a file whose content decides whether
    // it is a secret is always read.
    const fixtures: string[] = []
    const uninspected: string[] = []
    const tokenFree: string[] = []
    const real: string[] = []
    for (const file of shaped) {
      if (/(^|\/)\.npmrc$/.test(file)) {
        if (npmrcHasToken(ctx.profile.root, file)) real.push(file)
        else tokenFree.push(file)
        continue
      }
      if (isTestDataPath(file)) {
        // A fixture's content is not inspected, so the finding must not claim it was.
        uninspected.push(file)
        continue
      }
      real.push(file)
    }
    fixtures.push(...tokenFree, ...uninspected)

    if (real.length === 0) {
      const noted = [...new Set(fixtures)].slice(0, 4)
      const detail =
        noted.length === 0
          ? 'No secret-shaped files tracked'
          : [
              'No committed secret found in the tracked secret-shaped files.',
              tokenFree.length > 0 ? `${tokenFree.length} of them hold config with no auth token` : '',
              uninspected.length > 0
                ? `${uninspected.length} sit in a test/sample path and were not content-inspected`
                : '',
              `Files: ${noted.join(', ')}${fixtures.length > noted.length ? ', ...' : ''}`,
            ]
              .filter((part) => part !== '')
              .join(' ')
      return pass(detail, noted)
    }
    return fail(
      `${real.length} secret-shaped file(s) tracked in git: ${real.slice(0, 4).join(', ')}`,
      real.slice(0, 6),
      {
        kind: 'manual',
        origin: 'derived',
        summary: 'Remove these from git, rotate any real credentials, and gitignore them',
        confidence: 0.9,
      },
    )
  },
}

/**
 * RISK_MAP: is the blast radius documented?
 *
 * The risk map is computed in the profile; this rule only asks whether the repo or its
 * instructions acknowledge it. Acting on it (risk checklists in PR bodies) is M6.
 */
const RISK_MAP: Rule = {
  id: 'RISK_MAP',
  layer: 'governance',
  severity: 'medium',
  title: 'High-risk paths identified',
  order: 59,
  evaluate(ctx) {
    const high = ctx.profile.risk.filter((r) => r.level === 'high')
    if (high.length === 0) return na('No high-risk paths detected')
    const text = ctx.instructionsText.toLowerCase()
    const mentioned = high.filter((r) => text.includes(r.reason.toLowerCase().split(' ')[0] ?? '')).length
    if (mentioned === 0) {
      return warn(
        `${high.length} high-risk path pattern(s) detected but not mentioned in the instructions. An agent will edit them with the same care as a typo fix.`,
        high.map((r) => r.glob),
        derived('AGENTS.md', 'Document which paths are high-risk and need extra review', 0.75),
      )
    }
    return pass(
      `${high.length} high-risk patterns, ${mentioned} acknowledged in instructions`,
      high.map((r) => r.glob),
    )
  },
}

export const RULES: readonly Rule[] = [
  AGENTS_FILE,
  AGENTS_COMMANDS,
  ARCH_DOC,
  MODULE_MAP,
  CONVENTIONS,
  BUILD,
  TEST,
  TEST_FAST,
  LINT,
  FORMAT,
  TYPECHECK,
  CI,
  CI_PARITY,
  LOCKFILE,
  PRECOMMIT,
  INSTALL_DOC,
  PLAYBOOK,
  MCP,
  STYLE_GUIDE,
  CODEOWNERS,
  PR_TEMPLATE,
  ISSUE_TEMPLATE,
  CONTRIBUTING,
  SECURITY_MD,
  LICENSE,
  GITIGNORE_ENV,
  ENV_EXAMPLE,
  SECRET_SCAN,
  RISK_MAP,
].sort((a, b) => a.order - b.order)

export { install }
