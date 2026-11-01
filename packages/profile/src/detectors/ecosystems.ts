/**
 * Go, Rust, JVM and .NET detectors.
 *
 * Grouped in one module because each is a short signature match plus a small set of
 * conventional commands. The interesting shared problem is the *build command*: all four
 * have canonical invocations, but none of them are guaranteed to be what the project uses.
 * Gradle in particular has `./gradlew`, `./gradlew :module:test`, and `gradle` (system),
 * only the first of which is safe to assume -- and it only exists when the wrapper is
 * committed, which is a finding in itself.
 */

import { join } from 'node:path'
import {
  addCommand,
  addModule,
  addStack,
  addTool,
  type Detector,
  type DetectorContext,
  filesUnder,
  hasFile,
  setMonorepo,
} from '../detector.ts'
import { evidence, findLine } from '../manifest.ts'
import type { CommandEntry } from '../types.ts'
import { readText } from '../walk.ts'
import { nodeDetector } from './node.ts'
import { pythonDetector } from './python.ts'

function read(ctx: DetectorContext, rel: string): string | null {
  return readText(join(ctx.root, ctx.resolve(rel))).text
}

/** Only use ./gradlew when the wrapper is actually committed. */
function gradlew(ctx: DetectorContext): { cmd: string; wrapper: boolean } {
  const wrapper = hasFile(ctx, 'gradlew') || hasFile(ctx, 'gradlew.bat')
  return { cmd: wrapper ? './gradlew' : 'gradle', wrapper }
}

/**
 * A Gradle task the project defines that runs a changed-files subset of the tests.
 *
 * The two ways a build spells this are a task whose name says so (`testChanged`,
 * `changedTests`, `testAffected`) and a `Test` task filtered on `*Changed*`. Both are read
 * out of the build files, so the command names a task that exists rather than one invented
 * from a convention -- which is the whole point: a command naming a task the build does not
 * define selects nothing and fails.
 */
function gradleChangedTestTask(
  ctx: DetectorContext,
  gradleFiles: readonly string[],
): { name: string; file: string; line: number | null } | null {
  // `(register|create|task)("name"...)` and `task name(...)`, plus `name = tasks.register`.
  const declared = /(?:tasks\s*\.\s*(?:register|create)|(?:register|create|task)\s*\(\s*|task\s+)["']?([A-Za-z][\w]*)/g
  // A filter on `*Changed*`/`*Affected*` only means "changed files" in a `Test` task.
  const filtersChanged =
    /includeTestsMatching\s*\(\s*["'][^"']*(?:Changed|Affected)[^"']*["']|includeTestsMatching\s*\(\s*.*changedTests|--tests\s+["'][^"']*Changed/i

  for (const file of gradleFiles) {
    const text = read(ctx, file)
    if (text === null) continue
    for (const m of text.matchAll(declared)) {
      const name = m[1] as string
      if (!/(changed|affected)/i.test(name)) continue
      return { name, file, line: findLine(text, new RegExp(`\\b${name}\\b`)) }
    }
    if (filtersChanged.test(text)) {
      const line = findLine(text, /includeTestsMatching|--tests/)
      return { name: 'test', file, line }
    }
  }
  return null
}

/**
 * The first Gradle build file that applies a plugin.
 *
 * Tooling is configured in the module that uses it (`app/build.gradle.kts`) and usually has
 * no config file of its own, so probing only root-level `spotless.gradle` / `config/checkstyle`
 * reported "no linter configured" for a repository whose module applies detekt and whose
 * AGENTS.md documents `./gradlew detekt`. The plugin id (or version-catalog alias) is matched
 * rather than any mention, and `apply false` declarations are skipped: `ktlint(...)` inside a
 * Spotless block configures formatting, it does not create the ktlint plugin's `ktlintCheck`
 * task.
 */
function gradlePluginFile(ctx: DetectorContext, buildFiles: readonly string[], plugin: RegExp): string | null {
  for (const file of buildFiles) {
    const text = read(ctx, file)
    if (text === null) continue
    for (const line of text.split('\n')) {
      if (/apply\s+false/.test(line)) continue
      if (plugin.test(line)) return file
    }
  }
  return null
}

// ---------------------------------------------------------------------------
// Android and Kotlin Multiplatform
// ---------------------------------------------------------------------------

/** Every Gradle build file: the modules and the settings that enumerate them. */
function gradleBuildFiles(ctx: DetectorContext): string[] {
  return filesUnder(ctx, '').filter((f) => /(^|\/)(?:build|settings)\.gradle(?:\.kts)?$/.test(f))
}

/**
 * The plugin that makes a Gradle build an *Android* build.
 *
 * This exists because `android.yaml` used to match on the `gradle` dependency and a bare
 * `**\/build.gradle.kts`, which is every Gradle project ever written. Spring Petclinic -- a
 * Gradle Java build -- was matched as Android and offered Compose performance guidance, and a
 * Kotlin Multiplatform module with no Android target was matched the same way. The evidence
 * for Android is the Android Gradle Plugin id, not the build system.
 */
const ANDROID_PLUGIN =
  /com\.android\.(?:application|library|test|dynamic-feature|asset-pack)|com\.android\.tools\.build:gradle/

/** One manifest or plugin line is Android evidence; the first found is the citation. */
function androidEvidence(ctx: DetectorContext): string | null {
  const manifest = filesUnder(ctx, '').find((f) => f === 'AndroidManifest.xml' || f.endsWith('/AndroidManifest.xml'))
  if (manifest !== undefined) return manifest

  for (const file of gradleBuildFiles(ctx)) {
    const text = read(ctx, file)
    if (text === null) continue
    const plugin = findLine(text, ANDROID_PLUGIN)
    if (plugin !== null) return evidence(file, plugin)
    // An `android { }` block with no plugin line in this file: the plugin is applied by a
    // convention plugin or a parent, and the block is still a statement about Android.
    const block = findLine(text, /\bandroid\s*\{/)
    if (block !== null) return evidence(file, block)
  }

  const props = read(ctx, 'gradle.properties')
  if (props !== null) {
    const line = findLine(props, /^\s*android\./)
    if (line !== null) return evidence('gradle.properties', line)
  }
  return null
}

export const androidDetector: Detector = {
  id: 'android',
  title: 'Android',
  // After `jvm`, so a shared Gradle build claims names first; the stack is additive either way.
  priority: 65,
  matches: (ctx) => androidEvidence(ctx) !== null,
  detect(ctx, draft) {
    const evidencePath = androidEvidence(ctx)
    if (evidencePath === null) return
    addStack(draft, { id: 'android', version: null, evidence: [evidencePath] })
  },
}

/**
 * Kotlin Multiplatform, detected separately so it is not mistaken for Android.
 *
 * A KMP module shares the Gradle build system and the `kotlin` language with an Android one,
 * but it targets iOS, JVM and native too. The two are frequently *and* legitimately both
 * (a KMP module with an `androidTarget`), which is why this is its own stack rather than a
 * correction to `android`: a repository can be both, and the plan should say so.
 */
const KMP_PLUGIN =
  /kotlin\s*\(\s*["']multiplatform["']\s*\)|kotlin-multiplatform|kotlin\.multiplatform|ios(?:Arm64|X64|SimulatorArm64)\s*\(/

export const kotlinMultiplatformDetector: Detector = {
  id: 'kotlin-multiplatform',
  title: 'Kotlin Multiplatform',
  priority: 66,
  matches: (ctx) => gradleBuildFiles(ctx).length > 0,
  detect(ctx, draft) {
    for (const file of gradleBuildFiles(ctx)) {
      const text = read(ctx, file)
      if (text === null) continue
      const line = findLine(text, KMP_PLUGIN)
      if (line !== null) {
        addStack(draft, { id: 'kotlin-multiplatform', version: null, evidence: [evidence(file, line)] })
        return
      }
    }
  },
}

// ---------------------------------------------------------------------------
// Go
// ---------------------------------------------------------------------------

export const goDetector: Detector = {
  id: 'go',
  title: 'Go',
  priority: 50,
  matches: (ctx) => hasFile(ctx, 'go.mod') || hasFile(ctx, 'go.work'),
  detect(ctx, draft) {
    const mod = read(ctx, 'go.mod')
    if (mod !== null) {
      addStack(draft, {
        id: 'go',
        // The `go` directive is a language version, not a toolchain version; take the
        // minor as the closest verifiable thing.
        version: /^\s*go\s+1\.(\d+)/m.exec(mod)?.[1] !== undefined ? `1.${/^\s*go\s+1\.(\d+)/m.exec(mod)?.[1]}` : null,
        evidence: [evidence('go.mod', findLine(mod, /^module\s+/))],
      })
    }
    if (hasFile(ctx, 'go.work')) {
      setMonorepo(draft, { tool: 'go-work', evidence: 'go.work', members: [] })
      for (const f of ctx.files) {
        if (!f.endsWith('/go.mod')) continue
        const path = f === 'go.mod' ? '.' : f.slice(0, -'/go.mod'.length)
        const inner = read(ctx, f)
        const name = inner === null ? path : (/^module\s+(\S+)/m.exec(inner)?.[1] ?? path)
        addModule(draft, { id: name, path, kind: 'package', deps: [] })
      }
    }

    // A fast subset exists only if the project says so: `go test -short`, or a
    // `TestShort` guard. Both are searched for rather than assumed.
    const hasShort = filesUnder(ctx, '').some((f) => {
      if (!f.endsWith('_test.go')) return false
      const t = read(ctx, f)
      return t !== null && /testing\.Short\(\)/.test(t)
    })
    addCommand(draft, 'test', {
      cmd: 'go test ./...',
      source: 'detected',
      evidence: 'go.mod',
    })
    if (hasShort) {
      addCommand(draft, 'testFast', {
        cmd: 'go test -short ./...',
        source: 'detected',
        evidence: 'testing.Short() guard found',
      })
    }
    if (hasFile(ctx, '.golangci.yml') || hasFile(ctx, '.golangci.yaml')) {
      addTool(draft, 'lint', 'golangci-lint')
      addCommand(draft, 'lint', {
        cmd: 'golangci-lint run',
        source: 'detected',
        evidence: '.golangci.yml',
      })
    }
    if (hasFile(ctx, 'Makefile')) {
      // No `make build` here any more. It was emitted for any repository with a Makefile,
      // so a project whose Makefile defines only `deploy` was told to build with a target
      // that does not exist -- labelled `detected`, with evidence `Makefile` and no claim
      // that `build` was in it. The language-agnostic pass reads the real targets instead
      // (`detectMakefileCommands`), so this is emitted when a `build` target is actually
      // defined, with the line it is defined on.
    }
  },
}

// ---------------------------------------------------------------------------
// Rust
// ---------------------------------------------------------------------------

export const rustDetector: Detector = {
  id: 'rust',
  title: 'Rust',
  priority: 50,
  matches: (ctx) => hasFile(ctx, 'Cargo.toml'),
  detect(ctx, draft) {
    const cargo = read(ctx, 'Cargo.toml')
    addStack(draft, {
      id: 'rust',
      version: null,
      evidence: [evidence('Cargo.toml', cargo === null ? null : findLine(cargo, /^\[package\]/))],
    })

    if (cargo !== null && /\[workspace\]/.test(cargo)) {
      setMonorepo(draft, {
        tool: 'cargo-workspace',
        evidence: evidence('Cargo.toml', findLine(cargo, /\[workspace\]/)),
        members: [],
      })
      for (const f of ctx.files) {
        if (!f.endsWith('/Cargo.toml')) continue
        const path = f === 'Cargo.toml' ? '.' : f.slice(0, -'/Cargo.toml'.length)
        const inner = read(ctx, f)
        const name = inner === null ? path : (/^\s*name\s*=\s*["']([^"']+)["']/m.exec(inner)?.[1] ?? path)
        addModule(draft, { id: name, path, kind: 'crate', deps: [] })
      }
    }

    const commands: Array<['build' | 'test' | 'testFast' | 'lint' | 'format', CommandEntry]> = [
      ['build', { cmd: 'cargo build', source: 'inferred' }],
      ['test', { cmd: 'cargo test', source: 'inferred' }],
      ['format', { cmd: 'cargo fmt --check', source: 'inferred' }],
    ]
    for (const [kind, entry] of commands) addCommand(draft, kind, entry)

    if (hasFile(ctx, 'clippy.toml') || (cargo !== null && /clippy/.test(cargo))) {
      addCommand(draft, 'lint', {
        cmd: 'cargo clippy --all-targets -- -D warnings',
        source: 'inferred',
      })
    }
    // `cargo nextest run` is the fast path; its presence is a real, checkable signal.
    if (cargo !== null && /nextest/.test(cargo)) {
      addCommand(draft, 'testFast', {
        cmd: 'cargo nextest run',
        source: 'detected',
        evidence: 'Cargo.toml',
      })
    } else if (hasFile(ctx, '.config/nextest.toml')) {
      addCommand(draft, 'testFast', {
        cmd: 'cargo nextest run',
        source: 'detected',
        evidence: '.config/nextest.toml',
      })
    }
    if (hasFile(ctx, 'rust-toolchain.toml') || hasFile(ctx, 'rust-toolchain')) {
      addStack(draft, {
        id: 'rust-toolchain',
        version: null,
        evidence: ['rust-toolchain.toml'],
      })
    }
  },
}

// ---------------------------------------------------------------------------
// JVM (Gradle / Maven)
// ---------------------------------------------------------------------------

export const jvmDetector: Detector = {
  id: 'jvm',
  title: 'JVM (Gradle / Maven)',
  priority: 60,
  matches: (ctx) =>
    hasFile(ctx, 'build.gradle') ||
    hasFile(ctx, 'build.gradle.kts') ||
    hasFile(ctx, 'pom.xml') ||
    hasFile(ctx, 'settings.gradle') ||
    hasFile(ctx, 'settings.gradle.kts'),
  detect(ctx, draft) {
    const gradleFiles = ['build.gradle.kts', 'build.gradle', 'settings.gradle.kts', 'settings.gradle'].filter((f) =>
      hasFile(ctx, f),
    )
    const maven = hasFile(ctx, 'pom.xml')
    const pomText = maven ? read(ctx, 'pom.xml') : null

    if (gradleFiles.length > 0) {
      addStack(draft, {
        id: 'gradle',
        version: null,
        evidence: [gradleFiles[0] as string],
      })
      const { cmd, wrapper } = gradlew(ctx)
      setMonorepo(draft, {
        tool: 'gradle',
        evidence: gradleFiles[0] as string,
        members: [],
      })

      addCommand(draft, 'build', {
        cmd: `${cmd} build`,
        source: wrapper ? 'detected' : 'inferred',
      })
      addCommand(draft, 'test', {
        cmd: `${cmd} test`,
        source: wrapper ? 'detected' : 'inferred',
      })
      // A changed-files test subset needs a task the project actually defines; without one
      // this is a genuine readiness gap, which the TEST_FAST rule should report.
      //
      // It used to emit `./gradlew test --tests '*Changed'` whenever the wrapper was
      // committed, which is how okhttp, spring-petclinic and nowinandroid were all reported
      // as having a documented fast subset. None of them defines a `*Changed` task: the
      // command selects zero tests and Gradle fails it. A committed wrapper says the build
      // is reproducible and nothing whatsoever about which tasks exist.
      const changedTask = gradleChangedTestTask(ctx, gradleFiles)
      if (changedTask !== null && hasFile(ctx, 'gradlew')) {
        addCommand(draft, 'testFast', {
          cmd: `./gradlew ${changedTask.name}`,
          source: 'detected',
          evidence: evidence(changedTask.file, changedTask.line),
        })
      }

      // Subprojects from settings.gradle `include(...)`.
      const settings = gradleFiles.find((f) => f.startsWith('settings.gradle'))
      if (settings !== undefined) {
        const text = read(ctx, settings)
        if (text !== null) {
          const inc = /include\s*\(?\s*([^)]*)\)?/m.exec(text)
          if (inc !== null) {
            const members = [...inc[1]!.matchAll(/['"]([^'"]+)['"]/g)].map((m) => m[1] as string)
            for (const m of members) addModule(draft, { id: m, path: m, kind: 'project', deps: [] })
            if (draft.monorepo !== null) draft.monorepo.members = members
          }
        }
      }
      if (!wrapper) {
        // Worth surfacing: without the wrapper the build is not reproducible.
        addStack(draft, {
          id: 'gradle-no-wrapper',
          version: null,
          evidence: ['(gradlew absent)'],
        })
      }

      // Tooling applied by a Gradle plugin. The task each plugin contributes is what makes
      // the command runnable, so the tool and the command are recorded together.
      const buildFiles = [...ctx.files].filter((f) => /(^|\/)build\.gradle(?:\.kts)?$/.test(f))
      const source = wrapper ? 'detected' : 'inferred'
      const detekt = gradlePluginFile(ctx, buildFiles, /(?:io\.gitlab\.arturbosch\.detekt|libs\.plugins\.detekt)\b/)
      if (detekt !== null) {
        addTool(draft, 'lint', 'detekt')
        addCommand(draft, 'lint', { cmd: `${cmd} detekt`, source, evidence: detekt })
      }
      const spotless = gradlePluginFile(ctx, buildFiles, /(?:com\.diffplug\.spotless|libs\.plugins\.spotless)\b/)
      if (spotless !== null) {
        addTool(draft, 'formatter', 'spotless')
        addCommand(draft, 'format', { cmd: `${cmd} spotlessCheck`, source, evidence: spotless })
      }
      const ktlint = gradlePluginFile(ctx, buildFiles, /(?:org\.jlleitschuh\.gradle\.ktlint|libs\.plugins\.ktlint)\b/)
      if (ktlint !== null) {
        addTool(draft, 'lint', 'ktlint')
        addTool(draft, 'formatter', 'ktlint')
        addCommand(draft, 'lint', { cmd: `${cmd} ktlintCheck`, source, evidence: ktlint })
        addCommand(draft, 'format', { cmd: `${cmd} ktlintFormat`, source, evidence: ktlint })
      }
      const checkstyle = gradlePluginFile(ctx, buildFiles, /\bcheckstyle\b/)
      if (checkstyle !== null) {
        addTool(draft, 'lint', 'checkstyle')
        addCommand(draft, 'lint', { cmd: `${cmd} checkstyleMain`, source, evidence: checkstyle })
      }
    }

    if (maven) {
      addStack(draft, { id: 'maven', version: null, evidence: ['pom.xml'] })
      const mvn = hasFile(ctx, 'mvnw') ? './mvnw' : 'mvn'
      addCommand(draft, 'build', {
        cmd: `${mvn} -q package -DskipTests`,
        source: hasFile(ctx, 'mvnw') ? 'detected' : 'inferred',
      })
      addCommand(draft, 'test', {
        cmd: `${mvn} -q test`,
        source: hasFile(ctx, 'mvnw') ? 'detected' : 'inferred',
      })
      // Maven has no changed-files filter of its own. Surefire's `-Dtest` takes a *name
      // pattern*, so `-Dit.test=*Changed*` presumes this project renames the tests it cares
      // about -- and `it.test` is failsafe's property, not surefire's, so it is the wrong
      // flag for `mvn test` besides. Only a plugin that genuinely selects by changed file
      // counts as evidence, because that is the thing the command would be invoking.
      const mavenSubset = /buildmate|git-diff|changed-files|changedfiles/i.test(pomText ?? '') && hasFile(ctx, 'mvnw')
      if (mavenSubset) {
        addCommand(draft, 'testFast', {
          cmd: `${mvn} test -Dtest='*Changed*'`,
          source: 'inferred',
        })
      }
      setMonorepo(draft, { tool: 'maven', evidence: 'pom.xml', members: [] })
    }

    // Spring Boot is a framework on top of the build, and the marker is the starter it pulls in.
    // A plain JVM project that happens to be a web service is not a Spring project: the framework's
    // conventions -- auto-configuration, the application context, the request lifecycle -- are not
    // inferable from `build.gradle`.
    for (const file of [...(maven ? ['pom.xml'] : []), ...gradleFiles]) {
      const text = read(ctx, file)
      if (text === null) continue
      const line = findLine(text, /spring-boot-starter|org\.springframework\.boot/)
      if (line === null) continue
      addStack(draft, { id: 'spring-boot', version: null, evidence: [evidence(file, line)] })
      break
    }

    for (const f of ctx.files) {
      if (f.startsWith('.github/workflows/') && f.endsWith('.yml')) addTool(draft, 'ci', f)
    }
    if (hasFile(ctx, 'config/spotless') || hasFile(ctx, 'spotless.gradle') || hasFile(ctx, 'spotless.gradle.kts')) {
      addTool(draft, 'formatter', 'spotless')
    }
    if (hasFile(ctx, 'config/checkstyle') || hasFile(ctx, 'checkstyle.xml')) addTool(draft, 'lint', 'checkstyle')
  },
}

// ---------------------------------------------------------------------------
// .NET
// ---------------------------------------------------------------------------

export const dotnetDetector: Detector = {
  id: 'dotnet',
  title: '.NET',
  priority: 50,
  matches: (ctx) =>
    filesUnder(ctx, '').some((f) => f.endsWith('.csproj') || f.endsWith('.fsproj')) || hasFile(ctx, 'global.json'),
  detect(ctx, draft) {
    const projects = filesUnder(ctx, '').filter((f) => f.endsWith('.csproj') || f.endsWith('.fsproj'))
    addStack(draft, {
      id: 'dotnet',
      version: null,
      evidence: [projects[0] ?? 'global.json'],
    })

    for (const p of projects) {
      const dir = p.slice(0, p.lastIndexOf('/') + 1) || '.'
      const id = p.replace(/\.(cs|fs)proj$/, '').replace(/\//g, ':')
      addModule(draft, { id, path: dir, kind: 'project', deps: [] })
    }

    // ASP.NET Core is a .NET workload with its own SDK marker. A plain .NET project is not a web
    // application, and the framework's guidance -- middleware order, the request pipeline, the
    // hosting model -- does not apply to a console app.
    for (const p of projects) {
      const text = read(ctx, p)
      if (text === null) continue
      const line = findLine(text, /Microsoft\.NET\.Sdk\.Web/i)
      if (line === null) continue
      addStack(draft, { id: 'aspnet', version: null, evidence: [evidence(p, line)] })
      break
    }

    if (hasFile(ctx, 'global.json')) {
      setMonorepo(draft, { tool: 'sln', evidence: 'global.json', members: [] })
    }

    addCommand(draft, 'build', { cmd: 'dotnet build', source: 'inferred' })
    addCommand(draft, 'test', { cmd: 'dotnet test', source: 'inferred' })
    if (hasFile(ctx, 'Directory.Build.props') || hasFile(ctx, '.editorconfig')) {
      addTool(draft, 'formatter', 'dotnet format')
    }
    for (const f of ctx.files) {
      if (f.startsWith('.github/workflows/') && f.endsWith('.yml')) addTool(draft, 'ci', f)
    }
  },
}

export const ecosystemDetectors: readonly Detector[] = [
  jvmDetector,
  androidDetector,
  kotlinMultiplatformDetector,
  nodeDetector,
  pythonDetector,
  goDetector,
  rustDetector,
  dotnetDetector,
]
