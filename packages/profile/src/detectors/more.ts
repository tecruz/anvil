/**
 * Six further ecosystem detectors: Ruby, PHP, Elixir, frontend frameworks,
 * Swift and Terraform.
 *
 * Chosen for the "any company, any project" premise rather than for any ranking of
 * importance. Each follows the same rules as the first six: never execute, label
 * commands honestly, and only report a command when something in the repo defines it.
 *
 * Detectors that would need to parse a real manifest to do their job are deliberately
 * shallow here. A half-parsed Gemfile that yields a wrong build command is worse than no
 * detection, so these report the stack and the tooling, and mark commands `inferred`
 * unless a task-runner definition proves otherwise.
 */

import { join } from 'node:path'
import {
  addCommand,
  addRisk,
  addStack,
  addTool,
  type Detector,
  type DetectorContext,
  filesUnder,
  hasFile,
  hookFramework,
} from '../detector.ts'
import { evidence, findLine, looseVersion } from '../manifest.ts'
import { readText } from '../walk.ts'

function read(ctx: DetectorContext, rel: string): string | null {
  return readText(join(ctx.root, ctx.resolve(rel))).text
}

/**
 * Find a Rake task definition.
 *
 * Handles the four idioms that actually appear:
 *
 *   - `task :test => ...`                     the plain declaration
 *   - `Rake::TestTask.new(:test)`             rake's own test task
 *   - `Minitest::TestTask.create`             minitest 6+; with no argument it creates
 *     the default `test` task, which is why a bare `.create` has to count
 *   - `RSpec::Core::RakeTask.new(:spec)`      how most Rails projects declare `spec`
 *
 * Only the first and last were handled before, which meant a minitest project with a
 * Rakefile reported no test command at all -- and the audit's `TEST` rule then failed as a
 * blocker on a repository whose tests run perfectly well with `rake test`.
 */
function rakeTask(text: string, task: string): number | null {
  const forms: RegExp[] = [
    new RegExp(`^\\s*task\\s+:${task}\\b`, 'm'),
    new RegExp(`RakeTask\\.new\\(:['"]?${task}\\b`),
    new RegExp(`Minitest::TestTask\\.create\\(\\s*:['"]${task}\\b`),
  ]
  // A bare `Minitest::TestTask.create` defines the default `test` task, so it counts for
  // `test` and for nothing else.
  if (task === 'test') forms.push(/Minitest::TestTask\.create\b/)
  for (const re of forms) {
    const line = findLine(text, re)
    if (line !== null) return line
  }
  return null
}

// ---------------------------------------------------------------------------
// Ruby
// ---------------------------------------------------------------------------

export const rubyDetector: Detector = {
  id: 'ruby',
  title: 'Ruby',
  priority: 50,
  matches: (ctx) => hasFile(ctx, 'Gemfile') || hasFile(ctx, '*.gemspec') || hasFile(ctx, 'Rakefile'),
  detect(ctx, draft) {
    const gemspecs = filesUnder(ctx, '').filter((f) => f.endsWith('.gemspec'))
    if (hasFile(ctx, 'Gemfile') || gemspecs.length > 0) {
      addStack(draft, {
        id: 'ruby',
        version: null,
        evidence: [hasFile(ctx, 'Gemfile') ? 'Gemfile' : (gemspecs[0] as string)],
      })
    }

    const rake = hasFile(ctx, 'Rakefile') ? read(ctx, 'Rakefile') : null
    if (rake !== null) {
      // A Rake task definition is real evidence; anything else is a guess.
      //
      // Which command to offer depends on which task exists. Offering `rspec` for a project
      // that declares a `test` task and uses minitest is the confident-and-wrong output
      // this tool exists to avoid: the command is real-looking, carries file:line evidence,
      // and fails when an agent runs it. `rake test` is what the Rakefile actually provides,
      // and it is correct whichever framework is underneath.
      const hasSpec = rakeTask(rake, 'spec') !== null
      const hasTest = rakeTask(rake, 'test') !== null
      if (hasTest && !hasSpec) {
        addCommand(draft, 'test', {
          cmd: 'bundle exec rake test',
          source: 'detected',
          evidence: 'Rakefile',
        })
      } else if (hasSpec || hasTest) {
        addCommand(draft, 'test', {
          cmd: 'bundle exec rspec',
          source: 'detected',
          evidence: 'Rakefile',
        })
      }
      if (rakeTask(rake, 'rubocop') !== null) {
        addTool(draft, 'lint', 'rubocop')
        addCommand(draft, 'lint', {
          cmd: 'bundle exec rubocop',
          source: 'detected',
          evidence: 'Rakefile',
        })
      }
      if (rakeTask(rake, 'standard') !== null) {
        addTool(draft, 'formatter', 'standardrb')
      }
    }
    if (hasFile(ctx, '.rubocop.yml')) addTool(draft, 'lint', 'rubocop')
    if (hasFile(ctx, '.rspec')) addTool(draft, 'test', 'rspec')
    // `RuboCop::RakeTask.new` is the canonical declaration and takes no argument, so it
    // does not show up as a named task.
    if (rake !== null && /RuboCop::RakeTask\.new/.test(rake)) {
      addTool(draft, 'lint', 'rubocop')
      addCommand(draft, 'lint', {
        cmd: 'bundle exec rubocop',
        source: 'detected',
        evidence: 'Rakefile',
      })
    }

    // Leading whitespace is allowed because a `gem` line is commonly indented inside a
    // `group` block, which is where the development tooling lives.
    const frameworks: Array<[string, RegExp]> = [
      ['rails', /^\s*gem ['"]rails['"]/m],
      ['sinatra', /^\s*gem ['"]sinatra['"]/m],
      // `rspec-rails` is the Rails integration, and is what most Rails projects declare.
      ['rspec', /^\s*gem ['"]rspec(-rails)?['"]/m],
      // Tooling is a stack too, matching how the Node detector reports eslint/jest, so
      // `anvil plan` can match a playbook on "this repo uses rubocop".
      ['rubocop', /^\s*gem ['"]rubocop(-rails)?['"]/m],
    ]
    const gemfile = hasFile(ctx, 'Gemfile') ? read(ctx, 'Gemfile') : null
    if (gemfile !== null) {
      for (const [id, re] of frameworks) {
        if (!re.test(gemfile)) continue
        const m = new RegExp(`gem ['"]${id}['"](?:,\\s*['"]([^'"]+)['"])?`).exec(gemfile)
        addStack(draft, {
          id,
          version: looseVersion(m?.[1] ?? null),
          evidence: [evidence('Gemfile', findLine(gemfile, re))],
        })
      }
    }
  },
}

// ---------------------------------------------------------------------------
// PHP / Laravel
// ---------------------------------------------------------------------------

export const phpDetector: Detector = {
  id: 'php',
  title: 'PHP',
  priority: 50,
  matches: (ctx) => hasFile(ctx, 'composer.json') || hasFile(ctx, 'artisan'),
  detect(ctx, draft) {
    addStack(draft, { id: 'php', version: null, evidence: ['composer.json'] })

    if (hasFile(ctx, 'artisan')) {
      addStack(draft, { id: 'laravel', version: null, evidence: ['artisan'] })
      // artisan defines these subcommands; their existence is checkable.
      addCommand(draft, 'test', {
        cmd: 'php artisan test',
        source: 'detected',
        evidence: 'artisan',
      })
      addCommand(draft, 'testFast', {
        cmd: 'php artisan test --filter=<Changed>',
        source: 'inferred',
      })
      if (hasFile(ctx, 'phpunit.xml') || hasFile(ctx, 'phpunit.xml.dist')) {
        addTool(draft, 'test', 'phpunit')
        addCommand(draft, 'test', {
          cmd: 'vendor/bin/phpunit',
          source: 'detected',
          evidence: 'phpunit.xml',
        })
      }
    }

    const composer = read(ctx, 'composer.json')
    if (composer !== null && /"laravel\/framework"/.test(composer)) {
      addStack(draft, {
        id: 'laravel',
        version: null,
        evidence: [evidence('composer.json', findLine(composer, /"laravel\/framework"/))],
      })
    }
    if (hasFile(ctx, 'phpstan.neon') || hasFile(ctx, 'phpstan.neon.dist')) {
      addTool(draft, 'typecheck', 'phpstan')
      addCommand(draft, 'typecheck', {
        cmd: 'vendor/bin/phpstan analyse',
        source: 'detected',
        evidence: 'phpstan.neon',
      })
    }
    if (hasFile(ctx, 'pint.json') || hasFile(ctx, '.php-cs-fixer.php')) addTool(draft, 'formatter', 'pint/php-cs-fixer')

    // Laravel's database layer is where a wrong migration does real damage.
    addRisk(draft, {
      glob: '**/migrations/**',
      level: 'high',
      reason: 'database migration',
      origin: 'heuristic',
    })
  },
}

// ---------------------------------------------------------------------------
// Elixir
// ---------------------------------------------------------------------------

export const elixirDetector: Detector = {
  id: 'elixir',
  title: 'Elixir / Phoenix',
  priority: 50,
  matches: (ctx) => hasFile(ctx, 'mix.exs'),
  detect(ctx, draft) {
    const mix = read(ctx, 'mix.exs')
    addStack(draft, {
      id: 'elixir',
      version: looseVersion(mix === null ? null : (/version:\s*"([^"]+)"/.exec(mix)?.[1] ?? null)),
      evidence: [evidence('mix.exs', mix === null ? null : findLine(mix, /app:/))],
    })
    if (mix !== null && /phoenix/.test(mix)) {
      addStack(draft, {
        id: 'phoenix',
        version: null,
        evidence: [evidence('mix.exs', findLine(mix, /phoenix/))],
      })
    }
    if (hasFile(ctx, 'config/config.exs')) {
      addStack(draft, {
        id: 'ecto',
        version: null,
        evidence: ['config/config.exs'],
      })
      addRisk(draft, {
        glob: 'priv/repo/migrations/**',
        level: 'high',
        reason: 'database migration',
        origin: 'heuristic',
      })
    }
    addCommand(draft, 'build', { cmd: 'mix compile', source: 'inferred' })
    addCommand(draft, 'test', { cmd: 'mix test', source: 'inferred' })
  },
}

// ---------------------------------------------------------------------------
// Frontend frameworks
// ---------------------------------------------------------------------------

export const frontendDetector: Detector = {
  id: 'frontend',
  title: 'Frontend framework',
  priority: 45,
  matches(ctx) {
    if (hasFile(ctx, 'vite.config.ts') || hasFile(ctx, 'vite.config.js')) return true
    if (hasFile(ctx, 'next.config.js') || hasFile(ctx, 'next.config.mjs')) return true
    return filesUnder(ctx, '').some((f) => f.endsWith('.vue') || f.endsWith('.svelte'))
  },
  detect(ctx, draft) {
    const hasVue = filesUnder(ctx, '').some((f) => f.endsWith('.vue'))
    const hasSvelte = filesUnder(ctx, '').some((f) => f.endsWith('.svelte'))

    if (hasFile(ctx, 'next.config.js') || hasFile(ctx, 'next.config.mjs') || hasFile(ctx, 'next.config.ts')) {
      addStack(draft, {
        id: 'nextjs',
        version: null,
        evidence: ['next.config.js'],
      })
    }
    if (hasVue) addStack(draft, { id: 'vue', version: null, evidence: ['*.vue'] })
    if (hasSvelte) addStack(draft, { id: 'svelte', version: null, evidence: ['*.svelte'] })
    if (hasFile(ctx, 'vite.config.ts') || hasFile(ctx, 'vite.config.js')) {
      addStack(draft, {
        id: 'vite',
        version: null,
        evidence: ['vite.config.ts'],
      })
    }

    // No build command can be claimed here: the bundler is often invoked through a
    // package script, and the node detector already read it properly.
    if (hasFile(ctx, 'eslint.config.js') || hasFile(ctx, '.eslintrc.json')) addTool(draft, 'lint', 'eslint')
    if (hasFile(ctx, 'tailwind.config.js') || hasFile(ctx, 'tailwind.config.ts')) {
      addStack(draft, {
        id: 'tailwind',
        version: null,
        evidence: ['tailwind.config.js'],
      })
    }
  },
}

// ---------------------------------------------------------------------------
// Swift / iOS
// ---------------------------------------------------------------------------

export const swiftDetector: Detector = {
  id: 'swift',
  title: 'Swift / iOS',
  priority: 50,
  matches: (ctx) => hasFile(ctx, 'Package.swift') || hasFile(ctx, '*.xcodeproj') || hasFile(ctx, 'project.pbxproj'),
  detect(ctx, draft) {
    addStack(draft, {
      id: 'swift',
      version: null,
      evidence: ['Package.swift'],
    })
    if (hasFile(ctx, 'Package.swift')) {
      // `swift build` / `swift test` are the toolchain's own subcommands, and the
      // manifest is what makes them applicable to this package.
      addCommand(draft, 'build', {
        cmd: 'swift build',
        source: 'detected',
        evidence: 'Package.swift',
      })
      addCommand(draft, 'test', {
        cmd: 'swift test',
        source: 'detected',
        evidence: 'Package.swift',
      })
    }
    if (hasFile(ctx, '.swiftlint.yml')) addTool(draft, 'lint', 'swiftlint')
    if (hasFile(ctx, '.swiftformat')) addTool(draft, 'formatter', 'swiftformat')
  },
}

// ---------------------------------------------------------------------------
// Terraform
// ---------------------------------------------------------------------------

export const terraformDetector: Detector = {
  id: 'terraform',
  title: 'Terraform',
  // High: an IaC repo is a Terraform repo first, and its playbooks must win over a
  // provider-specific one.
  priority: 85,
  matches: (ctx) => filesUnder(ctx, '').some((f) => f.endsWith('.tf')),
  detect(ctx, draft) {
    const tf = filesUnder(ctx, '').filter((f) => f.endsWith('.tf'))
    addStack(draft, {
      id: 'terraform',
      version: null,
      evidence: [tf[0] as string],
    })
    for (const f of tf) {
      const dir = f.includes('/') ? f.slice(0, f.lastIndexOf('/')) : '.'
      addTool(draft, 'iac', dir)
    }

    const text = tf.map((f) => read(ctx, f) ?? '').join('\n')

    // Read provider identity from the `source = "org/type"` string, which is Terraform's
    // own convention. Scanning `name = {` entries instead means stopping at the first
    // closing brace, so only the first provider in the block is ever found.
    const KNOWN_PROVIDERS = [
      'aws',
      'azurerm',
      'google',
      'kubernetes',
      'github',
      'gitlab',
      'datadog',
      'vault',
      'cloudflare',
    ]
    for (const m of text.matchAll(/source\s*=\s*"([\w-]+)\/([\w-]+)"/g)) {
      const provider = m[2] as string
      if (!KNOWN_PROVIDERS.includes(provider)) continue
      addStack(draft, {
        id: `terraform-${provider}`,
        version: null,
        evidence: [tf[0] as string],
      })
    }

    const hook = hookFramework(ctx)
    if (hook !== null) addTool(draft, 'hooks', hook)
    // A plan/apply typo is the classic expensive IaC mistake.
    addRisk(draft, {
      glob: '**/*.tf',
      level: 'high',
      reason: 'infrastructure-as-code',
      origin: 'heuristic',
    })
    addRisk(draft, {
      glob: '**/*.tfvars',
      level: 'high',
      reason: 'infrastructure variables, may hold secrets',
      origin: 'heuristic',
    })
  },
}

/**
 * Bazel, including bzlmod-only trees.
 *
 * Found by auditing shaped repositories: a `MODULE.bazel` tree with no `WORKSPACE` scored
 * 22/100 and failed `TEST` as a blocker, because anvil did not know Bazel existed. It is
 * the second-largest build system by Java/TypeScript projects and it was simply absent --
 * a gap that only shows up on a shape the ten-repository audit did not include.
 *
 * `MODULE.bazel` is checked as well as `WORKSPACE` because WORKSPACE is on its way out:
 * since Bazel 7 a `MODULE.bazel` with no `WORKSPACE` is the normal shape, and a detector
 * that only knew `WORKSPACE` would miss the newer form entirely.
 *
 * No install command is emitted, because Bazel fetches its own dependencies at build time
 * and there is nothing for a newcomer to install. Saying so is better than inventing
 * `bazel fetch` and hoping.
 */
export const bazelDetector: Detector = {
  id: 'bazel',
  title: 'Bazel',
  priority: 60,
  matches: (ctx) =>
    hasFile(ctx, 'MODULE.bazel') ||
    hasFile(ctx, 'WORKSPACE') ||
    hasFile(ctx, 'WORKSPACE.bazel') ||
    filesUnder(ctx, '').some((f) => f === 'BUILD.bazel' || f.endsWith('/BUILD.bazel')),
  detect(ctx, draft) {
    const build = bazelEvidence(ctx)
    addStack(draft, { id: 'bazel', version: null, evidence: [build] })

    // `//...` is the recursive target pattern, so one command covers every package. The
    // evidence is the file that proves Bazel is in use, not a line in it: a BUILD file has
    // no version to quote.
    addCommand(draft, 'build', {
      cmd: 'bazel build //...',
      source: 'detected',
      evidence: build,
    })
    addCommand(draft, 'test', {
      cmd: 'bazel test //...',
      source: 'detected',
      evidence: build,
    })

    // Query is Bazel's own way to enumerate the test targets, and it is fast by
    // construction: it resolves the graph without building it.
    addCommand(draft, 'testFast', {
      cmd: 'bazel query "kind(test, //...)"',
      source: 'detected',
      evidence: build,
    })

    addRisk(draft, {
      glob: '**/BUILD.bazel',
      level: 'medium',
      reason: 'build graph definition; a change alters what compiles and what is tested',
      origin: 'heuristic',
    })
  },
}

/**
 * The file that proves Bazel is in use, preferring the root's own declaration.
 *
 * `MODULE.bazel` first: it is the current form, and a tree that has one may still carry a
 * legacy `WORKSPACE` alongside it. A `BUILD.bazel` in a subdirectory is the last resort --
 * it still proves Bazel, just less directly.
 */
function bazelEvidence(ctx: DetectorContext): string {
  for (const f of ['MODULE.bazel', 'WORKSPACE.bazel', 'WORKSPACE']) {
    if (hasFile(ctx, f)) return f
  }
  return filesUnder(ctx, '').find((f) => f === 'BUILD.bazel' || f.endsWith('/BUILD.bazel')) ?? 'BUILD.bazel'
}

export const additionalDetectors: readonly Detector[] = [
  terraformDetector,
  rubyDetector,
  phpDetector,
  elixirDetector,
  swiftDetector,
  frontendDetector,
  bazelDetector,
]
