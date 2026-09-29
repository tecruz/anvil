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

import type { ProjectProfile } from '@anvil/profile'
import type { Finding, Fix, Layer, Severity, Status } from './types.ts'

export interface RuleContext {
  profile: ProjectProfile
  /** True when the repo has a primary language (i.e. it is not docs/config only). */
  hasCode: boolean
  hasTests: boolean
  /** Agent instruction text, concatenated, for content checks. */
  instructionsText: string
  /**
   * Contents of each CI workflow file, keyed by repo-relative path.
   *
   * Read by the engine rather than the profile because it is only needed by one rule,
   * and reading every workflow into the profile would bloat the `--json` output that the
   * opencode plugin consumes.
   */
  ciWorkflows: ReadonlyMap<string, string>
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

const pass = (detail: string, evidence: string[] = []): RuleOutcome => ({ status: 'pass', detail, evidence })
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
  return { kind: 'create-file', origin: 'derived', target, summary, confidence }
}

function install(summary: string, label: string, url: string, confidence: number): Fix {
  return { kind: 'install', origin: 'community', summary, source: { label, url }, confidence }
}

function hasCommand(ctx: RuleContext, kind: keyof ProjectProfile['commands']): boolean {
  const entries = ctx.profile.commands[kind]
  return Array.isArray(entries) && entries.length > 0
}

function commands(ctx: RuleContext, kind: keyof ProjectProfile['commands']): string[] {
  return (ctx.profile.commands[kind] ?? []).map((c) => `${c.cmd} [${c.source}]`)
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
  return /(^|[\s`"'(])(npm |pnpm |yarn |bun |cargo |go |gradlew|mvnw|pytest|make |dotnet |tsc |ruff |mypy |eslint)/m.test(text)
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
      return fail('No instructions to inspect, and no commands documented', [], derived(
        'AGENTS.md',
        'Create AGENTS.md documenting the build, test and lint commands',
        0.95,
      ))
    }
    if (!mentionsCommand(ctx.instructionsText)) {
      return fail(
        'Instructions exist but name no runnable command. An agent that cannot verify its work produces unreviewable diffs.',
        ctx.profile.instructions.map((i) => i.path),
        derived('AGENTS.md', 'Add the build/test/lint commands to AGENTS.md', 0.95),
      )
    }
    return pass('Instructions name runnable commands', ctx.profile.instructions.map((i) => i.path))
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
      return pass(`Conventions enforced by tooling: ${[...ctx.profile.tooling.lint, ...ctx.profile.tooling.formatter].join(', ')}`, [
        'package.json',
      ])
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
    if (hasCommand(ctx, 'build')) return pass(commands(ctx, 'build').join(', '))
    if (hasCommand(ctx, 'test')) {
      return warn('No separate build command, but a test command exists that implies compilation', ['package.json'])
    }
    return fail('No build command. An agent cannot confirm its change compiles.', [], derived(
      'AGENTS.md',
      'Document the build command',
      0.7,
    ))
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
    if (!hasCommand(ctx, 'test')) {
      return fail(
        ctx.hasTests
          ? 'Test files exist but no runnable test command was found.'
          : 'No tests and no test command.',
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
    if (entries.length > 0) return pass(entries.map((c) => `${c.cmd} [${c.source}]`).join(', '), entries.map((c) => c.evidence ?? ''))

    // Documented in prose but not detected as a command: report the prose, not the guess.
    if (mentionsCommand(ctx.instructionsText) && /(--changed|-k\s|--onlyChanged|nextest|test:fast|test-changed)/i.test(ctx.instructionsText)) {
      return pass('A changed-files test subset is described in the instructions', ['AGENTS.md'])
    }

    const hasRunner = ctx.profile.tooling.test.length > 0
    if (hasRunner) {
      return warn(
        `A test runner is configured (${ctx.profile.tooling.test.join(', ')}) but no changed-files subset is documented. Full-suite feedback on every iteration makes agents unusable.`,
        ctx.profile.tooling.test,
        derived('AGENTS.md', 'Document a changed-files test command', 0.8),
      )
    }
    return fail('No changed-files test subset documented and no test runner detected.', [], derived(
      'AGENTS.md',
      'Document a changed-files test command',
      0.8,
    ))
  },
}

const LINT: Rule = {
  id: 'LINT',
  layer: 'operability',
  severity: 'medium',
  title: 'Linter configured',
  order: 23,
  evaluate(ctx) {
    if (!ctx.hasCode) return na('No source files detected')
    if (ctx.profile.tooling.lint.length === 0) {
      return fail('No linter configured. Nothing catches the mistakes an agent makes most often.', [], derived(
        'AGENTS.md',
        'Configure a linter and document the command',
        0.7,
      ))
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
      return warn('No formatter configured; agents reformat by hand and produce noisy diffs', [], derived(
        'AGENTS.md',
        'Configure a formatter and document the command',
        0.6,
      ))
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
        source: { label: 'GitHub Actions docs', url: 'https://docs.github.com/actions' },
        confidence: 0.85,
      })
    }
    return pass(`${ctx.profile.tooling.ci.length} workflow file(s)`, ctx.profile.tooling.ci)
  },
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
    const CHECKS: Array<{ kind: keyof ProjectProfile['commands']; label: string; tokens: string[] }> = [
      { kind: 'test', label: 'test', tokens: ['npm test', 'npm run test', 'yarn test', 'pnpm test', 'pytest', 'go test', 'cargo test', 'dotnet test', 'gradlew test', './gradlew test', 'mvn test', './mvnw test', 'jest', 'vitest', 'nextest'] },
      { kind: 'build', label: 'build', tokens: ['npm run build', 'npm run build', 'yarn build', 'pnpm build', 'cargo build', 'dotnet build', 'gradlew build', './gradlew build', 'go build', 'mvn package', 'tsc'] },
      { kind: 'lint', label: 'lint', tokens: ['npm run lint', 'npm run lint', 'yarn lint', 'eslint', 'ruff check', 'golangci-lint', 'cargo clippy', 'dotnet format'] },
      { kind: 'typecheck', label: 'typecheck', tokens: ['tsc --noEmit', 'npm run typecheck', 'mypy', 'pyright'] },
    ]

    const workflowText = [...ctx.ciWorkflows.values()].join('\n').toLowerCase()
    if (workflowText.trim() === '') return na('CI workflow files are empty or unreadable')

    const satisfied: string[] = []
    const unsatisfied: Array<{ label: string; evidence: string[] }> = []

    for (const check of CHECKS) {
      const entries = ctx.profile.commands[check.kind] ?? []
      if (entries.length === 0) continue
      const hit = check.tokens.find((t) => workflowText.includes(t.toLowerCase()))
      if (hit !== undefined) {
        satisfied.push(`${check.label} (${hit})`)
      } else {
        unsatisfied.push({ label: check.label, evidence: entries.map((e) => e.evidence ?? '') })
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
    const lockfiles = ['package-lock.json', 'pnpm-lock.yaml', 'yarn.lock', 'bun.lockb', 'Cargo.lock', 'poetry.lock', 'uv.lock', 'go.sum', 'Gemfile.lock', 'gradle.lockfile']
    const found = lockfiles.filter((f) => ctx.profile.files.includes(f))
    if (found.length === 0) return na('No lockfile convention for this ecosystem detected')
    if (found.length > 1) {
      return fail(
        `${found.length} lockfiles present (${found.join(', ')}). Builds are not reproducible and a second lockfile usually means a second package manager.`,
        found,
        { kind: 'manual', origin: 'derived', summary: `Remove the unused lockfile(s), keep one of: ${found.join(', ')}`, confidence: 0.8 },
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
    return warn('No documented dependency-install command', [], derived(
      'AGENTS.md',
      'Document how to install dependencies',
      0.7,
    ))
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
      (f) => f === '.mcp.json' || f === 'opencode.json' || f === 'opencode.jsonc' || f === '.vscode/mcp.json' || f === '.cursor/mcp.json',
    )
    const hasSkills = ctx.profile.files.some((f) => f.startsWith('.agents/skills/') || f.startsWith('.opencode/skills/') || f.startsWith('.claude/skills/'))
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

const CODEOWNERS: Rule = {
  id: 'CODEOWNERS',
  layer: 'governance',
  severity: 'medium',
  title: 'CODEOWNERS present',
  order: 50,
  evaluate(ctx) {
    if (ctx.profile.docs.codeowners !== null) return pass('CODEOWNERS present', [ctx.profile.docs.codeowners])
    return warn(
      'No CODEOWNERS. Review routing (including the extra reviewers a risky PR needs) has to be manual.',
      [],
      derived('CODEOWNERS', 'Add CODEOWNERS so review routing is automatic', 0.7),
    )
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
    if (ctx.profile.docs.security !== null) return pass('SECURITY.md present', [ctx.profile.docs.security])
    return warn('No SECURITY.md', [], null)
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
    if (!ctx.profile.files.includes('.gitignore')) return na('No .gitignore (repo is not Git-managed, or ignores nothing)')
    const hasEnv = ctx.profile.files.some((f) => /(^|\/)\.env(\..+)?$/.test(f))
    if (!hasEnv) return pass('No .env files present', ['.gitignore'])
    return warn('.env-like files are tracked by git', ctx.profile.files.filter((f) => /(^|\/)\.env/.test(f)).slice(0, 3), {
      kind: 'manual',
      origin: 'derived',
      summary: 'Remove .env from git and add it to .gitignore',
      confidence: 0.95,
    })
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
    const referencesEnv = ctx.instructionsText.includes('.env') || ctx.profile.files.some((f) => /process\.env|os\.environ|System\.getenv/.test(f))
    if (!referencesEnv) return na('No environment variable usage detected')
    if (hasExample) return pass('Environment variables documented', ctx.profile.files.filter((f) => /\.env\.example$/.test(f)))
    return warn('Environment variables are used but no .env.example documents them', [], derived(
      '.env.example',
      'Add .env.example listing required variables with no real values',
      0.8,
    ))
  },
}

/** Secret scanning is filename-and-pattern based in M1; entropy scanning lands later. */
const SECRET_SCAN: Rule = {
  id: 'SECRET_SCAN',
  layer: 'governance',
  severity: 'high',
  title: 'No obvious committed secrets',
  order: 58,
  evaluate(ctx) {
    const suspicious = ctx.profile.files.filter((f) =>
      /(^|\/)\.env(\.(local|production|prod|secret))?$|\.(pem|p12|pfx|key|keystore)$|(^|\/)id_(rsa|dsa|ecdsa|ed25519)$|(^|\/)\.npmrc$|(^|\/)\.pypirc$|(^|\/)\.netrc$/.test(f),
    )
    if (suspicious.length === 0) return pass('No secret-shaped files tracked', ['.gitignore'])
    return fail(
      `${suspicious.length} secret-shaped file(s) tracked in git: ${suspicious.slice(0, 4).join(', ')}`,
      suspicious.slice(0, 6),
      { kind: 'manual', origin: 'derived', summary: 'Remove these from git, rotate any real credentials, and gitignore them', confidence: 0.9 },
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
    return pass(`${high.length} high-risk patterns, ${mentioned} acknowledged in instructions`, high.map((r) => r.glob))
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
